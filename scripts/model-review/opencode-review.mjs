#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD_ENV } from "./spend-guard.mjs";

export const OPENCODE_VERSION = "1.19.5";
export const REVIEW_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"];
export const REASONING_VARIANT = "high";
export const OUTPUT_TOKEN_MAX = 200000;
export const MIN_OUTPUT_TOKENS = 100000;
export const MODEL_OUTPUT_LIMITS = { "deepseek-v4.1-flash": 384000, "glm-5.3-flash": 131072 };
export const MODES = ["code-review", "plan", "plan-review"];
export const GIT_READ_COMMANDS = ["git diff", "git log", "git show", "git blame", "git status"];
export const WRITE_OR_OUTSIDE_PATTERNS = [
  "*>*",
  "*<*",
  "*\t*",
  "*--output*",
  "* -o*",
  "* -O*",
  "*--ext-diff*",
  "*--textconv*",
  "*--no-index*",
  "*--contents*",
  "*difftool*",
];
export const GIT_SUBCOMMANDS = ["diff", "log", "show", "blame", "status"];
export const GIT_BANNED_OPTIONS = [
  "--output",
  "--no-index",
  "--contents",
  "--ext-diff",
  "--textconv",
  "--open-files-in-pager",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--ignore-revs-file",
  "--pathspec-from-file",
  "--mailmap-file",
  "--orderfile",
  "--help",
  "--show-signature",
  "--text",
  "--binary",
];
const GIT_SHORT_VALUE_LETTERS = "SGLUnlMCBXI";
export const GIT_REFUSED = "REVIEW_GIT_REFUSED";
export const COST_LIMIT_PER_MODEL_USD = 0.2;
export const WRAP_UP_RESERVE_USD = 0.05;
export const WRAP_UP_RESERVE_MAX_MS = 5 * 60 * 1000;
export const WRAP_UP_MIN_USD = 0.02;
export const WRAP_UP_MIN_MS = 15000;
export const GUARD_GRACE_MAX_MS = 30000;
export const GUARD_GRACE_DIVISOR = 15;
export const GUARD_DEFERS_TO_PARENT = ["cost-unknown", "wrap-up-tool-call"];
export const SPEND_GUARD_PATH = join(dirname(fileURLToPath(import.meta.url)), "spend-guard.mjs");
export const ASK_FIRST_LINE_USD = { "code-review": 1, plan: 0.5, "plan-review": 0.5 };
export const FOCUS_SENTENCE =
  "做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。";
export const WRAP_UP_PROMPT =
  "现在停止读代码和调用工具。根据你已经读到的内容，按上面要求的输出格式写出完整结论；结论要写在正文里，不要只写在思考里。没核实的地方标「未核实」。";
export const RULE_16_SENTENCE = "列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function reviewConfig({ mode, baseURL, wrapUp = false } = {}) {
  if (!MODES.includes(mode)) throw new Error(`MODE_UNKNOWN ${mode}`);
  const bash = { "*": "deny" };
  for (const command of GIT_READ_COMMANDS) {
    bash[command] = "allow";
    bash[`${command} *`] = "allow";
  }
  for (const pattern of WRITE_OR_OUTSIDE_PATTERNS) bash[pattern] = "deny";
  const provider = baseURL ? { options: { apiKey: "placeholder", baseURL } } : {};
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(SPEND_GUARD_PATH).href],
    provider: { "opencode-go": provider },
    permission: {
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
      glob: "allow",
      grep: "allow",
      bash,
      edit: "deny",
      webfetch: mode === "code-review" ? "deny" : "allow",
      websearch: mode === "code-review" ? "deny" : "allow",
      task: "deny",
      todowrite: "deny",
      skill: "deny",
      question: "deny",
      lsp: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
  };
  if (!wrapUp) return config;
  return {
    ...config,
    permission: askInsteadOfAllow(config.permission),
    agent: { build: { steps: 1 } },
  };
}

function askInsteadOfAllow(rule) {
  if (rule === "allow") return "ask";
  if (typeof rule !== "object") return rule;
  return Object.fromEntries(
    Object.entries(rule).map(([key, value]) => [key, askInsteadOfAllow(value)]),
  );
}

export function expectedTools(mode) {
  const tools = ["bash", "glob", "grep", "read"];
  if (mode !== "code-review") tools.push("webfetch", "websearch");
  return tools.sort();
}

