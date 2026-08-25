import {
  AttentionPolicyService,
  type AttentionCandidate,
  type AttentionPolicyConfig,
} from "@himawari-agent/application";
import {
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  DeterministicDeliveryPort,
  InMemoryAttentionStatePort,
  ManualClock,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const T0 = "2026-08-25T00:00:00.000Z";

const defaultPolicy: AttentionPolicyConfig = {
  duplicateWindowMs: 60_000,
  rateLimitWindowMs: 60_000,
  maxImmediateDeliveries: 10,
  quietHours: null,
  authorizedInterruptRefs: ["grant-interrupt-critical"],
};

function candidate(
  id: string,
  urgency: number,
  confidence: number,
  overrides: Partial<AttentionCandidate> = {},
): AttentionCandidate {
  return {
    id,
    ownerId: createOwnerId("owner-attention-policy"),
    agentId: createAgentId("agent-attention-policy"),
    runId: createRunId(`run-${id}`),
    sessionId: createSessionId("session-attention-policy"),
    threadId: createThreadId("thread-attention-policy"),
    resultRef: `payload-${id}`,
    dataClassification: "private",
    urgency,
    confidence,
    duplicateKey: `duplicate-${id}`,
    generatedAt: T0,
    deviceState: "available",
    interruptAuthorizationRef: null,
    ...overrides,
  };
}

function fixture(policy: Partial<AttentionPolicyConfig> = {}) {
  const clock = new ManualClock(T0);
  const state = new InMemoryAttentionStatePort();
  const delivery = new DeterministicDeliveryPort();
  const service = new AttentionPolicyService({
    state,
    delivery,
    clock,
    policy: { ...defaultPolicy, ...policy },
  });
  return { clock, delivery, service, state };
}

describe("Task 15 centralized Attention Policy", () => {
  it.each([
    ["SILENT", 10, 90, null],
    ["INBOX", 30, 90, "INBOX"],
    ["DIGEST", 50, 90, "DIGEST"],
    ["NOTIFY", 75, 90, "NOTIFY"],
    ["INTERRUPT", 95, 95, "INTERRUPT"],
  ] as const)(
    "maps deterministic signal thresholds to %s",
    async (level, urgency, confidence, deliveryLevel) => {
      const { service } = fixture();
      const evaluated = await service.evaluate(
        candidate(`candidate-${level.toLowerCase()}`, urgency, confidence, {
          ...(level === "INTERRUPT"
            ? { interruptAuthorizationRef: "grant-interrupt-critical" }
            : {}),
        }),
      );

      expect(evaluated.record.decision.level).toBe(level);
      expect(evaluated.delivery?.level ?? null).toBe(deliveryLevel);
    },
  );

  it("requires a currently authorized explicit reference before selecting INTERRUPT", async () => {
    const { service } = fixture();
    const missing = await service.evaluate(candidate("interrupt-missing", 95, 95));
    const mismatched = await service.evaluate(
      candidate("interrupt-mismatch", 95, 95, {
        interruptAuthorizationRef: "grant-interrupt-not-active",
      }),
    );

    expect(missing.record.decision).toMatchObject({
      level: "NOTIFY",
      interruptAuthorizationRef: null,
    });
    expect(mismatched.record.decision).toMatchObject({
      level: "NOTIFY",
      interruptAuthorizationRef: null,
    });
  });

  it("downgrades normal notification during quiet hours but preserves an authorized interrupt", async () => {
    const { service } = fixture({
      quietHours: { startMinute: 23 * 60, endMinute: 7 * 60, utcOffsetMinutes: 0 },
    });
    const notification = await service.evaluate(candidate("quiet-notify", 75, 90));
    const interrupt = await service.evaluate(
      candidate("quiet-interrupt", 95, 95, {
        interruptAuthorizationRef: "grant-interrupt-critical",
      }),
    );

    expect(notification.record.decision).toMatchObject({
      level: "DIGEST",
      reasonCode: "quiet_hours",
    });
    expect(interrupt.record.decision).toMatchObject({
      level: "INTERRUPT",
      reasonCode: "authorized_urgent_result",
    });
  });

  it("silences duplicate results and serializes concurrent duplicate decisions", async () => {
    const { service } = fixture();
    const duplicateKey = "restaurant-result-same";
    const [first, second] = await Promise.all([
      service.evaluate(candidate("duplicate-a", 75, 90, { duplicateKey })),
      service.evaluate(candidate("duplicate-b", 75, 90, { duplicateKey })),
    ]);

    expect([first.record.decision.level, second.record.decision.level].sort()).toEqual([
      "NOTIFY",
      "SILENT",
    ]);
    expect([first.delivery, second.delivery].filter(Boolean)).toHaveLength(1);
  });

  it("downgrades immediate delivery when rate-limited or the device is unavailable", async () => {
    const { service } = fixture({ maxImmediateDeliveries: 1 });
    await service.evaluate(candidate("rate-first", 75, 90));
    const rateLimited = await service.evaluate(
      candidate("rate-second", 95, 95, {
        interruptAuthorizationRef: "grant-interrupt-critical",
      }),
    );
    const unavailableService = fixture({ maxImmediateDeliveries: 1 }).service;
    const unavailable = await unavailableService.evaluate(
      candidate("device-unavailable", 75, 90, { deviceState: "unavailable" }),
    );

    expect(rateLimited.record.decision).toMatchObject({
      level: "DIGEST",
      reasonCode: "rate_limited",
    });
    expect(unavailable.record.decision).toMatchObject({
      level: "INBOX",
      reasonCode: "client_unavailable",
    });
  });

  it("replays one immutable decision and Delivery Request for the same candidate", async () => {
    const { service, state } = fixture();
    const input = candidate("idempotent-candidate", 75, 90);
    const first = await service.evaluate(input);
    const replay = await service.evaluate(input);

    expect(replay).toEqual({ ...first, replayed: true });
    expect((await state.readPolicyState(input.ownerId, input.agentId)).decisions).toHaveLength(1);
  });
});
