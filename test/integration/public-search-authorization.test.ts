import { readFile, rm } from "node:fs/promises";
import {
  ApprovalService,
  actionIntentFingerprint,
  type GovernedActionIntent,
  resolveSandboxActionGrant,
} from "@himawari-agent/application";
import { createIdempotencyKey } from "@himawari-agent/domain";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { expect, it } from "vitest";
import { configuredModelDisclosureIdentity } from "../../apps/agent-service/src/production-model-disclosure.js";
import { PublicSearchAuthorization } from "../../apps/agent-service/src/public-search-authorization.js";
import { commandMessage, queryMessage } from "../../apps/control-center/src/messages.js";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

it.each(["directory", "private"] as const)(
  "persists %s search policy, derives exact grants and rejects use after revocation",
  async (mode) => {
    const resource = await openRepository();
    const config = parseProductConfiguration(
      JSON.parse(
        await readFile(
          new URL("./fixtures/file-summary/configuration.json", import.meta.url),
          "utf8",
        ),
      ),
      T1,
    );
    if (!config.runPolicy) throw new Error("fixture policy required");
    const route = {
      hostId: "host",
      workerInstanceId: "worker",
      ...(mode === "private" ? { scopeSource: "private_temp" as const } : { grantId: "directory" }),
      capabilityRef: "search",
      capabilityVersion: "1",
      maximumBytes: 4096,
    };
    const configuration = {
      ...config,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runPolicy: { ...config.runPolicy, publicSearch: route },
    };
    const ui = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ...SERVICE_AUTHORITY.product,
      actorId: OWNER_ID,
      csrfToken: "test",
      authorizationRef: "owner-authorization",
    };
    let sequence = 0;
    const service = new PublicSearchAuthorization({
      configuration,
      repository: resource.repository,
      clock: { now: () => T1 },
      ids: { next: (prefix) => `${prefix}:${++sequence}` },
    });
    const query = () => service.query(queryMessage(ui, "search.authorization.read", {}));
    const change = (enabled: boolean, revision: number, key: string) =>
      service.set(
        commandMessage(
          ui,
          "search.authorization.set",
          { enabled, expectedRevision: revision, recipient: "https://mcp.exa.ai" },
          { authorizationRef: ui.authorizationRef, idempotencyKey: key, risk: "high" },
        ),
        SERVICE_AUTHORITY.lease,
      );
    const model = configuration.modelDescriptors.find((item) => item.role === "primary");
    if (!model) throw new Error("fixture model required");
    const intent: GovernedActionIntent = {
      contractVersion: "authorization.v2",
      id: "search-intent",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      threadId: "thread-capability-invocation",
      capabilityRef: "search",
      capabilityVersion: "1",
      operation: "web_search",
      resourceRef: "coding:query",
      resourceRefs: ["coding:query"],
      targets: [
        { type: "network-domain", ref: "mcp.exa.ai:443" },
        { type: "host", ref: route.hostId },
        ...(mode === "private" ? [] : [{ type: "directory-grant", ref: "directory" }]),
      ],
      dataClassification: "private",
      sideEffect: "none",
      estimatedCostMicros: 0,
      frequency: { count: 1, intervalMs: null },
      idempotencyKey: createIdempotencyKey("search-intent"),
      reversible: true,
      requestedAt: T1,
      expiresAt: T2,
      actionKind: "READ",
      disclosure: "named_recipients",
      recipients: [configuredModelDisclosureIdentity(model), "https://mcp.exa.ai"],
      credentialOrAccessChange: false,
      modelClassification: {
        actionKind: "READ",
        suggestedRisk: "HIGH",
        reasonCode: "governed-search",
      },
      deterministicFacts: [],
      finalRisk: "HIGH",
    };
    try {
      expect(await query()).toMatchObject({ payload: { enabled: false, revision: 0 } });
      await service.authorize(intent);
      expect(
        await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID),
      ).toHaveLength(0);
      const store = resource.repository.authorizationStore();
      const deniedIntent = {
        ...intent,
        id: "previously-denied",
        idempotencyKey: createIdempotencyKey("previously-denied"),
      };
      const denied = await store.createApproval({
        id: "explicit-denial",
        revision: 1,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        intentId: deniedIntent.id,
        intentSnapshot: deniedIntent,
        semanticSnapshotHash: actionIntentFingerprint(deniedIntent),
        status: "pending",
        deliveryState: "deliverable",
        requestedAt: T1,
        expiresAt: T2,
        decidedAt: null,
        grantId: null,
      });
      await new ApprovalService({ store, clock: { now: () => T1 } }).respond({
        approvalRequestId: denied.id,
        expectedRevision: 1,
        semanticSnapshotHash: denied.semanticSnapshotHash,
        response: { decision: "denied" },
      });
      await change(true, 0, "enable-search");
      expect(await change(true, 0, "enable-search")).toMatchObject({ replayed: true });
      await service.authorize({ ...intent, operation: "write" });
      await service.authorize({ ...intent, targets: [] });
      await service.authorize({ ...intent, targets: [...intent.targets, ...intent.targets] });
      await service.authorize({
        ...intent,
        recipients: [configuredModelDisclosureIdentity(model), "https://other.example"],
      });
      expect(
        await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID),
      ).toHaveLength(0);
      await service.authorize(intent);
      await service.authorize(intent);
      const grants = await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID);
      expect(grants).toHaveLength(1);
      const grant = grants[0];
      if (!grant) throw new Error("expected granted search");
      const source = await resource.repository
        .authorizationStore()
        .getApproval(grant.sourceApprovalRequestId);
      expect(source).toMatchObject({
        status: "approved",
        deliveryState: "queued_no_ui",
        policyAuthorization: { revision: 1 },
      });
      const plan = {
        authorizationRef: grant.id,
        capabilityRef: "search",
        capabilityVersion: "1",
        operation: "web_search",
        effectiveDeadlineAt: T2,
        identity: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          threadId: intent.threadId,
        },
      };
      expect(
        (
          await resolveSandboxActionGrant({
            plan,
            authorizations: resource.repository.authorizationStore(),
            now: () => T1,
          })
        ).grant.id,
      ).toBe(grant.id);
      const next = {
        ...intent,
        id: "new-search-content",
        resourceRef: "coding:new-query",
        resourceRefs: ["coding:new-query"],
        idempotencyKey: createIdempotencyKey("new-search-content"),
      };
      await service.authorize(next);
      await service.authorize(next);
      const nextApproval = await store.findApprovalByIntent(next.id);
      expect(nextApproval).toMatchObject({
        status: "approved",
        intentSnapshot: next,
        policyAuthorization: { revision: 1 },
      });
      expect(nextApproval?.grantId).not.toBe(grant.id);
      const all = await store.listGrants(OWNER_ID, AGENT_ID);
      expect(all).toHaveLength(2);
      expect(all.find(({ id }) => id === nextApproval?.grantId)).toMatchObject({
        kind: "one_time",
        maxUses: 1,
        intentFingerprint: actionIntentFingerprint(next),
      });
      await service.authorize(deniedIntent);
      expect(await store.getApproval(denied.id)).toMatchObject({
        status: "denied",
        revision: 2,
        grantId: null,
      });
      expect(await store.listGrants(OWNER_ID, AGENT_ID)).toHaveLength(2);
      await change(false, 1, "revoke-search");
      await expect(
        resolveSandboxActionGrant({
          plan,
          authorizations: resource.repository.authorizationStore(),
          now: () => T1,
        }),
      ).rejects.toThrow("owner policy revoked");
      await expect(
        resource.repository.authorizationStore().consumeGrant({
          grantId: grant.id,
          expectedRevision: grant.revision,
          costMicros: 0,
          consumedAt: T1,
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      expect(await query()).toMatchObject({ payload: { enabled: false, revision: 2 } });
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    }
  },
);