export function reviewQuestions(markdown) {
  const start = markdown.indexOf('<a id="checklist"></a>');
  if (start < 0) throw new Error("REVIEW_CHECKLIST_MISSING");
  const section = markdown
    .slice(start)
    .split(/\n(?=<a id=|## )/)
    .slice(0, 2)
    .join("\n");
  const questions = [...section.matchAll(/^\d+\.\s+(.+)$/gm)].map((match) => match[1].trim());
  if (questions.length === 0) throw new Error("REVIEW_CHECKLIST_EMPTY");
  return questions;
}

const MODE_TEXT = {
  "code-review": {
    role: "你是独立的代码复核者。",
    network: "不能上网。",
    task: "系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。",
    output:
      "输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。",
    materialTitle: "作者的说法（可能有错，请核对）：",
  },
  plan: {
    role: "你是独立的方案设计者。",
    network:
      "可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。",
    task: "下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。",
    output:
      "输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。",
    materialTitle: "问题、目标和约束：",
  },
  "plan-review": {
    role: "你是独立的方案审核者。",
    network:
      "可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。",
    task: "下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。",
    output:
      "输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。",
    materialTitle: "待审核的方案：",
  },
};

export function buildPrompt({ mode, questions, head, base, previous, brief }) {
  if (!MODES.includes(mode)) throw new Error(`MODE_UNKNOWN ${mode}`);
  if (!brief || !brief.trim()) throw new Error("BRIEF_EMPTY");
  const text = MODE_TEXT[mode];
  const fixed = [
    text.role,
    `你能用的工具：read、grep、glob${mode === "code-review" ? "" : "、websearch、webfetch"}，以及 ${GIT_READ_COMMANDS.join("、")} 这几条 git 命令。不能修改任何文件，不能运行别的命令。${text.network}`,
    text.task,
    FOCUS_SENTENCE,
    RULE_16_SENTENCE,
    "必答问题：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    text.output,
  ].join("\n");
  const material = [
    "---- 本次材料 ----",
    `仓库就是当前目录，已检出 ${head}。`,
    base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
    previous
      ? `上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。`
      : null,
    text.materialTitle,
    brief.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  return `${fixed}\n\n${material}\n`;
}

export const validCost = (value) => Number.isFinite(value) && value >= 0;

export function summarizeEvents(jsonl) {
  const usage = {
    steps: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  const texts = [];
  const thoughts = [];
  const toolCalls = [];
  let lastReason = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const part = event.part ?? {};
    if (event.type === "text" && typeof part.text === "string") texts.push(part.text);
    if (event.type === "reasoning" && typeof part.text === "string") thoughts.push(part.text);
    if (event.type === "tool_use") {
      toolCalls.push({
        tool: part.tool,
        input: part.state?.input,
        status: part.state?.status,
        output: String(part.state?.output ?? part.state?.error ?? ""),
      });
    }
    if (event.type === "step_finish") {
      const tokens = part.tokens ?? {};
      usage.steps += 1;
      usage.input += tokens.input ?? 0;
      usage.output += tokens.output ?? 0;
      usage.reasoning += tokens.reasoning ?? 0;
      usage.cacheRead += tokens.cache?.read ?? 0;
      usage.cacheWrite += tokens.cache?.write ?? 0;
      if (validCost(part.cost)) usage.cost += part.cost;
      else usage.costUnknown = true;
      lastReason = part.reason ?? null;
    }
  }
  const text = texts.join("\n").trim();
  let outcome = "ok";
  if (lastReason === "length") outcome = "truncated";
  else if (!text) outcome = "no-text";
  return { outcome, lastReason, text, thinking: thoughts.join("\n").trim(), usage, toolCalls };
}

export const OPENCODE_LOCK_DIR = join(dirname(fileURLToPath(import.meta.url)), "opencode-lock");
export const OPENCODE_LOCK_FILES = ["package.json", "package-lock.json"];

export function installedIntegrityProblems(prefix, lock) {
  const installedPath = join(prefix, "node_modules", ".package-lock.json");
  if (!existsSync(installedPath)) return ["installed-lock-missing"];
  const installed = JSON.parse(readFileSync(installedPath, "utf8")).packages ?? {};
  const problems = [];
  if (!installed["node_modules/opencode-ai"]) problems.push("node_modules/opencode-ai missing");
  for (const [name, entry] of Object.entries(installed)) {
    const expected = lock.packages?.[name];
    if (!expected?.integrity || expected.integrity !== entry.integrity)
      problems.push(`${name} ${entry.integrity ?? "no-integrity"}`);
  }
  return problems;
}

export function installOpencode({ prefix, lockDir = OPENCODE_LOCK_DIR }) {
  const lock = JSON.parse(readFileSync(join(lockDir, "package-lock.json"), "utf8"));
  const binary = join(prefix, "node_modules", ".bin", "opencode");
  if (!existsSync(binary)) {
    mkdirSync(prefix, { recursive: true });
    for (const file of OPENCODE_LOCK_FILES)
      writeFileSync(join(prefix, file), readFileSync(join(lockDir, file)));
    const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: prefix,
      encoding: "utf8",
    });
    process.stderr.write(`${install.stdout ?? ""}${install.stderr ?? ""}`);
    if (install.status !== 0) {
      if (/EINTEGRITY|integrity checksum failed/i.test(install.stderr ?? ""))
        throw new Error("OPENCODE_INTEGRITY_MISMATCH npm-ci");
      throw new Error("OPENCODE_INSTALL_FAILED");
    }
    if (!existsSync(binary)) throw new Error("OPENCODE_INSTALL_FAILED");
  }
  const problems = installedIntegrityProblems(prefix, lock);
  if (problems.length > 0)
    throw new Error(`OPENCODE_INTEGRITY_MISMATCH ${prefix} ${problems.join(" | ")}`);
  return binary;
}

export function opencodeBinary() {
  if (process.env.HIMAWARI_OPENCODE_BIN) return process.env.HIMAWARI_OPENCODE_BIN;
  const lockDigest = createHash("sha256")
    .update(readFileSync(join(OPENCODE_LOCK_DIR, "package-lock.json")))
    .digest("hex")
    .slice(0, 12);
  return installOpencode({
    prefix: join(homedir(), ".cache", `himawari-opencode-${OPENCODE_VERSION}-${lockDigest}`),
  });
}

const activeChildren = new Set();

export function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    return false;
  }
  return true;
}

export const REVIEWS_PATH_FRAGMENT = "agents/reviews";

function shortOptionProblem(subcommand, letters) {
  for (const letter of letters) {
    if (letter === "o" || letter === "O" || letter === "a") return true;
    if (subcommand === "blame" && letter === "S") return true;
    if (subcommand === "blame" && letter === "n") continue;
    if (GIT_SHORT_VALUE_LETTERS.includes(letter)) return false;
  }
  return false;
}

export function checkGitArgs(args) {
  if (!GIT_SUBCOMMANDS.includes(args[0])) return `subcommand ${args[0] ?? "(none)"}`;
  const recordsPath = args.slice(1).find((arg) => arg.includes(REVIEWS_PATH_FRAGMENT));
  if (recordsPath) return `records-path ${recordsPath}`;
  for (const arg of args.slice(1)) {
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (name.length > 2 && GIT_BANNED_OPTIONS.some((banned) => banned.startsWith(name)))
        return name;
    } else if (arg.startsWith("-") && shortOptionProblem(args[0], arg.slice(1))) {
      return arg;
    }
  }
  return null;
}

