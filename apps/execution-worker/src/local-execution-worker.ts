import {
  ExecutionWorkerService,
  type ExecutionWorkerServiceDependencies,
} from "@himawari-agent/application";
import {
  EXECUTION_SCHEMA_VERSION,
  type ExecutionEvent,
  type ExecutionRequest,
  executionMessageSchema,
} from "@himawari-agent/execution-contracts";

export interface ServiceDiagnostic {
  readonly component: "execution-worker";
  readonly adapterIdentity: "local-in-process-execution-worker";
  readonly schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  readonly readiness: "ready";
}

export interface ExecutionWorkerClientPort {
  readonly adapterIdentity: string;
  readonly schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  isReady(): boolean;
  dispatch(request: ExecutionRequest): AsyncIterable<ExecutionEvent>;
}

export class LocalExecutionWorkerProcess {
  readonly client: ExecutionWorkerClientPort;
  private readonly service: ExecutionWorkerService;
  private readonly activeSettlements = new Set<Promise<void>>();
  private lifecycle: "stopped" | "ready" | "draining" = "stopped";

  constructor(dependencies: ExecutionWorkerServiceDependencies) {
    this.service = new ExecutionWorkerService(dependencies);
    this.client = Object.freeze({
      adapterIdentity: "local-in-process-execution-worker",
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      isReady: () => this.isReady(),
      dispatch: (request: ExecutionRequest) => this.dispatch(request),
    });
  }

  async start(): Promise<ServiceDiagnostic> {
    if (this.lifecycle === "draining") throw new Error("WORKER_DRAINING");
    this.lifecycle = "ready";
    return Object.freeze({
      component: "execution-worker",
      adapterIdentity: "local-in-process-execution-worker",
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      readiness: "ready",
    });
  }

  isReady(): boolean {
    return this.lifecycle === "ready";
  }

  async *dispatch(request: ExecutionRequest): AsyncIterable<ExecutionEvent> {
    if (!this.isReady()) throw new Error("WORKER_NOT_READY");
    const parsed = executionMessageSchema.parse(request);
    if (parsed.kind !== "request") throw new TypeError("Execution Worker accepts requests only");
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.activeSettlements.add(settlement);
    try {
      if (parsed.type === "work.execute") {
        for await (const event of this.service.execute(parsed)) yield event;
        return;
      }
      if (parsed.type === "work.cancel") {
        yield await this.service.cancel(parsed);
        return;
      }
      yield await this.service.reconcile(parsed);
    } finally {
      settle();
      this.activeSettlements.delete(settlement);
    }
  }

  async shutdown(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    this.lifecycle = "draining";
    await Promise.allSettled([...this.activeSettlements]);
    this.lifecycle = "stopped";
  }
}

export function createLocalExecutionWorkerProcess(
  dependencies: ExecutionWorkerServiceDependencies,
): LocalExecutionWorkerProcess {
  return new LocalExecutionWorkerProcess(dependencies);
}
