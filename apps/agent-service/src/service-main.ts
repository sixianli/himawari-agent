import { DurableMemoryService } from "@himawari-agent/application";
import { ProductionMemoryWorker } from "./production-memory-worker.js";
import { ProductionServiceLifecycle } from "./production-service-lifecycle.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type ClockPort,
  type IdGeneratorPort,
  type ProductConfiguration,
  WorkerDelegationAdmissionService,
} from "@himawari-agent/application";
import type { ExecutionAdmissionPeerBinding } from "@himawari-agent/execution-contracts";
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
import { createProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import { ProductionExecutionAdmissionHandler } from "./production-execution-admission-handler.js";
import { AgentServiceExecutionClient } from "./production-execution-client.js";
import {
  createProductionMemoryCompositionFromConfiguration,
  type ProductionMemoryComposition,
} from "./production-memory-composition.js";
import {
  createProductionModelCompositionFromConfiguration,
  type ProductionConfiguredModelComposition,
} from "./production-model-composition.js";
import { ProductionPayloadBrokerHandler } from "./production-payload-broker-handler.js";
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
}

export type AgentServiceModelCompositionFactory = (
  context: AgentServiceModelCompositionContext,
) => Promise<ProductionConfiguredModelComposition>;

export interface AgentServiceMemoryCompositionContext {
  readonly configuration: ProductConfiguration;
  readonly repository: SqliteProductStateRepository;
}

export type AgentServiceMemoryCompositionFactory = (
  context: AgentServiceMemoryCompositionContext,
) => Promise<ProductionMemoryComposition>;

export interface AgentServiceDependencies {
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

function configuredPayloadProtector(configuration: ProductConfiguration): EnvelopePayloadProtector {
  const payloadKeys = configuration.secretReferences.filter(
    ({ purpose }) => purpose === "payload-encryption",
  );
  if (payloadKeys.length !== 1 || !payloadKeys[0]) {
    throw new Error(AGENT_SERVICE_ERROR_CODES.PAYLOAD_KEY_REFERENCE_INVALID);
  }
  const payloadKey = payloadKeys[0];
  const sources = hostModelSources(configuration);
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
  const sources = hostModelSources(configuration);
  const clock = productionClock();
  const ids = productionIds();
  const handles = new EphemeralSecretPort({ ids, clock });
  const protector = configuredPayloadProtector(configuration);
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
  const sources = hostModelSources(context.configuration);
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
    stopAccepting: stopReverseServices,
    close: stopReverseServices,
  });
  try {
    const args = parseServiceArguments(arguments_);
    const configuration = await new JsonFileConfigurationPort(args.configurationPath).load();
    if (configuration.publicMode) {
      throw new Error(SERVICE_RUNTIME_ERROR_CODES.PUBLIC_MODE_INCOMPLETE);
    }
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
      modelComposition = await factory({ configuration, repository });
      const memoryFactory = dependencies.memoryCompositionFactory ?? createDefaultMemoryComposition;
      memoryComposition = await memoryFactory({ configuration, repository });
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
    const admission = new WorkerDelegationAdmissionService({
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
      receipts: repository.capabilityInvocationReceiptPort(
        configuration.ownerId,
        configuration.agentId,
      ),
      results: repository.capabilityInvocationResultPort(
        configuration.ownerId,
        configuration.agentId,
      ),
      payloadsFor: (ownerId, agentId) => activeRepository.payloadStore(ownerId, agentId),
      protector: configuredPayloadProtector(configuration),
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
    if (authorityLost || !authorityLifecycle.isAccepting()) {
      throw authorityLossError ?? new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
    }
    if (memoryComposition) {
      const payloads = repository.payloadStore(configuration.ownerId, configuration.agentId);
      const protector = configuredPayloadProtector(configuration);
      const memory = new DurableMemoryService({
        state: repository.productMemoryState(),
        jobs: repository.memoryProjectionJobs(),
        provider: memoryComposition.projection,
        content: {
          readText: async (ref) => {
            const payload = await payloads.get(ref);
            if (!payload) throw new Error("MEMORY_PAYLOAD_MISSING");
            return new TextDecoder("utf-8", { fatal: true }).decode(
              await protector.unprotect({
                ownerId: configuration.ownerId,
                agentId: configuration.agentId,
                payload,
              }),
            );
          },
        },
        workerId: `${agentServiceBootId}:memory`,
        now: () => clock.now(),
      });
      memoryWorker = new ProductionMemoryWorker({
        service: memory,
        assertActive: async () => {
          if (!authorityLifecycle) throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
          await authorityLifecycle.assertActive();
          if (authorityLost) throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_LOST);
        },
        onFailure: (error) => {
          authorityLost = true;
          authorityLossError = error;
          resolveAuthorityLoss?.();
        },
      });
      await memoryWorker.start();
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
      publicMode: false,
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
