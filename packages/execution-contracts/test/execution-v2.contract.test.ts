import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  EXECUTION_V2_MESSAGE_TYPES,
  executionV2MessageSchema,
} from "../src/index.ts";
import messages from "./fixtures/v2/messages.json" with { type: "json" };

const executeMessage = messages.find(({ type }) => type === "work.execute");
if (!executeMessage) throw new TypeError("work.execute fixture is missing");
const hostOperationMessage = messages.find(({ type }) => type === "host.operation.execute");
if (!hostOperationMessage) throw new TypeError("host.operation.execute fixture is missing");
function fixture(type: string) {
  const message = messages.find((item) => item.type === type);
  if (!message) throw new TypeError(`${type} fixture is missing`);
  return message;
}
const environmentRequest = fixture("environment.operation.execute");
const environmentResult = fixture("environment.operation.result");
const environmentPayload = environmentRequest.payload as Record<string, unknown>;
const environmentTarget = {
  identity: environmentPayload["identity"],
  createIntentId: environmentPayload["createIntentId"],
  locator: (environmentResult.payload as Record<string, unknown>)["result"],
};
const stopProof = {
  basis: "verified_stopped",
  identity: environmentPayload["identity"],
  createIntentId: "environment-create-01",
  stopIntentId: "environment-stop-01",
  stopFence: 1,
  verifierRef: "container-docker:host-01",
  checkedAt: "2026-08-26T00:00:06.000Z",
  validUntil: "2026-08-26T00:01:06.000Z",
  evidence: [{ ref: "container-evidence-01", digest: "f".repeat(64) }],
  locator: environmentTarget.locator,
  coverage: [
    "environment_terminated",
    "no_restart",
    "execute_closed",
    "egress_closed",
    "credentials_revoked",
  ],
};
function environmentOperation(payload: Record<string, unknown>, overrides = {}) {
  return {
    ...environmentRequest,
    ...overrides,
    payload: {
      requestedAt: "2026-08-26T00:00:00.000Z",
      deadlineAt: "2026-08-26T00:01:00.000Z",
      ...payload,
    },
  };
}
function environmentOutcome(payload: Record<string, unknown>) {
  return { ...environmentResult, payload: { ...environmentResult.payload, ...payload } };
}

const forbiddenKeys = new Set([
  "apiKey",
  "accessToken",
  "password",
  "secretValue",
  "credential",
  "rawInput",
  "rawOutput",
]);

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

describe("Execution v2 compatibility fixtures", () => {
  it("round trips sandbox identity and rejects substitution across invocation scopes", () => {
    const job = {
      jobId: "job",
      attemptId: "attempt",
      receiptRef: "receipt",
      hostId: "host",
      threadId: "thread",
      toolCallId: "tool",
      invocationId: executeMessage.messageId,
      ownerId: executeMessage.scope.ownerId,
      agentId: executeMessage.scope.agentId,
      runId: executeMessage.scope.runId,
    };
    const message = { ...executeMessage, payload: { ...executeMessage.payload, sandboxJob: job } };
    expect(
      executionV2MessageSchema.parseJson(
        executionV2MessageSchema.serialize(executionV2MessageSchema.parse(message)),
      ),
    ).toEqual(message);
    for (const key of ["invocationId", "ownerId", "agentId", "runId"]) {
      expect(() =>
        executionV2MessageSchema.parse({
          ...message,
          payload: { ...message.payload, sandboxJob: { ...job, [key]: "foreign" } },
        }),
      ).toThrow();
    }
  });

  it("round-trips handshake, readiness, cursor replay, bounded work, cancellation and reconciliation", () => {
    const parsed = messages.map((message) => executionV2MessageSchema.parse(message));

    expect(parsed.map(({ type }) => type)).toEqual(EXECUTION_V2_MESSAGE_TYPES);
    for (const [index, message] of parsed.entries()) {
      expect(
        executionV2MessageSchema.parseJson(executionV2MessageSchema.serialize(message)),
      ).toEqual(messages[index]);
    }
  });

  it("carries only Payload and secret references across the Worker boundary", () => {
    const serialized = JSON.stringify(messages);

    expect(collectKeys(messages).filter((key) => forbiddenKeys.has(key))).toEqual([]);
    for (const forbidden of ["@octokit/", "mem0ai", "fastify", "JwtPayload"])
      expect(serialized).not.toContain(forbidden);
  });
});

