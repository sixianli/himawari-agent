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
