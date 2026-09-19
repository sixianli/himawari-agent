import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationConsumeResult,
  SandboxExecutionAdmissionRecord,
  SandboxExecutionJournalPort,
  SandboxExecutionPreparationPort,
  SandboxExecutionRecord,
  SandboxRecoveryState,
  SandboxWorkspaceClaim,
} from "@himawari-agent/application";
import { projectSandboxExecution } from "@himawari-agent/application/sandbox-execution-projection";
import {
  PI_FIXED_FILE_CONTRACT,
  piFileRecoveryOperationKey,
  type SandboxExecutionPlanV2,
  type SandboxJobIdentity,
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanCandidateV2Schema,
  sandboxExecutionPlanV2Schema,
  sandboxExecutionReservationSchema,
  sandboxJobIdentitySchema,
  validateSandboxExecutionFacts,
} from "@himawari-agent/execution-contracts";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { capabilityInvocationOutputOperationKey } from "./sqlite-run-payload-artifact-operations.ts";
import { SqliteSandboxRecoveryOperations } from "./sqlite-sandbox-recovery-operations.ts";
import { SqliteSandboxReleaseOperations } from "./sqlite-sandbox-release-operations.ts";
import { SqliteWorkspaceAdmissionQueue } from "./sqlite-workspace-admission-queue.ts";

type Input<K extends keyof SandboxExecutionJournalPort> = Parameters<
  SandboxExecutionJournalPort[K]
