import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CapabilityRuntimeQualification,
  ClockPort,
  ExecutionWorkerService,
  IdGeneratorPort,
  ProductConfiguration,
} from "@himawari-agent/application";
import { ExecutionWorkerService as ExecutionWorkerServiceImplementation } from "@himawari-agent/application";
import type {
  ExecutionAdmissionPeerBinding,
  ResourceCeiling,
} from "@himawari-agent/execution-contracts";
import {
  assertProductionSecretSource,
  CapabilityDeploymentSnapshotLoader,
  type CapabilityDeploymentSnapshotLoaderOptions,
  EphemeralSecretPort,
  ExecutionAdmissionUdsClient,
  type ExecutionUdsCredential,
  LinuxBubblewrapIsolationBackend,
  type LoadedCapabilityDeployment,
  MacOsKeychainProviderSecretSource,
  MacSignedHelperIsolationBackend,
  NodeCapabilityRuntimePort,
  NodeCapabilityRuntimeQualifier,
  type SandboxedProcessIsolationBackend,
  SystemdProviderSecretSource,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import { ProductionExecutionWorker } from "./production-execution-worker.js";
import { ProductionPayloadBrokerClient } from "./production-payload-broker-client.js";
import { ProductionSandboxExecutionV2 } from "./production-sandbox-execution-v2.js";
import { createProductionSandboxWorker } from "./production-sandbox-worker.js";
import { WorkerDelegationStore } from "./worker-delegation-store.js";

export const PRODUCTION_WORKER_COMPOSITION_ERROR_CODES = Object.freeze({
  AGENT_SERVICE_BOOT_ID_REQUIRED: "WORKER_AGENT_SERVICE_BOOT_ID_REQUIRED",
  AGENT_SERVICES_UNAVAILABLE: "WORKER_AGENT_SERVICES_UNAVAILABLE",
  CAPABILITY_DEPLOYMENT_REQUIRED: "WORKER_CAPABILITY_DEPLOYMENT_REQUIRED",
  CAPABILITY_REGISTRY_INCOMPLETE: "WORKER_CAPABILITY_REGISTRY_INCOMPLETE",
  CREDENTIAL_INVALID: "WORKER_CREDENTIAL_INVALID",
  HOST_ISOLATION_BINDING_REQUIRED: "WORKER_HOST_ISOLATION_BINDING_REQUIRED",
  LIVE_QUALIFICATION_FAILED: "WORKER_LIVE_QUALIFICATION_FAILED",
  PLATFORM_UNSUPPORTED: "WORKER_PLATFORM_UNSUPPORTED",
  QUALIFICATION_MISMATCH: "WORKER_QUALIFICATION_MISMATCH",
  SHUTDOWN: "WORKER_COMPOSITION_SHUTDOWN",
} as const);

type ProductionWorkerCompositionErrorCode =
  (typeof PRODUCTION_WORKER_COMPOSITION_ERROR_CODES)[keyof typeof PRODUCTION_WORKER_COMPOSITION_ERROR_CODES];

export class ProductionWorkerCompositionError extends Error {
  readonly code: ProductionWorkerCompositionErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ProductionWorkerCompositionErrorCode,
    message: string = code,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ProductionWorkerCompositionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ProductionWorkerAuthorityBinding {
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export interface ProductionWorkerCompositionOptions {
  readonly configuration: ProductConfiguration;
  readonly credential: ExecutionUdsCredential;
  readonly authority: ProductionWorkerAuthorityBinding;
  /** Must be supplied by the Agent boot coordinator; it is never derived. */
  readonly agentServiceBootId?: string;
  readonly agentServiceInstanceId?: string;
  readonly workerInstanceId?: string;
  readonly workerBootId?: string;
  readonly platform?: NodeJS.Platform;
  readonly clock?: ClockPort;
  readonly ids?: IdGeneratorPort;
  readonly nextId?: (scope: string) => string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maximumBodyBytes?: number;
  readonly maximumPayloadBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly admissionSocketPath?: string;
  readonly payloadSocketPath?: string;
  readonly maximumQualificationAgeMs?: number;
}

export interface ProductionWorkerReadiness {
  readonly live: boolean;
  readonly ready: boolean;
  readonly reasonCodes: readonly string[];
}

export interface ProductionWorkerComposition {
  readonly worker: ProductionExecutionWorker;
  readonly service: ExecutionWorkerService;
  readonly runtime: NodeCapabilityRuntimePort;
  readonly isolation: SandboxedProcessIsolationBackend;
  readonly deployment: LoadedCapabilityDeployment;
  readonly delegations: WorkerDelegationStore;
  readonly admission: ExecutionAdmissionUdsClient;
  readonly payloads: ProductionPayloadBrokerClient;
  readonly peerBinding: ExecutionAdmissionPeerBinding;
  readonly readiness: () => ProductionWorkerReadiness;
  readonly connectAgentServices: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const DEFAULT_MAXIMUM_BODY_BYTES = 65_536;
const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 48 * 1024;
const DEFAULT_MAXIMUM_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAXIMUM_PROGRESS_EVENTS = 256;

function nonEmpty(value: string | undefined, code: ProductionWorkerCompositionErrorCode): string {
  if (!value || value.length === 0) throw new ProductionWorkerCompositionError(code);
  return value;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CREDENTIAL_INVALID,
      "Production Worker numeric binding is invalid",
      { field },
    );
  }
  return value;
}

function assertCredential(credential: ExecutionUdsCredential): void {
  if (
    typeof credential.tokenRef !== "string" ||
    credential.tokenRef.length === 0 ||
    typeof credential.tokenValue !== "string" ||
    credential.tokenValue.length < 32
  ) {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CREDENTIAL_INVALID,
    );
  }
}

function productionClock(): ClockPort {
  return Object.freeze({ now: () => new Date().toISOString() });
}

function productionIds(): IdGeneratorPort {
  return Object.freeze({ next: (namespace: string) => `${namespace}:${randomUUID()}` });
}

function sameEnforcement(
  left: CapabilityRuntimeQualification["enforcement"],
  right: CapabilityRuntimeQualification["enforcement"],
): boolean {
  return (
    left.filesystem === right.filesystem &&
    left.network === right.network &&
    left.processes === right.processes &&
    left.secrets === right.secrets &&
    left.resourceCeilings === right.resourceCeilings &&
    left.termination === right.termination
  );
}

function qualificationMismatch(
  expected: LoadedCapabilityDeployment["snapshot"]["capabilities"][number]["qualification"],
  actual: typeof expected,
): string | undefined {
  if (
    actual.platform !== expected.platform ||
    actual.runtimeIdentity !== expected.runtimeIdentity ||
    actual.artifactDigest !== expected.artifactDigest ||
    actual.productionSuitable !== true ||
    actual.reasonCodes.length !== 0 ||
    !sameEnforcement(actual.enforcement, expected.enforcement)
  ) {
    return "qualification identity or enforcement changed";
  }
  if (expected.reasonCodes.length !== 0) return "snapshot qualification contains blockers";
  return undefined;
}

function completeDeployment(deployment: LoadedCapabilityDeployment): void {
  const entries = deployment.snapshot.capabilities;
  if (
    deployment.manifests.length !== entries.length ||
    deployment.records.length !== entries.length ||
    deployment.adapters.length !== entries.length ||
    entries.length === 0
  ) {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CAPABILITY_REGISTRY_INCOMPLETE,
    );
  }
  const entryByRef = new Map(entries.map((entry) => [entry.manifest.ref, entry] as const));
  for (const record of deployment.records) {
    const entry = entryByRef.get(record.ref);
    if (
      !entry ||
      record.lifecycle !== "active" ||
      record.declaration.version !== entry.manifest.version ||
      record.declaration.integrity !== entry.manifest.integrity ||
      record.runtimeQualification?.artifactDigest !== entry.manifest.integrity ||
      record.runtimeQualification?.productionSuitable !== true
    ) {
      throw new ProductionWorkerCompositionError(
        PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CAPABILITY_REGISTRY_INCOMPLETE,
        "Capability registry record is not bound to the deployment snapshot",
        { capabilityRef: record.ref },
      );
    }
  }
  for (const adapter of deployment.adapters) {
    const entry = entryByRef.get(adapter.capabilityId);
    if (
      !entry ||
      adapter.capabilityVersion !== entry.manifest.version ||
      adapter.artifactDigest !== entry.manifest.integrity ||
      adapter.runtimeKind !== entry.manifest.runtime.kind ||
      adapter.operations.length !== entry.manifest.operations.length ||
      !adapter.operations.every((operation) => entry.manifest.operations.includes(operation))
    ) {
      throw new ProductionWorkerCompositionError(
        PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CAPABILITY_REGISTRY_INCOMPLETE,
        "Capability Worker adapter is not bound to the deployment snapshot",
        { capabilityRef: adapter.capabilityId },
      );
    }
  }
}

