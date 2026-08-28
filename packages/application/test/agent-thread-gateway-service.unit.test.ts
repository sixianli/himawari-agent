import {
  type ThreadGatewayCommand,
  type ThreadGatewayEvent,
  type ThreadGatewayQuery,
  type ThreadGatewayRequestResult,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import {
  AgentThreadGatewayService,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type ThreadGatewayAccessPolicyPort,
  type ThreadGatewayControlPlanePort,
  type ThreadGatewayReadModelPort,
} from "../src/index.js";

const authentication: GatewayAuthenticationContext = {
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-28T00:00:00.000Z",
  authenticationRef: "session-01",
};

const base = {
  schemaVersion: "gateway.thread.v3" as const,
  messageId: "message-thread-01",
  correlationId: "correlation-01",
  causationId: null,
  scope: { ownerId: "owner-01", agentId: "agent-01" },
  authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
  actor: { actorType: "owner" as const, actorId: "owner-01" },
};

function command(): ThreadGatewayCommand {
  const parsed = threadGatewayMessageSchema.parse({
    ...base,
    kind: "command",
    type: "thread.pin",
    idempotencyKey: "idempotency-01",
    payload: {
      threadId: "thread-01",
      expectedRevision: 1,
      pinOrder: 0,
      resultRef: "payload:result-01",
    },
  });
  if (parsed.kind !== "command") throw new Error("expected command");
  return parsed;
}

function query(): ThreadGatewayQuery {
  const parsed = threadGatewayMessageSchema.parse({
    ...base,
    kind: "query",
    type: "thread.list",
    payload: { statuses: ["active"], pinnedOnly: false, afterCursor: null, limit: 10 },
  });
  if (parsed.kind !== "query") throw new Error("expected query");
  return parsed;
}

function subscription(): ThreadGatewaySubscription {
  const parsed = threadGatewayMessageSchema.parse({
    ...base,
    kind: "subscription",
    type: "thread.events",
    payload: { afterCursor: null },
  });
  if (parsed.kind !== "subscription") throw new Error("expected subscription");
  return parsed;
}

function event(cursor: string, revision: number): ThreadGatewayEvent {
  const parsed = threadGatewayMessageSchema.parse({
    ...base,
    kind: "event",
    type: "thread.event",
    messageId: `event:${cursor}`,
    actor: { actorType: "system", actorId: "thread-gateway" },
    payload: {
      eventId: `event:${cursor}`,
      threadId: "thread-01",
      revision,
      cursor,
      causationCommandId: "thread-command:01",
      eventType: "thread.pin",
      payloadRef: "payload:result-01",
      occurredAt: "2026-08-28T00:00:00.000Z",
    },
  });
  if (parsed.kind !== "event") throw new Error("expected event");
  return parsed;
}

function result(request: ThreadGatewayCommand | ThreadGatewayQuery): ThreadGatewayRequestResult {
  const parsed = threadGatewayMessageSchema.parse({
    schemaVersion: request.schemaVersion,
    messageId: request.messageId,
    correlationId: request.correlationId,
    causationId: request.messageId,
    scope: request.scope,
    authority: request.authority,
    kind: "result",
    type: "thread.command_result",
    actor: { actorType: "system", actorId: "thread-gateway" },
    payload: {
      commandType: "thread.pin",
      commandId: "thread-command:01",
      threadId: "thread-01",
      threadRevision: 2,
      resultRef: "payload:result-01",
      replayed: false,
      committedAt: "2026-08-28T00:00:00.000Z",
    },
  });
  if (parsed.kind !== "result") throw new Error("expected result");
  return parsed;
}

function fixture(events: readonly ThreadGatewayEvent[] = [event("thread-cursor:1", 1)]) {
  const executions: ThreadGatewayCommand[] = [];
  const authorized: string[] = [];
  const access: ThreadGatewayAccessPolicyPort = {
    async authorize({ message }) {
      authorized.push(message.type);
      return { allowed: true, reasonCode: "OWNER_DEVICE_AUTHORIZED" };
    },
  };
  const controlPlane: ThreadGatewayControlPlanePort = {
    async execute({ command: message }) {
      executions.push(message);
      return result(message);
    },
  };
  const reads: ThreadGatewayReadModelPort = {
    async query({ query: message }) {
      const parsed = threadGatewayMessageSchema.parse({
        ...message,
        kind: "snapshot",
        type: "thread.collection_snapshot",
        actor: { actorType: "system", actorId: "thread-gateway" },
        payload: {
          threads: [],
          nextCursor: null,
          snapshotRef: "snapshot:01",
          generatedAt: "2026-08-28T00:00:00.000Z",
        },
      });
      if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
      return parsed;
    },
    async *subscribe() {
      for (const item of events) yield item;
    },
  };
  return {
    authorized,
    executions,
    gateway: new AgentThreadGatewayService({ access, controlPlane, reads }),
  };
}

describe("AgentThreadGatewayService", () => {
  it("authorizes and routes commands, queries, and subscriptions", async () => {
    const { authorized, executions, gateway } = fixture();
    expect(await gateway.request(authentication, command())).toMatchObject({
      type: "thread.command_result",
    });
    expect(await gateway.request(authentication, query())).toMatchObject({
      type: "thread.collection_snapshot",
    });
    const streamed = [];
    for await (const item of gateway.subscribe(authentication, subscription())) streamed.push(item);
    expect(streamed).toHaveLength(1);
    expect(executions).toHaveLength(1);
    expect(authorized).toEqual(["thread.pin", "thread.list", "thread.events"]);
  });

  it("rejects cross-owner scope before dispatch", async () => {
    const { executions, gateway } = fixture();
    await expect(
      gateway.request({ ...authentication, ownerId: "owner-02" }, command()),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(executions).toEqual([]);
  });

  it("rejects repeated cursors and backwards Thread revisions", async () => {
    const duplicate = fixture([event("thread-cursor:1", 1), event("thread-cursor:1", 2)]).gateway;
    await expect(
      (async () => {
        for await (const _item of duplicate.subscribe(authentication, subscription())) {
          // Exhaust the stream.
        }
      })(),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
    const backwards = fixture([event("thread-cursor:1", 2), event("thread-cursor:2", 1)]).gateway;
    await expect(
      (async () => {
        for await (const _item of backwards.subscribe(authentication, subscription())) {
          // Exhaust the stream.
        }
      })(),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
  });
});
