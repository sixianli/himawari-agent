import {
  PORT_ERROR_CODES,
  SchedulerService,
  UnifiedTriggerIngestionService,
  type ScheduledJobWrite,
  type TriggerAdmissionPort,
} from "@himawari-agent/application";
import {
  createAgent,
  createAgentAuthorityLease,
  createAgentId,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createIdempotencyKey,
  createOwner,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import type { AdmitTriggerCommand } from "@himawari-agent/gateway-contracts";
import { ManualClock, createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";

class PipelineAdmissionPort implements TriggerAdmissionPort {
  readonly commands: AdmitTriggerCommand[] = [];
  readonly stages: string[] = [];
  private readonly results = new Map<string, string>();

  async admit(command: AdmitTriggerCommand) {
    this.commands.push(command);
    const existing = this.results.get(command.idempotencyKey);
    if (existing) return { resultRef: existing, replayed: true };
    const resultRef = `run:${command.payload.triggerId}`;
    this.results.set(command.idempotencyKey, resultRef);
    this.stages.push("context", "permission", "trace");
    await Promise.resolve();
    return { resultRef, replayed: false };
  }
}

function scheduledJob(
  ownerId: ReturnType<typeof createOwnerId>,
  agentId: ReturnType<typeof createAgentId>,
  overrides: Partial<ScheduledJobWrite> = {},
): ScheduledJobWrite {
  return {
    id: "job-restaurant-monitor",
    ownerId,
    agentId,
    threadId: createThreadId("thread-restaurant-monitor"),
    payloadRef: "payload-restaurant-monitor",
    sourceProofRef: "proof-long-term-task-authorization",
    dataClassification: "private",
    authorizationRef: "grant-restaurant-monitor",
    taskScopeRef: "scope-beef-restaurants",
    capabilityRef: "restaurant-monitor",
    operation: "scan",
    resourceRef: "restaurant:beef",
    sideEffect: "none",
    estimatedCostMicros: 100,
    intervalMs: 1_000,
    minimumIntervalMs: 1_000,
    expiresAt: "2026-08-26T00:00:00.000Z",
    revokedAt: null,
    nextRunAt: T0,
    occurrence: 0,
    status: "active",
    ...overrides,
  };
}

async function fixture() {
  const owner = createOwner(createOwnerId("owner-scheduler"));
  const agent = createAgent({ id: createAgentId("agent-scheduler"), owner });
  const clock = new ManualClock(T0);
  const adapters = createReferenceAdapterSet({ clock });
  const lease = createAgentAuthorityLease({
    id: createAuthorityLeaseId("lease-scheduler"),
    agent,
    holderId: createAuthorityHolderId("holder-scheduler"),
  });
  const authorityRecord = await adapters.authority.claim(lease, 60_000);
  const authority = { leaseId: lease.id, fencingToken: authorityRecord.fencingToken };
  const admission = new PipelineAdmissionPort();
  const service = new SchedulerService({
    scheduler: adapters.scheduler,
    triggers: new UnifiedTriggerIngestionService(admission),
    authority: adapters.authority,
    authorization: adapters.authorization,
    clock,
  });
  return { adapters, admission, agent, authority, clock, service };
}

async function seedLongTermGrant(setup: Awaited<ReturnType<typeof fixture>>) {
  const approval = {
    id: "approval-restaurant-monitor",
    revision: 1,
    ownerId: setup.agent.ownerId,
    agentId: setup.agent.id,
    runId: createRunId("run-restaurant-monitor-approval"),
    intentId: "intent-restaurant-monitor",
    intentSnapshot: {
      id: "intent-restaurant-monitor",
      ownerId: setup.agent.ownerId,
      agentId: setup.agent.id,
      runId: createRunId("run-restaurant-monitor-approval"),
      capabilityRef: "restaurant-monitor",
      operation: "scan",
      resourceRef: "restaurant:beef",
      dataClassification: "private" as const,
      sideEffect: "none" as const,
      estimatedCostMicros: 100,
      frequency: { count: 1, intervalMs: 1_000 },
      idempotencyKey: createIdempotencyKey("intent-restaurant-monitor"),
      reversible: true,
      requestedAt: T0,
    },
    semanticSnapshotHash: "snapshot-restaurant-monitor",
    status: "pending" as const,
    deliveryState: "deliverable" as const,
    requestedAt: T0,
    expiresAt: T1,
    decidedAt: null,
    grantId: null,
  };
  await setup.adapters.authorization.createApproval(approval);
  await setup.adapters.authorization.resolveApproval({
    approvalRequestId: approval.id,
    expectedRevision: approval.revision,
    semanticSnapshotHash: approval.semanticSnapshotHash,
    resolution: "approved",
    decidedAt: T0,
    grant: {
      id: "grant-restaurant-monitor",
      revision: 1,
      ownerId: setup.agent.ownerId,
      agentId: setup.agent.id,
      kind: "long_term",
      scope: {
        capabilityRef: "restaurant-monitor",
        operations: ["scan"],
        exactResourceRef: null,
        resourcePrefixes: ["restaurant:"],
        maxDataClassification: "private",
        sideEffects: ["none"],
        maxCostMicrosPerUse: 100,
        maxFrequency: { count: 1, intervalMs: 1_000 },
      },
      intentFingerprint: null,
      sourceApprovalRequestId: approval.id,
      validFrom: T0,
      expiresAt: "2026-08-26T00:00:00.000Z",
      maxUses: 100,
      uses: 0,
      maxTotalCostMicros: 10_000,
      spentCostMicros: 0,
      revokedAt: null,
      revocationReasonCode: null,
    },
  });
}

describe("Task 14 Scheduler and unified trigger ingestion", () => {
  it("dispatches through unified admission and preserves the downstream context, Permission and Trace path", async () => {
    const setup = await fixture();
    await seedLongTermGrant(setup);
    await setup.adapters.scheduler.upsert(scheduledJob(setup.agent.ownerId, setup.agent.id), null);

    const result = await setup.service.dispatchDue({ authority: setup.authority, limit: 10 });

    expect(result.records).toEqual([
      {
        jobId: "job-restaurant-monitor",
        outcome: "dispatched",
        reasonCode: "TRIGGER_ADMITTED",
        triggerResultRef: "run:schedule-trigger:job-restaurant-monitor:0",
        nextRunAt: T1,
      },
    ]);
    expect(setup.admission.commands).toHaveLength(1);
    expect(setup.admission.commands[0]).toMatchObject({
      type: "trigger.admit",
      idempotencyKey: "schedule-command:job-restaurant-monitor:0",
      actor: { actorType: "scheduler", actorId: "scheduler:job-restaurant-monitor" },
      payload: {
        sourceType: "schedule",
        sourceId: "job-restaurant-monitor",
        occurredAt: T0,
        sourceProofRef: "proof-long-term-task-authorization",
      },
    });
    expect(setup.admission.stages).toEqual(["context", "permission", "trace"]);
  });

  it("deduplicates concurrent timer delivery and advances the schedule only once", async () => {
    const setup = await fixture();
    await seedLongTermGrant(setup);
    await setup.adapters.scheduler.upsert(scheduledJob(setup.agent.ownerId, setup.agent.id), null);

    const results = await Promise.all([
      setup.service.dispatchDue({ authority: setup.authority, limit: 10 }),
      setup.service.dispatchDue({ authority: setup.authority, limit: 10 }),
    ]);

    expect(
      results
        .flatMap(({ records }) => records)
        .map(({ outcome }) => outcome)
        .sort(),
    ).toEqual(["dispatched", "duplicate"]);
    expect(setup.admission.commands).toHaveLength(2);
    expect(new Set(setup.admission.commands.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(
      1,
    );
    expect(setup.admission.stages).toEqual(["context", "permission", "trace"]);
    expect(await setup.adapters.scheduler.read("job-restaurant-monitor")).toMatchObject({
      revision: 2,
      occurrence: 1,
      nextRunAt: T1,
    });
  });

  it("coalesces a forward clock jump into one trigger instead of replaying every missed interval", async () => {
    const setup = await fixture();
    await seedLongTermGrant(setup);
    await setup.adapters.scheduler.upsert(scheduledJob(setup.agent.ownerId, setup.agent.id), null);
    setup.clock.advance(10_500);

    await setup.service.dispatchDue({ authority: setup.authority, limit: 10 });

    expect(setup.admission.commands).toHaveLength(1);
    expect(await setup.adapters.scheduler.read("job-restaurant-monitor")).toMatchObject({
      occurrence: 11,
      nextRunAt: "2026-08-25T00:00:11.000Z",
    });
  });

  it.each([
    ["expired", { expiresAt: T0 }, "SCHEDULE_AUTHORIZATION_EXPIRED"],
    ["revoked", { revokedAt: T0 }, "SCHEDULE_AUTHORIZATION_REVOKED"],
    [
      "frequency-out-of-scope",
      { intervalMs: 500, minimumIntervalMs: 1_000 },
      "SCHEDULE_FREQUENCY_EXCEEDS_SCOPE",
    ],
  ] as const)("disables a %s long-term task before admission", async (_case, override, reason) => {
    const setup = await fixture();
    await seedLongTermGrant(setup);
    await setup.adapters.scheduler.upsert(
      scheduledJob(setup.agent.ownerId, setup.agent.id, override),
      null,
    );

    const result = await setup.service.dispatchDue({ authority: setup.authority, limit: 10 });

    expect(result.records[0]).toMatchObject({ outcome: "disabled", reasonCode: reason });
    expect(setup.admission.commands).toEqual([]);
    expect(await setup.adapters.scheduler.read("job-restaurant-monitor")).toMatchObject({
      status: "cancelled",
      revision: 2,
    });
  });

  it("reads current Grant revocation and task scope before each timer Run", async () => {
    const revoked = await fixture();
    await seedLongTermGrant(revoked);
    await revoked.adapters.authorization.revokeGrant(
      "grant-restaurant-monitor",
      T0,
      "owner_revoked",
    );
    await revoked.adapters.scheduler.upsert(
      scheduledJob(revoked.agent.ownerId, revoked.agent.id),
      null,
    );

    const revokedResult = await revoked.service.dispatchDue({
      authority: revoked.authority,
      limit: 10,
    });
    expect(revokedResult.records[0]).toMatchObject({
      outcome: "disabled",
      reasonCode: "SCHEDULE_AUTHORIZATION_REVOKED",
    });
    expect(revoked.admission.commands).toEqual([]);

    const outsideScope = await fixture();
    await seedLongTermGrant(outsideScope);
    await outsideScope.adapters.scheduler.upsert(
      scheduledJob(outsideScope.agent.ownerId, outsideScope.agent.id, {
        operation: "reserve",
        sideEffect: "reversible",
      }),
      null,
    );
    const scopeResult = await outsideScope.service.dispatchDue({
      authority: outsideScope.authority,
      limit: 10,
    });
    expect(scopeResult.records[0]).toMatchObject({
      outcome: "disabled",
      reasonCode: "SCHEDULE_TASK_OUTSIDE_GRANT_SCOPE",
    });
    expect(outsideScope.admission.commands).toEqual([]);
  });

  it("fails closed under a stale authority fence without admitting a trigger", async () => {
    const setup = await fixture();
    await seedLongTermGrant(setup);
    await setup.adapters.scheduler.upsert(scheduledJob(setup.agent.ownerId, setup.agent.id), null);

    await expect(
      setup.service.dispatchDue({
        authority: { ...setup.authority, fencingToken: setup.authority.fencingToken + 1 },
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(setup.admission.commands).toEqual([]);
    expect(await setup.adapters.scheduler.read("job-restaurant-monitor")).toMatchObject({
      revision: 1,
      occurrence: 0,
    });
  });
});
