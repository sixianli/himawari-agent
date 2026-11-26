import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  CancelCoordinatedRunInput,
  CapabilityReactivationVerifierPort,
  DurableMemoryService,
  MemoryExtractionAuditRecord,
  PayloadProtectionRequest,
  ThreadCreateInput,
  ThreadGatewayInboundMessage,
} from "@himawari-agent/application";
import {
  AgentThreadGatewayService,
  ApplicationPortError,
  approvalBodyPreview,
  DEFAULT_HOME_FEED,
  DEFAULT_SEARCH_ASK,
  DEFAULT_VOICE_GATES,
  DEVICE_CONFIGURATION_DEFAULTS,
  type DeviceActionService,
  defaultDeviceHardLimits,
  deviceVoiceTimingRecorder,
  type ExecutionLiveFeed,
  type GatewayAccessDecision,
  type GatewayAuthenticationContext,
  type GatewayV2InboundMessage,
  MAIL_INBOX_SOURCE_KIND,
  type McpMemorySyncStorePort,
  type OwnerIdentityStatePort,
  OwnerProfileService,
  type PairedDeviceScope,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PERCEPTION_CONFIGURATION_DEFAULTS,
  PERCEPTION_SEARCH_INDEX_RULES,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  ProductThreadGatewayAdapter,
  perceptionSearchEvidenceText,
  RecentAuthenticationGuard,
  type RunLifecyclePort,
  readThreadExecutionEnvironment,
  type SessionDeviceStatePort,
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  ThreadExecutionProjection,
  ThreadForkService,
  type ThreadGatewayAccessPolicyPort,
  type ThreadMessageOptionsPort,
  ThreadQueryService,
  threadCommandFingerprint,
  type VaultService,
} from "@himawari-agent/application";
import {
  isDeviceAccessText,
  type ThreadExecutionEnvironment,
} from "@himawari-agent/gateway-contracts";
import { MemoryConsolidationService, undoConversationReview } from "@himawari-agent/memory-engine";
import {
  SqliteGovernedDeletionAdapter,
  type SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  CloudflareAccessJwtVerifier as AccessJwtVerifier,
  assertProductionSecretSource,
  assertUnixSocketPathLength,
  authenticateHttpRequest,
  BoundedJwksFetcher,
  BrowserTextPayloadReader,
  BrowserThreadFiles,
  BrowserThreadSearchPreparer,
  BuiltInAuthenticationService,
  buildHttpGatewayServer,
  CloudflareAccessIdentityClient,
  type CloudflareAccessIdentityFetcher,
  DEVICE_ACCESS_SECRET_PURPOSES,
  type DeviceActionHub,
  type DeviceGatewayAuditFailure,
  type DeviceNotificationHub,
  type DevicePairingAccess,
  type DevicePresence,
  DevicePushService,
  digestIdentityCredential,
  EnvelopePayloadProtector,
  type HostProviderSecretSource,
  type HostSecretMaterialSource,
  type HttpGatewayAuthenticationPort,
  type HttpGatewayPayloadAdmissionPort,
  type HttpGatewayPayloadContentType,
  type HttpGatewayServerOptions,
  type HttpGatewaySlowRequest,
  IDENTITY_GATEWAY_ERROR_CODES,
  IdentityGatewayError,
  type JwksFetcher,
  OwnerBootstrapService,
  PairedDeviceService,
  type PairedDeviceWarning,
  type PerceptionLimitWarning,
  PerceptionService,
  ProductSessionAuthenticationService,
  type ProductSessionAuthenticationServiceOptions,
  prepareUnixSocketPath,
  RuntimeHealthModel,
  RuntimeMetricsRegistry,
  registerBuiltInIdentityRoutes,
  registerIdentityAuthenticationRoutes,
  removeUnixSocketFile,
  ScopedThreadSearchTokenizer,
  SessionBoundCsrfService,
  sealUnixSocket,
  ThreadSearchBackgroundIndexer,
  ThreadSearchProjector,
  type UnixSocketIdentity,
  type UtterancePrefetchPort,
} from "@himawari-agent/platform-node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BuiltInActionRuleSwitches } from "./action-rule-switches.js";
import { classifiedThreadTitleReader } from "./classified-thread-title.js";
import type { ContextExternalContent } from "./context-external-content.js";
import type { OwnerAllowances } from "./owner-allowances.js";
import type { ProductionApplePush } from "./production-apple-push.js";
import { ProductionApprovalAnswers } from "./production-approval-answers.js";
import {
  createProductionApprovalGateway,
  PRODUCTION_APPROVAL_OPERATIONS,
  PRODUCTION_CAPABILITY_OPERATIONS,
  PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS,
} from "./production-approval-gateway.js";
import { backgroundCommandRef } from "./production-background-commands.js";
import { registerChatExportRoute } from "./production-chat-export.js";
import { createProductionSpeech } from "./production-speech.js";
import {
  DataExportJobs,
  deviceExportArchive,
  PRODUCTION_DATA_EXPORT_OPERATIONS,
  ProductionDataExportControl,
  registerDataExportRoute,
} from "./production-data-export.js";
import {
  PRODUCTION_DEVICE_OPERATIONS,
  ProductionDeviceControl,
} from "./production-device-control.js";
import { PRODUCTION_FILES_OPERATIONS, ProductionFilesControl } from "./production-files-control.js";
import { PRODUCTION_HOME_OPERATIONS, ProductionHomeControl } from "./production-home.js";
import { productionInbox } from "./production-inbox-composition.js";
import { type InboxRunRegistry, ProductionInboxDelivery } from "./production-inbox-delivery.js";
import {
  PRODUCTION_INBOX_OPERATIONS,
  ProductionInboxControl,
  ProductionInboxSettings,
} from "./production-inbox-settings.js";
import type { InboxDelivery } from "./production-inbox-worker.js";
import {
  PRODUCTION_LOGIN_DEVICE_OPERATIONS,
  ProductionLoginDevicesControl,
} from "./production-login-devices-control.js";
import { ProductionMainThread } from "./production-main-thread.js";
import {
  McpConnectionAddresses,
  PRODUCTION_MCP_CONNECTION_OPERATIONS,
  ProductionMcpConnectionsControl,
  registerMcpConnectionAddressRoute,
} from "./production-mcp-connections-control.js";
import type { ProductionMcpMemoryWriter } from "./production-mcp-memory-writer.js";
import { type ProductionMcpRead, registerMcpReadRoute } from "./production-mcp-read.js";
import type { ProductionMemoryClassifier } from "./production-memory-classification.js";
import type { ProductionQueryPrefetch } from "./production-memory-composition.js";
import {
  PRODUCTION_MEMORY_OPERATIONS,
  ProductionMemoryControl,
} from "./production-memory-control.js";
import { ProductionMemoryInbox } from "./production-memory-inbox.js";
import { flushSensitiveInterceptions } from "./production-model-egress.js";
import {
  PRODUCTION_OBSERVATION_OPERATIONS,
  type ProductionObservation,
} from "./production-observation.js";
import {
  PRODUCTION_OWNER_PREFERENCE_OPERATIONS,
  ProductionOwnerPreferencesControl,
} from "./production-owner-preferences-control.js";
import { ProductionOwnerRuleWriter } from "./production-owner-rules.js";
import {
  PRODUCTION_PERCEPTION_OPERATIONS,
  ProductionPerceptionControl,
} from "./production-perception-control.js";
import type { ProductionPerceptionInbox } from "./production-perception-inbox.js";
import {
  PROACTIVE_GOOGLE_CALLBACK_PATH,
  PROACTIVE_GOOGLE_START_PATH,
  PRODUCTION_PROACTIVE_OPERATIONS,
  type ProductionProactive,
} from "./production-proactive.js";
import {
  PRODUCTION_QUIET_HOURS_OPERATIONS,
  ProductionQuietHoursControl,
} from "./production-quiet-hours-control.js";
import type { ProductionReminderInbox } from "./production-reminder-inbox.js";
import {
  PRODUCTION_SEARCH_OPERATIONS,
  ProductionSearchControl,
  type ProductionSearchOptions,
} from "./production-search.js";
import {
  PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS,
  ProductionSensitiveInterceptionsControl,
} from "./production-sensitive-interceptions-control.js";
import {
  PRODUCTION_SERVER_STATUS_OPERATIONS,
  ProductionServerStatusControl,
} from "./production-server-status-control.js";
import {
  DEFAULT_TIMER_TIME_ZONE,
  localTime,
  type ProductionSubthreads,
} from "./production-subthreads.js";
import { ThreadDeletionRetry } from "./production-thread-deletion-retry.js";
import {
  PRODUCTION_TIMER_OPERATIONS,
  ProductionTimerControl,
  type TimerReminders,
} from "./production-timer-control.js";
import { type ProductionWebPush, WebPushPresence } from "./production-web-push.js";
import {
  PRODUCTION_WEB_PUSH_OPERATIONS,
  ProductionWebPushControl,
} from "./production-web-push-control.js";
import {
  createProductionWorkspaceCopies,
  PRODUCTION_COPY_OPERATIONS,
} from "./production-workspace-copies.js";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];
type ProductAuthorityFence = ThreadCreateInput["authority"];

