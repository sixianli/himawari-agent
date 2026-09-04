import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePolicySource } from "./check-policy.mjs";
import {
  fileSha256,
  parseArguments,
  repositoryRoot,
  sha256,
  validateRecord,
} from "./contracts.mjs";
import { validateQualityPolicy } from "./quality-policy.mjs";

export function outputPath(value, root = repositoryRoot) {
  const canonicalRoot = realpathSync(root);
  const relative = path.relative(path.resolve(root), path.resolve(root, value));
  const output = path.resolve(canonicalRoot, relative);
  if (!relative.startsWith(`.ci-output${path.sep}`) || relative.includes("\0")) {
    throw new Error("CI_OUTPUT_OUTSIDE_RUN_DIRECTORY");
  }
  let current = output;
  while (!existsSync(current)) {
    if (lstatExists(current)) throw new Error("CI_OUTPUT_BROKEN_SYMLINK");
    current = path.dirname(current);
  }
  const actual = realpathSync(current);
  const outputRoot = path.join(canonicalRoot, ".ci-output");
  if (
    actual !== canonicalRoot &&
    actual !== outputRoot &&
    !actual.startsWith(`${outputRoot}${path.sep}`)
  ) {
    throw new Error("CI_OUTPUT_SYMLINK_ESCAPE");
  }
  for (const part of relative.split(path.sep)) {
    if (part === ".." || part === ".") throw new Error("CI_OUTPUT_INVALID_PATH");
  }
  return output;
}

function lstatExists(filename) {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function createContext({
  root = repositoryRoot,
  env = process.env,
  base,
  now = Date.now(),
} = {}) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (value) => {
    if (!/^[a-f0-9]{40}$/u.test(value ?? "")) throw new Error("CI_COMMIT_ID_REQUIRED");
    return git(["rev-parse", "--verify", `${value}^{commit}`]);
  };
  const testedSha = git(["rev-parse", "HEAD"]);
  const hosted = env.GITHUB_ACTIONS === "true";
  const event = hosted ? env.GITHUB_EVENT_NAME : "workflow_dispatch";
  if (!["pull_request", "push", "workflow_dispatch", "schedule"].includes(event))
    throw new Error("CI_EVENT_UNSUPPORTED");
  const payload = hosted ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  let headSha = testedSha;
  let baseSha;
  if (hosted && env.GITHUB_SHA !== testedSha) throw new Error("CI_CHECKOUT_SHA_MISMATCH");
  if (event === "pull_request") {
    headSha = commit(payload.pull_request?.head?.sha);
    baseSha = commit(payload.pull_request?.base?.sha);
    const parents = git(["show", "-s", "--format=%P", testedSha]).split(" ");
    if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
      throw new Error("CI_PR_MERGE_IDENTITY_MISMATCH");
    }
  } else if (event === "push") {
    if (payload.after !== testedSha) throw new Error("CI_PUSH_AFTER_MISMATCH");
    baseSha = commit(/^0{40}$/u.test(payload.before ?? "") ? base : payload.before);
  } else if (event === "schedule") {
    const policyPath = "ci/quality-policy.json";
    const bytes = execFileSync("git", ["show", `${testedSha}:${policyPath}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const policy = validateQualityPolicy(JSON.parse(bytes));
    if (!policy.schedule.enabled) throw new Error("CI_QUALITY_SCHEDULE_DISABLED");
    if (env.GITHUB_REF !== `refs/heads/${policy.defaultBranch}`)
      throw new Error("CI_QUALITY_DEFAULT_BRANCH_REQUIRED");
    if (payload.schedule !== policy.schedule.cron) throw new Error("CI_QUALITY_SCHEDULE_MISMATCH");
    if (fileSha256(path.join(root, policyPath)) !== sha256(bytes))
      throw new Error("CI_QUALITY_POLICY_CHECKOUT_MISMATCH");
    if (base !== undefined && base !== testedSha) throw new Error("CI_SCHEDULE_BASE_MISMATCH");
    baseSha = testedSha;
  } else {
    baseSha = commit(base ?? payload.inputs?.base_sha ?? (hosted ? undefined : testedSha));
  }
  const source = resolvePolicySource({ root, base: baseSha });
  if (event === "schedule" && source.initialization)
    throw new Error("CI_SCHEDULE_ACCEPTED_POLICY_REQUIRED");
  const repository = hosted ? env.GITHUB_REPOSITORY : "sixianli/himawari-agent";
  const context = {
    repository,
    event,
    runId: hosted ? env.GITHUB_RUN_ID : String(now),
    attempt: hosted ? Number(env.GITHUB_RUN_ATTEMPT) : 1,
    testedSha,
    headSha,
    baseSha,
    policySha256: source.policySha256,
    toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json")),
    initialization: source.initialization,
  };
  return validateRecord("Context", context);
}

export function verifyContext(context, { root = repositoryRoot, env = process.env } = {}) {
  validateRecord("Context", context);
  const expected = createContext({ root, env, base: context.baseSha, now: Number(context.runId) });
  for (const key of Object.keys(expected)) {
    if (expected[key] !== context[key]) throw new Error(`CI_CONTEXT_MISMATCH:${key}`);
  }
  return context;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, ["--base", "--output"]);
  if (!args["--output"]) throw new Error("CI_CONTEXT_OUTPUT_REQUIRED");
  const output = outputPath(args["--output"]);
  const context = createContext({ base: args["--base"] });
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(context, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(context)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
