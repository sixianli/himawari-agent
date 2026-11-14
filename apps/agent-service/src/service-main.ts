import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CapabilityManifest,
  ModelInvocationAdmissionResolver,
  PayloadProtectorPort,
  ProductMemoryRecord,
} from "@himawari-agent/application";
import {
  autoCommitThreshold,
  type ClockPort,
  claimFromRunExecutionLease,
  classificationRank,
  createProactiveSeal,
  type DataClassification,
  DEFAULT_PROACTIVE_MEMORY_LIMITS,
  DurableMemoryService,
  ExecutionLiveFeed,
  type IdGeneratorPort,
  MemoryCheckupService,
  modelUsagePurpose,
  modelVisibleClassifications,
  OwnerProfileService,
  type ProductConfiguration,
  prereviewPromptId,
  RemoteExecutionBackend,
  RuleReviewService,
  type RuntimeRequest,
  recoverSandboxExecutionsAtStartup,
  recoverSandboxJobsAtStartup,
  reviewCapacity,
  reviewMemoryVisible,
  WorkerDelegationAdmissionService,
} from "@himawari-agent/application";
import {
  type ExecutionAdmissionPeerBinding,
  payloadBrokerV1BodyBytes,
  SANDBOX_TOOL_MEMORY_LIMIT_BYTES,
  type SandboxExecutionSupport,
  SRT_TASK_ENVIRONMENT_BACKEND_REF,
  SRT_TASK_ENVIRONMENT_GUARANTEES,
} from "@himawari-agent/execution-contracts";
import { MemoryConsolidationService, MemoryEpisodeService } from "@himawari-agent/memory-engine";
import {
  inspectDeploymentAuthorityReadOnly,
  type SqliteExtraReadThreadBudget,
  SqliteProductStateRepository,
  sqliteLibraryVersion,
} from "@himawari-agent/persistence-sqlite";
import {
  assertProductionSecretSource,
  BoundedJwksFetcher,
  CloudflareAccessJwtVerifier,
  createDemoGoogleOAuth,
  createDemoMailReader,
  createGmailReader,
  createGoogleOAuth,
  createWebPushSender,
  DescriptorRelativeReadOnly,
  EnvelopePayloadProtector,
  EphemeralSecretPort,
  EXECUTION_UDS_ERROR_CODES,
  ExecutionAdmissionUdsServer,
  ExecutionUdsError,
  failureReason,
  GAP_EXPORT_SECRET_PURPOSE,
  GOOGLE_OAUTH_CLIENT_SECRET_PURPOSE,
  initializeStateRoot,
  JsonFileConfigurationPort,
  MacOsKeychainProviderSecretSource,
  MacOsKeychainSecretSource,
  MUSE_INTAKE_SECRET_PURPOSE,
  PayloadUdsServer,
  parseServiceArguments,
  portErrorSite,
  RuntimeHealthModel,
  readAuthorityFile,
  readGmailAccount,
  readRestrictedExecutionTokenFile,
  readWorkerServiceBootBinding,
  SERVICE_RUNTIME_ERROR_CODES,
  SystemdCredentialSecretSource,
  SystemdProviderSecretSource,
  stableErrorCode,
  TypeSafeJevTransport,
  writeAgentServiceBootBinding,
  writeAuthorityFile,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";
import {
  admissionCostForConfiguredPiModel,
  createPiFilePreparationPool,
  getPiModelPresentation,
} from "@himawari-agent/runtime-pi";
import { monitorFollowUpCacheHits } from "./cache-hit-monitor.js";
import { classifiedThreadTitleReader } from "./classified-thread-title.js";
import { COMMAND_SILENCE_CHECK_INTERVAL_MS, CommandSilenceWatch } from "./command-silence-watch.js";
import { createLocalVectorCatchUp } from "./local-vector-catch-up.js";
import { OwnerScopeAuthorization } from "./owner-scope-authorization.js";
import { createProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import { createProductionAutomaticReview } from "./production-automatic-review.js";
import { backgroundCommandLimits } from "./production-background-commands.js";
import { retrievalDegradeRecorder } from "./production-decision-ledger.js";
import { ProductionExecutionAdmissionHandler } from "./production-execution-admission-handler.js";
import { AgentServiceExecutionClient } from "./production-execution-client.js";
import { strictModeUnavailableTools } from "./production-execution-environment.js";
import { createProductionFileReadServices } from "./production-file-read-services.js";
import { ProductionGapExport } from "./production-gap-export.js";
import { createConfiguredHostWeb } from "./production-host-web.js";
import {
  createProductionHttpComposition,
  type ProductionHttpComposition,
  type ProductionHttpCompositionOptions,
} from "./production-http-composition.js";
import { expandConfigurationWithMagpieModels, priceTiers } from "./production-magpie-models.js";
import { ProductionMcpMemoryWriter } from "./production-mcp-memory-writer.js";
import { ProductionMcpRead } from "./production-mcp-read.js";
import { ProductionMcpRuleWriter } from "./production-mcp-rule-writer.js";
import {
  MEMORY_CLASSIFICATION_BATCH_CHARACTERS,
  MEMORY_CLASSIFICATION_OUTPUT_TOKENS_PER_ITEM,
  memoryClassificationFailureCode,
  ProductionMemoryClassifier,
} from "./production-memory-classification.js";
import {
  createProductionMemoryCompositionFromConfiguration,
  type ProductionMemoryComposition,
} from "./production-memory-composition.js";
import { quoteRefOfMemory } from "./production-memory-consolidation.js";
import { expandMemoryReviews, findSourceMessageIds } from "./production-memory-control.js";
import { DEFAULT_CONVERSATION_REVIEW_SETTINGS } from "./production-memory-conversation-review.js";
import {
  importDuplicateFailureCode,
  productionImportDuplicateChecker,
} from "./production-memory-import-duplicates.js";
import { ProductionMemoryRecall } from "./production-memory-recall.js";
import { ProductionMemoryWorker } from "./production-memory-worker.js";
import {
  createProductionModelCompositionFromConfiguration,
  type ProductionConfiguredModelComposition,
} from "./production-model-composition.js";
import {
  createProductionModelEgress,
  flushSensitiveInterceptions,
  productionEgressThreadOf,
  productionSensitiveInterceptionRecorder,
} from "./production-model-egress.js";
import { createMuseChannelPushSource, ProductionMuseIntake } from "./production-muse-intake.js";
import { ProductionMuseControl } from "./production-muse-intake-control.js";
import { ProductionObservation, readServiceRevision } from "./production-observation.js";
import { ProductionOwnerRuleTools, ProductionOwnerRuleWriter } from "./production-owner-rules.js";
import { ProductionPayloadBrokerHandler } from "./production-payload-broker-handler.js";
import {
  createProactivePushSource,
  PREREVIEW_MAX_OUTPUT_TOKENS,
  PROACTIVE_MAX_OUTPUT_TOKENS,
  ProductionProactive,
  proactiveCostEstimator,
  proactiveRedirectUri,
  RULE_REVIEW_MAX_OUTPUT_TOKENS,
} from "./production-proactive.js";
import { createProactiveMemoryRecall } from "./production-proactive-memory.js";
import { createProactiveRecentSummaries } from "./production-proactive-summaries.js";
import {
  createProductionRealEval,
  createRealEvalModel,
  type ProductionRealEval,
  RealEvalSampleExpiry,
} from "./production-real-eval.js";
import { ProductionReminderTools, ProductionReminderWriter } from "./production-reminder-writer.js";
import { createProductionRunComposition } from "./production-run-composition.js";
import { ProductionRunDispatchLoop } from "./production-run-dispatch-loop.js";
import {
  createProductionRunMemory,
  embeddingAdmissionDescriptor,
} from "./production-run-memory.js";
import { configuredWorkspaceRoot, createProductionRunPolicy } from "./production-run-policy.js";
import { recordInCurrentRun } from "./production-run-timing.js";
import { ProductionRuntimeTools } from "./production-runtime-tools.js";
import {
  createProductionSandboxServices,
  type ProductionTaskEnvironments,
} from "./production-sandbox-services.js";
import { ProductionServiceLifecycle } from "./production-service-lifecycle.js";
import { productionToolActionRegistry } from "./production-tool-actions.js";
import { toolCallSandboxPrewarm } from "./production-tool-call-prewarm.js";
import { ProductionWebPush, WebPushPresence } from "./production-web-push.js";
import { createProductionWorkerParentBindingRegistry } from "./production-worker-parent-binding-registry.js";
import {
  inspectSandboxCommands,
  type SandboxCommandInventory,
} from "./sandbox-command-inventory.js";
import {
  resolveCodingNetworkFacts,
  WorkspaceAutoAuthorization,
} from "./workspace-auto-authorization.js";

function siteField(error: unknown): { readonly site?: string } {
  const site = portErrorSite(error);
  return site === undefined ? {} : { site };
}

export const AGENT_SERVICE_ERROR_CODES = Object.freeze({
  AUTHORITY_INACTIVE: "AGENT_AUTHORITY_INACTIVE",
  AUTHORITY_MISMATCH: "AGENT_AUTHORITY_MISMATCH",
  AUTHORITY_LOST: "AGENT_AUTHORITY_LOST",
  MODEL_PATH_UNSUPPORTED: "AGENT_MODEL_PATH_UNSUPPORTED",
  PAYLOAD_KEY_REFERENCE_INVALID: "AGENT_PAYLOAD_KEY_REFERENCE_INVALID",
  WORKER_BOOT_BINDING_INVALID: "AGENT_WORKER_BOOT_BINDING_INVALID",
  WORKER_UNAVAILABLE: "AGENT_WORKER_UNAVAILABLE",
} as const);

const AUTHORITY_LEASE_DURATION_MS = 30_000;
const AUTHORITY_RENEWAL_INTERVAL_MS = 10_000;
const STARTUP_RETRY_DELAY_MS = 50;
const ARTIFACT_RECONCILE_DELAY_MS = 60_000;
const MAXIMUM_BODY_BYTES = 65_536;
const MAXIMUM_PAYLOAD_BYTES = 48 * 1024;
const PI_FILE_PREPARATION_MEMORY_BYTES = 256 * 1024 * 1024;

export interface AgentServiceModelCompositionContext {
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
  readonly sources?: ReturnType<typeof hostModelSources>;
  readonly admission?: ModelInvocationAdmissionResolver;
}

export type AgentServiceModelCompositionFactory = (
  context: AgentServiceModelCompositionContext,
) => Promise<ProductionConfiguredModelComposition>;

export interface AgentServiceMemoryCompositionContext {
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
  readonly sources?: ReturnType<typeof hostModelSources>;
  readonly diagnostic?: (event: Readonly<Record<string, string | number>>) => void;
}

export type AgentServiceMemoryCompositionFactory = (
  context: AgentServiceMemoryCompositionContext,
) => Promise<ProductionMemoryComposition>;

export interface AgentServiceDependencies {
  readonly secretSources?: ReturnType<typeof hostModelSources>;
  readonly httpOptions?: Pick<ProductionHttpCompositionOptions, "jwksFetcher" | "identityFetcher">;
  readonly modelCompositionFactory?: AgentServiceModelCompositionFactory;
  readonly memoryCompositionFactory?: AgentServiceMemoryCompositionFactory;
}

let sandboxCommandInventoryOnce: Promise<SandboxCommandInventory> | undefined;
function sandboxCommandInventory(): Promise<SandboxCommandInventory> {
  sandboxCommandInventoryOnce ??= inspectSandboxCommands();
  return sandboxCommandInventoryOnce;
}

function productionClock(): ClockPort {
  return Object.freeze({ now: () => new Date().toISOString() });
}

function productionIds(): IdGeneratorPort {
  return Object.freeze({
    next: (namespace: string) => `${namespace}:${randomUUID()}`,
  });
}

function srtTaskEnvironmentRoute(lifecycle: RemoteExecutionBackend): ProductionTaskEnvironments {
  return {
    backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
    session: "srt",
    guarantees: SRT_TASK_ENVIRONMENT_GUARANTEES,
    inspectBeforeReuse: true,
    lifecycle,
    prewarm: (input) => lifecycle.prewarm(input),
  };
}

function toolCallPrewarm<Route>(
  route: Route | undefined,
  create: (route: Route) => (request: RuntimeRequest, toolName: string) => void,
): {
  readonly onToolCallStarted?: (request: RuntimeRequest, toolName: string) => void;
} {
  return route ? { onToolCallStarted: create(route) } : {};
}

function configuredEmbedding(configuration: ProductConfiguration) {
  const descriptor = configuration.modelDescriptors.find(({ role }) => role === "embedding");
  if (!descriptor || descriptor.role !== "embedding") {
    throw new Error(AGENT_SERVICE_ERROR_CODES.MODEL_PATH_UNSUPPORTED);
  }
  return descriptor;
}

function isDeterministicOnly(configuration: ProductConfiguration): boolean {
  return configuration.modelDescriptors
    .filter(({ role }) => role !== "embedding")
    .every(({ provider }) => provider === "deterministic");
}

function hostModelSources(configuration: ProductConfiguration) {
  if (process.platform === "darwin") {
    return Object.freeze({
      provider: new MacOsKeychainProviderSecretSource({
        servicePrefix: "himawari-provider",
        account: "himawari-agent",
      }),
      keys: new MacOsKeychainSecretSource({
        servicePrefix: "himawari-payload",
        account: "himawari-agent",
      }),
    });
  }
  const directory = path.join(configuration.stateRoot, "secrets");
  return Object.freeze({
    provider: new SystemdProviderSecretSource(directory),
    keys: new SystemdCredentialSecretSource(directory),
  });
}

function configuredPayloadProtector(
  configuration: ProductConfiguration,
  sources = hostModelSources(configuration),
): EnvelopePayloadProtector {
  const payloadKeys = configuration.secretReferences.filter(
    ({ purpose }) => purpose === "payload-encryption",
  );
  if (payloadKeys.length !== 1 || !payloadKeys[0]) {
    throw new Error(AGENT_SERVICE_ERROR_CODES.PAYLOAD_KEY_REFERENCE_INVALID);
  }
  const payloadKey = payloadKeys[0];
  assertProductionSecretSource(sources.keys);
  return new EnvelopePayloadProtector({
    keys: sources.keys,
    activeKey: {
      keyRef: payloadKey.ref,
      kekVersion: payloadKey.version,
      dekVersion: "dek-v1",
    },
  });
}

async function createDefaultModelComposition(
  context: AgentServiceModelCompositionContext,
): Promise<ProductionConfiguredModelComposition> {
  const { configuration, repository } = context;
  const sources = context.sources ?? hostModelSources(configuration);
  const clock = productionClock();
  const ids = productionIds();
  const handles = new EphemeralSecretPort({ ids, clock });
  const protector = configuredPayloadProtector(configuration, sources);
  try {
    const created = await createProductionModelCompositionFromConfiguration({
      egress: createProductionModelEgress(
        configuration,
        sources,
        productionSensitiveInterceptionRecorder(repository),
      ),
      egressThreadOf: productionEgressThreadOf(repository, configuration),
      configuration,
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      handles,
      secretSource: sources.provider,
      payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
      protector,
      ids,
      clock,
      requestTimeoutMs: configuration.deadlines.providerRequestMs,
      ...(context.admission === undefined ? {} : { admission: context.admission }),
      usage: {
        store: repository.modelUsage(),
        onFailure: (error) =>
          writeServiceDiagnostic(process.stderr, {
            component: "agent-service",
            event: "model-usage.record_failed",
            code: stableErrorCode(error),
          }),
      },
    });
    return Object.freeze({
      descriptors: created.descriptors,
      handles,
      secretSource: sources.provider,
      composition: Object.freeze({
        ...created.composition,
        close: async () => {
          try {
            await created.composition.close();
          } finally {
            handles.clear();
          }
        },
      }),
    });
  } catch (error) {
    handles.clear();
    throw error;
  }
}

async function createDefaultMemoryComposition(
  context: AgentServiceMemoryCompositionContext,
): Promise<ProductionMemoryComposition> {
  const sources = context.sources ?? hostModelSources(context.configuration);
  return createProductionMemoryCompositionFromConfiguration({
    egress: createProductionModelEgress(
      context.configuration,
      sources,
      productionSensitiveInterceptionRecorder(context.repository),
    ),
    configuration: context.configuration,
    secretSource: sources.provider,
    index: context.repository.memoryIndex(),
    onVectorFailure: retrievalDegradeRecorder({
      ledger: context.repository.decisionLedger(),
      now: () => new Date().toISOString(),
      onFailure: () => {},
    }),
    onRelevanceUnknown: (count) =>
      context.diagnostic?.({
        component: "agent-service",
        event: "memory.relevance_unknown",
        candidates: count,
      }),
  });
}

type AgentAuthorityRecord = Awaited<ReturnType<typeof readAuthorityFile>>;

function sameConfiguredAuthority(
  authority: AgentAuthorityRecord,
  configuration: ProductConfiguration,
): boolean {
  return (
    authority.status === "active" &&
    authority.id === configuration.deploymentId &&
    authority.ownerId === configuration.ownerId &&
    authority.agentId === configuration.agentId
  );
}

async function waitForWorkerBootBinding(input: {
  readonly layout: Awaited<ReturnType<typeof initializeStateRoot>>;
  readonly configuration: ProductConfiguration;
  readonly authority: AgentAuthorityRecord;
  readonly isAuthorityActive?: () => boolean;
}): Promise<Awaited<ReturnType<typeof readWorkerServiceBootBinding>>> {
  const deadline = Date.now() + input.configuration.deadlines.workerRequestMs;
  for (;;) {
    if (input.isAuthorityActive && !input.isAuthorityActive()) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
    }
    const binding = await readWorkerServiceBootBinding(input.layout).catch(() => undefined);
    if (
      binding &&
      binding.workerInstanceId === `execution-worker:${input.configuration.deploymentId}` &&
      binding.deploymentId === input.configuration.deploymentId &&
      binding.ownerId === input.configuration.ownerId &&
      binding.agentId === input.configuration.agentId &&
      binding.authorityEpoch === input.authority.authorityEpoch &&
      binding.fencingToken === input.authority.fencingToken
    ) {
      return binding;
    }
    if (Date.now() >= deadline) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.WORKER_BOOT_BINDING_INVALID);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_RETRY_DELAY_MS));
  }
}

