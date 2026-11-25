import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AuthorityFence,
  ProductConfiguration,
  ThreadCreateInput,
} from "@himawari-agent/application";
import {
  actionIntentFingerprint,
  DEVICE_HARD_LIMIT_KEYS,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  MCP_CONNECTION_MAXIMUM,
} from "@himawari-agent/application";
import { DEVICE_LIMIT_KEYS, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  devicePairingNumber,
  type HostProviderSecretSource,
  type HostSecretMaterialSource,
  initializeStateRoot,
  parseProductConfiguration,
} from "@himawari-agent/platform-node";
import { exportJWK, importJWK, type JSONWebKeySet, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProductionHttpComposition,
  type ProductionHttpCompositionSecretSources,
  ProductionThreadGatewayAccessPolicy,
  resolveDevicePairingAccess,
} from "../src/production-http-composition.js";
import {
  mcpConnectionSecretDigest,
  newMcpConnectionSecret,
} from "../src/production-mcp-connections.js";
import {
  MCP_READ_BODY_LIMIT,
  MCP_READ_PATH,
  ProductionMcpRead,
  type ProductionMcpReadOptions,
} from "../src/production-mcp-read.js";
import { buildDeviceTestRequest, generateDeviceTestKeyPair } from "@himawari-agent/testing";
import { createMcpAccess } from "./fixtures/mcp-access.js";
import { productionHttpRs256TestKeys } from "./fixtures/production-http-rs256.test-key.js";

const ORIGIN = "https://agent.example.test";
const ISSUER = "https://team.cloudflareaccess.com";
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUDIENCE = "access-audience-production-fixture";
const NOW = new Date("2026-09-04T00:00:00.000Z");
const OWNER_ID = "owner-production-http";
const AGENT_ID = "agent-production-http";
const DEPLOYMENT_ID = "deployment-production-http";
type ProductAuthorityFence = ThreadCreateInput["authority"];
const AUTHORITY = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 2,
  fencingToken: 7,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-production-http-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const layout = await initializeStateRoot(stateRoot);
  const staticRoot = path.join(root, "browser");
  await mkdir(staticRoot);
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>Himawari</title>");
  const databasePath = path.join(layout.data, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', ?, ?)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID, AUTHORITY.authorityEpoch, AUTHORITY.fencingToken);
  database.close();
  return { stateRoot, staticRoot, databasePath };
}

function rawConfiguration(paths: Awaited<ReturnType<typeof fixture>>): Record<string, unknown> {
  return {
    schemaVersion: "himawari.configuration.v1",
    deploymentId: DEPLOYMENT_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    stateRoot: paths.stateRoot,
    runtimeDirectory: path.join(paths.stateRoot, "runtime"),
    cacheDirectory: path.join(paths.stateRoot, "cache"),
    publicOrigin: ORIGIN,
    publicMode: true,
    http: {
      listenHost: "127.0.0.1",
      listenPort: 8787,
      staticRoot: paths.staticRoot,
      sessionCookieName: "himawari_session",
      maximumBodyBytes: 256 * 1024,
      maximumStaticAssetBytes: 8 * 1024 * 1024,
      heartbeatMilliseconds: 15_000,
    },
    identity: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      jwksCacheMilliseconds: 300_000,
      jwksTimeoutMilliseconds: 2_000,
      jwksMaximumBodyBytes: 65_536,
      clockToleranceSeconds: 30,
      identityLookupTimeoutMilliseconds: 2_000,
      identityLookupMaximumBodyBytes: 65_536,
      recentAuthentication: {
        maximumAgeMilliseconds: 900_000,
        clockSkewMilliseconds: 30_000,
      },
      bootstrap: {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecretRef: "identity-bootstrap",
      },
      csrf: {
        keySecretRef: "identity-csrf",
        ttlMilliseconds: 1_800_000,
      },
    },
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "deterministic",
        model: "deterministic-primary",
        version: "v1",
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        priority: 1,
        name: "Production HTTP fixture primary",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "deterministic",
        model: "deterministic-embedding",
        version: "v1",
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "local_only",
        secretRef: null,
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 1536,
      },
    ],
    memory: {
      adapter: "himawari-sqlite",
      version: "3.3.1",
      storagePath: path.join(paths.stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
    ],
    concurrency: { totalRuns: 4, foregroundReserved: 1, perCategory: { foreground: 2 } },
    deadlines: { runMs: 60_000, workerRequestMs: 5_000, providerRequestMs: 5_000 },
  };
}

function configuration(paths: Awaited<ReturnType<typeof fixture>>): ProductConfiguration {
  return parseProductConfiguration(rawConfiguration(paths), NOW.toISOString());
}

function secretSources(): ProductionHttpCompositionSecretSources {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const keys: HostSecretMaterialSource = {
    kind: "restricted-secret-file",
    productionSuitable: true,
    async resolve() {
      return new Uint8Array(key);
    },
  };
  const provider: HostProviderSecretSource = {
    kind: "restricted-secret-file",
    productionSuitable: true,
    async resolve() {
      return "bootstrap-token-production-fixture";
    },
  };
  return { provider, keys };
}

function authority(configurationValue: ProductConfiguration): ProductAuthorityFence {
  return {
    deploymentId: configurationValue.deploymentId,
    authorityEpoch: AUTHORITY.authorityEpoch,
    fencingToken: AUTHORITY.fencingToken,
  };
}

function requestHeaders(token: string, cookie: string, csrf?: string) {
  return {
    host: "agent.example.test",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "cf-access-jwt-assertion": token,
    cookie,
    ...(csrf === undefined ? {} : { "x-csrf-token": csrf }),
  };
}

function envelope(kind: "command" | "query", type: string) {
  return {
    schemaVersion: "gateway.thread.v3" as const,
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: `correlation:${type}`,
    causationId: null,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: AUTHORITY,
    actor: { actorType: "owner" as const, actorId: OWNER_ID },
  };
}

