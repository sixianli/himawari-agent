import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  EXECUTION_V2_MESSAGE_TYPES,
  executionV2MessageSchema,
} from "../src/index.ts";
import messages from "./fixtures/v2/messages.json" with { type: "json" };

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
    ["invalid classification", { ...messages[4], dataClassification: "secret" }],
    ["missing high-risk authorization", { ...messages[4], authorizationRef: null }],
    ["stale zero epoch", { ...messages[4], scope: { ...messages[4]?.scope, authorityEpoch: 0 } }],
    ["stale zero fence", { ...messages[4], scope: { ...messages[4]?.scope, fencingToken: 0 } }],
    ["missing Run scope", { ...messages[4], scope: { ...messages[4]?.scope, runId: null } }],
    [
      "unbounded memory",
      {
        ...messages[4],
        payload: {
          ...messages[4]?.payload,
          resourceCeiling: { ...messages[4]?.payload?.resourceCeiling, maxMemoryBytes: 0 },
        },
      },
    ],
    [
      "deadline before request",
      {
        ...messages[4],
        payload: { ...messages[4]?.payload, deadlineAt: "2026-08-25T00:00:00.000Z" },
      },
    ],
    ["raw secret", { ...messages[4], secretValue: "not-allowed" }],
    [
      "nested raw secret",
      {
        ...messages[4],
        payload: {
          ...messages[4]?.payload,
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
    ["unknown message type", { ...messages[0], type: "worker.execute_provider_sdk" }],
  ])("rejects %s", (_case, input) => {
    expect(() => executionV2MessageSchema.parse(input)).toThrow(ContractValidationError);
  });
});