export const GIT_ENV = {
  GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: "true",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_PAGER: "cat",
  PAGER: "cat",
};
export const GIT_KEPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"];
export const REVIEW_CANARY_ENV = "REVIEW_CANARY";
export const REVIEW_PARENT_CANARY_ENV = "REVIEW_PARENT_CANARY";
export const OPENCODE_KEPT_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function opencodeEnv(env) {
  return Object.fromEntries(
    OPENCODE_KEPT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
}
export const SHELL_LOG_NAME = "review-shell.log";

export function gitChildEnv(env) {
  const kept = Object.fromEntries(
    GIT_KEPT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
  return { ...kept, ...GIT_ENV };
}

export function installGitGuard(workRoot) {
  const which = (name) =>
    spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  const realGit = which("git");
  const realBash = which("bash");
  if (!realGit) throw new Error("GIT_NOT_FOUND");
  if (!realBash) throw new Error("BASH_NOT_FOUND");
  const binDir = join(workRoot, "guard-bin");
  mkdirSync(binDir);
  const modulePath = fileURLToPath(import.meta.url);
  const guard = join(binDir, "git");
  writeFileSync(
    guard,
    [
      `#!${process.execPath}`,
      'import { spawnSync } from "node:child_process";',
      `import { GIT_REFUSED, checkGitArgs, gitChildEnv } from ${JSON.stringify(modulePath)};`,
      "const args = process.argv.slice(2);",
      "const problem = checkGitArgs(args);",
      "if (problem) {",
      '  process.stderr.write([GIT_REFUSED, problem].join(" ") + "\\n");',
      "  process.exit(1);",
      "}",
      `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit", env: gitChildEnv(process.env) });`,
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  chmodSync(guard, 0o755);
  const shellDir = join(workRoot, "guard-shell");
  mkdirSync(shellDir);
  const shell = join(shellDir, "bash");
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      `echo "$$" >> ${JSON.stringify(join(workRoot, SHELL_LOG_NAME))}`,
      `exec ${JSON.stringify(realBash)} -r "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  const configHome = join(workRoot, "opencode-config-home");
  mkdirSync(configHome);
  return { binDir, realGit, shell, configHome };
}

function runOpencode({
  binary,
  cwd,
  configPath,
  gitGuard,
  model,
  prompt,
  timeoutMs,
  costLimit,
  wrapUpCost,
  wrapUpMs,
  session,
  stopOnToolCall = false,
  extraEnv = {},
  parentEnv = process.env,
  guard,
}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const guardFiles = guard
      ? prepareGuard({ gitGuard, guard, startedAt, timeoutMs, wrapUpMs })
      : null;
    const graceMs = guard
      ? Math.min(GUARD_GRACE_MAX_MS, Math.floor(timeoutMs / GUARD_GRACE_DIVISOR))
      : 0;

    let stdout = "";
    let stderr = "";
    let pending = "";
    let cost = 0;
    let stopReason = null;
    let settled = false;
    let calledTool = false;
    const child = spawn(
      binary,
      [
        "run",
        "--format",
        "json",
        "--thinking",
        ...(session ? ["--session", session] : []),
        "-m",
        model,
        "--variant",
        REASONING_VARIANT,
        prompt,
      ],
      {
        cwd,
        env: {
          ...opencodeEnv(parentEnv),
          PWD: cwd,
          OPENCODE_CONFIG: configPath,
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          ...(guardFiles ? { [GUARD_ENV]: guardFiles.limitsPath } : {}),
          XDG_CONFIG_HOME: gitGuard.configHome,
          OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(OUTPUT_TOKEN_MAX),
          GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: "true",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PAGER: "cat",
          PAGER: "cat",
          PATH: `${gitGuard.binDir}${delimiter}${parentEnv.PATH ?? ""}`,
          SHELL: gitGuard.shell,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    activeChildren.add(child);
    let killTimer;
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 10000);
      killTimer.unref();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(wrapUpTimer);
      clearTimeout(killTimer);
      killProcessGroup(child, "SIGKILL");
      activeChildren.delete(child);
      const marker = guardFiles ? readGuardMarker(guardFiles.markerPath) : null;
      const inFlight = Boolean(stopReason && marker && marker.allowed > marker.completed);
      if (marker?.reason && !GUARD_DEFERS_TO_PARENT.includes(stopReason))
        stopReason = marker.reason;
      resolvePromise({ stdout, stderr, stopReason, guard: marker, inFlight, ...result });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "tool_use") calledTool = true;
        if (event.type !== "step_finish") continue;
        const stepCost = event.part?.cost;
        if (!validCost(stepCost)) {
          if (costLimit !== undefined) stop("cost-unknown");
        } else cost += stepCost;
        if (costLimit !== undefined && cost > costLimit) stop("cost-limit");
        if (wrapUpCost !== undefined && cost >= wrapUpCost) stop("wrap-up-cost");
        if (stopOnToolCall && calledTool) stop("wrap-up-tool-call");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
    child.on("exit", () => killProcessGroup(child, "SIGKILL"));
    child.on("close", (code, signal) => finish({ code, signal }));
    const timer = setTimeout(() => stop("timeout"), timeoutMs + graceMs);
    const wrapUpTimer =
      wrapUpMs === undefined
        ? undefined
        : setTimeout(() => stop("wrap-up-time"), wrapUpMs + graceMs);
  });
}

function prepareGuard({ gitGuard, guard, startedAt, timeoutMs, wrapUpMs }) {
  const dir = mkdtempSync(join(dirname(gitGuard.configHome), "spend-guard-"));
  const limitsPath = join(dir, "limits.json");
  const markerPath = join(dir, "marker.json");
  const limits = {
    markerPath,
    totalUsd: guard.totalUsd,
    deadlineAt: startedAt + timeoutMs,
  };
  if (guard.stopAtUsd !== undefined) limits.stopAtUsd = guard.stopAtUsd;
  if (guard.startingUsd !== undefined) limits.startingUsd = guard.startingUsd;
  if (wrapUpMs !== undefined) limits.wrapUpAt = startedAt + wrapUpMs;
  if (guard.stopAfterRequests !== undefined) limits.stopAfterRequests = guard.stopAfterRequests;
  writeFileSync(limitsPath, JSON.stringify(limits));
  return { limitsPath, markerPath };
}

function readGuardMarker(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function applyGuardUsage(summary, runs) {
  const guardCost = Math.max(0, ...runs.map((run) => run.guard?.totalCostUsd ?? 0));
  const inFlight = runs.some((run) => run.inFlight);
  const usage = { ...summary.usage };
  if (guardCost > usage.cost) usage.cost = guardCost;
  if (inFlight) usage.inFlight = true;
  return { ...summary, usage };
}

export function sessionOf(jsonl) {
  for (const line of jsonl.split("\n")) {
    try {
      const id = JSON.parse(line).sessionID;
      if (typeof id === "string" && id) return id;
    } catch {}
  }
  return null;
}

export function wrapUpReason(summary, run) {
  if (run.stopReason === "wrap-up-cost") return "cost";
  if (run.stopReason === "wrap-up-time") return "time";
  if (!run.stopReason && !run.spawnError && run.code === 0 && summary.outcome === "no-text")
    return "no-text";
  return null;
}

export async function reviewModel({
  binary,
  cwd,
  configPath,
  wrapUpConfigPath,
  gitGuard,
  model,
  prompt,
  timeoutMs,
  costLimit = COST_LIMIT_PER_MODEL_USD,
}) {
  const deadline = Date.now() + timeoutMs;
  const reserveMs = Math.min(WRAP_UP_RESERVE_MAX_MS, Math.floor(timeoutMs / 5));
  const first = await runOpencode({
    binary,
    cwd,
    configPath,
    gitGuard,
    model,
    prompt,
    timeoutMs,
    costLimit,
    wrapUpCost: costLimit - WRAP_UP_RESERVE_USD,
    wrapUpMs: timeoutMs - reserveMs,
    guard: { totalUsd: costLimit, stopAtUsd: costLimit - WRAP_UP_RESERVE_USD },
  });
  const firstSummary = applyGuardUsage(summarizeEvents(first.stdout), [first]);
  const wrapUp = wrapUpReason(firstSummary, first);
  const session = wrapUp ? sessionOf(first.stdout) : null;
  const remainingMs = deadline - Date.now();
  const remainingUsd = costLimit - firstSummary.usage.cost;
  const skipped = !wrapUp
    ? null
    : !session
      ? "no-session"
      : firstSummary.usage.costUnknown
        ? "cost-unknown"
        : remainingUsd < WRAP_UP_MIN_USD
          ? "no-budget"
          : remainingMs < WRAP_UP_MIN_MS
            ? "no-time"
            : null;
  if (!wrapUp || skipped) {
    return {
      runs: [first],
      stdout: first.stdout,
      stderr: first.stderr,
      summary: firstSummary,
      wrapUp,
      wrapUpSkipped: skipped,
      outcome: runOutcome(firstSummary, first),
    };
  }
  const second = await runOpencode({
    binary,
    cwd,
    configPath: wrapUpConfigPath,
    gitGuard,
    model,
    prompt: WRAP_UP_PROMPT,
    session,
    stopOnToolCall: true,
    timeoutMs: remainingMs,
    costLimit: remainingUsd,
    guard: { totalUsd: costLimit, startingUsd: firstSummary.usage.cost },
  });
  const stdout = `${first.stdout}${first.stdout.endsWith("\n") ? "" : "\n"}${second.stdout}`;
  const secondSummary = summarizeEvents(second.stdout);
  const combined = applyGuardUsage(summarizeEvents(stdout), [first, second]);
  return {
    runs: [first, second],
    stdout,
    stderr: `${first.stderr}${second.stderr}`,
    summary: { ...combined, text: secondSummary.text || firstSummary.text },
    wrapUp,
    wrapUpSkipped: null,
    outcome: runOutcome(secondSummary, second),
  };
}

export function spentOf(records) {
  return records.reduce(
    (total, record) =>
      total +
      (record.costUnknown || record.inFlight
        ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
        : record.cost),
    0,
  );
}

export function budgetCheck({ mode, records, models, approvedUsd }) {
  const spent = spentOf(records);
  const thisRunMax = COST_LIMIT_PER_MODEL_USD * models.length;
  const total = spent + thisRunMax;
  const line = ASK_FIRST_LINE_USD[mode];
  if (total <= line) return null;
  if (approvedUsd !== undefined && total <= approvedUsd) return null;
  return `BUDGET_NEEDS_APPROVAL spent=${spent.toFixed(3)} thisRunMax=${thisRunMax.toFixed(3)} total=${total.toFixed(3)} askFirstLine=${line}${approvedUsd === undefined ? "" : ` approved=${approvedUsd}`}`;
}

export function readUsage(out) {
  const path = join(out, "usage.jsonl");
  if (!existsSync(path)) return [];
  return parseUsage(readFileSync(path, "utf8"), path);
}

export function resultLine(record) {
  return `REVIEW_RESULT round=${record.round} ${record.model} outcome=${record.outcome} wrapUp=${record.wrapUp ?? "none"}${record.wrapUpSkipped ? `-skipped-${record.wrapUpSkipped}` : ""} steps=${record.steps} input=${record.input} cacheRead=${record.cacheRead} output=${record.output} reasoning=${record.reasoning} cost=${record.cost.toFixed(4)}`;
}

export function lastCompleteRound(records, models = REVIEW_MODELS) {
  const reviews = records.filter((record) => record.mode === "code-review");
  const rounds = [...new Set(reviews.map((record) => record.round ?? 1))].sort((a, b) => b - a);
  for (const round of rounds) {
    const passed = reviews.filter(
      (record) => (record.round ?? 1) === round && record.outcome === "ok",
    );
    if (!models.every((model) => passed.some((record) => record.model === model))) continue;
    const heads = [...new Set(passed.map((record) => record.head))];
    if (heads.length !== 1)
      throw new Error(`REVIEW_ROUND_HEADS_DIFFER ${round} ${heads.join(",")}`);
    return { round, head: heads[0] };
  }
  return null;
}

function gitStatus(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}

export function assertReviewed({ repo, pr, mainRef = "origin/main", acceptUnreviewed }) {
  const ledgerPath = `${REVIEWS_DIR}/${reviewKey({ pr })}`;
  const head = git(["rev-parse", "HEAD"], repo);
  const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
  const records = shown.status === 0 ? parseUsage(shown.stdout, `HEAD:${ledgerPath}`) : null;
  const complete = records ? lastCompleteRound(records) : null;
  const problems = [];
  if (!records) problems.push("ledger-not-committed");
  else if (!complete) problems.push("no-complete-round");
  else if (gitStatus(["merge-base", "--is-ancestor", complete.head, head], repo).status !== 0)
    problems.push(`not-ancestor ${complete.head}`);
  else
    for (const file of git(["diff", "--name-only", complete.head, head], repo).split("\n"))
      if (file && !file.startsWith(`${ledgerPath}/`)) problems.push(`unreviewed ${file}`);
  if (gitStatus(["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`], repo).status !== 0)
    problems.push(`main-ref-missing ${mainRef}`);
  else if (gitStatus(["merge-base", "--is-ancestor", mainRef, head], repo).status !== 0)
    problems.push(`main-not-merged ${mainRef}`);
  const summary = `pr=${pr} round=${complete?.round ?? "none"} reviewed=${complete?.head ?? "none"} head=${head}`;
  const lines =
    problems.length === 0
      ? [`REVIEW_CURRENT ${summary}`]
      : [`REVIEW_NOT_CURRENT ${summary}`, ...problems.map((problem) => `  ${problem}`)];
  const overridden = problems.length > 0 && Boolean(acceptUnreviewed);
  if (overridden) {
    mkdirSync(join(repo, ledgerPath), { recursive: true });
    appendFileSync(
      join(repo, ledgerPath, "usage.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), mode: "override", cost: 0, head, quote: acceptUnreviewed, problems })}\n`,
    );
    lines.push(`REVIEW_OVERRIDE quote=${acceptUnreviewed}`);
  }
  return {
    round: complete?.round ?? null,
    reviewed: complete?.head ?? null,
    head,
    problems,
    lines,
    overridden,
  };
}

export function parseUsage(text, path) {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim())
    .map(({ line, number }) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        record = null;
      }
      const roundValid =
        record?.round === undefined || (Number.isSafeInteger(record.round) && record.round > 0);
      if (!Number.isFinite(record?.cost) || record.cost < 0 || !roundValid)
        throw new Error(`USAGE_LEDGER_INVALID ${path}:${number}`);
      return record;
    });
}