const STATIC_FILE_PATHS = new Set([
  "/",
  "/sw.js",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
]);

function servesStaticFile(requestPath: string): boolean {
  return (
    STATIC_FILE_PATHS.has(requestPath) ||
    requestPath.startsWith("/assets/") ||
    requestPath.startsWith("/icons/")
  );
}

function lossCode(error: unknown): string {
  const code = stableErrorCode(error);
  return code === SERVICE_RUNTIME_ERROR_CODES.STARTUP_FAILED ? "AUTHORITY_LOSS_CODE_UNKNOWN" : code;
}

function failureReasonField(error: unknown): { reason?: string } {
  const reason = failureReason(error);
  return reason === undefined ? {} : { reason };
}

function writeStartupStep(output: NodeJS.WritableStream, step: string): void {
  writeServiceDiagnostic(output, {
    component: "agent-service",
    event: "startup.step",
    step,
    elapsedMs: Math.round(performance.now()),
  });
}

function retryableWorkerStartupError(error: unknown): boolean {
  return (
    error instanceof ExecutionUdsError &&
    (error.code === EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE ||
      error.code === EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED ||
      error.code === EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED)
  );
}

async function connectWorkerWithRetry(
  client: AgentServiceExecutionClient,
  timeoutMs: number,
  isAuthorityActive?: () => boolean,
): Promise<Awaited<ReturnType<AgentServiceExecutionClient["start"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isAuthorityActive && !isAuthorityActive()) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
    }
    try {
      const handshake = await client.start();
      if (handshake.payload.ready) return handshake;
      if (Date.now() >= deadline) {
        throw new Error(AGENT_SERVICE_ERROR_CODES.WORKER_UNAVAILABLE);
      }
    } catch (error) {
      if (!retryableWorkerStartupError(error) || Date.now() >= deadline) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_RETRY_DELAY_MS));
  }
}

function waitForTerminationOrAuthorityLoss(
  authorityLoss: Promise<void>,
): Promise<
  | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" }
  | { readonly kind: "authority-loss" }
> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    let settled = false;
    const settle = (
      result:
        | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" }
        | { readonly kind: "authority-loss" },
    ) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(result);
    };
    const onInterrupt = () => settle({ kind: "signal", signal: "SIGINT" });
    const onTerminate = () => settle({ kind: "signal", signal: "SIGTERM" });
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    void authorityLoss.then(() => settle({ kind: "authority-loss" }));
  });
}

export interface TenantRuntimeShared {
  readonly piFilePreparationPool?: ReturnType<typeof createPiFilePreparationPool>;
  readonly extraReadThreadBudget?: SqliteExtraReadThreadBudget;
}

export interface TenantExecutionWorkerLauncher {
  ensureStarted(): Promise<void>;
}

export type TenantListenTarget =
  | { readonly kind: "tcp" }
  | { readonly kind: "unix"; readonly path: string };

export interface StartTenantRuntimeInput {
  readonly tenantId: string;
  readonly configuration: ProductConfiguration;
  readonly magpieModels: Awaited<ReturnType<typeof expandConfigurationWithMagpieModels>>;
  readonly sources: ReturnType<typeof hostModelSources>;
  readonly workerTokenPath: string;
  readonly output: NodeJS.WritableStream;
  readonly errorOutput: NodeJS.WritableStream;
  readonly dependencies?: AgentServiceDependencies;
  readonly listen?: TenantListenTarget;
  readonly shared?: TenantRuntimeShared;
  readonly executionWorker?: TenantExecutionWorkerLauncher;
}

export interface TenantRuntimeHandle {
  readonly tenantId: string;
  readonly listenPath: string | undefined;
  readonly listenPort: number | undefined;
  readonly health: RuntimeHealthModel | undefined;
  stop(timeoutMs?: number): Promise<void>;
  onAuthorityLost(handler: (error: unknown) => void): void;
}

export const TENANT_RUNTIME_ERROR_CODES = Object.freeze({
  STOP_TIMEOUT: "TENANT_RUNTIME_STOP_TIMEOUT",
} as const);

export async function runAgentService(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
  dependencies: AgentServiceDependencies = {},
): Promise<number> {
  let handle: TenantRuntimeHandle | undefined;
  try {
    const args = parseServiceArguments(arguments_);
    const loadedConfiguration = await new JsonFileConfigurationPort(args.configurationPath).load();
    const sources = dependencies.secretSources ?? hostModelSources(loadedConfiguration);
    const magpieModels = await expandConfigurationWithMagpieModels(loadedConfiguration, {
      resolveSecret: (secretRef, secretVersion) =>
        sources.provider.resolve(secretRef, secretVersion),
      onDiagnostic: (event) =>
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          ...event,
        }),
    });
    const started = await startTenantRuntime({
      tenantId: magpieModels.configuration.ownerId,
      configuration: magpieModels.configuration,
      magpieModels,
      sources,
      workerTokenPath: args.workerTokenPath,
      output,
      errorOutput,
      dependencies,
    });
    handle = started;
    let lossError: unknown;
    const authorityLoss = new Promise<void>((resolve) =>
      started.onAuthorityLost((error) => {
        lossError = error;
        resolve();
      }),
    );
    const termination = await waitForTerminationOrAuthorityLoss(authorityLoss);
    const signal = termination.kind === "signal" ? termination.signal : "AUTHORITY_LOST";
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.draining",
      signal,
      ...(termination.kind === "signal" ? {} : { code: lossCode(lossError) }),
    });
    await started.stop();
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.stopped",
    });
    return termination.kind === "signal" ? 0 : 1;
  } catch (error) {
    await handle?.stop().catch(() => undefined);
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "service.failed",
      code: stableErrorCode(error),
      ...failureReasonField(error),
    });
    return 1;
  }
}

