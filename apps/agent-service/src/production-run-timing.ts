import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { AgentRuntimePort, RuntimeEvent, RuntimeRequest } from "@himawari-agent/application";

interface SpanTotals {
  count: number;
  totalMs: number;
  maxMs: number;
  firstStartMs: number;
  lastEndMs: number;
}

interface AttemptTimings {
  readonly startedAt: number;
  readonly spans: Map<string, SpanTotals>;
}

export type RunTimingDiagnostic = Readonly<Record<string, string | number>>;

const MAXIMUM_TRACKED_RUNS = 64;

const runningAttempt = new AsyncLocalStorage<{
  readonly timings: ProductionRunTimings;
  readonly runId: string;
}>();

export function currentRunId(): string | undefined {
  return runningAttempt.getStore()?.runId;
}

export function recordInCurrentRun(name: string, durationMs: number): void {
  const attempt = runningAttempt.getStore();
  if (!attempt) return;
  attempt.timings.recordEndingNow(attempt.runId, name, durationMs);
}

export class ProductionRunTimings {
  readonly #attempts = new Map<string, AttemptTimings>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  async attempt<T>(
    runId: string,
    kind: string,
    work: () => Promise<T>,
    report: (diagnostic: RunTimingDiagnostic) => void,
  ): Promise<T> {
    const timings: AttemptTimings = { startedAt: this.#now(), spans: new Map() };
    this.#attempts.delete(runId);
    this.#attempts.set(runId, timings);
    if (this.#attempts.size > MAXIMUM_TRACKED_RUNS) {
      const oldest = this.#attempts.keys().next().value;
      if (oldest !== undefined) this.#attempts.delete(oldest);
    }
    let outcome = "failed";
    try {
      const result = await runningAttempt.run({ timings: this, runId }, work);
      outcome = "returned";
      return result;
    } finally {
      if (this.#attempts.get(runId) === timings) this.#attempts.delete(runId);
      const diagnostic: Record<string, string | number> = {
        runId,
        attempt: kind,
        outcome,
        totalMs: Math.round(this.#now() - timings.startedAt),
      };
      for (const [name, span] of [...timings.spans].sort(
        ([, left], [, right]) => left.firstStartMs - right.firstStartMs,
      )) {
        diagnostic[`${name}.n`] = span.count;
        diagnostic[`${name}.ms`] = Math.round(span.totalMs);
        diagnostic[`${name}.max`] = Math.round(span.maxMs);
        diagnostic[`${name}.at`] = Math.round(span.firstStartMs);
        diagnostic[`${name}.end`] = Math.round(span.lastEndMs);
      }
      report(diagnostic);
    }
  }

  async measure<T>(runId: string | undefined, name: string, work: () => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    try {
      return await work();
    } finally {
      this.record(runId, name, startedAt, this.#now());
    }
  }

  recordEndingNow(runId: string, name: string, durationMs: number): void {
    const endedAt = this.#now();
    this.record(runId, name, endedAt - durationMs, endedAt);
  }

  record(runId: string | undefined, name: string, startedAt: number, endedAt: number): void {
    const timings = runId === undefined ? undefined : this.#attempts.get(runId);
    if (!timings) return;
    const durationMs = Math.max(0, endedAt - startedAt);
    const span = timings.spans.get(name);
    if (!span) {
      timings.spans.set(name, {
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
        firstStartMs: startedAt - timings.startedAt,
        lastEndMs: endedAt - timings.startedAt,
      });
      return;
    }
    span.count += 1;
    span.totalMs += durationMs;
    span.maxMs = Math.max(span.maxMs, durationMs);
    span.lastEndMs = Math.max(span.lastEndMs, endedAt - timings.startedAt);
  }

  methods<T extends object>(
    target: T,
    names: Readonly<Partial<Record<keyof T & string, string>>>,
    runIdOf: (args: readonly unknown[]) => string | undefined = (args) => runIdField(args[0]),
  ): T {
    return new Proxy(Object.create(Object.getPrototypeOf(target)) as T, {
      has: (_shell, property) => property in target,
      get: (_shell, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        const label =
          typeof property === "string" ? names[property as keyof T & string] : undefined;
        if (label === undefined) return value.bind(target);
        return (...args: unknown[]) =>
          this.measure(runIdOf(args), label, () => Promise.resolve(value.apply(target, args)));
      },
    });
  }

  runtime(runtime: AgentRuntimePort, prefix: string): AgentRuntimePort {
    const timings = this;
    return {
      cancel: (runId) => runtime.cancel(runId),
      async *run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
        const iterator = runtime.run(request)[Symbol.asyncIterator]();
        let label = `${prefix}.first_event`;
        try {
          for (;;) {
            const waitStartedAt = timings.#now();
            const next = await iterator.next();
            timings.record(request.runId, label, waitStartedAt, timings.#now());
            label = `${prefix}.next_event`;
            if (next.done) return;
            const handedAt = timings.#now();
            yield next.value;
            timings.record(request.runId, `${prefix}.consumer`, handedAt, timings.#now());
          }
        } finally {
          await iterator.return?.();
        }
      },
    };
  }
}

function runIdField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const runId = (value as { readonly runId?: unknown }).runId;
  return typeof runId === "string" ? runId : undefined;
}
