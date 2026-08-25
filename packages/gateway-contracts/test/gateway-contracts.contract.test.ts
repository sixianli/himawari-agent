import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  GATEWAY_MESSAGE_TYPES,
  gatewayMessageSchema,
} from "../src/index.js";
import messages from "./fixtures/v1/messages.json" with { type: "json" };

const forbiddenKeys = new Set(["apiKey", "accessToken", "password", "secretValue", "credential"]);
const forbiddenPiValues = ["AgentSession", "AgentEvent", "ToolDefinition", "@earendil-works/pi-"];

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

describe("Gateway v1 compatibility fixtures", () => {
  it("round-trips every command, query, subscription, snapshot and streaming event", () => {
    const parsed = messages.map((message) => gatewayMessageSchema.parse(message));

    expect(parsed.map(({ type }) => type)).toEqual(GATEWAY_MESSAGE_TYPES);
    for (const [index, message] of parsed.entries()) {
      expect(gatewayMessageSchema.parseJson(gatewayMessageSchema.serialize(message))).toEqual(
        messages[index],
      );
    }
  });

  it("contains no raw-secret fields or Pi runtime types", () => {
    const serialized = JSON.stringify(messages);

    expect(collectKeys(messages).filter((key) => forbiddenKeys.has(key))).toEqual([]);
    for (const piValue of forbiddenPiValues) expect(serialized).not.toContain(piValue);
  });
});

describe("Gateway v1 invalid input", () => {
  it.each([
    ["unsupported schema", { ...messages[0], schemaVersion: "gateway.v2" }],
    ["missing correlation", { ...messages[0], correlationId: undefined }],
    ["invalid classification", { ...messages[0], dataClassification: "secret" }],
    ["unknown raw-secret field", { ...messages[0], apiKey: "not-allowed" }],
    [
      "nested raw-secret field",
      { ...messages[0], payload: { ...messages[0]?.payload, secretValue: "not-allowed" } },
    ],
    [
      "invalid event sequence",
      { ...messages.at(-1), payload: { ...messages.at(-1)?.payload, sequence: 0 } },
    ],
    ["unknown message type", { ...messages[0], type: "pi.session" }],
  ])("rejects %s", (_case, input) => {
    expect(() => gatewayMessageSchema.parse(input)).toThrow(ContractValidationError);
  });

  it("rejects malformed JSON", () => {
    expect(() => gatewayMessageSchema.parseJson("{")).toThrow(ContractValidationError);
  });
});