describe("production HTTP composition", () => {
  it("[R2-D22] authenticates an RS256 assertion, admits a durable Thread run, and replays after restart", async () => {
    const paths = await fixture();
    const keyPair = {
      privateKey: await importJWK(productionHttpRs256TestKeys.privateKey, "RS256"),
      publicKey: await importJWK(productionHttpRs256TestKeys.publicKey, "RS256"),
    };
    const jwks: JSONWebKeySet = {
      keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "key-production-http", alg: "RS256" }],
    };
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-production-http" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("subject-production-http")
      .setIssuedAt(Math.floor(NOW.valueOf() / 1000))
      .setExpirationTime(Math.floor(NOW.valueOf() / 1000) + 300)
      .sign(keyPair.privateKey);
    let identityLookupAvailable = true;
    const identityFetcher = {
      async fetch(input: { readonly url: URL; readonly assertionToken: string }) {
        expect(input.url.href).toBe(`${ISSUER}/cdn-cgi/access/get-identity`);
        expect(input.assertionToken).toBe(token);
        if (!identityLookupAvailable) {
          throw new Error("identity lookup unavailable in controlled fixture");
        }
        return {
          user_uuid: "subject-production-http",
          iat: Math.floor(NOW.valueOf() / 1000),
        };
      },
    };
    const jwksFetcher = {
      async fetch(url: URL) {
        expect(url.href).toBe(JWKS_URL);
        return jwks;
      },
    };
    const config = configuration(paths);
    const configAuthority = authority(config);
    let repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    const acceptedCommandPaths: string[] = [];
    let composition = await createProductionHttpComposition({
      configuration: config,
      repository,
      authority: () => configAuthority,
      secretSources: secretSources(),
      jwksFetcher,
      identityFetcher,
      now: () => new Date(NOW),
      createSessionToken: () => "session-token-production-http",
      onCommandAccepted: (path) => acceptedCommandPaths.push(path),
      executionEnvironment: {
        mode: "strict",
        unavailableTools: async () => [
          { toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" },
        ],
      },
    });
    try {
      const bootstrap = await composition.app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: { host: "agent.example.test" },
        payload: {
          token: "bootstrap-token-production-fixture",
          ownerId: OWNER_ID,
          assertionToken: token,
        },
      });
      expect(bootstrap.statusCode).toBe(201);
      const mcpRead = await composition.app.inject({
        method: "POST",
        url: MCP_READ_PATH,
        headers: {
          host: "agent.example.test",
          authorization: ["Bearer", "m".repeat(40)].join(" "),
          "content-type": "application/json",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(mcpRead.statusCode).toBe(404);

      const session = await composition.app.inject({
        method: "POST",
        url: "/api/identity/v1/sessions",
        headers: requestHeaders(token, "", undefined),
        payload: { deviceLabel: "production HTTP fixture" },
      });
      expect(session.statusCode).toBe(201);
      const cookieHeader = session.headers["set-cookie"];
      expect(cookieHeader).toContain("himawari_session=session-token-production-http");
      const cookie = "himawari_session=session-token-production-http";
      const sessionBody = session.json() as {
        readonly session: { readonly authenticationRef: string; readonly id: string };
      };

      const configResponse = await composition.app.inject({
        method: "GET",
        url: "/api/control-center/v1/config",
        headers: requestHeaders(token, cookie),
      });
      expect(configResponse.statusCode).toBe(200);
      expect(configResponse.json()).toMatchObject({
        executionEnvironmentAvailable: true,
        installedGatewayV2Operations: [
          "approval.list",
          "approval.detail",
          "approval.respond",
          "approval.allowance.set",
          "search.authorization.read",
          "search.authorization.set",
          "push.status.read",
          "push.subscription.set",
          "push.kind.set",
          "push.test",
          "presence.heartbeat",
          "push.feedback.record",
          "owner.preferences.read",
          "owner.preferences.set",
          "proposals.read",
          "proposal.respond",
          "sensitive.interceptions.read",
          "sensitive.interceptions.clear",
          "server.status.read",
          "capability.list",
          "capability.detail",
          "capability.disable",
          "device.list.read",
          "device.pairing.start",
          "device.pairing.confirm",
          "device.rename",
          "device.revoke",
          "home.read",
          "data.export.start",
          "data.export.cancel",
          "data.export.status.read",
          "files.list.read",
          "login.devices.read",
          "login.device.revoke",
          "login.devices.revoke_others",
          "perception.status.read",
          "perception.day.read",
          "perception.episode.read",
          "perception.usage.read",
          "perception.settings.change",
          "think.settings.read",
          "think.settings.change",
        ],
        healthDependenciesAvailable: true,
      });
      const healthResponse = await composition.app.inject({
        method: "GET",
        url: "/api/health/v1/dependencies",
        headers: requestHeaders(token, cookie),
      });
      expect(healthResponse.statusCode).toBe(200);
      expect(healthResponse.json()).toMatchObject({
        dependencies: expect.arrayContaining([expect.objectContaining({ name: "sqlite" })]),
      });
      const browserConfig = configResponse.json() as {
        readonly csrfToken: string;
        readonly sessionId: string;
        readonly recentAuthenticationRef: string;
      };
      expect(browserConfig.recentAuthenticationRef).toBe(sessionBody.session.authenticationRef);
      expect(browserConfig.sessionId).toBe(sessionBody.session.id);
      const concurrentConfigurations = await Promise.all(
        Array.from({ length: 12 }, () =>
          composition.app.inject({
            method: "GET",
            url: "/api/control-center/v1/config",
            headers: requestHeaders(token, cookie),
          }),
        ),
      );
      expect(concurrentConfigurations.map((response) => response.statusCode)).toEqual(
        Array(12).fill(200),
      );

      const csrfRejected = await composition.app.inject({
        method: "POST",
        url: "/api/payload/v1/text",
        headers: {
          ...requestHeaders(token, cookie),
          "idempotency-key": "payload-csrf-rejected",
        },
        payload: { content: "must not persist", dataClassification: "private" },
      });
      expect(csrfRejected.statusCode).toBe(403);

      async function upload(idempotencyKey: string, content: string) {
        const response = await composition.app.inject({
          method: "POST",
          url: "/api/payload/v1/text",
          headers: {
            ...requestHeaders(token, cookie, browserConfig.csrfToken),
            "idempotency-key": idempotencyKey,
          },
          payload: { content, dataClassification: "private" },
        });
        expect(response.statusCode).toBe(201);
        return (response.json() as { readonly payloadRef: string }).payloadRef;
      }

      const createResultRef = await upload("payload-create-result", "create-result");
      expect(await upload("payload-create-result", "create-result")).toBe(createResultRef);
      const conflictingUpload = await composition.app.inject({
        method: "POST",
        url: "/api/payload/v1/text",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": "payload-create-result",
        },
        payload: { content: "different-content", dataClassification: "private" },
      });
      expect(conflictingUpload.statusCode).toBe(409);
      const createCommand = {
        ...envelope("command", "thread.create"),
        idempotencyKey: "thread-create-production-http",
        payload: {
          threadId: "thread-production-http",
          answerLocale: "zh-CN" as const,
          resultRef: createResultRef,
        },
      };
      const created = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": createCommand.idempotencyKey,
        },
        payload: createCommand,
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        type: "thread.command_result",
        payload: { threadRevision: 1, replayed: false },
      });

      const submitResultRef = await upload("payload-submit-result", "submit-result");
      const contentRef = await upload("payload-submit-content", "hello from the owner");
      const submitCommand = {
        ...envelope("command", "thread.message.submit"),
        messageId: "message:production-http-submit",
        correlationId: "correlation:production-http-submit",
        idempotencyKey: "thread-submit-production-http",
        payload: {
          threadId: "thread-production-http",
          expectedRevision: 1,
          messageId: "message:production-http-owner",
          turnId: "turn:production-http-owner",
          runId: "run:production-http-owner",
          sessionId: sessionBody.session.id,
          contentRef,
          sourceProofRef: "proof:production-http-fixture",
          dataClassification: "private" as const,
          occurredAt: NOW.toISOString(),
          resultRef: submitResultRef,
        },
      };
      const crossSession = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": "thread-submit-cross-session",
        },
        payload: {
          ...submitCommand,
          messageId: "message:production-http-cross-session",
          correlationId: "correlation:production-http-cross-session",
          idempotencyKey: "thread-submit-cross-session",
          payload: { ...submitCommand.payload, sessionId: "session:other" },
        },
      });
      expect(crossSession.statusCode).toBe(403);
      expect(acceptedCommandPaths).toEqual(["/api/gateway/thread/v3/commands"]);

      const admitted = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": submitCommand.idempotencyKey,
        },
        payload: submitCommand,
      });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.json()).toMatchObject({
        type: "thread.command_result",
        payload: { threadRevision: 2, replayed: false },
      });
      expect(acceptedCommandPaths).toEqual([
        "/api/gateway/thread/v3/commands",
        "/api/gateway/thread/v3/commands",
      ]);

      const action: GovernedActionIntent = {
        contractVersion: "authorization.v2",
        id: "action-http-approval",
        ownerId: config.ownerId,
        agentId: config.agentId,
        threadId: submitCommand.payload.threadId,
        runId: submitCommand.payload.runId as GovernedActionIntent["runId"],
        capabilityRef: "test.communicate",
        capabilityVersion: "1",
        operation: "send",
        resourceRef: "recipient:test-only",
        resourceRefs: ["recipient:test-only"],
        targets: [{ type: "recipient", ref: "test-only" }],
        dataClassification: "private",
        sideEffect: "irreversible",
        estimatedCostMicros: 0,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: "http-approval-action" as GovernedActionIntent["idempotencyKey"],
        reversible: false,
        requestedAt: NOW.toISOString(),
        expiresAt: "2026-09-04T01:00:00.000Z",
        actionKind: "COMMUNICATE",
        disclosure: "named_recipients",
        recipients: ["recipient:test-only"],
        credentialOrAccessChange: false,
        modelClassification: {
          actionKind: "COMMUNICATE",
          suggestedRisk: "HIGH",
          reasonCode: "test",
        },
        deterministicFacts: [],
        finalRisk: "HIGH",
      };
      const approvalId = "approval-production-http";
      const snapshotHash = actionIntentFingerprint(action);
      const approval: GovernedApprovalRequest = {
        id: approvalId,
        revision: 1,
        ownerId: config.ownerId,
        agentId: config.agentId,
        runId: action.runId,
        intentId: action.id,
        intentSnapshot: action,
        semanticSnapshotHash: snapshotHash,
        status: "pending",
        deliveryState: "deliverable",
        requestedAt: action.requestedAt,
        expiresAt: action.expiresAt,
        decidedAt: null,
        grantId: null,
        finalRisk: "HIGH",
        recentAuthenticationRequired: false,
        recentAuthenticationRef: null,
      };
      await repository.authorizationStore().createApproval(approval);
      const approvalEnvelope = {
        schemaVersion: "gateway.v2",
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        authority: configAuthority,
        actor: { actorType: "owner", actorId: OWNER_ID },
        dataClassification: "private",
        risk: "high",
        authorizationRef: sessionBody.session.authenticationRef,
        correlationId: "correlation-approval-http",
        causationId: null,
      };
      const approvalQuery = {
        ...approvalEnvelope,
        kind: "query",
        type: "approval.detail",
        messageId: "approval-query-http",
        payload: { approvalRequestId: approvalId },
      };
      const pendingApproval = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, cookie),
        payload: approvalQuery,
      });
      expect(pendingApproval.statusCode).toBe(200);
      expect(pendingApproval.json()).toMatchObject({
        type: "approval.snapshot",
        payload: { status: "pending", intent: { actionKind: "COMMUNICATE" } },
      });
      const approvalCommand = {
        ...approvalEnvelope,
        kind: "command",
        type: "approval.respond",
        messageId: "approval-command-http",
        idempotencyKey: "approval-command-http",
        payload: {
          approvalRequestId: approvalId,
          expectedRevision: 1,
          semanticSnapshotHash: snapshotHash,
          decision: "approved",
          editedPayloadRef: null,
          recentAuthenticationRef: null,
        },
      };
      const approvalWithoutCsrf = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, cookie),
          "idempotency-key": approvalCommand.idempotencyKey,
        },
        payload: approvalCommand,
      });
      expect(approvalWithoutCsrf.statusCode).toBe(403);
      const badAuthority = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": approvalCommand.idempotencyKey,
        },
        payload: {
          ...approvalCommand,
          authority: { ...configAuthority, fencingToken: configAuthority.fencingToken + 1 },
        },
      });
      expect(badAuthority.statusCode).toBe(403);
      const approved = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": approvalCommand.idempotencyKey,
        },
        payload: approvalCommand,
      });
      expect(approved.statusCode).toBe(200);
      expect((await repository.authorizationStore().getApproval(approvalId))?.status).toBe(
        "approved",
      );
      const replayedApproval = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": approvalCommand.idempotencyKey,
        },
        payload: approvalCommand,
      });
      expect(replayedApproval.statusCode).toBe(200);
      expect(replayedApproval.json()).toMatchObject({ replayed: true });
      expect(
        await repository.authorizationStore().listGrants(config.ownerId, config.agentId),
      ).toHaveLength(1);

      const detail = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(token, cookie),
        payload: {
          ...envelope("query", "thread.detail"),
          payload: {
            threadId: "thread-production-http",
            afterSequence: 0,
            limit: 10,
          },
        },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        type: "thread.detail_snapshot",
        payload: {
          thread: { revision: 2, messageWatermark: 1 },
          runs: [{ runId: "run:production-http-owner", status: "accepted" }],
        },
      });
      const environment = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(token, cookie),
        payload: {
          ...envelope("query", "thread.execution_environment"),
          messageId: "message:production-http-environment",
          payload: {},
        },
      });
      expect(environment.statusCode).toBe(200);
      expect(environment.json()).toMatchObject({
        type: "thread.execution_environment_snapshot",
        payload: {
          environment: {
            mode: "strict",
            programs: [],
            unavailableTools: [{ toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" }],
          },
        },
      });

      identityLookupAvailable = false;
      const missingFreshnessConfig = await composition.app.inject({
        method: "GET",
        url: "/api/control-center/v1/config",
        headers: requestHeaders(token, cookie),
      });
      expect(missingFreshnessConfig.statusCode).toBe(200);
      expect(missingFreshnessConfig.json()).toMatchObject({ recentAuthenticationRef: null });

      const readWithoutFreshness = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(token, cookie),
        payload: {
          ...envelope("query", "thread.detail"),
          messageId: "message:production-http-no-freshness",
          payload: {
            threadId: "thread-production-http",
            afterSequence: 0,
            limit: 10,
          },
        },
      });
      expect(readWithoutFreshness.statusCode).toBe(200);
      expect(readWithoutFreshness.json()).toMatchObject({
        payload: { thread: { revision: 2 }, runs: [{ status: "accepted" }] },
      });

      const deleteResultRef = "payload:production-http-delete-result";
      const sensitiveDelete = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": "thread-delete-without-freshness",
        },
        payload: {
          ...envelope("command", "thread.delete_permanently"),
          messageId: "message:production-http-delete-without-freshness",
          correlationId: "correlation:production-http-delete-without-freshness",
          idempotencyKey: "thread-delete-without-freshness",
          payload: {
            threadId: "thread-production-http",
            expectedRevision: 2,
            reasonCode: "controlled-freshness-rejection",
            authorizationRef: "authorization:production-http",
            recentAuthenticationRef: sessionBody.session.authenticationRef,
            resultRef: deleteResultRef,
          },
        },
      });
      expect(sensitiveDelete.statusCode).toBe(403);
      expect(sensitiveDelete.json()).toMatchObject({ error: { code: "PORT_NOT_AUTHORITATIVE" } });

      identityLookupAvailable = true;

      await composition.close();
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        stateRoot: paths.stateRoot,
        databasePath: paths.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW.toISOString(),
      });
      const restarted = await createProductionHttpComposition({
        configuration: config,
        repository,
        authority: () => configAuthority,
        secretSources: secretSources(),
        jwksFetcher,
        identityFetcher,
        now: () => new Date(NOW),
        createSessionToken: () => "session-token-production-http-02",
      });
      composition = restarted;
      const replay = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/commands",
        headers: {
          ...requestHeaders(token, cookie, browserConfig.csrfToken),
          "idempotency-key": submitCommand.idempotencyKey,
        },
        payload: submitCommand,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        type: "thread.command_result",
        payload: { threadRevision: 2, replayed: true },
      });
      const restartedDetail = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(token, cookie),
        payload: {
          ...envelope("query", "thread.detail"),
          messageId: "message:production-http-detail-restarted",
          payload: { threadId: "thread-production-http", afterSequence: 0, limit: 10 },
        },
      });
      expect(restartedDetail.statusCode).toBe(200);
      expect(restartedDetail.json()).toMatchObject({
        payload: { thread: { revision: 2 }, runs: [{ status: "accepted" }] },
      });
      const restartedConfig = await composition.app.inject({
        method: "GET",
        url: "/api/control-center/v1/config",
        headers: requestHeaders(token, cookie),
      });
      expect(restartedConfig.json()).toMatchObject({ executionEnvironmentAvailable: false });
      const environmentNotInstalled = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(token, cookie),
        payload: {
          ...envelope("query", "thread.execution_environment"),
          messageId: "message:production-http-environment-restarted",
          payload: {},
        },
      });
      expect(environmentNotInstalled.statusCode).not.toBe(200);
      expect(JSON.stringify(environmentNotInstalled.json())).not.toContain("programs");

      const persistedSession = (
        await repository.sessionDeviceState().listSessions(config.ownerId, true)
      ).find(
        ({ authenticationRef }) => authenticationRef === sessionBody.session.authenticationRef,
      );
      expect(persistedSession?.status).toBe("active");
      if (!persistedSession) throw new Error("session fixture was not persisted");
      await repository
        .sessionDeviceState()
        .revokeSession(persistedSession.id, persistedSession.revision, NOW.toISOString());
      const revokedSession = await composition.app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(token, cookie),
        payload: {
          ...envelope("query", "thread.detail"),
          messageId: "message:production-http-revoked",
          payload: { threadId: "thread-production-http", afterSequence: 0, limit: 10 },
        },
      });
      expect(revokedSession.statusCode).toBe(401);
    } finally {
      await composition.close();
      await repository.close();
    }
  });

  it("[P5-3] serves the MCP read entry through the real composition only with a Cloudflare Access assertion", async () => {
    const paths = await fixture();
    const config = configuration(paths);
    const repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    const access = await createMcpAccess(() => new Date(NOW));
    const recorded: string[] = [];
    const scope = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
    } as unknown as ProductionMcpReadOptions["scope"];
    const owners = repository.ownerIdentityState();
    await owners.bindFirstOwner({
      ownerId: scope.ownerId,
      externalSubjectRef: await access.ownerSubjectRef(),
      boundAt: NOW.toISOString(),
    });
    const mcpRead = new ProductionMcpRead({
      scope,
      clock: { now: () => NOW.toISOString() },
      access: access.verifier,
      owners,
      timeZone: "Asia/Tokyo",
      connections: repository.mcpConnections(),
      requestTimeoutMs: 5_000,
      sources: {
        recall: async () => ({ output: {}, contentClassification: "public", memoryIds: [] }),
        embedOutsideRun: (_context, operation) => operation(),
        reminders: async () => ({ reminders: [], more: false }),
        settings: () => repository.proactive().readSettings(scope),
      },
      ledger: {
        append: async (write) => {
          recorded.push(write.reasonCode);
        },
      },
      onFailure: () => undefined,
      onSummariesFailed: () => undefined,
    });
    const composition = await createProductionHttpComposition({
      configuration: config,
      repository,
      authority: () => authority(config),
      secretSources: secretSources(),
      jwksFetcher: { fetch: async () => ({ keys: [] }) },
      identityFetcher: { fetch: async () => ({}) },
      now: () => new Date(NOW),
      mcpRead,
    });
    const secret = newMcpConnectionSecret();
    await repository.mcpConnections().create({
      ...scope,
      id: "conn-composition",
      name: "composition",
      secretSha256: mcpConnectionSecretDigest(secret),
      capabilities: ["mcp"],
      readCeiling: "private",
      pushPolicy: "ask",
      createdAt: NOW.toISOString(),
    });
    try {
      const call = (assertion?: string, url = `${MCP_READ_PATH}/${secret}`) =>
        composition.app.inject({
          method: "POST",
          url,
          headers: {
            host: "agent.example.test",
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
            ...(assertion ? { "cf-access-jwt-assertion": assertion } : {}),
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "today_context", arguments: {} },
          },
        });
      const denied = await call();
      expect(denied.statusCode).toBe(401);
      expect(recorded).toEqual([]);
      const unknown = await call(
        await access.sign(),
        `${MCP_READ_PATH}/${newMcpConnectionSecret()}`,
      );
      expect(unknown.statusCode).toBe(404);
      const bare = await call(await access.sign(), MCP_READ_PATH);
      expect(bare.body).not.toContain("2026");
      expect(recorded).toEqual([]);
      const served = await call(await access.sign());
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("2026");
      expect(recorded).toEqual(["today_context"]);
    } finally {
      await composition.close();
      await repository.close();
    }
  });

  it("[P5-B] the owner creates a connection, sees its address once, and the connection is counted", async () => {
    const paths = await fixture();
    const config = configuration(paths);
    const keyPair = {
      privateKey: await importJWK(productionHttpRs256TestKeys.privateKey, "RS256"),
      publicKey: await importJWK(productionHttpRs256TestKeys.publicKey, "RS256"),
    };
    const jwks: JSONWebKeySet = {
      keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "key-production-http", alg: "RS256" }],
    };
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-production-http" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("subject-production-http")
      .setIssuedAt(Math.floor(NOW.valueOf() / 1000))
      .setExpirationTime(Math.floor(NOW.valueOf() / 1000) + 300)
      .sign(keyPair.privateKey);
    const repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    const access = await createMcpAccess(() => new Date(NOW));
    const recorded: string[] = [];
    const scope = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
    } as unknown as ProductionMcpReadOptions["scope"];
    const mcpRead = new ProductionMcpRead({
      scope,
      clock: { now: () => NOW.toISOString() },
      access: access.verifier,
      owners: {
        readBySubject: async () =>
          ({ ownerId: scope.ownerId, status: "active" }) as unknown as Awaited<
            ReturnType<ReturnType<typeof repository.ownerIdentityState>["readBySubject"]>
          >,
      },
      timeZone: "Asia/Tokyo",
      connections: repository.mcpConnections(),
      requestTimeoutMs: 5_000,
      sources: {
        recall: async () => ({ output: {}, contentClassification: "public", memoryIds: [] }),
        embedOutsideRun: (_context, operation) => operation(),
        reminders: async () => ({ reminders: [], more: false }),
        settings: () => repository.proactive().readSettings(scope),
      },
      ledger: {
        append: async (write) => {
          recorded.push(write.subjectRef ?? "");
        },
      },
      onFailure: () => undefined,
      onSummariesFailed: () => undefined,
    });
    const composition = await createProductionHttpComposition({
      configuration: config,
      repository,
      authority: () => authority(config),
      secretSources: secretSources(),
      jwksFetcher: { fetch: async () => jwks },
      identityFetcher: {
        fetch: async () => ({
          user_uuid: "subject-production-http",
          iat: Math.floor(NOW.valueOf() / 1000),
        }),
      },
      now: () => new Date(NOW),
      createSessionToken: () => "session-token-mcp-connections",
      executionAuthority: () => ({
        leaseId: "lease-mcp-connections" as AuthorityFence["leaseId"],
        fencingToken: AUTHORITY.fencingToken,
      }),
      mcpRead,
    });
    const ownerEnvelope = (authenticationRef: string, type: string) => ({
      schemaVersion: "gateway.v2",
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority: authority(config),
      actor: { actorType: "owner", actorId: OWNER_ID },
      dataClassification: "private",
      risk: "medium",
      authorizationRef: authenticationRef,
      correlationId: `correlation-${type}`,
      causationId: null,
      messageId: `message-${type}-${Math.random()}`,
      type,
    });
    try {
      const bootstrap = await composition.app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: { host: "agent.example.test" },
        payload: {
          token: "bootstrap-token-production-fixture",
          ownerId: OWNER_ID,
          assertionToken: token,
        },
      });
      expect(bootstrap.statusCode).toBe(201);
      const session = await composition.app.inject({
        method: "POST",
        url: "/api/identity/v1/sessions",
        headers: requestHeaders(token, "", undefined),
        payload: { deviceLabel: "mcp connections fixture" },
      });
      expect(session.statusCode).toBe(201);
      const cookie = "himawari_session=session-token-mcp-connections";
      const csrf = (
        (
          await composition.app.inject({
            method: "GET",
            url: "/api/control-center/v1/config",
            headers: requestHeaders(token, cookie),
          })
        ).json() as { csrfToken: string; installedGatewayV2Operations: string[] }
      ).csrfToken;
      const authenticationRef = (session.json() as { session: { authenticationRef: string } })
        .session.authenticationRef;
      const command = (type: string, key: string, payload: Record<string, unknown>) =>
        composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/commands",
          headers: { ...requestHeaders(token, cookie, csrf), "idempotency-key": key },
          payload: {
            ...ownerEnvelope(authenticationRef, type),
            kind: "command",
            idempotencyKey: key,
            payload,
          },
        });
      const read = async () => {
        const response = await composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/queries",
          headers: requestHeaders(token, cookie),
          payload: {
            ...ownerEnvelope(authenticationRef, "mcp.connections.read"),
            kind: "query",
            payload: {},
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        const parsed = gatewayV2MessageSchema.parseJson(response.body);
        if (parsed.type !== "mcp.connections.snapshot") throw new Error(parsed.type);
        return parsed.payload;
      };
      const address = (connectionId: string, withCookie = cookie) =>
        composition.app.inject({
          method: "GET",
          url: `/api/mcp-connections/address?connectionId=${encodeURIComponent(connectionId)}`,
          headers: requestHeaders(token, withCookie),
        });
      const mcpAssertion = await access.sign();
      const mcp = (path: string) =>
        composition.app.inject({
          method: "POST",
          url: path,
          headers: {
            host: "agent.example.test",
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
            "cf-access-jwt-assertion": mcpAssertion,
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "today_context", arguments: {} },
          },
        });
      expect((await read()).connections).toEqual([]);
      const created = await command("mcp.connection.create", "mcp-create-01", {
        name: "  Claude Code  ",
        capabilities: ["mcp", "command_hooks"],
        readCeiling: "private",
        pushPolicy: "ask",
      });
      expect(created.statusCode, created.body).toBe(200);
      const connectionId = (created.json() as { resultRef: string }).resultRef;
      expect(connectionId).toMatch(/^conn-[0-9a-f]{24}$/u);
      const again = await command("mcp.connection.create", "mcp-create-01", {
        name: "  Claude Code  ",
        capabilities: ["mcp", "command_hooks"],
        readCeiling: "private",
        pushPolicy: "ask",
      });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual({ resultRef: connectionId, replayed: true });
      expect((await read()).connections).toHaveLength(1);
      expect((await read()).connections[0]?.pushPolicy).toBe("ask");
      const switched = await command("mcp.connection.change", "mcp-direct-01", {
        connectionId,
        name: null,
        capabilities: null,
        readCeiling: null,
        pushPolicy: "direct",
        status: null,
      });
      expect(switched.statusCode, switched.body).toBe(200);
      expect((await read()).connections[0]?.pushPolicy).toBe("direct");
      expect((await address(connectionId, "")).statusCode).toBe(401);
      const shown = await address(connectionId);
      expect(shown.statusCode).toBe(200);
      expect(shown.headers["cache-control"]).toBe("no-store");
      const { path: keyedPath } = shown.json() as { path: string };
      expect(keyedPath).toMatch(/^\/api\/mcp\/v1\/[A-Za-z0-9_-]{43}$/u);
      expect((await address(connectionId)).statusCode).toBe(404);
      const served = await mcp(keyedPath);
      expect(served.statusCode, served.body).toBe(200);
      expect(recorded).toEqual([`mcp-connection:${connectionId}`]);
      const snapshot = await read();
      expect(snapshot.connections).toHaveLength(1);
      expect(snapshot.connections[0]).toMatchObject({
        id: connectionId,
        name: "Claude Code",
        capabilities: ["command_hooks", "mcp"],
        status: "active",
        lastSeenAt: NOW.toISOString(),
        usage: { reads: 1, delivered: 1, empty: 0, failed: 0, modelReads: 1, autoReads: 0 },
        minute: { reads: 1, hookReads: 0 },
      });
      expect(snapshot.limits).toContainEqual({
        key: "mcp.connections",
        value: MCP_CONNECTION_MAXIMUM,
        used: 1,
      });
      expect(snapshot.limits).toContainEqual({
        key: "mcp.request.body_bytes",
        value: MCP_READ_BODY_LIMIT,
        used: null,
      });
      expect(snapshot.limits).toContainEqual({
        key: "mcp.connection.name_characters",
        value: 64,
        used: 11,
      });
      expect(JSON.stringify(snapshot)).not.toContain(keyedPath.split("/").at(-1));
      const paused = await command("mcp.connection.change", "mcp-pause-01", {
        connectionId,
        name: null,
        capabilities: null,
        readCeiling: "public",
        pushPolicy: null,
        status: "paused",
      });
      expect(paused.statusCode, paused.body).toBe(200);
      expect((await mcp(keyedPath)).statusCode).toBe(403);
      expect((await read()).connections[0]).toMatchObject({
        status: "paused",
        readCeiling: "public",
      });
      const rotated = await command("mcp.connection.rotate", "mcp-rotate-01", { connectionId });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const { path: rotatedPath } = (await address(connectionId)).json() as { path: string };
      expect(rotatedPath).not.toBe(keyedPath);
      expect((await mcp(keyedPath)).statusCode).toBe(404);
      const revoked = await command("mcp.connection.change", "mcp-revoke-01", {
        connectionId,
        name: null,
        capabilities: null,
        readCeiling: null,
        pushPolicy: null,
        status: "revoked",
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await mcp(rotatedPath)).statusCode).toBe(404);
      expect((await read()).limits).toContainEqual({
        key: "mcp.connection.name_characters",
        value: 64,
        used: 0,
      });
      expect(
        (
          await command("mcp.connection.change", "mcp-empty-01", {
            connectionId,
            name: null,
            capabilities: null,
            readCeiling: null,
            pushPolicy: null,
            status: null,
          })
        ).statusCode,
      ).not.toBe(200);
      expect(
        (await command("mcp.connection.rotate", "mcp-rotate-02", { connectionId })).statusCode,
      ).toBe(409);
      expect(
        (await command("mcp.connection.rotate", "mcp-rotate-03", { connectionId: "conn-missing" }))
          .statusCode,
      ).toBe(404);
      const twice = await Promise.all(
        [0, 1].map(() =>
          command("mcp.connection.create", "mcp-create-race", {
            name: "Codex",
            capabilities: ["mcp"],
            readCeiling: "private",
            pushPolicy: "ask",
          }),
        ),
      );
      expect(twice.map((reply) => reply.statusCode)).toEqual([200, 200]);
      const raced = twice.map((reply) => (reply.json() as { resultRef: string }).resultRef);
      expect(raced[0]).toBe(raced[1]);
      expect((await read()).connections.filter(({ id }) => id === raced[0])).toHaveLength(1);
    } finally {
      await composition.close();
      await repository.close();
    }
  });

  it("[I-16] keeps every owner setting when the model configuration changes", async () => {
    const paths = await fixture();
    const keyPair = {
      privateKey: await importJWK(productionHttpRs256TestKeys.privateKey, "RS256"),
      publicKey: await importJWK(productionHttpRs256TestKeys.publicKey, "RS256"),
    };
    const jwks: JSONWebKeySet = {
      keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "key-production-http", alg: "RS256" }],
    };
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-production-http" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("subject-production-http")
      .setIssuedAt(Math.floor(NOW.valueOf() / 1000))
      .setExpirationTime(Math.floor(NOW.valueOf() / 1000) + 300)
      .sign(keyPair.privateKey);
    const fetchers = {
      jwksFetcher: { fetch: async () => jwks },
      identityFetcher: {
        fetch: async () => ({
          user_uuid: "subject-production-http",
          iat: Math.floor(NOW.valueOf() / 1000),
        }),
      },
    };
    const before = configuration(paths);
    const changedRaw = rawConfiguration(paths);
    const changed = parseProductConfiguration(
      {
        ...changedRaw,
        modelDescriptors: (changedRaw["modelDescriptors"] as Record<string, unknown>[]).map(
          (model) =>
            model["role"] === "primary"
              ? { ...model, model: "deterministic-primary-next", maxTokens: 2048 }
              : model,
        ),
      },
      NOW.toISOString(),
    );
    const start = async (config: ProductConfiguration, sessionToken: string) => {
      const repository = await SqliteProductStateRepository.open({
        stateRoot: paths.stateRoot,
        databasePath: paths.databasePath,
        minimumFreeBytes: 0,
        now: () => NOW.toISOString(),
      });
      const composition = await createProductionHttpComposition({
        configuration: config,
        repository,
        authority: () => authority(config),
        secretSources: secretSources(),
        ...fetchers,
        now: () => new Date(NOW),
        createSessionToken: () => sessionToken,
        executionAuthority: () => ({
          leaseId: "lease-settings" as AuthorityFence["leaseId"],
          fencingToken: AUTHORITY.fencingToken,
        }),
      });
      return { repository, composition };
    };
    const ownerEnvelope = (authenticationRef: string, type: string) => ({
      schemaVersion: "gateway.v2",
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority: authority(before),
      actor: { actorType: "owner", actorId: OWNER_ID },
      dataClassification: "private",
      risk: "medium",
      authorizationRef: authenticationRef,
      correlationId: `correlation-${type}`,
      causationId: null,
      messageId: `message-${type}-${Math.random()}`,
      type,
    });
    const saved = {
      name: "Andy",
      locale: "ja",
      accent: "teal",
      theme: "light",
      modelRef: "model-primary",
      thinkingLevel: "high",
    };
    let running = await start(before, "session-token-settings-01");
    try {
      const bootstrap = await running.composition.app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: { host: "agent.example.test" },
        payload: {
          token: "bootstrap-token-production-fixture",
          ownerId: OWNER_ID,
          assertionToken: token,
        },
      });
      expect(bootstrap.statusCode).toBe(201);
      const signIn = async (cookieToken: string) => {
        const session = await running.composition.app.inject({
          method: "POST",
          url: "/api/identity/v1/sessions",
          headers: requestHeaders(token, "", undefined),
          payload: { deviceLabel: "settings fixture" },
        });
        expect(session.statusCode).toBe(201);
        const cookie = `himawari_session=${cookieToken}`;
        const config = await running.composition.app.inject({
          method: "GET",
          url: "/api/control-center/v1/config",
          headers: requestHeaders(token, cookie),
        });
        return {
          cookie,
          csrf: (config.json() as { csrfToken: string }).csrfToken,
          authenticationRef: (session.json() as { session: { authenticationRef: string } }).session
            .authenticationRef,
        };
      };
      const first = await signIn("session-token-settings-01");
      const set = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, first.cookie, first.csrf),
          "idempotency-key": "owner-preferences-settings-01",
        },
        payload: {
          ...ownerEnvelope(first.authenticationRef, "owner.preferences.set"),
          kind: "command",
          idempotencyKey: "owner-preferences-settings-01",
          payload: { ...saved, expectedRevision: 0 },
        },
      });
      expect(set.statusCode, set.body).toBe(200);
      await running.composition.close();
      await running.repository.close();
      running = await start(changed, "session-token-settings-02");
      const second = await signIn("session-token-settings-02");
      const read = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, second.cookie),
        payload: {
          ...ownerEnvelope(second.authenticationRef, "owner.preferences.read"),
          kind: "query",
          payload: {},
        },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        type: "owner.preferences.snapshot",
        payload: { ...saved, revision: 1 },
      });
      const serverStatus = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, second.cookie),
        payload: {
          ...ownerEnvelope(second.authenticationRef, "server.status.read"),
          kind: "query",
          payload: {},
        },
      });
      expect(serverStatus.statusCode, serverStatus.body).toBe(200);
      const webStatus = await running.composition.app.inject({
        method: "GET",
        url: "/api/health/v1/dependencies",
        headers: requestHeaders(token, second.cookie),
      });
      const phoneStatus = serverStatus.json() as {
        type: string;
        payload: {
          live: boolean;
          ready: boolean;
          status: string;
          dependencies: {
            name: string;
            required: boolean;
            status: string;
            reasonCode: string | null;
          }[];
        };
      };
      const webBody = webStatus.json() as typeof phoneStatus.payload;
      expect(gatewayV2MessageSchema.parseJson(serverStatus.body).type).toBe(
        "server.status.snapshot",
      );
      expect(phoneStatus.type).toBe("server.status.snapshot");
      expect(phoneStatus.payload.live).toBe(webBody.live);
      expect(phoneStatus.payload.ready).toBe(webBody.ready);
      expect(phoneStatus.payload.status).toBe(webBody.status);
      expect(phoneStatus.payload.dependencies).toEqual(
        webBody.dependencies.map(({ name, required, status, reasonCode }) => ({
          name,
          required,
          status,
          reasonCode,
        })),
      );
      const withoutSession = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, "", undefined),
        payload: {
          ...ownerEnvelope(second.authenticationRef, "server.status.read"),
          kind: "query",
          payload: {},
        },
      });
      expect(withoutSession.statusCode, withoutSession.body).toBe(401);
      const homeQuery = (cookie: string) =>
        running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/queries",
          headers: requestHeaders(token, cookie),
          payload: {
            ...ownerEnvelope(second.authenticationRef, "home.read"),
            kind: "query",
            payload: { locale: "zh-CN" },
          },
        });
      const homeResponse = await homeQuery(second.cookie);
      expect(homeResponse.statusCode, homeResponse.body).toBe(200);
      const homeSnapshot = gatewayV2MessageSchema.parseJson(homeResponse.body);
      if (homeSnapshot.type !== "home.snapshot") throw new Error(homeSnapshot.type);
      expect(homeSnapshot.payload.incompleteSources).toEqual([]);
      expect(homeSnapshot.payload.awaitingCount).toBe(
        homeSnapshot.payload.items.filter(({ awaitsOwner }) => awaitsOwner).length,
      );
      expect(await running.composition.home.awaitingCount()).toBe(
        homeSnapshot.payload.awaitingCount,
      );
      expect((await homeQuery("")).statusCode).toBe(401);
      const exportStart = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, second.cookie, second.csrf),
          "idempotency-key": "data-export-settings-01",
        },
        payload: {
          ...ownerEnvelope(second.authenticationRef, "data.export.start"),
          kind: "command",
          idempotencyKey: "data-export-settings-01",
          payload: {},
        },
      });
      expect(exportStart.statusCode, exportStart.body).toBe(200);
      const exportId = (exportStart.json() as { resultRef: string }).resultRef;
      expect(exportId).toMatch(/^data-export:[A-Za-z0-9_-]{22}$/u);
      let exported: { state: string; result: { downloadPath: string; sizeBytes: number } | null } =
        {
          state: "running",
          result: null,
        };
      for (let attempt = 0; attempt < 300 && exported.state === "running"; attempt += 1) {
        const status = await running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/queries",
          headers: requestHeaders(token, second.cookie),
          payload: {
            ...ownerEnvelope(second.authenticationRef, "data.export.status.read"),
            kind: "query",
            payload: { exportId },
          },
        });
        expect(status.statusCode, status.body).toBe(200);
        const parsed = gatewayV2MessageSchema.parseJson(status.body);
        if (parsed.type !== "data.export.status.snapshot") throw new Error("snapshot");
        exported = parsed.payload;
        if (exported.state === "running") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(exported.state).toBe("ready");
      const archive = await running.composition.app.inject({
        method: "GET",
        url: exported.result?.downloadPath ?? "",
        headers: requestHeaders(token, second.cookie),
      });
      expect(archive.statusCode).toBe(200);
      expect(archive.rawPayload.byteLength).toBe(exported.result?.sizeBytes);
      const cancelExport = (id: string, key: string) =>
        running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/commands",
          headers: { ...requestHeaders(token, second.cookie, second.csrf), "idempotency-key": key },
          payload: {
            ...ownerEnvelope(second.authenticationRef, "data.export.cancel"),
            kind: "command",
            idempotencyKey: key,
            payload: { exportId: id },
          },
        });
      expect(
        (await cancelExport("data-export:AAAAAAAAAAAAAAAAAAAAAA", "data-export-cancel-unknown"))
          .statusCode,
      ).toBe(404);
      const exportWithoutSession = await running.composition.app.inject({
        method: "GET",
        url: exported.result?.downloadPath ?? "",
        headers: requestHeaders(token, "", undefined),
      });
      expect(exportWithoutSession.statusCode).toBe(401);
      const cancelled = await cancelExport(exportId, "data-export-cancel-01");
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json()).toMatchObject({ resultRef: exportId, replayed: false });
      expect(
        (
          await running.composition.app.inject({
            method: "GET",
            url: exported.result?.downloadPath ?? "",
            headers: requestHeaders(token, second.cookie),
          })
        ).statusCode,
      ).toBe(404);
      const phoneFiles = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, second.cookie),
        payload: {
          ...ownerEnvelope(second.authenticationRef, "files.list.read"),
          kind: "query",
          payload: { kind: null, origin: null, before: null, limit: 20 },
        },
      });
      expect(phoneFiles.statusCode, phoneFiles.body).toBe(200);
      expect(gatewayV2MessageSchema.parseJson(phoneFiles.body)).toMatchObject({
        type: "files.list.snapshot",
        payload: { files: [], nextCursor: null },
      });
      const filesWithoutSession = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, "", undefined),
        payload: {
          ...ownerEnvelope(second.authenticationRef, "files.list.read"),
          kind: "query",
          payload: { kind: null, origin: null, before: null, limit: 20 },
        },
      });
      expect(filesWithoutSession.statusCode, filesWithoutSession.body).toBe(401);
      const filesWithBadCursor = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, second.cookie),
        payload: {
          ...ownerEnvelope(second.authenticationRef, "files.list.read"),
          kind: "query",
          payload: { kind: null, origin: null, before: "bm90LWEtY3Vyc29y", limit: 20 },
        },
      });
      expect(filesWithBadCursor.statusCode, filesWithBadCursor.body).toBe(400);
      const loginDevices = async () => {
        const response = await running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/queries",
          headers: requestHeaders(token, second.cookie),
          payload: {
            ...ownerEnvelope(second.authenticationRef, "login.devices.read"),
            kind: "query",
            payload: {},
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        const parsed = gatewayV2MessageSchema.parseJson(response.body);
        if (parsed.type !== "login.devices.snapshot") throw new Error(parsed.type);
        return parsed.payload.devices;
      };
      const deviceState = running.repository.sessionDeviceState();
      const latest = [...(await deviceState.listDevices(OWNER_ID as never, false))]
        .sort((left, right) => Number(left.id > right.id) - Number(left.id < right.id))
        .at(-1);
      if (!latest) throw new Error("no device");
      const { revision: latestRevision, ...latestDevice } = latest;
      await deviceState.saveDevice(
        { ...latestDevice, lastSeenAt: "2099-01-01T00:00:00.000Z" },
        latestRevision,
      );
      const before = await loginDevices();
      expect(before[0]?.deviceId).toBe(latest.id);
      expect(before.length).toBeGreaterThanOrEqual(2);
      expect(before.filter(({ current }) => current)).toHaveLength(1);
      expect(before.map(({ deviceId }) => deviceId)).toEqual(
        [...(await running.repository.sessionDeviceState().listDevices(OWNER_ID as never, false))]
          .sort((left, right) =>
            left.lastSeenAt === right.lastSeenAt
              ? Number(left.id > right.id) - Number(left.id < right.id)
              : Number(left.lastSeenAt < right.lastSeenAt) -
                Number(left.lastSeenAt > right.lastSeenAt),
          )
          .map(({ id }) => id),
      );
      const current = before.find(({ current }) => current);
      const other = before.find(({ current }) => !current);
      const revoke = (deviceId: string, recentAuthenticationRef: string | null, key: string) =>
        running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/commands",
          headers: {
            ...requestHeaders(token, second.cookie, second.csrf),
            "idempotency-key": key,
          },
          payload: {
            ...ownerEnvelope(second.authenticationRef, "login.device.revoke"),
            kind: "command",
            idempotencyKey: key,
            payload: { deviceId, recentAuthenticationRef },
          },
        });
      expect(
        (await revoke(current?.deviceId ?? "", second.authenticationRef, "revoke-self")).statusCode,
      ).toBe(409);
      expect((await revoke(other?.deviceId ?? "", null, "revoke-no-recent")).statusCode).not.toBe(
        200,
      );
      expect((await loginDevices()).length).toBe(before.length);
      const revoked = await revoke(other?.deviceId ?? "", second.authenticationRef, "revoke-other");
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await loginDevices()).map(({ deviceId }) => deviceId)).not.toContain(other?.deviceId);
      const replayed = await revoke(other?.deviceId ?? "", null, "revoke-other-again");
      expect(replayed.statusCode, replayed.body).toBe(200);
      expect(replayed.json()).toMatchObject({ replayed: true });
      expect((await revoke("device-missing", null, "revoke-missing")).statusCode).toBe(404);
      expect((await loginDevices()).find(({ current }) => current)?.deviceId).toBe(
        current?.deviceId,
      );
      for (const id of ["device-extra-1", "device-extra-2"])
        await deviceState.saveDevice(
          {
            id: id as never,
            ownerId: OWNER_ID as never,
            label: id,
            status: "active",
            firstSeenAt: "2026-11-01T00:00:00.000Z",
            lastSeenAt: "2026-11-01T00:00:00.000Z",
          },
          null,
        );
      const revokeOthers = (recentAuthenticationRef: string | null, key: string) =>
        running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/commands",
          headers: { ...requestHeaders(token, second.cookie, second.csrf), "idempotency-key": key },
          payload: {
            ...ownerEnvelope(second.authenticationRef, "login.devices.revoke_others"),
            kind: "command",
            idempotencyKey: key,
            payload: { recentAuthenticationRef },
          },
        });
      const crowded = await loginDevices();
      expect(crowded.length).toBeGreaterThanOrEqual(3);
      expect((await revokeOthers(null, "revoke-others-no-recent")).statusCode).not.toBe(200);
      expect((await loginDevices()).length).toBe(crowded.length);
      const othersCleared = await revokeOthers(second.authenticationRef, "revoke-others");
      expect(othersCleared.statusCode, othersCleared.body).toBe(200);
      expect(othersCleared.json()).toMatchObject({ replayed: false });
      expect(await loginDevices()).toEqual([
        expect.objectContaining({ deviceId: current?.deviceId, current: true }),
      ]);
      const clearedAgain = await revokeOthers(null, "revoke-others-again");
      expect(clearedAgain.statusCode, clearedAgain.body).toBe(200);
      expect(clearedAgain.json()).toMatchObject({ replayed: true });
      const readInterceptions = async () => {
        const response = await running.composition.app.inject({
          method: "POST",
          url: "/api/gateway/v2/queries",
          headers: requestHeaders(token, second.cookie),
          payload: {
            ...ownerEnvelope(second.authenticationRef, "sensitive.interceptions.read"),
            kind: "query",
            payload: { before: null },
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(String(response.headers["cache-control"])).toContain("no-store");
        return response.json() as {
          type: string;
          payload: { counts: unknown; items: Record<string, unknown>[]; next: unknown };
        };
      };
      expect((await readInterceptions()).payload).toMatchObject({
        counts: { masked: 0, withheld: 0, notSaved: 0 },
        items: [],
        next: null,
      });
      await running.repository.sensitiveInterceptions().record({
        ownerId: configuration(paths).ownerId,
        agentId: configuration(paths).agentId,
        observations: [
          {
            threadId: null,
            source: "mail",
            purpose: "mail-judgment",
            part: "mail",
            category: "verification-code",
            ruleId: "verification-code-keyword",
            fingerprint: "f".repeat(32),
            outcome: "masked",
            occurrences: 1,
          },
        ],
        now: NOW.toISOString(),
      });
      const listed = await readInterceptions();
      expect(listed.type).toBe("sensitive.interceptions.snapshot");
      expect(listed.payload.counts).toEqual({ masked: 1, withheld: 0, notSaved: 0 });
      expect(listed.payload.items).toEqual([
        expect.objectContaining({
          threadId: null,
          source: "mail",
          purpose: "mail-judgment",
          category: "verification-code",
          seenCount: 1,
        }),
      ]);
      expect(Object.keys(listed.payload.items[0] ?? {})).not.toContain("fingerprint");
      expect(Object.keys(listed.payload.items[0] ?? {})).not.toContain("ruleId");
      const cleared = await running.composition.app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: {
          ...requestHeaders(token, second.cookie, second.csrf),
          "idempotency-key": "sensitive-interceptions-clear-01",
        },
        payload: {
          ...ownerEnvelope(second.authenticationRef, "sensitive.interceptions.clear"),
          kind: "command",
          idempotencyKey: "sensitive-interceptions-clear-01",
          payload: {},
        },
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect((await readInterceptions()).payload).toMatchObject({
        counts: { masked: 0, withheld: 0, notSaved: 0 },
        items: [],
      });
    } finally {
      await running.composition.close();
      await running.repository.close();
    }
  });
});

