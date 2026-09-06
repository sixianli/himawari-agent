import { randomUUID } from "node:crypto";
import { EXECUTION_V2_SCHEMA_VERSION } from "@himawari-agent/execution-contracts";
import {
  ExecutionUdsServer,
  initializeStateRoot,
  JsonFileConfigurationPort,
  parseServiceArguments,
  readAgentServiceBootBinding,
  readAuthorityFile,
  readRestrictedExecutionTokenFile,
  stableErrorCode,
  waitForTerminationSignal,
  writeServiceDiagnostic,
  writeWorkerServiceBootBinding,
} from "@himawari-agent/platform-node";
import {
  createProductionWorkerComposition,
  type ProductionWorkerComposition,
} from "./production-worker-composition.js";

export const EXECUTION_WORKER_SERVICE_ERROR_CODES = Object.freeze({
  AUTHORITY_INACTIVE: "WORKER_AUTHORITY_INACTIVE",
  AUTHORITY_MISMATCH: "WORKER_AUTHORITY_MISMATCH",
  AGENT_SERVICE_BOOT_BINDING_INVALID: "WORKER_AGENT_SERVICE_BOOT_BINDING_INVALID",
  STARTUP_TIMEOUT: "WORKER_STARTUP_TIMEOUT",
} as const);

const DEFAULT_STARTUP_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_RETRY_DELAY_MS = 50;

export type ExecutionWorkerServiceDependencies = Readonly<{
  readonly startupWaitTimeoutMs?: number;
  readonly startupRetryDelayMs?: number;
}>;

type StartupTiming = Readonly<{
  readonly startupWaitTimeoutMs: number;
  readonly startupRetryDelayMs: number;
}>;

function resolveStartupTiming(dependencies: ExecutionWorkerServiceDependencies): StartupTiming {
  const startupWaitTimeoutMs = dependencies.startupWaitTimeoutMs ?? DEFAULT_STARTUP_WAIT_TIMEOUT_MS;
  const startupRetryDelayMs = dependencies.startupRetryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(startupWaitTimeoutMs) || startupWaitTimeoutMs <= 0) {
    throw new TypeError("Worker startup wait timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(startupRetryDelayMs) || startupRetryDelayMs <= 0) {
    throw new TypeError("Worker startup retry delay must be a positive safe integer");
  }
  return Object.freeze({ startupWaitTimeoutMs, startupRetryDelayMs });
}

function sameAuthorityScope(
  authority: Awaited<ReturnType<typeof readAuthorityFile>>,
  configuration: Awaited<ReturnType<JsonFileConfigurationPort["load"]>>,
): boolean {
  return (
    authority.status === "active" &&
    authority.id === configuration.deploymentId &&
    authority.ownerId === configuration.ownerId &&
    authority.agentId === configuration.agentId
  );
}

function sameAuthorityGeneration(
  left: Awaited<ReturnType<typeof readAuthorityFile>>,
  right: Awaited<ReturnType<typeof readAuthorityFile>>,
): boolean {
  return (
    left.id === right.id &&
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken
  );
}

