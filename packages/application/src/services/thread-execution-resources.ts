import type { SandboxExecutionPlanCandidateV2 } from "@himawari-agent/execution-contracts";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { SandboxExecutionRunInventory } from "../ports/sandbox-execution-journal.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import { projectSandboxExecution } from "./sandbox-execution-projection.js";
import { readSandboxScopeSnapshot } from "./sandbox-scope-service.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

export type ThreadResourcePhase =
  | "released"
  | "queued"
  | "preparing"
  | "executing"
  | "verifying"
  | "stopping"
  | "unresolved"
  | "not_dispatched";
export interface ThreadExecutionResources {
  readonly revision: string;
  readonly allReleased: boolean;
  readonly pendingResources: boolean;
  readonly unresolvedResultItemIds: readonly string[];
  readonly phase: Exclude<ThreadResourcePhase, "released" | "not_dispatched"> | null;
  readonly reasonCode: string;
  readonly lastObservedAt: string | null;
  readonly operations: readonly {
    readonly itemId: string;
    readonly phase: ThreadResourcePhase;
    readonly reasonCode: string;
    readonly lastObservedAt: string | null;
  }[];
}
const priority: Record<ThreadResourcePhase, number> = {
  released: 0,
  not_dispatched: 1,
  preparing: 2,
  queued: 3,
  executing: 4,
  verifying: 5,
  stopping: 6,
  unresolved: 7,
};

/** Read-only product projection. Protected identities stay behind this boundary;
 * authenticated historical scope is never used as a current execution grant. */