describe("production HTTP startup rejection contracts", () => {
  async function rejectedConfiguration(
    change: (value: ProductConfiguration) => ProductConfiguration,
    expected: string,
    fenceChange?: (value: ProductAuthorityFence) => ProductAuthorityFence,
  ) {
    const paths = await fixture();
    const original = configuration(paths);
    const repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    try {
      await expect(
        createProductionHttpComposition({
          configuration: change(original),
          repository,
          authority: () => (fenceChange ? fenceChange(authority(original)) : authority(original)),
          secretSources: secretSources(),
          now: () => new Date(NOW),
        }),
      ).rejects.toMatchObject({ code: expected });
    } finally {
      await repository.close();
    }
  }
  it.each([
    ["listenHost", "0.0.0.0"],
    ["listenPort", 65536],
    ["listenPort", 1.5],
    ["maximumBodyBytes", 0],
    ["maximumBodyBytes", 16 * 1024 * 1024 + 1],
    ["maximumBodyBytes", 1.5],
    ["maximumStaticAssetBytes", 0],
    ["maximumStaticAssetBytes", 64 * 1024 * 1024 + 1],
    ["maximumStaticAssetBytes", 1.5],
    ["heartbeatMilliseconds", 9],
    ["heartbeatMilliseconds", 300001],
    ["heartbeatMilliseconds", 10.5],
  ])("rejects unsafe listener configuration %s=%s", async (key, value) => {
    await rejectedConfiguration((c) => {
      if (!c.http) throw new Error("Missing fixture HTTP configuration");
      return { ...c, http: { ...c.http, [key as string]: value } };
    }, "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE");
  });
  it("[R2-T6] accepts an ephemeral loopback port, binds it and reports the real port", async () => {
    const paths = await fixture();
    const raw = rawConfiguration(paths);
    raw["http"] = { ...(raw["http"] as object), listenPort: 0 };
    const ephemeral = parseProductConfiguration(raw, NOW.toISOString());
    if (!ephemeral.http) throw new Error("Missing fixture HTTP configuration");
    expect(ephemeral.http.listenPort).toBe(0);
    for (const listenPort of [65_536, 1.5])
      expect(() =>
        parseProductConfiguration(
          { ...raw, http: { ...(raw["http"] as object), listenPort } },
          NOW.toISOString(),
        ),
      ).toThrow();
    const repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    const composition = await createProductionHttpComposition({
      configuration: ephemeral,
      repository,
      authority: () => authority(ephemeral),
      secretSources: secretSources(),
      now: () => new Date(NOW),
    });
    try {
      const address = await composition.listen();
      const port = Number(new URL(address).port);
      expect(Number.isSafeInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      expect(reachable).toBe(true);
    } finally {
      await composition.close();
      await repository.close();
    }
  });
  async function unixComposition(socketPath: string) {
    const paths = await fixture();
    const raw = rawConfiguration(paths);
    const parsed = parseProductConfiguration(raw, NOW.toISOString());
    const repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    const create = () =>
      createProductionHttpComposition({
        configuration: parsed,
        repository,
        authority: () => authority(parsed),
        secretSources: secretSources(),
        now: () => new Date(NOW),
        listenUnixSocketPath: socketPath,
      });
    return { repository, create };
  }
  function getOverSocket(socketPath: string, requestPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ socketPath, path: requestPath, method: "GET" }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
  }
  it("[MU-A] listens on a unix socket (directory 0700, file 0600) and leaves nothing behind after stop and restart", async () => {
    const socketPath = path.join(
      await mkdtemp(path.join(tmpdir(), "himawari-mu-")),
      "run",
      "web.sock",
    );
    roots.push(path.dirname(path.dirname(socketPath)));
    const { repository, create } = await unixComposition(socketPath);
    try {
      for (let round = 0; round < 2; round += 1) {
        const composition = await create();
        expect(await composition.listen()).toBe(socketPath);
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
        expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
        expect(await getOverSocket(socketPath, "/health/live")).toBeGreaterThan(0);
        await composition.close();
        await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await repository.close();
    }
  });
  it("[MU-A] refuses a socket directory that already exists with open permissions and leaves it untouched", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-mu-open-"));
    roots.push(directory);
    await chmod(directory, 0o755);
    const { repository, create } = await unixComposition(path.join(directory, "web.sock"));
    try {
      const composition = await create();
      await expect(composition.listen()).rejects.toThrow(/private directory/u);
      await composition.close();
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
    } finally {
      await repository.close();
    }
  });
  it("[MU-A] rejects a relative or non-normalized unix socket path", async () => {
    for (const socketPath of ["web.sock", `${tmpdir()}/a/../web.sock`]) {
      const { repository, create } = await unixComposition(socketPath);
      try {
        await expect(create()).rejects.toMatchObject({
          code: "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE",
        });
      } finally {
        await repository.close();
      }
    }
  });
  it("[MU-A] rejects a unix socket path over the platform limit before binding", async () => {
    const socketPath = path.join(tmpdir(), "x".repeat(120), "web.sock");
    const { repository, create } = await unixComposition(socketPath);
    try {
      await expect(create()).rejects.toThrow(/exceeds/u);
    } finally {
      await repository.close();
    }
  });
  it.each(["http", "identity"])("requires the %s boundary", async (key) => {
    await rejectedConfiguration((c) => {
      const copy = { ...c };
      delete (copy as Record<string, unknown>)[key];
      return copy;
    }, "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE");
  });
  it("does not enable external Access identity in local mode", async () => {
    await rejectedConfiguration(
      (c) => ({ ...c, publicMode: false }),
      "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE",
    );
  });
  it.each(["invalid", "http://agent.example.test", "https://agent.example.test/path"])(
    "rejects an unsafe public origin %s",
    async (publicOrigin) => {
      await rejectedConfiguration(
        (c) => ({ ...c, publicOrigin }),
        "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE",
      );
    },
  );
  it.each([
    ["issuer", "invalid"],
    ["issuer", "http://team.cloudflareaccess.com"],
    ["issuer", "https://team.cloudflareaccess.com/path"],
    ["jwksUrl", "invalid"],
    ["jwksUrl", "http://team.cloudflareaccess.com/cdn-cgi/access/certs"],
    ["jwksUrl", "https://person@team.cloudflareaccess.com/cdn-cgi/access/certs"],
    ["jwksUrl", "https://:fixture@team.cloudflareaccess.com/cdn-cgi/access/certs"],
    ["jwksUrl", `${JWKS_URL}?redirect=1`],
    ["jwksUrl", `${JWKS_URL}#fragment`],
    ["jwksUrl", "https://elsewhere.example.test/cdn-cgi/access/certs"],
  ])("rejects identity discovery escape %s=%s", async (key, value) => {
    await rejectedConfiguration((c) => {
      if (!c.identity) throw new Error("Missing fixture identity configuration");
      return { ...c, identity: { ...c.identity, [key]: value } };
    }, "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE");
  });
  it.each(["relative", "/tmp/../tmp/browser", "/tmp/himawari-nonexistent-contract-root"])(
    "requires a real normalized browser artifact %s",
    async (staticRoot) => {
      await rejectedConfiguration((c) => {
        if (!c.http) throw new Error("Missing fixture HTTP configuration");
        return { ...c, http: { ...c.http, staticRoot } };
      }, "PRODUCTION_HTTP_STATIC_ROOT_INVALID");
    },
  );
  it.each([
    ["deploymentId", "deployment-other"],
    ["authorityEpoch", 0],
    ["authorityEpoch", 1.5],
    ["fencingToken", 0],
    ["fencingToken", 1.5],
  ])("rejects an invalid active authority %s=%s", async (key, value) => {
    await rejectedConfiguration(
      (c) => c,
      "PRODUCTION_HTTP_AUTHORITY_INVALID",
      (fence) => ({ ...fence, [key as string]: value }),
    );
  });
  it.each(["payload-encryption", "identity-csrf"])(
    "requires exactly one correctly bound %s secret reference",
    async (purpose) => {
      await rejectedConfiguration(
        (c) => ({
          ...c,
          secretReferences: c.secretReferences.filter((ref) => ref.purpose !== purpose),
        }),
        "PRODUCTION_HTTP_SECRET_REFERENCE_INVALID",
      );
      await rejectedConfiguration(
        (c) => ({
          ...c,
          secretReferences: [
            ...c.secretReferences,
            ...c.secretReferences.filter((ref) => ref.purpose === purpose),
          ],
        }),
        "PRODUCTION_HTTP_SECRET_REFERENCE_INVALID",
      );
    },
  );
});