describe("Execution v2 environment operations", () => {
  it("carries every backend operation with its own fields and typed result", () => {
    const requests = [
      { operation: "capabilities" },
      { operation: "inspect", ...environmentTarget },
      {
        operation: "stop",
        ...environmentTarget,
        stopIntentId: "environment-stop-01",
        stopFence: 1,
      },
      {
        operation: "verifyStopped",
        ...environmentTarget,
        stopIntentId: "environment-stop-01",
        stopFence: 1,
      },
      { operation: "destroy", ...environmentTarget },
    ];
    for (const payload of requests) {
      const message = environmentOperation(
        payload,
        payload.operation === "execute"
          ? { risk: "high", authorizationRef: "authorization-01" }
          : {},
      );
      expect(executionV2MessageSchema.parse(message)).toEqual(message);
    }
    const results = [
      [
        "inspect",
        {
          state: "stopped",
          locator: environmentTarget.locator,
          observedAt: "2026-08-26T00:00:05.000Z",
        },
      ],
      ["stop", { accepted: true }],
      ["verifyStopped", stopProof],
      ["destroy", { destroyed: true }],
    ] as const;
    for (const [operation, result] of results) {
      const message = environmentOutcome({ operation, result });
      expect(executionV2MessageSchema.parse(message)).toEqual(message);
    }
    const runless = environmentOperation(
      { operation: "capabilities" },
      { scope: { ...environmentRequest.scope, runId: null, workerRunId: null } },
    );
    expect(executionV2MessageSchema.parse(runless)).toEqual(runless);
    const failed = environmentOutcome({
      outcome: "failed",
      result: null,
      errorCode: "CONTAINER_NOT_RUNNING",
    });
    expect(executionV2MessageSchema.parse(failed)).toEqual(failed);
    const unknown = environmentOutcome({ outcome: "result_unknown", result: null });
    expect(executionV2MessageSchema.parse(unknown)).toEqual(unknown);
  });

  it.each([
    [
      "a Run scope other than the environment's",
      { ...environmentRequest, scope: { ...environmentRequest.scope, runId: "run-02" } },
    ],
    [
      "a missing Worker Run scope",
      { ...environmentRequest, scope: { ...environmentRequest.scope, workerRunId: null } },
    ],
    [
      "a capabilities query without an owner",
      environmentOperation(
        { operation: "capabilities" },
        { scope: { ...environmentRequest.scope, ownerId: null, runId: null, workerRunId: null } },
      ),
    ],
    ["an unknown operation", environmentOperation({ operation: "exec_shell" })],
    [
      "a create without its envelope",
      environmentOperation({ ...environmentPayload, envelope: undefined }),
    ],
    [
      "fields from another operation",
      environmentOperation({ operation: "inspect", ...environmentTarget, stopFence: 1 }),
    ],
    [
      "a deadline before the request",
      environmentOperation({ ...environmentPayload, deadlineAt: "2026-08-25T00:00:00.000Z" }),
    ],
    [
      "a command execution, which only work.execute may carry",
      environmentOperation({
        operation: "execute",
        ...environmentTarget,
        stopFence: 0,
        invocationId: "invocation-01",
        argumentsRef: "payload-arguments-01",
        invocationDeadlineAt: "2026-08-26T00:00:30.000Z",
        credential: null,
      }),
    ],
    ["a success without a result", environmentOutcome({ result: null })],
    ["a failure without an error code", environmentOutcome({ outcome: "failed", result: null })],
    [
      "a result of another operation",
      environmentOutcome({ operation: "create", result: stopProof }),
    ],
    [
      "an incomplete stop proof",
      environmentOutcome({
        operation: "verifyStopped",
        result: { ...stopProof, coverage: ["environment_terminated"] },
      }),
    ],
  ])("rejects %s", (_case, input) => {
    expect(() => executionV2MessageSchema.parse(input)).toThrow(ContractValidationError);
  });
});

describe("Execution v2 fail-closed validation", () => {
  it.each([
    ["unsupported schema", { ...messages[0], schemaVersion: "execution.v3" }],
    ["invalid classification", { ...executeMessage, dataClassification: "secret" }],
    ["missing high-risk authorization", { ...executeMessage, authorizationRef: null }],
    [
      "stale zero epoch",
      { ...executeMessage, scope: { ...executeMessage.scope, authorityEpoch: 0 } },
    ],
    [
      "stale zero fence",
      { ...executeMessage, scope: { ...executeMessage.scope, fencingToken: 0 } },
    ],
    ["missing Run scope", { ...executeMessage, scope: { ...executeMessage.scope, runId: null } }],
    [
      "unbounded memory",
      {
        ...executeMessage,
        payload: {
          ...executeMessage.payload,
          resourceCeiling: { ...executeMessage.payload.resourceCeiling, maxMemoryBytes: 0 },
        },
      },
    ],
    [
      "deadline before request",
      {
        ...executeMessage,
        payload: { ...executeMessage.payload, deadlineAt: "2026-08-25T00:00:00.000Z" },
      },
    ],
    ["raw secret", { ...executeMessage, secretValue: "not-allowed" }],
    [
      "nested raw secret",
      {
        ...executeMessage,
        payload: {
          ...executeMessage.payload,
          secretRefs: [
            {
              secretRef: "secret-ref-01",
              secretVersion: "v1",
              purpose: "github",
              secretValue: "not-allowed",
            },
          ],
        },
      },
    ],
    [
      "permanent deletion without recent authentication",
      {
        ...hostOperationMessage,
        payload: { ...hostOperationMessage.payload, recentAuthenticationRef: null },
      },
    ],
    [
      "host operation stale fence",
      {
        ...hostOperationMessage,
        scope: { ...hostOperationMessage.scope, fencingToken: 0 },
      },
    ],
    ["push host operation is absent", { ...hostOperationMessage, type: "host.workspace.push" }],
    ["unknown message type", { ...messages[0], type: "worker.execute_provider_sdk" }],
  ])("rejects %s", (_case, input) => {
    expect(() => executionV2MessageSchema.parse(input)).toThrow(ContractValidationError);
  });
});