export async function readThreadExecutionResources(input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly inventory: SandboxExecutionRunInventory;
  readonly now: string;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: Pick<PayloadProtectorPort, "unprotect">;
  readonly digest: (bytes: Uint8Array) => string;
  readonly itemId: (toolCallId: string) => string;
}): Promise<ThreadExecutionResources> {
  const { inventory, now } = input;
  if (!Number.isFinite(Date.parse(now))) throw new Error("THREAD_EXECUTION_RESOURCE_CLOCK_INVALID");
  const operations = new Map<string, ThreadExecutionResources["operations"][number]>();
  const unresolvedResultItemIds = new Set<string>();
  let pendingResources = inventory.legacyResourcesPending;
  let allReleased = inventory.admissions.length > 0 && !inventory.legacyResourcesPending;
  let lastObservedAt: string | null = null;
  const add = async (
    plan: SandboxExecutionPlanCandidateV2,
    phase: ThreadResourcePhase,
    reasonCode: string,
    at: string | null,
  ) => {
    for (const key of ["ownerId", "agentId", "threadId", "runId"] as const)
      if (plan.identity[key] !== input[key])
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "THREAD_EXECUTION_RESOURCE_SCOPE_MISMATCH",
        );
    const scope = await readSandboxScopeSnapshot(plan, input);
    const itemId = input.itemId(scope.parentToolCallId ?? scope.toolCallId);
    const prior = operations.get(itemId);
    const observed =
      at && (!prior?.lastObservedAt || at > prior.lastObservedAt)
        ? at
        : (prior?.lastObservedAt ?? null);
    const winner =
      prior && priority[prior.phase] >= priority[phase]
        ? prior
        : { itemId, phase, reasonCode, lastObservedAt: at };
    operations.set(itemId, { ...winner, lastObservedAt: observed });
    if (at && (!lastObservedAt || at > lastObservedAt)) lastObservedAt = at;
    return itemId;
  };
  const admitted = new Map(
    inventory.admissions.map((entry) => {
      const plan = entry.phase === "bound" ? entry.record.plan : entry.plan;
      const { semanticFingerprint: _fingerprint, ...candidate } = plan;
      return [plan.identity.jobId, threadCommandFingerprint(candidate)];
    }),
  );
  if (admitted.size !== inventory.admissions.length)
    throw new Error("THREAD_EXECUTION_RESOURCE_DUPLICATE_ADMISSION");
  for (const entry of inventory.admissions) {
    const record = entry.phase === "bound" ? entry.record : entry;
    const plan = record.plan;
    const released =
      entry.phase === "reserved"
        ? !!entry.releaseReceipt &&
          entry.workspaceBlocked === false &&
          entry.releaseReceipt.acceptedAt <= now
        : entry.record.workspaceBlocked === false &&
          projectSandboxExecution(plan, entry.record.facts, {
            now,
            environment: entry.record.facts.environment,
            operationContract: plan.operationContract,
            verification: null,
            releaseReceipt: entry.record.releaseReceipt ?? null,
            currentResourceSequence: entry.record.facts.resource.sequence,
            runState: "terminated",
            currentAuthority: false,
            currentFence: false,
            userDisclosureAllowed: false,
            modelDisclosureAllowed: false,
            conflictingWorkspaceRisk: true,
            pendingApprovalOrReconciliation: true,
            resultAlreadyDelivered: false,
          }).resourceObligationReleased;
    const recovery = record.recovery;
    const recovering =
      recovery?.status === "running" &&
      recovery.finishedAt === null &&
      recovery.startedAt <= now &&
      now < recovery.deadlineAt;
    const resource = entry.phase === "bound" ? entry.record.facts.resource : null;
    let phase: ThreadResourcePhase;
    let reason: string;
    if (released) {
      phase = "released";
      reason = "RESOURCE_RELEASE_CONFIRMED";
    } else if (recovering) {
      phase = recovery.action === "stop" ? "stopping" : "verifying";
      reason =
        recovery.action === "stop" ? "RESOURCE_STOP_IN_PROGRESS" : "RESOURCE_CHECK_IN_PROGRESS";
    } else if (
      recovery ||
      plan.effectiveDeadlineAt <= now ||
      (entry.phase === "reserved" && entry.stopRequestedAt) ||
      (resource && ["lost", "released", "reconciling", "stopping"].includes(resource.supervision))
    ) {
      phase = "unresolved";
      reason = "RESOURCE_STATE_UNCONFIRMED";
    } else if (
      resource?.supervision === "controlled" &&
      resource.occurredAt <= now &&
      resource.evidence.validUntil > now
    ) {
      const running =
        resource.status.kind === "foreground" ||
        (resource.status.kind === "task" && resource.status.state === "running") ||
        (resource.status.kind === "service" && resource.status.readiness === "ready");
      phase = running ? "executing" : "preparing";
      reason = running ? "RESOURCE_EXECUTION_OBSERVED" : "RESOURCE_START_UNCONFIRMED";
    } else if (resource?.supervision === "controlled") {
      phase = "unresolved";
      reason = "RESOURCE_OBSERVATION_EXPIRED";
    } else {
      phase = "preparing";
      reason = "RESOURCE_START_UNCONFIRMED";
    }
    allReleased &&= released;
    pendingResources ||= !released;
    const dates = [
      resource?.occurredAt,
      record.releaseReceipt?.acceptedAt,
      recovery?.startedAt,
      recovery?.finishedAt,
      recovery && "scheduledAt" in recovery ? recovery.scheduledAt : null,
      entry.phase === "reserved" ? entry.stopRequestedAt : null,
    ].filter((value): value is string => !!value);
    const itemId = await add(plan, phase, reason, dates.sort().at(-1) ?? null);
    if (
      entry.phase === "bound" &&
      (!entry.record.facts.result ||
        entry.record.facts.result.kind === "unknown" ||
        entry.record.facts.effect.kind === "unknown")
    )
      unresolvedResultItemIds.add(itemId);
  }
  for (const queued of inventory.queue) {
    // An admitted queue row and its journal are the same attempt, not two resources.
    const admittedPlan = admitted.get(queued.plan.identity.jobId);
    if (admittedPlan) {
      if (queued.status !== "admitted" || admittedPlan !== threadCommandFingerprint(queued.plan))
        throw new Error("THREAD_EXECUTION_RESOURCE_QUEUE_MISMATCH");
      continue;
    }
    if (queued.status === "cancelled") {
      await add(queued.plan, "not_dispatched", "RESOURCE_QUEUE_CANCELLED", null);
      continue;
    }
    allReleased = false;
    pendingResources = true;
    const waiting = queued.status === "queued" && queued.plan.effectiveDeadlineAt > now;
    await add(
      queued.plan,
      waiting ? "queued" : "unresolved",
      waiting ? "RESOURCE_QUEUE_WAITING" : "RESOURCE_STATE_UNCONFIRMED",
      null,
    );
  }
  const values = [...operations.values()].sort((a, b) => a.itemId.localeCompare(b.itemId));
  const selected = values.reduce<ThreadExecutionResources["operations"][number] | undefined>(
    (prior, item) => (!prior || priority[item.phase] > priority[prior.phase] ? item : prior),
    undefined,
  );
  return {
    revision: threadCommandFingerprint(inventory),
    allReleased,
    pendingResources,
    unresolvedResultItemIds: [...unresolvedResultItemIds].sort(),
    lastObservedAt,
    phase: inventory.legacyResourcesPending
      ? "unresolved"
      : selected && priority[selected.phase] > 1
        ? (selected.phase as ThreadExecutionResources["phase"])
        : null,
    reasonCode: inventory.legacyResourcesPending
      ? "LEGACY_RESOURCE_STATE_UNCONFIRMED"
      : (selected?.reasonCode ?? "RESOURCE_HISTORY_EMPTY"),
    operations: values,
  };
}
