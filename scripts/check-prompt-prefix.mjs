import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const TAG = "[I-66]";
const FILES = ["packages/runtime-pi/test/prompt-prefix.compat.test.ts"];
const REQUIRED = 8;

const directory = mkdtempSync(path.join(tmpdir(), "himawari-prompt-prefix-"));
const report = path.join(directory, "report.json");
try {
  const run = spawnSync(
    process.execPath,
    [
      path.join("node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "pi-compat",
      ...FILES,
      "-t",
      "\\[I-66\\]",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (run.error) console.error(`PROMPT_PREFIX_VITEST_NOT_STARTED ${run.error.message}`);
  const results = existsSync(report)
    ? JSON.parse(readFileSync(report, "utf8"))
    : { testResults: [] };
  const tagged = results.testResults.flatMap((file) =>
    file.assertionResults.filter((test) => test.fullName.includes(TAG)),
  );
  const passed = tagged.filter((test) => test.status === "passed");
  const failed = tagged.filter((test) => test.status === "failed");
  for (const test of failed) console.error(`PROMPT_PREFIX_FAILED ${test.fullName}`);
  if (passed.length < REQUIRED)
    console.error(
      `PROMPT_PREFIX_TESTS_MISSING 需要至少 ${REQUIRED} 条 ${TAG} 测试通过，实际 ${passed.length} 条`,
    );
  const ok = run.status === 0 && failed.length === 0 && passed.length >= REQUIRED;
  console.log(`PROMPT_PREFIX ${ok ? "passed" : "failed"} (${passed.length} 条通过)`);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
