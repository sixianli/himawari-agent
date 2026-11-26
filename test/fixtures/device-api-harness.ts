import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentThreadGatewayService,
  type ApplePushConfiguration,
  DEFAULT_HOME_FEED,
  DEFAULT_VOICE_GATES,
  DEVICE_CONFIGURATION_DEFAULTS,
  type DeviceActionAuthorizationPort,
  type DeviceActionOpenRequestPort,
  type DeviceActionRecord,
  type DeviceActionRegistry,
  type DeviceConfiguration,
  defaultDeviceHardLimits,
  deviceVoiceTimingLister,
  deviceVoiceTimingRecorder,
  type ExecutionLiveFeed,
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
  VaultService,
  type VoiceGates,
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
  type Embedder,
  prefetchingEmbedder,
  QUERY_PREFETCH_LIMIT_DEFAULTS,
  QueryPrefetch,
  type QueryPrefetchLimits,
} from "@himawari-agent/memory-engine";
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
  type DeviceConnectionsPort,
  DeviceNotificationHub,
  DevicePresence,
  DeviceSignInService,
  displaySetupCode,
  FileSetupCodeSource,
  generateSetupCode,
  writeSetupCode,
  DevicePushService,
  EnvelopePayloadProtector,
  NodeVaultCrypto,
  PairedDeviceService,
  type PairedDeviceWarning,
  type PerceptionLimitWarning,
  PerceptionService,
  ScopedThreadSearchTokenizer,
  SessionBoundCsrfService,
} from "@himawari-agent/platform-node";
import {
  buildDeviceTestRequest,
  type DeviceTestKeyPair,
  type DeviceTestRequestInput,
  generateDeviceTestKeyPair,
  ManualClock,
  SoftwarePasskey,
} from "@himawari-agent/testing";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.ts";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import { createProductionDeviceActions } from "../../apps/agent-service/src/production-device-actions.ts";
import { ProductionHomeControl } from "../../apps/agent-service/src/production-home.ts";
import { ProductionSensitiveInterceptionsControl } from "../../apps/agent-service/src/production-sensitive-interceptions-control.ts";
import { WebPushPresence } from "../../apps/agent-service/src/production-web-push.ts";
import { ProductionWebPushControl } from "../../apps/agent-service/src/production-web-push-control.ts";
import {
  ProductionHttpPayloadAdmission,
  ProductionThreadGatewayAccessPolicy,
  utterancePrefetch,
} from "../../apps/agent-service/src/production-http-composition.ts";
import { ProductionMainThread } from "../../apps/agent-service/src/production-main-thread.ts";

export const ownerId = createOwnerId("owner-device-api");
export const agentId = createAgentId("agent-device-api");
const deploymentId = createDeploymentId("deployment-device-api");
export const authority: ProductAuthorityFence = {
  deploymentId,
  authorityEpoch: 1,
  fencingToken: 1,
};
export const authorityLease = {
  leaseId: createAuthorityLeaseId("lease-device-api"),
  fencingToken: 1,
};
const origin = "https://himawari.example";
export const webToken = "web-session-token-for-device-api-test";
const csrfKey = new Uint8Array(32).fill(5);
export const ownerSubjectRef = "cloudflare-access:owner-device-api";
const temporaryDirectories: string[] = [];

export async function removeDeviceHarnessDirectories(): Promise<void> {
  await Promise.all([
    ...temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  ]);
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
  readonly passkey: SoftwarePasskey;
  readonly signedIn: string[];
  readonly presence: { deviceId: string; visible: boolean }[];
  readonly registered: { deviceId: string; pushType: string }[];
  readonly revoking: string[];
  readonly wiped: string[];
  readonly perception: PerceptionService;
  readonly perceptionConfiguration: { current: PerceptionConfiguration };
  readonly timeZone: { current: string };
  readonly voiceGates: { current: VoiceGates };
  readonly prefetch: QueryPrefetch;
  readonly prefetchLimits: { current: QueryPrefetchLimits };
  readonly embeddedQueries: string[];
  readonly queryEmbedder: Embedder;
  readonly limitWarnings: PerceptionLimitWarning[];
  readonly readText: (contentRef: string) => Promise<string | undefined>;
  readonly protector: EnvelopePayloadProtector;
  readonly externalContent: ContextExternalContent;
  readonly notifications: {
    readonly hub: DeviceNotificationHub;
    readonly presence: DevicePresence;
    readonly settledAsked: (readonly string[])[];
    readonly settledAnswer: { current: readonly string[] };
  };
  readonly actions: ReturnType<typeof createProductionDeviceActions> & {
    readonly hub: DeviceActionHub;
    readonly authorization: { current: DeviceActionAuthorizationPort | undefined };
    readonly openRequests: DeviceActionRecord[];
  };
  readonly vault: VaultService;
  readonly vaultNotified: string[];
}

