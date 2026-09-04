import type {
  ProductionRunDispatchDrainResult,
  ProductionRunDispatcher,
} from "./production-run-dispatcher.js";

export const PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "PRODUCTION_RUN_DISPATCH_LOOP_CONFIGURATION_INVALID",
  STATE_CONFLICT: "PRODUCTION_RUN_DISPATCH_LOOP_STATE_CONFLICT",
} as const);

export type ProductionRunDispatchLoopErrorCode =
  (typeof PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES)[keyof typeof PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES];

export class ProductionRunDispatchLoopError extends Error {
  readonly code: ProductionRunDispatchLoopErrorCode;

  constructor(code: ProductionRunDispatchLoopErrorCode, message: string) {
    super(message);
    this.name = "ProductionRunDispatchLoopError";
    this.code = code;
  }
}

export type ProductionRunDispatchLoopFailurePhase = "startup" | "wakeup" | "interval" | "drain";

export interface ProductionRunDispatchLoopFailure {
  readonly phase: ProductionRunDispatchLoopFailurePhase;
  readonly error: unknown;
}

export type ProductionRunDispatchLoopState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface ProductionRunDispatchLoopOptions {
  readonly dispatcher: Pick<ProductionRunDispatcher, "pump" | "drain">;
  /** The bounded fallback scan interval. It is always unref'ed. */
  readonly fallbackScanIntervalMs: number;
  /** Called once for the first pump or drain failure. It must not restart the loop. */
  readonly onFailure?: (failure: ProductionRunDispatchLoopFailure) => void;
}

