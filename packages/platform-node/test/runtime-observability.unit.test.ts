import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RuntimeMetricsRegistry } from "../src/runtime-observability.js";
import { writeServiceDiagnostic } from "../src/service-runtime.js";

const NOW = "2026-08-27T00:00:00.000Z";

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

describe("runtime observability", () => {
  it("covers storage, queues, Worker, Memory, model, cost and SSE without private labels", () => {
    const registry = new RuntimeMetricsRegistry({ now: () => NOW });
    registry.observeSqlite({
      databaseBytes: 10,
      walBytes: 20,
      freeBytes: 30,
      outboxPending: 2,
      backgroundJobsPending: 3,
      memoryProjectionPending: 4,
      deletionPending: 5,
      sseEventRows: 6,
    });
    registry.setGauge("worker_inflight", 1);
    registry.setGauge("sse_connections", 2);
    registry.setGauge("request_latency_ms_last", 12.5);
    registry.increment("model_calls_total", 7);
    registry.increment("model_fallback_total", 1);
    registry.increment("model_cost_micros_total", 1234);
    registry.increment("sse_backpressure_total", 2);

    expect(() => registry.authenticatedSnapshot(false)).toThrow("METRICS_AUTHENTICATION_REQUIRED");
    const snapshot = registry.authenticatedSnapshot(true);
    expect(snapshot.metrics).toEqual(
      expect.arrayContaining([
        { name: "sqlite_wal_bytes", kind: "gauge", value: 20, updatedAt: NOW },
        { name: "outbox_pending", kind: "gauge", value: 2, updatedAt: NOW },
        { name: "worker_inflight", kind: "gauge", value: 1, updatedAt: NOW },
        { name: "memory_projection_pending", kind: "gauge", value: 4, updatedAt: NOW },
        { name: "model_fallback_total", kind: "counter", value: 1, updatedAt: NOW },
        { name: "model_cost_micros_total", kind: "counter", value: 1234, updatedAt: NOW },
        { name: "sse_backpressure_total", kind: "counter", value: 2, updatedAt: NOW },
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toContain("owner");
  });

  it("redacts machine-secret literals from structured diagnostics", () => {
    const output = sink();
    writeServiceDiagnostic(output.stream, {
      component: "fixture",
      event: "adapter.failed",
      code: "FIXTURE_FAILED",
      detail: ["Authorization:", "Bearer", "secret".repeat(3)].join(" "),
    });
    expect(output.value()).toContain("[MACHINE_SECRET_REDACTED]");
    expect(output.value()).not.toContain("secret-secret-secret");
    expect(JSON.parse(output.value())).toMatchObject({
      component: "fixture",
      event: "adapter.failed",
      code: "FIXTURE_FAILED",
    });
  });
});