export async function harness(
  options: {
    readonly origin?: string;
    readonly staticRoot?: string;
    readonly actionRegistry?: DeviceActionRegistry;
    readonly applePush?: ApplePushConfiguration;
    readonly revokeHookFails?: "prepare" | "wipe";
    readonly withoutNotifications?: boolean;
    readonly connections?: DeviceConnectionsPort;
    readonly indexTermLimit?: number;
    readonly indexReadText?: (
      contentRef: string,
      read: (contentRef: string) => Promise<string | undefined>,
    ) => Promise<string | undefined>;
    readonly searchControl?: Parameters<typeof createProductionApprovalGateway>[0]["searchControl"];
    readonly memorySearch?: (input: {
      readonly repository: SqliteProductStateRepository;
    }) => NonNullable<Parameters<typeof createProductionApprovalGateway>[0]["memorySearchControl"]>;
    readonly files?: (input: {
      readonly repository: SqliteProductStateRepository;
      readonly protector: EnvelopePayloadProtector;
    }) => NonNullable<Parameters<typeof buildHttpGatewayServer>[0]["files"]>;
    readonly clock?: ManualClock;
    readonly live?: ExecutionLiveFeed;
    readonly mainThread?: boolean;
    readonly beforeReady?: (app: FastifyInstance) => void;
    readonly exportArchive?: NonNullable<
      Parameters<typeof buildHttpGatewayServer>[0]["devices"]
    >["exportArchive"];
    readonly speech?: NonNullable<
      Parameters<typeof buildHttpGatewayServer>[0]["devices"]
    >["speech"];
    readonly chatAttachments?: { readonly images: boolean };
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
  const clock = options.clock ?? new ManualClock("2026-11-12T00:00:00.000Z");
  const now = () => new Date(clock.now());
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  const vaultNotified: string[] = [];
  const vault = new VaultService({
    store: repository.vault(),
    crypto: new NodeVaultCrypto(),
    notifier: {
      approvalNeeded: async (input) => {
        vaultNotified.push(input.requestId);
      },
    },
    now,
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
        ...(options.live ? { live: options.live } : {}),
        ...(options.mainThread
          ? {
              mainThread: new ProductionMainThread({
                ownerId,
                agentId,
                threads,
                commands,
                payloads: repository.payloadStore(ownerId, agentId),
                protector,
                clock,
              }),
            }
          : {}),
      });
      return { controlPlane: adapter, reads: adapter };
    })(),
  });
  const threadAccess = new ProductionThreadGatewayAccessPolicy({ ownerId, agentId, sessions });
  const home = new ProductionHomeControl({
    settings: DEFAULT_HOME_FEED,
    listApprovals: () =>
      repository.authorizationStore().listApprovals(ownerId, agentId, { status: "pending" }),
    runThread: async () => null,
    threadTitle: async () => null,
    clock,
    onSourceFailure: () => undefined,
  });
  const approvalResolved: { current: (() => Promise<void>) | undefined } = { current: undefined };
  const gatewayV2 = createProductionApprovalGateway({
    onApprovalResolved: async () => {
      await approvalResolved.current?.();
    },
    homeControl: home,
    configuration: { ownerId, agentId },
    repository,
    access: threadAccess,
    recentAuthentication,
    clock,
    authority: () => authority,
    executionAuthority: () => authority as never,
    ...(options.searchControl ? { searchControl: options.searchControl } : {}),
    ...(options.memorySearch ? { memorySearchControl: options.memorySearch({ repository }) } : {}),
    sensitiveInterceptionsControl: new ProductionSensitiveInterceptionsControl({
      configuration: { ownerId, agentId },
      store: repository.sensitiveInterceptions(),
      clock,
    }),
    webPushControl: new ProductionWebPushControl({
      configuration: { ownerId, agentId },
      store: repository.webPush(),
      presence: new WebPushPresence(),
      push: undefined,
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
  const presence: Harness["presence"] = [];
  const registered: Harness["registered"] = [];
  const revoking: string[] = [];
  const wiped: string[] = [];
  const signedIn: string[] = [];
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
  const voiceGates = { current: DEFAULT_VOICE_GATES };
  const limitWarnings: PerceptionLimitWarning[] = [];
  const searchTokenizer = new ScopedThreadSearchTokenizer({
    keys: { resolve: async () => new Uint8Array(32).fill(9) },
    projectionVersion: "perception-search-test",
  });
  const perception = new PerceptionService({
    store: repository.perception(),
    deviceConfiguration: () => configuration.current,
    configuration: () => perceptionConfiguration.current,
    timeZone: () => timeZone.current,
    protectText: async (input) =>
      (await payloadAdmission.protect({ ...input, contentType: "text/plain" })).payloadRef,
    uploadDirectory: path.join(stateRoot, "device-uploads"),
    voiceGates: () => voiceGates.current,
    searchIndex: {
      version: "perception-search-test:rules:2000",
      rebuildBatch: 2,
      termLimit: options.indexTermLimit ?? 2000,
      readText: async (contentRef) => {
        const read = async (ref: string) => {
          const payload = await repository.payloadStore(ownerId, agentId).get(ref);
          if (!payload) return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await protector.unprotect({ ownerId, agentId, payload }),
          );
        };
        return options.indexReadText ? options.indexReadText(contentRef, read) : read(contentRef);
      },
      document: (scope, text) =>
        searchTokenizer.tokenizeDocument({ ownerId: scope.ownerId, agentId: scope.agentId, text }),
      query: (scope, text) =>
        searchTokenizer.tokenize({ ownerId: scope.ownerId, agentId: scope.agentId, text }),
    },
    onLimitWarning: (warning) => limitWarnings.push(warning),
    now,
  });
  await perception.prepareDirectories();
  const hub = new DeviceActionHub();
  const notifications = {
    hub: new DeviceNotificationHub(),
    presence: new DevicePresence(),
    settledAsked: [] as (readonly string[])[],
    settledAnswer: { current: [] as readonly string[] },
  };
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
      resolve: async (approvalId) =>
        authorization.current?.resolve?.(approvalId) ?? { decision: "pending" },
    },
    ...(options.actionRegistry ? { registry: options.actionRegistry } : {}),
  });
  approvalResolved.current = () => actions.service.reconcile();
  const prefetchLimits = { current: QUERY_PREFETCH_LIMIT_DEFAULTS };
  const prefetch = new QueryPrefetch({
    limits: () => prefetchLimits.current,
    now: () => Date.parse(clock.now()),
  });
  const embeddedQueries: string[] = [];
  const fixtureEmbedder: Embedder = {
    model: "fixture-embedding",
    dimensions: 2,
    embedQuery: async (query) => {
      embeddedQueries.push(query);
      return new Float32Array([[...query].length, 1]);
    },
    embedDocument: async (text) => new Float32Array([[...text].length, 0]),
  };
  const queryEmbedder = prefetchingEmbedder(fixtureEmbedder, prefetch);
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
    ...(options.files ? { files: options.files({ repository, protector }) } : {}),
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
        prepareRevoke: async (deviceId) => {
          revoking.push(deviceId);
          if (options.revokeHookFails === "prepare") throw new Error("PREPARE_WIPE_FAILED");
          return async () => {
            if (options.revokeHookFails === "wipe") throw new Error("WIPE_FAILED");
            wiped.push(deviceId);
          };
        },
      }),
      configuration: () => configuration.current,
      audit: repository.auditLedger(),
      push: new DevicePushService({
        store: repository.applePush(),
        reactions: repository.webPush(),
        configuration: () => options.applePush,
        now,
        onPresence: (deviceId, visible) => presence.push({ deviceId, visible }),
        onRegistered: (deviceId, pushType) => registered.push({ deviceId, pushType }),
      }),
      signIn: new DeviceSignInService({
        scope: { ownerId, agentId },
        store: repository.pairedDevices(),
        publicOrigin: new URL(publicOrigin),
        setupCodes: new FileSetupCodeSource(stateRoot),
        now,
        onSignedIn: (device) => signedIn.push(device.id),
      }),
      appleAppIds: () =>
        options.applePush
          ? options.applePush.topics.map((topic) => `${options.applePush?.teamId}.${topic}`)
          : [],
      perception,
      vault: (scope) =>
        scope.ownerId === ownerId && scope.agentId === agentId ? vault : undefined,
      ...(options.connections
        ? {
            connections: (scope) =>
              scope.ownerId === ownerId && scope.agentId === agentId
                ? options.connections
                : undefined,
          }
        : {}),
      actions: {
        service: (scope) =>
          scope.ownerId === ownerId && scope.agentId === agentId ? actions.service : undefined,
        hub,
      },
      ...(options.withoutNotifications
        ? {}
        : {
            notifications: {
              hub: notifications.hub,
              presence: notifications.presence,
              settled: async ({ ids }: { ids: readonly string[] }) => {
                notifications.settledAsked.push(ids);
                return ids.filter((id) => notifications.settledAnswer.current.includes(id));
              },
            },
          }),
      voiceGates: () => voiceGates.current,
      prefetch: utterancePrefetch(
        {
          queue: prefetch,
          embedQuery: (text) => fixtureEmbedder.embedQuery(text),
          estimateMicros: (text) => [...text].length,
        },
        perception,
        agentId,
      ),
      ...(options.exportArchive ? { exportArchive: options.exportArchive } : {}),
      ...(options.speech ? { speech: options.speech } : {}),
      ...(options.chatAttachments
        ? { chatAttachments: () => options.chatAttachments as { readonly images: boolean } }
        : {}),
      listVoiceTiming: deviceVoiceTimingLister({
        ownerId,
        agentId,
        trace: repository.traceStore(),
        payloads: repository.payloadStore(ownerId, agentId),
        protector,
      }),
      recordVoiceTiming: deviceVoiceTimingRecorder({
        ownerId,
        agentId,
        trace: repository.traceStore(),
        payloads: repository.payloadStore(ownerId, agentId),
        protector,
        now: () => clock.now(),
      }),
    },
  });
  options.beforeReady?.(app);
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
    passkey: new SoftwarePasskey(publicOrigin),
    signedIn,
    presence,
    registered,
    revoking,
    wiped,
    perception,
    perceptionConfiguration,
    timeZone,
    voiceGates,
    prefetch,
    prefetchLimits,
    embeddedQueries,
    queryEmbedder,
    limitWarnings,
    protector,
    externalContent,
    actions: { ...actions, hub, authorization, openRequests },
    vault,
    vaultNotified,
    notifications,
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

