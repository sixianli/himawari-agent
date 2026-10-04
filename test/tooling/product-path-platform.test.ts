import { describe, expect, it } from "vitest";
import { productPathToolchainPaths } from "../fixtures/product-path-harness.ts";

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
});
