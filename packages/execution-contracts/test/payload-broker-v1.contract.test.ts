import { describe, expect, it } from "vitest";

import { PAYLOAD_BROKER_V1_SCHEMA_VERSION, payloadBrokerV1MessageSchema } from "../src/index.ts";

const identity = {
  handleRef: "handle:one",
  invocationId: "invocation:one",
  workerInstanceId: "worker:one",
  workerBootId: "worker-boot:one",
  authorityEpoch: 3,
  fencingToken: 7,
} as const;

function envelope(kind: "request" | "response", type: string) {
  return {
    schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
    kind,
    type,
    messageId: `${type}:message`,
    correlationId: `${type}:correlation`,
    causationId: null,
  };
}

describe("payload-broker.v1 contract", () => {
  it("binds sandbox requests to one invocation and rejects caller-supplied authority", () => {
    const job = {
      jobId: "job:one",
      attemptId: "attempt:one",
      invocationId: identity.invocationId,
      receiptRef: "receipt:one",
      hostId: "host:one",
      ownerId: "owner:one",
      agentId: "agent:one",
      threadId: null,
      runId: "run:one",
      toolCallId: "tool:one",
    };
    const request = {
      ...envelope("request", "payload.sandbox.job"),
      idempotencyKey: "job:read",
      payload: { ...identity, identity: job, observation: null },
    };
    expect(payloadBrokerV1MessageSchema.parse(request)).toEqual(request);
    for (const payload of [
      { ...request.payload, authority: { fencingToken: 100 } },
      { ...request.payload, identity: { ...job, invocationId: "other" } },
      { ...request.payload, identity: { ...job, extra: true } },
      { ...request.payload, observation: {} },
    ])
      expect(() => payloadBrokerV1MessageSchema.parse({ ...request, payload })).toThrow();
  });

  it("round-trips the handshake and both bounded byte operations", () => {
    const messages = [
      {
        ...envelope("request", "payload.handshake"),
        idempotencyKey: "payload.handshake:idempotency",
        payload: {
          agentServiceInstanceId: "agent:one",
          agentServiceBootId: "agent-boot:one",
          workerInstanceId: identity.workerInstanceId,
          workerBootId: identity.workerBootId,
          authorityEpoch: identity.authorityEpoch,
          fencingToken: identity.fencingToken,
          requestedAt: "2026-09-04T00:00:00.000Z",
        },
      },
      {
        ...envelope("response", "payload.handshake.accepted"),
        payload: {
          agentServiceInstanceId: "agent:one",
          agentServiceBootId: "agent-boot:one",
          workerInstanceId: identity.workerInstanceId,
          workerBootId: identity.workerBootId,
          authorityEpoch: identity.authorityEpoch,
          fencingToken: identity.fencingToken,
          acceptedAt: "2026-09-04T00:00:00.001Z",
        },
      },
      {
        ...envelope("request", "payload.input.read"),
        idempotencyKey: "payload.input.read:idempotency",
        payload: identity,
      },
      {
        ...envelope("response", "payload.input.read.result"),
        payload: {
          ...identity,
          agentServiceInstanceId: "agent:one",
          agentServiceBootId: "agent-boot:one",
          bytesBase64: "AAEC+v8=",
        },
      },
      {
        ...envelope("request", "payload.output.write"),
        idempotencyKey: "payload.output.write:idempotency",
        payload: {
          ...identity,
          bytesBase64: "AAEC+v8=",
          contentType: "application/octet-stream",
        },
      },
      {
        ...envelope("response", "payload.output.write.accepted"),
        payload: {
          ...identity,
          agentServiceInstanceId: "agent:one",
          agentServiceBootId: "agent-boot:one",
          outputRef: "payload:output:one",
          replayed: false,
        },
      },
    ];

    for (const message of messages) {
      const parsed = payloadBrokerV1MessageSchema.parse(message);
      expect(JSON.parse(payloadBrokerV1MessageSchema.serialize(parsed))).toEqual(message);
    }
  });

  it.each([
    [
      "unknown top-level field",
      {
        ...envelope("request", "payload.input.read"),
        idempotencyKey: "payload.input.read:idempotency",
        payload: identity,
        ownerId: "must-not-cross-boundary",
      },
    ],
    [
      "worker scope field",
      {
        ...envelope("request", "payload.input.read"),
        idempotencyKey: "payload.input.read:idempotency",
        payload: { ...identity, ownerId: "must-not-cross-boundary" },
      },
    ],
    [
      "noncanonical bytes",
      {
        ...envelope("response", "payload.input.read.result"),
        payload: {
          ...identity,
          agentServiceInstanceId: "agent:one",
          agentServiceBootId: "agent-boot:one",
          bytesBase64: "AAEC+v8",
        },
      },
    ],
    [
      "nonzero padding bits",
      {
        ...envelope("response", "payload.input.read.result"),
        payload: {
          ...identity,
          agentServiceInstanceId: "agent:one",
          agentServiceBootId: "agent-boot:one",
          bytesBase64: "AB==",
        },
      },
    ],
    [
      "invalid content type",
      {
        ...envelope("request", "payload.output.write"),
        idempotencyKey: "payload.output.write:idempotency",
        payload: { ...identity, bytesBase64: "", contentType: "text/plain\n" },
      },
    ],
    [
      "unknown message type",
      {
        ...envelope("request", "payload.get"),
        idempotencyKey: "payload.get:idempotency",
        payload: identity,
      },
    ],
    [
      "unsupported version",
      {
        ...envelope("request", "payload.input.read"),
        schemaVersion: "payload-broker.v2",
        idempotencyKey: "payload.input.read:idempotency",
        payload: identity,
      },
    ],
  ])("rejects %s", (_name, message) => {
    expect(() => payloadBrokerV1MessageSchema.parse(message)).toThrow();
  });
});