describe("production Thread access scope", () => {
  function accessFixture() {
    const session = { id: "session", status: "active", ownerId: OWNER_ID, deviceId: "device" };
    const findSessionByAuthenticationRef = vi.fn(
      async (): Promise<typeof session | undefined> => session,
    );
    const policy = new ProductionThreadGatewayAccessPolicy({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sessions: { findSessionByAuthenticationRef },
    } as unknown as ConstructorParameters<typeof ProductionThreadGatewayAccessPolicy>[0]);
    const authentication = {
      ownerId: OWNER_ID,
      subjectId: OWNER_ID,
      deviceId: "device",
      authenticationRef: "authentication",
      authenticatedAt: NOW.toISOString(),
    };
    const message = {
      ...envelope("query", "thread.list"),
      payload: { statuses: ["active"], pinnedOnly: false, afterCursor: null, limit: 10 },
    } as Parameters<typeof policy.authorize>[0]["message"];
    return { policy, session, findSessionByAuthenticationRef, input: { authentication, message } };
  }
  it("requires the active session on every authorized read", async () => {
    const f = accessFixture();
    expect(await f.policy.authorize(f.input)).toEqual({
      allowed: true,
      reasonCode: "OWNER_SESSION_AUTHORIZED",
    });
    expect(f.findSessionByAuthenticationRef).toHaveBeenCalledExactlyOnceWith("authentication");
    f.session.status = "revoked";
    expect(await f.policy.authorize(f.input)).toEqual({
      allowed: false,
      reasonCode: "SESSION_INACTIVE",
    });
  });
  it.each(["message-owner", "message-agent", "authentication-owner", "actor"])(
    "rejects %s mismatch before session lookup",
    async (field) => {
      const f = accessFixture();
      if (field === "message-owner")
        f.input.message = {
          ...f.input.message,
          scope: { ...f.input.message.scope, ownerId: "other" },
        };
      else if (field === "message-agent")
        f.input.message = {
          ...f.input.message,
          scope: { ...f.input.message.scope, agentId: "other" },
        };
      else if (field === "authentication-owner") f.input.authentication.ownerId = "other";
      else
        f.input.message = {
          ...f.input.message,
          actor: { actorType: "owner" as const, actorId: "other" },
        };
      expect(await f.policy.authorize(f.input)).toEqual({
        allowed: false,
        reasonCode: "THREAD_SCOPE_MISMATCH",
      });
      expect(f.findSessionByAuthenticationRef).not.toHaveBeenCalled();
    },
  );
  it.each(["ownerId", "deviceId", "status"])("rejects session %s substitution", async (field) => {
    const f = accessFixture();
    Object.assign(f.session, { [field]: "other" });
    expect(await f.policy.authorize(f.input)).toEqual({
      allowed: false,
      reasonCode: "SESSION_INACTIVE",
    });
  });
  it("rejects an unbound session and a subject that is not the owner", async () => {
    const f = accessFixture();
    f.findSessionByAuthenticationRef.mockResolvedValueOnce(undefined);
    expect(await f.policy.authorize(f.input)).toEqual({
      allowed: false,
      reasonCode: "SESSION_INACTIVE",
    });
    f.input.authentication.subjectId = "external-subject";
    f.input.message = {
      ...f.input.message,
      actor: { actorType: "owner" as const, actorId: "external-subject" },
    };
    expect(await f.policy.authorize(f.input)).toEqual({
      allowed: false,
      reasonCode: "SESSION_INACTIVE",
    });
  });
  it.each(["thread.message.submit", "thread.message.submit_configured"])(
    "binds %s to the current browser session",
    async (type) => {
      const f = accessFixture();
      const message = {
        ...f.input.message,
        kind: "command",
        type,
        payload: { sessionId: "other" },
      } as Parameters<typeof f.policy.authorize>[0]["message"];
      expect(await f.policy.authorize({ ...f.input, message })).toEqual({
        allowed: false,
        reasonCode: "SESSION_SCOPE_MISMATCH",
      });
      expect(
        await f.policy.authorize({
          ...f.input,
          message: {
            ...message,
            payload: { ...message.payload, sessionId: "session" },
          } as unknown as typeof message,
        }),
      ).toEqual({ allowed: true, reasonCode: "OWNER_SESSION_AUTHORIZED" });
    },
  );
});