export function roundsOnDisk(out) {
  if (!existsSync(out)) return [];
  return readdirSync(out)
    .map((name) => /^round-(\d+)$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
}

export function nextRound(records, rounds = []) {
  const recorded = records.map((record) => record.round ?? 1);
  return Math.max(0, ...recorded, ...rounds) + 1;
}

export function roundForRun({ records, rounds, requested, models, head, prompts, promptsOnDisk }) {
  if (requested === undefined) return nextRound(records, rounds);
  const inRound = records.filter((record) => (record.round ?? 1) === requested);
  if (inRound.length === 0 && !rounds.includes(requested))
    throw new Error(`ROUND_NOT_FOUND ${requested}`);
  for (const model of models) {
    if (inRound.some((record) => record.model === model && record.outcome === "ok"))
      throw new Error(`ROUND_ALREADY_HAS_RESULT ${requested} ${model}`);
  }
  const heads = new Set(inRound.map((record) => record.head).filter(Boolean));
  if ([...heads].some((recorded) => recorded !== head))
    throw new Error(`ROUND_HEAD_MISMATCH ${requested} ${[...heads].join(",")} ${head}`);
  for (const model of models) {
    const onDisk = promptsOnDisk[model] ?? null;
    if (onDisk !== null && onDisk !== prompts[model])
      throw new Error(`ROUND_PROMPT_MISMATCH ${requested} ${model}`);
  }
  return requested;
}

export const KEPT_FILE_SUFFIXES = [".prompt.md", ".md", ".stderr.txt"];
export const RAW_FILE_SUFFIXES = [".jsonl", ".thinking.md"];

export function keepEarlierAttempt(roundDir, name, suffixes = KEPT_FILE_SUFFIXES) {
  if (!existsSync(roundDir)) return null;
  const present = suffixes.filter((suffix) => existsSync(join(roundDir, `${name}${suffix}`)));
  if (present.length === 0) return null;
  let attempt = 1;
  while (
    suffixes.some((suffix) => existsSync(join(roundDir, `${name}.attempt-${attempt}${suffix}`)))
  )
    attempt += 1;
  for (const suffix of present)
    renameSync(
      join(roundDir, `${name}${suffix}`),
      join(roundDir, `${name}.attempt-${attempt}${suffix}`),
    );
  return attempt;
}

export function runOutcome(summary, run) {
  if (run.spawnError) return "spawn-error";
  if (run.stopReason) return run.stopReason;
  if (summary.outcome !== "ok") return summary.outcome;
  if (run.signal) return `signal-${run.signal}`;
  if (run.code !== 0) return `exit-${run.code}`;
  return "ok";
}

export function probePlan(workRoot, blameFile = "AGENTS.md") {
  const marker = `OUTSIDE_REPO_MARKER_${randomBytes(8).toString("hex")}`;
  const outsideA = join(workRoot, "outside-a.txt");
  const outsideB = join(workRoot, "outside-b.txt");
  const target = (name) => join(workRoot, `probe-${name}`);
  const bash = (command) => ({ tool: "bash", args: { command, description: "probe" } });
  const writes = [
    ["output", (f) => `git log -1 --output=${f}`],
    ["abbrev-out", (f) => `git diff --out=${f} HEAD`],
    ["abbrev-outp", (f) => `git diff --outp=${f} HEAD`],
    ["quoted-output", (f) => `git log -1 "--output=${f}"`],
    ["escaped-output", (f) => `git log -1 --out\\put=${f}`],
    ["short-o", (f) => `git diff -o${f} HEAD`],
    ["redirect", (f) => `git log -1 > ${f}`],
    ["append", (f) => `git log -1 >> ${f}`],
    ["stderr", (f) => `git log -1 2>${f}`],
    ["pipe", (f) => `git log -1 | tee ${f}`],
    ["backtick", (f) => `git log -1 \`touch ${f}\``],
    ["substitution", (f) => `git log -1 $(touch ${f})`],
    ["semicolon", (f) => `git log -1; touch ${f}`],
    ["and", (f) => `git log -1 && touch ${f}`],
    ["newline", (f) => `git log -1\ntouch ${f}`],
    ["difftool", (f) => `git difftool -y -x "touch ${f}" HEAD~1 HEAD`],
  ].map(([name, build]) => ({ kind: "write", file: target(name), ...bash(build(target(name))) }));
  const insideName = (name) => `probe-inside-${name}`;
  const insideWrites = [
    ["redirect", (f) => `git log -1 > ${f}`],
    ["clobber", (f) => `git log -1 >| ${f}`],
    ["both", (f) => `git log -1 &> ${f}`],
    ["output", (f) => `git log -1 --output=${f}`],
    ["cd-redirect", (f) => `cd ${join(workRoot, "repo")} && git log -1 > ${f}`],
    [
      "cd-devnull",
      (f) => `cd ${join(workRoot, "repo")} && git log -1 > /dev/null; git log -1 > ${f}`,
    ],
  ].map(([name, build]) => ({
    kind: "write",
    file: join(workRoot, "repo", insideName(name)),
    ...bash(build(insideName(name))),
  }));
  const reads = [
    bash(`git diff --no-index ${outsideA} ${outsideB}`),
    bash(`git diff --no-inde ${outsideA} ${outsideB}`),
    bash(`git diff "--no-index" ${outsideA} ${outsideB}`),
    bash(`git diff --no\\-index ${outsideA} ${outsideB}`),
    bash(`git diff\t--no-index ${outsideA} ${outsideB}`),
    bash(`git blame --contents ${outsideA} -- AGENTS.md`),
    bash(`git blame -S ${outsideA} -- AGENTS.md`),
    bash(`git blame -nS${outsideA} -- AGENTS.md`),
    bash(`git blame --ignore-revs-file=${outsideA} -- AGENTS.md`),
    bash(`git diff -pO${outsideA} HEAD~1 HEAD`),
    bash(`git diff --pathspec-from-file=${outsideA} HEAD~1 HEAD`),
    bash("git show --help"),
    bash(`git show HEAD:${REVIEWS_DIR}`),
    bash("git diff -a HEAD~1 HEAD"),
    { tool: "read", args: { filePath: outsideA } },
    { tool: "read", args: { filePath: "../outside-a.txt" } },
    { tool: "read", args: { filePath: "/proc/self/environ" } },
    { tool: "grep", args: { pattern: marker, path: ".." } },
    { tool: "grep", args: { pattern: marker, path: workRoot } },
    { tool: "glob", args: { pattern: "outside-*.txt", path: workRoot }, leak: "outside-b.txt" },
  ].map((probe) => ({ kind: "read", leak: marker, ...probe }));
  const contained = [
    bash("export GIT_EXTERNAL_DIFF=env; git diff HEAD~1 HEAD"),
    bash("export GIT_EXTERNAL_DIFF=touch; git diff HEAD~1 HEAD"),
    bash(
      `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=env; git diff HEAD~1 HEAD`,
    ),
    bash("export NODE_OPTIONS=--version; git log -1 --oneline"),
    bash(`git log $${REVIEW_PARENT_CANARY_ENV}`),
  ].map((probe) => ({ kind: "contained", leak: marker, ...probe }));
  const records = [
    { tool: "glob", args: { pattern: "**/usage.jsonl", path: ".agents" }, leak: "usage.jsonl" },
    {
      tool: "bash",
      args: {
        command: `git log -p -3 -- '${REVIEWS_DIR.replace("reviews", "rev*")}'`,
        description: "probe",
      },
      leak: '"cacheRead"',
    },
  ].map((probe) => ({ kind: "contained", ...probe }));
  return {
    marker,
    outsideFiles: [outsideA, outsideB],
    probes: [
      { kind: "allowed", ...bash("git log -1 --oneline") },
      { kind: "allowed", ...bash("git diff --stat HEAD") },
      { kind: "allowed", ...bash("git show --stat HEAD") },
      { kind: "allowed", ...bash(`git blame -L 1,1 -- ${blameFile}`) },
      { kind: "allowed", ...bash("git status --short") },
      ...writes,
      ...insideWrites,
      ...reads,
      ...contained,
      ...records,
    ],
  };
}

function probeKey(tool, args) {
  return `${tool} ${JSON.stringify(args?.command ?? args?.filePath ?? [args?.pattern, args?.path])}`;
}

function startProbeServer(probes) {
  const requests = [];
  const served = new Map();
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      requests.push(parsed);
      const send = (payload) =>
        response.write(
          `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: parsed.model, ...payload })}\n\n`,
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const next = served.get(parsed.model) ?? 0;
      if (hasTools && next < probes.length) {
        served.set(parsed.model, next + 1);
        const probe = probes[next];
        send({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `probe-call-${next}`,
                    type: "function",
                    function: { name: probe.tool, arguments: JSON.stringify(probe.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      } else {
        send({
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        });
        send({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () =>
      resolvePromise({ server, requests, port: server.address().port }),
    );
  });
}

export const REFUSAL_TEXTS = [
  "The user has specified a rule which prevents you",
  GIT_REFUSED,
  ": restricted",
];

export function probeRefused(call) {
  return REFUSAL_TEXTS.some((text) => String(call.output ?? "").includes(text));
}

export function projectInstructionLine(copy) {
  const path = join(copy, "AGENTS.md");
  if (!existsSync(path)) return null;
  return (
    readFileSync(path, "utf8")
      .split("\n")
      .find((line) => line.startsWith("# ")) ?? null
  );
}

export function checkProbeRequests({
  mode,
  requests,
  plan,
  toolCalls,
  writtenFiles,
  shellCalls,
  projectInstructions,
}) {
  const problems = [];
  const allowedCount = plan.probes.filter((probe) => probe.kind === "allowed").length;
  if (shellCalls !== undefined && shellCalls < allowedCount)
    problems.push(`PROBE_SHELL_NOT_USED ${shellCalls}`);
  const main = requests.filter(
    (request) => Array.isArray(request.tools) && request.tools.length > 0,
  );
  if (main.length === 0) problems.push("PROBE_NO_TOOL_REQUEST");
  for (const request of main) {
    const tools = request.tools.map((tool) => tool.function?.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools(mode))) {
      problems.push(`PROBE_TOOLS_UNEXPECTED ${request.model} ${tools.join(",")}`);
    }
    if (
      projectInstructions &&
      (request.messages ?? [])
        .filter((message) => message.role === "system" || message.role === "user")
        .some((message) => JSON.stringify(message.content).includes(projectInstructions))
    )
      problems.push(`PROBE_PROJECT_INSTRUCTIONS_LOADED ${request.model}`);
    const modelLimit = MODEL_OUTPUT_LIMITS[String(request.model).split("/").pop()];
    if (modelLimit === undefined) problems.push(`PROBE_MODEL_UNKNOWN ${request.model}`);
    if (!(request.max_tokens >= MIN_OUTPUT_TOKENS) || !(request.max_tokens <= modelLimit))
      problems.push(`PROBE_OUTPUT_CAP ${request.model} ${request.max_tokens}`);
    if (request.reasoning_effort !== REASONING_VARIANT) {
      problems.push(`PROBE_REASONING ${request.model} ${request.reasoning_effort}`);
    }
  }
  const callsByKey = new Map();
  for (const call of toolCalls) {
    const key = probeKey(call.tool, call.input);
    callsByKey.set(key, [...(callsByKey.get(key) ?? []), call]);
  }
  for (const probe of plan.probes) {
    const calls = callsByKey.get(probeKey(probe.tool, probe.args)) ?? [];
    const label = `${probe.tool} ${probe.args.command ?? probe.args.filePath ?? probe.args.pattern}`;
    if (calls.length === 0) {
      problems.push(`PROBE_NOT_RUN ${label}`);
      continue;
    }
    for (const call of calls) {
      if (probe.kind === "allowed" && (call.status !== "completed" || probeRefused(call))) {
        problems.push(`PROBE_READ_COMMAND_BLOCKED ${label}`);
      }
      if (probe.leak && call.output.includes(probe.leak)) {
        problems.push(`PROBE_READ_OUTSIDE ${label}`);
      }
      if ((probe.kind === "write" || probe.kind === "read") && !probeRefused(call)) {
        problems.push(`PROBE_NOT_REFUSED ${label}`);
      }
    }
  }
  for (const file of writtenFiles) problems.push(`PROBE_WROTE_FILE ${file}`);
  return problems;
}

async function selfCheck({ binary, copy, workRoot, gitGuard, mode, timeoutMs }) {
  const plan = probePlan(
    workRoot,
    git(["ls-files"], copy)
      .split("\n")
      .find((file) => file && !/\s/.test(file)),
  );
  for (const file of plan.outsideFiles) writeFileSync(file, `${plan.marker}\n${file}\n`);
  const { server, requests, port } = await startProbeServer(plan.probes);
  const configPath = join(workRoot, "probe-opencode.json");
  writeFileSync(
    configPath,
    JSON.stringify(reviewConfig({ mode, baseURL: `http://127.0.0.1:${port}/v1` }), null, 2),
  );
  try {
    const problems = [];
    for (const model of REVIEW_MODELS) {
      const before = requests.length;
      const run = await runOpencode({
        binary,
        cwd: copy,
        configPath,
        gitGuard,
        model,
        prompt: "probe",
        timeoutMs,
        extraEnv: { [REVIEW_CANARY_ENV]: plan.marker },
        parentEnv: { ...process.env, [REVIEW_PARENT_CANARY_ENV]: plan.marker },
        guard: { totalUsd: GUARD_PROBE_OPEN_USD },
      });
      if (!run.guard?.loaded) problems.push(`${model}: GUARD_NOT_LOADED`);
      const summary = summarizeEvents(run.stdout);
      const writtenFiles = plan.probes
        .filter((probe) => probe.kind === "write" && existsSync(probe.file))
        .map((probe) => probe.file);
      for (const file of writtenFiles) rmSync(file, { force: true });
      const changed = git(["status", "--porcelain", "--untracked-files=all"], copy);
      if (changed) {
        writtenFiles.push(...changed.split("\n").map((line) => `copy:${line.slice(3)}`));
        git(["checkout", "--quiet", "--", "."], copy);
        git(["clean", "-fdq"], copy);
      }
      const shellLog = join(workRoot, SHELL_LOG_NAME);
      const shellCalls = existsSync(shellLog)
        ? readFileSync(shellLog, "utf8").split("\n").filter(Boolean).length
        : 0;
      rmSync(shellLog, { force: true });
      problems.push(
        ...checkProbeRequests({
          mode,
          requests: requests.slice(before),
          plan,
          toolCalls: summary.toolCalls,
          writtenFiles,
          shellCalls,
          projectInstructions: projectInstructionLine(copy),
        }).map((problem) => `${model}: ${problem}`),
      );
    }
    problems.push(...(await guardProbe({ binary, copy, workRoot, gitGuard, mode })));
    return problems;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

export const GUARD_PROBE_OPEN_USD = 1e9;
export const GUARD_PROBE_REQUESTS = 3;

function startLoopServer() {
  let mainRequests = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const main = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      if (main) mainRequests += 1;
      const send = (payload) =>
        response.write(
          `data: ${JSON.stringify({ id: "loop", object: "chat.completion.chunk", created: 1, model: parsed.model, ...payload })}\n\n`,
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = { role: "assistant" };
      if (main) {
        delta.tool_calls = [
          {
            index: 0,
            id: `loop-call-${mainRequests}`,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: "AGENTS.md" }) },
          },
        ];
      } else delta.content = "title";
      send({ choices: [{ index: 0, delta, finish_reason: null }] });
      send({
        choices: [{ index: 0, delta: {}, finish_reason: main ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, mainRequests: () => mainRequests, port: server.address().port }),
    ),
  );
}

async function guardProbe({ binary, copy, workRoot, gitGuard, mode }) {
  const { server, mainRequests, port } = await startLoopServer();
  const configPath = join(workRoot, "guard-probe-opencode.json");
  writeFileSync(
    configPath,
    JSON.stringify(reviewConfig({ mode, baseURL: `http://127.0.0.1:${port}/v1` }), null, 2),
  );
  try {
    const run = await runOpencode({
      binary,
      cwd: copy,
      configPath,
      gitGuard,
      model: REVIEW_MODELS[0],
      prompt: "probe",
      timeoutMs: 20000,
      guard: { totalUsd: GUARD_PROBE_OPEN_USD, stopAfterRequests: GUARD_PROBE_REQUESTS },
    });
    const problems = [];
    if (!run.guard?.loaded) problems.push("GUARD_PROBE_NOT_LOADED");
    else if (mainRequests() !== GUARD_PROBE_REQUESTS)
      problems.push(`GUARD_PROBE_REQUESTS expected=${GUARD_PROBE_REQUESTS} got=${mainRequests()}`);
    else if (run.stopReason !== "request-limit")
      problems.push(`GUARD_PROBE_REASON ${run.stopReason}`);
    return problems;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

export function removeUnsafeProjectFiles(copy) {
  const removed = [];
  const root = `${resolve(copy)}${sep}`;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const outsideLink =
        entry.isSymbolicLink() && !resolve(dir, readlinkSync(path)).startsWith(root);
      const unsafeName =
        entry.name === ".opencode" ||
        /^opencode\.jsonc?$/.test(entry.name) ||
        isSecretEnvName(entry.name);
      if (outsideLink || unsafeName) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(copy);
  return removed;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0)
    throw new Error(`GIT_FAILED git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export const QUESTIONS_PATH = ".agents/instructions/model-review.md";

export function questionsSource(repo, commits) {
  return git(["show", `${commits.base ?? commits.head}:${QUESTIONS_PATH}`], repo);
}

export function isSecretEnvName(name) {
  return /^\.env(?!.*\.(example|sample|template)$)/.test(name);
}

export function envFilesInHistory(copy) {
  return [
    ...new Set(
      git(["rev-list", "--all", "--objects"], copy)
        .split("\n")
        .filter((line) => line.includes(" "))
        .map((line) => line.slice(line.indexOf(" ") + 1))
        .filter((path) => isSecretEnvName(path.split("/").pop())),
    ),
  ].sort();
}

export function resolveCommits(repo, { head, base, previous }) {
  const resolveOne = (ref) =>
    ref ? git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo) : undefined;
  return { head: resolveOne(head), base: resolveOne(base), previous: resolveOne(previous) };
}

export function prepareCopy({ repo, copy, commits, workRoot }) {
  git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", repo, copy], workRoot);
  git(["fetch", "--quiet", "origin", "+refs/*:refs/source/*"], copy);
  const envFiles = envFilesInHistory(copy);
  if (envFiles.length > 0) throw new Error(`ENV_FILE_IN_HISTORY ${envFiles.join(" ")}`);
  git(["sparse-checkout", "set", "--no-cone", "/*", `!/${REVIEWS_DIR}/`], copy);
  mkdirSync(join(copy, ".git", "info"), { recursive: true });
  writeFileSync(join(copy, ".git", "info", "attributes"), `/${REVIEWS_DIR}/** -diff\n`);
  git(["checkout", "--quiet", "--detach", commits.head], copy);
  git(["remote", "remove", "origin"], copy);
  const refs = git(["for-each-ref", "--format=%(refname)"], copy).split("\n").filter(Boolean);
  const pruned = spawnSync("git", ["update-ref", "--stdin"], {
    cwd: copy,
    input: refs.map((ref) => `delete ${ref}\n`).join(""),
  });
  if (pruned.status !== 0) throw new Error("GIT_FAILED update-ref --stdin");
  for (const [name, commit] of Object.entries(commits).filter(([, value]) => value))
    git(["update-ref", `refs/review/${name}`, commit], copy);
  git(["reflog", "expire", "--expire=now", "--all"], copy);
  rmSync(join(copy, ".git", "FETCH_HEAD"), { force: true });
  for (const commit of [commits.base, commits.previous].filter(Boolean))
    git(["cat-file", "-e", `${commit}^{commit}`], copy);
  return removeUnsafeProjectFiles(copy);
}

export const REVIEWS_DIR = ".agents/reviews";
export const TOPIC_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export function reviewKey({ pr, topic }) {
  if (pr !== undefined) return `pr-${pr}`;
  if (topic !== undefined) return `topic-${topic}`;
  throw new Error("REVIEW_KEY_MISSING");
}

export function reviewDir(repo, options) {
  return join(repo, REVIEWS_DIR, reviewKey(options));
}

export function rawDir(options, round) {
  return join(tmpdir(), "himawari-review-raw", reviewKey(options), `round-${round}`);
}

export function promptFileName(model) {
  return `${model.split("/").pop()}.prompt.md`;
}

export function parseArgs(argv) {
  const options = {
    mode: "code-review",
    repo: repoRoot,
    timeoutMinutes: 25,
    models: REVIEW_MODELS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    const take = () => {
      index += 1;
      if (value === undefined) throw new Error(`ARG_MISSING_VALUE ${key}`);
      return value;
    };
    if (key === "--mode") options.mode = take();
    else if (key === "--repo") options.repo = resolve(take());
    else if (key === "--head") options.head = take();
    else if (key === "--base") options.base = take();
    else if (key === "--previous") options.previous = take();
    else if (key === "--brief") options.brief = resolve(take());
    else if (key === "--out") options.out = resolve(take());
    else if (key === "--pr") {
      options.pr = Number(take());
      if (!Number.isSafeInteger(options.pr) || options.pr <= 0) throw new Error("ARG_INVALID --pr");
    } else if (key === "--topic") {
      options.topic = take();
      if (!TOPIC_PATTERN.test(options.topic)) throw new Error("ARG_INVALID --topic");
    } else if (key === "--timeout-minutes") options.timeoutMinutes = Number(take());
    else if (key === "--self-check-only") options.selfCheckOnly = true;
    else if (key === "--assert-reviewed") options.assertReviewed = true;
    else if (key === "--main-ref") options.mainRef = take();
    else if (key === "--accept-unreviewed") {
      options.acceptUnreviewed = take();
      if (!options.acceptUnreviewed.trim()) throw new Error("ARG_INVALID --accept-unreviewed");
    } else if (key === "--models") {
      const names = take()
        .split(",")
        .map((name) => name.trim());
      const models = names.map((name) =>
        REVIEW_MODELS.find((model) => name && (model === name || model.endsWith(`/${name}`))),
      );
      if (
        names.length === 0 ||
        models.some((model) => !model) ||
        new Set(models).size !== models.length
      )
        throw new Error("ARG_INVALID --models");
      options.models = models;
    } else if (key === "--round") {
      options.round = Number(take());
      if (!Number.isSafeInteger(options.round) || options.round <= 0)
        throw new Error("ARG_INVALID --round");
    } else if (key === "--approved-usd") {
      options.approvedUsd = Number(take());
      if (!Number.isFinite(options.approvedUsd) || options.approvedUsd <= 0)
        throw new Error("ARG_INVALID --approved-usd");
    } else throw new Error(`ARG_UNKNOWN ${key}`);
  }
  if (!MODES.includes(options.mode)) throw new Error(`MODE_UNKNOWN ${options.mode}`);
  if (options.assertReviewed) {
    if (options.pr === undefined) throw new Error("ARG_REQUIRED --pr");
    return options;
  }
  if (options.acceptUnreviewed !== undefined)
    throw new Error("ARG_ACCEPT_UNREVIEWED_ONLY_WITH_ASSERT");
  for (const required of ["head", "brief"]) {
    if (!options[required]) throw new Error(`ARG_REQUIRED --${required}`);
  }
  if (options.mode === "code-review" && !options.base) throw new Error("ARG_REQUIRED --base");
  if (!options.selfCheckOnly) {
    if (options.out !== undefined) throw new Error("ARG_OUT_ONLY_FOR_SELF_CHECK");
    if (options.pr !== undefined && options.topic !== undefined)
      throw new Error("ARG_PR_AND_TOPIC");
    if (options.mode === "code-review" && options.pr === undefined)
      throw new Error("ARG_REQUIRED --pr");
    if (options.mode !== "code-review" && options.topic === undefined)
      throw new Error("ARG_REQUIRED --topic");
    options.out = reviewDir(options.repo, options);
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("ARG_INVALID --timeout-minutes");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.assertReviewed) {
    const result = assertReviewed(options);
    for (const line of result.lines) console.log(line);
    if (result.problems.length > 0 && !result.overridden) process.exitCode = 5;
    return;
  }
  const timeoutMs = options.timeoutMinutes * 60 * 1000;
  const commits = resolveCommits(options.repo, options);
  const questions = reviewQuestions(questionsSource(options.repo, commits));
  const brief = readFileSync(options.brief, "utf8");
  const prompts = Object.fromEntries(
    options.models.map((model) => [
      model,
      buildPrompt({ ...options, ...commits, model, questions, brief }),
    ]),
  );
  for (const prompt of Object.values(prompts))
    if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
  const records = options.selfCheckOnly ? [] : readUsage(options.out);
  const overBudget = options.selfCheckOnly
    ? null
    : budgetCheck({
        mode: options.mode,
        records,
        models: options.models,
        approvedUsd: options.approvedUsd,
      });
  if (overBudget) throw new Error(overBudget);
  const promptOnDisk = (model) => {
    if (options.round === undefined) return null;
    const path = join(options.out, `round-${options.round}`, promptFileName(model));
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const round = options.selfCheckOnly
    ? 0
    : roundForRun({
        records,
        rounds: roundsOnDisk(options.out),
        requested: options.round,
        models: options.models,
        head: commits.head,
        prompts,
        promptsOnDisk: Object.fromEntries(
          options.models.map((model) => [model, promptOnDisk(model)]),
        ),
      });
  const binary = opencodeBinary();
  const workRoot = mkdtempSync(join(tmpdir(), "opencode-review-"));
  const copy = join(workRoot, "repo");
  const cleanup = () => {
    for (const child of activeChildren) killProcessGroup(child, "SIGKILL");
    rmSync(workRoot, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const removed = prepareCopy({ repo: options.repo, copy, commits, workRoot });
    if (removed.length > 0) console.log(`UNSAFE_PROJECT_FILES_REMOVED ${removed.length}`);
    const gitGuard = installGitGuard(workRoot);
    const problems = await selfCheck({
      binary,
      copy,
      workRoot,
      gitGuard,
      mode: options.mode,
      timeoutMs: 180000,
    });
    if (problems.length > 0) {
      console.error(`SELF_CHECK_FAILED ${problems.join(" | ")}`);
      process.exitCode = 3;
      return;
    }
    console.log("SELF_CHECK_OK");
    if (options.selfCheckOnly) return;
    const configPath = join(workRoot, "opencode.json");
    writeFileSync(configPath, JSON.stringify(reviewConfig({ mode: options.mode }), null, 2));
    const wrapUpConfigPath = join(workRoot, "opencode-wrap-up.json");
    writeFileSync(
      wrapUpConfigPath,
      JSON.stringify(reviewConfig({ mode: options.mode, wrapUp: true }), null, 2),
    );
    const roundDir = join(options.out, `round-${round}`);
    const roundRawDir = rawDir(options, round);
    mkdirSync(roundDir, { recursive: true });
    mkdirSync(roundRawDir, { recursive: true });
    console.log(`REVIEW_RAW_DIR ${roundRawDir}`);
    const results = await Promise.all(
      options.models.map(async (model) => {
        const name = model.split("/").pop();
        const prompt = prompts[model];
        keepEarlierAttempt(roundDir, name);
        keepEarlierAttempt(roundRawDir, name, RAW_FILE_SUFFIXES);
        writeFileSync(join(roundDir, promptFileName(model)), prompt);
        const review = await reviewModel({
          binary,
          cwd: copy,
          configPath,
          wrapUpConfigPath,
          gitGuard,
          model,
          prompt,
          timeoutMs,
        });
        writeFileSync(join(roundRawDir, `${name}.jsonl`), review.stdout);
        const { summary } = review;
        writeFileSync(join(roundDir, `${name}.md`), `${summary.text}\n`);
        if (summary.thinking)
          writeFileSync(join(roundRawDir, `${name}.thinking.md`), `${summary.thinking}\n`);
        const record = {
          at: new Date().toISOString(),
          round,
          mode: options.mode,
          model,
          head: commits.head,
          base: commits.base ?? null,
          previous: commits.previous ?? null,
          promptSha256: createHash("sha256").update(prompt).digest("hex"),
          outcome: review.outcome,
          wrapUp: review.wrapUp,
          wrapUpSkipped: review.wrapUpSkipped,
          lastReason: summary.lastReason,
          exitCode: review.runs.at(-1).code,
          ...summary.usage,
          toolCalls: summary.toolCalls.length,
        };
        appendFileSync(join(options.out, "usage.jsonl"), `${JSON.stringify(record)}\n`);
        if (record.outcome !== "ok" && review.stderr.trim()) {
          writeFileSync(join(roundDir, `${name}.stderr.txt`), review.stderr);
        }
        return record;
      }),
    );
    for (const record of results) {
      console.log(resultLine(record));
    }
    const totalSpent = spentOf(readUsage(options.out));
    console.log(`REVIEW_SPENT_TOTAL ${totalSpent.toFixed(4)} ${options.out}`);
    if (results.some((record) => record.outcome !== "ok")) process.exitCode = 4;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
