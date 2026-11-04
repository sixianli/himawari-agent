import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const KEPT = ["HOME", "TMPDIR", "HIMAWARI_TEST_TEMP_ROOT", "LANG"];

function keptEnvironment() {
  return Object.fromEntries(
    KEPT.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
}

function runWithoutNpx(script) {
  const scratch = mkdtempSync(path.join(tmpdir(), "check-without-npx-"));
  try {
    const bin = path.join(scratch, "bin");
    const elsewhere = path.join(scratch, "elsewhere");
    for (const directory of [bin, elsewhere]) spawnSync("mkdir", ["-p", directory]);
    symlinkSync(process.execPath, path.join(bin, "node"));
    return spawnSync(process.execPath, [path.join(root, script)], {
      cwd: elsewhere,
      env: { ...keptEnvironment(), PATH: bin },
      encoding: "utf8",
      timeout: 300000,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("checks that start vitest themselves", () => {
  it.each([
    ["scripts/check-memory-relevance.mjs", "MEMORY_RELEVANCE passed"],
    ["scripts/check-prompt-prefix.mjs", "PROMPT_PREFIX passed"],
  ])(
    "%s runs with no npx on PATH and from outside the repository root",
    (script, passed) => {
      const result = runWithoutNpx(script);
      expect(result.stderr).not.toMatch(/VITEST_NOT_STARTED|TESTS_MISSING/);
      expect(result.stdout).toContain(passed);
      expect(result.status).toBe(0);
    },
    300000,
  );
});
