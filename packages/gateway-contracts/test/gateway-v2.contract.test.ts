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
    [
      "[P4-6] memory checkup merge without the memory to keep",
      fixture("command", "proactive.review.checkup", {
        key: "checkup:checkup-01",
        action: "merge",
        keep: null,
      }),
    ],
    [
      "[P4-6] memory checkup confirm that names a memory to keep",
      fixture("command", "proactive.review.checkup", {
        key: "checkup:checkup-01",
        action: "confirm",
        keep: "memory-02",
      }),
    ],
    [
      "[P4-6] memory checkup with an unknown action",
      fixture("command", "proactive.review.checkup", {
        key: "checkup:checkup-01",
        action: "rate",
        keep: null,
      }),
    ],
    [
      "[P5-3] external proposal rejected with edited text",
      fixture("command", "memory.external.respond", {
        items: [{ proposalId: "external-proposal-01", decision: "reject", editedText: "改过的" }],
      }),
    ],
    [
      "[P5-3] external proposal answered twice in one batch",
      fixture("command", "memory.external.respond", {
        items: [
          { proposalId: "external-proposal-01", decision: "keep", editedText: null },
          { proposalId: "external-proposal-01", decision: "reject", editedText: null },
        ],
      }),
    ],
    [
      "[P5-3] external proposal batch with no items",
      fixture("command", "memory.external.respond", { items: [] }),
    ],
    [
      "[P5-3] external proposal batch over 500 items",
      fixture("command", "memory.external.respond", {
        items: Array.from({ length: 501 }, (_unused, index) => ({
          proposalId: `external-proposal-${index}`,
          decision: "keep",
          editedText: null,
        })),
      }),
    ],
    [
      "[ADR-0285] taking back a yes goes through its own command, not the rule answer",
      fixture("command", "memory.rule.respond", {
        target: "allowance:0123456789abcdef",
        action: "revoke",
      }),
    ],
    [
      "[ADR-0285] taking back a yes without naming it",
      fixture("command", "approval.allowance.revoke", {}),
    ],
    ["push surface is absent", { ...messages[0], type: "workspace.push" }],
    ["unknown message type", { ...messages[0], type: "provider.github.raw" }],
  ])("rejects %s", (_case, input) => {
    expect(() => gatewayV2MessageSchema.parse(input)).toThrow(ContractValidationError);
  });
});

describe("Gateway v2 approval display limits", () => {
  const base = (
    governanceMessages as unknown as readonly { type: string; payload?: object }[]
  ).find((message) => message.type === "approval.snapshot");
  const withDisplay = (display: Record<string, unknown>) => ({
    ...base,
    payload: { ...base?.payload, display },
  });
  const display = (overrides: Record<string, unknown>) => ({
    displayTitle: null,
    bodyPreview: null,
    askedBecause: { kind: "no_rule_allows", ruleId: null, ruleText: null },
    origin: null,
    ...overrides,
  });

  it.each([
    ["bodyPreview", (length: number) => ({ bodyPreview: "x".repeat(length) }), 2001],
    ["displayTitle", (length: number) => ({ displayTitle: "x".repeat(length) }), 301],
    [
      "ruleText",
      (length: number) => ({
        askedBecause: { kind: "rule", ruleId: "rule-1", ruleText: "x".repeat(length) },
      }),
      2001,
    ],
    [
      "threadTitle",
      (length: number) => ({ origin: { threadId: "thread-1", threadTitle: "x".repeat(length) } }),
      121,
    ],
  ])("accepts %s at its limit and rejects one character more", (_name, make, limit) => {
    expect(() => gatewayV2MessageSchema.parse(withDisplay(display(make(limit))))).not.toThrow();
    expect(() => gatewayV2MessageSchema.parse(withDisplay(display(make(limit + 1))))).toThrow(
      ContractValidationError,
    );
  });

  it("accepts tab, newline and carriage return but rejects other control characters", () => {
    expect(() =>
      gatewayV2MessageSchema.parse(withDisplay(display({ bodyPreview: "a\tb\nc\rd" }))),
    ).not.toThrow();
    for (const bad of ["a\u0000b", "a\u001bb", "a\u007fb"])
      expect(() =>
        gatewayV2MessageSchema.parse(withDisplay(display({ bodyPreview: bad }))),
      ).toThrow(ContractValidationError);
  });
});
