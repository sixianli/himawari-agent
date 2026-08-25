import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import { createLocalExecutionWorkerProcess } from "../src/index.js";

describe("local execution-worker process", () => {
  it("starts as an independent execution.v1 boundary and reports safe diagnostics", async () => {
    const adapters = createReferenceAdapterSet();
    const worker = createLocalExecutionWorkerProcess({
      handles: adapters.capabilityRegistry,
      capability: adapters.capability,
      secrets: adapters.secret,
      clock: adapters.clock,
      ids: adapters.ids,
    });

    expect(worker.client.isReady()).toBe(false);
    const diagnostics = await worker.start();

    expect(worker.client.isReady()).toBe(true);
    expect(diagnostics).toEqual({
      component: "execution-worker",
      adapterIdentity: "local-in-process-execution-worker",
      schemaVersion: "execution.v1",
      readiness: "ready",
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|credential|token/i);

    await worker.shutdown();
    expect(worker.client.isReady()).toBe(false);
  });
});
