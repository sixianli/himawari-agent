import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  GATEWAY_V2_MESSAGE_TYPES,
  gatewayV2MessageSchema,
} from "../src/index.ts";
import messages from "./fixtures/v2/messages.json" with { type: "json" };

import {
  autonomyMessages,
  compatibilityMessages,
  fixture,
  governanceMessages,
} from "./gateway-v2.fixture.ts";

const forbiddenKeys = new Set([
  "apiKey",
  "accessToken",
  "password",
  "secretValue",
  "credential",
  "rawContent",
  "jwt",
]);

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

describe("Gateway v2 compatibility fixtures", () => {
  it("round-trips every Thread, approval, task, inbox, Memory, Trace, identity and health message", () => {
    const byType = new Map(compatibilityMessages.map((message) => [message.type, message]));
    const ordered = GATEWAY_V2_MESSAGE_TYPES.map((type) => byType.get(type));
    expect(ordered.every(Boolean)).toBe(true);
    const parsed = ordered.map((message) => gatewayV2MessageSchema.parse(message));

    expect(parsed.map(({ type }) => type)).toEqual(GATEWAY_V2_MESSAGE_TYPES);
    for (const [index, message] of parsed.entries()) {
      expect(gatewayV2MessageSchema.parseJson(gatewayV2MessageSchema.serialize(message))).toEqual(
        ordered[index],
      );
    }
  });

  it("contains references instead of raw content, secrets, JWT or provider SDK types", () => {
    const serialized = JSON.stringify(compatibilityMessages);

    expect(collectKeys(compatibilityMessages).filter((key) => forbiddenKeys.has(key))).toEqual([]);
    for (const forbidden of ["@octokit/", "mem0ai", "fastify", "CloudflareJwtPayload"])
      expect(serialized).not.toContain(forbidden);
  });
});

describe("Gateway v2 fail-closed validation", () => {
  it.each([
    ["unsupported schema", { ...messages[0], schemaVersion: "gateway.v3" }],
    ["invalid classification", { ...messages[0], dataClassification: "secret" }],
    ["missing authorization", { ...messages[2], authorizationRef: null }],
    [
      "improvement cannot self-activate",
      {
        ...autonomyMessages[2],
        payload: {
          // biome-ignore lint/complexity/useLiteralKeys: fixture JSON has an index signature.
          ...(autonomyMessages[2]?.["payload"] as Record<string, unknown>),
          decision: "apply",
        },
      },
    ],
    [
      "missing GitHub disclosure",
      { ...messages[4], payload: { ...messages[4]?.payload, disclosure: null } },
    ],
    [
      "missing GitHub revoke history policy",
      {
        ...messages[4],
        payload: {
          ...messages[4]?.payload,
          action: "revoke",
          historyPolicy: null,
          disclosure: null,
        },
      },
    ],
    [
      "GitHub disclosure on pause",
      {
        ...messages[4],
        payload: { ...messages[4]?.payload, action: "pause", historyPolicy: null },
      },
    ],
    [
      "empty GitHub disclosure classifications",
      {
        ...messages[4],
        payload: {
          ...messages[4]?.payload,
          disclosure: { ...messages[4]?.payload?.disclosure, disclosedDataClassifications: [] },
        },
      },
    ],
    [
      "stale zero epoch",
      { ...messages[0], authority: { ...messages[0]?.authority, authorityEpoch: 0 } },
    ],
    [
      "stale zero fence",
      { ...messages[0], authority: { ...messages[0]?.authority, fencingToken: 0 } },
    ],
    ["raw secret", { ...messages[0], secretValue: "not-allowed" }],
    [
      "nested raw secret",
      { ...messages[0], payload: { ...messages[0]?.payload, accessToken: "not-allowed" } },
    ],
    [
      "archive with correction content",
      {
        ...messages[5],
        payload: { ...messages[5]?.payload, action: "archive", contentRef: "payload-forbidden" },
      },
    ],
    [
      "approved capability update without Approval",
      {
        ...governanceMessages[3],
        payload: {
          capabilityRef: "capability-01",
          expectedRevision: 5,
          decision: "approved",
          approvalRef: null,
        },
      },
    ],
    [
      "denied capability update with Approval",
      {
        ...governanceMessages[3],
        payload: {
          capabilityRef: "capability-01",
          expectedRevision: 5,
          decision: "denied",
          approvalRef: "approval-must-not-be-used",
        },
      },
    ],
    [
      "permanent deletion without recent authentication",
      fixture("command", "host.file.execute", {
        operationPlanRef: "permanent-deletion-01",
        expectedRevision: 1,
        operation: "permanent_delete",
        canonicalHash: "sha256-permanent-deletion-01",
        recentAuthenticationRef: null,
      }),
    ],
    [
      "workspace staging without task-owned paths",
      fixture("command", "workspace.stage", {
        workspaceSnapshotId: "workspace-snapshot-01",
        expectedTaskChangeSetRevision: 2,
        taskPathRefs: [],
        validationResultRefs: ["validation-01"],
        commitMessageRef: "payload-commit-message-01",
        expiresAt: "2026-08-26T01:00:00.000Z",
      }),
    ],
    ["push surface is absent", { ...messages[0], type: "workspace.push" }],
    ["unknown message type", { ...messages[0], type: "provider.github.raw" }],
  ])("rejects %s", (_case, input) => {
    expect(() => gatewayV2MessageSchema.parse(input)).toThrow(ContractValidationError);
  });
});
