import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type GatewayAccessDecision,
  type GatewayAccessPolicyPort,
  type GatewayAuthenticationContext,
  type GatewayCommandExecution,
  type GatewayControlPlanePort,
  type GatewayReadModelPort,
  AgentGatewayService,
} from "@himawari-agent/application";
import type {
  EventSubscription,
  GatewayCommand,
  GetRunSnapshotQuery,
  GetThreadSnapshotQuery,
  RunSnapshot,
  StreamEvent,
  ThreadSnapshot,
  TraceQuery,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";

const authentication: GatewayAuthenticationContext = Object.freeze({
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-25T00:00:00.000Z",
  authenticationRef: "auth-session-01",
});

function envelope(kind: "command" | "query" | "subscription", type: string) {
  return {
    schemaVersion: "gateway.v1" as const,
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: "correlation-01",
    causationId: null,
    dataClassification: "private" as const,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    actor: { actorType: "owner" as const, actorId: "owner-01" },
  };
}

function triggerCommand(): GatewayCommand {
  return {
    ...envelope("command", "trigger.admit"),
    kind: "command",
    type: "trigger.admit",
    idempotencyKey: "trigger-key-01",
    payload: {
      triggerId: "trigger-01",
      sourceType: "user_message",
      sourceId: "client-message-01",
      occurredAt: "2026-08-25T00:00:00.000Z",
      threadId: "thread-01",
      payloadRef: "payload-user-message-01",
      sourceProofRef: "proof-client-01",
    },
  };
}

function streamEvent(cursor: string, sequence: number): StreamEvent {
  return {
    ...envelope("subscription", "events.subscribe"),
    kind: "event",
    type: "stream.event",
    messageId: `stream-${cursor}`,
    causationId: "message-events.subscribe",
    payload: {
      cursor,
      sessionId: "session-01",
      threadId: "thread-01",
      runId: "run-01",
      turnId: null,
      parentEventId: null,
      sequence,
      occurredAt: "2026-08-25T00:00:00.000Z",
      recordedAt: `2026-08-25T00:00:0${sequence}.000Z`,
      eventType: `run.event_${sequence}`,
      payloadRef: null,
    },
  };
}

class RecordingAccessPolicy implements GatewayAccessPolicyPort {
  readonly observed: Array<{
    readonly authentication: GatewayAuthenticationContext;
    readonly type: string;
  }> = [];

  async authorize(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly message: { readonly type: string };
  }): Promise<GatewayAccessDecision> {
    this.observed.push({ authentication: input.authentication, type: input.message.type });
    return input.authentication.deviceId === "device-01"
      ? { allowed: true, reasonCode: "OWNER_DEVICE_AUTHORIZED" }
      : { allowed: false, reasonCode: "DEVICE_NOT_AUTHORIZED" };
  }
}

class RecordingControlPlane implements GatewayControlPlanePort {
  readonly executions: GatewayCommandExecution[] = [];
  private readonly results = new Map<string, { readonly resultRef: string }>();

  async execute(input: GatewayCommandExecution) {
    this.executions.push(input);
    const current = this.results.get(input.command.idempotencyKey);
    if (current) return { ...current, replayed: true };
    const result = { resultRef: "run:run-01" };
    this.results.set(input.command.idempotencyKey, result);
    return { ...result, replayed: false };
  }
}

class GatewayReadModelFixture implements GatewayReadModelPort {
  private readonly events = [streamEvent("cursor-01", 1), streamEvent("cursor-02", 2)];

  async getThreadSnapshot(_query: GetThreadSnapshotQuery): Promise<ThreadSnapshot> {
    return {
      ...envelope("query", "thread.get_snapshot"),
      kind: "snapshot",
      type: "thread.snapshot",
      messageId: "thread-snapshot-01",
      causationId: "message-thread.get_snapshot",
      payload: {
        threadId: "thread-01",
        status: "open",
        revision: 2,
        sessionIds: ["session-01"],
        runIds: ["run-01"],
      },
    };
  }

  async getRunSnapshot(_query: GetRunSnapshotQuery): Promise<RunSnapshot> {
    return {
      ...envelope("query", "run.get_snapshot"),
      kind: "snapshot",
      type: "run.snapshot",
      messageId: "run-snapshot-01",
      causationId: "message-run.get_snapshot",
      payload: {
        runId: "run-01",
        threadId: "thread-01",
        sessionId: "session-01",
        triggerId: "trigger-01",
        status: "completed",
        revision: 4,
        latestSequence: 2,
        activeApprovalRequestId: null,
      },
    };
  }

  async queryTrace(_query: TraceQuery): Promise<readonly StreamEvent[]> {
    return this.events;
  }

  async *subscribe(subscription: EventSubscription): AsyncIterable<StreamEvent> {
    const start =
      subscription.payload.afterCursor === null
        ? 0
        : this.events.findIndex(
            ({ payload }) => payload.cursor === subscription.payload.afterCursor,
          ) + 1;
    for (const event of this.events.slice(start)) yield event;
  }
}

function createGateway() {
  const access = new RecordingAccessPolicy();
  const controlPlane = new RecordingControlPlane();
  const reads = new GatewayReadModelFixture();
  return {
    access,
    controlPlane,
    gateway: new AgentGatewayService({ access, controlPlane, reads }),
  };
}

describe("AgentGatewayService", () => {
  it("propagates authentication context and delegates idempotent commands to Control Plane", async () => {
    const { access, controlPlane, gateway } = createGateway();
    const command = triggerCommand();

    const first = await gateway.request(authentication, command);
    const replay = await gateway.request(authentication, command);

    expect(first).toEqual({ resultRef: "run:run-01", replayed: false });
    expect(replay).toEqual({ resultRef: "run:run-01", replayed: true });
    expect(controlPlane.executions).toHaveLength(2);
    expect(controlPlane.executions[0]?.authentication).toEqual(authentication);
    expect(access.observed).toHaveLength(2);
  });

  it("rejects cross-owner and unauthorized-device requests before Control Plane", async () => {
    const { controlPlane, gateway } = createGateway();
    const command = triggerCommand();

    await expect(
      gateway.request({ ...authentication, ownerId: "owner-02" }, command),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    await expect(
      gateway.request({ ...authentication, deviceId: "device-02" }, command),
    ).rejects.toBeInstanceOf(ApplicationPortError);
    expect(controlPlane.executions).toEqual([]);
  });

  it("returns product snapshots and resumes an ordered subscription after its cursor", async () => {
    const { gateway } = createGateway();
    const snapshot = await gateway.request(authentication, {
      ...envelope("query", "run.get_snapshot"),
      kind: "query",
      type: "run.get_snapshot",
      payload: { runId: "run-01" },
    });
    expect(snapshot).toMatchObject({ type: "run.snapshot", payload: { revision: 4 } });

    const subscription: EventSubscription = {
      ...envelope("subscription", "events.subscribe"),
      kind: "subscription",
      type: "events.subscribe",
      payload: {
        subscriptionId: "subscription-01",
        sessionId: "session-01",
        threadId: "thread-01",
        runId: null,
        afterCursor: "cursor-01",
      },
    };
    const resumed: StreamEvent[] = [];
    for await (const event of gateway.subscribe(authentication, subscription)) resumed.push(event);

    expect(resumed.map(({ payload }) => payload.cursor)).toEqual(["cursor-02"]);
    expect(resumed.map(({ payload }) => payload.sequence)).toEqual([2]);
  });
});
