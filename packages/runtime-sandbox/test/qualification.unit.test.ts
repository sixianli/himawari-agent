import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dependencies, identity } = vi.hoisted(() => ({
  dependencies: vi.fn(),
  identity: { override: undefined as Record<string, unknown> | undefined },
}));
vi.mock("@anthropic-ai/sandbox-runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  SandboxManager: { isSupportedPlatform: () => true, checkDependenciesAsync: dependencies },
}));
vi.mock("../src/srt-runtime-identity.ts", async (original) => {
  const actual = await original<typeof import("../src/srt-runtime-identity.ts")>();
  return {
    ...actual,
    readSrtRuntimeIdentity: async (...args: Parameters<typeof actual.readSrtRuntimeIdentity>) => ({
      ...(await actual.readSrtRuntimeIdentity(...args)),
      ...identity.override,
    }),
  };
});

import { inspectSrtDependencies } from "../src/qualification.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  identity.override = undefined;
});
describe("accepted Mac SRT qualification limits", () => {
  it("keeps Mac unqualified until unknown cleanup and crash reconciliation are wired", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    dependencies.mockResolvedValue({ errors: [], warnings: [] });
    const result = await inspectSrtDependencies();
    expect(result.productionSuitable).toBe(false);
    expect(result.missingGuarantees).toContain("best_effort_stop_and_unknown_quarantine");
    expect(result.missingGuarantees).toContain("worker_crash_reconciliation");
    expect(result.missingGuarantees).not.toContain("task_tree_termination");
    expect(result.limitations).toEqual(["detached_descendants_may_survive_stop"]);
  });
  it("does not relax Linux guarantees or discard dependency failures", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    dependencies.mockResolvedValue({
      errors: ["missing dependency"],
      warnings: ["configuration warning"],
    });
    const result = await inspectSrtDependencies();
    expect(result.productionSuitable).toBe(false);
    expect(result.missingGuarantees).toContain("task_tree_termination");
    expect(result.missingGuarantees).toContain("worker_crash_cleanup");
    expect(result.limitations).toEqual([]);
    expect(result.errors).toEqual(["missing dependency"]);
    expect(result.warnings).toEqual(["configuration warning"]);
  });
  it("reports the installed SRT and bubblewrap versions and no runtime error when they are locked", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
    dependencies.mockResolvedValue({ errors: [], warnings: [] });
    const result = await inspectSrtDependencies();
    expect(result.installedVersion).toBe(SANDBOX_RUNTIME_VERSION);
    expect(result.errors).toEqual([]);
    expect(result.bwrapVersion === null || /^bubblewrap /.test(result.bwrapVersion)).toBe(true);
  });
  it.each([
    [{ version: "0.0.75" }, "JOB_HOST_SRT_VERSION_MISMATCH"],
    [{ helper: null }, "JOB_HOST_SECCOMP_HELPER_UNAVAILABLE"],
  ])("puts a runtime that is not locked into the errors: %j", async (override, code) => {
    vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
    identity.override = override;
    dependencies.mockResolvedValue({ errors: ["missing dependency"], warnings: [] });
    const result = await inspectSrtDependencies();
    expect(result.errors).toEqual([code, "missing dependency"]);
  });
});