export async function issueSetupCode(h: Harness, minutes = 15): Promise<string> {
  const code = generateSetupCode();
  await writeSetupCode({
    stateRoot: h.stateRoot,
    scope: { ownerId, agentId },
    code,
    now: new Date(h.clock.now()),
    minutes,
  });
  return displaySetupCode(code);
}

export async function signInRequest(h: Harness, path: string, body: unknown) {
  return h.app.inject({
    method: "POST",
    url: `/api/device/v1/sign-in/${path}`,
    headers: { host: new URL(h.origin).host, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

export function signInDevice(name = "Andy iPhone", kind: "iphone" | "watch" | "mac" = "iphone") {
  const keys = generateDeviceTestKeyPair();
  const confirmKeys = generateDeviceTestKeyPair();
  return {
    keys,
    confirmKeys,
    device: {
      kind,
      name,
      releaseChannel: "direct",
      devicePublicKey: keys.publicKeySpkiBase64,
      confirmPublicKey: confirmKeys.publicKeySpkiBase64,
    },
  };
}

export async function signInWithPasskey(
  h: Harness,
  device: ReturnType<typeof signInDevice>["device"] | Record<string, unknown>,
) {
  const enrolled =
    (await h.repository.pairedDevices().listPasskeys({ ownerId, agentId })).length > 0;
  if (enrolled) {
    const options = await signInRequest(h, "options", { device });
    expect(options.statusCode, options.body).toBe(200);
    const started = options.json() as {
      flowId: string;
      publicKey: { challenge: string; rpId: string };
    };
    const response = await signInRequest(h, "finish", {
      flowId: started.flowId,
      credential: h.passkey.get(started.publicKey),
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { device: { id: string; revision: number } }).device;
  }
  const options = await signInRequest(h, "setup/options", {
    setupCode: await issueSetupCode(h),
    device,
  });
  expect(options.statusCode, options.body).toBe(200);
  const started = options.json() as {
    flowId: string;
    publicKey: { challenge: string; rp: { id: string } };
  };
  const response = await signInRequest(h, "setup/finish", {
    flowId: started.flowId,
    credential: h.passkey.create(started.publicKey),
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { device: { id: string; revision: number } }).device;
}

export async function pairAndConfirm(
  h: Harness,
  name?: string,
  kind?: "iphone" | "watch" | "mac",
): Promise<PairedClient> {
  const client = signInDevice(name, kind);
  const device = await signInWithPasskey(h, client.device);
  return {
    deviceId: device.id,
    keys: client.keys,
    confirmKeys: client.confirmKeys,
    revision: device.revision,
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

export function ownerSpokenAt(threshold: number): VoiceGates {
  return {
    ...DEFAULT_VOICE_GATES,
    ownerSpoken: { ...DEFAULT_VOICE_GATES.ownerSpoken, defaultThreshold: threshold },
  };
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
