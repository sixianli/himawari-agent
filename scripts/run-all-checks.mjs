import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FAILED_OUTPUT_BUDGET = 100;
export const STEP_TAIL_BYTES = 64 * 1024;

export function stepNames(stepsCommand) {
  return stepsCommand.split(" && ").map((step) => {
    const match = /^npm run (\S+)$/.exec(step.trim());
    if (!match) throw new Error(`CHECK_STEP_NOT_AN_NPM_SCRIPT: ${step}`);
    return match[1];
  });
}

export function lastLines(text, count) {
  if (count <= 0) return [];
  const trimmed = text.replace(/\n+$/u, "");
  return trimmed === "" ? [] : trimmed.split("\n").slice(-count);
}

export async function runAllChecks(names, run, log = console.log) {
  const failures = [];
  for (const name of names) {
    const result = await run(name);
    const { status, output = "" } = typeof result === "number" ? { status: result } : result;
    if (status !== 0) failures.push({ name, status, output });
  }
  if (failures.length === 0) {
    log(`CHECK_ALL_PASSED ${names.length} steps`);
    return 0;
  }
  for (const { name, status } of failures) log(`CHECK_FAILED ${name} exit=${status}`);
  log(`CHECK_SUMMARY ${failures.length} of ${names.length} steps failed`);
  const share = Math.floor((FAILED_OUTPUT_BUDGET - failures.length) / failures.length);
  if (share < 1) return 1;
  for (const { name, output } of failures) {
    const tail = lastLines(output, share);
    if (tail.length === 0) continue;
    log(`CHECK_FAILED_OUTPUT ${name} last ${tail.length} lines`);
    for (const line of tail) log(line);
  }
  return 1;
}

export function runStep(
  command,
  args,
  { cwd, write = (chunk) => process.stdout.write(chunk) } = {},
) {
  return new Promise((resolve) => {
    let tail = "";
    const keep = (chunk) => {
      const text = chunk.toString("utf8");
      write(text);
      tail = (tail + text).slice(-STEP_TAIL_BYTES);
    };
    const child = spawn(command, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => resolve({ status: 1, output: `${tail}${error.message}\n` }));
    child.on("close", (code) => resolve({ status: code ?? 1, output: tail }));
  });
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const names = stepNames(manifest.scripts["check:steps"]);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runAllChecks(names, (name) => runStep(npm, ["run", name], { cwd: root }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
