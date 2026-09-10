import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  PayloadProtectionRequest,
  CancelCoordinatedRunInput,
  ThreadCreateInput,
  ThreadGatewayInboundMessage,
} from "@himawari-agent/application";
import {
  AgentThreadGatewayService,
  ApplicationPortError,
  type GatewayAccessDecision,
  type GatewayAuthenticationContext,
  type GatewayV2InboundMessage,
  type OwnerIdentityStatePort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  ProductThreadGatewayAdapter,
  RecentAuthenticationGuard,
  type SessionDeviceStatePort,
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  ThreadExecutionProjection,
  ThreadForkService,
  type ThreadGatewayAccessPolicyPort,
  ThreadQueryService,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  CloudflareAccessJwtVerifier as AccessJwtVerifier,
  assertProductionSecretSource,
  BoundedJwksFetcher,
  BrowserTextPayloadReader,
  buildHttpGatewayServer,
  CloudflareAccessIdentityClient,
  type CloudflareAccessIdentityFetcher,
  type CloudflareAccessJwtVerifier,
  digestIdentityCredential,
  EnvelopePayloadProtector,
  type HostProviderSecretSource,
  type HostSecretMaterialSource,
  type HttpGatewayPayloadAdmissionPort,
  type HttpGatewayServerOptions,
  IDENTITY_GATEWAY_ERROR_CODES,
  IdentityGatewayError,
  type JwksFetcher,
  OwnerBootstrapService,
  ProductSessionAuthenticationService,
  type ProductSessionAuthenticationServiceOptions,
  RuntimeHealthModel,
  RuntimeMetricsRegistry,
  registerIdentityAuthenticationRoutes,
  SessionBoundCsrfService,
} from "@himawari-agent/platform-node";
import type { FastifyInstance } from "fastify";
import {
  createProductionApprovalGateway,
  PRODUCTION_APPROVAL_OPERATIONS,
} from "./production-approval-gateway.js";

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

export interface ProductionHttpCompositionSecretSources {
  readonly provider: HostProviderSecretSource;
  readonly keys: HostSecretMaterialSource;
}

export interface ProductionHttpCompositionOptions {
  readonly modelCatalog?: readonly {
    ref: string;
    model: string;
    name: string;
    provider: string;
    thinkingLevels: readonly string[];
  }[];
  readonly cancelRun?: (
    input: Pick<CancelCoordinatedRunInput, "runId" | "command">,
  ) => Promise<void>;
  readonly health?: RuntimeHealthModel;
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
  /** Core owns the authority lifecycle and supplies the current product fence. */
  readonly authority: () => ProductAuthorityFence;
  readonly secretSources: ProductionHttpCompositionSecretSources;
  /** Test-only local JWKS boundary; production defaults to the fixed HTTPS endpoint. */
  readonly jwksFetcher?: JwksFetcher;
  /** Test-only local get-identity boundary; production uses the fixed provider endpoint. */
  readonly identityFetcher?: CloudflareAccessIdentityFetcher;
  readonly now?: () => Date;
  readonly createSessionId?: ProductSessionAuthenticationServiceOptions["createSessionId"];
  readonly createDeviceId?: ProductSessionAuthenticationServiceOptions["createDeviceId"];
  readonly createSessionToken?: () => string;
}

export interface ProductionHttpComposition {
  readonly app: FastifyInstance;
  readonly authentication: ProductSessionAuthenticationService;
  readonly verifier: CloudflareAccessJwtVerifier;
  readonly identity: CloudflareAccessIdentityClient;
  readonly bootstrap: OwnerBootstrapService;
  readonly csrf: SessionBoundCsrfService;
  readonly recentAuthentication: RecentAuthenticationGuard;
  readonly threadGateway: AgentThreadGatewayService;
  readonly threadAccess: ThreadGatewayAccessPolicyPort;
  readonly payloadProtector: PayloadProtectorPort;
  readonly payloadAdmission: HttpGatewayPayloadAdmissionPort;
  readonly health: RuntimeHealthModel;
  readonly metrics: RuntimeMetricsRegistry;
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
    http.listenPort < 1 ||
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

class ProductionHttpPayloadAdmission implements HttpGatewayPayloadAdmissionPort {
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
    readonly contentType: "text/plain";
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

function routeOptions(
  configuration: ProductConfiguration,
  identity: ProductSessionAuthenticationService,
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
      canCancelRun,
      availableModels: modelCatalog ?? [],
      installedGatewayV2Operations: PRODUCTION_APPROVAL_OPERATIONS,
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

/**
 * Build the production HTTP boundary around the durable identity and Thread
 * v3 stores. Core remains the owner of authority lifecycle and of the worker
 * dispatch path; this factory intentionally does not invent either one.
 */
export async function createProductionHttpComposition(
  options: ProductionHttpCompositionOptions,
): Promise<ProductionHttpComposition> {
  const { configuration, repository, secretSources } = options;
  const httpConfiguration = configuration.http;
  const identityConfiguration = configuration.identity;
  if (!configuration.publicMode || !httpConfiguration || !identityConfiguration) {
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
  const payloadKey = soleSecret(configuration, "payload-encryption");
  const payloadProtector = new EnvelopePayloadProtector({
    keys: secretSources.keys,
    activeKey: { keyRef: payloadKey.ref, kekVersion: payloadKey.version, dekVersion: "dek-v1" },
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
  const authentication = new ProductSessionAuthenticationService({
    verifier,
    identityState,
    sessionState: sessionsState,
    recentAuthenticationProvider: identity,
    now,
    ...(options.createSessionId === undefined ? {} : { createSessionId: options.createSessionId }),
    ...(options.createDeviceId === undefined ? {} : { createDeviceId: options.createDeviceId }),
    createToken: options.createSessionToken ?? (() => randomBytes(32).toString("base64url")),
  });
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
  const bootstrapService = new OwnerBootstrapService({
    enabled: bootstrap.enabled,
    expiresAt: bootstrap.expiresAt,
    tokenDigest: bootstrapTokenDigest,
    identityState,
    now,
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
  const threadAdapter = new ProductThreadGatewayAdapter({
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
    execution: new ThreadExecutionProjection({
      threads,
      trace: repository.traceStore(),
      payloads: () => repository.payloadStore(ownerId, agentId),
      protector: payloadProtector,
    }),
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
  const health = options.health ?? new RuntimeHealthModel({ publicMode: true, now: clock });
  const metrics = new RuntimeMetricsRegistry({ now: clock });
  const gatewayV2 = createProductionApprovalGateway({
    configuration,
    repository,
    access: threadAccess,
    recentAuthentication,
    clock: { now: clock },
    authority: options.authority,
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
    ),
    gatewayV2,
  });
  registerIdentityAuthenticationRoutes(app, {
    publicOrigin: configuration.publicOrigin,
    verifier,
    bootstrap: bootstrapService,
    sessions: authentication,
    sessionCookieName: httpConfiguration.sessionCookieName,
  });
  return Object.freeze({
    app,
    authentication,
    verifier,
    identity,
    bootstrap: bootstrapService,
    csrf,
    recentAuthentication,
    threadGateway,
    threadAccess,
    payloadProtector,
    payloadAdmission,
    health,
    metrics,
    listen: () =>
      app.listen({ host: httpConfiguration.listenHost, port: httpConfiguration.listenPort }),
    close: () => app.close(),
  });
}
