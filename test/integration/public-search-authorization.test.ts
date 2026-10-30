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
      authority: () => SERVICE_AUTHORITY.lease,
    });
    const query = () => service.query(queryMessage(ui, "search.authorization.read", {}));
    const change = (enabled: boolean, revision: number, key: string) =>
      service.set(
        commandMessage(
          ui,
          "search.authorization.set",
          { enabled, expectedRevision: revision, recipients: ["https://mcp.exa.ai"] },
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
      expect(await query()).toMatchObject({
        payload: { enabled: true, providersChanged: false, revision: 0 },
      });
      await change(false, 0, "revoke-default");
      expect(await query()).toMatchObject({
        payload: { enabled: false, providersChanged: false, revision: 1 },
      });
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
      await change(true, 1, "enable-search");
      expect(await change(true, 1, "enable-search")).toMatchObject({ replayed: true });
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
        policyAuthorization: { revision: 2 },
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
        policyAuthorization: { revision: 2 },
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
      await change(false, 2, "revoke-search");
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
      expect(await query()).toMatchObject({ payload: { enabled: false, revision: 3 } });
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    }
  },
);

it("covers page reading under the same owner switch, keeps it through limit changes and asks again when the provider list changes", async () => {
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
  const policy = config.runPolicy;
  const route = {
    hostId: "host",
    workerInstanceId: "worker",
    scopeSource: "private_temp" as const,
    capabilityVersion: "1",
    maximumBytes: 4096,
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
  const service = (
    providers?: readonly ("exa-public" | "deepseek")[],
    limits: { readonly maximumBytes?: number } = {},
  ) =>
    new PublicSearchAuthorization({
      configuration: {
        ...config,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runPolicy: {
          ...policy,
          publicSearch: { ...route, capabilityRef: "search" },
          publicFetch: {
            ...route,
            capabilityRef: "fetch",
            ...(providers ? { providers } : {}),
            ...limits,
          },
        },
      },
      repository: resource.repository,
      clock: { now: () => T1 },
      ids: { next: (prefix) => `${prefix}:${++sequence}` },
    });
  const model = config.modelDescriptors.find((item) => item.role === "primary");
  if (!model) throw new Error("fixture model required");
  const intent: GovernedActionIntent = {
    contractVersion: "authorization.v2",
    id: "fetch-intent",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    threadId: "thread-capability-invocation",
    capabilityRef: "fetch",
    capabilityVersion: "1",
    operation: "web_fetch",
    resourceRef: "coding:url",
    resourceRefs: ["coding:url"],
    targets: [
      { type: "network-domain", ref: "mcp.exa.ai:443" },
      { type: "host", ref: route.hostId },
    ],
    dataClassification: "private",
    sideEffect: "none",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: createIdempotencyKey("fetch-intent"),
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
      reasonCode: "governed-fetch",
    },
    deterministicFacts: [],
    finalRisk: "HIGH",
  };
  const set = (target: PublicSearchAuthorization, recipients: string[], key: string) =>
    target.set(
      commandMessage(
        ui,
        "search.authorization.set",
        { enabled: true, expectedRevision: 0, recipients },
        { authorizationRef: ui.authorizationRef, idempotencyKey: key, risk: "high" },
      ),
      SERVICE_AUTHORITY.lease,
    );
  try {
    const exaOnly = service();
    await expect(
      set(exaOnly, ["https://mcp.exa.ai", "https://api.deepseek.com"], "stale-list"),
    ).rejects.toThrow("SEARCH_RECIPIENTS_CHANGED");
    await set(exaOnly, ["https://mcp.exa.ai"], "enable");
    await exaOnly.authorize({ ...intent, capabilityRef: "search" });
    await exaOnly.authorize({
      ...intent,
      targets: [...intent.targets, { type: "network-domain", ref: "api.deepseek.com:443" }],
    });
    expect(
      await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID),
    ).toHaveLength(0);
    await exaOnly.authorize(intent);
    expect(
      await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID),
    ).toHaveLength(1);
    const resized = service(undefined, { maximumBytes: 102_400 });
    expect(await resized.query(queryMessage(ui, "search.authorization.read", {}))).toMatchObject({
      payload: { enabled: true, recipients: ["https://mcp.exa.ai"] },
    });
    await resized.authorize({
      ...intent,
      id: "fetch-intent-resized",
      idempotencyKey: createIdempotencyKey("fetch-intent-resized"),
    });
    expect(
      await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID),
    ).toHaveLength(2);
    const widened = service(["exa-public", "deepseek"]);
    expect(await widened.query(queryMessage(ui, "search.authorization.read", {}))).toMatchObject({
      payload: {
        enabled: false,
        providersChanged: true,
        recipients: ["https://mcp.exa.ai", "https://api.deepseek.com"],
      },
    });
    await widened.authorize({
      ...intent,
      id: "fetch-intent-2",
      idempotencyKey: createIdempotencyKey("fetch-intent-2"),
      targets: [...intent.targets, { type: "network-domain", ref: "api.deepseek.com:443" }],
      recipients: [...intent.recipients, "https://api.deepseek.com"],
    });
    expect(
      await resource.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID),
    ).toHaveLength(2);
  } finally {
    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  }
});

