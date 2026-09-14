import { afterEach, describe, expect, it, vi } from "vitest";

const { dependencies } = vi.hoisted(() => ({ dependencies: vi.fn() }));
vi.mock("@anthropic-ai/sandbox-runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  SandboxManager: { isSupportedPlatform: () => true, checkDependenciesAsync: dependencies },
}));

import { inspectSrtDependencies } from "../src/qualification.ts";

afterEach(() => vi.unstubAllGlobals());
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
});
