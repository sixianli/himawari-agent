import { execFileSync } from "node:child_process";
import process from "node:process";

export const HOOKS_PATH = "scripts/git-hooks";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function ensureLayer0Hooks({ cwd = process.cwd() } = {}) {
  let current = "";
  try {
    current = git(["config", "--local", "--get", "core.hooksPath"], cwd);
  } catch {}
  if (current === HOOKS_PATH) return { status: "installed", hooksPath: current };
  if (current) return { status: "conflict", hooksPath: current };
  git(["config", "--local", "core.hooksPath", HOOKS_PATH], cwd);
  return { status: "set", hooksPath: HOOKS_PATH };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = ensureLayer0Hooks();
  if (result.status === "conflict") {
    process.stderr.write(
      `LAYER0_HOOKS_PATH_CONFLICT core.hooksPath=${result.hooksPath}, expected ${HOOKS_PATH}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`LAYER0_HOOKS ${result.status} core.hooksPath=${result.hooksPath}\n`);
  }
}