function maximumCeiling(
  configuration: ProductConfiguration,
  deployment: LoadedCapabilityDeployment,
  maximumPayloadBytes: number,
): ResourceCeiling {
  const result = {
    maxWallTimeMs: positiveSafeInteger(configuration.deadlines.runMs, "deadlines.runMs"),
    maxCpuTimeMs: positiveSafeInteger(configuration.deadlines.runMs, "deadlines.runMs"),
    maxMemoryBytes: DEFAULT_MAXIMUM_MEMORY_BYTES,
    maxOutputBytes: maximumPayloadBytes,
    maxProgressEvents: DEFAULT_MAXIMUM_PROGRESS_EVENTS,
  };
  for (const entry of deployment.snapshot.capabilities) {
    if (entry.binding.kind !== "process" && entry.binding.kind !== "sandbox") continue;
    result.maxWallTimeMs = Math.max(
      result.maxWallTimeMs,
      entry.binding.value.maximumResourceCeiling.maxWallTimeMs,
    );
    result.maxCpuTimeMs = Math.max(
      result.maxCpuTimeMs,
      entry.binding.value.maximumResourceCeiling.maxCpuTimeMs,
    );
    result.maxMemoryBytes = Math.max(
      result.maxMemoryBytes,
      entry.binding.value.maximumResourceCeiling.maxMemoryBytes,
    );
    result.maxOutputBytes = Math.max(
      result.maxOutputBytes,
      entry.binding.value.maximumResourceCeiling.maxOutputBytes,
    );
    result.maxProgressEvents = Math.max(
      result.maxProgressEvents,
      entry.binding.value.maximumResourceCeiling.maxProgressEvents,
    );
  }
  return Object.freeze(result) as ResourceCeiling;
}

