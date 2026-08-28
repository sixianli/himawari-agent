import {
  ApplicationPortError,
  type PreparedWebAction,
  type WebCapabilityService,
  type WebExecutionHandle,
  type WebOperationRecord,
  type WebResourceRecord,
  type WebSessionRecord,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import type { PortConformanceHarness } from "./harness.js";
import { withPort } from "./harness.js";

export interface WebCapabilityConformanceFixture {
  readonly service: WebCapabilityService;
  readonly origin: string;
  readonly publicUrl: string;
  readonly readResourceBody: (resource: WebResourceRecord) => Promise<string>;
  readonly createSession: () => Promise<WebSessionRecord>;
  readonly prepare: (session: WebSessionRecord) => Promise<PreparedWebAction>;
  readonly handle: (action: PreparedWebAction, operationId: string) => WebExecutionHandle;
  readonly executionCount: (operationId: string) => number;
  readonly forceUnknownOnce: () => void;
}

export function webCapabilityConformance(
  harness: PortConformanceHarness<WebCapabilityConformanceFixture>,
): void {
  describe("Web capability conformance", () => {
    it("stores an opened public source while treating page instructions as untrusted", async () => {
      await withPort(harness, async (fixture) => {
        const resource = await fixture.service.openPublic({
          requestedUrl: fixture.publicUrl,
          authorized: true,
        });
        const body = await fixture.readResourceBody(resource);
        expect(resource.contentDigest).toMatch(/^sha256:/);
        expect(resource.excludedReasonCodes).toContain("prompt_injection_observed");
        expect(resource.excludedReasonCodes).toContain("machine_secret_removed");
        expect(body).toContain("[REDACTED_MACHINE_SECRET]");
        await expect(
          fixture.service.buildResearchCitations([
            {
              claimRef: "claim:fixture",
              resourceId: resource.id,
              fragmentRef: resource.selectedFragmentRefs[0] ?? "missing",
            },
          ]),
        ).resolves.toEqual([
          {
            claimRef: "claim:fixture",
            resourceId: resource.id,
            contentDigest: resource.contentDigest,
            fragmentRef: resource.selectedFragmentRefs[0],
          },
        ]);
      });
    });

    it("freezes origin and page version before a single confirmed execution", async () => {
      await withPort(harness, async (fixture) => {
        const session = await fixture.createSession();
        const action = await fixture.prepare(session);
        const handle = fixture.handle(action, "web-operation-success");
        const result = await fixture.service.executeAction({
          handle,
          idempotencyKey: "web-operation-success-key",
          authorityFence: handle.authorityFence,
        });
        const replay = await fixture.service.executeAction({
          handle,
          idempotencyKey: "web-operation-success-key",
          authorityFence: handle.authorityFence,
        });
        expect(result.status).toBe("confirmed_succeeded");
        expect(result.receiptRef).toBe("receipt:web-operation-success");
        expect(replay).toEqual(result);
        expect(fixture.executionCount(result.id)).toBe(1);
      });
    });

    it("records an interrupted dispatch as unknown and reconciles without resubmitting", async () => {
      await withPort(harness, async (fixture) => {
        const session = await fixture.createSession();
        const action = await fixture.prepare(session);
        fixture.forceUnknownOnce();
        const handle = fixture.handle(action, "web-operation-unknown");
        const unknown = await fixture.service.executeAction({
          handle,
          idempotencyKey: "web-operation-unknown-key",
          authorityFence: handle.authorityFence,
        });
        const reconciled = await fixture.service.reconcile(unknown.id);
        expect(unknown.status).toBe("unknown");
        expect(reconciled.status).toBe("confirmed_succeeded");
        expect(fixture.executionCount(unknown.id)).toBe(1);
      });
    });

    it("blocks cross-origin prepare and migrated host credentials", async () => {
      await withPort(harness, async (fixture) => {
        const session = await fixture.createSession();
        await expect(
          fixture.service.prepareAction({
            sessionId: session.id,
            finalUrl: "https://different.example/submit",
            method: "POST",
            fieldRefs: ["payload:field"],
            uploadRefs: [],
            recipientRefs: [],
            priceMicros: null,
            currency: null,
            accountRef: null,
            sideEffectFacts: ["COMMUNICATE"],
            reversible: false,
            successMarker: "receipt",
            expiresAt: "2026-08-28T22:00:00.000Z",
          }),
        ).rejects.toBeInstanceOf(ApplicationPortError);
        await fixture.service.blockSessionsAfterAuthorityTransfer([session.id]);
        await expect(fixture.prepare(session)).rejects.toBeInstanceOf(ApplicationPortError);
      });
    });
  });
}

export function operationOutcome(record: WebOperationRecord): string {
  return record.status;
}