describe("[P1-1] device pairing access", () => {
  const resolve = async (ref: string, version: string) => `resolved:${ref}@${version}`;
  const base = [
    { ref: "payload-kek", version: "v1", purpose: "payload-encryption" },
    { ref: "device-id-ref", version: "v2", purpose: "device-access-client-id" },
    { ref: "device-key-ref", version: "v3", purpose: "device-access-client-secret" },
  ];

  it("reads the client id and secret from the two declared secrets", async () => {
    await expect(resolveDevicePairingAccess(base, resolve)).resolves.toEqual({
      clientId: "resolved:device-id-ref@v2",
      clientSecret: "resolved:device-key-ref@v3",
    });
  });

  it("refuses an access value the gateway contract would reject", async () => {
    for (const value of ["", "x".repeat(257), "line\nbreak"])
      await expect(
        resolveDevicePairingAccess(base, async (ref) =>
          ref === "device-key-ref" ? value : "client-id",
        ),
      ).rejects.toMatchObject({ code: "PRODUCTION_HTTP_SECRET_MATERIAL_INVALID" });
    await expect(
      resolveDevicePairingAccess(base, async () => "x".repeat(256)),
    ).resolves.toBeDefined();
  });

  it("gives no access when either secret is not declared", async () => {
    await expect(resolveDevicePairingAccess(base.slice(0, 1), resolve)).resolves.toBeUndefined();
    await expect(resolveDevicePairingAccess(base.slice(0, 2), resolve)).resolves.toBeUndefined();
    await expect(
      resolveDevicePairingAccess([base[0], base[2]] as typeof base, resolve),
    ).resolves.toBeUndefined();
  });
});

