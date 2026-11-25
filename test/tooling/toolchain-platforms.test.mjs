import { describe, expect, it } from "vitest";
import { loadToolchainLock, validateToolchainLock } from "../../scripts/ci/install-tools.mjs";
import {
  artifactPlatformKey,
  buildPlatformKey,
  supportedPlatforms,
} from "../../scripts/ci/platforms.mjs";

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

  it("lets macOS, linux-x64 and linux-arm64 produce or consume build artifacts", () => {
    expect(artifactPlatformKey("darwin", "arm64")).toBe("macos-arm64");
    expect(artifactPlatformKey("linux", "x64")).toBe("linux-x64");
    expect(artifactPlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(() => artifactPlatformKey("linux", "riscv64")).toThrow("CI_PLATFORM_UNSUPPORTED");
    expect(() => artifactPlatformKey("win32", "x64")).toThrow("CI_PLATFORM_UNSUPPORTED");
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

  it("rejects actionlint and gitleaks files swapped inside the same platform", () => {
    for (const platform of supportedPlatforms()) {
      const lock = structuredClone(loadToolchainLock());
      const actionlint = swaps.actionlint(lock)[platform];
      swaps.actionlint(lock)[platform] = swaps.gitleaks(lock)[platform];
      expect(() => validateToolchainLock(lock)).toThrow(`${platform} 的 actionlint 下载物文件名`);
      const other = structuredClone(loadToolchainLock());
      swaps.gitleaks(other)[platform] = actionlint;
      expect(() => validateToolchainLock(other)).toThrow(`${platform} 的 gitleaks 下载物文件名`);
    }
  });

  for (const [kind, select] of Object.entries(swaps))
    it(`rejects a linux-arm64 ${kind} file placed in the linux-x64 or macOS entry`, () => {
      for (const platform of ["linux-x64", "darwin-arm64"]) {
        const lock = structuredClone(loadToolchainLock());
        select(lock)[platform] = select(lock)["linux-arm64"];
        expect(() => validateToolchainLock(lock)).toThrow(`${platform} 的 ${kind} 下载物文件名`);
      }
    });

  it("rejects a download whose file name carries another version than the lock states", () => {
    const bump = (text) =>
      text.replace(/(\d+)\.(\d+)\.(\d+)/, (_all, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
    for (const [kind, select] of Object.entries(swaps))
      for (const platform of supportedPlatforms()) {
        const lock = structuredClone(loadToolchainLock());
        const entry = select(lock)[platform];
        const filename = bump(entry.filename);
        expect(filename).not.toBe(entry.filename);
        select(lock)[platform] = {
          ...entry,
          filename,
          url: entry.url.slice(0, entry.url.lastIndexOf("/") + 1) + filename,
        };
        expect(() => validateToolchainLock(lock)).toThrow(`${platform} 的 ${kind} 下载物文件名`);
      }
  });

  it("rejects macOS wheels of the same CPU family in the Linux Semgrep closures", () => {
    for (const [platform, suffix] of [
      ["linux-x64", "macosx_11_0_x86_64"],
      ["linux-arm64", "macosx_11_0_aarch64"],
    ]) {
      const lock = structuredClone(loadToolchainLock());
      const wheel = lock.tools.semgrep.wheels[platform].find((item) =>
        item.filename.includes("manylinux"),
      );
      const filename = wheel.filename.replace(/-[^-]+\.whl$/, `-${suffix}.whl`);
      wheel.url = wheel.url.slice(0, wheel.url.lastIndexOf("/") + 1) + filename;
      wheel.filename = filename;
      expect(() => validateToolchainLock(lock)).toThrow(`${platform} 的 wheel 下载物文件名`);
    }
  });

  it("rejects a wheel whose file name disagrees with its package name or version", () => {
    for (const platform of supportedPlatforms())
      for (const change of [
        (wheel) => ({ ...wheel, version: `${wheel.version}1` }),
        (wheel) => ({ ...wheel, name: `${wheel.name}x` }),
      ]) {
        const lock = structuredClone(loadToolchainLock());
        const wheels = lock.tools.semgrep.wheels[platform];
        const index = wheels.findIndex((item) => item.name !== "semgrep");
        wheels[index] = change(wheels[index]);
        expect(() => validateToolchainLock(lock)).toThrow("wheel 文件名和它的包名、版本对不上");
      }
  });

  it("rejects linux-arm64 wheels placed in the linux-x64 or macOS Semgrep closure", () => {
    for (const platform of ["linux-x64", "darwin-arm64"]) {
      const lock = structuredClone(loadToolchainLock());
      lock.tools.semgrep.wheels[platform] = lock.tools.semgrep.wheels["linux-arm64"];
      expect(() => validateToolchainLock(lock)).toThrow(`${platform} 的 wheel 下载物文件名`);
    }
  });

  it("rejects linux-x64 or macOS wheels placed in the linux-arm64 Semgrep closure", () => {
    for (const other of ["linux-x64", "darwin-arm64"]) {
      const lock = structuredClone(loadToolchainLock());
      lock.tools.semgrep.wheels["linux-arm64"] = lock.tools.semgrep.wheels[other];
      expect(() => validateToolchainLock(lock)).toThrow("linux-arm64 的 wheel 下载物文件名");
    }
  });
});
