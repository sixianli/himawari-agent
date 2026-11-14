import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentThreadGatewayService,
  createProactiveSeal,
  DEFAULT_HOME_FEED,
  DEVICE_CONFIGURATION_DEFAULTS,
  type DeviceActionAuthorizationPort,
  type DeviceActionOpenRequestPort,
  type DeviceActionRecord,
  type DeviceActionRegistry,
  type DeviceConfiguration,
  defaultDeviceHardLimits,
  type GatewayAuthenticationContext,
  PERCEPTION_CONFIGURATION_DEFAULTS,
  type PerceptionConfiguration,
  ProductThreadGatewayAdapter,
  ReadOnlyDeviceActionAuthorization,
  RecentAuthenticationGuard,
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  ThreadExecutionProjection,
  ThreadForkService,
  ThreadQueryService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createDeviceId,
  createOwnerId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  BrowserTextPayloadReader,
  buildHttpGatewayServer,
  DeviceActionHub,
  type DevicePairingAccess,
  EnvelopePayloadProtector,
  PairedDeviceService,
  type PairedDeviceWarning,
  type PerceptionLimitWarning,
  PerceptionService,
  SessionBoundCsrfService,
} from "@himawari-agent/platform-node";
import {
  buildDeviceTestRequest,
  type DeviceTestKeyPair,
  type DeviceTestRequestInput,
  generateDeviceTestKeyPair,
  ManualClock,
} from "@himawari-agent/testing";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.ts";
import { createProductionDeviceActions } from "../../apps/agent-service/src/production-device-actions.ts";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import { ProductionHomeControl } from "../../apps/agent-service/src/production-home.ts";
import {
  ProductionHttpPayloadAdmission,
  ProductionThreadGatewayAccessPolicy,
} from "../../apps/agent-service/src/production-http-composition.ts";
import { ProductionMuseControl } from "../../apps/agent-service/src/production-muse-intake-control.ts";

export const ownerId = createOwnerId("owner-device-api");
export const agentId = createAgentId("agent-device-api");
const deploymentId = createDeploymentId("deployment-device-api");
export const authority: ProductAuthorityFence = {
  deploymentId,
  authorityEpoch: 1,
  fencingToken: 1,
};
const authorityLease = {
  leaseId: createAuthorityLeaseId("lease-device-api"),
  fencingToken: 1,
};
const origin = "https://himawari.example";
export const webToken = "web-session-token-for-device-api-test";
const csrfKey = new Uint8Array(32).fill(5);
export const ownerSubjectRef = "cloudflare-access:owner-device-api";
const temporaryDirectories: string[] = [];

export async function removeDeviceHarnessDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
}

