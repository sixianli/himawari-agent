import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TAG = "[iOS-7]";
const FILES = [
  "test/integration/proactive-sources.test.ts",
  "test/integration/proactive-production.test.ts",
  "packages/persistence-sqlite/test/proactive-source-registry-migration.contract.test.ts",
];
const REQUIRED_NAMES = [
  "registers Gmail alone",
  "refuses a source without a trust mark",
  "a newly registered source hands each new item to the inbox and records it",
  "spam and the owner's own mail are recorded as skipped and never reach her",
  "a mail the inbox refuses is not marked done and is handed again on the next check",
  "the database refuses a source name that is not registered",
  "each source has its own switch and caps",
  "a source written by another program delivers one entry at once and one at its set time",
  "a program entry is not recorded twice",
  "two writers racing on one entry",
  "a cap change whose decision record cannot be written changes nothing",
  "clearing the records of one source, or disconnecting it, leaves the other source alone",
  "survive export and import",
  "a source switched off is not checked",
  "will not start with a registered reader source that nobody reads",
  "refuses caps outside the registered range",
  "keeps every row of every rebuilt table",
  "changes nothing in the rebuilt tables except the source name constraints",
  "keeps the triggers that protect prereviews and signals",
  "keeps every decision kind and outcome the ledger accepted before",
  "accepts another well-formed source name and still refuses a malformed one",
  "calibration reads the registered Gmail source name",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(tmpdir(), "himawari-proactive-sources-check-"));
const report = path.join(directory, "report.json");
try {
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.workspace.ts",
      ...FILES,
      "-t",
      "\\[iOS-7\\]",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (run.error) console.error(`PROACTIVE_SOURCES_VITEST_NOT_STARTED ${run.error.message}`);
  const results = existsSync(report)
    ? JSON.parse(readFileSync(report, "utf8"))
    : { testResults: [] };
  const tagged = results.testResults.flatMap((file) =>
    file.assertionResults.filter((test) => test.fullName.includes(TAG)),
  );
  const passed = tagged.filter((test) => test.status === "passed");
  const failed = tagged.filter((test) => test.status === "failed");
  for (const test of failed) console.error(`PROACTIVE_SOURCES_FAILED ${test.fullName}`);
  const missingNames = REQUIRED_NAMES.filter(
    (name) => !passed.some((test) => test.fullName.includes(name)),
  );
  for (const name of missingNames)
    console.error(`PROACTIVE_SOURCES_TESTS_MISSING 没有通过的测试：${name}`);
  const ok = run.status === 0 && failed.length === 0 && missingNames.length === 0;
  console.log(`PROACTIVE_SOURCES ${ok ? "passed" : "failed"} (${passed.length} 条通过)`);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
