import type {
  GatewayV2Command,
  GatewayV2Event,
  GatewayV2Query,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import {
  AgentGatewayV2Service,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type GatewayV2AccessPolicyPort,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
} from "../src/index.js";

const authentication: GatewayAuthenticationContext = {
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-27T00:00:00.000Z",
  authenticationRef: "session-01",
};

function envelope(kind: "command" | "query" | "event", type: string) {
  return {
    schemaVersion: "gateway.v2" as const,
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: "correlation-01",
    causationId: null,
    dataClassification: "private" as const,
    risk: "low" as const,
    authorizationRef: null,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner" as const, actorId: "owner-01" },
  };
}

function command(): GatewayV2Command {
  return {
    ...envelope("command", "thread.message.submit"),
    kind: "command",
    type: "thread.message.submit",
    idempotencyKey: "idempotency-01",
    payload: {
      threadId: "thread-01",
      messageId: "client-message-01",
      contentRef: "payload-01",
      clientCreatedAt: "2026-08-27T00:00:00.000Z",
    },
  };
}

function query(): GatewayV2Query {
  return {
    ...envelope("query", "thread.list"),
    kind: "query",
    type: "thread.list",
    payload: { afterCursor: null, limit: 10 },
  };
}

function event(cursor: string, sequence: number): GatewayV2Event {
  return {
    ...envelope("event", "stream.event"),
    kind: "event",
    type: "stream.event",
    actor: { actorType: "system", actorId: "system-01" },
    messageId: `event:${cursor}`,
    payload: {
      cursor,
      retentionStartCursor: "cursor-01",
      eventId: `event:${cursor}`,
      scopeKind: "run",
      scopeId: "run-01",
      sequence,
      occurredAt: "2026-08-27T00:00:00.000Z",
      eventType: "run.changed",
      payloadRef: null,
    },
  };
}

function fixture(events: readonly GatewayV2Event[] = [event("cursor-01", 1)]) {
  const executions: GatewayV2Command[] = [];
  const access: GatewayV2AccessPolicyPort = {
    async authorize() {
      return { allowed: true, reasonCode: "OWNER_DEVICE_AUTHORIZED" };
    },
  };
  const controlPlane: GatewayV2ControlPlanePort = {
    async execute(input) {
      executions.push(input.command);
      return { resultRef: "accepted-01", replayed: false };
    },
  };
  const reads: GatewayV2ReadModelPort = {
    async query(message) {
      return {
        ...message,
        kind: "snapshot",
        type: "collection.snapshot",
        messageId: "snapshot-01",
        causationId: message.messageId,
        payload: {
          category: "threads",
          itemRefs: ["thread-01"],
          nextCursor: null,
          snapshotRef: "snapshot-ref-01",
          generatedAt: "2026-08-27T00:00:00.000Z",
        },
      };
    },
    async *subscribe() {
      for (const item of events) yield item;
    },
  };
  return { executions, gateway: new AgentGatewayV2Service({ access, controlPlane, reads }) };
}

describe("AgentGatewayV2Service", () => {
  it("routes authenticated commands and queries through product ports", async () => {
    const { executions, gateway } = fixture();
    expect(await gateway.request(authentication, command())).toEqual({
      resultRef: "accepted-01",
      replayed: false,
    });
    expect(await gateway.request(authentication, query())).toMatchObject({
      type: "collection.snapshot",
    });
    expect(executions).toHaveLength(1);
  });

  it("rejects cross-owner commands before Control Plane", async () => {
    const { executions, gateway } = fixture();
    await expect(
      gateway.request({ ...authentication, ownerId: "owner-02" }, command()),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(executions).toEqual([]);
  });

  it("rejects duplicate cursors and non-increasing per-scope sequences", async () => {
    const duplicate = fixture([event("cursor-01", 1), event("cursor-01", 2)]).gateway;
    await expect(
      (async () => {
        for await (const _item of duplicate.subscribe(authentication, null)) {
          // Exhaust the stream.
        }
      })(),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
    const unordered = fixture([event("cursor-01", 2), event("cursor-02", 1)]).gateway;
    await expect(
      (async () => {
        for await (const _item of unordered.subscribe(authentication, null)) {
          // Exhaust the stream.
        }
      })(),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
  });
});
