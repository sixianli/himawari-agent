import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readGatewayConfig } from "./gateway.mjs";
import {
  COMMIT_PATTERN,
  hasControlCharacter,
  MODES,
  nextRound,
  parseArgs,
  parseUsage,
  resultLine,
  DEFAULT_REVIEW_MODELS,
  REVIEW_MODELS,
  REVIEWS_DIR,
  reviewKey,
  spentOf,
  TOPIC_PATTERN,
} from "./opencode-review.mjs";

export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const SESSION_PATTERN = /^session_[A-Za-z0-9]{8,64}$/;
export const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;
export const RETRYABLE_OUTCOMES = ["timeout", "no-text"];
export const WAIT_MINUTES_DEFAULT = 90;
export const WAIT_INTERVAL_SECONDS_DEFAULT = 120;
export const WAIT_MINUTES_MAX = 600;
export const WAIT_GIT_FAILURES_MAX = 3;
export const GIT_TIMEOUT_MS = 120000;
export const GATEWAY_JSON_PATH = "scripts/model-review/gateway.json";
export const ROUND_FILE_PATTERN = /^round-(\d+)\/[a-z0-9][a-z0-9.-]*\.(?:md|stderr\.txt)$/;

const shortModel = (model) => model.split("/").pop();

function fail(code) {
  throw new Error(code);
}

function requireValue(condition, code) {
  if (!condition) fail(code);
}

export function briefPathFor({ pr, topic, head, mode }) {
  return `${REVIEWS_DIR}/${reviewKey({ pr, topic })}/briefs/${head.slice(0, 12)}-${mode}.md`;
}

export function validateTask(task) {
  requireValue(
    BRANCH_PATTERN.test(task.branch ?? "") && !task.branch.includes(".."),
    "DELEGATE_INVALID branch",
  );
  requireValue(COMMIT_PATTERN.test(task.tip ?? ""), "DELEGATE_INVALID tip");
  requireValue(
    task.replyTo === undefined || SESSION_PATTERN.test(task.replyTo),
    "DELEGATE_INVALID reply-to",
  );
  requireValue(MODES.includes(task.mode) && task.mode !== "plan-claims", "DELEGATE_INVALID mode");
  requireValue(COMMIT_PATTERN.test(task.head ?? ""), "DELEGATE_INVALID head");
  requireValue(task.base === undefined || COMMIT_PATTERN.test(task.base), "DELEGATE_INVALID base");
  requireValue(
    task.previous === undefined || COMMIT_PATTERN.test(task.previous),
    "DELEGATE_INVALID previous",
  );
  requireValue(
    (task.pr === undefined) !== (task.topic === undefined),
    "DELEGATE_INVALID pr-or-topic",
  );
  requireValue(
    task.pr === undefined || (Number.isSafeInteger(task.pr) && task.pr > 0),
    "DELEGATE_INVALID pr",
  );
  requireValue(
    task.topic === undefined || TOPIC_PATTERN.test(task.topic),
    "DELEGATE_INVALID topic",
  );
  requireValue(
    task.approvedUsd === undefined || (Number.isFinite(task.approvedUsd) && task.approvedUsd > 0),
    "DELEGATE_INVALID approved-usd",
  );
  const known = readGatewayConfig(undefined, REVIEW_MODELS).providers.map(
    (provider) => provider.id,
  );
  requireValue(
    task.providers === undefined ||
      (task.providers.length > 0 &&
        task.providers.every((id) => PROVIDER_PATTERN.test(id) && known.includes(id))),
    "DELEGATE_INVALID providers",
  );
  requireValue(
    task.models === undefined ||
      (task.models.length > 0 &&
        task.models.every((name) => REVIEW_MODELS.some((model) => shortModel(model) === name))),
    "DELEGATE_INVALID models",
  );
  requireValue(
    task.round === undefined || (Number.isSafeInteger(task.round) && task.round > 0),
    "DELEGATE_INVALID round",
  );
  requireValue(
    task.brief === briefPathFor(task),
    `DELEGATE_INVALID brief expected=${briefPathFor(task)}`,
  );
}