export const PRODUCTION_HTTP_COMPOSITION_ERROR_CODES = Object.freeze({
  CONFIGURATION_INCOMPLETE: "PRODUCTION_HTTP_CONFIGURATION_INCOMPLETE",
  AUTHORITY_INVALID: "PRODUCTION_HTTP_AUTHORITY_INVALID",
  STATIC_ROOT_INVALID: "PRODUCTION_HTTP_STATIC_ROOT_INVALID",
  SECRET_REFERENCE_INVALID: "PRODUCTION_HTTP_SECRET_REFERENCE_INVALID",
  SECRET_MATERIAL_INVALID: "PRODUCTION_HTTP_SECRET_MATERIAL_INVALID",
  SESSION_INVALID: "PRODUCTION_HTTP_SESSION_INVALID",
} as const);

export type ProductionHttpCompositionErrorCode =
  (typeof PRODUCTION_HTTP_COMPOSITION_ERROR_CODES)[keyof typeof PRODUCTION_HTTP_COMPOSITION_ERROR_CODES];

export class ProductionHttpCompositionError extends Error {
  readonly code: ProductionHttpCompositionErrorCode;

  constructor(code: ProductionHttpCompositionErrorCode) {
    super(code);
    this.name = "ProductionHttpCompositionError";
    this.code = code;
  }
}

const GATEWAY_COMMAND_PATH = /^\/api\/gateway\/(?:v1|v2|thread\/v3)\/commands$/u;

export interface ProductionHttpCompositionSecretSources {
  readonly provider: HostProviderSecretSource;
  readonly keys: HostSecretMaterialSource;
}

export interface ProductionHttpCompositionOptions {
  readonly messageOptions?: ThreadMessageOptionsPort;
  readonly capabilityReactivation?: CapabilityReactivationVerifierPort;
  readonly listenUnixSocketPath?: string;
  readonly modelCatalog?: readonly {
    ref: string;
    model: string;
    name: string;
    provider: string;
    thinkingLevels: readonly string[];
    images: boolean;
    automatic?: boolean;
    price?: { input: number; output: number };
    priceTier?: "low" | "mid" | "high";
  }[];
  readonly live?: Pick<ExecutionLiveFeed, "subscribe" | "current">;
  readonly cancelRun?: (
    input: Pick<CancelCoordinatedRunInput, "runId" | "command">,
  ) => Promise<void>;
  readonly onCommandAccepted?: (path: string) => void;
  readonly onSlowRequest?: (request: HttpGatewaySlowRequest) => void;
  readonly onDeviceAuditFailed?: (failure: DeviceGatewayAuditFailure) => void;
  readonly onSearchIndexDiagnostic?: (event: Record<string, string>) => void;
  readonly deviceActions?: {
    readonly service: DeviceActionService;
    readonly hub: DeviceActionHub;
  };
  readonly vault?: VaultService;
  readonly deviceNotifications?: {
    readonly hub: DeviceNotificationHub;
    readonly presence: DevicePresence;
    readonly settled: (ids: readonly string[]) => Promise<readonly string[]>;
  };
  readonly onDeviceWarning?: (warning: PairedDeviceWarning) => void;
  readonly onDevicePushFailed?: (error: unknown) => void;
  readonly onHomeDiagnostic?: (event: Record<string, string>) => void;
  readonly onPerceptionLimitWarning?: (warning: PerceptionLimitWarning) => void;
  readonly health?: RuntimeHealthModel;
  readonly executionEnvironment?: {
    readonly mode: ThreadExecutionEnvironment["mode"];
    readonly unavailableTools: () => Promise<ThreadExecutionEnvironment["unavailableTools"]>;
  };
  readonly memory?: {
    readonly search?: {
      readonly provider: ProductionSearchOptions["provider"];
      readonly episodes?: ProductionSearchOptions["episodes"];
    };
    readonly service: Pick<
      DurableMemoryService,
      | "applyProposal"
      | "correct"
      | "delete"
      | "restore"
      | "restoreVersion"
      | "confirm"
      | "revise"
      | "trash"
      | "recover"
      | "archive"
    >;
    readonly externalProposals?: ProductionMcpMemoryWriter;
    readonly mcpSync?: McpMemorySyncStorePort;
    readonly actionRules?: Pick<BuiltInActionRuleSwitches, "list" | "setAskFirst">;
    readonly allowances?: Pick<OwnerAllowances, "list" | "days">;
    readonly classifier?: Pick<ProductionMemoryClassifier, "classify">;
    readonly importDuplicates?: NonNullable<
      ConstructorParameters<typeof ProductionMemoryControl>[0]["importDuplicates"]
    >;
    readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  };
  readonly webPush?: {
    readonly presence: WebPushPresence;
    readonly push: ProductionWebPush | undefined;
    readonly applePush?: ProductionApplePush;
  };
  readonly proactive?: ProductionProactive;
  readonly inbox?: {
    readonly delivery?: InboxDelivery;
    readonly mainThread?: {
      readonly registry: InboxRunRegistry;
      readonly externalContent: Pick<ContextExternalContent, "mark">;
      readonly subthreads?: ProductionSubthreads;
      readonly reminders?: ProductionReminderInbox;
      readonly perception?: ProductionPerceptionInbox;
      readonly timerReminders?: TimerReminders;
      readonly timeZone?: string;
    };
    readonly onDiagnostic?: (event: Record<string, string>) => void;
  };
  readonly threadDeletionDiagnostic?: (event: Record<string, string>) => void;
  readonly queryPrefetch?: ProductionQueryPrefetch;
  readonly mcpRead?: ProductionMcpRead;
  readonly observation?: ProductionObservation;
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
  readonly authority: () => ProductAuthorityFence;
  readonly executionAuthority?: () => import("@himawari-agent/application").AuthorityFence;
  readonly secretSources: ProductionHttpCompositionSecretSources;
  readonly jwksFetcher?: JwksFetcher;
  readonly identityFetcher?: CloudflareAccessIdentityFetcher;
  readonly now?: () => Date;
  readonly createSessionId?: ProductSessionAuthenticationServiceOptions["createSessionId"];
  readonly createDeviceId?: ProductSessionAuthenticationServiceOptions["createDeviceId"];
  readonly createSessionToken?: () => string;
}

export interface ProductionHttpComposition {
  readonly app: FastifyInstance;
  readonly authentication: HttpGatewayAuthenticationPort;
  assertIdentityReady(): Promise<void>;
  readonly csrf: SessionBoundCsrfService;
  readonly recentAuthentication: RecentAuthenticationGuard;
  readonly threadGateway: AgentThreadGatewayService;
  readonly threadAccess: ThreadGatewayAccessPolicyPort;
  readonly payloadProtector: PayloadProtectorPort;
  readonly payloadAdmission: HttpGatewayPayloadAdmissionPort;
  readonly health: RuntimeHealthModel;
  readonly metrics: RuntimeMetricsRegistry;
  readonly home: Pick<ProductionHomeControl, "awaitingCount">;
  readonly perception: Pick<PerceptionService, "reserveModelCost">;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function compositionError(code: ProductionHttpCompositionErrorCode): never {
  throw new ProductionHttpCompositionError(code);
}

function configuredSecret(
  configuration: ProductConfiguration,
  ref: string,
  purpose: string,
): { readonly ref: string; readonly version: string } {
  const matches = configuration.secretReferences.filter((entry) => entry.ref === ref);
  if (matches.length !== 1 || matches[0]?.purpose !== purpose) {
    return compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.SECRET_REFERENCE_INVALID);
  }
  const match = matches[0];
  if (!match)
    return compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.SECRET_REFERENCE_INVALID);
  return match;
}

function soleSecret(
  configuration: ProductConfiguration,
  purpose: string,
): { readonly ref: string; readonly version: string } {
  const matches = configuration.secretReferences.filter((entry) => entry.purpose === purpose);
  if (matches.length !== 1 || !matches[0]) {
    return compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.SECRET_REFERENCE_INVALID);
  }
  return matches[0];
}

function assertAbsoluteDirectoryPath(value: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.STATIC_ROOT_INVALID);
  }
}

function assertProductionConfiguration(configuration: ProductConfiguration): void {
  const http = configuration.http;
  const identity = configuration.identity;
  if (!http || !identity) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }
  if (
    (http.listenHost !== "127.0.0.1" && http.listenHost !== "::1") ||
    !Number.isSafeInteger(http.listenPort) ||
    http.listenPort < 0 ||
    http.listenPort > 65_535 ||
    !Number.isSafeInteger(http.maximumBodyBytes) ||
    http.maximumBodyBytes < 1 ||
    http.maximumBodyBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(http.maximumStaticAssetBytes) ||
    http.maximumStaticAssetBytes < 1 ||
    http.maximumStaticAssetBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(http.heartbeatMilliseconds) ||
    http.heartbeatMilliseconds < 10 ||
    http.heartbeatMilliseconds > 300_000
  ) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }
  if (identity.kind === "built-in") {
    const origin = new URL(configuration.publicOrigin);
    if (
      origin.origin !== configuration.publicOrigin ||
      (origin.protocol !== "https:" &&
        !(
          !configuration.publicMode &&
          origin.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)
        ))
    ) {
      compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
    }
    return;
  }
  let publicOrigin: URL;
  let issuer: URL;
  let jwksUrl: URL;
  try {
    publicOrigin = new URL(configuration.publicOrigin);
    issuer = new URL(identity.issuer);
    jwksUrl = new URL(identity.jwksUrl);
  } catch {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.origin !== configuration.publicOrigin ||
    issuer.protocol !== "https:" ||
    issuer.origin !== identity.issuer ||
    issuer.username ||
    issuer.password ||
    (issuer.pathname !== "/" && issuer.pathname !== "") ||
    jwksUrl.protocol !== "https:" ||
    jwksUrl.username ||
    jwksUrl.password ||
    jwksUrl.search ||
    jwksUrl.hash ||
    jwksUrl.href !== new URL("/cdn-cgi/access/certs", issuer.origin).href
  ) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }
}