export async function startTenantRuntime(
  input: StartTenantRuntimeInput,
): Promise<TenantRuntimeHandle> {
  const { output, errorOutput, sources, magpieModels, configuration } = input;
  const dependencies = input.dependencies ?? {};
  const lifecycle = new ProductionServiceLifecycle();
  let repository: SqliteProductStateRepository | undefined;
  let authorityLifecycle: ReturnType<typeof createProductionAuthorityLifecycle> | undefined;
  let worker: AgentServiceExecutionClient | undefined;
  let admissionServer: ExecutionAdmissionUdsServer | undefined;
  let payloadServer: PayloadUdsServer | undefined;
  let modelComposition: ProductionConfiguredModelComposition | undefined;
  let memoryComposition: ProductionMemoryComposition | undefined;
  let memoryWorker: ProductionMemoryWorker | undefined;
  let piFilePreparationPool: ReturnType<typeof createPiFilePreparationPool> | undefined;
  let http: ProductionHttpComposition | undefined;
  let runs: ReturnType<typeof createProductionRunComposition> | undefined;
  let runDrain: ReturnType<ProductionRunDispatchLoop["stop"]> | undefined;
  let resourceOnlyLoop: ProductionRunDispatchLoop | undefined;
  let resourceRecoveryDrain: ReturnType<ProductionRunDispatchLoop["stop"]> | undefined;
  let health: RuntimeHealthModel | undefined;
  let runStopTimeoutMs = 30_000;
  let runInterruption: Promise<void> | undefined;
  let httpClosing: Promise<void> | undefined;
  let governedMemory: ReturnType<typeof createProductionRunMemory> | undefined;
  let runMemoryEpisodes: MemoryEpisodeService | undefined;
  let requeueStaleMemoryVectors: () => Promise<void> = async () => {};
  let webPush: ProductionWebPush | undefined;
  let proactive: ProductionProactive | undefined;
  let memoryClassifier: ProductionMemoryClassifier | undefined;
  let memoryImportDuplicates: ReturnType<typeof productionImportDuplicateChecker>;
  let museIntake: ProductionMuseIntake | undefined;
  let gapExport: ProductionGapExport | undefined;
  let mcpRead: ProductionMcpRead | undefined;
  let museControl: ProductionMuseControl | undefined;
  let observation: ProductionObservation | undefined;
  let realEval: ProductionRealEval | RealEvalSampleExpiry | undefined;
  const webPushPresence = new WebPushPresence();
  let durableMemory: DurableMemoryService | undefined;
  let protector: PayloadProtectorPort | undefined;
  let authorityLost = false;
  let authorityLossError: unknown;
  let resolveAuthorityLoss: (() => void) | undefined;
  const authorityLoss = new Promise<void>((resolve) => {
    resolveAuthorityLoss = resolve;
  });
  const failRuntime = (error: unknown, phase?: string) => {
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "runtime.failed",
      code: stableErrorCode(error),
      ...(phase === undefined ? {} : { phase }),
    });
    health?.setAuthorityActive(false);
    authorityLost = true;
    authorityLossError = error;
    resolveAuthorityLoss?.();
  };
  let reverseStop: Promise<void> | undefined;
  const stopReverseServices = (): Promise<void> => {
    if (reverseStop) return reverseStop;
    reverseStop = (async () => {
      await Promise.allSettled(
        [admissionServer?.stop(), payloadServer?.stop()].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        ),
      );
      admissionServer = undefined;
      payloadServer = undefined;
      worker?.stop();
    })();
    return reverseStop;
  };
  const runtimeTimers = new Set<NodeJS.Timeout>();
  lifecycle.register({ name: "repository", close: () => repository?.close() });
  lifecycle.register({
    name: "runtime-timers",
    stopAccepting: () => {
      for (const timer of runtimeTimers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      runtimeTimers.clear();
    },
    close: () => undefined,
  });
  lifecycle.register({
    name: "sensitive-interceptions",
    close: () => (repository === undefined ? undefined : flushSensitiveInterceptions(repository)),
  });
  lifecycle.register({
    name: "authority",
    close: () => authorityLifecycle?.stop(),
  });
  lifecycle.register({
    name: "model",
    close: () => modelComposition?.composition.close(),
  });
  lifecycle.register({
    name: "memory",
    close: () => memoryComposition?.close(),
  });
  lifecycle.register({
    name: "memory-worker",
    stopAccepting: () => memoryWorker?.stopAccepting(),
    drain: () => memoryWorker?.drain(),
    close: () => memoryWorker?.drain(),
  });
  lifecycle.register({
    name: "pi-file-preparation",
    close: () => piFilePreparationPool?.close(),
  });
  lifecycle.register({
    name: "worker-channels",
    close: stopReverseServices,
  });
  lifecycle.register({
    name: "runs",
    stopAccepting: () => {
      health?.setAuthorityActive(false);
      runs?.dispatcher.stopAccepting();
      runDrain = runs?.loop.stop(runStopTimeoutMs);
      void runDrain?.catch(() => undefined);
      runInterruption = runs?.coordinator.interruptAllExecutions("SERVICE_STOPPING");
      void runInterruption?.catch(() => undefined);
    },
    drain: async () => {
      if (!runs) return;
      await runInterruption;
      const drained = await runDrain;
      if (!drained?.drained) throw new Error("RUN_DRAIN_DEADLINE_EXCEEDED");
    },
    close: async () => {
      try {
        await runDrain;
      } finally {
        await runs?.titles?.stop();
        await runs?.memoryCapture?.stop();
        await runs?.memoryEpisodes?.stop();
        await runs?.memoryConsolidation?.stop();
        await webPush?.stop();
        await proactive?.stop();
        await realEval?.stop();
        await observation?.stop();
      }
    },
  });
  lifecycle.register({
    name: "resource-recovery",
    stopAccepting: () => {
      resourceRecoveryDrain = resourceOnlyLoop?.stop(runStopTimeoutMs);
      void resourceRecoveryDrain?.catch(() => undefined);
    },
    drain: async () => {
      const drained = await resourceRecoveryDrain;
      if (drained && !drained.drained) throw new Error("RESOURCE_RECOVERY_DRAIN_DEADLINE_EXCEEDED");
    },
    close: async () => {
      await resourceRecoveryDrain;
    },
  });
  lifecycle.register({
    name: "http",
    stopAccepting: async () => {
      health?.setAuthorityActive(false);
      httpClosing = http?.close();
      void httpClosing?.catch(() => undefined);
    },
    close: async () => {
      await (httpClosing ?? http?.close());
    },
  });
  try {
    for (const key of configuration.runPolicy?.retiredKeys ?? [])
      writeServiceDiagnostic(errorOutput, {
        component: "agent-service",
        event: "configuration.key_retired",
        key: `runPolicy.${key}`,
      });
    const webEnabled =
      configuration.publicMode ||
      (configuration.identity?.kind === "built-in" && Boolean(configuration.http));
    if (configuration.runPolicy?.mcpRead !== undefined && !webEnabled)
      throw new Error("MCP_READ_RUNTIME_UNAVAILABLE");
    if (
      webEnabled &&
      (!configuration.runPolicy ||
        !configuration.http ||
        !configuration.identity ||
        isDeterministicOnly(configuration))
    )
      throw new Error(SERVICE_RUNTIME_ERROR_CODES.PUBLIC_MODE_INCOMPLETE);
    runStopTimeoutMs = configuration.deadlines.providerRequestMs + 30_000;
    protector = configuredPayloadProtector(configuration, sources);
    const layout = await initializeStateRoot(configuration.stateRoot);
    const authorityFile = await readAuthorityFile(layout);
    if (authorityFile.status !== "active") {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_INACTIVE);
    }
    if (
      authorityFile.id !== configuration.deploymentId ||
      authorityFile.ownerId !== configuration.ownerId ||
      authorityFile.agentId !== configuration.agentId
    ) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    const persistedAuthority = inspectDeploymentAuthorityReadOnly(
      path.join(layout.data, "product.sqlite"),
      configuration.deploymentId,
    );
    if (
      persistedAuthority.ownerId !== authorityFile.ownerId ||
      persistedAuthority.agentId !== authorityFile.agentId ||
      persistedAuthority.status !== authorityFile.status ||
      persistedAuthority.transferId !== authorityFile.transferId
    ) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    repository = await SqliteProductStateRepository.open({
      stateRoot: configuration.stateRoot,
      databasePath: path.join(layout.data, "product.sqlite"),
      ...(input.shared?.extraReadThreadBudget
        ? { extraReadThreadBudget: input.shared.extraReadThreadBudget }
        : {}),
      onSlowOperation: (operation) =>
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          event: "sqlite.slow_operation",
          ...operation,
        }),
      onOperation: ({ queueWaitMs, runMs }) => {
        recordInCurrentRun("db.queue", queueWaitMs);
        recordInCurrentRun("db.run", runMs);
      },
    });
    writeStartupStep(output, "state-opened");
    const activeRepository = repository;
    const clock = productionClock();
    const ids = productionIds();
    authorityLifecycle = createProductionAuthorityLifecycle({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      deploymentId: configuration.deploymentId,
      deployment: repository.deploymentAuthorityPort(),
      leases: repository.authorityLeasePort(clock),
      clock,
      leaseDurationMs: AUTHORITY_LEASE_DURATION_MS,
      mirror: {
        read: () => readAuthorityFile(layout),
        write: (deployment) => writeAuthorityFile(layout, deployment),
      },
      onLost: (error, details) => {
        health?.setAuthorityActive(false);
        authorityLost = true;
        authorityLossError = error;
        resolveAuthorityLoss?.();
        void stopReverseServices();
        try {
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "authority.lost",
            code: lossCode(error),
            ...(details?.msSinceLastRenewal == null
              ? {}
              : { msSinceLastRenewal: details.msSinceLastRenewal }),
            leaseDurationMs: AUTHORITY_LEASE_DURATION_MS,
            renewalIntervalMs: AUTHORITY_RENEWAL_INTERVAL_MS,
          });
        } catch {}
      },
    });
    await authorityLifecycle.start();
    writeStartupStep(output, "authority-claimed");
    authorityLifecycle.startAutomaticRenewal(AUTHORITY_RENEWAL_INTERVAL_MS);
    const claimedAuthority = await readAuthorityFile(layout);
    const authority = authorityLifecycle.authorityFence();
    const authorityLease = authorityLifecycle.authorityLease();
    if (
      !sameConfiguredAuthority(claimedAuthority, configuration) ||
      claimedAuthority.authorityEpoch !== authority.authorityEpoch ||
      claimedAuthority.fencingToken !== authority.fencingToken
    ) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    const agentServiceInstanceId = `agent-service:${configuration.deploymentId}`;
    const agentServiceBootId = `agent-service-boot:${randomUUID()}`;
    const recovery = await repository.startupRecovery({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      authority: {
        deploymentId: configuration.deploymentId,
        authorityEpoch: authority.authorityEpoch,
        fencingToken: authority.fencingToken,
      },
      authorityLease: {
        leaseId: authorityLease.leaseId,
        fencingToken: authorityLease.fencingToken,
      },
    });
    const embedding = configuredEmbedding(configuration);
    const currentRunExecutionLease = async (
      runId: Parameters<ModelInvocationAdmissionResolver>[0]["runId"],
    ) => {
      const lease = await activeRepository
        .runDispatch(
          configuration.ownerId,
          configuration.agentId,
          authority,
          {
            leaseId: authorityLease.leaseId,
            fencingToken: authorityLease.fencingToken,
          },
          agentServiceBootId,
        )
        .currentExecutionLease?.({ runId, at: clock.now() });
      if (!lease) throw new Error("AUTOMATIC_REVIEW_LEASE_UNAVAILABLE");
      return claimFromRunExecutionLease(lease);
    };
    const modelAdmission: ModelInvocationAdmissionResolver = async (scope) => {
      if (scope.ownerId !== configuration.ownerId || scope.agentId !== configuration.agentId)
        return undefined;
      try {
        return runs?.admission({
          ...scope,
          executionLease: await currentRunExecutionLease(scope.runId),
        });
      } catch {
        return undefined;
      }
    };
    if (!isDeterministicOnly(configuration)) {
      const factory = dependencies.modelCompositionFactory ?? createDefaultModelComposition;
      modelComposition = await factory({
        configuration,
        repository,
        sources,
        admission: modelAdmission,
      });
      const memoryFactory = dependencies.memoryCompositionFactory ?? createDefaultMemoryComposition;
      memoryComposition = await memoryFactory({
        configuration,
        repository,
        sources,
        diagnostic: (event) => writeServiceDiagnostic(errorOutput, event),
      });
    }
    let automaticReview: ReturnType<typeof createProductionAutomaticReview>;
    if (configuration.runPolicy?.automaticReview !== undefined) {
      if (!modelComposition || !protector) throw new Error("AUTOMATIC_REVIEW_RUNTIME_UNAVAILABLE");
      automaticReview = createProductionAutomaticReview({
        configuration,
        model: modelComposition.composition.model,
        descriptors: modelComposition.descriptors.generation,
        handles: modelComposition.handles,
        payloads: activeRepository.payloadStore(configuration.ownerId, configuration.agentId),
        protector,
        store: activeRepository.automaticReviewStore(),
        executionLease: currentRunExecutionLease,
        clock,
        ids,
      });
    }
    await input.executionWorker?.ensureStarted();
    const credential = await readRestrictedExecutionTokenFile(input.workerTokenPath);
    const workerBinding = await waitForWorkerBootBinding({
      layout,
      configuration,
      authority: claimedAuthority,
      isAuthorityActive: () => authorityLifecycle?.isAccepting() === true && !authorityLost,
    });
    writeStartupStep(output, "worker-binding-read");
    const peerBinding: ExecutionAdmissionPeerBinding = Object.freeze({
      agentServiceInstanceId,
      agentServiceBootId,
      workerInstanceId: workerBinding.workerInstanceId,
      workerBootId: workerBinding.workerBootId,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
    });
    const parentBindings = createProductionWorkerParentBindingRegistry({
      trustedPeerBinding: () => peerBinding,
    });
    const invocationAuthority = () =>
      Object.freeze({
        product: authorityLifecycle?.authorityFence() ?? authority,
        lease: authorityLifecycle?.authorityLease() ?? authorityLease,
        agentServiceInstanceId,
        agentServiceBootId,
        workerInstanceId: peerBinding.workerInstanceId,
        workerBootId: peerBinding.workerBootId,
      });
    await recoverSandboxJobsAtStartup({
      journal: repository.sandboxJobJournal(configuration.ownerId, configuration.agentId),
      authority: invocationAuthority,
      now: () => clock.now(),
    });
    await recoverSandboxExecutionsAtStartup({
      preparations: repository.sandboxExecutionPreparations(
        configuration.ownerId,
        configuration.agentId,
      ),
      journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
      authority: invocationAuthority,
      now: () => clock.now(),
    });
    writeStartupStep(output, "sandbox-recovered");
    const workspaceNetwork = await resolveCodingNetworkFacts(configuration, clock);
    writeStartupStep(output, "coding-network-resolved");
    const workspaceAuto =
      workspaceNetwork && configuration.runPolicy?.coding
        ? new WorkspaceAutoAuthorization({
            configuration,
            repository,
            clock,
            ids,
            network: workspaceNetwork,
          })
        : undefined;
    if (workspaceAuto) await workspaceAuto.sync(invocationAuthority().lease);
    writeStartupStep(output, "workspace-synced");
    const hostWeb = createConfiguredHostWeb({
      runPolicy: configuration.runPolicy,
      secrets: sources.provider,
    });
    const hostReadOnlyPort = new DescriptorRelativeReadOnly();
    let externalEgress: ReturnType<typeof createProductionModelEgress> | undefined;
    let approvalThreadTitle: ((threadId: string) => Promise<string | null>) | undefined;
    const fileReadServices = createProductionFileReadServices({
      configuration,
      threadTitle: async (threadId) => (approvalThreadTitle ? approvalThreadTitle(threadId) : null),
      repository,
      authority: invocationAuthority,
      clock,
      ids,
      hostReadOnlyPort,
      workspaceSnapshotPort: hostReadOnlyPort,
      ...(hostWeb ? { hostWeb } : {}),
      externalTag: async () => {
        externalEgress ??= createProductionModelEgress(configuration, sources);
        try {
          return await externalEgress.externalTag();
        } catch (error) {
          externalEgress = undefined;
          throw error;
        }
      },
      ...(automaticReview ? { automaticReview } : {}),
      ...(workspaceAuto ? { workspaceAuto } : {}),
    });
    const reconcileTimer = setTimeout(() => {
      void fileReadServices.reconcileDeletedArtifacts?.().catch((error: unknown) => {
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          event: "thread.artifact.reconcile_failed",
          code: stableErrorCode(error),
        });
      });
    }, ARTIFACT_RECONCILE_DELAY_MS);
    reconcileTimer.unref();
    runtimeTimers.add(reconcileTimer);
    let workerSandboxSupport: SandboxExecutionSupport | undefined;
    const taskEnvironmentConfiguration = configuration.taskEnvironments;
    const sandboxServices = await createProductionSandboxServices({
      diagnosticOutput: errorOutput,
      backgroundCommandMs: backgroundCommandLimits(configuration.deadlines).maximumMs,
      createPiFilePreparation: () => {
        const sharedPool = input.shared?.piFilePreparationPool;
        if (sharedPool) return sharedPool.prepare;
        piFilePreparationPool = createPiFilePreparationPool({
          maxMemoryBytes: PI_FILE_PREPARATION_MEMORY_BYTES,
          onWarmupFailure: (error) => {
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "pi.preparation.warmup_failed",
              code: stableErrorCode(error),
            });
          },
          onWarmupRecovered: () => {
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "pi.preparation.warmup_recovered",
            });
          },
        });
        return piFilePreparationPool.prepare;
      },
      workerSupport: () => workerSandboxSupport,
      ...(taskEnvironmentConfiguration
        ? {
            taskEnvironments: {
              backendRef: taskEnvironmentConfiguration.backendRef,
              imageDigest: taskEnvironmentConfiguration.image.digest,
              lifecycle: new RemoteExecutionBackend({
                backendRef: taskEnvironmentConfiguration.backendRef,
                transport: {
                  request: (message) => {
                    if (!worker) throw new Error("SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE");
                    return worker.request(message);
                  },
                  events: (afterCursor) => {
                    if (!worker) throw new Error("SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE");
                    return worker.events(afterCursor);
                  },
                },
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                authority: () => invocationAuthority().product,
                nextId: (scope) => `${scope}:${randomUUID()}`,
                now: () => clock.now(),
                requestTimeoutMs: configuration.deadlines.workerRequestMs,
                resultTimeoutMs: configuration.deadlines.runMs,
                pollIntervalMs: 100,
              }),
            },
          }
        : {
            srtTaskEnvironments: srtTaskEnvironmentRoute(
              new RemoteExecutionBackend({
                backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
                transport: {
                  request: (message) => {
                    if (!worker) throw new Error("SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE");
                    return worker.request(message);
                  },
                  events: (afterCursor) => {
                    if (!worker) throw new Error("SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE");
                    return worker.events(afterCursor);
                  },
                },
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                authority: () => invocationAuthority().product,
                nextId: (scope) => `${scope}:${randomUUID()}`,
                now: () => clock.now(),
                requestTimeoutMs: configuration.deadlines.workerRequestMs,
                resultTimeoutMs: configuration.deadlines.runMs,
                pollIntervalMs: 100,
              }),
            ),
          }),
      configuration,
      repository,
      protector,
      authority: invocationAuthority,
      fileRead: fileReadServices,
      clock,
      ids,
    });
    writeStartupStep(output, "sandbox-services-created");
    const admission = new WorkerDelegationAdmissionService({
      ...(sandboxServices ? { sandbox: sandboxServices.child } : {}),
      invocations: repository.capabilityInvocationReceiptPort(
        configuration.ownerId,
        configuration.agentId,
      ),
      invocationAuthority,
      now: () => clock.now(),
      nextId: (scope) => ids.next(scope),
    });
    const admissionHandler = new ProductionExecutionAdmissionHandler({
      admission,
      parentBindings: parentBindings.reader,
      trustedPeerBinding: () => peerBinding,
    });
    const silenceWatch = new CommandSilenceWatch({
      onSilent: (detail) =>
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          event: "sandbox.command.silent",
          runId: detail.runId,
          silentMs: detail.silentMs,
        }),
      onResumed: (detail) =>
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          event: "sandbox.command.silence_ended",
          runId: detail.runId,
          silentMs: detail.silentMs,
        }),
    });
    const silenceTimer = setInterval(
      () => silenceWatch.check(Date.now()),
      COMMAND_SILENCE_CHECK_INTERVAL_MS,
    );
    silenceTimer.unref();
    runtimeTimers.add(silenceTimer);
    const payloadHandler = new ProductionPayloadBrokerHandler({
      silenceWatch,
      onSandboxExecutionRejected: (detail) =>
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          event: "sandbox.broker_command.rejected",
          command: detail.command,
          reason: detail.reason,
        }),
      ...(sandboxServices
        ? {
            sandboxJobs: sandboxServices.broker,
            sandboxExecutions: sandboxServices.brokerV2,
          }
        : {}),
      receipts: repository.capabilityInvocationReceiptPort(
        configuration.ownerId,
        configuration.agentId,
      ),
      results: repository.capabilityInvocationResultPort(
        configuration.ownerId,
        configuration.agentId,
      ),
      payloadsFor: (ownerId, agentId) => activeRepository.payloadStore(ownerId, agentId),
      protector,
      currentAuthority: () => ({
        product: authorityLifecycle?.authorityFence() ?? authority,
        lease: authorityLifecycle?.authorityLease() ?? authorityLease,
      }),
      clock,
      ids,
      agentServiceInstanceId,
      agentServiceBootId,
      maximumPayloadBytes: MAXIMUM_PAYLOAD_BYTES,
      allowedContentTypes: [
        "application/json",
        "text/plain",
        "text/markdown",
        "application/octet-stream",
      ],
    });
    admissionServer = new ExecutionAdmissionUdsServer({
      runtimeDirectory: configuration.runtimeDirectory,
      credential,
      trustedPeerBinding: () => peerBinding,
      maximumBodyBytes: MAXIMUM_BODY_BYTES,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
      now: () => clock.now(),
      nextId: (scope) => ids.next(scope),
      handler: admissionHandler,
    });
    payloadServer = new PayloadUdsServer({
      runtimeDirectory: configuration.runtimeDirectory,
      credential,
      agentServiceInstanceId,
      agentServiceBootId,
      allowedWorkerIdentities: [
        {
          workerInstanceId: peerBinding.workerInstanceId,
          workerBootId: peerBinding.workerBootId,
        },
      ],
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      maximumBodyBytes: payloadBrokerV1BodyBytes(MAXIMUM_PAYLOAD_BYTES),
      maximumPayloadBytes: MAXIMUM_PAYLOAD_BYTES,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
      handler: payloadHandler,
    });
    if (authorityLost || !authorityLifecycle.isAccepting()) {
      throw authorityLossError ?? new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
    }
    await admissionServer.start();
    try {
      await payloadServer.start();
    } catch (error) {
      await admissionServer.stop().catch(() => undefined);
      admissionServer = undefined;
      throw error;
    }
    if (authorityLost || !authorityLifecycle.isAccepting()) {
      throw authorityLossError ?? new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
    }
    await writeAgentServiceBootBinding(layout, {
      workerInstanceId: peerBinding.workerInstanceId,
      workerBootId: peerBinding.workerBootId,
      agentServiceInstanceId,
      agentServiceBootId,
      authorityLeaseId: authorityLease.leaseId,
      authority: claimedAuthority,
    });
    writeStartupStep(output, "agent-binding-written");
    let idSequence = 0;
    worker = new AgentServiceExecutionClient({
      socketPath: path.join(configuration.runtimeDirectory, "execution.sock"),
      credential,
      agentServiceInstanceId,
      maximumBodyBytes: MAXIMUM_BODY_BYTES,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      now: () => clock.now(),
      nextId: (scope) => {
        idSequence += 1;
        return `${scope}:${idSequence}:${randomUUID()}`;
      },
    });
    const handshake = await connectWorkerWithRetry(
      worker,
      configuration.deadlines.workerRequestMs,
      () => authorityLifecycle?.isAccepting() === true && !authorityLost,
    );
    writeStartupStep(output, "worker-connected");
    workerSandboxSupport = handshake.payload.supportedExecutions;
    if (authorityLost || !authorityLifecycle.isAccepting()) {
      throw authorityLossError ?? new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
    }
    if (memoryComposition) {
      const payloads = repository.payloadStore(configuration.ownerId, configuration.agentId);
      const activeProtector = protector;
      const memory = new DurableMemoryService({
        state: repository.productMemoryState(),
        jobs: repository.memoryProjectionJobs(),
        provider: memoryComposition.projection,
        dedupeSameSource: memoryComposition.dedupeSameSource,
        ...(webEnabled
          ? ({
              project: (job, memory, operation) => {
                if (!governedMemory) throw new Error("MEMORY_ADMISSION_NOT_READY");
                return governedMemory.project(job, memory, operation);
              },
            } satisfies Partial<ConstructorParameters<typeof DurableMemoryService>[0]>)
          : {}),
        content: {
          readText: async (ref) => {
            const payload = await payloads.get(ref);
            if (!payload) throw new Error("MEMORY_PAYLOAD_MISSING");
            return new TextDecoder("utf-8", { fatal: true }).decode(
              await activeProtector.unprotect({
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                payload,
              }),
            );
          },
        },
        projectionLeaseMs: configuration.deadlines.providerRequestMs + 30_000,
        workerId: `${agentServiceBootId}:memory`,
        now: () => clock.now(),
      });
      durableMemory = memory;
      const memoryIndex = repository.memoryIndex();
      const embedder = memoryComposition.projection.embedder;
      const embeddableClassifications = memoryComposition.projection.embeddableClassifications;
      requeueStaleMemoryVectors = async () => {
        let afterMemoryId: Parameters<typeof memoryIndex.listUnindexed>[0]["afterMemoryId"] = null;
        while (embedder) {
          const unindexed = await memoryIndex.listUnindexed({
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
            model: embedder.model,
            dimensions: embedder.dimensions,
            embeddableClassifications,
            afterMemoryId,
            limit: 500,
          });
          if (unindexed.length === 0) break;
          await memory.requeueProjection(unindexed);
          afterMemoryId = unindexed.at(-1) ?? null;
        }
      };
      if (!memoryComposition.localRuntime) await requeueStaleMemoryVectors();
      memoryWorker = new ProductionMemoryWorker({
        service: memory,
        assertActive: async () => {
          if (!authorityLifecycle) throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
          await authorityLifecycle.assertActive();
          if (authorityLost) throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
        },
        onFailure: (error) => {
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "memory-consumer.failed",
            code: stableErrorCode(error),
          });
          health?.setAuthorityActive(false);
          authorityLost = true;
          authorityLossError = error;
          resolveAuthorityLoss?.();
        },
      });
      if (!webEnabled) await memoryWorker.start();
    }
    let boundListenPort: number | undefined;
    let boundListenPath: string | undefined;
    if (webEnabled) {
      if (!modelComposition || !memoryComposition || !durableMemory || !protector || !worker)
        throw new Error("PUBLIC_RUNTIME_DEPENDENCY_MISSING");
      const activeAuthority = authorityLifecycle;
      const payloads = repository.payloadStore(configuration.ownerId, configuration.agentId);
      const artifacts = repository.runPayloadArtifactPort(
        configuration.ownerId,
        configuration.agentId,
        { product: authority, lease: authorityLease },
      );
      const capabilities = repository.capabilityStore(configuration.ownerId, configuration.agentId);
      health = new RuntimeHealthModel({
        publicMode: true,
        additionalRequired: ["run-dispatch", "memory-consumer"],
      });
      const recallProjection = memoryComposition.projection;
      const recallProtector = protector;
      const memoryRecall = new ProductionMemoryRecall({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        provider: { search: (input) => recallProjection.search(input) },
        dedupeSameSource: memoryComposition.dedupeSameSource,
        state: repository.productMemoryState(),
        episodes: {
          search: (input) =>
            runMemoryEpisodes ? runMemoryEpisodes.search(input) : Promise.resolve([]),
        },
        readText: async (record) => {
          const payload = await payloads.get(record.contentRef);
          if (!payload || payload.contentType !== "text/plain") return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await recallProtector.unprotect({
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              payload,
            }),
          );
        },
        embedWithin: (invocation, slot, operation) => {
          const memory = governedMemory;
          const executionLease = invocation.context?.executionLease;
          if (!memory || !executionLease) throw new Error("MEMORY_RECALL_NOT_READY");
          return memory.embedWithin(
            {
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              runId: invocation.runId,
              executionLease,
              deadlineAt:
                invocation.executionDeadlineAt ??
                new Date(
                  Date.parse(clock.now()) + configuration.deadlines.providerRequestMs,
                ).toISOString(),
              dataClassification: invocation.dataClassification,
              slot: `${slot}:${invocation.toolCallId}`,
            },
            operation,
          );
        },
        now: () => clock.now(),
        ...(configuration.runPolicy?.timeZone
          ? { timeZone: configuration.runPolicy.timeZone }
          : {}),
      });
      const reminderTimeZone = configuration.runPolicy?.timeZone;
      const reminderWriter = new ProductionReminderWriter({
        configuration,
        memory: durableMemory,
        state: repository.productMemoryState(),
        book: repository.memoryBook(),
        reminders: repository.memoryReminders(),
        payloads,
        protector: recallProtector,
        clock: { now: () => clock.now() },
        ...(reminderTimeZone ? { timeZone: reminderTimeZone } : {}),
      });
      const reminderTools = new ProductionReminderTools({
        writer: reminderWriter,
        ...(reminderTimeZone ? { timeZone: reminderTimeZone } : {}),
      });
      const ownerRuleWriter = new ProductionOwnerRuleWriter({
        configuration,
        rules: repository.ownerRules(),
        reviews: repository.ruleReviews(),
        memory: durableMemory,
        memories: repository.productMemoryState(),
        book: repository.memoryBook(),
        threads: repository.threadRepository(),
        payloads,
        protector: recallProtector,
        clock: { now: () => clock.now() },
        replay: (rule) =>
          proactive ? proactive.replayRule(rule) : Promise.reject(new Error("no mail check")),
      });
      const ownerRuleTools = new ProductionOwnerRuleTools(ownerRuleWriter);
      const toolActions = productionToolActionRegistry();
      const installedCapabilities = repository.capabilityStore(
        configuration.ownerId,
        configuration.agentId,
      );
      const ownerScope = new OwnerScopeAuthorization({
        configuration,
        store: repository.authorizationStore(),
        audit: repository.auditLedger(),
        state: repository,
        authority: () => invocationAuthority().lease,
        source: repository.runExecutionSource(configuration.ownerId, configuration.agentId),
        installedCapabilities: {
          inspect: async (ref) => {
            const record = await installedCapabilities.get(ref);
            const manifest = record?.declaration as CapabilityManifest | undefined;
            return record && manifest?.manifestVersion === "capability.v2"
              ? { lifecycle: record.lifecycle, manifest }
              : undefined;
          },
        },
        registry: toolActions,
        clock,
        ids,
        intentLifetimeMs: configuration.deadlines.workerRequestMs,
      });
      const tools = new ProductionRuntimeTools({
        memoryRecall,
        reminders: reminderTools,
        ownerRules: ownerRuleTools,
        toolActions,
        ownerScope,
        fileReadEnabled: configuration.runPolicy?.fileRead !== undefined,
        ...(configuration.runPolicy?.publicSearch
          ? { publicSearch: configuration.runPolicy.publicSearch }
          : {}),
        ...(configuration.runPolicy?.publicFetch
          ? { publicFetch: configuration.runPolicy.publicFetch }
          : {}),
        ...(configuration.runPolicy?.coding ? { coding: configuration.runPolicy.coding } : {}),
        backgroundCommands: backgroundCommandLimits(configuration.deadlines),
        fileRead: fileReadServices,
        ...(sandboxServices
          ? {
              sandbox: sandboxServices.runtime,
              completeSandboxToolResult: sandboxServices.completeToolResult,
              maximumResourceCeiling: sandboxServices.maximumResourceCeiling,
              managedTasks: sandboxServices.managedTasks,
              taskHandle: sandboxServices.taskHandle,
            }
          : {}),
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        capabilities,
        invocations: repository.capabilityInvocationReceiptPort(
          configuration.ownerId,
          configuration.agentId,
        ),
        transport: worker,
        parents: parentBindings.writer,
        peer: () => peerBinding,
        authority: invocationAuthority,
        assertRunActive: async (runId) => {
          await activeAuthority.assertActive();
          const run = await activeRepository
            .runLifecycle(configuration.ownerId, configuration.agentId, authority)
            .readRun(runId);
          if (!run || !["accepted", "building_context", "running"].includes(run.run.status))
            throw new Error("RUN_NOT_ACTIVE");
        },
        results: repository.capabilityInvocationResultPort(
          configuration.ownerId,
          configuration.agentId,
        ),
        artifacts,
        payloads,
        protector,
        ceiling: {
          maxWallTimeMs: configuration.deadlines.workerRequestMs,
          maxCpuTimeMs: configuration.deadlines.workerRequestMs,
          maxMemoryBytes: SANDBOX_TOOL_MEMORY_LIMIT_BYTES,
          maxOutputBytes: MAXIMUM_PAYLOAD_BYTES,
          maxProgressEvents: 100,
        },
        clock,
        ids,
      });
      const admission: ModelInvocationAdmissionResolver = (scope) => runs?.admission(scope);
      const memory = createProductionRunMemory({
        configuration,
        memory: durableMemory,
        projection: memoryComposition,
        budget: repository.modelBudgetPort(
          configuration.ownerId,
          configuration.agentId,
          authority,
          authorityLease,
        ),
        assertActive: () => activeAuthority.assertActive(),
        now: () => clock.now(),
        payloads,
        admission,
        diagnostic: (event) => writeServiceDiagnostic(errorOutput, event),
      });
      governedMemory = memory;
      const episodePayloads = repository.payloadStore(configuration.ownerId, configuration.agentId);
      const episodeProtector = protector;
      if (episodeProtector) {
        approvalThreadTitle = classifiedThreadTitleReader({
          configuration,
          threads: repository.threadRepository(),
          payloads: episodePayloads,
          protector: episodeProtector,
        });
      }
      const memoryEpisodes =
        memoryComposition && episodeProtector
          ? new MemoryEpisodeService({
              store: repository.memoryEpisodes(),
              threads: repository.threadRepository(),
              readText: async ({ ownerId, agentId, ref }) => {
                const payload = await episodePayloads.get(ref);
                if (!payload || payload.contentType !== "text/plain") return undefined;
                return new TextDecoder("utf-8", { fatal: true }).decode(
                  await episodeProtector.unprotect({
                    ownerId,
                    agentId,
                    payload,
                  }),
                );
              },
              storeText: async (input) => {
                if (await episodePayloads.get(input.ref)) return;
                await episodePayloads.put(
                  await episodeProtector.protect({
                    ownerId: input.ownerId,
                    agentId: input.agentId,
                    ref: input.ref,
                    contentType: "text/plain",
                    dataClassification: input.dataClassification,
                    plaintext: new TextEncoder().encode(input.text),
                    createdAt: input.createdAt,
                  }),
                );
              },
              embedder: memoryComposition.projection.embedder,
              ...(configuration.runPolicy?.timeZone
                ? { timeZone: configuration.runPolicy.timeZone }
                : {}),
              now: () => clock.now(),
            })
          : undefined;
      const embedWithin = <T>(
        request: RuntimeRequest,
        slot: string,
        operation: () => Promise<T>,
        dataClassification: RuntimeRequest["dataClassification"] = "private",
      ) =>
        memory.embedWithin(
          {
            ownerId: request.ownerId,
            agentId: request.agentId,
            runId: request.runId,
            executionLease: request.executionLease,
            deadlineAt:
              request.executionDeadlineAt ??
              new Date(
                Date.parse(clock.now()) + configuration.deadlines.providerRequestMs,
              ).toISOString(),
            dataClassification,
            slot,
          },
          operation,
        );
      const consolidationPayloads = repository.payloadStore(
        configuration.ownerId,
        configuration.agentId,
      );
      const consolidationJobs = repository.memoryProjectionJobs();
      const consolidationState = repository.productMemoryState();
      const memoryConsolidation =
        memoryComposition && episodeProtector && durableMemory
          ? new MemoryConsolidationService({
              store: repository.memoryConsolidation(),
              state: consolidationState,
              memory: durableMemory,
              generationFor: async (memoryId) =>
                (await consolidationJobs.listByMemory(memoryId)).at(-1)?.generationId,
              readText: async (record) => {
                const payload = await consolidationPayloads.get(record.contentRef);
                if (!payload || payload.contentType !== "text/plain") return undefined;
                return new TextDecoder("utf-8", { fatal: true }).decode(
                  await episodeProtector.unprotect({
                    ownerId: configuration.ownerId,
                    agentId: configuration.agentId,
                    payload,
                  }),
                );
              },
              readQuote: async (record) => {
                const events = await consolidationState.listHistory({
                  ownerId: configuration.ownerId,
                  agentId: configuration.agentId,
                  memoryIds: [record.id],
                });
                const quoteRef = quoteRefOfMemory(events, record.contentRef);
                if (!quoteRef) return undefined;
                const payload = await consolidationPayloads.get(quoteRef);
                if (!payload || payload.contentType !== "text/plain") return undefined;
                return new TextDecoder("utf-8", { fatal: true }).decode(
                  await episodeProtector.unprotect({
                    ownerId: configuration.ownerId,
                    agentId: configuration.agentId,
                    payload,
                  }),
                );
              },
              storeText: async (input) => {
                const ref = `memory-content:${createHash("sha256").update(input.key).digest("hex")}`;
                if (await consolidationPayloads.get(ref)) return ref;
                await consolidationPayloads.put(
                  await episodeProtector.protect({
                    ownerId: input.ownerId,
                    agentId: input.agentId,
                    ref,
                    contentType: "text/plain",
                    dataClassification: input.dataClassification,
                    plaintext: new TextEncoder().encode(input.text),
                    createdAt: input.createdAt,
                  }),
                );
                return ref;
              },
              now: () => clock.now(),
              ...(configuration.runPolicy?.timeZone
                ? { timeZone: configuration.runPolicy.timeZone }
                : {}),
            })
          : undefined;
      const consolidationProjection = memoryComposition.projection;
      runMemoryEpisodes = memoryEpisodes;
      const localEmbedding = memoryComposition.localRuntime;
      if (localEmbedding) {
        const catchUpLocalVectors = async () => {
          await requeueStaleMemoryVectors();
          if (!memoryEpisodes) return;
          for (;;) {
            const embedded = await memoryEpisodes.backfillEmbeddings({
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              limit: 100,
              within: ({ dataClassification }, operation) =>
                memory.embedForMaintenance(
                  {
                    deadlineAt: new Date(
                      Date.parse(clock.now()) + configuration.deadlines.providerRequestMs,
                    ).toISOString(),
                    dataClassification,
                  },
                  operation,
                ),
            });
            if (embedded === 0) break;
          }
        };
        const catchUp = createLocalVectorCatchUp({
          run: catchUpLocalVectors,
          failed: (error, retryInMs) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "memory.embedding_catch_up_failed",
              code: stableErrorCode(error),
              retryInMs: String(retryInMs),
            }),
        });
        localEmbedding.observe((state, reasonCode) => {
          const ready = state === "ready";
          health?.observe({
            name: "memory-embedding",
            required: false,
            status: ready ? "healthy" : "unavailable",
            reasonCode: ready ? null : (reasonCode ?? `EMBEDDING_LOCAL_${state.toUpperCase()}`),
          });
          writeServiceDiagnostic(output, {
            component: "agent-service",
            event: "memory.embedding_local_state",
            state,
            ...(reasonCode === null ? {} : { code: reasonCode }),
          });
          catchUp.observe(ready);
        });
        void localEmbedding.start();
      }
      const proactiveConfiguration = configuration.runPolicy?.proactive;
      const proactiveGmail = proactiveConfiguration?.gmail;
      const proactiveSecret = proactiveGmail
        ? configuration.secretReferences.find(
            ({ ref, purpose }) =>
              ref === proactiveGmail.clientSecretRef &&
              purpose === GOOGLE_OAUTH_CLIENT_SECRET_PURPOSE,
          )
        : undefined;
      const proactiveDescriptor = proactiveConfiguration
        ? modelComposition.descriptors.generation.find(
            ({ ref }) => ref === proactiveConfiguration.modelRef,
          )
        : undefined;
      const proactiveScope = {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
      };
      const proactiveStore =
        proactiveConfiguration &&
        (proactiveSecret || proactiveConfiguration.demoInbox) &&
        proactiveDescriptor
          ? repository.proactive()
          : undefined;
      const proactiveSeal =
        proactiveStore && protector
          ? createProactiveSeal({
              payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
              protector,
              ids,
            })
          : undefined;
      memoryImportDuplicates = productionImportDuplicateChecker(
        configuration,
        hostModelSources(configuration).provider,
        (error) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "memory.import_duplicates_failed",
            code: importDuplicateFailureCode(error),
          }),
      );
      const classifierModels = modelComposition;
      if (proactiveConfiguration && proactiveDescriptor && classifierModels)
        memoryClassifier = new ProductionMemoryClassifier({
          model: createRealEvalModel({
            modelRef: proactiveConfiguration.modelRef,
            invoker: (maxOutputTokens) =>
              classifierModels.composition.proactiveModel(proactiveConfiguration.modelRef, {
                maxOutputTokens,
                requestTimeoutMs: proactiveConfiguration.perCheckMs,
                purpose: "memory-capture",
              }),
            cost: proactiveDescriptor.cost,
            requestTimeoutMs: proactiveConfiguration.perCheckMs,
            now: () => clock.now(),
          }),
          dailyLimitMicros: proactiveConfiguration.dailyCostMicros,
          batchCharacters: MEMORY_CLASSIFICATION_BATCH_CHARACTERS,
          outputTokensPerItem: MEMORY_CLASSIFICATION_OUTPUT_TOKENS_PER_ITEM,
          timeZone: configuration.runPolicy?.timeZone ?? "UTC",
          now: () => clock.now(),
          newId: () => ids.next("memory-classify"),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "memory.classify_failed",
              code: memoryClassificationFailureCode(error),
            }),
        });
      if (
        proactiveConfiguration &&
        (proactiveSecret || proactiveConfiguration.demoInbox) &&
        proactiveDescriptor &&
        proactiveStore &&
        proactiveSeal
      ) {
        const demoInbox = proactiveConfiguration.demoInbox;
        const oauth = demoInbox
          ? createDemoGoogleOAuth()
          : createGoogleOAuth({
              clientId: requireValue(proactiveGmail).clientId,
              clientSecret: await hostModelSources(configuration).provider.resolve(
                requireValue(proactiveSecret).ref,
                requireValue(proactiveSecret).version,
              ),
              redirectUri: proactiveRedirectUri(configuration.publicOrigin),
            });
        const feedbackStore = repository.webPush();
        const reviewPayloads = repository.payloadStore(
          configuration.ownerId,
          configuration.agentId,
        );
        const proactiveMemoryState = repository.productMemoryState();
        const readReviewText = async (ref: string) => {
          const payload = await reviewPayloads.get(ref);
          if (!payload || payload.contentType !== "text/plain" || !protector) return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await protector.unprotect({
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              payload,
            }),
          );
        };
        const mailEgress = createProductionModelEgress(
          configuration,
          sources,
          productionSensitiveInterceptionRecorder(repository),
        );
        const proactiveTimeZone = configuration.runPolicy?.timeZone ?? "UTC";
        const checkupScope = {
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
        };
        const checkupJobs = repository.memoryProjectionJobs();
        const checkupBook = repository.memoryBook();
        const checkupConsolidation = repository.memoryConsolidation();
        const checkup = durableMemory
          ? new MemoryCheckupService({
              scope: checkupScope,
              store: repository.memoryCheckup(),
              state: proactiveMemoryState,
              memory: durableMemory,
              generationFor: async (memoryId) => {
                const generation =
                  (await checkupJobs.listByMemory(memoryId)).at(-1)?.generationId ??
                  (await checkupBook.latestGeneration(checkupScope));
                if (!generation) throw new Error("MEMORY_GENERATION_MISSING");
                return generation;
              },
              sourceMessageIds: (records) =>
                findSourceMessageIds(checkupBook, checkupScope, records),
              pairs: async () =>
                (
                  await checkupConsolidation.listHeldPairs({
                    ...checkupScope,
                    openOnly: true,
                  })
                ).map(([memoryId, relatedMemoryId]) => ({
                  memoryId,
                  relatedMemoryId,
                })),
              unusedDays: proactiveConfiguration.reviewMemoryUnusedDays,
              lowConfidenceThreshold: (category) => autoCommitThreshold(category),
              capacity: () =>
                reviewCapacity(
                  proactiveConfiguration.reviewBudgetSeconds,
                  proactiveConfiguration.reviewSecondsPerItem,
                ),
              timeZone: proactiveTimeZone,
              now: () => clock.now(),
              id: () => ids.next("memory-checkup"),
            })
          : undefined;
        proactive = new ProductionProactive({
          ...(checkup ? { checkup } : {}),
          onMasked: (sightings) =>
            void mailEgress.reportMasked(
              {
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                threadId: null,
                source: "mail",
                purpose: "mail-judgment",
              },
              "mail",
              sightings,
            ),
          scope: proactiveScope,
          configuration: proactiveConfiguration,
          timeZone: configuration.runPolicy?.timeZone ?? "UTC",
          store: proactiveStore,
          ownerRules: repository.ownerRules(),
          seal: proactiveSeal,
          oauth,
          reader: demoInbox
            ? createDemoMailReader({ now: () => clock.now(), timeZone: proactiveTimeZone })
            : createGmailReader({ oauth }),
          readAccount: (accessToken) => readGmailAccount({ accessToken }),
          ledger: repository.decisionLedger(),
          readMemoryText: readReviewText,
          readMemory: async (memoryId) => {
            const record = await proactiveMemoryState.read(memoryId as ProductMemoryRecord["id"]);
            if (
              !record ||
              record.ownerId !== configuration.ownerId ||
              record.agentId !== configuration.agentId ||
              record.status === "deleted_verified" ||
              record.status === "deletion_pending"
            )
              return undefined;
            if (!reviewMemoryVisible(record.dataClassification)) return { text: "", hidden: true };
            const text = await readReviewText(record.contentRef);
            return text === undefined
              ? undefined
              : { text, hidden: false, dataClassification: record.dataClassification };
          },
          ...(memory && durableMemory && protector && repository
            ? ((recallProtector, recallPayloads) => ({
                memory: createProactiveMemoryRecall({
                  ownerId: configuration.ownerId,
                  agentId: configuration.agentId,
                  memory: durableMemory,
                  content: {
                    readText: async (ref) => {
                      const payload = await recallPayloads.get(ref);
                      if (!payload) throw new Error("MEMORY_PAYLOAD_MISSING");
                      return new TextDecoder("utf-8", { fatal: true }).decode(
                        await recallProtector.unprotect({
                          ownerId: configuration.ownerId,
                          agentId: configuration.agentId,
                          payload,
                        }),
                      );
                    },
                  },
                  embedForMailCheck: memory.embedForMailCheck,
                  minimumSimilarity:
                    proactiveConfiguration.memoryMinimumSimilarity ??
                    memoryComposition.profile.proactiveMinimumSimilarity,
                  hitsPerMail: DEFAULT_PROACTIVE_MEMORY_LIMITS.perMail,
                  concurrency: 4,
                }),
              }))(protector, repository.payloadStore(configuration.ownerId, configuration.agentId))
            : {}),
          ...(memory && memoryEpisodes && repository
            ? ((book) => ({
                recentSummaries: createProactiveRecentSummaries({
                  ownerId: configuration.ownerId,
                  agentId: configuration.agentId,
                  episodes: memoryEpisodes,
                  allowedClassifications: proactiveDescriptor.allowedDataClassifications,
                  capturePaused: () =>
                    book
                      .readSettings({
                        ownerId: configuration.ownerId,
                        agentId: configuration.agentId,
                      })
                      .then(({ capturePaused }) => capturePaused),
                  embedForMailCheck: memory.embedForMailCheck,
                }),
              }))(repository.memoryBook())
            : {}),
          model: modelComposition.composition.proactiveModel(proactiveConfiguration.modelRef, {
            maxOutputTokens: PROACTIVE_MAX_OUTPUT_TOKENS,
            requestTimeoutMs: proactiveConfiguration.perCheckMs,
          }),
          estimateCostMicros: proactiveCostEstimator(
            proactiveDescriptor.cost,
            PROACTIVE_MAX_OUTPUT_TOKENS,
          ),
          readMemoryClassification: async (ref) =>
            (await reviewPayloads.get(ref).catch(() => undefined))?.dataClassification,
          prereview: {
            store: repository.reviewPrereview(),
            model: modelComposition.composition.proactiveModel(proactiveConfiguration.modelRef, {
              maxOutputTokens: PREREVIEW_MAX_OUTPUT_TOKENS,
              requestTimeoutMs: proactiveConfiguration.reviewPrereview.requestTimeoutMs,
              purpose: "review-prereview",
            }),
            digest: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
            estimateCostMicros: proactiveCostEstimator(
              proactiveDescriptor.cost,
              PREREVIEW_MAX_OUTPUT_TOKENS,
            ),
          },
          ruleReview: ((service, reviews) => ({
            run: async () => {
              await expandMemoryReviews(reviews, proactiveScope, () => clock.now());
              return service.run();
            },
          }))(
            new RuleReviewService({
              scope: proactiveScope,
              clock,
              store: repository.ruleReviews(),
              memories: proactiveMemoryState,
              readMemoryText: async (record) => {
                const text = await readReviewText(record.contentRef);
                if (text === undefined) throw new Error("RULE_REVIEW_MEMORY_UNREADABLE");
                return text;
              },
              model: modelComposition.composition.proactiveModel(proactiveConfiguration.modelRef, {
                maxOutputTokens: RULE_REVIEW_MAX_OUTPUT_TOKENS,
                requestTimeoutMs: proactiveConfiguration.perCheckMs,
                purpose: "rule-review",
              }),
              nextInvocationId: () => ids.next("rule-review"),
            }),
            repository.memoryReviews(),
          ),
          onRuleReview: (reports) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "rule.reviewed",
              reviewed: reports.length,
              suspended: reports.filter(({ outcome }) => outcome === "suspended").length,
              cleared: reports.filter(({ outcome }) => outcome === "cleared").length,
            }),
          onPrereview: (result) => {
            if (result.attempted > 0 || result.failures.length > 0)
              writeServiceDiagnostic(errorOutput, {
                component: "agent-service",
                event: "proactive.prereviewed",
                attempted: result.attempted,
                recorded: result.recorded,
                failed: result.failures.length,
                stoppedBy: result.stoppedBy,
                ...(result.failures[0] ? { code: result.failures[0].slice(0, 120) } : {}),
              });
          },
          feedback: (sentFrom) =>
            feedbackStore.listFeedback({
              ...proactiveScope,
              sentFrom,
              limit: 500,
            }),
          clock,
          ids,
          onDecision: (decision) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "proactive.checked",
              verdict: decision.verdict,
              code: decision.reasonCode,
              fetched: decision.counts.fetched,
              pushed: decision.counts.pushed,
              costMicros: decision.costMicros,
            }),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "proactive.failed",
              code: stableErrorCode(error),
            }),
        });
      }
      const realEvalConfiguration = configuration.runPolicy?.realEval;
      const realEvalDescriptor = realEvalConfiguration
        ? modelComposition.descriptors.generation.find(
            ({ ref }) => ref === realEvalConfiguration.modelRef,
          )
        : undefined;
      if (realEvalConfiguration && realEvalConfiguration.mode !== "off") {
        if (!realEvalDescriptor || !protector || !durableMemory)
          throw new Error("REAL_EVAL_RUNTIME_UNAVAILABLE");
        const realEvalProtector = protector;
        const realEvalRepository = repository;
        const realEvalModels = modelComposition;
        const realEvalPayloads = repository.payloadStore(
          configuration.ownerId,
          configuration.agentId,
        );
        realEval = createProductionRealEval({
          configuration: realEvalConfiguration,
          scope: { ownerId: configuration.ownerId, agentId: configuration.agentId },
          memoryLimit: configuration.runPolicy?.memoryLimit ?? 1,
          maxSelectedMemories: configuration.runPolicy?.maxSelectedMemories ?? 0,
          recallEstimateMicros: configuration.modelDescriptors.some(
            ({ role }) => role === "embedding",
          )
            ? embeddingAdmissionDescriptor(configuration).estimatedCostMicros
            : 0,
          store: repository.realEval(),
          state: repository.productMemoryState(),
          payloads: realEvalPayloads,
          protector: realEvalProtector,
          memory: durableMemory,
          embed: memory.embedForMailCheck,
          profile: (keep) =>
            new OwnerProfileService({
              state: realEvalRepository.productMemoryState(),
              pins: realEvalRepository.memoryBook(),
              readText: async (record) => {
                const payload = await realEvalPayloads.get(record.contentRef);
                if (!payload || payload.contentType !== "text/plain") return undefined;
                try {
                  return new TextDecoder("utf-8", { fatal: true }).decode(
                    await realEvalProtector.unprotect({
                      ownerId: configuration.ownerId,
                      agentId: configuration.agentId,
                      payload,
                    }),
                  );
                } catch {
                  return undefined;
                }
              },
              storeText: async ({ ref, text }) => keep(ref, text),
              digest: (text) => createHash("sha256").update(text).digest("hex"),
              ...(configuration.runPolicy?.timeZone
                ? { timeZone: configuration.runPolicy.timeZone }
                : {}),
            }),
          model: createRealEvalModel({
            modelRef: realEvalConfiguration.modelRef,
            invoker: (maxOutputTokens) =>
              realEvalModels.composition.proactiveModel(realEvalConfiguration.modelRef, {
                maxOutputTokens,
                requestTimeoutMs: realEvalConfiguration.requestTimeoutMs,
                purpose: "other",
              }),
            cost: realEvalDescriptor.cost,
            requestTimeoutMs: realEvalConfiguration.requestTimeoutMs,
            now: () => clock.now(),
          }),
          ledger: realEvalRepository.decisionLedger(),
          sampleDirectory: path.join(configuration.stateRoot, "real-eval"),
          now: () => clock.now(),
          newId: () => ids.next("real-eval"),
          onRun: (report, trigger) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "real-eval.completed",
              trigger,
              outcome: report.outcome,
              costMicros: report.costMicros,
            }),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "real-eval.failed",
              code: stableErrorCode(error),
            }),
        });
      } else
        realEval = new RealEvalSampleExpiry({
          directory: path.join(configuration.stateRoot, "real-eval"),
          now: () => clock.now(),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "real-eval.failed",
              code: stableErrorCode(error),
            }),
        });
      const museIntakeConfiguration = configuration.runPolicy?.museIntake;
      const museIntakeSecret =
        museIntakeConfiguration?.enabled === true
          ? configuration.secretReferences.find(
              ({ ref, purpose }) =>
                ref === museIntakeConfiguration.secretRef && purpose === MUSE_INTAKE_SECRET_PURPOSE,
            )
          : undefined;
      if (museIntakeSecret && protector) {
        const museSeal = createProactiveSeal({
          payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
          protector,
          ids,
        });
        museControl = new ProductionMuseControl({
          scope: proactiveScope,
          store: repository.museIntake(),
          seal: museSeal,
          ids,
          clock,
        });
        museIntake = new ProductionMuseIntake({
          scope: proactiveScope,
          store: repository.museIntake(),
          seal: museSeal,
          ids,
          clock,
          secret: await hostModelSources(configuration).provider.resolve(
            museIntakeSecret.ref,
            museIntakeSecret.version,
          ),
        });
      } else if (museIntakeConfiguration?.enabled === true) {
        throw new Error("MUSE_INTAKE_RUNTIME_UNAVAILABLE");
      }
      const gapExportRef = museIntakeConfiguration?.gapExportSecretRef;
      const gapExportSecret =
        museIntakeConfiguration?.enabled === true && gapExportRef !== undefined
          ? configuration.secretReferences.find(
              ({ ref, purpose }) => ref === gapExportRef && purpose === GAP_EXPORT_SECRET_PURPOSE,
            )
          : undefined;
      if (gapExportSecret && protector) {
        gapExport = new ProductionGapExport({
          scope: {
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
          },
          marks: repository.gapCaseMarks(),
          seal: createProactiveSeal({
            payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
            protector,
            ids,
          }),
          clock,
          secret: await hostModelSources(configuration).provider.resolve(
            gapExportSecret.ref,
            gapExportSecret.version,
          ),
        });
      } else if (gapExportRef !== undefined && museIntakeConfiguration?.enabled === true) {
        throw new Error("GAP_EXPORT_RUNTIME_UNAVAILABLE");
      }
      const externalProposals = new ProductionMcpMemoryWriter({
        configuration,
        memory: durableMemory,
        state: repository.productMemoryState(),
        book: repository.memoryBook(),
        ledger: repository.decisionLedger(),
        proposals: repository.externalMemoryProposals(),
        payloads,
        protector: recallProtector,
        clock: { now: () => clock.now() },
      });
      const mcpReadConfiguration = configuration.runPolicy?.mcpRead;
      const mcpIdentity =
        configuration.identity && configuration.identity.kind !== "built-in"
          ? configuration.identity
          : undefined;
      if (mcpReadConfiguration && mcpIdentity) {
        const settingsStore = repository.proactive();
        const ownerRuleStore = repository.ownerRules();
        const profileState = repository.productMemoryState();
        const profilePins = repository.memoryBook();
        mcpRead = new ProductionMcpRead({
          scope: {
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
          },
          clock,
          owners: repository.ownerIdentityState(),
          access: new CloudflareAccessJwtVerifier({
            issuer: mcpIdentity.issuer,
            audience: mcpReadConfiguration.audience,
            jwksUrl: mcpIdentity.jwksUrl,
            jwksFetcher:
              dependencies.httpOptions?.jwksFetcher ??
              new BoundedJwksFetcher({
                allowedUrl: mcpIdentity.jwksUrl,
                timeoutMilliseconds: mcpIdentity.jwksTimeoutMilliseconds,
                maximumBodyBytes: mcpIdentity.jwksMaximumBodyBytes,
              }),
            now: () => new Date(clock.now()),
            cacheMilliseconds: mcpIdentity.jwksCacheMilliseconds,
            clockToleranceSeconds: mcpIdentity.clockToleranceSeconds,
          }),
          ...(mcpReadConfiguration.proposals
            ? {
                write: {
                  proposals: externalProposals,
                  rules: new ProductionMcpRuleWriter({
                    configuration,
                    rules: ownerRuleWriter,
                    payloads,
                    protector: recallProtector,
                    clock: { now: () => clock.now() },
                    onFailure: (error) =>
                      writeServiceDiagnostic(errorOutput, {
                        component: "agent-service",
                        event: "mcp-rule.marker-failed",
                        code: stableErrorCode(error),
                      }),
                  }),
                },
              }
            : {}),
          timeZone: configuration.runPolicy?.timeZone ?? "UTC",
          requestTimeoutMs: configuration.deadlines.providerRequestMs,
          sources: {
            recall: (args, within, ceiling) => memoryRecall.recallOutsideRun(args, within, ceiling),
            embedOutsideRun: (context, operation) =>
              memory.embedForExternalRead(context, operation),
            reminders: (windowMs, ceiling) => reminderWriter.list(windowMs, ceiling),
            settings: () =>
              settingsStore.readSettings({
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
              }),
            profile: (maxClassification) =>
              new OwnerProfileService({
                state: profileState,
                pins: profilePins,
                readText: async (record) => {
                  const payload = await payloads.get(record.contentRef);
                  if (!payload || payload.contentType !== "text/plain") return undefined;
                  try {
                    return new TextDecoder("utf-8", { fatal: true }).decode(
                      await recallProtector.unprotect({
                        ownerId: configuration.ownerId,
                        agentId: configuration.agentId,
                        payload,
                      }),
                    );
                  } catch {
                    return undefined;
                  }
                },
                storeText: async () => undefined,
                digest: (text) => createHash("sha256").update(text).digest("hex"),
                ...(configuration.runPolicy?.timeZone
                  ? { timeZone: configuration.runPolicy.timeZone }
                  : {}),
              }).outline({
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                maxClassification,
                now: clock.now(),
              }),
            ownerRules: () =>
              ownerRuleStore.list({
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                includeRetired: false,
              }),
            memoryClassifications: async (memoryIds) =>
              new Map(
                (
                  await profileState.readMany({
                    ownerId: configuration.ownerId,
                    agentId: configuration.agentId,
                    memoryIds: memoryIds as Parameters<
                      typeof profileState.readMany
                    >[0]["memoryIds"],
                  })
                ).map((record) => [record.id as string, record.dataClassification]),
              ),
            ...(memoryEpisodes
              ? {
                  summaries: async ({
                    days,
                    limit,
                    maxClassification,
                  }: {
                    days: number;
                    limit: number;
                    maxClassification?: DataClassification;
                  }) => {
                    const found = await memoryEpisodes.recent({
                      ownerId: configuration.ownerId,
                      agentId: configuration.agentId,
                      days,
                      limit,
                      allowedClassifications: modelVisibleClassifications().filter(
                        (classification) =>
                          maxClassification === undefined ||
                          classificationRank(classification) <=
                            classificationRank(maxClassification),
                      ),
                    });
                    return {
                      partial: found.partial,
                      summaries: found.summaries.map(({ episode, text }) => ({
                        id: episode.id,
                        day: episode.day,
                        text,
                      })),
                    };
                  },
                }
              : {}),
          },
          ledger: repository.decisionLedger(),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "mcp-read.failed",
              code: stableErrorCode(error),
            }),
          onSummariesFailed: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "mcp-read.summaries-failed",
              code: stableErrorCode(error),
            }),
        });
      }
      const webPushConfiguration = configuration.runPolicy?.webPush;
      const webPushSecret = webPushConfiguration
        ? configuration.secretReferences.find(
            ({ ref, purpose }) => ref === webPushConfiguration.secretRef && purpose === "web-push",
          )
        : undefined;
      if (webPushConfiguration && webPushSecret && episodeProtector) {
        const pushRepository = repository;
        const pushSources = hostModelSources(configuration);
        const readPlain = async (ref: string) => {
          const payload = await consolidationPayloads.get(ref);
          if (!payload || payload.contentType !== "text/plain") return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await episodeProtector.unprotect({
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              payload,
            }),
          );
        };
        webPush = new ProductionWebPush({
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
          store: pushRepository.webPush(),
          sender: createWebPushSender({
            privateKey: await pushSources.keys.resolve(webPushSecret.ref, webPushSecret.version),
            subject: webPushConfiguration.subject,
          }),
          presence: webPushPresence,
          readLocale: async () =>
            (
              await pushRepository.ownerPreferences().read({
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
              })
            ).locale,
          reminders: pushRepository.memoryReminders(),
          memories: pushRepository.productMemoryState(),
          readMemoryText: (record) => readPlain(record.contentRef),
          listApprovals: () =>
            pushRepository
              .authorizationStore()
              .listApprovals(configuration.ownerId, configuration.agentId, {
                status: "pending",
              }),
          awaitingCount: async () => http?.home.awaitingCount(),
          ...(museIntake
            ? {
                museChannel: createMuseChannelPushSource({
                  scope: proactiveScope,
                  store: repository.museIntake(),
                }),
              }
            : {}),
          ...(proactive && proactiveStore && proactiveSeal
            ? {
                proactive: createProactivePushSource({
                  scope: proactiveScope,
                  store: proactiveStore,
                  seal: proactiveSeal,
                }),
              }
            : {}),
          runThread: async (runId) =>
            (
              await pushRepository
                .runLifecycle(configuration.ownerId, configuration.agentId, authority)
                .readRun(
                  runId as Parameters<ReturnType<typeof pushRepository.runLifecycle>["readRun"]>[0],
                )
            )?.run.threadId ?? null,
          threadTitle: async (threadId) => {
            const thread = await pushRepository
              .threadRepository()
              .read(
                configuration.ownerId,
                configuration.agentId,
                threadId as Parameters<
                  ReturnType<typeof pushRepository.threadRepository>["read"]
                >[2],
              );
            if (!thread || thread.status !== "active") return null;
            const title = thread.titleRef ? await readPlain(thread.titleRef) : undefined;
            return { title: title?.trim() || null };
          },
          publicOrigin: configuration.publicOrigin,
          ...(configuration.runPolicy?.timeZone
            ? { timeZone: configuration.runPolicy.timeZone }
            : {}),
          now: () => clock.now(),
          onDelivery: (outcome) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "web-push.delivery",
              outcome: outcome.kind,
              ...(outcome.code ? { code: outcome.code } : {}),
            }),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "web-push.failed",
              code: stableErrorCode(error),
            }),
        });
        webPush.start();
      }
      proactive?.start();
      realEval?.start();
      observation = new ProductionObservation({
        scope: {
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
        },
        observation: repository.ledgerObservation(),
        ledger: repository.decisionLedger(),
        marks: repository.gapCaseMarks(),
        ...(protector
          ? {
              seal: createProactiveSeal({
                payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
                protector,
                ids,
              }),
            }
          : {}),
        clock,
        schedule: {
          configured: proactive !== undefined,
          intervalMs: configuration.runPolicy?.proactive?.intervalMs ?? 0,
          perCheckMs: configuration.runPolicy?.proactive?.perCheckMs ?? 0,
        },
        serviceRevision: readServiceRevision(),
        correction: (
          (reviews) => () =>
            reviews.agreement({ ownerId: configuration.ownerId, agentId: configuration.agentId })
        )(repository.memoryReviews()),
        ...(configuration.runPolicy?.proactive
          ? ((settings, modelRef) => ({
              prereview: {
                version: {
                  modelRef,
                  promptId: prereviewPromptId((text) =>
                    createHash("sha256").update(text, "utf8").digest("hex"),
                  ),
                },
                agreementPermille: settings.reduction.hiddenAgreementPermille,
                confidencePermille: settings.reduction.confidencePermille,
                reductionEnabled: settings.enabled && settings.reduction.enabled,
                auditPermille: settings.reduction.auditPermille,
              },
            }))(
              configuration.runPolicy.proactive.reviewPrereview,
              configuration.runPolicy.proactive.modelRef,
            )
          : {}),
        onFailure: (error) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "observation.failed",
            code: stableErrorCode(error),
          }),
      });
      observation.start();
      const live = new ExecutionLiveFeed();
      runs = createProductionRunComposition({
        egress: createProductionModelEgress(
          configuration,
          sources,
          productionSensitiveInterceptionRecorder(activeRepository),
        ),
        live,
        ...(tools.background ? { backgroundCommands: tools.background } : {}),
        modelUsage: {
          store: monitorFollowUpCacheHits(activeRepository.modelUsage(), (hit) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "cache.follow_up_low_hit",
              ...hit,
            }),
          ),
          onFailure: (error) =>
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "model-usage.record_failed",
              code: stableErrorCode(error),
            }),
        },
        onModelAdmissionFailed: (request, failure) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "model.admission_failed",
            runId: request.runId,
            code: failure.code,
            ...(failure.reason === null ? {} : { reason: failure.reason }),
          }),
        onModelRequestRejected: (request, rejection) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "model.request_rejected",
            runId: request.runId,
            status: rejection.status,
            ...(rejection.retryAfter === null ? {} : { retryAfter: rejection.retryAfter }),
            ...(rejection.shouldRetry === null ? {} : { shouldRetry: rejection.shouldRetry }),
            ...(rejection.host === null ? {} : { host: rejection.host }),
          }),
        onCompactionSummaryRequest: (request, summary) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "compaction.summary_request",
            runId: request.runId,
            sharedHead: summary.sharedHead,
          }),
        onModelStreamFailed: (request, failure) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "model.stream_failed",
            runId: request.runId,
            code: failure.code,
            message: failure.message,
          }),
        onBackgroundFailure: (runId, error) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "background-command.finish_failed",
            runId,
            code: stableErrorCode(error),
          }),
        onRunTiming: (diagnostic) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "run.timing",
            ...diagnostic,
          }),
        onHandleTools: (request, observation) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "prompt.bundle.handle_tools",
            runId: request.runId,
            generation: observation.generation ?? -1,
            handleTools: observation.handleTools,
          }),
        ...(modelComposition.composition.generateTitle
          ? { generateTitle: modelComposition.composition.generateTitle }
          : {}),
        onTitleFailure: (error) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "thread-title.failed",
            code: stableErrorCode(error),
            ...siteField(error),
          }),
        ...(modelComposition.composition.generateText
          ? {
              memoryCapture: {
                product: durableMemory,
                approvals: repository.sensitiveMemoryApprovals(),
                ...(configuration.runPolicy?.timeZone
                  ? { timeZone: configuration.runPolicy.timeZone }
                  : {}),
                ...(memoryEpisodes
                  ? {
                      episodes: {
                        service: memoryEpisodes,
                        embedWithin: (request, slot, operation) =>
                          embedWithin(request, slot, operation, request.dataClassification),
                        onFailure: (error) =>
                          writeServiceDiagnostic(errorOutput, {
                            component: "agent-service",
                            event: "memory-episode.failed",
                            code: stableErrorCode(error),
                            ...siteField(error),
                          }),
                      },
                    }
                  : {}),
                ...(memoryConsolidation
                  ? {
                      consolidation: {
                        service: memoryConsolidation,
                        search: (request, query, limit) =>
                          consolidationProjection.search({
                            ownerId: request.ownerId,
                            agentId: request.agentId,
                            query,
                            limit,
                          }),
                        embedWithin: (request, slot, operation) =>
                          embedWithin(request, slot, operation, request.dataClassification),
                        onResult: (result) =>
                          writeServiceDiagnostic(errorOutput, {
                            component: "agent-service",
                            event: "memory-consolidation.completed",
                            modelCalled: result.modelCalled,
                            changes: result.changes.length,
                          }),
                        onFailure: (error) =>
                          writeServiceDiagnostic(errorOutput, {
                            component: "agent-service",
                            event: "memory-consolidation.failed",
                            code: stableErrorCode(error),
                            ...siteField(error),
                          }),
                      },
                    }
                  : {}),
                conversationReview: {
                  settings: () => ({
                    ...DEFAULT_CONVERSATION_REVIEW_SETTINGS,
                    ...configuration.memory.conversationReview,
                  }),
                  search: (request, query, limit) =>
                    embedWithin(
                      request,
                      `memory-conversation-review-search:${request.runId}`,
                      () =>
                        consolidationProjection.search({
                          ownerId: request.ownerId,
                          agentId: request.agentId,
                          query,
                          limit,
                          includeTentative: true,
                        }),
                      request.dataClassification,
                    ),
                  onResult: (result) =>
                    writeServiceDiagnostic(errorOutput, {
                      component: "agent-service",
                      event: "memory-conversation-review.completed",
                      changes: result.changes.length,
                      ...Object.fromEntries(
                        Object.entries(result.skipped).map(([reason, count]) => [
                          `skipped_${reason}`,
                          count,
                        ]),
                      ),
                    }),
                  onFailure: (error) =>
                    writeServiceDiagnostic(errorOutput, {
                      component: "agent-service",
                      event: "memory-conversation-review.failed",
                      code: stableErrorCode(error),
                    }),
                },
                generate: (request, prompt, gate, purpose = "memory-capture", call) => {
                  const generateText = modelComposition?.composition.generateText;
                  if (!generateText) throw new Error("MEMORY_CAPTURE_MODEL_UNAVAILABLE");
                  return generateText(request, prompt, gate, {
                    purpose: modelUsagePurpose(purpose),
                    invocationId: call?.invocationId ?? `${purpose}:${request.runId}`,
                    ...(call ? { retryToolCall: call.retryToolCall } : {}),
                    maxOutputTokens: call?.maxOutputTokens ?? 1024,
                    reasoningOutputTokens: 4096,
                    disableThinking: true,
                    requestTimeoutMs: 45000,
                    errorPrefix: "MEMORY_CAPTURE",
                  });
                },
                onAudit: (record) => {
                  writeServiceDiagnostic(errorOutput, {
                    component: "agent-service",
                    event: "memory-capture.audit",
                    outcome: record.outcome,
                    candidateOrdinal: record.candidateOrdinal ?? -1,
                    classification: record.classification,
                  });
                },
                onFailure: (error) =>
                  writeServiceDiagnostic(errorOutput, {
                    component: "agent-service",
                    event: "memory-capture.failed",
                    code: stableErrorCode(error),
                    ...siteField(error),
                  }),
              },
            }
          : {}),
        ...(sandboxServices
          ? {
              resources: sandboxServices.resources,
              recoverMissingToolResult: sandboxServices.recoverMissingToolResult,
              sandboxResultUnrecoverable: sandboxServices.sandboxResultUnrecoverable,
              prepareQueuedSandboxExecutions: sandboxServices.rebindQueuedRun,
              ...toolCallPrewarm(configuration.runPolicy?.coding, (route) =>
                toolCallSandboxPrewarm({
                  enabledTools: route.enabledTools,
                  prewarm: (request) => sandboxServices.prewarmEnvironment(request, route),
                  report: (event) =>
                    writeServiceDiagnostic(errorOutput, {
                      component: "agent-service",
                      ...event,
                    }),
                }),
              ),
            }
          : {}),
        configuration,
        repository,
        authority: activeAuthority,
        models: modelComposition.composition.piModels,
        modelRegistry: [
          ...modelComposition.descriptors.generation.map((descriptor) => ({
            ...descriptor,
            ...(descriptor.api === "typesafe-systemone"
              ? TypeSafeJevTransport.estimatedAdmissionCost(descriptor)
              : admissionCostForConfiguredPiModel(descriptor)),
          })),
          embeddingAdmissionDescriptor(configuration),
        ],
        protector,
        memory,
        tools,
        policy: createProductionRunPolicy({
          configuration,
          artifacts,
          protector,
          handles: capabilities,
          clock,
          ids,
          workspaceRoot: configuredWorkspaceRoot(configuration, repository, clock),
          sandboxCommands: sandboxCommandInventory,
        }),
        clock,
        ids,
        instanceId: agentServiceBootId,
        cwd: configuration.stateRoot,
        agentDir: path.join(configuration.cacheDirectory, "pi-agent"),
        ...(configuration.runPolicy?.timeZone
          ? { timeZone: configuration.runPolicy.timeZone }
          : {}),
        onFailure: ({ phase, error }) => failRuntime(error, phase),
      });
      const configuredPiModels = modelComposition.composition.piModels;
      const tiers = priceTiers(magpieModels.prices);
      const modelCatalogTags = (ref: string) => {
        const price = magpieModels.prices.get(ref);
        const tier = tiers.get(ref);
        return {
          ...(magpieModels.automaticRefs.has(ref) ? { automatic: true } : {}),
          ...(price && tier ? { price, priceTier: tier } : {}),
        };
      };
      const activeDurableMemory = durableMemory;
      if (configuration.runPolicy?.mcpRead !== undefined && !mcpRead)
        throw new Error("MCP_READ_RUNTIME_UNAVAILABLE");
      http = await createProductionHttpComposition({
        ...(input.listen?.kind === "unix" ? { listenUnixSocketPath: input.listen.path } : {}),
        live,
        webPush: { presence: webPushPresence, push: webPush },
        ...(proactive ? { proactive } : {}),
        ...(museIntake ? { museIntake } : {}),
        ...(gapExport ? { gapExport } : {}),
        ...(mcpRead ? { mcpRead } : {}),
        ...(museControl ? { museControl } : {}),
        ...(observation ? { observation } : {}),
        memory: {
          service: activeDurableMemory,
          externalProposals,
          ...(memoryClassifier ? { classifier: memoryClassifier } : {}),
          ...(memoryImportDuplicates ? { importDuplicates: memoryImportDuplicates } : {}),
          onAudit: (record) => {
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "memory-capture.audit",
              outcome: record.outcome,
              candidateOrdinal: record.candidateOrdinal ?? -1,
              classification: record.classification,
            });
          },
        },
        modelCatalog: await Promise.all(
          modelComposition.descriptors.generation
            .filter(
              (descriptor) =>
                descriptor.api === "openai-completions" &&
                descriptor.allowedDataClassifications.includes("private"),
            )
            .map(async (descriptor) => ({
              ...getPiModelPresentation(await configuredPiModels.resolve(descriptor.ref)),
              ...modelCatalogTags(descriptor.ref),
            })),
        ),
        onCommandAccepted: () => {
          runs?.loop.wakeup();
        },
        onSlowRequest: (request) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            event: "http.slow_request",
            ...request,
          }),
        onSearchIndexDiagnostic: (diagnostic) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            ...diagnostic,
          }),
        onDeviceWarning: (warning) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            ...warning,
          }),
        onHomeDiagnostic: (diagnostic) =>
          writeServiceDiagnostic(errorOutput, {
            component: "agent-service",
            ...diagnostic,
          }),
        cancelRun: async (input) => {
          if (!runs) throw new Error("RUN_COORDINATOR_UNAVAILABLE");
          if (await runs.background?.cancel(input.runId)) return;
          await runs.coordinator.cancel({
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
            runId: input.runId,
            authority: activeAuthority.authorityLease(),
            command: input.command,
            reasonCode: "OWNER_REQUESTED_STOP",
          });
        },
        configuration,
        repository,
        authority: () => activeAuthority.authorityFence(),
        executionAuthority: () => activeAuthority.authorityLease(),
        secretSources: sources,
        executionEnvironment: {
          mode:
            sandboxServices?.executionMode ?? (configuration.taskEnvironments ? "strict" : "srt"),
          unavailableTools: async () =>
            sandboxServices?.executionMode === "strict"
              ? strictModeUnavailableTools({
                  runPolicy: configuration.runPolicy,
                  refusal: sandboxServices.strictModeRefusal,
                })
              : [],
        },
        ...dependencies.httpOptions,
        health,
      });
      http.app.addHook("onRequest", async (request, reply) => {
        const requestPath = request.url.split("?", 1)[0] ?? "";
        if (requestPath === "/health/ready") {
          try {
            await activeAuthority.assertActive();
            if (!(await worker?.checkReadiness())) throw new Error("WORKER_NOT_READY");
            health?.observe({
              name: "worker",
              required: true,
              status: "healthy",
              reasonCode: null,
            });
          } catch {
            health?.observe({
              name: "worker",
              required: true,
              status: "unavailable",
              reasonCode: "WORKER_OR_AUTHORITY_UNAVAILABLE",
            });
          }
          return;
        }
        if (request.url.startsWith("/health/")) return;
        if (
          lifecycle.state !== "ready" ||
          !activeAuthority.isAccepting() ||
          !worker?.isReady() ||
          runs?.loop.state !== "running"
        )
          return reply.code(503).send({ error: "SERVICE_NOT_READY" });
        if (servesStaticFile(requestPath)) return;
        try {
          await activeAuthority.assertActive();
        } catch {
          return reply.code(503).send({ error: "AUTHORITY_UNAVAILABLE" });
        }
      });
      await http.assertIdentityReady();
      const probe = await protector.protect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        ref: ids.next("startup-key-probe"),
        plaintext: new TextEncoder().encode("payload-key-probe"),
        dataClassification: "private",
        contentType: "text/plain",
        createdAt: clock.now(),
      });
      const restoredProbe = await protector.unprotect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        payload: probe,
      });
      if (new TextDecoder().decode(restoredProbe) !== "payload-key-probe")
        throw new Error("PAYLOAD_KEY_PROBE_FAILED");
      await memoryWorker?.start();
      await runs.loop.start();
      if (authorityLost) throw authorityLossError;
      await http.listen();
      if (input.listen?.kind === "unix") {
        boundListenPath = input.listen.path;
      } else {
        const listenAddress = http.app.server.address();
        if (listenAddress === null || typeof listenAddress === "string")
          throw new Error("HTTP_LISTENER_ADDRESS_UNAVAILABLE");
        boundListenPort = listenAddress.port;
      }
      health.setLive(true);
      for (const name of [
        "authority",
        "schema",
        "sqlite",
        "payload-keyring",
        "worker",
        "memory-persistence",
        "recovery",
        "identity-trust",
        "run-dispatch",
        "memory-consumer",
      ])
        health.observe({
          name,
          required: true,
          status: "healthy",
          reasonCode: null,
        });
      health.setAuthorityActive(true);
    }
    if (!webEnabled && sandboxServices) {
      const activeAuthority = authorityLifecycle;
      resourceOnlyLoop = new ProductionRunDispatchLoop({
        dispatcher: {
          pump: async () => {},
          drain: async () => ({ drained: true, inFlight: 0 }),
        },
        fallbackScanIntervalMs: 1000,
        recoverResources: async (signal) => {
          await activeAuthority.assertActive();
          if (authorityLost) throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
          await sandboxServices.resources.recoverPending(
            signal,
            configuration.concurrency.totalRuns,
          );
        },
        onFailure: ({ phase, error }) => failRuntime(error, phase),
      });
      await resourceOnlyLoop.start();
      if (authorityLost) throw authorityLossError;
    }
    lifecycle.ready();
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.ready",
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      sqliteVersion: sqliteLibraryVersion(),
      workerSchemaVersion: handshake.payload.selectedSchemaVersion,
      publicMode: configuration.publicMode,
      ...(boundListenPort === undefined ? {} : { listenPort: boundListenPort }),
      ...(boundListenPath === undefined ? {} : { listenPath: boundListenPath }),
      unfinishedRuns: recovery.unfinishedRunKeys.length,
      pendingApprovals: recovery.pendingApprovalRequestIds.length,
      recoverableOccurrences: recovery.retryableJobOccurrenceIds.length,
      expiredWorkLeases: recovery.expiredWorkLeaseOccurrenceIds.length,
      blockedOccurrences: recovery.blockedOccurrenceIds.length,
      pendingDeliveries: recovery.pendingDeliveryRequestIds.length,
      modelPath: modelComposition === undefined ? "deterministic-descriptor-only" : "pi-production",
      memoryPath:
        memoryComposition === undefined
          ? "deterministic-descriptor-only"
          : "memory-engine-production",
      embeddingDescriptorRef: modelComposition?.descriptors.embedding.ref ?? embedding.ref,
      embeddingProvider:
        memoryComposition?.descriptor.provider ??
        modelComposition?.descriptors.embedding.provider ??
        embedding.provider,
      embeddingModel:
        memoryComposition?.descriptor.model ??
        modelComposition?.descriptors.embedding.model ??
        embedding.model,
      embeddingVersion:
        memoryComposition?.descriptor.version ??
        modelComposition?.descriptors.embedding.version ??
        embedding.version,
      embeddingDimensions:
        memoryComposition?.descriptor.dimensions ??
        modelComposition?.descriptors.embedding.dimensions ??
        embedding.dimensions,
    });
    let stopping: Promise<void> | undefined;
    return Object.freeze({
      tenantId: input.tenantId,
      listenPath: boundListenPath,
      listenPort: boundListenPort,
      health,
      stop: (timeoutMs?: number): Promise<void> => {
        stopping ??= lifecycle.shutdown();
        const shutdown = stopping;
        if (timeoutMs === undefined) return shutdown;
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT), {
                  code: TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT,
                }),
              ),
            timeoutMs,
          );
        });
        return Promise.race([shutdown, deadline]).finally(() => clearTimeout(timer));
      },
      onAuthorityLost: (handler: (error: unknown) => void) => {
        void authorityLoss.then(() => {
          try {
            handler(authorityLossError);
          } catch (error) {
            writeServiceDiagnostic(errorOutput, {
              component: "agent-service",
              event: "authority.lost_handler_failed",
              code: stableErrorCode(error),
            });
          }
        });
      },
    } satisfies TenantRuntimeHandle);
  } catch (error) {
    await lifecycle.shutdown().catch(() => undefined);
    throw error;
  }
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("PROACTIVE_CONFIGURATION_INCOMPLETE");
  return value;
}
