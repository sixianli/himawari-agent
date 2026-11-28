import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AuthorityFence,
  type GovernedActionIntent,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type ProductConfiguration,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

import { configuredModelDisclosureIdentity } from "../src/production-model-disclosure.js";
import {
  type CodingNetworkFacts,
  WorkspaceAutoAuthorization,
} from "../src/workspace-auto-authorization.js";

const OWNER_ID = "owner-workspace-auto" as GovernedActionIntent["ownerId"];
const AGENT_ID = "agent-workspace-auto" as GovernedActionIntent["agentId"];
const RUN_ID = "run-workspace-auto" as GovernedActionIntent["runId"];
const THREAD_ID = "thread-workspace-auto";
const DEPLOYMENT_ID = "deployment-workspace-auto" as ProductConfiguration["deploymentId"];
const LEASE_ID = "lease-workspace-auto" as AuthorityFence["leaseId"];
const INPUT_REF = "payload-workspace-auto-input";
const GRANT_ID = "directory:workspace-auto";
const HOST_ID = "host-workspace-auto";
const CAPABILITY_REF = "himawari.pi-coding";
const CAPABILITY_VERSION = "1.0.0";
const DISPLAY_PATH = "/srv/workspace-auto";
const WALL_NOW = Date.now();
const NOW = new Date(WALL_NOW + 30_000).toISOString();
const EXPIRES_AT = new Date(WALL_NOW + 600_000).toISOString();
const AUTHORITY: AuthorityFence = { leaseId: LEASE_ID, fencingToken: 1 };
const PRODUCT_AUTHORITY = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
} as const;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = {
  ref: "model-workspace-auto",
  role: "primary" as const,
  provider: "deterministic",
  model: "fixture",
  version: "1",
  allowedDataClassifications: ["private"] as const,
  disclosure: "local_only" as const,
  secretRef: null,
  capabilities: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  priority: 1,
  name: "Fixture",
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text"] as const,
  contextWindow: 8192,
  maxTokens: 1024,
};
const MODEL_IDENTITY = configuredModelDisclosureIdentity(
  MODEL as unknown as ProductConfiguration["modelDescriptors"][number],
);

const OFFLINE_NETWORK: CodingNetworkFacts = {
  allowedDomains: [],
  operationNetwork: { bash: "disabled" },
};

function codingRoute(approval?: "workspace_auto" | "ask") {
  return {
    hostId: HOST_ID,
    workerInstanceId: "worker-workspace-auto",
    grantId: GRANT_ID,
    capabilityRef: CAPABILITY_REF,
    capabilityVersion: CAPABILITY_VERSION,
    maximumBytes: 49152,
    enabledTools: ["read", "ls", "find", "grep", "write", "edit", "bash"] as const,
    ...(approval === undefined ? {} : { approval }),
  };
}

function configuration(
  approval?: "workspace_auto" | "ask",
): Pick<ProductConfiguration, "ownerId" | "agentId" | "modelDescriptors" | "runPolicy"> {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    modelDescriptors: [MODEL as unknown as ProductConfiguration["modelDescriptors"][number]],
    runPolicy: {
      version: "workspace-auto-v1",
      systemInstruction: "fixture",
      memoryLimit: 1,
      coding: codingRoute(approval),
    },
  };
}

function directoryGrant(overrides: Partial<HostDirectoryGrant> = {}): HostDirectoryGrant {
  return {
    id: GRANT_ID,
    revision: 1,
    hostId: HOST_ID,
    canonicalRootId: "1:2",
    displayPath: DISPLAY_PATH,
    operations: ["read", "create", "update"],
    dataClassification: "private",
    disclosure: "model",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "grant:workspace-auto-directory",
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    ...overrides,
  };
}

function intent(overrides: Partial<GovernedActionIntent> = {}): GovernedActionIntent {
  const operation = overrides.operation ?? "write";
  const readOnly = ["read", "ls", "find", "grep"].includes(operation);
  const actionKind =
    overrides.actionKind ??
    (operation === "bash" ? "INSTALL_OR_EXECUTE_CODE" : readOnly ? "READ" : "CREATE_OR_UPDATE");
  const resourceRef = `coding:${operation}:workspace-auto`;
  return {
    contractVersion: "authorization.v2",
    id: resourceRef,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    capabilityRef: CAPABILITY_REF,
    capabilityVersion: CAPABILITY_VERSION,
    operation,
    resourceRef,
    resourceRefs: [resourceRef],
    targets: [
      { type: "host", ref: HOST_ID },
      { type: "directory-grant", ref: GRANT_ID },
      { type: "directory-path", ref: DISPLAY_PATH },
      { type: "tool", ref: operation },
      { type: "input-digest", ref: "input-workspace-auto" },
      { type: "model", ref: MODEL_IDENTITY },
      { type: "file-path", ref: "note.txt" },
    ],
    dataClassification: "private",
    sideEffect: operation === "bash" ? "irreversible" : readOnly ? "none" : "reversible",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: resourceRef as GovernedActionIntent["idempotencyKey"],
    reversible: operation !== "bash",
    requestedAt: NOW,
    expiresAt: EXPIRES_AT,
    actionKind,
    disclosure: "named_recipients",
    recipients: [MODEL_IDENTITY],
    credentialOrAccessChange: false,
    modelClassification: {
      actionKind,
      suggestedRisk: "HIGH",
      reasonCode: "product_governed_coding",
    },
    deterministicFacts: [
      { code: "external_model_disclosure", minimumRisk: "HIGH", source: "product" },
    ],
    finalRisk: "HIGH",
    ...overrides,
  };
}

