import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ModelInvocationAdmissionResolver,
  PayloadProtectorPort,
} from "@himawari-agent/application";
import {
  type ClockPort,
  DurableMemoryService,
  type IdGeneratorPort,
  type ProductConfiguration,
  recoverSandboxExecutionsAtStartup,
  recoverSandboxJobsAtStartup,
  WorkerDelegationAdmissionService,
} from "@himawari-agent/application";
import type {
  ExecutionAdmissionPeerBinding,
  SandboxExecutionSupport,
} from "@himawari-agent/execution-contracts";
import {
  inspectDeploymentAuthorityReadOnly,
  openQualifiedDatabase,
  readSqliteRuntimeStatus,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  assertProductionSecretSource,
  EnvelopePayloadProtector,
  EphemeralSecretPort,
  EXECUTION_UDS_ERROR_CODES,
  ExecutionAdmissionUdsServer,
  ExecutionUdsError,
  initializeStateRoot,
  JsonFileConfigurationPort,
  MacOsKeychainProviderSecretSource,
  MacOsKeychainSecretSource,
  PayloadUdsServer,
  parseServiceArguments,
  RuntimeHealthModel,
  readAuthorityFile,
  readRestrictedExecutionTokenFile,
  readWorkerServiceBootBinding,
  SERVICE_RUNTIME_ERROR_CODES,
  SystemdCredentialSecretSource,
  SystemdProviderSecretSource,
  stableErrorCode,
  writeAgentServiceBootBinding,
  writeAuthorityFile,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";
import {
  admissionCostForConfiguredPiModel,
  getPiModelPresentation,
} from "@himawari-agent/runtime-pi";
import { createProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import { ProductionExecutionAdmissionHandler } from "./production-execution-admission-handler.js";
import { AgentServiceExecutionClient } from "./production-execution-client.js";
import { createProductionFileReadServices } from "./production-file-read-services.js";
import {
  createProductionHttpComposition,
  type ProductionHttpComposition,
  type ProductionHttpCompositionOptions,
} from "./production-http-composition.js";
import {
  createProductionMemoryCompositionFromConfiguration,
  type ProductionMemoryComposition,
} from "./production-memory-composition.js";
import { ProductionMemoryWorker } from "./production-memory-worker.js";
import {
  createProductionModelCompositionFromConfiguration,
  type ProductionConfiguredModelComposition,
} from "./production-model-composition.js";
import { ProductionPayloadBrokerHandler } from "./production-payload-broker-handler.js";
import { createProductionRunComposition } from "./production-run-composition.js";
import {
  createProductionRunMemory,
  embeddingAdmissionDescriptor,
} from "./production-run-memory.js";
import { createProductionRunPolicy } from "./production-run-policy.js";
import { ProductionRuntimeTools } from "./production-runtime-tools.js";
import { createProductionSandboxServices } from "./production-sandbox-services.js";
import { ProductionServiceLifecycle } from "./production-service-lifecycle.js";
import { createProductionWorkerParentBindingRegistry } from "./production-worker-parent-binding-registry.js";

export const AGENT_SERVICE_ERROR_CODES = Object.freeze({
  AUTHORITY_INACTIVE: "AGENT_AUTHORITY_INACTIVE",
  AUTHORITY_MISMATCH: "AGENT_AUTHORITY_MISMATCH",
  AUTHORITY_LOST: "AGENT_AUTHORITY_LOST",
  SQLITE_UNQUALIFIED: "AGENT_SQLITE_UNQUALIFIED",
  MODEL_PATH_UNSUPPORTED: "AGENT_MODEL_PATH_UNSUPPORTED",
  PAYLOAD_KEY_REFERENCE_INVALID: "AGENT_PAYLOAD_KEY_REFERENCE_INVALID",
  WORKER_BOOT_BINDING_INVALID: "AGENT_WORKER_BOOT_BINDING_INVALID",
  WORKER_UNAVAILABLE: "AGENT_WORKER_UNAVAILABLE",
} as const);

const AUTHORITY_LEASE_DURATION_MS = 30_000;
const AUTHORITY_RENEWAL_INTERVAL_MS = 10_000;
const STARTUP_WAIT_TIMEOUT_MS = 30_000;
const STARTUP_RETRY_DELAY_MS = 50;
const MAXIMUM_BODY_BYTES = 65_536;
const MAXIMUM_PAYLOAD_BYTES = 48 * 1024;

export interface AgentServiceModelCompositionContext {
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
  readonly sources?: ReturnType<typeof hostModelSources>;
}

export type AgentServiceModelCompositionFactory = (
  context: AgentServiceModelCompositionContext,
) => Promise<ProductionConfiguredModelComposition>;

export interface AgentServiceMemoryCompositionContext {
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
  readonly sources?: ReturnType<typeof hostModelSources>;
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

function productionClock(): ClockPort {
  return Object.freeze({ now: () => new Date().toISOString() });
}

function productionIds(): IdGeneratorPort {
  return Object.freeze({ next: (namespace: string) => `${namespace}:${randomUUID()}` });
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
      siteUrl: configuration.publicOrigin,
      appName: "himawari-agent",
    });
    return Object.freeze({
      descriptors: created.descriptors,
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
    configuration: context.configuration,
    secretSource: sources.provider,
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
  const deadline = Date.now() + STARTUP_WAIT_TIMEOUT_MS;
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
  isAuthorityActive?: () => boolean,
): Promise<Awaited<ReturnType<AgentServiceExecutionClient["start"]>>> {
  const deadline = Date.now() + STARTUP_WAIT_TIMEOUT_MS;
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

export async function runAgentService(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
  dependencies: AgentServiceDependencies = {},
): Promise<number> {
  const lifecycle = new ProductionServiceLifecycle();
  let repository: SqliteProductStateRepository | undefined;
  let authorityLifecycle: ReturnType<typeof createProductionAuthorityLifecycle> | undefined;
  let worker: AgentServiceExecutionClient | undefined;
  let admissionServer: ExecutionAdmissionUdsServer | undefined;
  let payloadServer: PayloadUdsServer | undefined;
  let modelComposition: ProductionConfiguredModelComposition | undefined;
  let memoryComposition: ProductionMemoryComposition | undefined;
  let memoryWorker: ProductionMemoryWorker | undefined;
  let http: ProductionHttpComposition | undefined;
  let runs: ReturnType<typeof createProductionRunComposition> | undefined;
  let health: RuntimeHealthModel | undefined;
  let runStopTimeoutMs = 30_000;
  let runInterruption: Promise<void> | undefined;
  let httpClosing: Promise<void> | undefined;
  let governedMemory: ReturnType<typeof createProductionRunMemory> | undefined;
  let durableMemory: DurableMemoryService | undefined;
  let protector: PayloadProtectorPort | undefined;
  let authorityLost = false;
  let authorityLossError: unknown;
  let resolveAuthorityLoss: (() => void) | undefined;
  const authorityLoss = new Promise<void>((resolve) => {
    resolveAuthorityLoss = resolve;
  });
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
  lifecycle.register({ name: "repository", close: () => repository?.close() });
  lifecycle.register({ name: "authority", close: () => authorityLifecycle?.stop() });
  lifecycle.register({ name: "model", close: () => modelComposition?.composition.close() });
  lifecycle.register({ name: "memory", close: () => memoryComposition?.close() });
  lifecycle.register({
    name: "memory-worker",
    stopAccepting: () => memoryWorker?.stopAccepting(),
    drain: () => memoryWorker?.drain(),
    close: () => memoryWorker?.drain(),
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
      runInterruption = runs?.coordinator.interruptAllExecutions("SERVICE_STOPPING");
    },
    drain: async () => {
      if (!runs) return;
      await runInterruption;
      const drained = await runs.loop.stop(runStopTimeoutMs);
      if (!drained.drained) throw new Error("RUN_DRAIN_DEADLINE_EXCEEDED");
    },
    close: async () => {
      await runs?.loop.stop(runStopTimeoutMs);
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
    const args = parseServiceArguments(arguments_);
    const configuration = await new JsonFileConfigurationPort(args.configurationPath).load();
    const webEnabled =
      configuration.publicMode ||
      (configuration.identity?.kind === "built-in" && Boolean(configuration.http));
    if (
      webEnabled &&
      (!configuration.runPolicy ||
        !configuration.http ||
        !configuration.identity ||
        isDeterministicOnly(configuration))
    )
      throw new Error(SERVICE_RUNTIME_ERROR_CODES.PUBLIC_MODE_INCOMPLETE);
    runStopTimeoutMs = configuration.deadlines.providerRequestMs + 30_000;
    const sources = dependencies.secretSources ?? hostModelSources(configuration);
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
    const database = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
    const sqlite = readSqliteRuntimeStatus(database);
    database.close();
    if (sqlite.quickCheck !== "ok") throw new Error(AGENT_SERVICE_ERROR_CODES.SQLITE_UNQUALIFIED);
    repository = await SqliteProductStateRepository.open({
      stateRoot: configuration.stateRoot,
      databasePath: path.join(layout.data, "product.sqlite"),
    });
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
      onLost: (error) => {
        health?.setAuthorityActive(false);
        authorityLost = true;
        authorityLossError = error;
        resolveAuthorityLoss?.();
        void stopReverseServices();
      },
    });
    await authorityLifecycle.start();
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
    if (!isDeterministicOnly(configuration)) {
      const factory = dependencies.modelCompositionFactory ?? createDefaultModelComposition;
      modelComposition = await factory({ configuration, repository, sources });
      const memoryFactory = dependencies.memoryCompositionFactory ?? createDefaultMemoryComposition;
      memoryComposition = await memoryFactory({ configuration, repository, sources });
    }
    const credential = await readRestrictedExecutionTokenFile(args.workerTokenPath);
    const workerBinding = await waitForWorkerBootBinding({
      layout,
      configuration,
      authority: claimedAuthority,
      isAuthorityActive: () => authorityLifecycle?.isAccepting() === true && !authorityLost,
    });
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
    // No admission/HTTP consumer is running yet. The new process may record old
    // attempts as unknown, but must not inherit their execution permission.
    await recoverSandboxJobsAtStartup({
      journal: repository.sandboxJobJournal(configuration.ownerId, configuration.agentId),
      authority: invocationAuthority,
      now: () => clock.now(),
    });
    await recoverSandboxExecutionsAtStartup({
      journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
      authority: invocationAuthority,
      now: () => clock.now(),
    });
    const fileReadServices = createProductionFileReadServices({
      configuration,
      repository,
      authority: invocationAuthority,
      clock,
      ids,
    });
    let workerSandboxSupport: SandboxExecutionSupport | undefined;
    const sandboxServices = await createProductionSandboxServices({
      workerSupport: () => workerSandboxSupport,
      configuration,
      repository,
      protector,
      authority: invocationAuthority,
      fileRead: fileReadServices,
      clock,
      ids,
    });
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
    const payloadHandler = new ProductionPayloadBrokerHandler({
      ...(sandboxServices
        ? { sandboxJobs: sandboxServices.broker, sandboxExecutions: sandboxServices.brokerV2 }
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
      maximumBodyBytes: MAXIMUM_BODY_BYTES,
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
      () => authorityLifecycle?.isAccepting() === true && !authorityLost,
    );
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
      const failRuntime = (error: unknown) => {
        writeServiceDiagnostic(errorOutput, {
          component: "agent-service",
          event: "runtime.failed",
          code: stableErrorCode(error),
        });
        health?.setAuthorityActive(false);
        authorityLost = true;
        authorityLossError = error;
        resolveAuthorityLoss?.();
      };
      const tools = new ProductionRuntimeTools({
        fileRead: fileReadServices,
        ...(sandboxServices
          ? {
              sandbox: sandboxServices.runtime,
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
          maxMemoryBytes: 256 * 1024 * 1024,
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
        projection: memoryComposition.projection,
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
      });
      governedMemory = memory;
      runs = createProductionRunComposition({
        ...(sandboxServices ? { resources: sandboxServices.resources } : {}),
        configuration,
        repository,
        authority: activeAuthority,
        models: modelComposition.composition.piModels,
        modelRegistry: [
          ...modelComposition.descriptors.generation.map((descriptor) => ({
            ...descriptor,
            ...admissionCostForConfiguredPiModel(descriptor),
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
        }),
        clock,
        ids,
        instanceId: agentServiceBootId,
        cwd: configuration.stateRoot,
        agentDir: path.join(configuration.cacheDirectory, "pi-agent"),
        onFailure: ({ error }) => failRuntime(error),
      });
      const configuredPiModels = modelComposition.composition.piModels;
      http = await createProductionHttpComposition({
        modelCatalog: await Promise.all(
          modelComposition.descriptors.generation
            .filter((descriptor) => descriptor.allowedDataClassifications.includes("private"))
            .map(async (descriptor) =>
              getPiModelPresentation(await configuredPiModels.resolve(descriptor.ref)),
            ),
        ),
        cancelRun: async (input) => {
          if (!runs) throw new Error("RUN_COORDINATOR_UNAVAILABLE");
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
        secretSources: sources,
        ...dependencies.httpOptions,
        health,
      });
      http.app.addHook("onRequest", async (request, reply) => {
        if (request.url.split("?", 1)[0] === "/health/ready") {
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
        health.observe({ name, required: true, status: "healthy", reasonCode: null });
      health.setAuthorityActive(true);
    }
    lifecycle.ready();
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.ready",
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      sqliteVersion: sqlite.sqliteVersion,
      workerSchemaVersion: handshake.payload.selectedSchemaVersion,
      publicMode: configuration.publicMode,
      unfinishedRuns: recovery.unfinishedRunKeys.length,
      pendingApprovals: recovery.pendingApprovalRequestIds.length,
      recoverableOccurrences: recovery.retryableJobOccurrenceIds.length,
      expiredWorkLeases: recovery.expiredWorkLeaseOccurrenceIds.length,
      blockedOccurrences: recovery.blockedOccurrenceIds.length,
      pendingDeliveries: recovery.pendingDeliveryRequestIds.length,
      modelPath: modelComposition === undefined ? "deterministic-descriptor-only" : "pi-production",
      memoryPath:
        memoryComposition === undefined ? "deterministic-descriptor-only" : "mem0-production",
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
    const termination = await waitForTerminationOrAuthorityLoss(authorityLoss);
    const signal = termination.kind === "signal" ? termination.signal : "AUTHORITY_LOST";
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.draining",
      signal,
    });
    await lifecycle.shutdown();
    writeServiceDiagnostic(output, { component: "agent-service", event: "service.stopped" });
    return termination.kind === "signal" ? 0 : 1;
  } catch (error) {
    await lifecycle.shutdown().catch(() => undefined);
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "service.failed",
      code: stableErrorCode(error),
    });
    return 1;
  }
}
