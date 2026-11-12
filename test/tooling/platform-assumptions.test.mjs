import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  comparePlatformAssumptions,
  INVENTORY_PATH,
  runPlatformAssumptionsCheck,
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
      "packages/a/src/join.ts": 'export const lib = path.join("/", "lib64");\n',
      "scripts/ci/policy.mjs": 'const member = { os: "linux", arch: "x64" };\n',
      "scripts/tools.json": '{ "filename": "actionlint_linux_amd64.tar.gz", "cpu": "X86_64" }\n',
      "scripts/probe.mjs":
        'assert.equal(hostname(), "hermes-home");\nassert.equal(hostname(), "__PKT_HOSTNAME__");\nassert.equal(hostname(), receipt.host);\nassert.equal(receipt.host, hostname(), "__PKT_LABEL_UPPER___HOST_CHANGED");\nconst who = { host: hostname(), "actor": 1 };\n',
      "scripts/probe.py": "assert socket.gethostname()=='hermes-home'\n",
      ".github/workflows/ci.yml": "      - key: linux-x64\n",
    });
    expect(scanPlatformAssumptions(root)).toEqual({
      lib64: { "packages/a/src/join.ts": 1, "scripts/seal.mjs": 1 },
      "linux-x64": { ".github/workflows/ci.yml": 1, "scripts/ci/build.mjs": 1 },
      "arch-x64": { "scripts/ci/policy.mjs": 1, "scripts/install.mjs": 1 },
      x86_64: { "scripts/download.py": 1, "scripts/tools.json": 1 },
      amd64: { "scripts/tools.json": 1 },
      "fixed-hostname": { "scripts/probe.mjs": 1, "scripts/probe.py": 1 },
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

  function run(root, write = false) {
    const out = [];
    const err = [];
    const code = runPlatformAssumptionsCheck({
      root,
      write,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { code, out, err };
  }

  it("exits 1 and names the file when the tree has an occurrence the inventory lacks", () => {
    const root = fixture({
      "scripts/seal.mjs": sealWithLib64,
      [INVENTORY_PATH]: "{}\n",
    });
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/^PLATFORM_ASSUMPTION_ADDED lib64 scripts\/seal\.mjs /);
  });

  it("exits 1 when the inventory is missing or is not JSON", () => {
    const missing = run(fixture({ "scripts/seal.mjs": sealWithLib64 }));
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual([`PLATFORM_ASSUMPTIONS_INVENTORY_MISSING ${INVENTORY_PATH}`]);
    const invalid = run(fixture({ [INVENTORY_PATH]: "{" }));
    expect(invalid.code).toBe(1);
    expect(invalid.err[0]).toMatch(/^PLATFORM_ASSUMPTIONS_INVENTORY_INVALID /);
  });

  it("--write lists what changed, writes the same bytes each time, and the check then passes", () => {
    const root = fixture({
      "scripts/seal.mjs": sealWithLib64,
      [INVENTORY_PATH]: '{ "lib64": { "scripts/gone.mjs": 2 } }\n',
    });
    const first = run(root, true);
    expect(first.code).toBe(0);
    expect(first.out).toEqual([
      "PLATFORM_ASSUMPTIONS_CHANGED stale lib64 scripts/gone.mjs 2 -> 0",
      "PLATFORM_ASSUMPTIONS_CHANGED added lib64 scripts/seal.mjs 0 -> 1",
      `PLATFORM_ASSUMPTIONS written ${INVENTORY_PATH}`,
    ]);
    const bytes = readFileSync(join(root, INVENTORY_PATH), "utf8");
    const second = run(root, true);
    expect(second.out).toEqual([`PLATFORM_ASSUMPTIONS written ${INVENTORY_PATH}`]);
    expect(readFileSync(join(root, INVENTORY_PATH), "utf8")).toBe(bytes);
    const check = run(root);
    expect(check.code).toBe(0);
    expect(check.out).toEqual(["PLATFORM_ASSUMPTIONS passed kinds=7 occurrences=1"]);
  });
});
