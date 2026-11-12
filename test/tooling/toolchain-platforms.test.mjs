import { describe, expect, it } from "vitest";
import { loadToolchainLock, validateToolchainLock } from "../../scripts/ci/install-tools.mjs";
import { buildPlatformKey, supportedPlatforms } from "../../scripts/ci/platforms.mjs";

describe("toolchain platforms", () => {
  it("names the three supported platforms for builds", () => {
    expect(supportedPlatforms()).toEqual(["darwin-arm64", "linux-x64", "linux-arm64"]);
    expect(buildPlatformKey("darwin", "arm64")).toBe("macos-arm64");
    expect(buildPlatformKey("linux", "x64")).toBe("linux-x64");
    expect(buildPlatformKey("linux", "arm64")).toBe("linux-arm64");
  });

  it("refuses other platforms instead of labelling them linux-x64", () => {
    for (const [os, arch] of [
      ["linux", "riscv64"],
      ["darwin", "x64"],
      ["win32", "x64"],
      ["to", "String"],
    ])
      expect(() => buildPlatformKey(os, arch)).toThrow("CI_PLATFORM_UNSUPPORTED");
  });

  it("pins aarch64 downloads for linux-arm64 at the same versions as linux-x64", () => {
    const lock = loadToolchainLock();
    const downloads = [
      lock.node.releases[lock.node.baseline].artifacts["linux-arm64"],
      lock.python.artifacts["linux-arm64"],
      lock.tools.actionlint.artifacts["linux-arm64"],
      lock.tools.gitleaks.artifacts["linux-arm64"],
    ];
    for (const download of downloads) expect(download.filename).toMatch(/arm64|aarch64/);
    const versions = (wheels) => wheels.map((wheel) => `${wheel.name}==${wheel.version}`);
    expect(versions(lock.tools.semgrep.wheels["linux-arm64"])).toEqual(
      versions(lock.tools.semgrep.wheels["linux-x64"]),
    );
    for (const wheel of lock.tools.semgrep.wheels["linux-arm64"])
      expect(wheel.filename).toMatch(/(?:_aarch64|-none-any)\.whl$/);
  });

  it("rejects a lock that lacks linux-arm64 downloads", () => {
    const lock = structuredClone(loadToolchainLock());
    delete lock.python.artifacts["linux-arm64"];
    expect(() => validateToolchainLock(lock)).toThrow("平台下载物");
    const wheels = structuredClone(loadToolchainLock());
    delete wheels.tools.semgrep.wheels["linux-arm64"];
    expect(() => validateToolchainLock(wheels)).toThrow("Semgrep wheels");
  });

  const swaps = {
    node: (lock) => lock.node.releases[lock.node.baseline].artifacts,
    python: (lock) => lock.python.artifacts,
    actionlint: (lock) => lock.tools.actionlint.artifacts,
    gitleaks: (lock) => lock.tools.gitleaks.artifacts,
  };
  for (const [kind, select] of Object.entries(swaps))
    it(`rejects a linux-x64 ${kind} file placed in the linux-arm64 entry`, () => {
      const lock = structuredClone(loadToolchainLock());
      select(lock)["linux-arm64"] = select(lock)["linux-x64"];
      expect(() => validateToolchainLock(lock)).toThrow(`linux-arm64 的 ${kind} 下载物文件名`);
    });

  it("rejects a tool file of another kind placed in the linux-arm64 node entry", () => {
    const lock = structuredClone(loadToolchainLock());
    swaps.node(lock)["linux-arm64"] = swaps.gitleaks(lock)["linux-arm64"];
    expect(() => validateToolchainLock(lock)).toThrow("linux-arm64 的 node 下载物文件名");
  });

  it("rejects linux-x64 or macOS wheels placed in the linux-arm64 Semgrep closure", () => {
    for (const other of ["linux-x64", "darwin-arm64"]) {
      const lock = structuredClone(loadToolchainLock());
      lock.tools.semgrep.wheels["linux-arm64"] = lock.tools.semgrep.wheels[other];
      expect(() => validateToolchainLock(lock)).toThrow("linux-arm64 的 wheel 下载物文件名");
    }
  });
});