describe("[P1-1] device management through gateway v2", () => {
  const ACCESS_ID = `access-id-${randomUUID()}`;
  const ACCESS_KEY = `access-key-${randomUUID()}`;

  it("pairs, lists, confirms, renames and revokes a device with the gateway types and never leaks the access secrets", async () => {
    const paths = await fixture();
    const raw = rawConfiguration(paths);
    const config = parseProductConfiguration(
      {
        ...raw,
        secretReferences: [
          ...(raw["secretReferences"] as Record<string, unknown>[]),
          { ref: "device-id", version: "v1", purpose: "device-access-client-id", scope: "agent" },
          {
            ref: "device-key",
            version: "v1",
            purpose: "device-access-client-secret",
            scope: "agent",
          },
        ],
      },
      NOW.toISOString(),
    );
    const sources = secretSources();
    const leaked: string[] = [];
    const repository = await SqliteProductStateRepository.open({
      stateRoot: paths.stateRoot,
      databasePath: paths.databasePath,
      minimumFreeBytes: 0,
      now: () => NOW.toISOString(),
    });
    const keyPair = {
      privateKey: await importJWK(productionHttpRs256TestKeys.privateKey, "RS256"),
      publicKey: await importJWK(productionHttpRs256TestKeys.publicKey, "RS256"),
    };
    const jwks: JSONWebKeySet = {
      keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "key-production-http", alg: "RS256" }],
    };
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-production-http" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("subject-production-http")
      .setIssuedAt(Math.floor(NOW.valueOf() / 1000))
      .setExpirationTime(Math.floor(NOW.valueOf() / 1000) + 300)
      .sign(keyPair.privateKey);
    const composition = await createProductionHttpComposition({
      configuration: config,
      repository,
      authority: () => authority(config),
      secretSources: {
        keys: sources.keys,
        provider: {
          ...sources.provider,
          resolve: async (ref, version) =>
            ref === "device-id"
              ? ACCESS_ID
              : ref === "device-key"
                ? ACCESS_KEY
                : sources.provider.resolve(ref, version),
        },
      },
      jwksFetcher: { fetch: async () => jwks },
      identityFetcher: {
        fetch: async () => ({
          user_uuid: "subject-production-http",
          iat: Math.floor(NOW.valueOf() / 1000),
        }),
      },
      now: () => new Date(NOW),
      createSessionToken: () => "session-token-devices-01",
      executionAuthority: () => ({
        leaseId: "lease-devices" as AuthorityFence["leaseId"],
        fencingToken: AUTHORITY.fencingToken,
      }),
      onCommandAccepted: (value) => leaked.push(value),
      onSlowRequest: (value) => leaked.push(JSON.stringify(value)),
    });
    const logged = vi.spyOn(process.stdout, "write");
    const errored = vi.spyOn(process.stderr, "write");
    try {
      const app = composition.app;
      const bootstrap = await app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: { host: "agent.example.test" },
        payload: {
          token: "bootstrap-token-production-fixture",
          ownerId: OWNER_ID,
          assertionToken: token,
        },
      });
      expect(bootstrap.statusCode).toBe(201);
      const session = await app.inject({
        method: "POST",
        url: "/api/identity/v1/sessions",
        headers: requestHeaders(token, ""),
        payload: { deviceLabel: "device gateway fixture" },
      });
      expect(session.statusCode).toBe(201);
      const cookie = "himawari_session=session-token-devices-01";
      const csrf = (
        (
          await app.inject({
            method: "GET",
            url: "/api/control-center/v1/config",
            headers: requestHeaders(token, cookie),
          })
        ).json() as { csrfToken: string }
      ).csrfToken;
      const authenticationRef = (session.json() as { session: { authenticationRef: string } })
        .session.authenticationRef;
      const message = (type: string) => ({
        schemaVersion: "gateway.v2",
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        authority: authority(config),
        actor: { actorType: "owner", actorId: OWNER_ID },
        dataClassification: "private",
        risk: "medium",
        authorizationRef: authenticationRef,
        correlationId: `correlation-${type}`,
        causationId: null,
        messageId: `message-${type}-${randomUUID()}`,
        type,
      });
      const list = async () => {
        const response = await app.inject({
          method: "POST",
          url: "/api/gateway/v2/queries",
          headers: requestHeaders(token, cookie),
          payload: { ...message("device.list.read"), kind: "query", payload: {} },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(String(response.headers["cache-control"])).toContain("no-store");
        const parsed = gatewayV2MessageSchema.parseJson(response.body);
        expect(parsed.type).toBe("device.list.snapshot");
        return response.json() as {
          payload: {
            devices: {
              id: string;
              revision: number;
              name: string;
              status: string;
              pairingNumber: string | null;
            }[];
            limits: { key: string }[];
            pairing: { expiresAt: string; access: unknown } | null;
          };
        };
      };
      const others: string[] = [];
      const command = async (type: string, payload: Record<string, unknown>) => {
        const key = `${type}-${randomUUID()}`;
        const response = await app.inject({
          method: "POST",
          url: "/api/gateway/v2/commands",
          headers: { ...requestHeaders(token, cookie, csrf), "idempotency-key": key },
          payload: { ...message(type), kind: "command", idempotencyKey: key, payload },
        });
        others.push(response.body);
        return response;
      };

      const empty = await list();
      expect(empty.payload.devices).toEqual([]);
      expect(empty.payload.pairing).toBeNull();
      expect(empty.payload.limits.map(({ key }) => key)).toContain("device.request.body_bytes");

      const invalid = await command("device.pairing.start", { pairingCode: "A".repeat(21) + "B" });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect((await list()).payload.pairing).toBeNull();

      const code = randomBytes(16).toString("base64url");
      const started = await command("device.pairing.start", { pairingCode: code });
      expect(started.statusCode, started.body).toBe(200);
      const open = await list();
      expect(open.payload.pairing).toEqual({
        expiresAt: new Date(NOW.valueOf() + 600_000).toISOString(),
        access: { clientId: ACCESS_ID, clientSecret: ACCESS_KEY },
      });

      const spki = () =>
        generateKeyPairSync("ec", { namedCurve: "prime256v1" })
          .publicKey.export({ type: "spki", format: "der" })
          .toString("base64");
      const devicePublicKey = spki();
      const confirmPublicKey = spki();
      const paired = await app.inject({
        method: "POST",
        url: "/api/device/v1/pair",
        headers: { host: "agent.example.test", "content-type": "application/json" },
        payload: JSON.stringify({
          pairingCode: code,
          kind: "iphone",
          name: "Andy iPhone",
          releaseChannel: "direct",
          devicePublicKey,
          confirmPublicKey,
        }),
      });
      others.push(paired.body);
      expect(paired.statusCode, paired.body).toBe(201);
      const pending = await list();
      expect(pending.payload.pairing).toBeNull();
      expect(pending.payload.devices).toEqual([
        expect.objectContaining({
          name: "Andy iPhone",
          status: "pending",
          revision: 0,
          pairingNumber: devicePairingNumber({ devicePublicKey, confirmPublicKey }),
        }),
      ]);
      const deviceId = pending.payload.devices[0]?.id ?? "";

      const stale = await command("device.pairing.confirm", { deviceId, expectedRevision: 5 });
      expect(stale.statusCode).not.toBe(200);
      const confirmed = await command("device.pairing.confirm", {
        deviceId,
        expectedRevision: 0,
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toEqual({ resultRef: `device:${deviceId}:1`, replayed: false });
      const confirmedAgain = await command("device.pairing.confirm", {
        deviceId,
        expectedRevision: 0,
      });
      expect(confirmedAgain.statusCode, confirmedAgain.body).toBe(200);
      expect(confirmedAgain.json()).toEqual({ resultRef: `device:${deviceId}:1`, replayed: true });
      expect((await list()).payload.devices[0]).toMatchObject({
        status: "active",
        pairingNumber: null,
      });

      const hidden = await command("device.rename", {
        deviceId,
        expectedRevision: 1,
        name: "Andy‮iPhone",
      });
      expect(hidden.statusCode).toBe(400);
      const renamed = await command("device.rename", {
        deviceId,
        expectedRevision: 1,
        name: "  Desk iPhone  ",
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      const renamedAgain = await command("device.rename", {
        deviceId,
        expectedRevision: 1,
        name: "Desk iPhone",
      });
      expect(renamedAgain.json()).toEqual({ resultRef: `device:${deviceId}:2`, replayed: true });
      const otherName = await command("device.rename", {
        deviceId,
        expectedRevision: 1,
        name: "Another name",
      });
      expect(otherName.statusCode).not.toBe(200);
      expect((await list()).payload.devices[0]).toMatchObject({ name: "Desk iPhone", revision: 2 });
      const rest = await app.inject({
        method: "POST",
        url: "/api/devices/v1/list",
        headers: requestHeaders(token, cookie, csrf),
        payload: {},
      });
      expect(rest.statusCode, rest.body).toBe(200);
      expect(rest.body).toContain("Desk iPhone");

      const revoked = await command("device.revoke", { deviceId, expectedRevision: 2 });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const revokedAgain = await command("device.revoke", { deviceId, expectedRevision: 2 });
      expect(revokedAgain.json()).toEqual({ resultRef: `device:${deviceId}:3`, replayed: true });
      const revokedStale = await command("device.revoke", { deviceId, expectedRevision: 0 });
      expect(revokedStale.statusCode).not.toBe(200);
      expect((await list()).payload.devices[0]).toMatchObject({ status: "revoked", revision: 3 });

      const secondCode = randomBytes(16).toString("base64url");
      expect((await command("device.pairing.start", { pairingCode: secondCode })).statusCode).toBe(
        200,
      );
      const second = {
        device: generateDeviceTestKeyPair(),
        confirm: generateDeviceTestKeyPair(),
      };
      const secondPaired = await app.inject({
        method: "POST",
        url: "/api/device/v1/pair",
        headers: { host: "agent.example.test", "content-type": "application/json" },
        payload: JSON.stringify({
          pairingCode: secondCode,
          kind: "iphone",
          name: "Confirmed iPhone",
          releaseChannel: "direct",
          devicePublicKey: second.device.publicKeySpkiBase64,
          confirmPublicKey: second.confirm.publicKeySpkiBase64,
        }),
      });
      expect(secondPaired.statusCode, secondPaired.body).toBe(201);
      const secondDevice = (secondPaired.json() as { device: { id: string } }).device.id;
      expect(
        (await command("device.pairing.confirm", { deviceId: secondDevice, expectedRevision: 0 }))
          .statusCode,
      ).toBe(200);
      const webLogins = await app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, cookie),
        payload: { ...message("login.devices.read"), kind: "query", payload: {} },
      });
      expect(webLogins.statusCode, webLogins.body).toBe(200);
      const webLogin = (
        webLogins.json() as { payload: { devices: { deviceId: string; current: boolean }[] } }
      ).payload.devices.find((device) => device.current);
      expect(webLogin).toBeDefined();
      const signedGateway = (body: unknown, confirm?: string) =>
        buildDeviceTestRequest({
          method: "POST",
          origin: ORIGIN,
          path: "/api/device/v1/gateway",
          body: JSON.stringify(body),
          deviceId: secondDevice,
          deviceKey: second.device.privateKey,
          createdAtSeconds: Math.floor(NOW.valueOf() / 1000),
          ...(confirm ? { confirmKey: second.confirm.privateKey, nonce: confirm } : {}),
        });
      const sendDevice = (request: ReturnType<typeof signedGateway>) =>
        app.inject({
          method: "POST",
          url: new URL(request.url).pathname,
          headers: request.headers,
          ...(request.body ? { payload: request.body } : {}),
        });
      const signOutLogin = {
        gateway: "v2",
        type: "login.device.revoke",
        messageId: "device-message-sign-out",
        idempotencyKey: "device-idempotency-sign-out",
        dataClassification: "private",
        risk: "low",
        payload: { deviceId: webLogin?.deviceId, recentAuthenticationRef: "device" },
      };
      const unconfirmed = await sendDevice(signedGateway(signOutLogin));
      expect(unconfirmed.statusCode, unconfirmed.body).toBe(403);
      const challengeRequest = buildDeviceTestRequest({
        method: "POST",
        origin: ORIGIN,
        path: "/api/device/v1/approvals/challenge",
        body: "{}",
        deviceId: secondDevice,
        deviceKey: second.device.privateKey,
        createdAtSeconds: Math.floor(NOW.valueOf() / 1000),
      });
      const issued = await sendDevice(challengeRequest);
      expect(issued.statusCode, issued.body).toBe(201);
      const signedOut = await sendDevice(
        signedGateway(signOutLogin, (issued.json() as { challenge: string }).challenge),
      );
      expect(signedOut.statusCode, signedOut.body).toBe(200);
      others.push(unconfirmed.body, issued.body, signedOut.body);
      const afterSignOut = await app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(token, cookie),
        payload: { ...message("login.devices.read"), kind: "query", payload: {} },
      });
      expect(afterSignOut.statusCode).toBe(401);

      const printed = [...logged.mock.calls, ...errored.mock.calls].map(([chunk]) => String(chunk));
      for (const text of [...leaked, ...others, ...printed]) {
        expect(text).not.toContain(ACCESS_ID);
        expect(text).not.toContain(ACCESS_KEY);
      }
    } finally {
      logged.mockRestore();
      errored.mockRestore();
      await composition.close();
      await repository.close();
    }
    const stored = await Promise.all(
      [paths.databasePath, `${paths.databasePath}-wal`].map((file) =>
        readFile(file).catch(() => Buffer.alloc(0)),
      ),
    );
    for (const bytes of stored) {
      expect(bytes.includes(ACCESS_ID)).toBe(false);
      expect(bytes.includes(ACCESS_KEY)).toBe(false);
    }
  });
});