export function sha256Ref(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export interface Harness {
  readonly origin: string;
  readonly app: FastifyInstance;
  readonly repository: SqliteProductStateRepository;
  readonly clock: ManualClock;
  readonly webHeaders: () => Promise<Record<string, string>>;
  readonly configuration: { current: DeviceConfiguration };
  readonly ownerActive: { current: boolean };
  readonly webAuthentication: GatewayAuthenticationContext;
  readonly warnings: PairedDeviceWarning[];
  readonly stateRoot: string;
  readonly perception: PerceptionService;
  readonly perceptionConfiguration: { current: PerceptionConfiguration };
  readonly timeZone: { current: string };
  readonly ownerVoiceQualified: { current: boolean };
  readonly limitWarnings: PerceptionLimitWarning[];
  readonly readText: (contentRef: string) => Promise<string | undefined>;
  readonly protector: EnvelopePayloadProtector;
  readonly externalContent: ContextExternalContent;
  readonly actions: ReturnType<typeof createProductionDeviceActions> & {
    readonly hub: DeviceActionHub;
    readonly authorization: { current: DeviceActionAuthorizationPort | undefined };
    readonly openRequests: DeviceActionRecord[];
  };
}

export async function harness(
  options: {
    readonly origin?: string;
    readonly staticRoot?: string;
    readonly pairingAccess?: DevicePairingAccess;
    readonly actionRegistry?: DeviceActionRegistry;
    readonly searchControl?: Parameters<typeof createProductionApprovalGateway>[0]["searchControl"];
  } = {},
): Promise<Harness> {
  const publicOrigin = options.origin ?? origin;
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-device-api-"));
  temporaryDirectories.push(stateRoot);
  const databasePath = path.join(stateRoot, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', ?, ?)`,
    )
    .run(deploymentId, ownerId, agentId, authority.authorityEpoch, authority.fencingToken);
  database
    .prepare(
      `INSERT INTO authority_leases (
        id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
        fencing_token, acquired_at, expires_at
      ) VALUES (?, ?, ?, ?, 'holder-device-api', ?, ?, '2026-11-12T00:00:00.000Z',
        '2999-12-31T23:59:59.999Z')`,
    )
    .run(
      authorityLease.leaseId,
      ownerId,
      agentId,
      deploymentId,
      authority.authorityEpoch,
      authorityLease.fencingToken,
    );
  database.close();
  const clock = new ManualClock("2026-11-12T00:00:00.000Z");
  const now = () => new Date(clock.now());
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  const sessions = repository.sessionDeviceState();
  const identityState = repository.ownerIdentityState();
  await identityState.bindFirstOwner({
    ownerId,
    externalSubjectRef: ownerSubjectRef,
    boundAt: clock.now(),
  });
  const recentAuthentication = new RecentAuthenticationGuard({
    identityState,
    sessionState: sessions,
    policy: { maximumAgeMilliseconds: 300_000, clockSkewMilliseconds: 0 },
    now: () => clock.now(),
  });
  const webDevice = await sessions.saveDevice(
    {
      id: createDeviceId("device:web-browser"),
      ownerId,
      label: "Browser",
      status: "active",
      firstSeenAt: clock.now(),
      lastSeenAt: clock.now(),
    },
    null,
  );
  const webSession = await sessions.saveSession(
    {
      id: createSessionId("session:web-browser"),
      ownerId,
      deviceId: webDevice.id,
      authenticationRef: sha256Ref(webToken),
      status: "active",
      firstAuthenticatedAt: clock.now(),
      lastActiveAt: clock.now(),
      recentAuthenticatedAt: clock.now(),
      revokedAt: null,
    },
    null,
  );
  const webAuthentication: GatewayAuthenticationContext = {
    subjectId: ownerId,
    ownerId,
    deviceId: webDevice.id,
    authenticatedAt: clock.now(),
    authenticationRef: webSession.authenticationRef,
    sessionId: webSession.id,
  };
  const protector = new EnvelopePayloadProtector({
    keys: {
      kind: "memory-development",
      productionSuitable: false,
      resolve: async () => new Uint8Array(32).fill(9),
    },
    activeKey: { keyRef: "test-kek", kekVersion: "v1", dekVersion: "v1" },
  });
  const threads = repository.threadRepository();
  const commands = new ThreadCommandService({
    repository: threads,
    clock,
    authority: () => authority,
  });
  const threadGateway = new AgentThreadGatewayService({
    access: new ProductionThreadGatewayAccessPolicy({ ownerId, agentId, sessions }),
    ...(() => {
      const adapter = new ProductThreadGatewayAdapter({
        repository: threads,
        checkpoints: repository.threadDistillationState(),
        commands,
        queries: new ThreadQueryService(threads),
        forks: new ThreadForkService({ repository: threads, clock, authority: () => authority }),
        deletion: new ThreadDeletionCoordinationService({
          repository: threads,
          clock,
          authority: () => authority,
          recentAuthentication,
        }),
        execution: new ThreadExecutionProjection({
          threads,
          trace: repository.traceStore(),
          payloads: (owner, agent) =>
            repository.payloadStore(createOwnerId(owner), createAgentId(agent)),
          protector,
        }),
        clock,
        waitForEvents: async () => new Promise((resolve) => setTimeout(resolve, 20)),
      });
      return { controlPlane: adapter, reads: adapter };
    })(),
  });
  const threadAccess = new ProductionThreadGatewayAccessPolicy({ ownerId, agentId, sessions });
  const ids = { next: (namespace: string) => `${namespace}:${randomUUID()}` };
  const home = new ProductionHomeControl({
    settings: DEFAULT_HOME_FEED,
    listApprovals: () =>
      repository.authorizationStore().listApprovals(ownerId, agentId, { status: "pending" }),
    runThread: async () => null,
    threadTitle: async () => null,
    clock,
    onSourceFailure: () => undefined,
  });
  const gatewayV2 = createProductionApprovalGateway({
    homeControl: home,
    configuration: { ownerId, agentId },
    repository,
    access: threadAccess,
    recentAuthentication,
    clock,
    authority: () => authority,
    executionAuthority: () => authority as never,
    ...(options.searchControl ? { searchControl: options.searchControl } : {}),
    museControl: new ProductionMuseControl({
      scope: { ownerId, agentId },
      store: repository.museIntake(),
      seal: createProactiveSeal({
        payloads: repository.payloadStore(ownerId, agentId),
        protector,
        ids,
      }),
      ids,
      clock,
    }),
  });
  const configuration = {
    current: {
      ...DEVICE_CONFIGURATION_DEFAULTS,
      heartbeatSeconds: 1,
      limits: defaultDeviceHardLimits(),
    } as DeviceConfiguration,
  };
  const ownerActive = { current: true };
  const warnings: PairedDeviceWarning[] = [];
  const csrf = new SessionBoundCsrfService({ key: csrfKey, now });
  const payloadAdmission = new ProductionHttpPayloadAdmission({
    ownerId,
    agentId,
    sessions,
    payloads: repository.payloadStore(ownerId, agentId),
    protector,
    clock: () => clock.now(),
  });
  const perceptionConfiguration = { current: PERCEPTION_CONFIGURATION_DEFAULTS };
  const timeZone = { current: "Asia/Tokyo" };
  const ownerVoiceQualified = { current: false };
  const limitWarnings: PerceptionLimitWarning[] = [];
  const perception = new PerceptionService({
    store: repository.perception(),
    deviceConfiguration: () => configuration.current,
    configuration: () => perceptionConfiguration.current,
    timeZone: () => timeZone.current,
    protectText: async (input) =>
      (await payloadAdmission.protect({ ...input, contentType: "text/plain" })).payloadRef,
    uploadDirectory: path.join(stateRoot, "device-uploads"),
    ownerVoiceQualified: () => ownerVoiceQualified.current,
    onLimitWarning: (warning) => limitWarnings.push(warning),
    now,
  });
  await perception.prepareDirectories();
  const hub = new DeviceActionHub();
  const authorization: { current: DeviceActionAuthorizationPort | undefined } = {
    current: undefined,
  };
  const openRequests: DeviceActionRecord[] = [];
  const requestOpen: DeviceActionOpenRequestPort = {
    requestOpen: async ({ record }) => {
      openRequests.push(record);
    },
  };
  const externalContent = new ContextExternalContent({
    configuration: { ownerId, agentId },
    state: repository,
    source: repository.runExecutionSource(ownerId, agentId),
    authority: () => authorityLease,
    clock,
  });
  const actions = createProductionDeviceActions({
    scope: { ownerId, agentId },
    store: repository.deviceActions(),
    perception: repository.perception(),
    externalContent,
    devices: (scope) => repository.pairedDevices().listDevices(scope),
    ledger: repository.decisionLedger(),
    payloads: repository.payloadStore(ownerId, agentId),
    protector,
    delivery: hub,
    configuration: () => perceptionConfiguration.current,
    timeZone: timeZone.current,
    now: () => clock.now(),
    openRequests: requestOpen,
    authorization: {
      authorize: async (intent) =>
        (authorization.current ?? new ReadOnlyDeviceActionAuthorization()).authorize(intent),
    },
    ...(options.actionRegistry ? { registry: options.actionRegistry } : {}),
  });
  const app = buildHttpGatewayServer({
    publicOrigin,
    staticRoot: options.staticRoot ?? stateRoot,
    authentication: {
      authenticate: async (input) => {
        if (!input.sessionToken) throw new Error("missing session");
        const session = await sessions.findSessionByAuthenticationRef(
          sha256Ref(input.sessionToken),
        );
        if (!session || session.status !== "active") throw new Error("inactive session");
        return {
          subjectId: session.ownerId,
          ownerId: session.ownerId,
          deviceId: session.deviceId,
          authenticatedAt: clock.now(),
          authenticationRef: session.authenticationRef,
          sessionId: session.id,
        };
      },
    },
    csrf,
    threadGateway,
    gatewayV2,
    payloadAdmission,
    payloadRead: new BrowserTextPayloadReader({
      payloads: (owner, agent) =>
        repository.payloadStore(createOwnerId(owner), createAgentId(agent)),
      protector,
    }),
    browserConfiguration: {
      agentId,
      deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
    },
    devices: {
      home: { resolveAction: (input) => home.resolveAction(input) },
      service: new PairedDeviceService({
        store: repository.pairedDevices(),
        sessions,
        configuration: () => configuration.current,
        ownerActive: async (scope) =>
          ownerActive.current && scope.ownerId === ownerId && scope.agentId === agentId,
        ownerSubject: async (scope) =>
          scope.ownerId === ownerId
            ? (await identityState.readByOwner(ownerId))?.externalSubjectRef
            : undefined,
        now,
        onWarning: (warning) => warnings.push(warning),
      }),
      configuration: () => configuration.current,
      audit: repository.auditLedger(),
      ...(options.pairingAccess ? { pairingAccess: options.pairingAccess } : {}),
      perception,
      actions: {
        service: (scope) =>
          scope.ownerId === ownerId && scope.agentId === agentId ? actions.service : undefined,
        hub,
      },
    },
  });
  await app.ready();
  return {
    origin: publicOrigin,
    app,
    repository,
    clock,
    configuration,
    ownerActive,
    webAuthentication,
    warnings,
    stateRoot,
    perception,
    perceptionConfiguration,
    timeZone,
    ownerVoiceQualified,
    limitWarnings,
    protector,
    externalContent,
    actions: { ...actions, hub, authorization, openRequests },
    readText: async (contentRef) => {
      const payload = await repository.payloadStore(ownerId, agentId).get(contentRef);
      if (!payload) return undefined;
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await protector.unprotect({ ownerId, agentId, payload }),
      );
    },
    webHeaders: async () => ({
      host: new URL(publicOrigin).host,
      origin: publicOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `himawari_session=${webToken}`,
      "x-csrf-token": await csrf.issue(webAuthentication),
    }),
  };
}