async function assertStaticArtifactRoot(staticRoot: string): Promise<void> {
  assertAbsoluteDirectoryPath(staticRoot);
  const root = await lstat(staticRoot).catch(() => undefined);
  const index = await lstat(path.join(staticRoot, "index.html")).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink() || !index?.isFile() || index.isSymbolicLink()) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.STATIC_ROOT_INVALID);
  }
}

function scopedIdentityState(
  delegate: OwnerIdentityStatePort,
  ownerId: OwnerId,
): OwnerIdentityStatePort {
  const assertOwner = (candidate: OwnerId): void => {
    if (candidate !== ownerId) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.OWNER_NOT_BOUND);
    }
  };
  const scoped: OwnerIdentityStatePort = {
    bindFirstOwner: async (input: Parameters<OwnerIdentityStatePort["bindFirstOwner"]>[0]) => {
      assertOwner(input.ownerId);
      return delegate.bindFirstOwner(input);
    },
    readBySubject: async (externalSubjectRef: string) => {
      const binding = await delegate.readBySubject(externalSubjectRef);
      return binding?.ownerId === ownerId ? binding : undefined;
    },
    readByOwner: async (candidate: OwnerId) => {
      if (candidate !== ownerId) return undefined;
      return delegate.readByOwner(candidate);
    },
    repairBinding: async (input: Parameters<OwnerIdentityStatePort["repairBinding"]>[0]) => {
      assertOwner(input.ownerId);
      return delegate.repairBinding(input);
    },
  };
  return Object.freeze(scoped);
}

function activeSession(
  sessionState: SessionDeviceStatePort,
  authentication: GatewayAuthenticationContext,
  ownerId: OwnerId,
): Promise<Awaited<ReturnType<SessionDeviceStatePort["findSessionByAuthenticationRef"]>>> {
  return sessionState
    .findSessionByAuthenticationRef(authentication.authenticationRef)
    .then((session) => {
      if (
        !session ||
        session.status !== "active" ||
        session.ownerId !== ownerId ||
        session.deviceId !== authentication.deviceId ||
        authentication.subjectId !== ownerId
      ) {
        return undefined;
      }
      return session;
    });
}

export class ProductionThreadGatewayAccessPolicy implements ThreadGatewayAccessPolicyPort {
  readonly #ownerId: OwnerId;
  readonly #agentId: AgentId;
  readonly #sessions: SessionDeviceStatePort;

  constructor(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly sessions: SessionDeviceStatePort;
  }) {
    this.#ownerId = input.ownerId;
    this.#agentId = input.agentId;
    this.#sessions = input.sessions;
  }

  async authorize(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly message: ThreadGatewayInboundMessage | GatewayV2InboundMessage;
  }): Promise<GatewayAccessDecision> {
    if (
      input.message.scope.ownerId !== this.#ownerId ||
      input.message.scope.agentId !== this.#agentId ||
      input.authentication.ownerId !== this.#ownerId ||
      input.authentication.subjectId !== input.message.actor.actorId
    ) {
      return { allowed: false, reasonCode: "THREAD_SCOPE_MISMATCH" };
    }
    const session = await activeSession(this.#sessions, input.authentication, this.#ownerId);
    if (!session) return { allowed: false, reasonCode: "SESSION_INACTIVE" };
    if (
      input.message.kind === "command" &&
      ["thread.message.submit", "thread.message.submit_configured"].includes(input.message.type) &&
      "sessionId" in input.message.payload &&
      input.message.payload.sessionId !== session.id
    ) {
      return { allowed: false, reasonCode: "SESSION_SCOPE_MISMATCH" };
    }
    return { allowed: true, reasonCode: "OWNER_SESSION_AUTHORIZED" };
  }
}

export async function resolveDevicePairingAccess(
  secretReferences: readonly {
    readonly ref: string;
    readonly version: string;
    readonly purpose: string;
  }[],
  resolve: (ref: string, version: string) => Promise<string>,
): Promise<DevicePairingAccess | undefined> {
  const [clientIdReference, clientSecretReference] = DEVICE_ACCESS_SECRET_PURPOSES.map((purpose) =>
    secretReferences.find((entry) => entry.purpose === purpose),
  );
  if (!clientIdReference || !clientSecretReference) return undefined;
  const clientId = await resolve(clientIdReference.ref, clientIdReference.version);
  const clientSecret = await resolve(clientSecretReference.ref, clientSecretReference.version);
  for (const value of [clientId, clientSecret])
    if (!isDeviceAccessText(value))
      compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.SECRET_MATERIAL_INVALID);
  return { clientId, clientSecret };
}

export class ProductionHttpPayloadAdmission implements HttpGatewayPayloadAdmissionPort {
  readonly #ownerId: OwnerId;
  readonly #agentId: AgentId;
  readonly #sessions: SessionDeviceStatePort;
  readonly #payloads: PayloadStorePort;
  readonly #protector: PayloadProtectorPort;
  readonly #clock: () => string;

  constructor(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly sessions: SessionDeviceStatePort;
    readonly payloads: PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly clock: () => string;
  }) {
    this.#ownerId = input.ownerId;
    this.#agentId = input.agentId;
    this.#sessions = input.sessions;
    this.#payloads = input.payloads;
    this.#protector = input.protector;
    this.#clock = input.clock;
  }

  async protect(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
    readonly contentType: HttpGatewayPayloadContentType;
  }): Promise<{ readonly payloadRef: string }> {
    const session = await activeSession(this.#sessions, input.authentication, this.#ownerId);
    if (!session || input.authentication.ownerId !== this.#ownerId) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Payload admission requires the active scoped session",
      );
    }
    const payloadRef = `payload:http:${sha256(
      `${input.authentication.authenticationRef}\u0000${input.idempotencyKey}`,
    )}`;
    const contentDigest = `sha256:${sha256(new TextEncoder().encode(input.content))}`;
    const existing = await this.#payloads.get(payloadRef);
    if (existing) {
      if (
        existing.contentDigest !== contentDigest ||
        existing.dataClassification !== input.dataClassification ||
        existing.contentType !== input.contentType
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Payload idempotency key was reused with different content",
        );
      }
      return Object.freeze({ payloadRef });
    }
    const payload = await this.#protector.protect({
      ownerId: this.#ownerId,
      agentId: this.#agentId,
      ref: payloadRef,
      dataClassification: input.dataClassification,
      contentType: input.contentType,
      plaintext: new TextEncoder().encode(input.content),
      createdAt: this.#clock(),
    });
    try {
      await this.#payloads.put(payload);
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE) {
        throw error;
      }
      const concurrent = await this.#payloads.get(payloadRef);
      if (
        !concurrent ||
        concurrent.contentDigest !== contentDigest ||
        concurrent.dataClassification !== input.dataClassification ||
        concurrent.contentType !== input.contentType
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Payload idempotency key was reused with different content",
        );
      }
    }
    return Object.freeze({ payloadRef });
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorityForConfiguration(
  configuration: ProductConfiguration,
  authority: ProductAuthorityFence,
): ProductAuthorityFence {
  if (
    authority.deploymentId !== configuration.deploymentId ||
    !Number.isSafeInteger(authority.authorityEpoch) ||
    authority.authorityEpoch < 1 ||
    !Number.isSafeInteger(authority.fencingToken) ||
    authority.fencingToken < 1
  ) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.AUTHORITY_INVALID);
  }
  return authority;
}

export function registerProactiveRoutes(
  app: FastifyInstance,
  proactive: ProductionProactive,
  input: {
    readonly authentication: HttpGatewayAuthenticationPort;
    readonly sessionCookieName: string;
    readonly ownerId: string;
  },
): void {
  const owner = async (request: FastifyRequest) => {
    const authentication = await authenticateHttpRequest(request, input).catch(() => undefined);
    return authentication && authentication.ownerId === input.ownerId
      ? `${authentication.subjectId}:${authentication.deviceId}`
      : undefined;
  };
  const settingsPage = (reply: FastifyReply, outcome: string) =>
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(`/?settings=apps&gmail=${outcome}`, 303);
  app.get(PROACTIVE_GOOGLE_START_PATH, async (request, reply) => {
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none")
      return reply.code(403).header("cache-control", "no-store").send();
    const subject = await owner(request);
    if (!subject) return reply.code(401).header("cache-control", "no-store").send();
    return reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(proactive.beginAuthorization(subject), 303);
  });
  app.get(PROACTIVE_GOOGLE_CALLBACK_PATH, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const text = (key: string) =>
      typeof query[key] === "string" && (query[key] as string).length <= 2048
        ? (query[key] as string)
        : null;
    const subject = await owner(request);
    if (!subject) {
      if (query["return"] !== undefined) return settingsPage(reply, "failed");
      const sameSiteReturn = new URLSearchParams({ return: "1" });
      for (const key of ["state", "code", "error"]) {
        const value = text(key);
        if (value !== null) sameSiteReturn.set(key, value);
      }
      return reply
        .code(200)
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", "default-src 'none'; base-uri 'none'")
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0;url=${escapeHtmlAttribute(`${PROACTIVE_GOOGLE_CALLBACK_PATH}?${sameSiteReturn}`)}"><title>Himawari</title>`,
        );
    }
    return settingsPage(
      reply,
      await proactive.completeAuthorization({
        owner: subject,
        state: text("state"),
        code: text("code"),
        error: text("error"),
      }),
    );
  });
}

