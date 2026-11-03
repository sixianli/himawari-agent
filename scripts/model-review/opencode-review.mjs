#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_VERSION = "1.19.5";
export const REVIEW_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"];
export const REASONING_VARIANT = "high";
export const OUTPUT_TOKEN_MAX = 200000;
export const MIN_OUTPUT_TOKENS = 100000;
export const STEP_LIMIT = 50;
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
];
const GIT_SHORT_VALUE_LETTERS = "SGLUnlMCBXI";
export const GIT_REFUSED = "REVIEW_GIT_REFUSED";
export const COST_LIMIT_PER_MODEL_USD = 0.2;
export const RULE_16_SENTENCE = "列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function reviewConfig({ mode, baseURL } = {}) {
  if (!MODES.includes(mode)) throw new Error(`MODE_UNKNOWN ${mode}`);
  const bash = { "*": "deny" };
  for (const command of GIT_READ_COMMANDS) {
    bash[command] = "allow";
    bash[`${command} *`] = "allow";
  }
  for (const pattern of WRITE_OR_OUTSIDE_PATTERNS) bash[pattern] = "deny";
  const providerOptions = { apiKey: "placeholder" };
  if (baseURL) providerOptions.baseURL = baseURL;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: { "opencode-go": { options: providerOptions } },
    agent: { build: { steps: STEP_LIMIT } },
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
    task: "下面只给了问题、目标和约束，没有给出任何人的方案。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。",
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
    `你能用的工具：read、grep、glob，以及 ${GIT_READ_COMMANDS.join("、")} 这几条 git 命令。不能修改任何文件，不能运行别的命令。${text.network}`,
    text.task,
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
      usage.cost += part.cost ?? 0;
      lastReason = part.reason ?? null;
    }
  }
  const text = texts.join("\n").trim();
  let outcome = "ok";
  if (lastReason === "length") outcome = "truncated";
  else if (!text) outcome = "no-text";
  return { outcome, lastReason, text, usage, toolCalls };
}