describe("[P1-1] device limit keys", () => {
  it("lists the same keys in the application, the gateway contract and the settings page", async () => {
    const page = await readFile(
      new URL("../../control-center/src/components/device-settings.tsx", import.meta.url),
      "utf8",
    );
    const listed =
      /export const DEVICE_LIMIT_KEYS = \[([\s\S]*?)\] as const/u.exec(page)?.[1] ?? "";
    const pageKeys = [...listed.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(pageKeys).toEqual([...DEVICE_HARD_LIMIT_KEYS]);
    expect([...DEVICE_LIMIT_KEYS]).toEqual([...DEVICE_HARD_LIMIT_KEYS]);
  });
});

describe("[I-73] memory import duplicates wiring", () => {
  it("forwards the import duplicate checker from the composition options to the memory control", async () => {
    const source = await readFile(
      new URL("../src/production-http-composition.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/readonly importDuplicates\?:/u);
    expect(source).toMatch(
      /options\.memory\.importDuplicates\s*\?\s*\{\s*importDuplicates:\s*options\.memory\.importDuplicates\s*\}/u,
    );
  });

  it("is not satisfied by a composition that never forwards it", () => {
    const withoutForwarding =
      "new ProductionMemoryControl({ classifier: options.memory.classifier })";
    expect(withoutForwarding).not.toMatch(/importDuplicates:\s*options\.memory\.importDuplicates/u);
  });
});