type LoopDispatcher = ProductionRunDispatchLoopOptions["dispatcher"];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolvePromise === undefined) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise(value);
    },
    reject(reason?: unknown) {
      if (rejectPromise === undefined) throw new Error("DEFERRED_NOT_INITIALIZED");
      rejectPromise(reason);
    },
  };
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProductionRunDispatchLoopError(
      PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES.CONFIGURATION_INVALID,
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

function fallbackInterval(value: number): number {
  positiveSafeInteger(value, "fallbackScanIntervalMs");
  if (value > 2_147_483_647) {
    throw new ProductionRunDispatchLoopError(
      PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES.CONFIGURATION_INVALID,
      "fallbackScanIntervalMs exceeds the supported timer bound",
    );
  }
  return value;
}

export class ProductionRunDispatchLoop {
  readonly #dispatcher: LoopDispatcher;
  readonly #fallbackScanIntervalMs: number;
  readonly #onFailure: ProductionRunDispatchLoopOptions["onFailure"];
  #state: ProductionRunDispatchLoopState = "stopped";
  #failure: ProductionRunDispatchLoopFailure | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #activePump: Promise<void> | undefined;
  #pendingWake = false;
  #pendingPhase: ProductionRunDispatchLoopFailurePhase | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<ProductionRunDispatchDrainResult> | undefined;
  #lastDrainResult: ProductionRunDispatchDrainResult | undefined;

  constructor(options: ProductionRunDispatchLoopOptions) {
    this.#dispatcher = options.dispatcher;
    this.#fallbackScanIntervalMs = fallbackInterval(options.fallbackScanIntervalMs);
    this.#onFailure = options.onFailure;
  }

  get state(): ProductionRunDispatchLoopState {
    return this.#state;
  }

  get failure(): ProductionRunDispatchLoopFailure | undefined {
    return this.#failure;
  }

  /**
   * Claims no work until the initial recovery scan has completed. A wakeup
   * arriving during that scan is retained as one coalesced follow-up scan.
   */
  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#state === "starting") {
      if (this.#startPromise === undefined) {
        throw new ProductionRunDispatchLoopError(
          PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES.STATE_CONFLICT,
          "Dispatch loop is starting without a startup operation",
        );
      }
      return this.#startPromise;
    }
    if (this.#state !== "stopped" || this.#lastDrainResult !== undefined) {
      throw new ProductionRunDispatchLoopError(
        PRODUCTION_RUN_DISPATCH_LOOP_ERROR_CODES.STATE_CONFLICT,
        `Dispatch loop cannot start from ${this.#state}`,
      );
    }

    this.#accepting = true;
    this.#state = "starting";
    const initialPump = this.#schedulePump("startup");
    const startup = initialPump.then(() => {
      if (this.#state === "starting") {
        this.#state = "running";
        this.#startTimer();
      }
    });
    this.#startPromise = startup;
    void startup.then(
      () => {
        if (this.#startPromise === startup) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === startup) this.#startPromise = undefined;
      },
    );
    return startup;
  }

  /**
   * Requests one scan. Concurrent requests collapse into one follow-up scan;
   * a request is rejected after stop, failure, or before start.
   */
  wakeup(): boolean {
    return this.#requestWakeup("wakeup");
  }

  stop(timeoutMs: number): Promise<ProductionRunDispatchDrainResult> {
    positiveSafeInteger(timeoutMs, "timeoutMs");
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    if (this.#lastDrainResult !== undefined) return Promise.resolve(this.#lastDrainResult);

    this.#accepting = false;
    this.#stopTimer();
    if (this.#state !== "failed") this.#state = "stopping";

    const stopping = this.#stopInternal(timeoutMs);
    this.#stopPromise = stopping;
    void stopping.then(
      () => {
        if (this.#stopPromise === stopping) this.#stopPromise = undefined;
      },
      () => {
        if (this.#stopPromise === stopping) this.#stopPromise = undefined;
      },
    );
    return stopping;
  }

  drain(timeoutMs: number): Promise<ProductionRunDispatchDrainResult> {
    return this.stop(timeoutMs);
  }

  #accepting = false;

  #requestWakeup(
    phase: Exclude<ProductionRunDispatchLoopFailurePhase, "startup" | "drain">,
  ): boolean {
    if (!this.#accepting || (this.#state !== "starting" && this.#state !== "running")) {
      return false;
    }
    this.#schedulePump(phase);
    return true;
  }

  #schedulePump(
    phase: ProductionRunDispatchLoopFailurePhase,
    allowStopping = false,
  ): Promise<void> {
    if (!allowStopping && this.#state !== "starting" && this.#state !== "running") {
      return Promise.resolve();
    }
    const active = this.#activePump;
    if (active !== undefined) {
      this.#pendingWake = true;
      this.#pendingPhase ??= phase;
      return active;
    }

    // Install the active promise before invoking the dispatcher. This keeps
    // re-entrant wakeups single-flight even when a test or adapter calls back
    // synchronously from pump().
    const completion = deferred<void>();
    const operation = completion.promise;
    this.#activePump = operation;
    try {
      const pump = Promise.resolve(this.#dispatcher.pump());
      void pump.then(
        () => completion.resolve(undefined),
        (error: unknown) => {
          this.#failClosed({ phase, error });
          completion.reject(error);
        },
      );
    } catch (error) {
      this.#failClosed({ phase, error });
      completion.reject(error);
    }
    void operation.then(
      () => this.#finishPump(operation),
      () => this.#finishPump(operation),
    );
    return operation;
  }

  #finishPump(operation: Promise<void>): void {
    if (this.#activePump !== operation) return;
    this.#activePump = undefined;
    if (!this.#pendingWake) return;

    const phase = this.#pendingPhase ?? "wakeup";
    this.#pendingWake = false;
    this.#pendingPhase = undefined;
    if (this.#state === "starting" || this.#state === "running" || this.#state === "stopping") {
      // A wake accepted before stop is drained as a no-op by the underlying
      // dispatcher after it has rejected further claims.
      this.#schedulePump(phase, this.#state === "stopping");
    }
  }

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    const timer = setInterval(() => {
      this.#requestWakeup("interval");
    }, this.#fallbackScanIntervalMs);
    timer.unref?.();
    this.#timer = timer;
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #failClosed(failure: ProductionRunDispatchLoopFailure): void {
    if (this.#failure !== undefined) return;
    this.#failure = Object.freeze(failure);
    this.#accepting = false;
    this.#pendingWake = false;
    this.#pendingPhase = undefined;
    this.#stopTimer();
    this.#state = "failed";
    try {
      this.#onFailure?.(this.#failure);
    } catch {
      // A diagnostic callback cannot reopen a failed dispatch loop or replace
      // the original failure exposed through the stable state property.
    }
  }

  async #stopInternal(timeoutMs: number): Promise<ProductionRunDispatchDrainResult> {
    let result: ProductionRunDispatchDrainResult;
    try {
      result = await this.#dispatcher.drain(timeoutMs);
    } catch (error) {
      this.#failClosed({ phase: "drain", error });
      throw error;
    }
    if (!result.drained) return result;

    await this.#waitForPumpQueue();
    if (this.#state === "stopping") this.#state = "stopped";
    this.#lastDrainResult = Object.freeze({ ...result });
    return this.#lastDrainResult;
  }

  async #waitForPumpQueue(): Promise<void> {
    while (this.#activePump !== undefined || this.#pendingWake) {
      const active = this.#activePump;
      if (active !== undefined) {
        await active.catch(() => undefined);
      } else {
        await Promise.resolve();
      }
    }
  }
}

export function createProductionRunDispatchLoop(
  options: ProductionRunDispatchLoopOptions,
): ProductionRunDispatchLoop {
  return new ProductionRunDispatchLoop(options);
}