export function reviewArgv(task) {
  const argv = [
    "--mode",
    task.mode,
    ...(task.pr !== undefined ? ["--pr", String(task.pr)] : ["--topic", task.topic]),
    ...(task.base ? ["--base", task.base] : []),
    "--head",
    task.head,
    ...(task.previous ? ["--previous", task.previous] : []),
    "--models",
    (task.models ?? DEFAULT_REVIEW_MODELS.map(shortModel)).join(","),
    ...(task.round !== undefined ? ["--round", String(task.round)] : []),
    "--brief",
    task.brief,
    "--gateway",
    "magpie",
    "--require-gateway",
    ...(task.approvedUsd !== undefined ? ["--approved-usd", String(task.approvedUsd)] : []),
    ...(task.providers ? ["--providers", task.providers.join(",")] : []),
  ];
  parseArgs(argv);
  return argv;
}

export function delegationPrompt(task) {
  validateTask(task);
  const argv = reviewArgv(task);
  const key = reviewKey(task);
  const command = `node scripts/model-review/opencode-review.mjs ${argv.join(" ")}`;
  const retryText =
    task.round === undefined
      ? `只有一种情况可以补跑：某个模型的 REVIEW_RESULT 里 outcome 是 ${RETRYABLE_OUTCOMES.join(" 或 ")} 时，只对那一个模型补跑一次，命令是上面那条去掉 --models 和它后面的值之后，加 --round <那一轮的序号> --models <那个模型的短名>。补跑照样受 --approved-usd 和脚本的先问门槛约束，遇到 BUDGET_NEEDS_APPROVAL 就停下报告。`
      : "这条命令本身就是补跑，不再补跑。";
  return `你是 himawari-agent 的复核执行线程，只负责跑一次模型复核并把原始记录推回分支；你不做判断、不改代码。

## 第 0 步：核对环境和分支，任何一项不对就停下报告，不要继续

1. 在仓库根目录运行 echo "$HIMAWARI_REVIEW_GATEWAY"，结果不是 magpie 就停下（说明会话没开在 himawari-cloud 环境里）。
2. 运行 git fetch origin ${task.branch} && git checkout -B ${task.branch} FETCH_HEAD，再运行 git rev-parse HEAD，结果必须正好是 ${task.tip}，否则停下。
3. 材料文件 ${task.brief} 必须存在。

## 第 1 步：跑复核（在仓库根目录，原样运行，不要增删参数，不要自己加 --approved-usd，不要加 --gateway direct）

${command}

脚本退出码不是 0 时不要整条重跑，其他任何失败也都不重跑。${retryText}

## 第 2 步：提交并推送

1. 如果 package.json 里有 check:gitleaks 这个脚本，先运行 npm run check:gitleaks；失败就停下报告，不提交。
2. 只提交 ${REVIEWS_DIR}/${key}/ 下新增或改动的文件，别的文件一个都不要提交。提交说明末尾写两行：Layer-0-tests: none 和 Fast-mode-checks: none（只跑复核，没有改代码）。
3. 普通推送 git push origin ${task.branch}，不要强制推送；推送被拒就停下报告，不要重试、不要合并。

## 第 3 步：报告

${
  task.replyTo
    ? `如果你有给其他会话发消息的工具，就给会话 ${task.replyTo} 发消息；没有就跳过，不要因此算失败，结果以推送到分支上的提交为准。\n开跑前发一行 REVIEW_DELEGATION_STARTED ${key}；\n结束后发一行 JSON：{"event":"REVIEW_DELEGATION_DONE","dir":"${key}","tip":"${task.tip}","exit":<脚本退出码>}，失败时 event 写 REVIEW_DELEGATION_FAILED 并加 "reason":"<错误码>"。\n`
    : ""
}在你自己的最后回复里写：推送后的分支头提交、每个模型的 REVIEW_RESULT 行、GATEWAY_USAGE 行、REVIEW_TIMING 行、全部 GATEWAY_REST 行、REVIEW_SPENT_TOTAL 行。

## 不许做的事

不改任何代码，不写 verdicts.jsonl 和 judgments.md，不用 --accept-low、--accept-unreviewed，不合并，不在 PR 上发评论，不开新一轮复核。Andy 在这个会话里说停止复核、换服务方时，按仓库里 .agents/instructions/model-review.md 的“Andy 怎样控制复核”一节做。
`;
}