it("keeps web search on by default and through model changes, and turns it off with a notice only when the search service changes", async () => {
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
  const policy = config.runPolicy;
  const route = {
    hostId: "host",
    workerInstanceId: "worker",
    scopeSource: "private_temp" as const,
    capabilityRef: "search",
    capabilityVersion: "1",
    maximumBytes: 4096,
  };
  const ui = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ...SERVICE_AUTHORITY.product,
    actorId: OWNER_ID,
    csrfToken: "test",
    authorizationRef: "owner-authorization",
  };
  const primary = config.modelDescriptors.find((item) => item.role === "primary");
  if (!primary) throw new Error("fixture model required");
  const switchedModel = { ...primary, model: "zai/glm-5.3-flash", version: "catalog-2026-10-30" };
  let sequence = 0;
  const service = (
    models: typeof config.modelDescriptors,
    providers?: readonly ("exa-public" | "deepseek")[],
  ) =>
    new PublicSearchAuthorization({
      configuration: {
        ...config,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        modelDescriptors: models,
        runPolicy: { ...policy, publicSearch: { ...route, ...(providers ? { providers } : {}) } },
      },
      repository: resource.repository,
      clock: { now: () => T1 },
      ids: { next: (prefix) => `${prefix}:${++sequence}` },
      authority: () => SERVICE_AUTHORITY.lease,
    });
  const intent = (id: string, model: typeof primary): GovernedActionIntent => ({
    contractVersion: "authorization.v2",
    id,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    threadId: "thread-capability-invocation",
    capabilityRef: "search",
    capabilityVersion: "1",
    operation: "web_search",
    resourceRef: `coding:${id}`,
    resourceRefs: [`coding:${id}`],
    targets: [
      { type: "network-domain", ref: "mcp.exa.ai:443" },
      { type: "host", ref: route.hostId },
    ],
    dataClassification: "private",
    sideEffect: "none",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: createIdempotencyKey(id),
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
  });
  const read = (target: PublicSearchAuthorization) =>
    target.query(queryMessage(ui, "search.authorization.read", {}));
  const store = resource.repository.authorizationStore();
  try {
    const before = service(config.modelDescriptors);
    expect(await read(before)).toMatchObject({
      payload: { enabled: true, providersChanged: false, revision: 0 },
    });
    await Promise.all([
      before.authorize(intent("tokyo", primary)),
      before.authorize(intent("osaka", primary)),
    ]);
    expect(await store.findApprovalByIntent("tokyo")).toMatchObject({
      status: "approved",
      policyAuthorization: { revision: 1 },
    });
    expect(await store.findApprovalByIntent("osaka")).toMatchObject({
      status: "approved",
      policyAuthorization: { revision: 1 },
    });
    expect(await read(before)).toMatchObject({ payload: { enabled: true, revision: 1 } });

    const afterModelSwitch = service([
      switchedModel,
      ...config.modelDescriptors.filter((item) => item.role !== "primary"),
    ]);
    expect(await read(afterModelSwitch)).toMatchObject({
      payload: { enabled: true, providersChanged: false, revision: 1 },
    });
    await afterModelSwitch.authorize(intent("after-model-switch", switchedModel));
    expect(await store.findApprovalByIntent("after-model-switch")).toMatchObject({
      status: "approved",
    });

    const widened = service(config.modelDescriptors, ["exa-public", "deepseek"]);
    expect(await read(widened)).toMatchObject({
      payload: { enabled: false, providersChanged: true, revision: 1 },
    });
    await widened.set(
      commandMessage(
        ui,
        "search.authorization.set",
        {
          enabled: false,
          expectedRevision: 1,
          recipients: ["https://mcp.exa.ai", "https://api.deepseek.com"],
        },
        { authorizationRef: ui.authorizationRef, idempotencyKey: "owner-off", risk: "high" },
      ),
      SERVICE_AUTHORITY.lease,
    );
    expect(await read(widened)).toMatchObject({
      payload: { enabled: false, providersChanged: false, revision: 2 },
    });
    expect(await read(before)).toMatchObject({
      payload: { enabled: false, providersChanged: false, revision: 2 },
    });
    await before.authorize(intent("after-owner-off", primary));
    expect(await store.findApprovalByIntent("after-owner-off")).toBeUndefined();
  } finally {
    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  }
});
