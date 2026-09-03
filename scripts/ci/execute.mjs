import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactText } from "./security-redaction.mjs";

export async function execute(command, args, { cwd, env, log, timeoutMs = 900_000 }) {
  const started = performance.now();
  const chunks = [];
  let bytes = 0;
  let termination;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const stop = (reason) => {
    termination = reason;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") chunks.push(Buffer.from(`Process termination: ${error.code}\n`));
    }
  };
  const collect = (chunk) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) stop("output_limit");
    else chunks.push(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: 127, error: error.code }));
    child.once("close", (code, signal) => resolve({ exitCode: code ?? 128, signal }));
  });
  clearTimeout(timer);
  const result = {
    ...outcome,
    ...(termination ? { termination } : {}),
    durationMs: Math.round(performance.now() - started),
  };
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(
    log,
    `${redactText(Buffer.concat(chunks).toString("utf8"))}\n${JSON.stringify(result)}\n`,
    { flag: "wx" },
  );
  return result;
}

export function vitestCounts(report) {
  if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0)
    throw new Error("CI_TEST_REPORT_EMPTY");
  const counts = {
    files: report.testResults.length,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const file of report.testResults) {
    if (!Array.isArray(file.assertionResults) || file.assertionResults.length === 0)
      throw new Error("CI_TEST_FILE_EMPTY");
    for (const test of file.assertionResults) {
      if (test.status === "passed") counts.passed += 1;
      else if (test.status === "failed") counts.failed += 1;
      else counts.skipped += 1;
    }
  }
  counts.executed = counts.passed + counts.failed;
  if (counts.executed === 0) throw new Error("CI_TEST_PROJECT_EMPTY");
  if (report.success !== (counts.failed === 0 && counts.skipped === 0))
    throw new Error("CI_TEST_REPORT_CONTRADICTION");
  return counts;
}

export function sumCounts(projects) {
  return projects.reduce(
    (sum, { counts }) =>
      Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + counts[key]])),
    { files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 },
  );
}
