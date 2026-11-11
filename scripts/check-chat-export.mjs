import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TAG = "[多人7]";
const FILES = [
  "test/integration/chat-export.test.ts",
  "test/integration/chat-export-http.test.ts",
  "test/integration/data-cli.test.ts",
];
const REQUIRED = 34;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(tmpdir(), "himawari-chat-export-"));
const report = path.join(directory, "report.json");
try {
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "integration",
      ...FILES,
      "-t",
      "\\[多人7\\]",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (run.error) console.error(`CHAT_EXPORT_VITEST_NOT_STARTED ${run.error.message}`);
  const results = existsSync(report)
    ? JSON.parse(readFileSync(report, "utf8"))
    : { testResults: [] };
  const tagged = results.testResults.flatMap((file) =>
    file.assertionResults.filter((test) => test.fullName.includes(TAG)),
  );
  const passed = tagged.filter((test) => test.status === "passed");
  const failed = tagged.filter((test) => test.status === "failed");
  for (const test of failed) console.error(`CHAT_EXPORT_FAILED ${test.fullName}`);
  if (passed.length < REQUIRED)
    console.error(
      `CHAT_EXPORT_TESTS_MISSING 需要至少 ${REQUIRED} 条 ${TAG} 测试通过，实际 ${passed.length} 条`,
    );
  const ok = run.status === 0 && failed.length === 0 && passed.length >= REQUIRED;
  console.log(`CHAT_EXPORT ${ok ? "passed" : "failed"} (${passed.length} 条通过)`);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