async function fixture(options: {
  readonly approval?: "workspace_auto" | "ask";
  readonly network?: CodingNetworkFacts;
  readonly grant?: HostDirectoryGrant;
}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-workspace-auto-"));
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  applyMigrations(database, migrations);
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
       VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
         fencing_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, 'holder-workspace-auto', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(
      hostDirectoryGrantStateKey(GRANT_ID),
      OWNER_ID,
      AGENT_ID,
      JSON.stringify(options.grant ?? directoryGrant()),
      NOW,
    );
  database.close();

  let repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
  cleanups.push(async () => {
    await repository.close();
    await rm(stateRoot, { recursive: true });
  });

  await repository.payloadStore(OWNER_ID, AGENT_ID).put(
    await new EnvelopePayloadProtector({
      keys: new InMemoryDevelopmentSecretSource({ "workspace-kek@v1": new Uint8Array(32).fill(7) }),
      activeKey: { keyRef: "workspace-kek", kekVersion: "v1", dekVersion: "dek-v1" },
    }).protect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ref: INPUT_REF,
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("workspace auto fixture input"),
      createdAt: NOW,
    }),
  );
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock: { now: () => NOW },
    authority: () => PRODUCT_AUTHORITY,
  });
  const thread = await commands.create({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID as NonNullable<Parameters<ThreadCommandService["create"]>[0]["threadId"]>,
    idempotencyKey: "workspace-auto-thread",
    resultRef: INPUT_REF,
  });
  await commands.admitOwnerMessage({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: thread.thread.id,
    expectedThreadRevision: thread.thread.revision,
    sessionId: "session-workspace-auto" as Parameters<
      ThreadCommandService["admitOwnerMessage"]
    >[0]["sessionId"],
    runId: RUN_ID,
    idempotencyKey: "workspace-auto-message",
    contentRef: INPUT_REF,
    sourceProofRef: "fixture-owner",
    dataClassification: "private",
    resultRef: INPUT_REF,
  });
  await repository.close();
  repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });

  let counter = 0;
  const ids = { next: (scope: string) => `${scope}:${++counter}` };
  const workspaceAuto = new WorkspaceAutoAuthorization({
    configuration: configuration(options.approval),
    repository,
    clock: { now: () => NOW },
    ids,
    network: options.network ?? OFFLINE_NETWORK,
  });
  const store = repository.authorizationStore();
  return { repository, workspaceAuto, store };
}

async function readState(repository: SqliteProductStateRepository) {
  const key = `workspace-authorization:${createHash("sha256")
    .update(JSON.stringify([OWNER_ID, AGENT_ID]))
    .digest("hex")}`;
  return repository.readScopedState(OWNER_ID, AGENT_ID, key);
}

async function policyApprovals(
  store: ReturnType<SqliteProductStateRepository["authorizationStore"]>,
) {
  return (await store.listApprovals(OWNER_ID, AGENT_ID)).filter(
    (approval) => approval.policyAuthorization !== undefined,
  );
}

