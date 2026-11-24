import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function stepNames(stepsCommand) {
  return stepsCommand.split(" && ").map((step) => {
    const match = /^npm run (\S+)$/.exec(step.trim());
    if (!match) throw new Error(`CHECK_STEP_NOT_AN_NPM_SCRIPT: ${step}`);
    return match[1];
  });
}

const FAILED_OUTPUT_LINES = 80;

export function runAllChecks(names, run, log = console.log) {
  const failures = [];
  for (const name of names) {
    const result = run(name);
    const { status, output = "" } = typeof result === "number" ? { status: result } : result;
    if (status !== 0) failures.push({ name, status, output });
  }
  if (failures.length === 0) {
    log(`CHECK_ALL_PASSED ${names.length} steps`);
    return 0;
  }
  for (const { name, status } of failures) log(`CHECK_FAILED ${name} exit=${status}`);
  log(`CHECK_SUMMARY ${failures.length} of ${names.length} steps failed`);
  for (const { name, output } of failures) {
    const tail = output.replace(/\n+$/u, "").split("\n").slice(-FAILED_OUTPUT_LINES);
    if (tail.length === 1 && tail[0] === "") continue;
    log(`CHECK_FAILED_OUTPUT ${name} last ${FAILED_OUTPUT_LINES} lines`);
    for (const line of tail) log(line);
  }
  return 1;
}

function runStep(npm, name, root) {
  const child = spawnSync(npm, ["run", name], {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  process.stdout.write(output);
  return { status: child.status ?? 1, output };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const names = stepNames(manifest.scripts["check:steps"]);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runAllChecks(names, (name) => runStep(npm, name, root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
