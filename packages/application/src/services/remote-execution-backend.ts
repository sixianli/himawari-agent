import {
  EXECUTION_V2_SCHEMA_VERSION,
  type EnvironmentOperation,
  type EnvironmentOperationRequestPayload,
  type EnvironmentOperationResults,
  type ExecutionEnvironmentIdentity,
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import type { ExecutionTransportPort } from "../ports/coordination.js";
import type { ExecutionBackendPort } from "../ports/execution-backend.js";

export class RemoteExecutionBackendError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RemoteExecutionBackendError";
    this.code = code;
  }
}

export interface RemoteExecutionBackendOptions {
  readonly transport: ExecutionTransportPort;
  readonly ownerId: string;
  readonly agentId: string;
  readonly authority: () => {
    readonly deploymentId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
  };
  readonly nextId: (scope: string) => string;
  readonly now: () => string;
  readonly requestTimeoutMs: number;
  readonly resultTimeoutMs: number;
  readonly pollIntervalMs: number;
}

type EnvironmentRequest = Extract<ExecutionV2Request, { type: "environment.operation.execute" }>;
type PayloadOf<TOperation extends EnvironmentOperation> = Omit<
  Extract<EnvironmentOperationRequestPayload, { readonly operation: TOperation }>,
  "operation" | "requestedAt" | "deadlineAt"
>;

export class RemoteExecutionBackend implements ExecutionBackendPort {
  private readonly options: RemoteExecutionBackendOptions;

  constructor(options: RemoteExecutionBackendOptions) {
    this.options = options;
  }

  capabilities() {
    return this.send("capabilities", {}, null, null);
  }

  create(input: Parameters<ExecutionBackendPort["create"]>[0]) {
    const { deadlineAt, ...rest } = input;
    return this.send(
      "create",
      { ...rest, environmentDeadlineAt: deadlineAt },
      input.identity,
      `environment-create:${input.identity.environmentId}:${input.createIntentId}`,
    );
  }

  execute(input: Parameters<ExecutionBackendPort["execute"]>[0]) {
    const { deadlineAt, authorizationRef, credential, ...rest } = input;
    return this.send(
      "execute",
      { ...rest, invocationDeadlineAt: deadlineAt, credential: credential ?? null },
      input.identity,
      `environment-execute:${input.identity.environmentId}:${input.invocationId}`,
      authorizationRef,
    );
  }

  inspect(input: Parameters<ExecutionBackendPort["inspect"]>[0]) {
    return this.send("inspect", input, input.identity, null);
  }

  stop(input: Parameters<ExecutionBackendPort["stop"]>[0]) {
    return this.send(
      "stop",
      input,
      input.identity,
      `environment-stop:${input.identity.environmentId}:${input.stopIntentId}`,
    );
  }

  verifyStopped(input: Parameters<ExecutionBackendPort["verifyStopped"]>[0]) {
    return this.send("verifyStopped", input, input.identity, null);
  }

  async destroy(input: Parameters<ExecutionBackendPort["destroy"]>[0]) {
    await this.send(
      "destroy",
      input,
      input.identity,
      `environment-destroy:${input.identity.environmentId}:${input.createIntentId}`,
    );
  }

  private async send<TOperation extends EnvironmentOperation>(
    operation: TOperation,
    fields: PayloadOf<TOperation>,
    identity: ExecutionEnvironmentIdentity | null,
    stateChangeKey: string | null,
    authorizationRef: string | null = null,
  ): Promise<EnvironmentOperationResults[TOperation]> {
    const requestedAt = this.options.now();
    const messageId = stateChangeKey ?? this.options.nextId(`environment-${operation}`);
    const parsed = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "environment.operation.execute",
      messageId,
      correlationId: identity ? `environment:${identity.environmentId}` : messageId,
      causationId: null,
      dataClassification: "private",
      risk: operation === "execute" ? "high" : "medium",
      authorizationRef,
      scope: {
        ...this.options.authority(),
        ownerId: this.options.ownerId,
        agentId: this.options.agentId,
        runId: identity?.runId ?? null,
        workerRunId: identity ? `environment:${identity.environmentId}` : null,
      },
      idempotencyKey: messageId,
      payload: {
        operation,
        ...fields,
        requestedAt,
        deadlineAt: new Date(Date.parse(requestedAt) + this.options.requestTimeoutMs).toISOString(),
      },
    });
    if (parsed.kind !== "request" || parsed.type !== "environment.operation.execute")
      throw new RemoteExecutionBackendError("EXECUTION_ENVIRONMENT_REQUEST_INVALID");
    await this.options.transport.request(parsed);
    return (await this.result(parsed)) as EnvironmentOperationResults[TOperation];
  }

  private async result(request: EnvironmentRequest): Promise<unknown> {
    const scope = JSON.stringify(request.scope);
    const deadline = Date.now() + this.options.resultTimeoutMs;
    while (Date.now() < deadline) {
      for await (const event of this.options.transport.events(null)) {
        if (
          event.type !== "environment.operation.result" ||
          event.payload.requestId !== request.messageId ||
          event.causationId !== request.messageId ||
          event.correlationId !== request.correlationId ||
          event.payload.operation !== request.payload.operation ||
          JSON.stringify(event.scope) !== scope
        )
          continue;
        if (event.payload.outcome === "succeeded") return event.payload.result;
        throw new RemoteExecutionBackendError(
          event.payload.outcome === "failed" && event.payload.errorCode
            ? event.payload.errorCode
            : "EXECUTION_ENVIRONMENT_RESULT_UNKNOWN",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
    }
    throw new RemoteExecutionBackendError("EXECUTION_ENVIRONMENT_RESULT_UNKNOWN");
  }
}
