import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  EXECUTION_MESSAGE_TYPES,
  executionMessageSchema,
} from "../src/index.js";
import messages from "./fixtures/v1/messages.json" with { type: "json" };

const forbiddenKeys = new Set(["apiKey", "accessToken", "password", "secretValue", "credential"]);
const forbiddenPiValues = ["AgentSession", "AgentEvent", "ToolDefinition", "@earendil-works/pi-"];

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

describe("Execution v1 compatibility fixtures", () => {
  it("round-trips every request, progress, result, cancellation and reconciliation message", () => {
    const parsed = messages.map((message) => executionMessageSchema.parse(message));

    expect(parsed.map(({ type }) => type)).toEqual(EXECUTION_MESSAGE_TYPES);
    for (const [index, message] of parsed.entries()) {
      expect(executionMessageSchema.parseJson(executionMessageSchema.serialize(message))).toEqual(
        messages[index],
      );
    }
  });

  it("contains only secret references and no Pi runtime types", () => {
    const serialized = JSON.stringify(messages);

    expect(collectKeys(messages).filter((key) => forbiddenKeys.has(key))).toEqual([]);
    for (const piValue of forbiddenPiValues) expect(serialized).not.toContain(piValue);
  });
});

describe("Execution v1 invalid input", () => {
  it.each([
    ["unsupported schema", { ...messages[0], schemaVersion: "execution.v2" }],
    ["missing idempotency key", { ...messages[0], idempotencyKey: undefined }],
    ["invalid classification", { ...messages[0], dataClassification: "secret" }],
    ["unknown raw-secret field", { ...messages[0], apiKey: "not-allowed" }],
    [
      "secret raw value in a reference",
      {
        ...messages[0],
        payload: {
          ...messages[0]?.payload,
          secretRefs: [
            {
              secretRef: "secret-ref-01",
              secretVersion: "v1",
              purpose: "search",
              secretValue: "no",
            },
          ],
        },
      },
    ],
    [
      "out-of-range progress",
      { ...messages[3], payload: { ...messages[3]?.payload, progressPermille: 1001 } },
    ],
    [
      "deadline before request time",
      {
        ...messages[0],
        payload: { ...messages[0]?.payload, deadlineAt: "2026-08-24T23:59:59.000Z" },
      },
    ],
    [
      "success without an output reference",
      { ...messages[4], payload: { ...messages[4]?.payload, outputRef: null } },
    ],
    [
      "confirmed reconciliation without a result reference",
      { ...messages[6], payload: { ...messages[6]?.payload, resultRef: null } },
    ],
    ["unknown message type", { ...messages[0], type: "pi.tool_call" }],
  ])("rejects %s", (_case, input) => {
    expect(() => executionMessageSchema.parse(input)).toThrow(ContractValidationError);
  });

  it("rejects malformed JSON", () => {
    expect(() => executionMessageSchema.parseJson("{")).toThrow(ContractValidationError);
  });
});
