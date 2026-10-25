import {
  isSandboxBoundedToolFailure,
  type SandboxExecutionPlanCandidateV2,
} from "@himawari-agent/execution-contracts";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { SandboxExecutionRunInventory } from "../ports/sandbox-execution-journal.js";
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
  | "not_dispatched"
  | "record_deleted";
export interface ThreadExecutionResources {
  readonly revision: string;
  readonly allReleased: boolean;
  readonly pendingResources: boolean;
  readonly unresolvedResultItemIds: readonly string[];
  readonly phase: Exclude<
    ThreadResourcePhase,
    "released" | "not_dispatched" | "record_deleted"
  > | null;
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
  record_deleted: 0,
  released: 0,
  not_dispatched: 1,
  preparing: 2,
  queued: 3,
  executing: 4,
  verifying: 5,
  stopping: 6,
  unresolved: 7,
};

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
  let allReleased =
    inventory.admissions.length + inventory.deletedPlans.length > 0 &&
    !inventory.legacyResourcesPending;
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
    let taskEnvironmentObservedAt: string | null = null;
    if (released) {
      phase = "released";
      reason =
        resource?.supervision === "released" &&
        resource.cleanup === "process_group_gone" &&
        resource.cleanupScope !== "pid_namespace"
          ? "RESOURCE_STOP_NOT_STRICTLY_CONFIRMED"
          : "RESOURCE_RELEASE_CONFIRMED";
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
    } else if (
      entry.phase === "bound" &&
      resource?.supervision === "initializing" &&
      entry.record.facts.result === null
    ) {
      const environment = entry.record.facts.environment;
      if (environment.kind !== "container") {
        phase = "preparing";
        reason = "RESOURCE_START_UNCONFIRMED";
      } else {
        const call = inventory.taskEnvironmentCalls.find(
          (candidate) =>
            candidate.environmentId === environment.taskEnvironmentId &&
            candidate.invocationId === plan.identity.invocationId &&
            candidate.executionJobId === environment.executionJobId &&
            candidate.environmentGeneration === environment.environmentGeneration &&
            candidate.stopFence === environment.stopFence,
        );
        if (call && (call.state === "ready" || call.state === "running") && call.deadlineAt > now) {
          const lease = inventory.executionLease;
          if (lease && lease.releasedAt === null && lease.expiresAt > now) {
            phase = "executing";
            reason = "RESOURCE_EXECUTION_OBSERVED";
            taskEnvironmentObservedAt = call.linkedAt;
          } else {
            phase = "unresolved";
            reason = "RESOURCE_OBSERVATION_EXPIRED";
          }
        } else {
          phase = "unresolved";
          reason = "RESOURCE_STATE_UNCONFIRMED";
        }
      }
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
      taskEnvironmentObservedAt,
    ].filter((value): value is string => !!value);
    const itemId = await add(plan, phase, reason, dates.sort().at(-1) ?? null);
    const awaitingResult =
      entry.phase === "bound" &&
      entry.record.facts.result === null &&
      ["preparing", "executing"].includes(phase);
    if (
      entry.phase === "bound" &&
      !awaitingResult &&
      !(
        plan.mode === "foreground" &&
        released &&
        isSandboxBoundedToolFailure(entry.record.facts.result)
      ) &&
      (!entry.record.facts.result ||
        entry.record.facts.result.kind === "unknown" ||
        entry.record.facts.effect.kind === "unknown")
    )
      unresolvedResultItemIds.add(itemId);
  }
  const deleted = new Set<string>();
  for (const plan of inventory.deletedPlans) {
    if (admitted.has(plan.identity.jobId) || deleted.has(plan.identity.jobId))
      throw new Error("THREAD_EXECUTION_RESOURCE_DUPLICATE_ADMISSION");
    deleted.add(plan.identity.jobId);
    await add(plan, "record_deleted", "EXECUTION_RECORD_DELETED", null);
  }
  for (const queued of inventory.queue) {
    const admittedPlan = admitted.get(queued.plan.identity.jobId);
    if (admittedPlan) {
      if (queued.status !== "admitted" || admittedPlan !== threadCommandFingerprint(queued.plan))
        throw new Error("THREAD_EXECUTION_RESOURCE_QUEUE_MISMATCH");
      continue;
    }
    if (queued.status === "admitted" && deleted.has(queued.plan.identity.jobId)) continue;
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

const RESOURCE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function nextThreadExecutionResourceChangeAt(
  inventory: SandboxExecutionRunInventory,
  now: string,
): string | null {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) throw new Error("THREAD_EXECUTION_RESOURCE_CLOCK_INVALID");
  let next: { readonly at: number; readonly value: string } | null = null;
  const pending: unknown[] = [inventory];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (!RESOURCE_INSTANT.test(value)) continue;
      const at = Date.parse(value);
      if (Number.isFinite(at) && at > current && (!next || at < next.at)) next = { at, value };
    } else if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") pending.push(...Object.values(value));
  }
  return next?.value ?? null;
}
