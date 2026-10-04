import { sandboxRuntimeQualificationSchema } from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import {
  productPathSandboxCleanup,
  productPathToolchainPaths,
} from "../fixtures/product-path-harness.ts";

const runtimeRoot = "/test-runtime";
const executable = "/test-node";

describe("product path platform toolchain", () => {
  it("uses the Linux deployment toolchain without macOS system paths", () => {
    expect(productPathToolchainPaths({ platform: "linux", runtimeRoot, executable })).toEqual([
      runtimeRoot,
      executable,
      "/bin",
      "/usr/bin",
      "/usr/lib",
      "/lib",
      "/lib64",
      "/proc",
      "/etc/ssl",
      "/etc/hosts",
      "/dev",
    ]);
  });

  it("preserves the original macOS toolchain paths", () => {
    expect(productPathToolchainPaths({ platform: "darwin", runtimeRoot, executable })).toEqual([
      runtimeRoot,
      executable,
      "/bin",
      "/usr/bin",
      "/usr/lib",
      "/System",
      "/dev",
    ]);
  });

  it.each(["darwin", "linux"] as const)(
    "generates %s cleanup declarations accepted by the strict sandbox contract",
    (platform) => {
      const cleanup = productPathSandboxCleanup(platform);
      expect(cleanup).toEqual({
        terminationMode: platform === "darwin" ? "best_effort" : "verified_tree",
        terminationEnforced: platform === "linux",
        guarantees: [
          "filesystem_default_deny",
          "network_allowlist",
          "clean_environment",
          "bounded_output",
          "wall_clock_stop",
          "resource_observation",
          "durable_start_admission",
          "unknown_quarantine",
          "restart_reconciliation",
          ...(platform === "darwin"
            ? ["best_effort_stop"]
            : ["task_tree_termination", "worker_crash_cleanup"]),
        ],
        limitations: platform === "darwin" ? ["detached_descendants_may_survive_stop"] : [],
      });
      expect(
        sandboxRuntimeQualificationSchema.parse({
          schemaVersion: "sandbox-runtime-qualification.v1",
          qualificationRef: "product-path:test",
          hostId: "product-path-host",
          profileRef: "authorized-project.v1",
          srtVersion: "0.0.75",
          platform,
          architecture: "x64",
          osRelease: "test-release",
          runtimeDigest: "a".repeat(64),
          runnerDigest: "b".repeat(64),
          evidenceDigest: "c".repeat(64),
          resourceMode: "observe_and_stop",
          terminationMode: cleanup.terminationMode,
          guarantees: cleanup.guarantees,
          limitations: cleanup.limitations,
        }),
      ).toMatchObject({ platform, terminationMode: cleanup.terminationMode });
    },
  );
});
