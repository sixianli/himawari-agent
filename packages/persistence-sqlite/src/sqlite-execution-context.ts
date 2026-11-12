import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
import { SQLITE_PERSISTENCE_ERROR_CODES, SqlitePersistenceError } from "./state-root-lock.js";

export interface SqliteWorkerConfiguration {
  readonly databasePath: string;
  readonly writerSequence: number;
  readonly busyTimeoutMs: number;
  readonly minimumFreeBytes: number;
  readonly warningFreeBytes: number;
  readonly readOnly?: boolean;
  readonly proactiveSources?: readonly {
    readonly name: string;
    readonly safetyLimits: {
      readonly perDay: {
        readonly defaultLimit: number;
        readonly minimum: number;
        readonly maximum: number;
      };
      readonly perCheck: {
        readonly defaultLimit: number;
        readonly minimum: number;
        readonly maximum: number;
      };
    };
  }[];
  readonly qualification?: {
    readonly crashAt?: "after_state" | "after_result" | "after_event" | "after_commit";
    readonly holdBeforeCommitMs?: number;
    readonly holdBeforeReadMs?: number;
    readonly maximumPageCount?: number;
  };
}

interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
  readonly runMs?: number;
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
  readonly runMs?: number;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

interface PendingOperation {
  readonly operation: string;
  readonly queuedAt: number;
  readonly queuedBehind: number;
  readonly inCaller: (<T>(report: () => T) => T) | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export type SqliteLane = "read" | "write";

export interface SqliteSlowOperation {
  readonly lane: SqliteLane;
  readonly operation: string;
  readonly totalMs: number;
  readonly queueWaitMs: number;
  readonly runMs: number;
  readonly queuedBehind: number;
}

export interface SqliteTimedOperation {
  readonly lane: SqliteLane;
  readonly operation: string;
  readonly queueWaitMs: number;
  readonly runMs: number;
}

export interface SqliteOperationObservers {
  readonly onSlowOperation?: (operation: SqliteSlowOperation) => void;
  readonly onOperation?: (operation: SqliteTimedOperation) => void;
}

const SLOW_OPERATION_MILLISECONDS = 500;

export class SqliteExecutionContext {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingOperation>();
  private nextId = 1;
  private exited = false;
  private readonly observers: SqliteOperationObservers;
  private readonly lane: SqliteLane;

  private constructor(worker: Worker, observers: SqliteOperationObservers, lane: SqliteLane) {
    this.worker = worker;
    this.observers = observers;
    this.lane = lane;
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

  static async start(
    configuration: SqliteWorkerConfiguration,
    observers: SqliteOperationObservers = {},
  ): Promise<SqliteExecutionContext> {
    const workerExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const worker = new Worker(new URL(`./sqlite-worker${workerExtension}`, import.meta.url), {
      workerData: configuration,
    });
    const context = new SqliteExecutionContext(
      worker,
      observers,
      configuration.readOnly ? "read" : "write",
    );
    await context.request<{ readonly writerSequence: number }>("ready", {});
    return context;
  }

  get pendingCount(): number {
    return this.pending.size;
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
      this.pending.set(id, {
        operation,
        queuedAt: performance.now(),
        queuedBehind: this.pending.size,
        inCaller: this.observers.onOperation ? AsyncLocalStorage.snapshot() : undefined,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
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
    this.report(operation, message.runMs);
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
        { workerCode: error.code, operation: operation.operation, ...error.details },
      ),
    );
  }

  private report(operation: PendingOperation, reportedRunMs: number | undefined): void {
    const totalMs = performance.now() - operation.queuedAt;
    const runMs = Math.min(totalMs, reportedRunMs ?? totalMs);
    const { onOperation, onSlowOperation } = this.observers;
    if (onOperation && operation.inCaller)
      operation.inCaller(() =>
        onOperation({
          lane: this.lane,
          operation: operation.operation,
          queueWaitMs: totalMs - runMs,
          runMs,
        }),
      );
    const roundedTotalMs = Math.round(totalMs);
    if (!onSlowOperation || roundedTotalMs < SLOW_OPERATION_MILLISECONDS) return;
    const roundedRunMs = Math.min(roundedTotalMs, reportedRunMs ?? roundedTotalMs);
    onSlowOperation({
      lane: this.lane,
      operation: operation.operation,
      totalMs: roundedTotalMs,
      queueWaitMs: roundedTotalMs - roundedRunMs,
      runMs: roundedRunMs,
      queuedBehind: operation.queuedBehind,
    });
  }

  private failAll(error: unknown): void {
    for (const operation of this.pending.values()) operation.reject(error);
    this.pending.clear();
  }
}