function routeOptions(
  configuration: ProductConfiguration,
  identity: HttpGatewayAuthenticationPort,
  csrf: SessionBoundCsrfService,
  recentAuthentication: RecentAuthenticationGuard,
  threadGateway: AgentThreadGatewayService,
  payloadAdmission: ProductionHttpPayloadAdmission,
  payloadRead: BrowserTextPayloadReader,
  health: RuntimeHealthModel,
  metrics: RuntimeMetricsRegistry,
  authority: ProductAuthorityFence,
  modelCatalog: ProductionHttpCompositionOptions["modelCatalog"],
  canCancelRun: boolean,
  workspaceCopiesAvailable: boolean,
  executionEnvironmentAvailable: boolean,
  memoryAvailable: boolean,
  proactiveAvailable: boolean,
  observationAvailable: boolean,
  mcpConnectionsAvailable: boolean,
  searchAvailable: boolean,
  capabilityReactivationAvailable: boolean,
  timersAvailable: boolean,
): HttpGatewayServerOptions {
  const http = configuration.http;
  if (!http || !configuration.identity) {
    return compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }
  const primary = configuration.modelDescriptors.find(({ role }) => role === "primary");
  return {
    threadGateway,
    authentication: identity,
    recentAuthentication,
    csrf,
    publicOrigin: configuration.publicOrigin,
    staticRoot: http.staticRoot,
    sessionCookieName: http.sessionCookieName,
    maximumBodyBytes: http.maximumBodyBytes,
    maximumStaticAssetBytes: http.maximumStaticAssetBytes,
    heartbeatMilliseconds: http.heartbeatMilliseconds,
    health,
    metrics,
    browserConfiguration: {
      executionPresentationAvailable: true,
      executionStateAvailable: true,
      executionEventsAvailable: true,
      executionEnvironmentAvailable,
      canCancelRun,
      availableModels: modelCatalog ?? [],
      installedGatewayV2Operations: [
        ...PRODUCTION_APPROVAL_OPERATIONS,
        ...(workspaceCopiesAvailable ? PRODUCTION_COPY_OPERATIONS : []),
        ...(memoryAvailable ? PRODUCTION_MEMORY_OPERATIONS : []),
        ...PRODUCTION_WEB_PUSH_OPERATIONS,
        ...(proactiveAvailable ? PRODUCTION_PROACTIVE_OPERATIONS : []),
        ...(observationAvailable ? PRODUCTION_OBSERVATION_OPERATIONS : []),
        ...PRODUCTION_OWNER_PREFERENCE_OPERATIONS,
        ...(memoryAvailable ? PRODUCTION_QUIET_HOURS_OPERATIONS : []),
        ...PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS,
        ...PRODUCTION_SERVER_STATUS_OPERATIONS,
        ...PRODUCTION_CAPABILITY_OPERATIONS,
        ...(capabilityReactivationAvailable ? PRODUCTION_CAPABILITY_REACTIVATION_OPERATIONS : []),
        ...PRODUCTION_DEVICE_OPERATIONS,
        ...PRODUCTION_HOME_OPERATIONS,
        ...(searchAvailable ? PRODUCTION_SEARCH_OPERATIONS : []),
        ...PRODUCTION_DATA_EXPORT_OPERATIONS,
        ...PRODUCTION_FILES_OPERATIONS,
        ...PRODUCTION_LOGIN_DEVICE_OPERATIONS,
        ...(mcpConnectionsAvailable ? PRODUCTION_MCP_CONNECTION_OPERATIONS : []),
        ...PRODUCTION_PERCEPTION_OPERATIONS,
        ...PRODUCTION_INBOX_OPERATIONS,
        ...(timersAvailable ? PRODUCTION_TIMER_OPERATIONS : []),
      ],
      agentId: configuration.agentId,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      ...(primary && primary.role !== "embedding"
        ? {
            primaryModel: {
              provider: primary.provider,
              model: primary.model,
              version: primary.version,
            },
            primaryModelRef: primary.ref,
          }
        : {}),
      repositoryAllowlistRefs: configuration.repositoryAllowlistRefs,
      disclosedDataClassifications: ["private"],
    },
    payloadAdmission,
    payloadRead,
  };
}

