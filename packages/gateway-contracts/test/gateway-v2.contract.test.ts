import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  GATEWAY_V2_MESSAGE_TYPES,
  gatewayV2MessageSchema,
} from "../src/index.ts";
import messages from "./fixtures/v2/messages.json" with { type: "json" };

const authority = { deploymentId: "deployment-01", authorityEpoch: 8, fencingToken: 3 };
const scope = { ownerId: "owner-01", agentId: "agent-01" };
const actor = { actorType: "owner", actorId: "owner-01" } as const;

function fixture(
  kind: "command" | "query" | "snapshot",
  type: string,
  payload: unknown,
): Record<string, unknown> {
  return {
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `fixture-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: kind === "command" ? "high" : "low",
    authorizationRef: kind === "command" ? "authorization-governance-01" : null,
    scope,
    authority,
    actor: kind === "snapshot" ? { actorType: "system", actorId: "agent-service-01" } : actor,
    ...(kind === "command" ? { idempotencyKey: `idempotency-${type}` } : {}),
    payload,
  };
}

const governanceMessages = [
  fixture("command", "grant.revoke", {
    grantId: "grant-01",
    expectedRevision: 2,
    reasonCode: "owner-requested",
  }),
  fixture("command", "capability.review", {
    capabilityRef: "capability-01",
    expectedRevision: 2,
  }),
  fixture("command", "capability.install.approve", {
    capabilityRef: "capability-01",
    expectedRevision: 3,
    approvalRef: "approval-install-01",
  }),
  fixture("command", "capability.update.respond", {
    capabilityRef: "capability-01",
    expectedRevision: 5,
    decision: "approved",
    approvalRef: "approval-update-01",
  }),
  fixture("command", "capability.disable", {
    capabilityRef: "capability-01",
    expectedRevision: 7,
    reasonCode: "owner-disabled",
  }),
  fixture("command", "capability.rollback", {
    capabilityRef: "capability-01",
    expectedRevision: 8,
    reasonCode: "owner-rollback",
  }),
  fixture("query", "approval.detail", { approvalRequestId: "approval-01" }),
  fixture("query", "capability.list", {
    lifecycle: null,
    afterCursor: null,
    limit: 50,
  }),
  fixture("query", "capability.detail", { capabilityRef: "capability-01" }),
  fixture("query", "grant.list", { includeRevoked: true, afterCursor: null, limit: 50 }),
  fixture("query", "grant.detail", { grantId: "grant-01" }),
  fixture("snapshot", "approval.snapshot", {
    approvalRequestId: "approval-01",
    revision: 2,
    status: "pending",
    deliveryState: "deliverable",
    semanticSnapshotHash: "sha256:snapshot01",
    finalRisk: "high",
    recentAuthenticationRequired: true,
    recentAuthenticationRef: null,
    requestedAt: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-08-26T01:00:00.000Z",
    decidedAt: null,
    grantId: null,
    intent: {
      intentId: "intent-01",
      threadId: "thread-01",
      runId: "run-01",
      actionKind: "COMMUNICATE",
      capabilityRef: "capability-01",
      capabilityVersion: "1.0.0",
      operation: "publish",
      targetRefs: ["target-01"],
      resourceRefs: ["resource:article-01"],
      dataClassification: "private",
      disclosure: "named_recipients",
      recipientRefs: ["recipient:reviewer-01"],
      sideEffect: "irreversible",
      estimatedCostMicros: 1_000,
      frequency: { count: 1, intervalMs: null },
      credentialOrAccessChange: false,
      reversible: false,
      idempotencyKey: "intent-publish-01",
      deterministicFactCodes: ["EXTERNAL_COMMUNICATION"],
      modelReasonCode: "MODEL_COMMUNICATION",
      requestedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-26T01:00:00.000Z",
    },
    trueResultRef: null,
    generatedAt: "2026-08-26T00:00:01.000Z",
  }),
  fixture("snapshot", "capability.snapshot", {
    capabilityRef: "capability-01",
    revision: 7,
    lifecycle: "update_proposed",
    displayName: "Fixture capability",
    sourceType: "adapter",
    sourceLocator: "adapter:fixture:1.0.0",
    sourceIdentity: "publisher:fixture",
    version: "1.0.0",
    integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    signatureStatus: "verified",
    signerRef: "signer-fixture",
    operations: ["publish"],
    permissionRefs: ["permission-publish"],
    dataClassifications: ["private"],
    networkScopes: ["api.example.test:443"],
    filesystemScopes: [],
    secretRefs: ["provider-token"],
    isolation: "remote",
    currency: "USD",
    maxMicrosPerInvocation: 1_000,
    healthStatus: "healthy",
    healthCheckedAt: "2026-08-26T00:00:00.000Z",
    reviewedBy: "owner-01",
    reviewedAt: "2026-08-26T00:00:00.000Z",
    approvalRefs: ["approval-install-01"],
    dependencyTaskRefs: ["task-01"],
    runtimeQualification: {
      platform: "linux",
      runtimeIdentity: "node-fetch:adapter-fixture",
      productionSuitable: true,
      reasonCodes: [],
      checkedAt: "2026-08-26T00:00:00.000Z",
    },
    pendingVersion: "2.0.0",
    updateAssessment: {
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      disposition: "approval_required",
      risk: "critical",
      sourceIdentityChanged: false,
      integrityChanged: true,
      semanticMajorChanged: true,
      runtimeKindChanged: false,
      executableIdentityChanged: false,
      executableCodeChanged: false,
      expansions: ["permission:publish-public"],
      contractions: [],
      compatibilityPreserved: true,
      reasonCodes: ["CAPABILITY_UPDATE_MAJOR_CHANGED"],
    },
    rollbackVersion: "0.9.0",
    rollbackAvailable: true,
    lastTransition: {
      fromVersion: "0.9.0",
      toVersion: "1.0.0",
      outcome: "activated",
      occurredAt: "2026-08-26T00:00:00.000Z",
      externalEffectsRolledBack: false,
      productStateRolledBack: false,
    },
    generatedAt: "2026-08-26T00:00:01.000Z",
  }),
  fixture("snapshot", "grant.snapshot", {
    grantId: "grant-01",
    revision: 2,
    kind: "one_time",
    status: "active",
    capabilityRef: "capability-01",
    capabilityVersion: "1.0.0",
    operations: ["publish"],
    exactResourceRef: "resource:article-01",
    resourceIdentities: ["resource:article-01"],
    resourcePrefixes: [],
    maxDataClassification: "private",
    disclosure: "named_recipients",
    sideEffects: ["irreversible"],
    recipientRefs: ["recipient:reviewer-01"],
    maxCostMicrosPerUse: 1_000,
    maxFrequency: { count: 1, intervalMs: null },
    validFrom: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-08-26T01:00:00.000Z",
    uses: 0,
    maxUses: 1,
    spentCostMicros: 0,
    maxTotalCostMicros: 1_000,
    sourceApprovalRequestId: "approval-01",
    revokedAt: null,
    revocationReasonCode: null,
    affectedTaskRefs: ["task-01"],
    generatedAt: "2026-08-26T00:00:01.000Z",
  }),
] as const;

const compatibilityMessages = [
  ...messages.map((message) =>
    message.type === "approval.respond"
      ? {
          ...message,
          payload: {
            ...message.payload,
            expectedRevision: 1,
            recentAuthenticationRef: "recent-auth-01",
          },
        }
      : message,
  ),
  ...governanceMessages,
];

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
    ["unknown message type", { ...messages[0], type: "provider.github.raw" }],
  ])("rejects %s", (_case, input) => {
    expect(() => gatewayV2MessageSchema.parse(input)).toThrow(ContractValidationError);
  });
});
