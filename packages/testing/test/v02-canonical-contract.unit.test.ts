import {
  assertCanonicalScope,
  assertDeletionHookContract,
  assertExternalEffectContract,
  assertExecutionHandleContract,
  assertMigrationCredentialContract,
  assertSecretReferenceContract,
  assertV02EvidenceRecord,
  createV02Fixture,
  deduplicateCanonicalEvents,
  mergeV02Evidence,
  type V02EvidenceRecord,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

function evidence(overrides: Partial<V02EvidenceRecord> = {}): V02EvidenceRecord {
  return {
    schemaVersion: "himawari.v0.2.evidence.v1",
    candidateRevision: "a".repeat(40),
    artifactDigest: digest("a"),
    configurationDigest: digest("b"),
    platformProfile: "macos-local",
    command: "npm run check",
    exitStatus: 0,
    startedAt: "2026-08-28T00:00:00.000Z",
    finishedAt: "2026-08-28T00:01:00.000Z",
    result: "passed",
    logRefs: ["log:npm-check"],
    screenshotRefs: [],
    evidenceDigest: digest("c"),
    ...overrides,
  };
}

describe("v0.2 canonical cross-slice contracts", () => {
  it("uses one product-owned Owner/Agent/Thread/Run/Trace and authority fence", () => {
    const fixture = createV02Fixture();
    expect(() => assertCanonicalScope(fixture.scope, fixture.records)).not.toThrow();
    expect(fixture.resourceRefs).toMatchObject({
      memory: "memory-v02-fixture",
      task: "task-v02-fixture",
      calendar: "calendar-v02-fixture",
      migration: "transfer-v02-fixture",
    });
    expect(fixture.profiles).toMatchObject({
      platforms: ["macos-local", "hermes-linux"],
      browsers: ["chromium", "webkit"],
      timeZone: "Asia/Tokyo",
      modelRoles: ["primary", "fallback"],
    });
  });

  it("fails closed for foreign authority, a second writer, or local identity substitution", () => {
    const fixture = createV02Fixture();
    const record = fixture.records[0];
    if (!record) throw new Error("Expected canonical fixture record");
    expect(() =>
      assertCanonicalScope(fixture.scope, [
        { ...record, authority: { ...fixture.scope.authority, fencingToken: 8 } },
      ]),
    ).toThrow(/stale or foreign/);
    expect(() =>
      assertCanonicalScope(fixture.scope, [{ ...record, authorityWriter: "browser" }]),
    ).toThrow(/second product authority/);
    expect(() =>
      assertCanonicalScope(fixture.scope, [{ ...record, providerRowId: fixture.scope.runId }]),
    ).toThrow(/cannot replace/);
  });

  it("deduplicates identical deliveries and rejects semantic reuse", () => {
    const event = {
      source: "github",
      deliveryId: "delivery-01",
      semanticFingerprint: "event-fingerprint-01",
    };
    expect(deduplicateCanonicalEvents([event, event])).toEqual([event]);
    expect(() =>
      deduplicateCanonicalEvents([
        event,
        { ...event, semanticFingerprint: "event-fingerprint-changed" },
      ]),
    ).toThrow(/changed semantic fingerprint/);
  });

  it("requires authorization, bounded reconciliation, secret handles, deletion hooks, and host reauthorization", () => {
    expect(() =>
      assertExternalEffectContract({
        effectKind: "calendar.event.create",
        stableIdentity: "effect-calendar-01",
        actionIntentRef: "intent-calendar-01",
        authorizationRef: "authorization-calendar-01",
        executionHandleRef: "handle-calendar-01",
        boundedReadbackRef: "readback-calendar-01",
        reconcileRef: "reconcile-calendar-01",
        resultRef: "result-calendar-01",
        attentionRef: "attention-calendar-01",
        outcome: "result_unknown",
        retryPolicy: "reconcile_only",
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalEffectContract({
        effectKind: "calendar.event.create",
        stableIdentity: "effect-calendar-01",
        actionIntentRef: "intent-calendar-01",
        authorizationRef: "authorization-calendar-01",
        executionHandleRef: "handle-calendar-01",
        boundedReadbackRef: "readback-calendar-01",
        reconcileRef: "reconcile-calendar-01",
        resultRef: "result-calendar-01",
        attentionRef: null,
        outcome: "result_unknown",
        retryPolicy: "never",
      }),
    ).toThrow(/reconcile before any retry/);
    const fixture = createV02Fixture();
    expect(() =>
      assertExecutionHandleContract({
        handleRef: "handle-calendar-01",
        status: "active",
        authority: fixture.scope.authority,
        expectedAuthority: fixture.scope.authority,
        remainingUses: 1,
        deadlineAt: "2026-08-28T00:05:00.000Z",
        now: "2026-08-28T00:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertExecutionHandleContract({
        handleRef: "handle-calendar-01",
        status: "revoked",
        authority: fixture.scope.authority,
        expectedAuthority: fixture.scope.authority,
        remainingUses: 1,
        deadlineAt: "2026-08-28T00:05:00.000Z",
        now: "2026-08-28T00:00:00.000Z",
      }),
    ).toThrow(/revoked/);
    expect(() =>
      assertSecretReferenceContract({
        secretRef: "secret-handle-calendar-01",
        rawValuePresent: false,
        disclosedToModel: false,
        disclosedToBrowser: false,
        includedInMigration: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertSecretReferenceContract({
        secretRef: "secret-handle-calendar-01",
        rawValuePresent: true,
        disclosedToModel: false,
        disclosedToBrowser: false,
        includedInMigration: false,
      }),
    ).toThrow(/raw values/);
    expect(() =>
      assertDeletionHookContract({
        lifecycle: "deleted_verified",
        contentResolvable: false,
        projectionResolvable: false,
        lineageMarkerPresent: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertDeletionHookContract({
        lifecycle: "deleted_verified",
        contentResolvable: true,
        projectionResolvable: false,
        lineageMarkerPresent: true,
      }),
    ).toThrow(/remove resolvable content/);
    expect(() =>
      assertMigrationCredentialContract({
        credentialKind: "host_bound",
        transferState: "included",
      }),
    ).toThrow(/reauthorization/);
  });
});

describe("v0.2 evidence harness", () => {
  it("accepts complete evidence and merges only one exact qualification identity", () => {
    const first = evidence();
    const second = evidence({ command: "npm run test:unit", evidenceDigest: digest("d") });
    expect(() => assertV02EvidenceRecord(first)).not.toThrow();
    expect(mergeV02Evidence([first, second])).toEqual([first, second]);
  });

  it.each([
    ["candidate", { candidateRevision: "b".repeat(40) }],
    ["artifact", { artifactDigest: digest("e") }],
    ["configuration", { configurationDigest: digest("f") }],
    ["platform", { platformProfile: "hermes-linux" as const }],
  ])("rejects evidence from a different %s", (_label, overrides) => {
    expect(() => mergeV02Evidence([evidence(), evidence(overrides)])).toThrow(/cannot be merged/);
  });

  it("rejects stale or internally inconsistent command evidence", () => {
    expect(() => assertV02EvidenceRecord(evidence({ candidateRevision: "short" }))).toThrow(
      /40-character/,
    );
    expect(() => assertV02EvidenceRecord(evidence({ exitStatus: 1, result: "passed" }))).toThrow(
      /agree/,
    );
    expect(() =>
      assertV02EvidenceRecord(
        evidence({
          startedAt: "2026-08-28T00:02:00.000Z",
          finishedAt: "2026-08-28T00:01:00.000Z",
        }),
      ),
    ).toThrow(/time interval/);
  });
});
