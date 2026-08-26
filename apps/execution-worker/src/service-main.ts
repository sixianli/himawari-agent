import type { ExecutionTransportPort } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  ExecutionUdsServer,
  initializeStateRoot,
  JsonFileConfigurationPort,
  parseServiceArguments,
  readAuthorityFile,
  readRestrictedExecutionTokenFile,
  stableErrorCode,
  waitForTerminationSignal,
  writeServiceDiagnostic,
} from "@himawari-agent/platform-node";

export const EXECUTION_WORKER_SERVICE_ERROR_CODES = Object.freeze({
  ADAPTER_REGISTRY_EMPTY: "WORKER_ADAPTER_REGISTRY_EMPTY",
  AUTHORITY_INACTIVE: "WORKER_AUTHORITY_INACTIVE",
  AUTHORITY_MISMATCH: "WORKER_AUTHORITY_MISMATCH",
} as const);

class EntrypointExecutionTransport implements ExecutionTransportPort {
  readonly #deploymentId: string;
  readonly #authorityEpoch: number;
  readonly #fencingToken: number;
  readonly #bootTokenRef: string;
  readonly #workerInstanceId: string;
  readonly #workerBootId: string;

  constructor(options: {
    readonly deploymentId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
    readonly bootTokenRef: string;
    readonly workerInstanceId: string;
    readonly workerBootId: string;
  }) {
    this.#deploymentId = options.deploymentId;
    this.#authorityEpoch = options.authorityEpoch;
    this.#fencingToken = options.fencingToken;
    this.#bootTokenRef = options.bootTokenRef;
    this.#workerInstanceId = options.workerInstanceId;
    this.#workerBootId = options.workerBootId;
  }

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    if (
      message.scope.deploymentId !== this.#deploymentId ||
      message.scope.authorityEpoch !== this.#authorityEpoch ||
      message.scope.fencingToken !== this.#fencingToken
    ) {
      throw new Error("WORKER_STALE_FENCE");
    }
    if (message.type === "worker.handshake") {
      if (
        message.payload.bootTokenRef !== this.#bootTokenRef ||
        !message.payload.supportedSchemaVersions.includes(EXECUTION_V2_SCHEMA_VERSION)
      ) {
        throw new Error("WORKER_HANDSHAKE_REJECTED");
      }
      return this.response(message, "worker.handshake.accepted", {
        workerInstanceId: this.#workerInstanceId,
        workerBootId: this.#workerBootId,
        selectedSchemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        ready: true,
        acceptedAt: new Date().toISOString(),
      });
    }
    if (message.type === "worker.readiness.query") {
      return this.response(message, "worker.readiness.snapshot", {
        workerInstanceId: this.#workerInstanceId,
        live: true,
        ready: true,
        supportedSchemaVersions: [EXECUTION_V2_SCHEMA_VERSION],
        reasonCodes: [EXECUTION_WORKER_SERVICE_ERROR_CODES.ADAPTER_REGISTRY_EMPTY],
        observedAt: new Date().toISOString(),
      });
    }
    if (message.type === "work.events.replay") return null;
    throw new Error(EXECUTION_WORKER_SERVICE_ERROR_CODES.ADAPTER_REGISTRY_EMPTY);
  }

  async *events(_afterCursor: string | null): AsyncIterable<ExecutionV2Event> {}

  private response<TType extends "worker.handshake.accepted" | "worker.readiness.snapshot">(
    request: Extract<ExecutionV2Request, { type: "worker.handshake" | "worker.readiness.query" }>,
    type: TType,
    payload: unknown,
  ): Extract<ExecutionV2Response, { type: TType }> {
    const response = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "response",
      type,
      messageId: `${type}:${this.#workerBootId}`,
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
      payload,
    });
    if (response.kind !== "response" || response.type !== type) {
      throw new TypeError("Worker response is invalid");
    }
    return response as Extract<ExecutionV2Response, { type: TType }>;
  }
}

export async function runExecutionWorkerService(
  arguments_: readonly string[],
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  let server: ExecutionUdsServer | undefined;
  try {
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
    const credential = await readRestrictedExecutionTokenFile(args.workerTokenPath);
    const instanceId = `agent-service:${configuration.deploymentId}`;
    const workerBootId = `worker-boot:${String(process.pid)}`;
    server = new ExecutionUdsServer({
      runtimeDirectory: configuration.runtimeDirectory,
      credential,
      allowedAgentServiceInstanceIds: [instanceId],
      transport: new EntrypointExecutionTransport({
        deploymentId: configuration.deploymentId,
        authorityEpoch: authority.authorityEpoch,
        fencingToken: authority.fencingToken,
        bootTokenRef: credential.tokenRef,
        workerInstanceId: `execution-worker:${configuration.deploymentId}`,
        workerBootId,
      }),
      maximumBodyBytes: 65_536,
      requestTimeoutMs: configuration.deadlines.workerRequestMs,
    });
    await server.start();
    writeServiceDiagnostic(output, {
      component: "execution-worker",
      event: "service.ready",
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      deploymentId: configuration.deploymentId,
      authorityEpoch: authority.authorityEpoch,
      fencingToken: authority.fencingToken,
      adapterRegistry: "empty-fail-closed",
    });
    const signal = await waitForTerminationSignal();
    writeServiceDiagnostic(output, {
      component: "execution-worker",
      event: "service.draining",
      signal,
    });
    await server.stop();
    writeServiceDiagnostic(output, { component: "execution-worker", event: "service.stopped" });
    return 0;
  } catch (error) {
    await server?.stop().catch(() => undefined);
    writeServiceDiagnostic(errorOutput, {
      component: "execution-worker",
      event: "service.failed",
      code: stableErrorCode(error),
    });
    return 1;
  }
}