async function waitForAgentBinding(input: {
  readonly layout: Awaited<ReturnType<typeof initializeStateRoot>>;
  readonly configuration: Awaited<ReturnType<JsonFileConfigurationPort["load"]>>;
  readonly workerInstanceId: string;
  readonly workerBootId: string;
  readonly timing: StartupTiming;
}): Promise<{
  readonly authority: Awaited<ReturnType<typeof readAuthorityFile>>;
  readonly agentServiceBootId: string;
}> {
  const deadline = Date.now() + input.timing.startupWaitTimeoutMs;
  let publishedAuthority: Awaited<ReturnType<typeof readAuthorityFile>> | undefined;
  for (;;) {
    const authority = await readAuthorityFile(input.layout);
    if (!sameAuthorityScope(authority, input.configuration)) {
      throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    if (!publishedAuthority || !sameAuthorityGeneration(publishedAuthority, authority)) {
      await writeWorkerServiceBootBinding(input.layout, {
        workerInstanceId: input.workerInstanceId,
        workerBootId: input.workerBootId,
        authority,
      });
      publishedAuthority = authority;
    }
    const agentBinding = await readAgentServiceBootBinding(input.layout).catch(() => undefined);
    if (
      agentBinding &&
      agentBinding.workerInstanceId === input.workerInstanceId &&
      agentBinding.workerBootId === input.workerBootId &&
      agentBinding.agentServiceInstanceId === `agent-service:${input.configuration.deploymentId}` &&
      agentBinding.deploymentId === input.configuration.deploymentId &&
      agentBinding.ownerId === input.configuration.ownerId &&
      agentBinding.agentId === input.configuration.agentId &&
      agentBinding.authorityEpoch === authority.authorityEpoch &&
      agentBinding.fencingToken === authority.fencingToken
    ) {
      return Object.freeze({ authority, agentServiceBootId: agentBinding.agentServiceBootId });
    }
    if (Date.now() >= deadline) {
      throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.STARTUP_TIMEOUT);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, input.timing.startupRetryDelayMs));
  }
}

export async function runExecutionWorkerService(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
  dependencies: ExecutionWorkerServiceDependencies = {},
): Promise<number> {
  let server: ExecutionUdsServer | undefined;
  let composition: ProductionWorkerComposition | undefined;
  try {
    const timing = resolveStartupTiming(dependencies);
    const args = parseServiceArguments(arguments_);
    const configuration = await new JsonFileConfigurationPort(args.configurationPath).load();
    const layout = await initializeStateRoot(configuration.stateRoot);
    const authority = await readAuthorityFile(layout);
    if (authority.status !== "active") {
      throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.AUTHORITY_INACTIVE);
    }
    if (
      authority.id !== configuration.deploymentId ||
      authority.ownerId !== configuration.ownerId ||
      authority.agentId !== configuration.agentId
    ) {
      throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.AUTHORITY_MISMATCH);
    }
    const workerInstanceId = `execution-worker:${configuration.deploymentId}`;
    const workerBootId = `worker-boot:${randomUUID()}`;
    const credential = await readRestrictedExecutionTokenFile(args.workerTokenPath);
    const binding = await waitForAgentBinding({
      layout,
      configuration,
      workerInstanceId,
      workerBootId,
      timing,
    });
    composition = await createProductionWorkerComposition({
      configuration,
      credential,
      authority: {
        authorityEpoch: binding.authority.authorityEpoch,
        fencingToken: binding.authority.fencingToken,
      },
      agentServiceInstanceId: `agent-service:${configuration.deploymentId}`,
      agentServiceBootId: binding.agentServiceBootId,
      workerInstanceId,
      workerBootId,
    });
    server = new ExecutionUdsServer({
      runtimeDirectory: configuration.runtimeDirectory,
      credential,
      allowedAgentServiceInstanceIds: [composition.peerBinding.agentServiceInstanceId],
      transport: composition.worker,
      maximumBodyBytes: 65_536,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
    });
    await server.start();
    await composition.connectAgentServices();
    writeServiceDiagnostic(output, {
      component: "execution-worker",
      event: "service.ready",
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      deploymentId: configuration.deploymentId,
      authorityEpoch: binding.authority.authorityEpoch,
      fencingToken: binding.authority.fencingToken,
      adapterRegistry: "snapshot-qualified",
      capabilityCount: composition.deployment.manifests.length,
    });
    const signal = await waitForTerminationSignal();
    writeServiceDiagnostic(output, {
      component: "execution-worker",
      event: "service.draining",
      signal,
    });
    await server.stop();
    await composition.close();
    composition = undefined;
    writeServiceDiagnostic(output, { component: "execution-worker", event: "service.stopped" });
    return 0;
  } catch (error) {
    await server?.stop().catch(() => undefined);
    await composition?.close().catch(() => undefined);
    writeServiceDiagnostic(errorOutput, {
      component: "execution-worker",
      event: "service.failed",
      code: stableErrorCode(error),
    });
    return 1;
  }
}