function secretSource(configuration: ProductConfiguration, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return new MacOsKeychainProviderSecretSource({
      servicePrefix: "himawari-provider",
      account: "himawari-agent",
    });
  }
  return new SystemdProviderSecretSource(path.join(configuration.stateRoot, "secrets"));
}

function loaderOptions(
  options: ProductionWorkerCompositionOptions,
  clock: ClockPort,
  platform: NodeJS.Platform,
): CapabilityDeploymentSnapshotLoaderOptions {
  const configuration = options.configuration;
  if (!configuration.capabilityDeployment) {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CAPABILITY_DEPLOYMENT_REQUIRED,
    );
  }
  return {
    ...configuration.capabilityDeployment,
    platform,
    now: () => clock.now(),
    ...(options.maximumQualificationAgeMs === undefined
      ? {}
      : { maximumQualificationAgeMs: options.maximumQualificationAgeMs }),
  };
}

function isolationBackend(
  deployment: LoadedCapabilityDeployment,
  clock: ClockPort,
  platform: NodeJS.Platform,
): SandboxedProcessIsolationBackend {
  if (platform === "darwin") {
    return new MacSignedHelperIsolationBackend({ clock, platform });
  }
  if (platform !== "linux") {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.PLATFORM_UNSUPPORTED,
    );
  }
  const hasProcess = deployment.snapshot.capabilities.some(
    (entry) => entry.binding.kind === "process",
  );
  if (hasProcess && deployment.hostIsolation === undefined) {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.HOST_ISOLATION_BINDING_REQUIRED,
    );
  }
  return new LinuxBubblewrapIsolationBackend({
    bindings: deployment.bindings,
    clock,
    platform,
    ...(deployment.hostIsolation === undefined ? {} : { hostBinding: deployment.hostIsolation }),
  });
}