>[0];
interface Row {
  plan: string;
  facts: string;
  admission: string;
  startedAt: string | null;
  sequence: number;
  operationRevision: number;
}
interface AuthorityDependencies {
  consume(value: unknown, owner: string, agent: string): CapabilityInvocationConsumeResult;
  validateQueued(value: unknown, owner: string, agent: string): void;
  live(plan: SandboxExecutionPlanV2, authority: CapabilityInvocationAuthority, now: string): void;
  authority(value: unknown, owner: string, agent: string, now: string): void;
  disk(): void;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function overlaps(a: SandboxWorkspaceClaim, b: SandboxWorkspaceClaim): boolean {
  if (a.hostId !== b.hostId) return false;
  const equal = (
    left: SandboxWorkspaceClaim["lineage"][number] | null | undefined,
    right: SandboxWorkspaceClaim["lineage"][number] | null | undefined,
  ) => left != null && right != null && left.device === right.device && left.inode === right.inode;
  const left = a.lineage.at(-1);
  const right = b.lineage.at(-1);
  if (a.file && b.file)
    return (
      (equal(left, right) && a.file.name === b.file.name) || equal(a.file.identity, b.file.identity)
    );
  if (a.file) return a.lineage.some((item) => equal(item, right));
  if (b.file) return b.lineage.some((item) => equal(item, left));
  return (
    a.lineage.some((item) => equal(item, right)) || b.lineage.some((item) => equal(item, left))
  );
}
function conflicts(a: SandboxWorkspaceClaim, b: SandboxWorkspaceClaim, uncertain = false): boolean {
  if (!overlaps(a, b)) return false;
  if (uncertain) return true;
  if (a.access === "read" && b.access === "read") return false;
  if (a.file && b.file && a.access !== b.access) {
    const writer = a.access === "write" ? a : b;
    if (writer.file?.atomicPublish) return false;
  }
  return true;
}
export class SqliteSandboxExecutionOperations {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly authority: AuthorityDependencies;
  private readonly releases: SqliteSandboxReleaseOperations;
  private readonly queue: SqliteWorkspaceAdmissionQueue;
  constructor(
    db: Database.Database,
    fail: SqliteApplicationFailure,
    authority: AuthorityDependencies,
  ) {
    this.db = db;
    this.releases = new SqliteSandboxReleaseOperations(db);
    this.queue = new SqliteWorkspaceAdmissionQueue(db, fail, conflicts);
    this.fail = fail;
    this.authority = authority;
  }
  execute(operation: string, raw: unknown, owner: string, agent: string): unknown {
    if (operation === "read") return this.read(sandboxJobIdentitySchema.parse(raw), owner, agent);
    if (operation === "readAdmission")
      return this.readAdmission(sandboxJobIdentitySchema.parse(raw), owner, agent);
    const input = raw as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return this.fail("PORT_INVALID_OPERATION", "Invalid sandbox journal request");
    if (operation === "readQueuedByInvocation") {
      if (!id(input["runId"]) || !id(input["invocationId"]))
        return this.fail("PORT_INVALID_OPERATION", "Invalid queued invocation locator");
      return this.queue.read(owner, agent, input["runId"], input["invocationId"]);
    }
    if (operation === "readAdmissionByResource") {
      if (!id(input["runId"]) || !id(input["resourceRef"]))
        return this.fail("PORT_INVALID_OPERATION", "Invalid resource locator");
      const row = this.db
        .prepare(
          "SELECT plan_json AS plan FROM sandbox_execution_records WHERE owner_id=? AND agent_id=? AND run_id=? AND resource_ref=?",
        )
        .get(owner, agent, input["runId"], input["resourceRef"]) as { plan: string } | undefined;
      return row
        ? this.readAdmission(
            sandboxExecutionPlanV2Schema.parse(JSON.parse(row.plan)).identity,
            owner,
            agent,
          )
        : undefined;
    }
    if (operation === "readAdmissionByInvocation") {
      if (!id(input["runId"]) || !id(input["invocationId"]))
        return this.fail("PORT_INVALID_OPERATION", "Invalid invocation locator");
      const row = this.db
        .prepare(
          "SELECT plan_json AS plan FROM sandbox_execution_records WHERE owner_id=? AND agent_id=? AND run_id=? AND invocation_id=?",
        )
        .get(owner, agent, input["runId"], input["invocationId"]) as { plan: string } | undefined;
      return row
        ? this.readAdmission(
            sandboxExecutionPlanV2Schema.parse(JSON.parse(row.plan)).identity,
            owner,
            agent,
          )
        : undefined;
    }
    if (operation === "listAdmissions") {
      const { afterJobId, limit } = input;
      if (
        (afterJobId !== null && !id(afterJobId)) ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 100
      )
        return this.fail("PORT_INVALID_OPERATION", "Invalid bounded page");
      if (input["runId"] !== undefined && !id(input["runId"]))
        return this.fail("PORT_INVALID_OPERATION", "Invalid Run locator");
      const rows = this.db
        .prepare(
          "SELECT plan_json AS plan FROM sandbox_execution_records WHERE owner_id=? AND agent_id=? AND (? IS NULL OR run_id=?) AND job_id>? ORDER BY job_id LIMIT ?",
        )
        .all(
          owner,
          agent,
          input["runId"] ?? null,
          input["runId"] ?? null,
          afterJobId ?? "",
          limit,
        ) as { plan: string }[];
      return rows.map((row) =>
        this.readAdmission(
          sandboxExecutionPlanV2Schema.parse(JSON.parse(row.plan)).identity,
          owner,
          agent,
        ),
      );
    }
    if (operation === "listPending") {
      const { afterJobId, limit } = input;
      if (
        (afterJobId !== null && !id(afterJobId)) ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 100
      )
        return this.fail("PORT_INVALID_OPERATION", "Invalid bounded page");
      return (
        this.db
          .prepare(`SELECT plan_json AS plan FROM sandbox_execution_records r WHERE owner_id=? AND agent_id=? AND job_id>? AND preparation_state!='reserved' AND
        (EXISTS(SELECT 1 FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) OR EXISTS(SELECT 1 FROM sandbox_workspace_barriers b WHERE b.job_id=r.job_id AND b.resolved_at IS NULL) OR json_extract(facts_json,'$.resource.supervision') != 'released' OR json_extract(facts_json,'$.effect.kind')='unknown' OR json_extract(facts_json,'$.result.kind') IS NULL OR json_extract(facts_json,'$.result.kind')='unknown' OR EXISTS(SELECT 1 FROM sandbox_execution_intents i WHERE i.job_id=r.job_id AND i.dispatched_at IS NOT NULL AND i.acknowledged_at IS NULL)) ORDER BY job_id LIMIT ?`)
          .all(owner, agent, afterJobId ?? "", limit) as { plan: string }[]
      ).map((r) =>
        this.read(sandboxExecutionPlanV2Schema.parse(JSON.parse(r.plan)).identity, owner, agent),
      );
    }
    this.authority.disk();
    return this.db
      .transaction(() => {
        if (operation === "enqueue") {
          const queued = raw as Parameters<SandboxExecutionPreparationPort["enqueue"]>[0];
          const plan = sandboxExecutionPlanCandidateV2Schema.parse(queued.plan);
          const reservation = sandboxExecutionReservationSchema.parse(queued.reservation);
          const invocation = queued.invocation;
          this.authority.authority(invocation.authority, owner, agent, invocation.consumedAt);
          if (
            !same(plan.identity, reservation.identity) ||
            plan.identity.ownerId !== owner ||
            plan.identity.agentId !== agent ||
            plan.identity.runId !== invocation.requestScope.runId ||
            plan.identity.invocationId !== invocation.invocationId ||
            plan.identity.receiptRef !== invocation.receiptRef ||
            plan.handleRef !== invocation.handleRef ||
            plan.inputRef !== invocation.inputRef ||
            plan.operation !== invocation.operation ||
            plan.effectiveDeadlineAt > invocation.deadlineAt ||
            plan.effectiveDeadlineAt <= invocation.consumedAt
          )
            this.fail("PORT_NOT_AUTHORITATIVE", "Queue binding is not authoritative");
          const claims = this.claims(queued.workspaces, plan, reservation.workspaceConflictRefs);
          return this.queue.enqueue({ ...queued, plan, reservation }, claims, () =>
            this.authority.validateQueued(invocation, owner, agent),
          );
        }
        if (operation === "reserve")
          return this.reserve(
            raw as Parameters<SandboxExecutionPreparationPort["reserve"]>[0],
            owner,
            agent,
          );
        if (operation === "admit") return this.admit(raw as Input<"admit">, owner, agent);
        const identity = sandboxJobIdentitySchema.parse(input["identity"]);
        const now = input["now"];
        if (
          typeof now !== "string" ||
          !Number.isFinite(Date.parse(now)) ||
          new Date(now).toISOString() !== now
        )
          return this.fail("PORT_INVALID_OPERATION", "Invalid observation time");
        this.authority.authority(input["authority"], owner, agent, now);
        if (operation === "cancelQueued") {
          this.queue.cancel(identity.jobId, owner, agent);
          return undefined;
        }
        if (operation === "interruptReservation") {
          const reasonCode = input["reasonCode"];
          if (
            reasonCode !== "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN" &&
            reasonCode !== "SANDBOX_PREVIOUS_BOOT_UNKNOWN"
          )
            return this.fail("PORT_INVALID_OPERATION", "Invalid reservation stop reason");
          const admission = this.readAdmission(identity, owner, agent);
          if (!admission) return this.fail("PORT_NOT_FOUND", "Sandbox reservation missing");
          if (admission.phase === "bound" || admission.stopRequestedAt)
            return { admission, applied: false };
          if (now < admission.reservation.createdAt)
            return this.fail("PORT_INVALID_OPERATION", "Reservation stop precedes admission");
          const recovery: SandboxRecoveryState = {
            revision: 1,
            owner: (input["authority"] as CapabilityInvocationAuthority).agentServiceBootId,
            attempts: 0,
            status: "unresolved",
            action: "stop",
            startedAt: now,
            deadlineAt: now,
            finishedAt: now,
            reasonCode,
          };
          this.db
            .prepare(
              "UPDATE sandbox_execution_records SET recovery_json=?,reservation_stopped_at=? WHERE job_id=? AND preparation_state='reserved' AND reservation_stopped_at IS NULL",
            )
            .run(JSON.stringify(recovery), now, identity.jobId);
          return { admission: { ...admission, stopRequestedAt: now, recovery }, applied: true };
        }
        if (operation === "bindAndStart")
          return this.bindAndStart(
            raw as Parameters<SandboxExecutionPreparationPort["bindAndStart"]>[0],
            owner,
            agent,
          );
        const current = this.read(identity, owner, agent);
        if (!current) return this.fail("PORT_NOT_FOUND", "Sandbox execution missing");
        if (["beginRecovery", "finishRecovery", "interruptRecovery"].includes(operation))
          return new SqliteSandboxRecoveryOperations(this.db, this.fail).mutate(
            operation,
            raw as Input<"beginRecovery"> & Input<"finishRecovery">,
            current,
          );
        if (operation === "start") {
          const start = raw as Input<"start">;
          this.authority.live(current.plan, start.authority, now);
          if (start.policyDigest !== current.facts.environment.policyDigest)
            return this.fail("PORT_CONFLICT", "Start policy differs");
          if (current.startedAt !== null) return { record: current, applied: false };
          if (
            current.facts.resource.sequence !== start.expectedSequence ||
            current.facts.resource.supervision !== "initializing"
          )
            return this.fail("PORT_CONFLICT", "Start sequence changed");
          this.assertAvailable(current.workspaces, identity.jobId, now);
          this.db
            .prepare(
              "UPDATE sandbox_execution_records SET started_at=?,start_policy_digest=? WHERE job_id=? AND started_at IS NULL",
            )
            .run(now, start.policyDigest, identity.jobId);
          return { record: { ...current, startedAt: now }, applied: true };
        }
        if (operation === "append" || operation === "recordOperation")
          return this.append(
            raw as Input<"append">,
            current,
            owner,
            agent,
            operation === "recordOperation",
          );
        if (operation === "prepareIntent" || operation === "dispatchIntent")
          return this.intent(operation, raw as Input<"prepareIntent">, current);
        if (operation === "acknowledgeIntent") {
          const request = raw as Input<"acknowledgeIntent">;
          if (!id(request.intentId))
            return this.fail("PORT_INVALID_OPERATION", "Invalid intent receipt");
          const row = this.db
            .prepare(
              "SELECT dispatched_at,acknowledged_at FROM sandbox_execution_intents WHERE intent_id=? AND job_id=?",
            )
            .get(request.intentId, identity.jobId) as
            | { dispatched_at: string | null; acknowledged_at: string | null }
            | undefined;
          if (!row?.dispatched_at) return this.fail("PORT_CONFLICT", "Intent was not dispatched");
          if (now < row.dispatched_at)
            return this.fail("PORT_INVALID_OPERATION", "Receipt predates dispatch");
          if (row.acknowledged_at) return undefined;
          this.db
            .prepare("UPDATE sandbox_execution_intents SET acknowledged_at=? WHERE intent_id=?")
            .run(now, request.intentId);
          this.releases.acknowledge(identity.jobId, request.intentId, now);
          return undefined;
        }
        if (operation === "observeIntent") {
          const request = raw as Input<"observeIntent">;
          if (!id(request.intentId) || !id(request.reasonCode))
            return this.fail("PORT_INVALID_OPERATION", "Invalid intent observation");
          const observation = JSON.stringify({ reasonCode: request.reasonCode, occurredAt: now });
          const row = this.db
            .prepare(
              "SELECT dispatched_at AS dispatchedAt,acknowledged_at AS acknowledgedAt,observation_json AS observation FROM sandbox_execution_intents WHERE intent_id=? AND job_id=?",
            )
            .get(request.intentId, identity.jobId) as
            | {
                dispatchedAt: string | null;
                acknowledgedAt: string | null;
                observation: string | null;
              }
            | undefined;
          if (!row?.dispatchedAt) return this.fail("PORT_CONFLICT", "Intent was not dispatched");
          if (row.acknowledgedAt || now < row.dispatchedAt)
            return this.fail(
              "PORT_CONFLICT",
              "Intent receipt already confirmed or observation predates dispatch",
            );
          if (row.observation && row.observation !== observation)
            return this.fail("PORT_CONFLICT", "Intent observation is immutable");
          this.db
            .prepare("UPDATE sandbox_execution_intents SET observation_json=? WHERE intent_id=?")
            .run(observation, request.intentId);
          return undefined;
        }
        return this.fail("PORT_INVALID_OPERATION", "Unknown sandbox execution operation");
      })
      .immediate();
  }
  private claims(
    raw: readonly SandboxWorkspaceClaim[],
    plan: Pick<SandboxExecutionPlanV2, "identity" | "operationContract">,
    conflictRefs: readonly string[],
  ): readonly SandboxWorkspaceClaim[] {
    if (plan.operationContract.kind === "network_only") {
      if (!Array.isArray(raw) || raw.length !== 0 || conflictRefs.length !== 0)
        return this.fail(
          "PORT_INVALID_OPERATION",
          "Private network execution cannot claim shared files",
        );
      return [];
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64)
      return this.fail("PORT_INVALID_OPERATION", "Verified workspace coverage required");
    const claims = raw.map((c) => {
      if (
        !c ||
        !id(c.ref) ||
        !id(c.canonicalRootId) ||
        c.hostId !== plan.identity.hostId ||
        !["read", "write"].includes(c.access) ||
        !Array.isArray(c.lineage) ||
        c.lineage.length === 0 ||
        c.lineage.length > 256 ||
        new Set(
          c.lineage.map(
            (i: SandboxWorkspaceClaim["lineage"][number]) => `${i?.device}:${i?.inode}`,
          ),
        ).size !== c.lineage.length ||
        c.lineage.some(
          (i: SandboxWorkspaceClaim["lineage"][number]) => !i || !id(i.device) || !id(i.inode),
        )
      )
        return this.fail("PORT_INVALID_OPERATION", "Invalid directory identity chain");
      if (
        c.file !== undefined &&
        (!c.file ||
          typeof c.file.name !== "string" ||
          c.file.name.length === 0 ||
          Buffer.byteLength(c.file.name) > 255 ||
          c.file.name.includes("/") ||
          c.file.name === "." ||
          c.file.name === ".." ||
          Array.from(c.file.name as string).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          c.file.name !== c.file.name.normalize("NFC").toLowerCase() ||
          typeof c.file.atomicPublish !== "boolean" ||
          (c.file.versionDigest !== undefined &&
            (typeof c.file.versionDigest !== "string" ||
              !/^[a-f0-9]{64}$/.test(c.file.versionDigest))) ||
          (c.file.identity !== null &&
            (!c.file.identity || !id(c.file.identity.device) || !id(c.file.identity.inode))))
      )
        return this.fail("PORT_INVALID_OPERATION", "Invalid file resource identity");
      return {
        ref: c.ref,
        hostId: c.hostId,
        canonicalRootId: c.canonicalRootId,
        access: c.access,
        ...(c.file === undefined
          ? {}
          : {
              file: {
                name: c.file.name,
                identity:
                  c.file.identity === null
                    ? null
                    : { device: c.file.identity.device, inode: c.file.identity.inode },
                atomicPublish: c.file.atomicPublish,
                ...(c.file.versionDigest === undefined
                  ? {}
                  : { versionDigest: c.file.versionDigest }),
              },
            }),
        lineage: c.lineage.map((i: SandboxWorkspaceClaim["lineage"][number]) => ({
          device: i.device,
          inode: i.inode,
        })),
      };
    });
    if (
      new Set(claims.map((c) => c.ref)).size !== claims.length ||
      !same([...claims.map((c) => c.ref)].sort(), [...conflictRefs].sort())
    )
      return this.fail("PORT_CONFLICT", "Workspace claims do not cover frozen environment");
    return claims;
  }
  private assertAvailable(
    claims: readonly SandboxWorkspaceClaim[],
    exceptJob: string,
    now: string,
  ): void {
    this.queue.assertFair(claims, exceptJob, now);
    for (const claim of claims) {
      const legacy = this.db
        .prepare(
          "SELECT job_id FROM sandbox_legacy_occupancy WHERE released_at IS NULL AND (host_id=? OR host_id IS NULL) AND job_id != ? LIMIT 1",
        )
        .get(claim.hostId, exceptJob);
      if (legacy) this.fail("PORT_CONFLICT", "Legacy execution has unresolved host occupancy");
      const occupied = this.db
        .prepare(`SELECT o.claim_json AS claim,r.facts_json AS facts, EXISTS(SELECT 1 FROM sandbox_execution_intents i WHERE i.job_id=r.job_id AND i.kind='continue' AND i.dispatched_at IS NOT NULL AND i.acknowledged_at IS NULL) OR EXISTS(SELECT 1 FROM sandbox_workspace_barriers b WHERE b.job_id=r.job_id AND b.resolved_at IS NULL) AS uncertain FROM sandbox_workspace_occupancy o JOIN sandbox_execution_records r ON r.job_id=o.job_id
        WHERE o.host_id=? AND (o.released_at IS NULL OR EXISTS(SELECT 1 FROM sandbox_workspace_barriers b WHERE b.job_id=o.job_id AND b.resolved_at IS NULL)) AND o.job_id != ?`)
        .all(claim.hostId, exceptJob) as { claim: string; facts: string; uncertain: number }[];
      for (const row of occupied) {
        const existing = JSON.parse(row.claim) as SandboxWorkspaceClaim;
        const rawFacts = JSON.parse(row.facts) as { schemaVersion?: unknown };
        if (rawFacts.schemaVersion === "sandbox-preparation.v1") {
          sandboxExecutionReservationSchema.parse(rawFacts);
          if (conflicts(claim, existing))
            this.fail("PORT_CONFLICT", "Workspace has a pending preparation", {
              reasonCode: "WORKSPACE_OCCUPIED",
            });
          continue;
        }
        const facts = sandboxExecutionFactsSchema.parse(rawFacts);
        const uncertain =
          row.uncertain !== 0 ||
          (facts.resource.supervision === "controlled" &&
            facts.resource.evidence.validUntil <= now) ||
          facts.resource.cleanup === "unknown" ||
          facts.resource.supervision === "reconciling" ||
          (facts.effect.kind === "unknown" && facts.result !== null);
        if (conflicts(claim, existing, uncertain))
          this.fail("PORT_CONFLICT", "Workspace remains occupied", {
            reasonCode: "WORKSPACE_OCCUPIED",
          });
      }
    }
  }
  private read(
    identity: SandboxJobIdentity,
    owner: string,
    agent: string,
  ): SandboxExecutionRecord | undefined {
    if (identity.ownerId !== owner || identity.agentId !== agent)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Sandbox scope mismatch");
    const row = this.db
      .prepare(
        "SELECT plan_json AS plan,facts_json AS facts,admission_json AS admission,started_at AS startedAt,sequence,operation_revision AS operationRevision FROM sandbox_execution_records WHERE job_id=? AND owner_id=? AND agent_id=?",
      )
      .get(identity.jobId, owner, agent) as Row | undefined;
    if (!row) return undefined;
    if (
      (JSON.parse(row.facts) as { schemaVersion?: unknown }).schemaVersion ===
      "sandbox-preparation.v1"
    )
      return this.fail("PORT_CONFLICT", "Sandbox runtime has not been bound");
    const plan = sandboxExecutionPlanV2Schema.parse(JSON.parse(row.plan));
    if (!same(plan.identity, identity))
      return this.fail("PORT_CONFLICT", "Sandbox identity changed");
    const workspaces = (
      this.db
        .prepare(
          "SELECT claim_json AS claim FROM sandbox_workspace_occupancy WHERE job_id=? ORDER BY scope_ref",
        )
        .all(identity.jobId) as { claim: string }[]
    ).map((r) => JSON.parse(r.claim) as SandboxWorkspaceClaim);
    const releaseReceipt = this.releases.read(identity.jobId);
    return {
      plan,
      facts: sandboxExecutionFactsSchema.parse(JSON.parse(row.facts)),
      workspaces,
      startedAt: row.startedAt,
      operationRevision: row.operationRevision,
      ...(releaseReceipt ? { releaseReceipt } : {}),
      ...new SqliteSandboxRecoveryOperations(this.db, this.fail).read(identity.jobId),
      workspaceBlocked: Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM sandbox_workspace_occupancy WHERE job_id=? AND released_at IS NULL UNION ALL SELECT 1 FROM sandbox_workspace_barriers WHERE job_id=? AND resolved_at IS NULL LIMIT 1",
          )
          .get(identity.jobId, identity.jobId),
      ),
    };
  }
  private readAdmission(
    identity: SandboxJobIdentity,
    owner: string,
    agent: string,
  ): SandboxExecutionAdmissionRecord | undefined {
    if (identity.ownerId !== owner || identity.agentId !== agent)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Sandbox scope mismatch");
    const row = this.db
      .prepare(
        "SELECT preparation_state AS phase,plan_json AS plan,facts_json AS facts,reservation_stopped_at AS stoppedAt FROM sandbox_execution_records WHERE job_id=? AND owner_id=? AND agent_id=?",
      )
      .get(identity.jobId, owner, agent) as
      | { phase: string; plan: string; facts: string; stoppedAt: string | null }
      | undefined;
    if (!row) return undefined;
    const plan = sandboxExecutionPlanV2Schema.parse(JSON.parse(row.plan));
    if (!same(plan.identity, identity))
      return this.fail("PORT_CONFLICT", "Sandbox identity changed");
    if (row.phase !== "reserved") {
      const record = this.read(identity, owner, agent);
      if (!record) return this.fail("PORT_NOT_FOUND", "Sandbox execution missing");
      return { phase: "bound", record };
    }
    const reservation = sandboxExecutionReservationSchema.parse(JSON.parse(row.facts));
    const workspaces = (
      this.db
        .prepare(
          "SELECT claim_json AS claim FROM sandbox_workspace_occupancy WHERE job_id=? ORDER BY scope_ref",
        )
        .all(identity.jobId) as { claim: string }[]
    ).map((row) => JSON.parse(row.claim) as SandboxWorkspaceClaim);
    return {
      phase: "reserved",
      ...(row.stoppedAt ? { stopRequestedAt: row.stoppedAt } : {}),
      plan,
      reservation,
      workspaces,
      ...new SqliteSandboxRecoveryOperations(this.db, this.fail).read(identity.jobId),
    };
  }
  private reserve(
    input: Parameters<SandboxExecutionPreparationPort["reserve"]>[0],
    owner: string,
    agent: string,
  ) {
    const candidate = sandboxExecutionPlanCandidateV2Schema.parse(input.plan);
    const reservation = sandboxExecutionReservationSchema.parse(input.reservation);
    this.queue.assertUnchanged(
      { ...input, plan: candidate, reservation },
      this.claims(input.workspaces, candidate, reservation.workspaceConflictRefs),
    );
    const consumed = this.authority.consume(input.invocation, owner, agent);
    const plan = sandboxExecutionPlanV2Schema.parse({
      ...candidate,
      semanticFingerprint: consumed.receipt.semanticFingerprint,
    });
    const workspaces = [
      ...this.claims(input.workspaces, plan, reservation.workspaceConflictRefs),
    ].sort((a, b) => a.ref.localeCompare(b.ref));
    if (
      !same(plan.identity, reservation.identity) ||
      plan.identity.ownerId !== owner ||
      plan.identity.agentId !== agent ||
      plan.identity.receiptRef !== consumed.receipt.receiptRef ||
      plan.identity.invocationId !== consumed.receipt.invocationId ||
      plan.handleRef !== consumed.receipt.handleRef ||
      reservation.environmentId !== plan.environmentId ||
      reservation.mode !== plan.mode ||
      (reservation.resourceRef === null) !== (plan.mode === "foreground") ||
      reservation.createdAt !== plan.requestedAt ||
      reservation.createdAt > input.invocation.consumedAt
    )
      return this.fail("PORT_CONFLICT", "Reservation binding mismatch");
    const admission = JSON.stringify({ plan, reservation, workspaces });
    const previous = this.readAdmission(plan.identity, owner, agent);
    if (previous) {
      const row = this.db
        .prepare("SELECT admission_json AS admission FROM sandbox_execution_records WHERE job_id=?")
        .get(plan.identity.jobId) as { admission: string };
      if (row.admission !== admission)
        return this.fail("PORT_CONFLICT", "Reservation changed on replay");
      return { admission: previous, applied: false, receipt: consumed.receipt };
    }
    if (consumed.replayed)
      return this.fail("PORT_CONFLICT", "Consumed invocation without reservation is unknown");
    if (plan.mode === "service" && plan.operationContract.kind !== "service_start")
      return this.fail("PORT_INVALID_OPERATION", "Service request requires its existing resource");
    this.authority.live(plan, input.invocation.authority, input.invocation.consumedAt);
    this.assertAvailable(workspaces, plan.identity.jobId, input.invocation.consumedAt);
    if (
      this.db
        .prepare("SELECT 1 FROM sandbox_jobs WHERE job_id=? OR receipt_ref=? OR attempt_id=?")
        .get(plan.identity.jobId, plan.identity.receiptRef, plan.identity.attemptId)
    )
      return this.fail("PORT_CONFLICT", "Invocation has a v1 sandbox record");
    this.db
      .prepare(
        "INSERT INTO sandbox_execution_records(job_id,attempt_id,receipt_ref,owner_id,agent_id,run_id,invocation_id,environment_id,resource_ref,plan_json,admission_json,facts_json,sequence,preparation_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'reserved')",
      )
      .run(
        plan.identity.jobId,
        plan.identity.attemptId,
        plan.identity.receiptRef,
        owner,
        agent,
        plan.identity.runId,
        plan.identity.invocationId,
        plan.environmentId,
        reservation.resourceRef,
        JSON.stringify(plan),
        admission,
        JSON.stringify(reservation),
      );
    for (const claim of workspaces)
      this.db
        .prepare(
          "INSERT INTO sandbox_workspace_occupancy(job_id,scope_ref,host_id,claim_json) VALUES(?,?,?,?)",
        )
        .run(plan.identity.jobId, claim.ref, claim.hostId, JSON.stringify(claim));
    this.db
      .prepare(
        "INSERT INTO sandbox_execution_observations(job_id,sequence,facts_json) VALUES(?,1,?)",
      )
      .run(plan.identity.jobId, JSON.stringify(reservation));
    this.queue.admitted(plan.identity.jobId);
    return {
      admission: { phase: "reserved" as const, plan, reservation, workspaces },
      applied: true,
      receipt: consumed.receipt,
    };
  }
  private bindAndStart(
    input: Parameters<SandboxExecutionPreparationPort["bindAndStart"]>[0],
    owner: string,
    agent: string,
  ) {
    const admission = this.readAdmission(input.identity, owner, agent);
    if (!admission) return this.fail("PORT_NOT_FOUND", "Sandbox reservation missing");
    if (admission.phase === "reserved" && admission.stopRequestedAt)
      return this.fail("PORT_CONFLICT", "Sandbox reservation stopped");
    const plan = admission.phase === "reserved" ? admission.plan : admission.record.plan;
    this.authority.live(plan, input.authority, input.now);
    const facts = validateSandboxExecutionFacts(plan, input.facts, {
      environment: input.facts.environment,
      operationContract: plan.operationContract,
    });
    if (
      input.expectedSequence !== 1 ||
      facts.result !== null ||
      facts.effect.kind !== "unknown" ||
      facts.resource.sequence !== 2 ||
      facts.resource.supervision !== "initializing" ||
      facts.resource.occurredAt > input.now
    )
      return this.fail("PORT_CONFLICT", "Start cannot assert execution or effects");
    if (admission.phase === "bound") {
      const initial = this.db
        .prepare(
          "SELECT facts_json AS facts FROM sandbox_execution_observations WHERE job_id=? AND sequence=2",
        )
        .get(plan.identity.jobId) as { facts: string } | undefined;
      const state = this.db
        .prepare("SELECT preparation_state AS state FROM sandbox_execution_records WHERE job_id=?")
        .get(plan.identity.jobId) as { state: string };
      if (
        state.state !== "bound" ||
        !admission.record.startedAt ||
        !initial ||
        initial.facts !== JSON.stringify(facts)
      )
        return this.fail("PORT_CONFLICT", "Start binding changed");
      return { record: admission.record, applied: false };
    }
    if (
      facts.environment.resourceRef !== admission.reservation.resourceRef ||
      !same(
        [...facts.environment.workspaceConflictRefs].sort(),
        [...admission.reservation.workspaceConflictRefs].sort(),
      )
    )
      return this.fail("PORT_CONFLICT", "Environment differs from reservation");
    this.assertAvailable(admission.workspaces, plan.identity.jobId, input.now);
    this.db
      .prepare(
        "UPDATE sandbox_execution_records SET preparation_state='bound',started_at=?,start_policy_digest=?,facts_json=?,sequence=2 WHERE job_id=? AND preparation_state='reserved'",
      )
      .run(input.now, facts.environment.policyDigest, JSON.stringify(facts), plan.identity.jobId);
    this.db
      .prepare(
        "INSERT INTO sandbox_execution_observations(job_id,sequence,facts_json) VALUES(?,2,?)",
      )
      .run(plan.identity.jobId, JSON.stringify(facts));
    return {
      record: {
        plan,
        facts,
        workspaces: admission.workspaces,
        startedAt: input.now,
        operationRevision: 0,
        workspaceBlocked: admission.workspaces.length > 0,
      },
      applied: true,
    };
  }
  private admit(input: Input<"admit">, owner: string, agent: string) {
    const candidate = sandboxExecutionPlanCandidateV2Schema.parse(input.plan);
    const consumed = this.authority.consume(input.invocation, owner, agent);
    const plan = sandboxExecutionPlanV2Schema.parse({
      ...candidate,
      semanticFingerprint: consumed.receipt.semanticFingerprint,
    });
    const facts = validateSandboxExecutionFacts(plan, input.facts, {
      environment: input.facts.environment,
      operationContract: plan.operationContract,
    });
    const workspaces = [
      ...this.claims(input.workspaces, plan, facts.environment.workspaceConflictRefs),
    ].sort((a, b) => a.ref.localeCompare(b.ref));
    if (
      plan.identity.ownerId !== owner ||
      plan.identity.agentId !== agent ||
      plan.identity.receiptRef !== consumed.receipt.receiptRef ||
      plan.identity.invocationId !== consumed.receipt.invocationId ||
      plan.handleRef !== consumed.receipt.handleRef
    )
      return this.fail("PORT_CONFLICT", "Consumed invocation mismatch");
    const admission = JSON.stringify({ plan, facts, workspaces });
    const previous = this.read(plan.identity, owner, agent);
    if (previous) {
      const row = this.db
        .prepare("SELECT admission_json AS admission FROM sandbox_execution_records WHERE job_id=?")
        .get(plan.identity.jobId) as { admission: string };
      if (row.admission !== admission)
        return this.fail("PORT_CONFLICT", "Admission changed on replay");
      return { record: previous, applied: false, receipt: consumed.receipt };
    }
    if (consumed.replayed)
      return this.fail("PORT_CONFLICT", "Consumed invocation without journal is unknown");
    if (
      facts.result !== null ||
      facts.resource.sequence !== 1 ||
      facts.resource.supervision !== "initializing" ||
      facts.resource.occurredAt > input.invocation.consumedAt
    )
      return this.fail("PORT_CONFLICT", "Initial observation cannot assert execution");
    if (plan.mode === "service" && plan.operationContract.kind !== "service_start")
      return this.fail(
        "PORT_INVALID_OPERATION",
        "Service request persistence is outside this delivery scope",
      );
    this.authority.live(plan, input.invocation.authority, input.invocation.consumedAt);
    this.assertAvailable(workspaces, plan.identity.jobId, input.invocation.consumedAt);
    if (
      this.db
        .prepare("SELECT 1 FROM sandbox_jobs WHERE job_id=? OR receipt_ref=? OR attempt_id=?")
        .get(plan.identity.jobId, plan.identity.receiptRef, plan.identity.attemptId)
    )
      return this.fail("PORT_CONFLICT", "Invocation has a v1 sandbox record");
    this.db
      .prepare(`INSERT INTO sandbox_execution_records(job_id,attempt_id,receipt_ref,owner_id,agent_id,run_id,invocation_id,environment_id,resource_ref,plan_json,admission_json,facts_json,sequence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(
        plan.identity.jobId,
        plan.identity.attemptId,
        plan.identity.receiptRef,
        owner,
        agent,
        plan.identity.runId,
        plan.identity.invocationId,
        plan.environmentId,
        facts.environment.resourceRef,
        JSON.stringify(plan),
        admission,
        JSON.stringify(facts),
      );
    for (const claim of workspaces)
      this.db
        .prepare(
          "INSERT INTO sandbox_workspace_occupancy(job_id,scope_ref,host_id,claim_json) VALUES(?,?,?,?)",
        )
        .run(plan.identity.jobId, claim.ref, claim.hostId, JSON.stringify(claim));
    this.db
      .prepare(
        "INSERT INTO sandbox_execution_observations(job_id,sequence,facts_json) VALUES(?,1,?)",
      )
      .run(plan.identity.jobId, JSON.stringify(facts));
    return {
      record: {
        plan,
        facts,
        workspaces,
        startedAt: null,
        operationRevision: 0,
        workspaceBlocked: workspaces.length > 0,
      },
      applied: true,
      receipt: consumed.receipt,
    };
  }
  private append(
    input: Input<"append">,
    current: SandboxExecutionRecord,
    owner: string,
    agent: string,
    operationOnly = false,
  ) {
    const facts = sandboxExecutionFactsSchema.parse(input.facts);
    const old = this.db
      .prepare(
        "SELECT facts_json AS facts FROM sandbox_execution_observations WHERE job_id=? AND sequence=?",
      )
      .get(current.plan.identity.jobId, facts.resource.sequence) as { facts: string } | undefined;
    if (old && !operationOnly) {
      if (old.facts !== JSON.stringify(facts))
        return this.fail("PORT_CONFLICT", "Observation replay changed");
      return { record: current, applied: false };
    }
    if (operationOnly && input.expectedOperationRevision < current.operationRevision) {
      const replay = this.db
        .prepare(
          "SELECT operation_json FROM sandbox_operation_observations WHERE job_id=? AND revision=?",
        )
        .get(current.plan.identity.jobId, input.expectedOperationRevision + 1) as
        | { operation_json: string }
        | undefined;
      if (
        replay?.operation_json === JSON.stringify({ result: facts.result, effect: facts.effect }) &&
        same(facts.environment, current.facts.environment) &&
        same(facts.resource, current.facts.resource)
      )
        return { record: current, applied: false };
    }
    if (input.expectedOperationRevision !== current.operationRevision)
      return this.fail("PORT_CONFLICT", "Operation observation CAS failed");
    if (input.expectedSequence !== current.facts.resource.sequence)
      return this.fail("PORT_CONFLICT", "Observation CAS failed");
    validateSandboxExecutionFacts(
      current.plan,
      facts,
      { environment: current.facts.environment, operationContract: current.plan.operationContract },
      operationOnly ? undefined : current.facts,
    );
    if (operationOnly) {
      if (!same(facts.resource, current.facts.resource))
        return this.fail("PORT_CONFLICT", "Operation update changed resource observation");
      if (
        current.facts.result &&
        current.facts.result.kind !== "unknown" &&
        !same(current.facts.result, facts.result)
      )
        return this.fail("PORT_CONFLICT", "Known operation result is immutable");
      if (current.facts.effect.kind === "verified" && !same(current.facts.effect, facts.effect))
        return this.fail("PORT_CONFLICT", "Verified effect is immutable");
    }
    if (
      facts.resource.occurredAt > input.now ||
      (facts.result && facts.result.occurredAt > input.now) ||
      (facts.effect.kind === "verified" && facts.effect.occurredAt > input.now)
    )
      return this.fail("PORT_INVALID_OPERATION", "Observation is in the future");
    if (facts.resource.supervision === "controlled" && current.startedAt === null)
      return this.fail("PORT_CONFLICT", "No persisted start intent");
    if (facts.result && facts.result.kind !== "unknown") {
      const out = facts.result.output;
      const exists = this.db
        .prepare(`SELECT 1 FROM run_payload_artifacts a JOIN payloads p ON p.ref=a.payload_ref AND p.owner_id=a.owner_id AND p.agent_id=a.agent_id
        WHERE a.owner_id=? AND a.agent_id=? AND a.run_id=? AND a.purpose='worker_result' AND a.operation_key=? AND a.payload_ref=? AND a.content_digest=? AND p.lifecycle_state='active'`)
        .get(
          owner,
          agent,
          current.plan.identity.runId,
          capabilityInvocationOutputOperationKey(current.plan.identity.invocationId),
          out.ref,
          `sha256:${out.digest}`,
        );
      const recovered =
        !exists &&
        current.plan.operationContract.ref === PI_FIXED_FILE_CONTRACT.ref &&
        current.plan.operationContract.version === PI_FIXED_FILE_CONTRACT.version &&
        current.plan.operationContract.kind === "verified_effect" &&
        ["write", "edit"].includes(current.plan.operation) &&
        this.db
          .prepare(`SELECT 1 FROM run_payload_artifacts a JOIN payloads p ON p.ref=a.payload_ref AND p.owner_id=a.owner_id AND p.agent_id=a.agent_id
          WHERE a.owner_id=? AND a.agent_id=? AND a.run_id=? AND a.purpose='trace' AND a.operation_key=? AND a.payload_ref=? AND a.content_digest=? AND p.lifecycle_state='active'`)
          .get(
            owner,
            agent,
            current.plan.identity.runId,
            piFileRecoveryOperationKey(current.plan.identity.invocationId),
            out.ref,
            `sha256:${out.digest}`,
          );
      if (!exists && !recovered)
        return this.fail("PORT_CONFLICT", "Output is not durably bound to invocation");
    }
    const projection = projectSandboxExecution(current.plan, facts, {
      ...input.context,
      releaseReceipt: operationOnly ? (current.releaseReceipt ?? null) : null,
      now: input.now,
      environment: current.facts.environment,
      operationContract: current.plan.operationContract,
      currentResourceSequence: facts.resource.sequence,
    });
    if (
      (facts.resource.supervision === "controlled" ||
        (facts.resource.supervision === "released" &&
          !(operationOnly && current.releaseReceipt))) &&
      !input.context.verification
    )
      return this.fail("PORT_NOT_AUTHORITATIVE", "Verified supervision evidence required");
    if (
      (facts.resource.supervision === "released" && !projection.resourceObligationReleased) ||
      (facts.resource.supervision === "controlled" && !projection.supervisionControlled)
    )
      return this.fail("PORT_NOT_AUTHORITATIVE", "Supervision evidence failed");
    if (
      facts.effect.kind === "verified" &&
      !same(current.facts.effect, facts.effect) &&
      !projection.operationSettled
    )
      return this.fail("PORT_NOT_AUTHORITATIVE", "Verified effect evidence failed");
    const operationChanged = !same(
      { result: current.facts.result, effect: current.facts.effect },
      { result: facts.result, effect: facts.effect },
    );
    const operationRevision = current.operationRevision + (operationChanged ? 1 : 0);
    if (operationChanged)
      this.db
        .prepare(
          "INSERT INTO sandbox_operation_observations(job_id,revision,operation_json) VALUES(?,?,?)",
        )
        .run(
          current.plan.identity.jobId,
          operationRevision,
          JSON.stringify({ result: facts.result, effect: facts.effect }),
        );
    if (!operationOnly)
      this.db
        .prepare(
          "INSERT INTO sandbox_execution_observations(job_id,sequence,facts_json) VALUES(?,?,?)",
        )
        .run(current.plan.identity.jobId, facts.resource.sequence, JSON.stringify(facts));
    const changed = this.db
      .prepare(
        "UPDATE sandbox_execution_records SET facts_json=?,sequence=?,operation_revision=? WHERE job_id=? AND sequence=?",
      )
      .run(
        JSON.stringify(facts),
        facts.resource.sequence,
        operationRevision,
        current.plan.identity.jobId,
        input.expectedSequence,
      );
    if (changed.changes !== 1) return this.fail("PORT_CONFLICT", "Observation CAS failed");
    const updated = { ...current, facts, operationRevision };
    if (facts.resource.supervision === "released" && (!operationOnly || !current.releaseReceipt)) {
      if (!input.context.verification)
        return this.fail("PORT_NOT_AUTHORITATIVE", "Release proof missing");
      this.releases.accept(updated, input.context.verification, input.authority, input.now);
    }
    return { record: this.read(current.plan.identity, owner, agent), applied: true };
  }
  private hasPendingIntent(jobId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sandbox_execution_intents WHERE job_id=? AND dispatched_at IS NOT NULL AND acknowledged_at IS NULL LIMIT 1",
        )
        .get(jobId),
    );
  }
  private intent(
    operation: string,
    input: Input<"prepareIntent">,
    current: SandboxExecutionRecord,
  ) {
    if (!id(input.intentId) || !["tool_result", "continue"].includes(input.kind))
      return this.fail("PORT_INVALID_OPERATION", "Invalid continuation intent");
    const old = this.db
      .prepare("SELECT * FROM sandbox_execution_intents WHERE intent_id=?")
      .get(input.intentId) as
      | {
          job_id: string;
          kind: string;
          sequence: number;
          operation_revision: number;
          authority_json: string;
          dispatched_at: string | null;
        }
      | undefined;
    if (
      old &&
      (old.job_id !== current.plan.identity.jobId ||
        old.kind !== input.kind ||
        old.sequence !== input.expectedSequence ||
        old.authority_json !== JSON.stringify(input.authority))
    )
      return this.fail("PORT_CONFLICT", "Intent binding changed");
    if (old?.dispatched_at) return { applied: false };
    if (current.facts.resource.sequence !== input.expectedSequence)
      return this.fail("PORT_CONFLICT", "Continuation sequence changed");
    if (old && old.operation_revision !== current.operationRevision)
      return this.fail("PORT_CONFLICT", "Continuation operation revision changed");
    this.authority.live(current.plan, input.authority, input.now);
    if (input.kind === "continue")
      this.assertAvailable(current.workspaces, current.plan.identity.jobId, input.now);
    if (this.hasPendingIntent(current.plan.identity.jobId))
      return this.fail("PORT_CONFLICT", "Dispatched operation remains uncertain");
    const projection = projectSandboxExecution(current.plan, current.facts, {
      ...input.context,
      releaseReceipt: current.releaseReceipt ?? null,
      now: input.now,
      environment: current.facts.environment,
      operationContract: current.plan.operationContract,
      currentResourceSequence: current.facts.resource.sequence,
      currentAuthority: true,
      currentFence: true,
    });
    if (!projection.continuePi || (input.kind === "tool_result" && !projection.deliverToolResult))
      return this.fail("PORT_NOT_AUTHORITATIVE", "Continuation is not safe");
    if (operation === "prepareIntent") {
      if (old) return { applied: false };
      this.db
        .prepare(
          "INSERT INTO sandbox_execution_intents(intent_id,job_id,kind,sequence,operation_revision,authority_json,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          input.intentId,
          current.plan.identity.jobId,
          input.kind,
          input.expectedSequence,
          current.operationRevision,
          JSON.stringify(input.authority),
          input.now,
        );
      return { applied: true };
    }
    if (!old) return this.fail("PORT_NOT_FOUND", "Continuation intent missing");
    this.db
      .prepare(
        "UPDATE sandbox_execution_intents SET dispatched_at=? WHERE intent_id=? AND dispatched_at IS NULL",
      )
      .run(input.now, input.intentId);
    // Result delivery cannot launch a writer. Unacknowledged control has separate protection.
    if (input.kind === "continue")
      this.releases.protect(
        current.plan.identity.jobId,
        `intent:${input.intentId}`,
        "control_unacknowledged",
        "SANDBOX_CONTROL_ACK_PENDING",
        input.now,
      );
    return { applied: true };
  }
}