export function opencodeBinary() {
  if (process.env.HIMAWARI_OPENCODE_BIN) return process.env.HIMAWARI_OPENCODE_BIN;
  const prefix = join(homedir(), ".cache", `himawari-opencode-${OPENCODE_VERSION}`);
  const binary = join(prefix, "node_modules", ".bin", "opencode");
  if (!existsSync(binary)) {
    mkdirSync(prefix, { recursive: true });
    const install = spawnSync(
      "npm",
      ["install", "--prefix", prefix, "--no-save", `opencode-ai@${OPENCODE_VERSION}`],
      {
        stdio: "inherit",
      },
    );
    if (install.status !== 0 || !existsSync(binary)) throw new Error("OPENCODE_INSTALL_FAILED");
  }
  return binary;
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

function shortOptionProblem(subcommand, letters) {
  for (const letter of letters) {
    if (letter === "o" || letter === "O") return true;
    if (subcommand === "blame" && letter === "S") return true;
    if (subcommand === "blame" && letter === "n") continue;
    if (GIT_SHORT_VALUE_LETTERS.includes(letter)) return false;
  }
  return false;
}

export function checkGitArgs(args) {
  if (!GIT_SUBCOMMANDS.includes(args[0])) return `subcommand ${args[0] ?? "(none)"}`;
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
export const SANDBOX_KEPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"];
export const SANDBOX_HIDDEN_DIRS = [
  "/root",
  "/home",
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  "/run",
  "/mnt",
];
export const SANDBOX_NOT_READ_ONLY = "SANDBOX_NOT_READ_ONLY";
export const SANDBOX_CANARY_ENV = "REVIEW_SANDBOX_CANARY";

export function gitChildEnv(env) {
  const kept = Object.fromEntries(
    SANDBOX_KEPT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
  return { ...kept, ...GIT_ENV };
}

function sandboxScript({ copy, binDir, realBash }) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const forced = Object.entries(GIT_ENV)
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(" ");
  return [
    "set -e",
    `COPY=${quote(copy)}`,
    `GUARD=${quote(binDir)}`,
    'START="$1"',
    "shift",
    "mount -t tmpfs tmpfs /mnt",
    "mkdir /mnt/copy /mnt/guard",
    'mount --rbind "$COPY" /mnt/copy',
    'mount --bind "$GUARD" /mnt/guard',
    `for dir in ${SANDBOX_HIDDEN_DIRS.join(" ")}; do`,
    '  if [ -d "$dir" ] && [ "$dir" != /mnt ]; then mount -t tmpfs tmpfs "$dir"; fi',
    "done",
    'mkdir -p "$COPY" "$GUARD"',
    'mount --move /mnt/copy "$COPY"',
    'mount --move /mnt/guard "$GUARD"',
    "umount /mnt",
    "mount -t tmpfs tmpfs /mnt",
    "awk '{print $5}' /proc/self/mountinfo | sort -r | while read -r point; do",
    '  mount -o remount,bind,ro "$point" 2>/dev/null || mount -o remount,ro "$point" 2>/dev/null || true',
    "done",
    'WRITABLE=""',
    "for point in $(awk '{print $5}' /proc/self/mountinfo | sort -u); do",
    '  if [ -d "$point" ]; then probe="$point/.review-sandbox-probe"; else probe="$point"; fi',
    '  if [ -d "$point" ] || [ -f "$point" ]; then',
    '    if (: >> "$probe") 2>/dev/null; then WRITABLE="$WRITABLE $point"; [ -d "$point" ] && rm -f "$probe"; fi',
    "  fi",
    "done",
    `if [ -n "$WRITABLE" ]; then echo ${SANDBOX_NOT_READ_ONLY}$WRITABLE >&2; exit 97; fi`,
    `cd "$START"`,
    `exec env -i PATH=${quote(`${binDir}:/usr/local/bin:/usr/bin:/bin`)} HOME=/nonexistent LANG=C.UTF-8 ${forced} ${quote(realBash)} -r "$@"`,
    "",
  ].join("\n");
}

export function installGitGuard(workRoot, copy = join(workRoot, "repo")) {
  const which = (name) =>
    spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  const realGit = which("git");
  const realBash = which("bash");
  const unshare = which("unshare");
  if (!realGit) throw new Error("GIT_NOT_FOUND");
  if (!realBash) throw new Error("BASH_NOT_FOUND");
  if (!unshare) throw new Error("UNSHARE_NOT_FOUND");
  const binDir = join(workRoot, "guard-bin");
  mkdirSync(binDir);
  const modulePath = join(binDir, "review-guard.mjs");
  writeFileSync(modulePath, readFileSync(fileURLToPath(import.meta.url)));
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
  const inner = join(shellDir, "sandbox.sh");
  writeFileSync(inner, sandboxScript({ copy, binDir, realBash }));
  const shell = join(shellDir, "bash");
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      `exec ${JSON.stringify(unshare)} --user --map-root-user --net --mount --pid --fork --mount-proc -- /bin/sh ${JSON.stringify(inner)} "$(pwd)" "$@"`,
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
  extraEnv = {},
}) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    let cost = 0;
    let stopReason = null;
    let settled = false;
    const child = spawn(
      binary,
      ["run", "--format", "json", "-m", model, "--variant", REASONING_VARIANT, prompt],
      {
        cwd,
        env: {
          ...process.env,
          PWD: cwd,
          OPENCODE_CONFIG: configPath,
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          XDG_CONFIG_HOME: gitGuard.configHome,
          OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(OUTPUT_TOKEN_MAX),
          GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: "true",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PAGER: "cat",
          PAGER: "cat",
          PATH: `${gitGuard.binDir}${delimiter}${process.env.PATH ?? ""}`,
          SHELL: gitGuard.shell,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    activeChildren.add(child);
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 10000).unref();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child, "SIGKILL");
      activeChildren.delete(child);
      resolvePromise({ stdout, stderr, stopReason, ...result });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.includes('"step_finish"')) continue;
        let stepCost;
        try {
          stepCost = JSON.parse(line).part?.cost;
        } catch {}
        if (typeof stepCost !== "number") stop("cost-unknown");
        else cost += stepCost;
      }
      if (costLimit !== undefined && cost > costLimit) stop("cost-limit");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
    child.on("exit", () => killProcessGroup(child, "SIGKILL"));
    child.on("close", (code, signal) => finish({ code, signal }));
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
  });
}