function git(args, cwd, { allowFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.status !== 0 && !allowFail)
    fail(`DELEGATE_GIT_FAILED git ${args[0]}: ${(result.stderr ?? "").trim()}`);
  return result;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function rawChanges(repo, from, to) {
  const tokens = git(["diff", "--raw", "-z", "--no-renames", from, to], repo)
    .stdout.split("\0")
    .filter(Boolean);
  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const [, newMode, , , status] = tokens[index].split(/\s+/);
    changes.push({ newMode, status, path: tokens[index + 1] });
  }
  return changes;
}

function showFile(repo, commit, path) {
  if (!git(["ls-tree", commit, "--", path], repo).stdout.trim()) return null;
  return git(["show", `${commit}:${path}`], repo).stdout;
}

function roundDirectories(repo, commit, recordsDir) {
  return git(["ls-tree", "-d", "--name-only", commit, recordsDir], repo)
    .stdout.split("\n")
    .map((line) => /\/round-(\d+)$/.exec(line)?.[1])
    .filter(Boolean)
    .map(Number);
}

function hasControlText(value) {
  if (typeof value === "string") return hasControlCharacter(value) || /[\p{Cc}\p{Cf}]/u.test(value);
  if (Array.isArray(value)) return value.some(hasControlText);
  if (value && typeof value === "object")
    return Object.entries(value).some(([key, item]) => hasControlText(key) || hasControlText(item));
  return false;
}

