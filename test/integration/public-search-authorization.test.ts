import { readFile, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { resolveSandboxActionGrant, type GovernedActionIntent } from "@himawari-agent/application";
import { createIdempotencyKey } from "@himawari-agent/domain";
import { PublicSearchAuthorization } from "../../apps/agent-service/src/public-search-authorization.js";
import { configuredModelDisclosureIdentity } from "../../apps/agent-service/src/production-model-disclosure.js";
import { commandMessage, queryMessage } from "../../apps/control-center/src/messages.js";
import {
  AGENT_ID,
  OWNER_ID,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
  openRepository,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

it("persists explicit search policy, derives exact grants and rejects use after revocation", async () => {
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
    grantId: "directory",
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
      { type: "directory-grant", ref: route.grantId },
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
      identity: { ownerId: OWNER_ID, agentId: AGENT_ID, runId: RUN_ID, threadId: intent.threadId },
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
});
