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

export function runAllChecks(names, run, log = console.log) {
  const failures = [];
  for (const name of names) {
    const status = run(name);
    if (status !== 0) failures.push({ name, status });
  }
  if (failures.length === 0) {
    log(`CHECK_ALL_PASSED ${names.length} steps`);
    return 0;
  }
  for (const { name, status } of failures) log(`CHECK_FAILED ${name} exit=${status}`);
  log(`CHECK_SUMMARY ${failures.length} of ${names.length} steps failed`);
  return 1;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const names = stepNames(manifest.scripts["check:steps"]);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runAllChecks(
    names,
    (name) => spawnSync(npm, ["run", name], { cwd: root, stdio: "inherit" }).status ?? 1,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
