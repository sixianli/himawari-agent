import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ClockPort, IdGeneratorPort, ProductConfiguration } from "@himawari-agent/application";
import {
  inspectDeploymentAuthorityReadOnly,
  openQualifiedDatabase,
  readSqliteRuntimeStatus,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  EphemeralSecretPort,
  initializeStateRoot,
  JsonFileConfigurationPort,
  MacOsKeychainProviderSecretSource,
  MacOsKeychainSecretSource,
  parseServiceArguments,
  readAuthorityFile,
  readRestrictedExecutionTokenFile,
  SERVICE_RUNTIME_ERROR_CODES,
  stableErrorCode,
  SystemdCredentialSecretSource,
  SystemdProviderSecretSource,
  waitForTerminationSignal,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";
import { AgentServiceExecutionClient } from "./production-execution-client.js";
import {
  createProductionModelCompositionFromConfiguration,
  type ProductionConfiguredModelComposition,
} from "./production-model-composition.js";
import {
  createProductionMemoryCompositionFromConfiguration,
  type ProductionMemoryComposition,
} from "./production-memory-composition.js";

export const AGENT_SERVICE_ERROR_CODES = Object.freeze({
  AUTHORITY_INACTIVE: "AGENT_AUTHORITY_INACTIVE",
  AUTHORITY_MISMATCH: "AGENT_AUTHORITY_MISMATCH",
  SQLITE_UNQUALIFIED: "AGENT_SQLITE_UNQUALIFIED",
  MODEL_PATH_UNSUPPORTED: "AGENT_MODEL_PATH_UNSUPPORTED",
  PAYLOAD_KEY_REFERENCE_INVALID: "AGENT_PAYLOAD_KEY_REFERENCE_INVALID",
} as const);

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

async function createDefaultModelComposition(
  context: AgentServiceModelCompositionContext,
): Promise<ProductionConfiguredModelComposition> {
  const { configuration, repository } = context;
  const payloadKeys = configuration.secretReferences.filter(
    ({ purpose }) => purpose === "payload-encryption",
  );
  if (payloadKeys.length !== 1 || !payloadKeys[0]) {
    throw new Error(AGENT_SERVICE_ERROR_CODES.PAYLOAD_KEY_REFERENCE_INVALID);
  }
  const payloadKey = payloadKeys[0];
  const sources = hostModelSources(configuration);
  const clock = productionClock();
  const ids = productionIds();
  const handles = new EphemeralSecretPort({ ids, clock });
  const protector = new EnvelopePayloadProtector({
    keys: sources.keys,
    activeKey: {
      keyRef: payloadKey.ref,
      kekVersion: payloadKey.version,
      dekVersion: "dek-v1",
    },
  });
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

export async function runAgentService(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
  dependencies: AgentServiceDependencies = {},
): Promise<number> {
  let repository: SqliteProductStateRepository | undefined;
  let worker: AgentServiceExecutionClient | undefined;
  let modelComposition: ProductionConfiguredModelComposition | undefined;
  let memoryComposition: ProductionMemoryComposition | undefined;
  try {
    const args = parseServiceArguments(arguments_);
    const configuration = await new JsonFileConfigurationPort(args.configurationPath).load();
    if (configuration.publicMode) {
      throw new Error(SERVICE_RUNTIME_ERROR_CODES.PUBLIC_MODE_INCOMPLETE);
    }
    const layout = await initializeStateRoot(configuration.stateRoot);
    const authority = await readAuthorityFile(layout);
    if (authority.status !== "active") {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_INACTIVE);
    }
    if (
      authority.id !== configuration.deploymentId ||
      authority.ownerId !== configuration.ownerId ||
      authority.agentId !== configuration.agentId
    ) {
      throw new Error(AGENT_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    const persistedAuthority = inspectDeploymentAuthorityReadOnly(
      path.join(layout.data, "product.sqlite"),
      configuration.deploymentId,
    );
    if (
      persistedAuthority.ownerId !== authority.ownerId ||
      persistedAuthority.agentId !== authority.agentId ||
      persistedAuthority.status !== authority.status ||
      persistedAuthority.authorityEpoch !== authority.authorityEpoch ||
      persistedAuthority.fencingToken !== authority.fencingToken ||
      persistedAuthority.transferId !== authority.transferId
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
    const recovery = await repository.startupRecovery();
    const embedding = configuredEmbedding(configuration);
    if (!isDeterministicOnly(configuration)) {
      const factory = dependencies.modelCompositionFactory ?? createDefaultModelComposition;
      modelComposition = await factory({ configuration, repository });
      const memoryFactory = dependencies.memoryCompositionFactory ?? createDefaultMemoryComposition;
      memoryComposition = await memoryFactory({ configuration, repository });
    }
    const credential = await readRestrictedExecutionTokenFile(args.workerTokenPath);
    let idSequence = 0;
    worker = new AgentServiceExecutionClient({
      socketPath: path.join(configuration.runtimeDirectory, "execution.sock"),
      credential,
      agentServiceInstanceId: `agent-service:${configuration.deploymentId}`,
      maximumBodyBytes: 65_536,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      now: () => new Date().toISOString(),
      nextId: (scope) => {
        idSequence += 1;
        return `${scope}:${idSequence}:${randomUUID()}`;
      },
    });
    const handshake = await worker.start();
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
    const signal = await waitForTerminationSignal();
    writeServiceDiagnostic(output, {
      component: "agent-service",
      event: "service.draining",
      signal,
    });
    worker.stop();
    await memoryComposition?.close();
    memoryComposition = undefined;
    await modelComposition?.composition.close();
    modelComposition = undefined;
    await repository.close();
    writeServiceDiagnostic(output, { component: "agent-service", event: "service.stopped" });
    return 0;
  } catch (error) {
    worker?.stop();
    await memoryComposition?.close().catch(() => undefined);
    await modelComposition?.composition.close().catch(() => undefined);
    await repository?.close().catch(() => undefined);
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "service.failed",
      code: stableErrorCode(error),
    });
    return 1;
  }
}
