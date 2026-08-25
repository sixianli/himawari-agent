import {
  AttentionPolicyService,
  RunStateCommitCoordinator,
  type AttentionCandidate,
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
  DeterministicDeliveryPort,
  InMemoryAttentionStatePort,
  ManualClock,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const T0 = "2026-08-25T00:00:00.000Z";

async function completedRunFixture() {
  const owner = createOwner(createOwnerId("owner-attention-delivery"));
  const agent = createAgent({ id: createAgentId("agent-attention-delivery"), owner });
  const session = createSession({ id: createSessionId("session-attention-delivery"), agent });
  const trigger = createTrigger({
    id: createTriggerId("trigger-attention-delivery"),
    idempotencyKey: createIdempotencyKey("trigger-attention-delivery"),
    agent,
  });
  const run = createRun({ id: createRunId("run-attention-delivery"), session, trigger });
  const clock = new ManualClock(T0);
  const adapters = createReferenceAdapterSet({ clock });
  const lease = createAgentAuthorityLease({
    id: createAuthorityLeaseId("lease-attention-delivery"),
    agent,
    holderId: createAuthorityHolderId("holder-attention-delivery"),
  });
  const claimed = await adapters.authority.claim(lease, 60_000);
  const authority = { leaseId: lease.id, fencingToken: claimed.fencingToken };
  const runs = new RunStateCommitCoordinator(adapters.productState, clock);
  await runs.admitRun({
    run,
    idempotencyKey: createIdempotencyKey("admit-attention-delivery"),
    commandFingerprint: "admit:attention-delivery:v1",
    authority,
    payloadRef: "payload-admit-attention-delivery",
  });
  let revision = 1;
  for (const status of ["building_context", "running", "completed"] as const) {
    await runs.transitionRun({
      runId: run.id,
      ownerId: owner.id,
      agentId: agent.id,
      expectedRevision: revision,
      nextStatus: status,
      idempotencyKey: createIdempotencyKey(`attention-delivery-${status}`),
      commandFingerprint: `attention-delivery:${status}:v1`,
      authority,
      payloadRef: `payload-attention-delivery-${status}`,
    });
    revision += 1;
  }
  return { adapters, agent, clock, run, runs, session };
}

function resultCandidate(
  setup: Awaited<ReturnType<typeof completedRunFixture>>,
  id: string,
): AttentionCandidate {
  return {
    id,
    ownerId: setup.agent.ownerId,
    agentId: setup.agent.id,
    runId: setup.run.id,
    sessionId: setup.session.id,
    threadId: null,
    resultRef: `payload-result-${id}`,
    dataClassification: "private",
    urgency: 75,
    confidence: 90,
    duplicateKey: `duplicate-${id}`,
    generatedAt: T0,
    deviceState: "available",
    interruptAuthorizationRef: null,
  };
}

function service(
  setup: Awaited<ReturnType<typeof completedRunFixture>>,
  state: InMemoryAttentionStatePort,
  delivery: DeterministicDeliveryPort,
) {
  return new AttentionPolicyService({
    state,
    delivery,
    clock: setup.clock,
    policy: {
      duplicateWindowMs: 60_000,
      rateLimitWindowMs: 60_000,
      maxImmediateDeliveries: 10,
      quietHours: null,
      authorizedInterruptRefs: [],
    },
  });
}

describe("Task 15 Delivery Requests independent of Run completion", () => {
  it("keeps a missing-client delivery pending without rolling back the completed Run", async () => {
    const setup = await completedRunFixture();
    const state = new InMemoryAttentionStatePort();
    const delivery = new DeterministicDeliveryPort(
      {
        "client-online": {
          outcome: "delivered",
          acknowledgementRef: "ack-client-online",
          errorCode: null,
        },
      },
      {
        outcome: "unavailable",
        acknowledgementRef: null,
        errorCode: "CLIENT_UNAVAILABLE",
      },
    );
    const attention = service(setup, state, delivery);
    const evaluated = await attention.evaluate(resultCandidate(setup, "candidate-retry"));
    if (!evaluated.delivery) throw new Error("Expected Delivery Request");

    const missing = await attention.deliver(evaluated.delivery.id, "client-offline");
    expect(missing).toMatchObject({
      outcome: "pending",
      reasonCode: "CLIENT_UNAVAILABLE",
      request: { status: "pending", attempts: 1, assignedClientId: null },
    });
    expect((await setup.runs.readRun(setup.run.id))?.run.status).toBe("completed");

    const retried = await attention.deliver(evaluated.delivery.id, "client-online");
    expect(retried).toMatchObject({
      outcome: "delivered",
      reasonCode: "DELIVERY_ACKNOWLEDGED",
      request: {
        status: "delivered",
        attempts: 2,
        assignedClientId: "client-online",
        acknowledgementRef: "ack-client-online",
      },
    });
    expect((await setup.runs.readRun(setup.run.id))?.run.status).toBe("completed");
  });

  it("lets two clients observe one centralized decision but only one delivery claim", async () => {
    const setup = await completedRunFixture();
    const state = new InMemoryAttentionStatePort();
    const delivery = new DeterministicDeliveryPort({
      "client-a": {
        outcome: "delivered",
        acknowledgementRef: "ack-client-a",
        errorCode: null,
      },
      "client-b": {
        outcome: "delivered",
        acknowledgementRef: "ack-client-b",
        errorCode: null,
      },
    });
    const attention = service(setup, state, delivery);
    const input = resultCandidate(setup, "candidate-two-clients");
    const [firstDecision, replayedDecision] = await Promise.all([
      attention.evaluate(input),
      attention.evaluate(input),
    ]);
    const requestId = firstDecision.delivery?.id ?? replayedDecision.delivery?.id;
    if (!requestId) throw new Error("Expected shared Delivery Request");

    expect([firstDecision.replayed, replayedDecision.replayed].sort()).toEqual([false, true]);
    expect(firstDecision.record.decision).toEqual(replayedDecision.record.decision);
    const results = await Promise.all([
      attention.deliver(requestId, "client-a"),
      attention.deliver(requestId, "client-b"),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["delivered", "duplicate"]);
    expect(delivery.observedAttempts()).toHaveLength(1);
    expect(await state.readDelivery(requestId)).toMatchObject({
      status: "delivered",
      attempts: 1,
    });
  });
});
