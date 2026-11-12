import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  comparePlatformAssumptions,
  scanPlatformAssumptions,
} from "../../scripts/check-platform-assumptions.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "platform-assumptions-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const sealWithLib64 = 'const roots = ["/usr/lib", "/lib64"].map((p) => realpath(p));\n';

describe("platform assumption inventory", () => {
  it("counts the x86-only directory and platform names that broke linux-arm64", () => {
    const root = fixture({
      "scripts/seal.mjs": sealWithLib64,
      "scripts/ci/build.mjs":
        'const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";\n',
      "scripts/install.mjs": 'if (process.arch === "x64") run();\n',
      "scripts/download.py": "url = 'fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz'\n",
      "scripts/make.py": "PYTHON = 'python-3.12.10.tar.gz'\n",
      "packages/a/src/paths.ts": 'export const lib = "/usr/lib64x";\n',
    });
    expect(scanPlatformAssumptions(root)).toEqual({
      lib64: { "scripts/seal.mjs": 1 },
      "linux-x64": { "scripts/ci/build.mjs": 1 },
      "arch-x64": { "scripts/install.mjs": 1 },
      x86_64: { "scripts/download.py": 1 },
      "python-3.12.10-archive": { "scripts/make.py": 1 },
    });
  });

  it("passes when the inventory matches the scan", () => {
    const root = fixture({ "scripts/seal.mjs": sealWithLib64 });
    const observed = scanPlatformAssumptions(root);
    expect(comparePlatformAssumptions(observed, observed)).toEqual([]);
  });

  it("fails when a new file hard-codes /lib64", () => {
    const root = fixture({
      "scripts/seal.mjs": sealWithLib64,
      "packages/a/scripts/probe-new.mjs": sealWithLib64,
    });
    const recorded = { lib64: { "scripts/seal.mjs": 1 } };
    expect(comparePlatformAssumptions(recorded, scanPlatformAssumptions(root))).toEqual([
      {
        kind: "added",
        name: "lib64",
        file: "packages/a/scripts/probe-new.mjs",
        expected: 0,
        actual: 1,
      },
    ]);
  });

  it("fails when a listed file gains another occurrence", () => {
    const root = fixture({ "scripts/seal.mjs": sealWithLib64 + sealWithLib64 });
    const recorded = { lib64: { "scripts/seal.mjs": 1 } };
    expect(comparePlatformAssumptions(recorded, scanPlatformAssumptions(root))).toEqual([
      { kind: "added", name: "lib64", file: "scripts/seal.mjs", expected: 1, actual: 2 },
    ]);
  });

  it("fails when the inventory still lists an occurrence that is gone", () => {
    const root = fixture({ "scripts/seal.mjs": 'const roots = ["/usr/lib"];\n' });
    const recorded = { lib64: { "scripts/seal.mjs": 1 } };
    expect(comparePlatformAssumptions(recorded, scanPlatformAssumptions(root))).toEqual([
      { kind: "stale", name: "lib64", file: "scripts/seal.mjs", expected: 1, actual: 0 },
    ]);
  });

  it("fails when the inventory names a kind the check does not scan", () => {
    expect(comparePlatformAssumptions({ riscv: { "a.mjs": 1 } }, {})).toEqual([
      { kind: "unknown", name: "riscv", file: "", expected: 0, actual: 0 },
    ]);
  });
});