async function qualifyDeployment(
  deployment: LoadedCapabilityDeployment,
  clock: ClockPort,
  platform: NodeJS.Platform,
  isolation: SandboxedProcessIsolationBackend,
): Promise<void> {
  const qualifier = new NodeCapabilityRuntimeQualifier({
    bindings: deployment.bindings,
    process: isolation,
    clock,
    platform,
  });
  for (const entry of deployment.snapshot.capabilities) {
    if (entry.binding.kind === "sandbox") {
      if (!entry.qualification.sandbox) throw new Error("SANDBOX_QUALIFICATION_UNAVAILABLE");
      await verifySandboxHost({
        binding: entry.binding.value,
        qualification: entry.qualification.sandbox,
        hostId: entry.binding.value.hostId,
      });
      continue;
    }
    const actual = await qualifier.qualify(entry.manifest);
    if (!actual.productionSuitable || actual.reasonCodes.length > 0) {
      throw new ProductionWorkerCompositionError(
        PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.LIVE_QUALIFICATION_FAILED,
        "Capability runtime is not production suitable",
        {
          capabilityRef: entry.manifest.ref,
          reason: actual.reasonCodes[0] ?? "not-production-suitable",
        },
      );
    }
    const mismatch = qualificationMismatch(entry.qualification, actual);
    if (mismatch) {
      throw new ProductionWorkerCompositionError(
        PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.QUALIFICATION_MISMATCH,
        "Capability runtime qualification no longer matches the signed snapshot",
        { capabilityRef: entry.manifest.ref, reason: mismatch },
      );
    }
  }
}

