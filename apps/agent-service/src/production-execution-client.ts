import type { ExecutionTransportPort } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  EXECUTION_UDS_ERROR_CODES,
  ExecutionUdsClient,
  type ExecutionUdsClientOptions,
  ExecutionUdsError,
} from "@himawari-agent/platform-node";

export interface AgentServiceExecutionClientOptions extends ExecutionUdsClientOptions {
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly now: () => string;
  readonly nextId: (scope: string) => string;
}

export class AgentServiceExecutionClient implements ExecutionTransportPort {
  readonly adapterIdentity = "agent-service-execution-v2-uds-client";
  readonly schemaVersion = EXECUTION_V2_SCHEMA_VERSION;
  private readonly options: AgentServiceExecutionClientOptions;
  private readonly client: ExecutionUdsClient;

  constructor(options: AgentServiceExecutionClientOptions) {
    this.options = options;
    this.client = new ExecutionUdsClient(options);
  }

  async start(): Promise<Extract<ExecutionV2Response, { type: "worker.handshake.accepted" }>> {
    const message = executionV2MessageSchema.parse({
      ...this.requestEnvelope("worker.handshake"),
      payload: {
        agentServiceInstanceId: this.options.agentServiceInstanceId,
        bootTokenRef: this.options.credential.tokenRef,
        supportedSchemaVersions: [EXECUTION_V2_SCHEMA_VERSION],
        requestedAt: this.options.now(),
      },
    });
    if (message.kind !== "request" || message.type !== "worker.handshake") {
      throw new TypeError("Invalid Worker handshake request");
    }
    return this.client.connect(message);
  }

  isReady(): boolean {
    return this.client.isReady();
  }

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    if (!this.isReady() && message.type !== "worker.handshake") {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE, 503);
    }
    return this.client.request(message);
  }

  async *events(afterCursor: string | null): AsyncIterable<ExecutionV2Event> {
    if (!this.isReady()) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE, 503);
    }
    yield* this.client.events(afterCursor);
  }

  stop(): void {
    this.client.disconnect();
  }

  private requestEnvelope(type: "worker.handshake") {
    const messageId = this.options.nextId("execution-request");
    return {
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request" as const,
      type,
      messageId,
      correlationId: messageId,
      causationId: null,
      dataClassification: "private" as const,
      risk: "low" as const,
      authorizationRef: null,
      scope: {
        deploymentId: this.options.deploymentId,
        authorityEpoch: this.options.authorityEpoch,
        fencingToken: this.options.fencingToken,
        ownerId: null,
        agentId: null,
        runId: null,
        workerRunId: null,
      },
      idempotencyKey: `${messageId}:idempotency`,
    };
  }
}
