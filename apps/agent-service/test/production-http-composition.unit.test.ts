import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProductConfiguration, ThreadCreateInput } from "@himawari-agent/application";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  type HostProviderSecretSource,
  type HostSecretMaterialSource,
  initializeStateRoot,
  parseProductConfiguration,
} from "@himawari-agent/platform-node";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionHttpComposition,
  type ProductionHttpCompositionSecretSources,
} from "../src/production-http-composition.js";

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

function configuration(paths: Awaited<ReturnType<typeof fixture>>): ProductConfiguration {
  return parseProductConfiguration(
    {
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
          ref: "model-fallback",
          role: "fallback",
          provider: "deterministic",
          model: "deterministic-fallback",
          version: "v1",
          allowedDataClassifications: ["private"],
          disclosure: "local_only",
          secretRef: null,
          capabilities: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          priority: 2,
          name: "Production HTTP fixture fallback",
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
        adapter: "mem0-oss",
        version: "3.1.7",
        storagePath: path.join(paths.stateRoot, "data", "memory"),
        dimensions: 1536,
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
        { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
        { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
      ],
      budgets: {
        globalCostMicros: 1_000_000,
        perRunCostMicros: 100_000,
        perClassificationCostMicros: {
          public: 100_000,
          private: 100_000,
          sensitive: 0,
          restricted: 0,
        },
      },
      concurrency: { totalRuns: 4, foregroundReserved: 1, perCategory: { foreground: 2 } },
      deadlines: { runMs: 60_000, workerRequestMs: 5_000, providerRequestMs: 5_000 },
    },
    NOW.toISOString(),
  );
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
  it("authenticates an RS256 assertion, admits a durable Thread run, and replays after restart", async () => {
    const paths = await fixture();
    const keyPair = await generateKeyPair("RS256", { extractable: true });
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
    let composition = await createProductionHttpComposition({
      configuration: config,
      repository,
      authority: () => configAuthority,
      secretSources: secretSources(),
      jwksFetcher,
      identityFetcher,
      now: () => new Date(NOW),
      createSessionToken: () => "session-token-production-http",
    });
    try {
      const bootstrap = await composition.app.inject({
        method: "POST",
        url: "/bootstrap",
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
      const browserConfig = configResponse.json() as {
        readonly csrfToken: string;
        readonly recentAuthenticationRef: string;
      };
      expect(browserConfig.recentAuthenticationRef).toBe(sessionBody.session.authenticationRef);

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
});
