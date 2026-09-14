import { describe, expect, it } from "vitest";
import {
  EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
  executionAdmissionV1MessageSchema,
  executionV2MessageSchema,
} from "../src/index.ts";
import messages from "./fixtures/v2/messages.json" with { type: "json" };

const delegate = messages.find(({ type }) => type === "work.delegate");
const execute = messages.find(({ type }) => type === "work.execute");
if (!delegate || !execute) throw new TypeError("execution.v2 projection fixtures are missing");

const peer = {
  agentServiceInstanceId: "agent-service:admission-contract",
  agentServiceBootId: "agent-boot:admission-contract",
  workerInstanceId: "worker:admission-contract",
  workerBootId: "worker-boot:admission-contract",
  deploymentId: "deployment:admission-contract",
  authorityEpoch: 3,
  fencingToken: 7,
} as const;

const receipt = {
  receiptRef: "receipt:admission-contract",
  handleRef: "handle:admission-contract",
  invocationId: "execution-v2-request-01",
  idempotencyKey: "idempotency:admission-contract",
  ownerId: "owner:admission-contract",
  agentId: "agent:admission-contract",
  runId: "run:admission-contract",
  workerRunId: "worker-run:admission-contract",
} as const;

function envelope(kind: "request" | "response", type: string) {
  return {
    schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: `correlation:${type}`,
    causationId: kind === "response" ? `message:${type}` : null,
  };
}

function admissionRequest() {
  const parsedExecute = executionV2MessageSchema.parse(execute);
  if (parsedExecute.kind !== "request" || parsedExecute.type !== "work.execute") {
    throw new TypeError("expected work.execute fixture");
  }
  return {
    ...envelope("request", "admission.work.execute"),
    idempotencyKey: "idempotency:admission-request",
    payload: { peer, execute: parsedExecute },
  };
}

describe("execution-admission.v1 contract", () => {
  it("round-trips handshake, consumed projection, replay and unknown outcomes", () => {
    const request = admissionRequest();
    const handshake = {
      ...envelope("request", "admission.handshake"),
      idempotencyKey: "idempotency:admission-handshake",
      payload: { peer, requestedAt: "2026-09-05T00:00:00.000Z" },
    };
    const accepted = {
      ...envelope("response", "admission.handshake.accepted"),
      payload: { peer, ready: true, acceptedAt: "2026-09-05T00:00:00.001Z" },
    };
    const projection = {
      delegate: executionV2MessageSchema.parse(delegate),
      execute: executionV2MessageSchema.parse(execute),
    };
    const responses = [
      {
        ...envelope("response", "admission.work.execute.accepted"),
        payload: {
          requestMessageId: request.payload.execute.messageId,
          peer,
          receipt,
          disposition: "consumed",
          projection,
          reasonCode: null,
        },
      },
      {
        ...envelope("response", "admission.work.execute.accepted"),
        payload: {
          requestMessageId: request.payload.execute.messageId,
          peer,
          receipt,
          disposition: "replayed",
          projection: null,
          reasonCode: null,
        },
      },
      {
        ...envelope("response", "admission.work.execute.accepted"),
        payload: {
          requestMessageId: request.payload.execute.messageId,
          peer,
          receipt,
          disposition: "unknown",
          projection: null,
          reasonCode: "PARENT_INVALID_AFTER_CONSUME",
        },
      },
    ];
    for (const message of [handshake, accepted, request, ...responses]) {
      const parsed = executionAdmissionV1MessageSchema.parse(message);
      expect(
        executionAdmissionV1MessageSchema.parseJson(
          executionAdmissionV1MessageSchema.serialize(parsed),
        ),
      ).toEqual(message);
    }
  });

  it.each([
    ["unknown top-level field", { ...admissionRequest(), ownerId: "not-authoritative" }],
    [
      "unknown peer field",
      {
        ...admissionRequest(),
        payload: { ...admissionRequest().payload, runId: "not-authoritative" },
      },
    ],
    [
      "missing parent causation",
      {
        ...admissionRequest(),
        payload: {
          ...admissionRequest().payload,
          execute: { ...admissionRequest().payload.execute, causationId: null },
        },
      },
    ],
    [
      "replayed projection",
      {
        ...envelope("response", "admission.work.execute.accepted"),
        payload: {
          requestMessageId: receipt.invocationId,
          peer,
          receipt,
          disposition: "replayed",
          projection: { delegate, execute },
          reasonCode: null,
        },
      },
    ],
    [
      "consumed without projection",
      {
        ...envelope("response", "admission.work.execute.accepted"),
        payload: {
          requestMessageId: receipt.invocationId,
          peer,
          receipt,
          disposition: "consumed",
          projection: null,
          reasonCode: null,
        },
      },
    ],
    [
      "unknown without stable reason",
      {
        ...envelope("response", "admission.work.execute.accepted"),
        payload: {
          requestMessageId: receipt.invocationId,
          peer,
          receipt,
          disposition: "unknown",
          projection: null,
          reasonCode: null,
        },
      },
    ],
    ["unsupported version", { ...admissionRequest(), schemaVersion: "execution-admission.v2" }],
  ])("rejects %s", (_name, message) => {
    expect(() => executionAdmissionV1MessageSchema.parse(message)).toThrow();
  });
});