describe("[R2-T2] workspace auto authorization", { timeout: 30_000 }, () => {
  it("[R2-T2] enables the policy by default and records the enabled audit", async () => {
    const { workspaceAuto, store, repository } = await fixture({});
    await workspaceAuto.sync(AUTHORITY);
    const state = await readState(repository);
    expect(state?.value["enabled"]).toBe(true);
    const audits = await repository.auditLedger().listByAgent(AGENT_ID, null);
    expect(audits.map((record) => record.action)).toContain("workspace.authorization.enabled");
    expect(await store.listGrants(OWNER_ID, AGENT_ID)).toHaveLength(0);
  });

  it("[R2-T2] keeps the policy enabled for an explicit workspace_auto and revokes it for ask", async () => {
    const enabled = await fixture({ approval: "workspace_auto" });
    await enabled.workspaceAuto.sync(AUTHORITY);
    expect((await readState(enabled.repository))?.value["enabled"]).toBe(true);

    const asking = await fixture({ approval: "ask" });
    await asking.workspaceAuto.sync(AUTHORITY);
    expect((await readState(asking.repository))?.value["enabled"]).toBe(false);
    const audits = await asking.repository.auditLedger().listByAgent(AGENT_ID, null);
    expect(audits.map((record) => record.action)).toContain("workspace.authorization.revoked");
  });

  it("[R2-T2] bumps the state revision when the configuration switches to ask and is idempotent otherwise", async () => {
    const auto = await fixture({ approval: "workspace_auto" });
    await auto.workspaceAuto.sync(AUTHORITY);
    const first = await readState(auto.repository);
    await auto.workspaceAuto.sync(AUTHORITY);
    const again = await readState(auto.repository);
    expect(again?.revision).toBe(first?.revision);

    await workspaceSwitchToAsk(auto, "ask");
    const after = await readState(auto.repository);
    expect(after?.value["enabled"]).toBe(false);
    expect(after?.revision).toBe((first?.revision ?? 0) + 1);
  });

  it.each(["read", "ls", "find", "grep", "write", "edit", "bash"])(
    "[R2-T2] approves %s inside the granted directory with an exact one-time grant",
    async (operation) => {
      const { workspaceAuto, store } = await fixture({});
      await workspaceAuto.sync(AUTHORITY);
      const action = intent({ operation });
      await workspaceAuto.authorize(action);
      const approvals = await policyApprovals(store);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe("approved");
      expect(approvals[0]?.policyAuthorization).toMatchObject({ revision: 1 });
      const grants = await store.listGrants(OWNER_ID, AGENT_ID);
      expect(grants).toHaveLength(1);
      const grant = grants[0];
      expect(grant?.kind).toBe("one_time");
      expect(grant?.maxUses).toBe(1);
      expect(grant?.scope).toMatchObject({
        capabilityRef: CAPABILITY_REF,
        capabilityVersion: CAPABILITY_VERSION,
        operations: [operation],
        exactResourceRef: action.resourceRef,
        resourceIdentities: [...action.resourceRefs],
        resourcePrefixes: [],
        maxDataClassification: "private",
        sideEffects: [action.sideEffect],
        maxCostMicrosPerUse: 0,
        disclosure: "named_recipients",
        recipients: [MODEL_IDENTITY],
        credentialOrAccessChange: false,
      });
    },
  );

  it("[R2-T2] records the applied-policy audit with the approval id", async () => {
    const { workspaceAuto, store, repository } = await fixture({});
    await workspaceAuto.sync(AUTHORITY);
    await workspaceAuto.authorize(intent({ operation: "read" }));
    const approval = (await policyApprovals(store))[0];
    const applied = (await repository.auditLedger().listByAgent(AGENT_ID, null)).filter(
      (record) => record.action === "workspace.authorization.policy_applied",
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.targetRef).toBe(approval?.id);
  });

  it("[R2-T2] does not create a second approval or grant for a repeated intent", async () => {
    const { workspaceAuto, store } = await fixture({});
    await workspaceAuto.sync(AUTHORITY);
    const action = intent({ operation: "write" });
    await workspaceAuto.authorize(action);
    await workspaceAuto.authorize(action);
    expect(await policyApprovals(store)).toHaveLength(1);
    expect(await store.listGrants(OWNER_ID, AGENT_ID)).toHaveLength(1);
  });

  it("[R2-T2] never overrides a pending or denied human approval", async () => {
    for (const status of ["pending", "denied"] as const) {
      const { workspaceAuto, store } = await fixture({});
      await workspaceAuto.sync(AUTHORITY);
      const action = intent({ operation: "read" });
      const created = await store.createApproval({
        id: `human:${status}`,
        revision: 1,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        intentId: action.id,
        intentSnapshot: action,
        semanticSnapshotHash: "human-snapshot",
        status,
        deliveryState: "deliverable",
        requestedAt: NOW,
        expiresAt: EXPIRES_AT,
        decidedAt: status === "denied" ? NOW : null,
        grantId: null,
      });
      await workspaceAuto.authorize(action);
      const existing = await store.getApproval(created.id);
      expect(existing?.status).toBe(status);
      expect(existing?.revision).toBe(1);
      expect(existing?.policyAuthorization).toBeUndefined();
      expect(await store.listGrants(OWNER_ID, AGENT_ID)).toHaveLength(0);
    }
  });

  it("[R2-T2] stays silent when the policy state is absent, disabled, or bound to other facts", async () => {
    const absent = await fixture({});
    await absent.workspaceAuto.authorize(intent({ operation: "read" }));
    expect(await policyApprovals(absent.store)).toHaveLength(0);

    const disabled = await fixture({ approval: "ask" });
    await disabled.workspaceAuto.sync(AUTHORITY);
    await disabled.workspaceAuto.authorize(intent({ operation: "read" }));
    expect(await policyApprovals(disabled.store)).toHaveLength(0);

    const rebound = await fixture({});
    await rebound.workspaceAuto.sync(AUTHORITY);
    const otherNetwork = new WorkspaceAutoAuthorization({
      configuration: configuration(),
      repository: rebound.repository,
      clock: { now: () => NOW },
      ids: { next: (scope: string) => `${scope}:x` },
      network: { allowedDomains: ["example.com:443"], operationNetwork: { bash: "disabled" } },
    });
    await otherNetwork.authorize(intent({ operation: "read" }));
    expect(await policyApprovals(rebound.store)).toHaveLength(0);
  });

  const negatives: Array<[string, Partial<GovernedActionIntent>]> = [
    ["capability ref", { capabilityRef: "other.capability" }],
    ["capability version", { capabilityVersion: "9.9.9" }],
    ["operation outside the seven", { operation: "move_directory" }],
    ["delete action kind", { operation: "write", actionKind: "DELETE" }],
    ["a password or key classification", { dataClassification: "restricted" }],
    ["credential change", { credentialOrAccessChange: true }],
    ["nonzero estimated cost", { estimatedCostMicros: 5 }],
    ["an extra recipient", { recipients: [MODEL_IDENTITY, "model:other"] }],
    ["an unknown recipient", { recipients: ["model:other"] }],
    ["no directory-grant target", { targets: [{ type: "host", ref: HOST_ID }] }],
    [
      "a different directory grant",
      {
        targets: [
          { type: "host", ref: HOST_ID },
          { type: "directory-grant", ref: "directory:other" },
        ],
      },
    ],
  ];
  it.each(negatives)("[R2-T2] stays silent for %s", async (_label, overrides) => {
    const { workspaceAuto, store } = await fixture({});
    await workspaceAuto.sync(AUTHORITY);
    await workspaceAuto.authorize(intent(overrides));
    expect(await policyApprovals(store)).toHaveLength(0);
    expect(await store.listGrants(OWNER_ID, AGENT_ID)).toHaveLength(0);
  });

  const unusableGrants: ReadonlyArray<readonly [string, HostDirectoryGrant]> = [
    ["revoked", directoryGrant({ revokedAt: NOW })],
    ["expired", directoryGrant({ expiresAt: new Date(WALL_NOW - 1000).toISOString() })],
    ["read only", directoryGrant({ operations: ["read"] })],
    ["restricted", directoryGrant({ dataClassification: "restricted" })],
    [
      "an unknown path policy",
      directoryGrant({
        pathPolicy: "same_filesystem" as unknown as HostDirectoryGrant["pathPolicy"],
      }),
    ],
  ];
  it.each(unusableGrants)(
    "[R2-T2] stays silent when the directory grant is %s",
    async (_label, grant) => {
      const { workspaceAuto, store } = await fixture({ grant });
      await workspaceAuto.sync(AUTHORITY);
      await workspaceAuto.authorize(intent({ operation: "write" }));
      expect(await policyApprovals(store)).toHaveLength(0);
    },
  );

  it("[R2-T2] asks for a network-capable bash and approves only an offline one", async () => {
    const online = await fixture({
      network: { allowedDomains: ["example.com:443"], operationNetwork: { bash: "disabled" } },
    });
    await online.workspaceAuto.sync(AUTHORITY);
    await online.workspaceAuto.authorize(intent({ operation: "bash" }));
    expect(await policyApprovals(online.store)).toHaveLength(0);

    const grantTargets = await fixture({
      network: { allowedDomains: [], operationNetwork: { bash: "grant_targets" } },
    });
    await grantTargets.workspaceAuto.sync(AUTHORITY);
    await grantTargets.workspaceAuto.authorize(intent({ operation: "bash" }));
    expect(await policyApprovals(grantTargets.store)).toHaveLength(0);

    const undeclared = await fixture({
      network: { allowedDomains: [], operationNetwork: {} },
    });
    await undeclared.workspaceAuto.sync(AUTHORITY);
    await undeclared.workspaceAuto.authorize(intent({ operation: "bash" }));
    expect(await policyApprovals(undeclared.store)).toHaveLength(0);

    const offline = await fixture({ network: OFFLINE_NETWORK });
    await offline.workspaceAuto.sync(AUTHORITY);
    await offline.workspaceAuto.authorize(intent({ operation: "bash" }));
    expect(await policyApprovals(offline.store)).toHaveLength(1);
  });
});

async function workspaceSwitchToAsk(
  current: { readonly repository: SqliteProductStateRepository },
  approval: "ask",
) {
  const switched = new WorkspaceAutoAuthorization({
    configuration: configuration(approval),
    repository: current.repository,
    clock: { now: () => NOW },
    ids: { next: (scope: string) => `${scope}:switch` },
    network: OFFLINE_NETWORK,
  });
  await switched.sync(AUTHORITY);
}