export function checkResult(task, { repo, fetch = true }) {
  validateTask(task);
  const key = reviewKey(task);
  const recordsDir = `${REVIEWS_DIR}/${key}/`;
  const ledgerPath = `${recordsDir}usage.jsonl`;
  const rejected = (reason) => ({ status: "rejected", reason });
  if (fetch)
    git(
      [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`,
      ],
      repo,
    );
  const remote = git(
    ["rev-parse", "--verify", `refs/remotes/origin/${task.branch}^{commit}`],
    repo,
  ).stdout.trim();
  const ancestry = git(["merge-base", "--is-ancestor", task.tip, remote], repo, {
    allowFail: true,
  });
  if (ancestry.status === 1)
    return rejected(`DELEGATION_REWRITTEN tip=${task.tip} remote=${remote}`);
  if (ancestry.status !== 0) fail(`DELEGATE_GIT_FAILED merge-base: ${ancestry.stderr.trim()}`);
  if (remote === task.tip) return { status: "pending", remote };
  if (git(["rev-list", "--merges", `${task.tip}..${remote}`], repo).stdout.trim())
    return rejected("DELEGATION_MERGE_COMMIT");
  const touched = git(
    ["log", "-z", "--name-only", "--format=", "--no-renames", `${task.tip}..${remote}`],
    repo,
  )
    .stdout.split("\0")
    .filter(Boolean);
  const stray = touched.find((file) => !file.startsWith(recordsDir));
  if (stray) return rejected(`DELEGATION_OUTSIDE_RECORDS ${JSON.stringify(stray)}`);
  const changes = rawChanges(repo, task.tip, remote);
  const outside = changes.find((change) => !change.path.startsWith(recordsDir));
  if (outside) return rejected(`DELEGATION_OUTSIDE_RECORDS ${JSON.stringify(outside.path)}`);
  const renamedAway = (change) =>
    /^(.*)\.stderr\.txt$/.test(change.path) &&
    changes.some(
      (other) =>
        other.status === "A" &&
        other.path.startsWith(change.path.replace(/\.stderr\.txt$/, ".attempt-")) &&
        other.path.endsWith(".stderr.txt"),
    );
  const irregular = changes.find(
    (change) =>
      (change.status === "D" && !renamedAway(change)) ||
      (change.status !== "D" && change.newMode !== "100644"),
  );
  if (irregular) return rejected(`DELEGATION_IRREGULAR_FILE ${JSON.stringify(irregular.path)}`);
  const before = showFile(repo, task.tip, ledgerPath) ?? "";
  const after = showFile(repo, remote, ledgerPath);
  if (after === null) return rejected("DELEGATION_NO_LEDGER");
  if (!after.startsWith(before)) return rejected("DELEGATION_LEDGER_REWRITTEN");
  let records;
  let earlier;
  try {
    earlier = parseUsage(before, "before");
    records = parseUsage(after, `${remote}:${ledgerPath}`);
  } catch (error) {
    return rejected(`DELEGATION_LEDGER_INVALID ${error.message}`);
  }
  const knownLines = new Set(before.split("\n").filter(Boolean));
  if (
    after
      .slice(before.length)
      .split("\n")
      .some((line) => line && knownLines.has(line))
  )
    return rejected("DELEGATION_LEDGER_DUPLICATE");
  const added = records.slice(earlier.length);
  if (added.length === 0) return rejected("DELEGATION_NO_NEW_RECORDS");
  if (hasControlText(added)) return rejected("DELEGATION_CONTROL_CHARACTER");
  const expectedRound =
    task.round ?? nextRound(earlier, roundDirectories(repo, task.tip, recordsDir));
  const expectedModels = parseArgs(reviewArgv(task)).models;
  const providersFromTip = () => {
    const text = showFile(repo, task.tip, GATEWAY_JSON_PATH);
    let ids = null;
    try {
      ids = JSON.parse(text).providers.map((item) => item.id);
    } catch {
      return fail("DELEGATION_NO_GATEWAY_CONFIG");
    }
    return ids.every((id) => typeof id === "string") ? ids : fail("DELEGATION_NO_GATEWAY_CONFIG");
  };
  const allowedProviders = task.providers ?? providersFromTip();
  const problems = [];
  for (const record of added) {
    const round = record.round ?? 1;
    if (record.mode !== task.mode) problems.push(`mode=${record.mode}`);
    if (record.head !== task.head) problems.push(`head=${record.head}`);
    if ((record.base ?? null) !== (task.base ?? null)) problems.push(`base=${record.base ?? null}`);
    if ((record.previous ?? null) !== (task.previous ?? null))
      problems.push(`previous=${record.previous ?? null}`);
    if (round !== expectedRound) problems.push(`round=${round} expected=${expectedRound}`);
    if (!REVIEW_MODELS.includes(record.model)) {
      problems.push(`model=${record.model}`);
      continue;
    }
    if (!expectedModels.includes(record.model) && !record.substitute)
      problems.push(`model=${record.model}`);
    if (record.gateway !== "magpie") problems.push(`gateway=${record.gateway}`);
    for (const provider of Object.keys(record.providers ?? {}))
      if (!allowedProviders.includes(provider) && !["none", "unknown"].includes(provider))
        problems.push(`provider=${provider}`);
    const name = shortModel(record.model);
    const answer = showFile(repo, remote, `${recordsDir}round-${round}/${name}.md`);
    const prompt = showFile(repo, remote, `${recordsDir}round-${round}/${name}.prompt.md`);
    if (answer === null) problems.push(`missing=round-${round}/${name}.md`);
    if (prompt === null) problems.push(`missing=round-${round}/${name}.prompt.md`);
    else if (sha256(prompt) !== (record.promptFileSha256 ?? record.promptSha256))
      problems.push(`prompt-hash=round-${round}/${name}`);
  }
  for (const model of expectedModels)
    if (!added.some((record) => record.model === model && !record.substitute))
      problems.push(`absent=${model}`);
  const roundFiles = changes.filter((change) => change.path !== ledgerPath);
  for (const change of roundFiles) {
    const relative = change.path.slice(recordsDir.length);
    const match = ROUND_FILE_PATTERN.exec(relative);
    const file = relative.split("/").pop();
    const ofAddedModel = added.some((record) => {
      const stem = shortModel(record.model);
      return [".md", ".prompt.md", ".stderr.txt"].some(
        (suffix) =>
          file === `${stem}${suffix}` ||
          (file.startsWith(`${stem}.attempt-`) &&
            /^\d+$/.test(file.slice(`${stem}.attempt-`.length, file.length - suffix.length)) &&
            file.endsWith(suffix)),
      );
    });
    if (!match || Number(match[1]) !== expectedRound || !ofAddedModel)
      problems.push(`unexpected-file=${JSON.stringify(change.path)}`);
  }
  if (problems.length > 0) return rejected(`DELEGATION_RECORD_MISMATCH ${problems.join(" ")}`);
  const spent = spentOf(added);
  const finished = (model) =>
    added.some(
      (record) =>
        record.outcome === "ok" &&
        ((record.model === model && record.substitute === undefined) ||
          (record.substitute === true && record.substituteFor === model)),
    );
  const notOk = expectedModels.filter((model) => !finished(model));
  const estimated = added.some((record) => record.costUnknown || record.inFlight);
  return { status: "ok", remote, added, spent, notOk, estimated };
}

export function applyResult(task, { repo, remote }) {
  const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
  if (head !== task.tip) fail(`DELEGATION_LOCAL_MOVED head=${head} tip=${task.tip}`);
  git(["merge", "--ff-only", remote ?? `refs/remotes/origin/${task.branch}`], repo);
  return git(["rev-parse", "HEAD"], repo).stdout.trim();
}

export async function waitForBranch({
  branch,
  tip,
  lsRemote,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  minutes = WAIT_MINUTES_DEFAULT,
  intervalSeconds = WAIT_INTERVAL_SECONDS_DEFAULT,
}) {
  requireValue(
    Number.isFinite(minutes) && minutes > 0 && minutes <= WAIT_MINUTES_MAX,
    "DELEGATE_INVALID minutes",
  );
  requireValue(
    Number.isFinite(intervalSeconds) && intervalSeconds >= 1 && intervalSeconds <= minutes * 60,
    "DELEGATE_INVALID interval",
  );
  const polls = Math.ceil((minutes * 60) / intervalSeconds) + 1;
  let failures = 0;
  for (let attempt = 0; attempt < polls; attempt += 1) {
    let sha = "";
    try {
      sha = lsRemote(branch);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= WAIT_GIT_FAILURES_MAX) throw error;
    }
    if (sha && sha !== tip) return { moved: true, sha };
    if (attempt < polls - 1) await sleep(intervalSeconds * 1000);
  }
  return { moved: false, sha: tip };
}

export function remoteHead(repo, branch) {
  const result = git(["ls-remote", "origin", `refs/heads/${branch}`], repo);
  return (result.stdout.split("\t")[0] ?? "").trim();
}

const COMMAND_OPTIONS = {
  prompt: [
    "--mode",
    "--pr",
    "--topic",
    "--base",
    "--head",
    "--previous",
    "--models",
    "--round",
    "--approved-usd",
    "--providers",
    "--branch",
    "--tip",
    "--reply-to",
    "--repo",
  ],
  check: [
    "--mode",
    "--pr",
    "--topic",
    "--base",
    "--head",
    "--previous",
    "--models",
    "--round",
    "--approved-usd",
    "--providers",
    "--branch",
    "--tip",
    "--reply-to",
    "--repo",
    "--apply",
  ],
  wait: ["--branch", "--tip", "--repo", "--minutes", "--interval-seconds"],
};

export function parseTask(argv) {
  const task = {};
  const given = [];
  let command;
  let repo = process.cwd();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (index === 0 && !key.startsWith("--")) {
      command = key;
      continue;
    }
    const take = () => {
      index += 1;
      if (argv[index] === undefined) fail(`DELEGATE_MISSING_VALUE ${key}`);
      return argv[index];
    };
    given.push(key);
    if (key === "--repo") repo = resolve(take());
    else if (key === "--branch") task.branch = take();
    else if (key === "--tip") task.tip = take();
    else if (key === "--reply-to") task.replyTo = take();
    else if (key === "--mode") task.mode = take();
    else if (key === "--pr") task.pr = Number(take());
    else if (key === "--topic") task.topic = take();
    else if (key === "--base") task.base = take();
    else if (key === "--head") task.head = take();
    else if (key === "--previous") task.previous = take();
    else if (key === "--models") task.models = take().split(",");
    else if (key === "--round") task.round = Number(take());
    else if (key === "--approved-usd") task.approvedUsd = Number(take());
    else if (key === "--providers") task.providers = take().split(",");
    else if (key === "--minutes") task.minutes = Number(take());
    else if (key === "--interval-seconds") task.intervalSeconds = Number(take());
    else if (key === "--apply") flags.add("apply");
    else fail(`DELEGATE_UNKNOWN ${key}`);
  }
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) fail("DELEGATE_USAGE prompt|check|wait");
  const extra = given.filter((key) => !COMMAND_OPTIONS[command].includes(key));
  if (extra.length > 0) fail(`DELEGATE_NOT_FOR_COMMAND ${extra.join(" ")}`);
  if (task.mode && !task.brief && task.head)
    task.brief = briefPathFor({ pr: task.pr, topic: task.topic, head: task.head, mode: task.mode });
  return { command, task, repo, flags };
}

async function main() {
  const { command, task, repo, flags } = parseTask(process.argv.slice(2));
  if (command === "prompt") {
    process.stdout.write(delegationPrompt(task));
    return;
  }
  if (command === "check") {
    const result = checkResult(task, { repo });
    if (result.status === "pending") {
      console.log(`DELEGATION_PENDING remote=${result.remote}`);
      process.exitCode = 3;
      return;
    }
    if (result.status === "rejected") {
      console.log(result.reason);
      process.exitCode = 5;
      return;
    }
    const applied = flags.has("apply") ? applyResult(task, { repo, remote: result.remote }) : null;
    for (const record of result.added) console.log(resultLine(record));
    const summary = `remote=${result.remote} records=${result.added.length} spent=${result.spent.toFixed(4)}${result.estimated ? " estimated=true" : ""}`;
    if (result.notOk.length > 0) {
      console.log(`DELEGATION_RESULT_INCOMPLETE ${summary} not-ok=${result.notOk.join(",")}`);
      process.exitCode = 4;
    } else console.log(`DELEGATION_RESULT_OK ${summary}`);
    if (applied) console.log(`DELEGATION_APPLIED head=${applied}`);
    return;
  }
  if (command === "wait") {
    requireValue(
      BRANCH_PATTERN.test(task.branch ?? "") && !task.branch.includes(".."),
      "DELEGATE_INVALID branch",
    );
    requireValue(COMMIT_PATTERN.test(task.tip ?? ""), "DELEGATE_INVALID tip");
    const waited = await waitForBranch({
      branch: task.branch,
      tip: task.tip,
      lsRemote: (branch) => remoteHead(repo, branch),
      minutes: task.minutes,
      intervalSeconds: task.intervalSeconds,
    });
    if (waited.moved) console.log(`DELEGATION_BRANCH_MOVED ${waited.sha}`);
    else {
      console.log(`DELEGATION_WAIT_TIMEOUT tip=${task.tip}`);
      process.exitCode = 3;
    }
    return;
  }
  fail("DELEGATE_USAGE prompt|check|wait");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
