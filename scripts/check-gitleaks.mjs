import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGitleaksGate } from "./ci/check-security.mjs";
import { createContext } from "./ci/context.mjs";
import { downloadArtifact, loadToolchainLock } from "./ci/install-tools.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function gitleaksCacheDirectory({ env = process.env, version, platform }) {
  return (
    env.HIMAWARI_GITLEAKS_CACHE ??
    join(homedir(), ".cache", "himawari", "gitleaks", version, platform)
  );
}

export async function ensureGitleaks({
  root = repositoryRoot,
  env = process.env,
  platform = `${process.platform}-${process.arch}`,
  fetch,
} = {}) {
  const tool = loadToolchainLock(root).tools.gitleaks;
  const artifact = tool.artifacts[platform];
  if (!artifact) throw new Error(`GITLEAKS_PLATFORM_UNSUPPORTED:${platform}`);
  const directory = gitleaksCacheDirectory({ env, version: tool.version, platform });
  const archive = await downloadArtifact(artifact, directory, fetch ? { fetch } : {});
  const member = execFileSync("tar", ["-xOzf", archive, "gitleaks"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const executable = join(directory, "gitleaks");
  if (!existsSync(executable) || !readFileSync(executable).equals(member)) {
    const partial = `${executable}.${process.pid}.partial`;
    writeFileSync(partial, member);
    chmodSync(partial, 0o755);
    renameSync(partial, executable);
  }
  const version = execFileSync(executable, ["version"], { encoding: "utf8" }).trim().split("\n")[0];
  if (version !== tool.version) throw new Error(`GITLEAKS_VERSION_MISMATCH:${version}`);
  return executable;
}

export function gateBase({ root = repositoryRoot, env = process.env } = {}) {
  const reference = env.HIMAWARI_GITLEAKS_BASE ?? "origin/main";
  try {
    return execFileSync("git", ["merge-base", "HEAD", reference], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `GITLEAKS_BASE_MISSING:${reference}（先 git fetch origin main，或用 HIMAWARI_GITLEAKS_BASE 指定基准提交）`,
    );
  }
}

export function formatGateResult(result) {
  const lines = [];
  for (const finding of result.blocking)
    lines.push(
      `GITLEAKS_FINDING ${finding.scope} ${finding.path}:${finding.line} ${finding.id}${finding.commit ? ` ${finding.commit}` : ""}`,
    );
  const summary = `current=${result.currentFiles} commits=${result.commits} excepted=${result.exceptedCount} blocking=${result.blocking.length}`;
  if (result.status === "passed") lines.push(`GITLEAKS_GATE_PASSED ${summary}`);
  else
    lines.push(
      `GITLEAKS_GATE_FAILED ${summary}`,
      "CI 的 security 作业会以同样的规则失败。误报：在 ci/rules/gitleaks.toml 按路径加窄的白名单（CI 用同一份）；真密钥：从文件删掉并作废它，已提交的历史改不掉。",
    );
  return lines.join("\n");
}

async function main() {
  const executable = await ensureGitleaks();
  const context = createContext({ root: repositoryRoot, base: gateBase() });
  const result = runGitleaksGate({ root: repositoryRoot, executable, context });
  process.stdout.write(`${formatGateResult(result)}\n`);
  return result.status === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`GITLEAKS_GATE_ERROR ${error.message}\n`);
      process.exitCode = 2;
    },
  );
}