export async function createProductionHttpComposition(
  options: ProductionHttpCompositionOptions,
): Promise<ProductionHttpComposition> {
  const { configuration, repository, secretSources } = options;
  const unixSocketPath = options.listenUnixSocketPath;
  let unixSocketIdentity: UnixSocketIdentity | undefined;
  if (unixSocketPath !== undefined) {
    if (!path.isAbsolute(unixSocketPath) || path.normalize(unixSocketPath) !== unixSocketPath)
      compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
    assertUnixSocketPathLength(unixSocketPath);
  }
  const httpConfiguration = configuration.http;
  const identityConfiguration = configuration.identity;
  if (
    !httpConfiguration ||
    !identityConfiguration ||
    (!configuration.publicMode && identityConfiguration.kind !== "built-in")
  ) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }
  assertProductionConfiguration(configuration);
  assertProductionSecretSource(secretSources.provider);
  assertProductionSecretSource(secretSources.keys);
  await assertStaticArtifactRoot(httpConfiguration.staticRoot);
  const authority = authorityForConfiguration(configuration, options.authority());
  const now = options.now ?? (() => new Date());
  const clock = () => now().toISOString();
  const ownerId = configuration.ownerId;
  const agentId = configuration.agentId;
  const identityState = scopedIdentityState(repository.ownerIdentityState(), ownerId);
  const sessionsState = repository.sessionDeviceState();
  const deviceConfiguration = configuration.runPolicy?.device ?? {
    ...DEVICE_CONFIGURATION_DEFAULTS,
    limits: defaultDeviceHardLimits(),
  };
  const chatModel = configuration.modelDescriptors.find(
    (descriptor) => descriptor.role === "primary",
  );
  const chatAttachments = Object.freeze({
    images:
      options.modelCatalog?.find((entry) => entry.ref === chatModel?.ref)?.images ??
      chatModel?.input.includes("image") ??
      false,
  });
  const devicePairingAccess = await resolveDevicePairingAccess(
    configuration.secretReferences,
    (ref, version) => secretSources.provider.resolve(ref, version),
  );
  const speech = createProductionSpeech(configuration, (ref, version) =>
    secretSources.provider.resolve(ref, version),
  );
  const payloadKey = soleSecret(configuration, "payload-encryption");
  const payloadProtector = new EnvelopePayloadProtector({
    keys: secretSources.keys,
    activeKey: { keyRef: payloadKey.ref, kekVersion: payloadKey.version, dekVersion: "dek-v1" },
  });
  const recordVoiceTiming = deviceVoiceTimingRecorder({
    ownerId,
    agentId,
    trace: repository.traceStore(),
    payloads: repository.payloadStore(ownerId, agentId),
    protector: payloadProtector,
    now: clock,
  });
  const csrfKeyRef = configuredSecret(
    configuration,
    identityConfiguration.csrf.keySecretRef,
    "identity-csrf",
  );
  const csrfKey = await secretSources.keys.resolve(csrfKeyRef.ref, csrfKeyRef.version);
  if (csrfKey.byteLength < 32) {
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.SECRET_MATERIAL_INVALID);
  }
  let authentication: HttpGatewayAuthenticationPort;
  let assertIdentityReady: () => Promise<void>;
  let registerAuthentication: (
    app: FastifyInstance,
    csrf: SessionBoundCsrfService,
    guard: RecentAuthenticationGuard,
  ) => void;
  if (identityConfiguration.kind === "built-in") {
    const native = new BuiltInAuthenticationService({
      ownerId,
      state: repository.builtInIdentityState(ownerId, agentId),
      policy: identityConfiguration,
      now,
      readFactor: async (ref) => {
        const payload = await repository.payloadStore(ownerId, agentId).get(ref);
        if (
          !payload ||
          payload.dataClassification !== "restricted" ||
          payload.contentType !== "application/vnd.himawari.identity-factor"
        )
          throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.SESSION_INVALID);
        return payloadProtector.unprotect({ ownerId, agentId, payload });
      },
    });
    authentication = native;
    assertIdentityReady = () => native.assertReady();
    registerAuthentication = (app, csrf, recentAuthentication) =>
      registerBuiltInIdentityRoutes(app, {
        publicOrigin: configuration.publicOrigin,
        sessionCookieName: httpConfiguration.sessionCookieName,
        sessions: native,
        state: sessionsState,
        csrf,
        recentAuthentication,
        now,
        sessionAbsoluteMilliseconds: identityConfiguration.sessionAbsoluteMilliseconds,
      });
  } else {
    const bootstrap = identityConfiguration.bootstrap;
    let bootstrapTokenDigest = "";
    if (bootstrap.enabled) {
      if (bootstrap.tokenSecretRef === null) {
        compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.SECRET_REFERENCE_INVALID);
      }
      const bootstrapSecret = configuredSecret(
        configuration,
        bootstrap.tokenSecretRef,
        "identity-bootstrap",
      );
      bootstrapTokenDigest = digestIdentityCredential(
        await secretSources.provider.resolve(bootstrapSecret.ref, bootstrapSecret.version),
      );
    }
    const jwksFetcher =
      options.jwksFetcher ??
      new BoundedJwksFetcher({
        allowedUrl: identityConfiguration.jwksUrl,
        timeoutMilliseconds: identityConfiguration.jwksTimeoutMilliseconds,
        maximumBodyBytes: identityConfiguration.jwksMaximumBodyBytes,
      });
    const verifier = new AccessJwtVerifier({
      issuer: identityConfiguration.issuer,
      audience: identityConfiguration.audience,
      jwksUrl: identityConfiguration.jwksUrl,
      jwksFetcher,
      now,
      cacheMilliseconds: identityConfiguration.jwksCacheMilliseconds,
      clockToleranceSeconds: identityConfiguration.clockToleranceSeconds,
    });
    const identity = new CloudflareAccessIdentityClient({
      issuer: identityConfiguration.issuer,
      subjectBinding: "user_uuid_equals_sub",
      ...(options.identityFetcher === undefined ? {} : { fetcher: options.identityFetcher }),
      now,
      timeoutMilliseconds: identityConfiguration.identityLookupTimeoutMilliseconds,
      maximumBodyBytes: identityConfiguration.identityLookupMaximumBodyBytes,
    });
    const externalAuthentication = new ProductSessionAuthenticationService({
      verifier,
      identityState,
      sessionState: sessionsState,
      recentAuthenticationProvider: identity,
      now,
      ...(options.createSessionId === undefined
        ? {}
        : { createSessionId: options.createSessionId }),
      ...(options.createDeviceId === undefined ? {} : { createDeviceId: options.createDeviceId }),
      createToken: options.createSessionToken ?? (() => randomBytes(32).toString("base64url")),
    });
    const bootstrapService = new OwnerBootstrapService({
      enabled: bootstrap.enabled,
      expiresAt: bootstrap.expiresAt,
      tokenDigest: bootstrapTokenDigest,
      identityState,
      now,
    });
    authentication = externalAuthentication;
    assertIdentityReady = () => verifier.assertReady();
    registerAuthentication = (app) =>
      registerIdentityAuthenticationRoutes(app, {
        publicOrigin: configuration.publicOrigin,
        verifier,
        bootstrap: bootstrapService,
        sessions: externalAuthentication,
        sessionCookieName: httpConfiguration.sessionCookieName,
      });
  }
  const csrf = new SessionBoundCsrfService({
    key: new Uint8Array(csrfKey),
    now,
    ttlMilliseconds: identityConfiguration.csrf.ttlMilliseconds,
  });
  const recentAuthentication = new RecentAuthenticationGuard({
    identityState,
    sessionState: sessionsState,
    policy: identityConfiguration.recentAuthentication,
    now: clock,
  });
  const threads = repository.threadRepository();
  const threadCommands = new ThreadCommandService({
    repository: threads,
    clock: { now: clock },
    authority: () => authorityForConfiguration(configuration, options.authority()),
  });
  const threadDeletion = new ThreadDeletionCoordinationService({
    repository: threads,
    clock: { now: clock },
    authority: () => authorityForConfiguration(configuration, options.authority()),
    recentAuthentication,
  });
  const mainThread = new ProductionMainThread({
    ownerId,
    agentId,
    threads,
    commands: threadCommands,
    payloads: repository.payloadStore(ownerId, agentId),
    protector: payloadProtector,
    clock: { now: clock },
  });
  const environment = options.executionEnvironment;
  const backgroundWork = options.inbox?.mainThread?.subthreads;
  const threadAdapter = new ProductThreadGatewayAdapter({
    ...(backgroundWork ? { backgroundWork: { read: () => backgroundWork.backgroundWork() } } : {}),
    ...(options.messageOptions ? { messageOptions: options.messageOptions } : {}),
    validateModelSelection: (selection, classification) => {
      const model = options.modelCatalog?.find((entry) => entry.ref === selection.modelRef);
      const descriptor = configuration.modelDescriptors.find(
        (entry) => entry.ref === selection.modelRef && entry.role !== "embedding",
      );
      if (
        !model ||
        !model.thinkingLevels.includes(selection.thinkingLevel) ||
        !descriptor?.allowedDataClassifications.some((value) => value === classification)
      )
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "MODEL_SELECTION_NOT_ALLOWED",
        );
    },
    ...(options.cancelRun ? { cancelRun: options.cancelRun } : {}),
    ...(options.live ? { live: options.live } : {}),
    execution: new ThreadExecutionProjection({
      threads,
      checkpoints: repository.runCheckpointStore(ownerId, agentId, authority),
      memories: repository.productMemoryState(),
      trace: repository.traceStore(),
      payloads: () => repository.payloadStore(ownerId, agentId),
      protector: payloadProtector,
      resources: {
        readInventory: async (scope) => {
          if (scope.ownerId !== ownerId || scope.agentId !== agentId)
            throw new ApplicationPortError(
              PORT_ERROR_CODES.NOT_AUTHORITATIVE,
              "THREAD_EXECUTION_RESOURCE_SCOPE_MISMATCH",
            );
          return repository
            .sandboxExecutionPreparations(ownerId, agentId)
            .readRunInventory({ runId: scope.runId });
        },
        now: clock,
        digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      },
    }),
    ...(environment
      ? {
          executionEnvironment: {
            read: async (scope: { ownerId: string; agentId: string }) => {
              if (scope.ownerId !== ownerId || scope.agentId !== agentId)
                throw new ApplicationPortError(
                  PORT_ERROR_CODES.NOT_AUTHORITATIVE,
                  "THREAD_EXECUTION_ENVIRONMENT_SCOPE_MISMATCH",
                );
              return readThreadExecutionEnvironment({
                programs: repository.sandboxExecutionPreparations(ownerId, agentId),
                mode: environment.mode,
                unavailableTools: environment.unavailableTools,
              });
            },
          },
        }
      : {}),
    repository: threads,
    checkpoints: repository.threadDistillationState(),
    commands: threadCommands,
    queries: new ThreadQueryService(threads),
    forks: new ThreadForkService({
      repository: threads,
      clock: { now: clock },
      authority: () => authorityForConfiguration(configuration, options.authority()),
    }),
    deletion: threadDeletion,
    mainThread,
    clock: { now: clock },
  });
  const threadAccess = new ProductionThreadGatewayAccessPolicy({
    ownerId,
    agentId,
    sessions: sessionsState,
  });
  const threadGateway = new AgentThreadGatewayService({
    access: threadAccess,
    controlPlane: threadAdapter,
    reads: threadAdapter,
  });
  const payloadAdmission = new ProductionHttpPayloadAdmission({
    ownerId,
    agentId,
    sessions: sessionsState,
    payloads: repository.payloadStore(ownerId, agentId),
    protector: payloadProtector,
    clock,
  });
  const payloadRead = new BrowserTextPayloadReader({
    payloads: () => repository.payloadStore(ownerId, agentId),
    protector: payloadProtector,
  });
  const files = new BrowserThreadFiles({
    ownerId,
    agentId,
    store: repository.threadArtifacts(),
    payloads: () => repository.payloadStore(ownerId, agentId),
    protector: payloadProtector,
    ...(httpConfiguration.previewOrigin ? { previewOrigin: httpConfiguration.previewOrigin } : {}),
    ticketKey: createHmac("sha256", csrfKey).update("himawari.file-preview.key.v1").digest(),
    now: clock,
    commandKey: backgroundCommandRef,
  });
  const searchKey = createHmac("sha256", csrfKey).update("himawari.search.key.v2").digest();
  const searchTokenizer = new ScopedThreadSearchTokenizer({
    keys: { resolve: async () => searchKey },
    projectionVersion: `thread-search-v2:${createHash("sha256").update(searchKey).digest("hex").slice(0, 24)}`,
  });
  const reportSearchIndex = (event: string, error: unknown, extra: Record<string, string> = {}) =>
    options.onSearchIndexDiagnostic?.({
      event,
      ...extra,
      error: error instanceof Error ? error.message : String(error),
    });
  const searchProjector = new ThreadSearchProjector({
    sources: repository.threadSearchProjectionSource(),
    threads,
    reader: payloadRead,
    tokenizer: searchTokenizer,
    onSourceSkipped: (source, error) =>
      reportSearchIndex("thread_search.source_skipped", error, {
        threadId: source.threadId,
        kind: source.kind,
      }),
  });
  const threadSearch = new BrowserThreadSearchPreparer({
    tokenizer: searchTokenizer,
    payloadAdmission,
    synchronize: (input) => searchProjector.synchronize(input),
    onSynchronizeError: (error) => reportSearchIndex("thread_search.synchronize_failed", error),
  });
  const searchIndexer = new ThreadSearchBackgroundIndexer({
    synchronize: () =>
      searchProjector.synchronize({
        authentication: {
          subjectId: "thread-search-indexer",
          ownerId,
          deviceId: "thread-search-indexer",
          authenticatedAt: clock(),
          authenticationRef: "thread-search-indexer",
        },
        agentId,
      }),
    onError: (error) => reportSearchIndex("thread_search.background_failed", error),
    intervalMs: 5_000,
  });
  const health = options.health ?? new RuntimeHealthModel({ publicMode: true, now: clock });
  const metrics = new RuntimeMetricsRegistry({ now: clock });
  const workspaceCopies = options.executionAuthority
    ? await createProductionWorkspaceCopies({
        configuration,
        repository,
        protector: payloadProtector,
        authority: options.executionAuthority,
        clock: { now: clock },
      })
    : undefined;
  const memoryPayloads = repository.payloadStore(ownerId, agentId);
  const memoryJobs = repository.memoryProjectionJobs();
  const memoryTidyUp = options.memory
    ? new MemoryConsolidationService({
        store: repository.memoryConsolidation(),
        state: repository.productMemoryState(),
        memory: options.memory.service,
        generationFor: async (memoryId) =>
          (await memoryJobs.listByMemory(memoryId)).at(-1)?.generationId,
        readText: async () => undefined,
        storeText: async () => {
          throw new Error("MEMORY_CONSOLIDATION_WRITE_UNAVAILABLE");
        },
        now: clock,
      })
    : undefined;
  const inboxSettings = new ProductionInboxSettings({
    scope: { ownerId, agentId },
    store: repository.inbox(),
    configuration: configuration.runPolicy?.inbox,
    clock: { now: clock },
    enabled: options.inbox?.delivery !== undefined || options.inbox?.mainThread !== undefined,
  });
  const retentionDeletion = () =>
    new SqliteGovernedDeletionAdapter({
      stateRoot: configuration.stateRoot,
      databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
      ownerId,
      agentId,
      now: clock,
    });
  const ensureMainThread = () =>
    mainThread.ensure().then(
      () => undefined,
      (error: unknown) =>
        options.threadDeletionDiagnostic?.({
          code: "thread.main_ensure_failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
    );
  const threadDeletionRetry = new ThreadDeletionRetry({
    deletion: {
      retryIncompleteThreadDeletions: (input) =>
        retentionDeletion().retryIncompleteThreadDeletions(input),
      deleteLegacyThreads: (input) => retentionDeletion().deleteLegacyThreads(input),
    },
    ...(options.threadDeletionDiagnostic ? { onDiagnostic: options.threadDeletionDiagnostic } : {}),
  });
  const mainThreadInbox = options.inbox?.mainThread;
  const inboxDelivery =
    options.inbox?.delivery ??
    (mainThreadInbox
      ? new ProductionInboxDelivery({
          ownerId,
          agentId,
          mainThread,
          threads,
          commands: threadCommands,
          runs: repository.runLifecycle(ownerId, agentId, authority),
          ledger: repository.decisionLedger(),
          externalContent: mainThreadInbox.externalContent,
          registry: mainThreadInbox.registry,
          payloads: repository.payloadStore(ownerId, agentId),
          protector: payloadProtector,
          clock: { now: clock },
          ...(options.cancelRun ? { cancelRun: options.cancelRun } : {}),
          ...(mainThreadInbox.subthreads ? { subthreads: mainThreadInbox.subthreads } : {}),
          checkpoints: repository.runCheckpointStore(ownerId, agentId, authority),
          ...(mainThreadInbox.reminders ? { reminders: mainThreadInbox.reminders } : {}),
        })
      : undefined);
  const inbox = productionInbox({
    settings: inboxSettings,
    configuration,
    repository,
    payloads: memoryPayloads,
    protector: payloadProtector,
    clock,
    ...(inboxDelivery ? { delivery: inboxDelivery } : {}),
    ...(options.inbox?.onDiagnostic ? { onDiagnostic: options.inbox.onDiagnostic } : {}),
  });
  const reminderInbox = mainThreadInbox?.reminders;
  if (reminderInbox) {
    reminderInbox.registerSource(inbox.inbox.sources);
    reminderInbox.attach(inbox.inbox);
    reminderInbox.start();
  }
  const approvalRuns = repository.runLifecycle(ownerId, agentId, authority);
  const approvalAnswers = mainThreadInbox
    ? new ProductionApprovalAnswers({
        threadOf: async (runId) => (await approvalRuns.readRun(runId as never))?.run.threadId,
        mainThread,
      })
    : undefined;
  if (approvalAnswers) {
    approvalAnswers.registerSource(inbox.inbox.sources);
    approvalAnswers.attach(inbox.inbox);
  }
  const memoryInbox = mainThreadInbox
    ? new ProductionMemoryInbox({
        ownerId,
        agentId,
        state: repository.productMemoryState(),
        mainThread,
        formatTime: (iso) =>
          localTime(iso, options.inbox?.mainThread?.timeZone ?? DEFAULT_TIMER_TIME_ZONE),
        clock: { now: clock },
        onFailure: (error: unknown) =>
          options.inbox?.onDiagnostic?.({
            event: "inbox.memory_source_failed",
            error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
          }),
      })
    : undefined;
  if (memoryInbox) {
    memoryInbox.registerSource(inbox.inbox.sources);
    memoryInbox.attach(inbox.inbox);
  }
  const perceptionInbox = mainThreadInbox?.perception;
  if (perceptionInbox) {
    perceptionInbox.registerSource(inbox.inbox.sources);
    perceptionInbox.attach(inbox.inbox);
  }
  const subthreads = mainThreadInbox?.subthreads;
  if (subthreads) {
    subthreads.registerSources(inbox.inbox.sources);
    const cancelRun = options.cancelRun;
    subthreads.attach({
      inbox: inbox.inbox,
      ...(cancelRun
        ? {
            cancelThreadRuns: async (threadId: string) => {
              const runs = await threads.listRuns(ownerId, agentId, threadId as never);
              for (const run of runs)
                if (!["completed", "failed", "cancelled"].includes(run.status))
                  await cancelRun({
                    runId: run.runId,
                    command: {
                      idempotencyKey: `subthread-stop:${run.runId}` as never,
                      commandFingerprint: threadCommandFingerprint({
                        type: "subthread.stop",
                        runId: run.runId,
                      }),
                      payloadRef: run.runId as never,
                    },
                  }).catch(() => undefined);
            },
          }
        : {}),
    });
    subthreads.startTimers();
  }
  if (options.proactive) {
    inbox.inbox.sources.register({
      kind: MAIL_INBOX_SOURCE_KIND,
      describe: "新邮件",
      externalContent: true,
      fromOwner: false,
      priority: 5,
    });
    options.proactive.attachInbox(inbox.inbox);
  }
  const ownerRuleWriter = options.memory
    ? new ProductionOwnerRuleWriter({
        configuration,
        rules: repository.ownerRules(),
        reviews: repository.ruleReviews(),
        memory: options.memory.service,
        memories: repository.productMemoryState(),
        book: repository.memoryBook(),
        threads,
        payloads: memoryPayloads,
        protector: payloadProtector,
        clock: { now: clock },
        ...(options.proactive
          ? { replay: (rule) => options.proactive?.replayRule(rule) ?? Promise.reject(rule) }
          : {}),
      })
    : undefined;
  const memoryControl = options.memory
    ? new ProductionMemoryControl({
        configuration,
        state: repository.productMemoryState(),
        jobs: repository.memoryProjectionJobs(),
        approvals: repository.sensitiveMemoryApprovals(),
        unitOfWork: repository.unitOfWork(),
        memory: options.memory.service,
        profile: new OwnerProfileService({
          state: repository.productMemoryState(),
          pins: repository.memoryBook(),
          readText: async (record) => {
            const payload = await memoryPayloads.get(record.contentRef);
            if (!payload || payload.contentType !== "text/plain") return undefined;
            return new TextDecoder("utf-8", { fatal: true }).decode(
              await payloadProtector.unprotect({ ownerId, agentId, payload }),
            );
          },
          storeText: async () => {},
          digest: (text) => createHash("sha256").update(text).digest("hex"),
          ...(configuration.runPolicy?.timeZone
            ? { timeZone: configuration.runPolicy.timeZone }
            : {}),
        }),
        consolidation: {
          store: repository.memoryConsolidation(),
          undo: (changeId) => memoryTidyUp?.undo(changeId) ?? Promise.resolve(),
        },
        conversationReviews: {
          store: repository.memoryConversationReviews(),
          undo: (reviewId) =>
            options.memory
              ? undoConversationReview(
                  {
                    store: repository.memoryConversationReviews(),
                    state: repository.productMemoryState(),
                    memory: options.memory.service,
                    generationFor: async (memoryId) =>
                      (await memoryJobs.listByMemory(memoryId)).at(-1)?.generationId,
                    now: clock,
                  },
                  reviewId,
                )
              : Promise.resolve(),
        },
        reminders: repository.memoryReminders(),
        ...(ownerRuleWriter ? { ownerRules: ownerRuleWriter } : {}),
        reviews: { memories: repository.memoryReviews(), rules: repository.ruleReviews() },
        book: repository.memoryBook(),
        ledger: repository.decisionLedger(),
        ...(options.memory.actionRules ? { actionRules: options.memory.actionRules } : {}),
        ...(options.memory.allowances ? { allowances: options.memory.allowances } : {}),
        payloads: memoryPayloads,
        protector: payloadProtector,
        clock: { now: clock },
        ...(configuration.runPolicy?.timeZone
          ? { timeZone: configuration.runPolicy.timeZone }
          : {}),
        ...(options.memory.mcpSync ? { mcpSync: options.memory.mcpSync } : {}),
        ...(options.memory.externalProposals
          ? { externalProposals: options.memory.externalProposals }
          : {}),
        ...(options.memory.classifier ? { classifier: options.memory.classifier } : {}),
        ...(options.memory.importDuplicates
          ? { importDuplicates: options.memory.importDuplicates }
          : {}),
        onAudit: options.memory.onAudit,
      })
    : undefined;
  const pairedDevices = new PairedDeviceService({
    store: repository.pairedDevices(),
    sessions: sessionsState,
    configuration: () => deviceConfiguration,
    ownerActive: async (scope) => {
      if (scope.ownerId !== ownerId || scope.agentId !== agentId) return false;
      if (identityConfiguration.kind === "built-in") return true;
      return (await identityState.readByOwner(ownerId))?.status === "active";
    },
    ownerSubject: async (scope) => {
      if (scope.ownerId !== ownerId || scope.agentId !== agentId) return undefined;
      const binding = await identityState.readByOwner(ownerId);
      return binding?.status === "active" ? binding.externalSubjectRef : undefined;
    },
    now,
    ...(options.onDeviceWarning ? { onWarning: options.onDeviceWarning } : {}),
    prepareRevoke: async (deviceId) => {
      const report = (error: unknown) => options.onDevicePushFailed?.(error);
      const wipe = await options.webPush?.applePush?.prepareWipe(deviceId).catch(report);
      return wipe ? () => wipe().catch(report) : undefined;
    },
  });
  const pushPresence = options.webPush?.presence ?? new WebPushPresence();
  const applePush = options.webPush?.applePush;
  const devicePush = new DevicePushService({
    store: repository.applePush(),
    reactions: repository.webPush(),
    configuration: () => (applePush ? configuration.runPolicy?.applePush : undefined),
    now,
    onPresence: (deviceId, visible, at) => pushPresence.beat(`device:${deviceId}`, visible, at),
    onRegistered: (_deviceId, pushType) => {
      if (pushType === "widgets") applePush?.requestWidgetRefresh();
    },
  });
  const home = new ProductionHomeControl({
    settings: configuration.runPolicy?.homeFeed ?? DEFAULT_HOME_FEED,
    ...(options.proactive ? { proactive: options.proactive } : {}),
    ...(memoryControl ? { memory: memoryControl } : {}),
    listApprovals: () =>
      repository.authorizationStore().listApprovals(ownerId, agentId, { status: "pending" }),
    runThread: async (runId) =>
      (
        await repository
          .runLifecycle(ownerId, agentId, authority)
          .readRun(runId as Parameters<RunLifecyclePort["readRun"]>[0])
      )?.run.threadId ?? null,
    runs: repository.runLifecycle(ownerId, agentId, authority),
    threadTitle: async (threadId) => {
      const thread = await threads.read(
        ownerId,
        agentId,
        threadId as Parameters<typeof threads.read>[2],
      );
      if (!thread || thread.status !== "active") return null;
      const payload = thread.titleRef ? await memoryPayloads.get(thread.titleRef) : undefined;
      if (!payload || payload.contentType !== "text/plain") return { title: null };
      return {
        dataClassification: payload.dataClassification,
        title:
          new TextDecoder("utf-8", { fatal: true })
            .decode(await payloadProtector.unprotect({ ownerId, agentId, payload }))
            .trim() || null,
      };
    },
    clock: { now: clock },
    onSourceFailure: (source, error) =>
      options.onHomeDiagnostic?.({
        event: "home.source_failed",
        source,
        error:
          error instanceof ApplicationPortError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
      }),
  });
  const mcpConnectionAddresses = new McpConnectionAddresses({ now: clock });
  const searchControl = options.memory?.search
    ? new ProductionSearchControl({
        ownerId,
        agentId,
        settings: configuration.runPolicy?.searchAsk ?? DEFAULT_SEARCH_ASK,
        ...(configuration.runPolicy?.timeZone
          ? { timeZone: configuration.runPolicy.timeZone }
          : {}),
        provider: options.memory.search.provider,
        ...(options.memory.search.episodes ? { episodes: options.memory.search.episodes } : {}),
        perception: {
          search: async ({ query, limit }) => {
            const found = await perception.search({
              scope: { ownerId, agentId },
              query,
              limit,
            });
            const rows = await Promise.all(
              found.map(async (record) => {
                const spoken =
                  record.contentRef === null
                    ? undefined
                    : await readPerceptionText(record.contentRef).catch(() => undefined);
                const written = perceptionSearchEvidenceText(record.type, record.evidence);
                const text =
                  [spoken ?? "", written].filter((part) => part !== "").join(" · ") || undefined;
                return text === undefined
                  ? []
                  : [
                      {
                        recordId: record.id,
                        origin: record.origin,
                        occurredAt: new Date(record.occurredAtMs).toISOString(),
                        dataClassification: record.dataClassification,
                        text,
                      },
                    ];
              }),
            );
            return rows.flat();
          },
        },
        state: repository.productMemoryState(),
        readText: async (record) => {
          const payload = await memoryPayloads.get(record.contentRef);
          if (!payload || payload.contentType !== "text/plain") return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await payloadProtector.unprotect({ ownerId, agentId, payload }),
          );
        },
        clock: { now: clock },
      })
    : undefined;
  const readPerceptionText = async (contentRef: string) => {
    const payload = await repository.payloadStore(ownerId, agentId).get(contentRef);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await payloadProtector.unprotect({ ownerId, agentId, payload }),
    );
  };
  const perceptionSearchSettings = configuration.runPolicy?.searchAsk ?? DEFAULT_SEARCH_ASK;
  const dataExportJobs = new DataExportJobs({
    ownerId,
    agentId,
    databasePath: repository.databasePath,
    protector: payloadProtector,
    now: clock,
  });
  const perceptionConfiguration =
    configuration.runPolicy?.perception ?? PERCEPTION_CONFIGURATION_DEFAULTS;
  const proactiveConfiguration = configuration.runPolicy?.proactive;
  const perception = new PerceptionService({
    store: repository.perception(),
    deviceConfiguration: () => deviceConfiguration,
    configuration: () => perceptionConfiguration,
    timeZone: () => configuration.runPolicy?.timeZone ?? "UTC",
    protectText: async (input) =>
      (await payloadAdmission.protect({ ...input, contentType: "text/plain" })).payloadRef,
    uploadDirectory: path.join(configuration.stateRoot, "data", "device-uploads"),
    searchIndex: {
      version: `${searchTokenizer.projectionVersion}:${PERCEPTION_SEARCH_INDEX_RULES}:${perceptionSearchSettings.indexTermLimit}`,
      rebuildBatch: perceptionSearchSettings.indexRebuildBatch,
      termLimit: perceptionSearchSettings.indexTermLimit,
      readText: readPerceptionText,
      document: (scope, text) =>
        searchTokenizer.tokenizeDocument({
          ownerId: scope.ownerId,
          agentId: scope.agentId,
          text,
        }),
      query: (scope, text) =>
        searchTokenizer.tokenize({ ownerId: scope.ownerId, agentId: scope.agentId, text }),
    },
    ...(proactiveConfiguration
      ? {
          proactiveUsage: {
            limit: () => proactiveConfiguration.dailyCostMicros,
            usedSince: (scope, since) => repository.proactive().costSince({ ...scope, since }),
          },
        }
      : {}),
    ...(options.onPerceptionLimitWarning
      ? { onLimitWarning: options.onPerceptionLimitWarning }
      : {}),
    now,
  });
  await perception.prepareDirectories();
  await perception.resumeDeletions({ ownerId, agentId }).catch(() => undefined);
  const approvalThreadTitle = classifiedThreadTitleReader({
    configuration,
    threads,
    payloads: memoryPayloads,
    protector: payloadProtector,
  });
  const gatewayV2 = createProductionApprovalGateway({
    configuration,
    ...(options.capabilityReactivation
      ? { capabilityReactivation: options.capabilityReactivation }
      : {}),
    repository,
    access: threadAccess,
    homeControl: home,
    ...(searchControl ? { searchControl } : {}),
    recentAuthentication,
    clock: { now: clock },
    authority: options.authority,
    ...(options.deviceActions || approvalAnswers
      ? {
          onApprovalResolved: async (approval) => {
            await approvalAnswers?.answered(approval);
            await options.deviceActions?.service.reconcile(approval.id);
          },
        }
      : {}),
    ...(subthreads
      ? {
          approvalOrigin: async (threadId: string) => {
            const parent = await subthreads.parentOf(threadId).catch(() => undefined);
            if (!parent) return null;
            const title = await approvalThreadTitle(parent).catch(() => null);
            return {
              threadId: parent,
              threadTitle: title === null ? null : (approvalBodyPreview(title, 120) ?? null),
            };
          },
        }
      : {}),
    ...(workspaceCopies ? { workspaceCopies } : {}),
    ...(options.executionAuthority ? { executionAuthority: options.executionAuthority } : {}),
    ...(memoryControl ? { memoryControl } : {}),
    webPushControl: new ProductionWebPushControl({
      configuration,
      store: repository.webPush(),
      presence: pushPresence,
      push: options.webPush?.push,
      clock: { now: clock },
    }),
    ...(options.proactive ? { proactiveControl: options.proactive } : {}),
    ...(options.observation ? { observationControl: options.observation } : {}),
    ...(ownerRuleWriter
      ? {
          quietHoursControl: new ProductionQuietHoursControl({
            configuration,
            rules: ownerRuleWriter,
            clock: { now: clock },
          }),
        }
      : {}),
    ownerPreferencesControl: new ProductionOwnerPreferencesControl({
      configuration,
      store: repository.ownerPreferences(),
      clock: { now: clock },
    }),
    sensitiveInterceptionsControl: new ProductionSensitiveInterceptionsControl({
      configuration,
      store: repository.sensitiveInterceptions(),
      clock: { now: clock },
      beforeRead: () => flushSensitiveInterceptions(repository),
    }),
    deviceControl: new ProductionDeviceControl({
      configuration,
      devices: pairedDevices,
      deviceConfiguration: () => deviceConfiguration,
      ...(devicePairingAccess ? { pairingAccess: devicePairingAccess } : {}),
      clock: { now: clock },
    }),
    inboxControl: new ProductionInboxControl({
      settings: inboxSettings,
      scope: { ownerId, agentId },
      clock: { now: clock },
    }),
    ...(options.inbox?.mainThread?.subthreads
      ? {
          timerControl: new ProductionTimerControl({
            subthreads: options.inbox.mainThread.subthreads,
            ...(options.inbox.mainThread.timerReminders
              ? { reminders: options.inbox.mainThread.timerReminders }
              : {}),
            ...(options.inbox.mainThread.timeZone
              ? { timeZone: options.inbox.mainThread.timeZone }
              : {}),
            scope: { ownerId, agentId },
            clock: { now: clock },
          }),
        }
      : {}),
    perceptionControl: new ProductionPerceptionControl({
      configuration,
      perception,
      perceptionConfiguration: () => perceptionConfiguration,
      readText: async (contentRef) => {
        const payload = await repository.payloadStore(ownerId, agentId).get(contentRef);
        if (!payload || payload.contentType !== "text/plain") return undefined;
        return new TextDecoder("utf-8", { fatal: true }).decode(
          await payloadProtector.unprotect({ ownerId, agentId, payload }),
        );
      },
      clock: { now: clock },
    }),
    serverStatusControl: new ProductionServerStatusControl({
      configuration,
      health,
      clock: { now: clock },
    }),
    dataExportControl: new ProductionDataExportControl({
      configuration,
      jobs: dataExportJobs,
      clock: { now: clock },
    }),
    filesControl: new ProductionFilesControl({
      configuration,
      store: repository.threadArtifacts(),
      threadTitle: classifiedThreadTitleReader({
        configuration,
        threads,
        payloads: memoryPayloads,
        protector: payloadProtector,
      }),
      clock: { now: clock },
    }),
    loginDevicesControl: new ProductionLoginDevicesControl({
      configuration,
      state: repository.sessionDeviceState(),
      recentAuthentication,
      clock: { now: clock },
    }),
    ...(options.mcpRead
      ? {
          mcpConnectionsControl: new ProductionMcpConnectionsControl({
            configuration,
            store: repository.mcpConnections(),
            addresses: mcpConnectionAddresses,
            minute: (connectionId) =>
              options.mcpRead?.minuteUsage(connectionId) ?? {
                reads: 0,
                hookReads: 0,
              },
            hookReadsPerMinute: options.mcpRead.hookReadsPerMinute,
            timeZone: configuration.runPolicy?.timeZone ?? "UTC",
            clock: { now: clock },
          }),
        }
      : {}),
  });
  const app = buildHttpGatewayServer({
    ...routeOptions(
      configuration,
      authentication,
      csrf,
      recentAuthentication,
      threadGateway,
      payloadAdmission,
      payloadRead,
      health,
      metrics,
      authority,
      options.modelCatalog,
      Boolean(options.cancelRun),
      Boolean(workspaceCopies),
      Boolean(options.executionEnvironment),
      Boolean(memoryControl),
      Boolean(options.proactive),
      Boolean(options.observation),
      Boolean(options.mcpRead),
      Boolean(searchControl),
      options.capabilityReactivation !== undefined,
      Boolean(options.inbox?.mainThread?.subthreads),
    ),
    gatewayV2,
    threadSearch,
    files,
    devices: {
      service: pairedDevices,
      home: { resolveAction: (input) => home.resolveAction(input) },
      configuration: () => deviceConfiguration,
      chatAttachments: () => chatAttachments,
      recordVoiceTiming: (input) => recordVoiceTiming(input),
      audit: repository.auditLedger(),
      push: devicePush,
      ...(options.onDeviceAuditFailed ? { onAuditFailed: options.onDeviceAuditFailed } : {}),
      ...(devicePairingAccess ? { pairingAccess: devicePairingAccess } : {}),
      exportArchive: deviceExportArchive({ ownerId, jobs: dataExportJobs }),
      perception,
      ...(options.deviceNotifications
        ? {
            notifications: {
              hub: options.deviceNotifications.hub,
              presence: options.deviceNotifications.presence,
              settled: async ({ scope, ids }) =>
                scope.ownerId === ownerId && scope.agentId === agentId
                  ? ((await options.deviceNotifications?.settled(ids)) ?? [])
                  : [],
            },
          }
        : {}),
      ...(options.deviceActions
        ? {
            actions: {
              service: (scope) =>
                scope.ownerId === ownerId && scope.agentId === agentId
                  ? options.deviceActions?.service
                  : undefined,
              hub: options.deviceActions.hub,
            },
          }
        : {}),
      ...(options.vault
        ? {
            vault: (scope: PairedDeviceScope) =>
              scope.ownerId === ownerId && scope.agentId === agentId ? options.vault : undefined,
          }
        : {}),
      voiceGates: () => DEFAULT_VOICE_GATES,
      ...(speech ? { speech } : {}),
      ...(options.queryPrefetch
        ? { prefetch: utterancePrefetch(options.queryPrefetch, perception, agentId) }
        : {}),
    },
    ...(httpConfiguration.previewOrigin ? { previewOrigin: httpConfiguration.previewOrigin } : {}),
    ...(options.onSlowRequest ? { onSlowRequest: options.onSlowRequest } : {}),
  });
  app.get("/api/identity/v1/method", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({
      method: identityConfiguration.kind === "built-in" ? "built-in" : "cloudflare-access",
    }),
  );
  if (options.proactive)
    registerProactiveRoutes(app, options.proactive, {
      authentication,
      sessionCookieName: httpConfiguration.sessionCookieName,
      ownerId,
    });
  registerDataExportRoute(app, {
    authentication,
    sessionCookieName: httpConfiguration.sessionCookieName,
    ownerId,
    jobs: dataExportJobs,
  });
  registerChatExportRoute(app, {
    authentication,
    sessionCookieName: httpConfiguration.sessionCookieName,
    ownerId,
    agentId,
    databasePath: repository.databasePath,
    protector: payloadProtector,
    now: clock,
  });
  if (options.mcpRead) {
    registerMcpReadRoute(app, options.mcpRead);
    registerMcpConnectionAddressRoute(app, {
      authentication,
      sessionCookieName: httpConfiguration.sessionCookieName,
      ownerId,
      addresses: mcpConnectionAddresses,
    });
  }
  registerAuthentication(app, csrf, recentAuthentication);
  const onCommandAccepted = options.onCommandAccepted;
  if (onCommandAccepted)
    app.addHook("onResponse", async (request, reply) => {
      const path = request.url.split("?", 1)[0] ?? "";
      if (request.method === "POST" && reply.statusCode < 300 && GATEWAY_COMMAND_PATH.test(path))
        onCommandAccepted(path);
    });
  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (request.method === "POST" && reply.statusCode < 300 && GATEWAY_COMMAND_PATH.test(path))
      searchIndexer.kick();
  });
  return Object.freeze({
    app,
    authentication,
    assertIdentityReady,
    csrf,
    recentAuthentication,
    threadGateway,
    threadAccess,
    payloadProtector,
    payloadAdmission,
    health,
    metrics,
    home,
    perception,
    listen: async () => {
      if (unixSocketPath === undefined) {
        const address = await app.listen({
          host: httpConfiguration.listenHost,
          port: httpConfiguration.listenPort,
        });
        searchIndexer.start();
        await ensureMainThread();
        inbox.loop?.start();
        memoryInbox?.start();
        threadDeletionRetry.start();
        return address;
      }
      await prepareUnixSocketPath(unixSocketPath, { adoptExistingDirectory: false });
      await app.listen({ path: unixSocketPath });
      try {
        unixSocketIdentity = await sealUnixSocket(unixSocketPath);
      } catch (error) {
        await app.close().catch(() => undefined);
        await removeUnixSocketFile(unixSocketPath).catch(() => undefined);
        throw error;
      }
      searchIndexer.start();
      await ensureMainThread();
      inbox.loop?.start();
      memoryInbox?.start();
      threadDeletionRetry.start();
      return unixSocketPath;
    },
    close: async () => {
      searchIndexer.stop();
      await memoryInbox?.stop();
      await inbox.loop?.stop();
      await threadDeletionRetry.stop();
      try {
        await app.close();
      } finally {
        if (unixSocketPath !== undefined && unixSocketIdentity !== undefined) {
          const identity = unixSocketIdentity;
          unixSocketIdentity = undefined;
          const current = await lstat(unixSocketPath).catch(() => undefined);
          if (current && current.dev === identity.dev && current.ino === identity.ino)
            await removeUnixSocketFile(unixSocketPath);
        }
      }
    },
  });
}

export function utterancePrefetch(
  prefetch: ProductionQueryPrefetch,
  perception: PerceptionService,
  agentId: AgentId,
): UtterancePrefetchPort {
  return {
    prepare: async ({ authentication, deviceId, utteranceId, text }) => {
      const scope = { ownerId: authentication.ownerId as OwnerId, agentId };
      if (!(await perception.reserveModelCost(scope, prefetch.estimateMicros(text))))
        return { prepared: false, reason: "limit_reached" };
      const prepared = await prefetch.queue.prepare({ deviceId, utteranceId, text }, (query) =>
        prefetch.embedQuery(query),
      );
      return { prepared, reason: prepared ? null : "nothing_to_search" };
    },
    settle: (input) => {
      prefetch.queue.settle(input);
    },
  };
}
