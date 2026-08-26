import { Worker } from "node:worker_threads";
import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
import { SQLITE_PERSISTENCE_ERROR_CODES, SqlitePersistenceError } from "./state-root-lock.js";

export interface SqliteWorkerConfiguration {
  readonly databasePath: string;
  readonly writerSequence: number;
  readonly busyTimeoutMs: number;
  readonly minimumFreeBytes: number;
  readonly startupNow: string;
  readonly qualification?: {
    readonly crashAt?: "after_state" | "after_result" | "after_event" | "after_commit";
    readonly holdBeforeCommitMs?: number;
    readonly maximumPageCount?: number;
  };
}

interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
}

interface WorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: {
    readonly kind: "application" | "persistence";
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, string>>;
  };
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

interface PendingOperation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class SqliteExecutionContext {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingOperation>();
  private nextId = 1;
  private exited = false;
  private startupRecovery: unknown;

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.on("message", (message: WorkerResponse) => this.receive(message));
    worker.on("error", (error) => this.failAll(error));
    worker.on("exit", (code) => {
      this.exited = true;
      if (this.pending.size > 0) {
        this.failAll(
          new SqlitePersistenceError(
            SQLITE_PERSISTENCE_ERROR_CODES.WORKER_EXITED,
            `The SQLite execution worker exited with status ${code}`,
            { exitStatus: String(code) },
          ),
        );
      }
    });
  }

  static async start(configuration: SqliteWorkerConfiguration): Promise<SqliteExecutionContext> {
    const worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
      workerData: configuration,
    });
    const context = new SqliteExecutionContext(worker);
    const ready = await context.request<{ readonly startupRecovery: unknown }>("ready", {});
    context.startupRecovery = ready.startupRecovery;
    return context;
  }

  initialRecovery<TResult>(): TResult {
    return structuredClone(this.startupRecovery) as TResult;
  }

  request<TResult>(operation: string, payload: unknown): Promise<TResult> {
    if (this.exited) {
      return Promise.reject(
        new SqlitePersistenceError(
          SQLITE_PERSISTENCE_ERROR_CODES.WORKER_EXITED,
          "The SQLite execution worker is not running",
        ),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, operation, payload });
    });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    await this.request("close", {});
  }

  private receive(message: WorkerResponse): void {
    const operation = this.pending.get(message.id);
    if (!operation) return;
    this.pending.delete(message.id);
    if (message.ok) {
      operation.resolve(message.value);
      return;
    }
    const { error } = message;
    if (error.kind === "application") {
      operation.reject(
        new ApplicationPortError(error.code as PortErrorCode, error.message, error.details),
      );
      return;
    }
    operation.reject(
      new SqlitePersistenceError(
        SQLITE_PERSISTENCE_ERROR_CODES.WORKER_OPERATION_FAILED,
        error.message,
        { workerCode: error.code, ...error.details },
      ),
    );
  }

  private failAll(error: unknown): void {
    for (const operation of this.pending.values()) operation.reject(error);
    this.pending.clear();
  }
}
