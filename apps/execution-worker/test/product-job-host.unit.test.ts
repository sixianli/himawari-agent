import type { SandboxExecutionPlan } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@himawari-agent/runtime-sandbox", () => ({ prepareSandboxJobHost: prepare }));

import { createProductSandboxHostSession } from "../src/product-job-host.ts";

const plan = {
  identity: { jobId: "job", attemptId: "attempt" },
  requestedAt: "2026-09-08T00:00:00.000Z",
  effectiveDeadlineAt: "2026-09-08T00:01:00.000Z",
  resourceCeiling: {
    maxOutputBytes: 42,
    maxWallTimeMs: 1000,
    maxCpuTimeMs: 100,
    maxMemoryBytes: 1024,
  },
} as SandboxExecutionPlan;
const resolved = {
  policy: {
    workspace: "/work",
    privateDirectory: "/scratch",
    writable: true,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  },
  policyDigest: "a".repeat(64),
  executable: "/bin/echo",
  args: [],
  cleanupTimeoutMs: 1000,
};
const observation = {
  jobId: "job",
  attemptId: "attempt",
  reason: "exited",
  exitCode: 0,
  stdout: new TextEncoder().encode("synthetic"),
  stderr: new Uint8Array(),
  taskStarted: true,
  taskProcessExited: true,
  stdioClosed: true,
  srtReset: true,
  taskTreeCleanup: "unknown",
  resources: null,
};
describe("product Job Host adapter", () => {
  it("keeps original limits and preserves output references without inventing cleanup", async () => {
    const start = vi.fn();
    prepare.mockReturnValue({
      ready: Promise.resolve(),
      result: Promise.resolve(observation),
      start,
      cancel: vi.fn(),
    });
    const protect = vi.fn(async () => ({
      outputRef: "protected-output",
      outputDigest: "b".repeat(64),
    }));
    const session = createProductSandboxHostSession(plan, resolved, protect);
    expect(start).not.toHaveBeenCalled();
    session.start();
    expect(start).toHaveBeenCalledOnce();
    expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({
      jobId: "job",
      attemptId: "attempt",
      maxOutputBytes: 42,
      resourceLimits: { maxCpuTimeMs: 100, maxMemoryBytes: 1024 },
      deadlineAt: "2026-09-08T00:00:01.000Z",
    });
    expect(await session.result).toMatchObject({
      outcome: "succeeded",
      cleanup: "unknown",
      effect: "unknown",
      outputRef: "protected-output",
    });
    expect(protect).toHaveBeenCalledWith(observation);
  });
  it("retains unknown persistence and cancellation as explicit observations", async () => {
    prepare.mockReturnValue({
      ready: Promise.resolve(),
      result: Promise.resolve(observation),
      start: vi.fn(),
      cancel: vi.fn(),
    });
    const failed = createProductSandboxHostSession(plan, resolved, async () => {
      throw new Error("storage unavailable");
    });
    expect(await failed.result).toMatchObject({
      outcome: "unknown",
      outputRef: null,
      reasonCode: "SANDBOX_OUTPUT_PERSISTENCE_UNKNOWN",
    });
    prepare.mockReturnValue({
      ready: Promise.resolve(),
      result: Promise.resolve({ ...observation, reason: "cancelled", stdout: new Uint8Array() }),
      start: vi.fn(),
      cancel: vi.fn(),
    });
    const cancelled = createProductSandboxHostSession(plan, resolved, async () => {
      throw new Error("must not persist empty output");
    });
    expect(await cancelled.result).toMatchObject({
      outcome: "cancelled",
      cleanup: "unknown",
      reasonCode: "SANDBOX_CANCELLED",
    });
  });
});

it("persists resource observations even when an over-limit task produced no output", async () => {
  const result = {
    ...observation,
    reason: "resource_limit",
    stdout: new Uint8Array(),
    resources: { samples: 2, observedCpuTimeMs: 200, peakObservedMemoryBytes: 512 },
  };
  prepare.mockReturnValue({
    ready: Promise.resolve(),
    result: Promise.resolve(result),
    start: vi.fn(),
    cancel: vi.fn(),
  });
  const protect = vi.fn(async () => ({
    outputRef: "resource-observation",
    outputDigest: "b".repeat(64),
  }));
  expect(await createProductSandboxHostSession(plan, resolved, protect).result).toMatchObject({
    outcome: "failed",
    cleanup: "unknown",
    reasonCode: "SANDBOX_RESOURCE_LIMIT",
    outputRef: "resource-observation",
  });
  expect(protect).toHaveBeenCalledWith(result);
});
