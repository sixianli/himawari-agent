export const RUNTIME_METRIC_NAMES = Object.freeze([
  "sqlite_database_bytes",
  "sqlite_wal_bytes",
  "storage_free_bytes",
  "outbox_pending",
  "background_jobs_pending",
  "worker_inflight",
  "memory_projection_pending",
  "deletion_pending",
  "model_calls_total",
  "model_fallback_total",
  "model_cost_micros_total",
  "sse_retained_events",
  "sse_connections",
  "sse_backpressure_total",
  "request_latency_ms_last",
] as const);

export type RuntimeMetricName = (typeof RUNTIME_METRIC_NAMES)[number];

const COUNTERS = new Set<RuntimeMetricName>([
  "model_calls_total",
  "model_fallback_total",
  "model_cost_micros_total",
  "sse_backpressure_total",
]);

export interface RuntimeMetricPoint {
  readonly name: RuntimeMetricName;
  readonly kind: "gauge" | "counter";
  readonly value: number;
  readonly updatedAt: string;
}

export interface RuntimeMetricsSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly metrics: readonly RuntimeMetricPoint[];
}

export interface SqliteMetricsObservation {
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly freeBytes: number;
  readonly outboxPending: number;
  readonly backgroundJobsPending: number;
  readonly memoryProjectionPending: number;
  readonly deletionPending: number;
  readonly sseEventRows: number;
}

function validValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Metric value must be finite");
  return value;
}

export class RuntimeMetricsRegistry {
  readonly #points = new Map<RuntimeMetricName, RuntimeMetricPoint>();
  readonly #now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    for (const name of RUNTIME_METRIC_NAMES) {
      this.#points.set(
        name,
        Object.freeze({
          name,
          kind: COUNTERS.has(name) ? "counter" : "gauge",
          value: 0,
          updatedAt: this.#now(),
        }),
      );
    }
  }

  setGauge(name: RuntimeMetricName, value: number): void {
    if (COUNTERS.has(name)) throw new TypeError(`${name} is a counter`);
    this.#set(name, validValue(value));
  }

  increment(name: RuntimeMetricName, delta = 1): void {
    if (!COUNTERS.has(name)) throw new TypeError(`${name} is a gauge`);
    const current = this.#points.get(name);
    if (!current) throw new TypeError(`Unknown metric ${name}`);
    this.#set(name, current.value + validValue(delta));
  }

  observeSqlite(status: SqliteMetricsObservation): void {
    this.setGauge("sqlite_database_bytes", status.databaseBytes);
    this.setGauge("sqlite_wal_bytes", status.walBytes);
    this.setGauge("storage_free_bytes", status.freeBytes);
    this.setGauge("outbox_pending", status.outboxPending);
    this.setGauge("background_jobs_pending", status.backgroundJobsPending);
    this.setGauge("memory_projection_pending", status.memoryProjectionPending);
    this.setGauge("deletion_pending", status.deletionPending);
    this.setGauge("sse_retained_events", status.sseEventRows);
  }

  authenticatedSnapshot(authenticated: boolean): RuntimeMetricsSnapshot {
    if (!authenticated) throw new Error("METRICS_AUTHENTICATION_REQUIRED");
    return Object.freeze({
      schemaVersion: 1,
      generatedAt: this.#now(),
      metrics: Object.freeze(
        RUNTIME_METRIC_NAMES.map((name) =>
          Object.freeze({ ...(this.#points.get(name) as RuntimeMetricPoint) }),
        ),
      ),
    });
  }

  #set(name: RuntimeMetricName, value: number): void {
    const current = this.#points.get(name);
    if (!current) throw new TypeError(`Unknown metric ${name}`);
    this.#points.set(name, Object.freeze({ ...current, value, updatedAt: this.#now() }));
  }
}
