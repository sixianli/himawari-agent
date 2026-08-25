import {
  PORT_ERROR_CODES,
  ReliableEventPublisher,
  RunStateCommitCoordinator,
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
  createRun,
  createRunId,
  createSession,
  createSessionId,
  createTrigger,
  createTriggerId,
} from "@himawari-agent/domain";
import {
  DeterministicFailureScheduler,
  InMemoryReliableEventSink,
  ManualClock,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const owner = createOwner(createOwnerId("owner-task-5"));
const agent = createAgent({ id: createAgentId("agent-task-5"), owner });
const session = createSession({ id: createSessionId("session-task-5"), agent });
const trigger = createTrigger({
  id: createTriggerId("trigger-task-5"),
  idempotencyKey: createIdempotencyKey("trigger-task-5"),
  agent,
});
const run = createRun({ id: createRunId("run-task-5"), session, trigger });

function authorityLease(suffix = "01") {
  return createAgentAuthorityLease({
    id: createAuthorityLeaseId(`lease-task-5-${suffix}`),
    agent,
    holderId: createAuthorityHolderId(`coordinator-task-5-${suffix}`),
  });
}

async function fixture(failures?: DeterministicFailureScheduler) {
  const clock = new ManualClock("2026-08-25T01:00:00.000Z");
  const adapters = createReferenceAdapterSet({ clock, ...(failures ? { failures } : {}) });
  const lease = authorityLease();
  const authority = await adapters.authority.claim(lease, 60_000);
  const coordinator = new RunStateCommitCoordinator(adapters.productState, clock);
  return { adapters, authority, clock, coordinator };
}

function admissionInput(
  authority: Awaited<ReturnType<typeof fixture>>["authority"],
  overrides: Partial<Parameters<RunStateCommitCoordinator["admitRun"]>[0]> = {},
) {
  return {
    run,
    idempotencyKey: createIdempotencyKey("command-admit-task-5"),
    commandFingerprint: "trigger.admit:task-5:v1",
    authority: {
      leaseId: authority.lease.id,
      fencingToken: authority.fencingToken,
    },
    payloadRef: "payload-run-accepted-task-5",
    ...overrides,
  };
}

describe("product-state commit and reliable-event semantics", () => {
  it("makes Run state and its business event atomically visible", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("productState.commit.before", 1);
    const { adapters, authority, coordinator } = await fixture(failures);
    const input = admissionInput(authority);

    await expect(coordinator.admitRun(input)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INJECTED_FAILURE,
    });
    expect(await adapters.productState.read(`run:${run.id}`)).toBeUndefined();
    expect(await adapters.productState.listPending(10)).toEqual([]);
    expect(
      await coordinator.lookupCommand({
        ownerId: run.ownerId,
        agentId: run.agentId,
        idempotencyKey: input.idempotencyKey,
      }),
    ).toBeUndefined();

    const committed = await coordinator.admitRun(input);

    expect(committed).toMatchObject({
      replayed: false,
      state: { key: `run:${run.id}`, revision: 1, value: { status: "accepted" } },
      commandResult: { resultRef: `run:${run.id}`, stateRevision: 1 },
    });
    expect(await adapters.productState.listPending(10)).toEqual(committed.events);
  });

  it("keeps a committed event pending when publication fails and publishes it after restart", async () => {
    const { adapters, authority, clock, coordinator } = await fixture();
    await coordinator.admitRun(admissionInput(authority));
    const publishFailures = new DeterministicFailureScheduler();
    publishFailures.failOn("reliableEventSink.publish", 1);
    const sink = new InMemoryReliableEventSink(publishFailures);
    const firstPublisher = new ReliableEventPublisher(adapters.productState, sink, clock);

    await expect(firstPublisher.publishPending(10)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INJECTED_FAILURE,
    });
    expect(await adapters.productState.read(`run:${run.id}`)).toMatchObject({ revision: 1 });
    expect(await adapters.productState.listPending(10)).toHaveLength(1);

    const restartedPublisher = new ReliableEventPublisher(adapters.productState, sink, clock);
    await expect(restartedPublisher.publishPending(10)).resolves.toEqual({
      attempted: 1,
      published: 1,
      duplicates: 0,
    });
    expect(await adapters.productState.listPending(10)).toEqual([]);
    expect(sink.deliveredEvents()).toHaveLength(1);
  });

  it("deduplicates publication after delivery succeeds but marking it published fails", async () => {
    const failures = new DeterministicFailureScheduler();
    failures.failOn("reliableEvents.markPublished", 1);
    const { adapters, authority, clock, coordinator } = await fixture(failures);
    await coordinator.admitRun(admissionInput(authority));
    const sink = new InMemoryReliableEventSink();
    const publisher = new ReliableEventPublisher(adapters.productState, sink, clock);

    await expect(publisher.publishPending(10)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INJECTED_FAILURE,
    });
    expect(await adapters.productState.listPending(10)).toHaveLength(1);
    expect(sink.deliveredEvents()).toHaveLength(1);

    await expect(publisher.publishPending(10)).resolves.toEqual({
      attempted: 1,
      published: 0,
      duplicates: 1,
    });
    expect(sink.attemptsFor(`event:${admissionInput(authority).idempotencyKey}`)).toBe(2);
    expect(sink.deliveredEvents()).toHaveLength(1);
    expect(await adapters.productState.listPending(10)).toEqual([]);
  });

  it("returns the original result for an idempotent replay and rejects key reuse", async () => {
    const { adapters, authority, coordinator } = await fixture();
    const input = admissionInput(authority);
    const first = await coordinator.admitRun(input);
    const replayed = await coordinator.admitRun(input);

    expect(replayed).toEqual({ ...first, replayed: true });
    expect(await adapters.productState.listPending(10)).toHaveLength(1);
    expect(await adapters.productState.read(`run:${run.id}`)).toMatchObject({ revision: 1 });
    await expect(
      coordinator.admitRun({ ...input, commandFingerprint: "trigger.admit:different" }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
  });

  it("converges concurrent duplicate admission on one committed result", async () => {
    const { adapters, authority, coordinator } = await fixture();
    const input = admissionInput(authority);

    const results = await Promise.all([coordinator.admitRun(input), coordinator.admitRun(input)]);

    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(results[0]?.commandResult).toEqual(results[1]?.commandResult);
    expect(await adapters.productState.read(`run:${run.id}`)).toMatchObject({ revision: 1 });
    expect(await adapters.productState.listPending(10)).toHaveLength(1);
  });

  it("requires the current authority fence for every Run mutation", async () => {
    const clock = new ManualClock("2026-08-25T01:00:00.000Z");
    const adapters = createReferenceAdapterSet({ clock });
    const coordinator = new RunStateCommitCoordinator(adapters.productState, clock);
    const missingLease = authorityLease("missing");

    await expect(
      coordinator.admitRun({
        run,
        idempotencyKey: createIdempotencyKey("command-without-authority-task-5"),
        commandFingerprint: "trigger.admit:without-authority:v1",
        authority: { leaseId: missingLease.id, fencingToken: 1 },
        payloadRef: "payload-run-without-authority-task-5",
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(await adapters.productState.read(`run:${run.id}`)).toBeUndefined();

    const firstLease = await adapters.authority.claim(authorityLease("old"), 1_000);
    await coordinator.admitRun(admissionInput(firstLease));

    clock.advance(1_001);
    const currentLease = await adapters.authority.claim(authorityLease("current"), 60_000);
    const transition = {
      runId: run.id,
      ownerId: run.ownerId,
      agentId: run.agentId,
      expectedRevision: 1,
      nextStatus: "building_context" as const,
      idempotencyKey: createIdempotencyKey("command-transition-task-5"),
      commandFingerprint: "run.transition:building-context:v1",
      payloadRef: "payload-run-building-context-task-5",
    };

    await expect(
      coordinator.transitionRun({
        ...transition,
        authority: { leaseId: firstLease.lease.id, fencingToken: firstLease.fencingToken },
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(await adapters.productState.read(`run:${run.id}`)).toMatchObject({ revision: 1 });

    await expect(
      coordinator.transitionRun({
        ...transition,
        authority: {
          leaseId: currentLease.lease.id,
          fencingToken: currentLease.fencingToken,
        },
      }),
    ).resolves.toMatchObject({ state: { revision: 2, value: { status: "building_context" } } });
  });

  it("reconstructs Run progress after coordinator restart from product state only", async () => {
    const { adapters, authority, clock, coordinator } = await fixture();
    await coordinator.admitRun(admissionInput(authority));

    const restartedCoordinator = new RunStateCommitCoordinator(adapters.productState, clock);
    expect(await restartedCoordinator.readRun(run.id)).toEqual({ run, revision: 1 });
    await restartedCoordinator.transitionRun({
      runId: run.id,
      ownerId: run.ownerId,
      agentId: run.agentId,
      expectedRevision: 1,
      nextStatus: "building_context",
      idempotencyKey: createIdempotencyKey("command-restart-task-5"),
      commandFingerprint: "run.transition:restart:v1",
      authority: {
        leaseId: authority.lease.id,
        fencingToken: authority.fencingToken,
      },
      payloadRef: "payload-run-restart-task-5",
    });

    expect(await restartedCoordinator.readRun(run.id)).toMatchObject({
      revision: 2,
      run: { status: "building_context" },
    });
    expect(await adapters.productState.listPending(10)).toHaveLength(2);
  });
});