export async function createProductionWorkerComposition(
  options: ProductionWorkerCompositionOptions,
): Promise<ProductionWorkerComposition> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.PLATFORM_UNSUPPORTED,
    );
  }
  const clock = options.clock ?? productionClock();
  const ids = options.ids ?? productionIds();
  const nextId = options.nextId ?? ((scope: string) => ids.next(scope));
  const configuration = options.configuration;
  assertCredential(options.credential);
  const agentServiceBootId = nonEmpty(
    options.agentServiceBootId,
    PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.AGENT_SERVICE_BOOT_ID_REQUIRED,
  );
  const agentServiceInstanceId =
    options.agentServiceInstanceId ?? `agent-service:${configuration.deploymentId}`;
  const workerInstanceId =
    options.workerInstanceId ?? `execution-worker:${configuration.deploymentId}`;
  const workerBootId = options.workerBootId ?? `worker-boot:${randomUUID()}`;
  nonEmpty(agentServiceInstanceId, PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CREDENTIAL_INVALID);
  nonEmpty(workerInstanceId, PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CREDENTIAL_INVALID);
  nonEmpty(workerBootId, PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CREDENTIAL_INVALID);
  positiveSafeInteger(options.authority.authorityEpoch, "authorityEpoch");
  positiveSafeInteger(options.authority.fencingToken, "fencingToken");

  const deployment = await new CapabilityDeploymentSnapshotLoader(
    loaderOptions(options, clock, platform),
  ).load();
  completeDeployment(deployment);
  const isolation = isolationBackend(deployment, clock, platform);
  await qualifyDeployment(deployment, clock, platform, isolation);

  const maximumBodyBytes = options.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES;
  const maximumPayloadBytes = options.maximumPayloadBytes ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
  if (
    !Number.isSafeInteger(maximumBodyBytes) ||
    maximumBodyBytes < 1 ||
    !Number.isSafeInteger(maximumPayloadBytes) ||
    maximumPayloadBytes < 1 ||
    maximumPayloadBytes > maximumBodyBytes
  ) {
    throw new ProductionWorkerCompositionError(
      PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CREDENTIAL_INVALID,
      "Worker UDS resource ceilings are invalid",
    );
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? configuration.deadlines.workerRequestMs;
  positiveSafeInteger(requestTimeoutMs, "deadlines.workerRequestMs");
  const peerBinding: ExecutionAdmissionPeerBinding = Object.freeze({
    agentServiceInstanceId,
    agentServiceBootId,
    workerInstanceId,
    workerBootId,
    deploymentId: configuration.deploymentId,
    authorityEpoch: options.authority.authorityEpoch,
    fencingToken: options.authority.fencingToken,
  });
  const admission = new ExecutionAdmissionUdsClient({
    socketPath:
      options.admissionSocketPath ??
      path.join(configuration.runtimeDirectory, "execution-admission.sock"),
    credential: options.credential,
    peerBinding,
    maximumBodyBytes,
    requestTimeoutMs,
    nextId,
    now: () => clock.now(),
  });
  const payloads = new ProductionPayloadBrokerClient({
    socketPath:
      options.payloadSocketPath ?? path.join(configuration.runtimeDirectory, "payload.sock"),
    credential: options.credential,
    agentServiceInstanceId,
    agentServiceBootId,
    workerInstanceId,
    workerBootId,
    authorityEpoch: options.authority.authorityEpoch,
    fencingToken: options.authority.fencingToken,
    maximumBodyBytes,
    maximumPayloadBytes,
    requestTimeoutMs,
    nextId,
  });
  const providerSecrets = secretSource(configuration, platform);
  assertProductionSecretSource(providerSecrets);
  const secretHandles = new EphemeralSecretPort({ ids, clock });
  const activeManifests = Object.freeze({
    listActive: async () => deployment.manifests,
  });
  const delegations = new WorkerDelegationStore({
    authorityFence: options.authority.fencingToken,
    adapters: deployment.adapters,
    records: deployment.records,
    now: () => clock.now(),
  });
  const runtime = new NodeCapabilityRuntimePort({
    manifests: activeManifests,
    bindings: deployment.bindings,
    isolation,
    payloads,
    secretHandles,
    secretSource: providerSecrets,
    clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const service = new ExecutionWorkerServiceImplementation({
    handles: delegations,
    capability: runtime,
    secrets: secretHandles,
    clock,
    ids,
    authorityFence: () => options.authority.fencingToken,
  });

  let stopped = false;
  let agentServicesReady = false;
  let connectPromise: Promise<void> | undefined;
  const readiness = (): ProductionWorkerReadiness => {
    if (stopped) {
      return Object.freeze({
        live: false,
        ready: false,
        reasonCodes: Object.freeze([PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.SHUTDOWN]),
      });
    }
    return Object.freeze({
      live: true,
      ready: agentServicesReady,
      reasonCodes: Object.freeze(
        agentServicesReady
          ? []
          : [PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.AGENT_SERVICES_UNAVAILABLE],
      ),
    });
  };
  const worker = new ProductionExecutionWorker({
    ...(deployment.snapshot.capabilities.some((entry) => entry.binding.kind === "sandbox")
      ? {
          sandboxV2: new ProductionSandboxExecutionV2({
            configuration,
            peer: peerBinding,
            payloads,
            clock,
          }),
          sandbox: createProductionSandboxWorker({
            configuration,
            peer: peerBinding,
            payloads,
            clock,
          }),
        }
      : {}),
    service,
    workerInstanceId,
    workerBootId,
    bootTokenRef: options.credential.tokenRef,
    deploymentId: configuration.deploymentId,
    authorityEpoch: options.authority.authorityEpoch,
    fencingToken: options.authority.fencingToken,
    maximumResourceCeiling: maximumCeiling(configuration, deployment, maximumPayloadBytes),
    adapters: deployment.adapters,
    delegations,
    now: () => clock.now(),
    nextId,
    readiness,
  });
  const connectAgentServices = async (): Promise<void> => {
    if (stopped)
      throw new ProductionWorkerCompositionError(
        PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.SHUTDOWN,
      );
    if (agentServicesReady) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      try {
        await admission.connect();
        await payloads.connect();
        if (stopped)
          throw new ProductionWorkerCompositionError(
            PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.SHUTDOWN,
          );
        agentServicesReady = true;
      } catch (error) {
        admission.disconnect();
        payloads.disconnect();
        agentServicesReady = false;
        if (error instanceof ProductionWorkerCompositionError) throw error;
        throw new ProductionWorkerCompositionError(
          PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.AGENT_SERVICES_UNAVAILABLE,
          "Authenticated Agent UDS services are unavailable",
        );
      } finally {
        connectPromise = undefined;
      }
    })();
    return connectPromise;
  };
  const close = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    agentServicesReady = false;
    try {
      // Keep the broker available while jobs stop and persist their final observations.
      await worker.shutdown();
    } finally {
      admission.disconnect();
      payloads.disconnect();
      secretHandles.clear();
    }
  };
  return Object.freeze({
    worker,
    service,
    runtime,
    isolation,
    deployment,
    delegations,
    admission,
    payloads,
    peerBinding,
    readiness,
    connectAgentServices,
    close,
  });
}