export function runOutcome(summary, run) {
  if (run.spawnError) return "spawn-error";
  if (run.stopReason) return run.stopReason;
  if (summary.outcome !== "ok") return summary.outcome;
  if (run.signal) return `signal-${run.signal}`;
  if (run.code !== 0) return `exit-${run.code}`;
  return "ok";
}

export function probePlan(workRoot) {
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
    { tool: "read", args: { filePath: outsideA } },
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
  ].map((probe) => ({ kind: "contained", leak: marker, ...probe }));
  return {
    marker,
    outsideFiles: [outsideA, outsideB],
    probes: [
      { kind: "allowed", ...bash("git log -1 --oneline") },
      ...writes,
      ...insideWrites,
      ...reads,
      ...contained,
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

export function checkProbeRequests({ mode, requests, plan, toolCalls, writtenFiles }) {
  const problems = [];
  const main = requests.filter(
    (request) => Array.isArray(request.tools) && request.tools.length > 0,
  );
  if (main.length === 0) problems.push("PROBE_NO_TOOL_REQUEST");
  for (const request of main) {
    const tools = request.tools.map((tool) => tool.function?.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools(mode))) {
      problems.push(`PROBE_TOOLS_UNEXPECTED ${request.model} ${tools.join(",")}`);
    }
    if (!(request.max_tokens >= MIN_OUTPUT_TOKENS))
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
  const plan = probePlan(workRoot);
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
        extraEnv: { [SANDBOX_CANARY_ENV]: plan.marker },
      });
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
      problems.push(
        ...checkProbeRequests({
          mode,
          requests: requests.slice(before),
          plan,
          toolCalls: summary.toolCalls,
          writtenFiles,
        }).map((problem) => `${model}: ${problem}`),
      );
    }
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

export function parseArgs(argv) {
  const options = { mode: "code-review", repo: repoRoot, timeoutMinutes: 25 };
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
    else if (key === "--timeout-minutes") options.timeoutMinutes = Number(take());
    else if (key === "--self-check-only") options.selfCheckOnly = true;
    else throw new Error(`ARG_UNKNOWN ${key}`);
  }
  if (!MODES.includes(options.mode)) throw new Error(`MODE_UNKNOWN ${options.mode}`);
  for (const required of ["head", "brief", "out"]) {
    if (!options[required]) throw new Error(`ARG_REQUIRED --${required}`);
  }
  if (options.mode === "code-review" && !options.base) throw new Error("ARG_REQUIRED --base");
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("ARG_INVALID --timeout-minutes");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timeoutMs = options.timeoutMinutes * 60 * 1000;
  const commits = resolveCommits(options.repo, options);
  const questions = reviewQuestions(questionsSource(options.repo, commits));
  const prompt = buildPrompt({
    ...options,
    ...commits,
    questions,
    brief: readFileSync(options.brief, "utf8"),
  });
  if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
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
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, "prompt.md"), prompt);
    const results = await Promise.all(
      REVIEW_MODELS.map(async (model) => {
        const run = await runOpencode({
          binary,
          cwd: copy,
          configPath,
          gitGuard,
          model,
          prompt,
          timeoutMs,
          costLimit: COST_LIMIT_PER_MODEL_USD,
        });
        const name = model.split("/").pop();
        writeFileSync(join(options.out, `${name}.jsonl`), run.stdout);
        const summary = summarizeEvents(run.stdout);
        writeFileSync(join(options.out, `${name}.md`), `${summary.text}\n`);
        const record = {
          at: new Date().toISOString(),
          mode: options.mode,
          model,
          head: commits.head,
          outcome: runOutcome(summary, run),
          lastReason: summary.lastReason,
          exitCode: run.code,
          ...summary.usage,
          toolCalls: summary.toolCalls.length,
        };
        appendFileSync(join(options.out, "usage.jsonl"), `${JSON.stringify(record)}\n`);
        if (record.outcome !== "ok" && run.stderr.trim()) {
          writeFileSync(join(options.out, `${name}.stderr.txt`), run.stderr);
        }
        return record;
      }),
    );
    for (const record of results) {
      console.log(
        `REVIEW_RESULT ${record.model} outcome=${record.outcome} steps=${record.steps} input=${record.input} cacheRead=${record.cacheRead} output=${record.output} reasoning=${record.reasoning} cost=${record.cost.toFixed(4)}`,
      );
    }
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