export async function web(h: Harness, action: string, body: unknown = {}) {
  const response = await h.app.inject({
    method: "POST",
    url: `/api/devices/v1/${action}`,
    headers: await h.webHeaders(),
    payload: JSON.stringify(body),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

export interface PairedClient {
  readonly deviceId: string;
  readonly keys: DeviceTestKeyPair;
  readonly confirmKeys: DeviceTestKeyPair;
  readonly revision: number;
}

export function pairingCode(uri: unknown): string {
  const encoded = String(uri).replace(/^himawari-pair:/u, "");
  return (JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { code: string }).code;
}

export async function pair(h: Harness, name = "Andy iPhone") {
  const started = await web(h, "pairing-codes");
  expect(started.status).toBe(201);
  const keys = generateDeviceTestKeyPair();
  const confirmKeys = generateDeviceTestKeyPair();
  const response = await h.app.inject({
    method: "POST",
    url: "/api/device/v1/pair",
    headers: { host: new URL(h.origin).host, "content-type": "application/json" },
    payload: JSON.stringify({
      pairingCode: pairingCode(started.body["pairingUri"]),
      kind: "iphone",
      name,
      releaseChannel: "direct",
      devicePublicKey: keys.publicKeySpkiBase64,
      confirmPublicKey: confirmKeys.publicKeySpkiBase64,
    }),
  });
  return { response, keys, confirmKeys, code: pairingCode(started.body["pairingUri"]) };
}

export async function pairAndConfirm(h: Harness): Promise<PairedClient> {
  const paired = await pair(h);
  expect(paired.response.statusCode).toBe(201);
  const device = (paired.response.json() as { device: { id: string; revision: number } }).device;
  const confirmed = await web(h, "confirm", {
    deviceId: device.id,
    expectedRevision: device.revision,
  });
  expect(confirmed.status).toBe(200);
  return {
    deviceId: device.id,
    keys: paired.keys,
    confirmKeys: paired.confirmKeys,
    revision: (confirmed.body["device"] as { revision: number }).revision,
  };
}

export function signedRequest(
  h: Harness,
  client: PairedClient,
  input: Partial<DeviceTestRequestInput> & { method: string; path: string },
) {
  return buildDeviceTestRequest({
    origin: h.origin,
    deviceId: client.deviceId,
    deviceKey: client.keys.privateKey,
    createdAtSeconds: Math.floor(Date.parse(h.clock.now()) / 1000),
    ...input,
  });
}

export async function send(h: Harness, request: ReturnType<typeof buildDeviceTestRequest>) {
  const url = new URL(request.url);
  return h.app.inject({
    method: request.method as "GET" | "POST",
    url: url.pathname + url.search,
    headers: request.headers,
    ...(request.body ? { payload: request.body } : {}),
  });
}

export async function threadCommand(
  h: Harness,
  type: string,
  idempotencyKey: string,
  payload: (resultRef: string) => Record<string, unknown>,
) {
  const resultRef = (
    await new ProductionHttpPayloadAdmission({
      ownerId,
      agentId,
      sessions: h.repository.sessionDeviceState(),
      payloads: h.repository.payloadStore(ownerId, agentId),
      protector: new EnvelopePayloadProtector({
        keys: {
          kind: "memory-development",
          productionSuitable: false,
          resolve: async () => new Uint8Array(32).fill(9),
        },
        activeKey: { keyRef: "test-kek", kekVersion: "v1", dekVersion: "v1" },
      }),
      clock: () => h.clock.now(),
    }).protect({
      authentication: h.webAuthentication,
      idempotencyKey,
      content: `thread-action:${type}`,
      dataClassification: "private",
      contentType: "text/plain",
    })
  ).payloadRef;
  const response = await h.app.inject({
    method: "POST",
    url: "/api/gateway/thread/v3/commands",
    headers: { ...(await h.webHeaders()), "idempotency-key": idempotencyKey },
    payload: JSON.stringify({
      schemaVersion: "gateway.thread.v3",
      kind: "command",
      type,
      messageId: `message:${idempotencyKey}`,
      correlationId: "correlation:device-test",
      causationId: null,
      scope: { ownerId, agentId },
      authority,
      actor: { actorType: "owner", actorId: ownerId },
      idempotencyKey,
      payload: payload(resultRef),
    }),
  });
  expect(response.statusCode, response.body).toBe(200);
}

export async function createThread(h: Harness, threadId: string) {
  await threadCommand(h, "thread.create", `create:${threadId}`, (resultRef) => ({
    threadId,
    answerLocale: "zh-CN",
    resultRef,
  }));
}
