#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_VERSION = "1.19.5";
export const REVIEW_MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"];
export const REASONING_VARIANT = "high";
export const OUTPUT_TOKEN_MAX = 200000;
export const MIN_OUTPUT_TOKENS = 100000;
export const STEP_LIMIT = 50;
export const MODES = ["code-review", "discussion"];
export const GIT_READ_COMMANDS = ["git diff", "git log", "git show", "git blame", "git status"];
export const WRITE_OR_OUTSIDE_PATTERNS = [
  "*>*",
  "*<*",
  "* --output*",
  "* -o*",
  "* --ext-diff*",
  "* --textconv*",
  "* --no-index*",
  "* --contents*",
];
export const COST_LIMIT_PER_MODEL_USD = 0.25;
export const RULE_16_SENTENCE = "列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function reviewConfig({ mode, baseURL } = {}) {
  if (!MODES.includes(mode)) throw new Error(`MODE_UNKNOWN ${mode}`);
  const bash = { "*": "deny" };
  for (const command of GIT_READ_COMMANDS) bash[`${command}*`] = "allow";
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
      webfetch: mode === "discussion" ? "allow" : "deny",
      websearch: "deny",
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
  if (mode === "discussion") tools.push("webfetch");
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

export function buildPrompt({ mode, questions, head, base, previous, brief }) {
  if (!MODES.includes(mode)) throw new Error(`MODE_UNKNOWN ${mode}`);
  if (!brief || !brief.trim()) throw new Error("BRIEF_EMPTY");
  const role = mode === "code-review" ? "你是独立的代码复核者。" : "你是独立的方案讨论者。";
  const network =
    mode === "code-review"
      ? "不能上网。"
      : "可以用 webfetch 读材料里给出的网址或官方文档网页，不能搜索。";
  const fixed = [
    role,
    `你只能读：read、grep、glob，以及 ${GIT_READ_COMMANDS.join("、")} 这几条 git 命令。不能修改任何文件，不能运行别的命令。${network}`,
    "系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。",
    RULE_16_SENTENCE,
    "必答问题：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。",
  ].join("\n");
  const material = [
    "---- 本次材料 ----",
    `仓库就是当前目录，已检出 ${head}。`,
    base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
    previous
      ? `上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。`
      : null,
    "作者的说法（可能有错，请核对）：",
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

function runOpencode({ binary, cwd, configPath, model, prompt, timeoutMs, costLimit }) {
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
          OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(OUTPUT_TOKEN_MAX),
          GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    activeChildren.add(child);
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10000).unref();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        try {
          cost += JSON.parse(line).part?.cost ?? 0;
        } catch {}
      }
      if (costLimit !== undefined && cost > costLimit) stop("cost-limit");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
  });
}

export function runOutcome(summary, run) {
  if (run.spawnError) return "spawn-error";
  if (run.stopReason) return run.stopReason;
  if (summary.outcome !== "ok") return summary.outcome;
  if (run.code !== 0) return `exit-${run.code}`;
  return "ok";
}

export function probePlan(workRoot) {
  const marker = "OUTSIDE_REPO_MARKER_7f3a";
  const outsideA = join(workRoot, "outside-a.txt");
  const outsideB = join(workRoot, "outside-b.txt");
  const target = (name) => join(workRoot, `probe-${name}`);
  const writes = [
    ["output", (f) => `git log -1 --output=${f}`],
    ["abbrev", (f) => `git diff --outp=${f} HEAD`],
    ["redirect", (f) => `git log -1 > ${f}`],
    ["append", (f) => `git log -1 >> ${f}`],
    ["stderr", (f) => `git log -1 2>${f}`],
    ["pipe", (f) => `git log -1 | tee ${f}`],
    ["backtick", (f) => `git log -1 \`touch ${f}\``],
    ["substitution", (f) => `git log -1 $(touch ${f})`],
    ["semicolon", (f) => `git log -1; touch ${f}`],
    ["and", (f) => `git log -1 && touch ${f}`],
    ["newline", (f) => `git log -1\ntouch ${f}`],
  ].map(([name, build]) => ({ kind: "write", file: target(name), command: build(target(name)) }));
  const reads = [
    `git diff --no-index ${outsideA} ${outsideB}`,
    `git diff --no-inde ${outsideA} ${outsideB}`,
    `git blame --contents ${outsideA} -- AGENTS.md`,
  ].map((command) => ({ kind: "read", command }));
  return {
    marker,
    outsideFiles: [outsideA, outsideB],
    probes: [{ kind: "allowed", command: "git log -1 --oneline" }, ...writes, ...reads],
  };
}

function startProbeServer(commands) {
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
      if (hasTools && next < commands.length) {
        served.set(parsed.model, next + 1);
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
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({ command: commands[next], description: "probe" }),
                    },
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
  const bashCalls = toolCalls.filter((call) => call.tool === "bash");
  if (bashCalls.length < plan.probes.length) {
    problems.push(`PROBE_INCOMPLETE ran=${bashCalls.length} expected=${plan.probes.length}`);
  }
  plan.probes.forEach((probe, index) => {
    const call = bashCalls[index];
    if (!call) return;
    if (probe.kind === "allowed" && call.status !== "completed") {
      problems.push(`PROBE_READ_COMMAND_BLOCKED ${probe.command}`);
    }
    if (probe.kind === "read" && call.output.includes(plan.marker)) {
      problems.push(`PROBE_READ_OUTSIDE ${probe.command}`);
    }
  });
  for (const file of writtenFiles) problems.push(`PROBE_WROTE_FILE ${file}`);
  return problems;
}

async function selfCheck({ binary, copy, workRoot, mode, timeoutMs }) {
  const plan = probePlan(workRoot);
  for (const file of plan.outsideFiles) writeFileSync(file, `${plan.marker}\n${file}\n`);
  const { server, requests, port } = await startProbeServer(plan.probes.map((p) => p.command));
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
        model,
        prompt: "probe",
        timeoutMs,
      });
      const summary = summarizeEvents(run.stdout);
      const writtenFiles = plan.probes
        .filter((probe) => probe.kind === "write" && existsSync(probe.file))
        .map((probe) => probe.file);
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
      if (outsideLink || entry.name === ".opencode" || /^opencode\.jsonc?$/.test(entry.name)) {
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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`GIT_FAILED git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function resolveCommits(repo, { head, base, previous }) {
  const resolveOne = (ref) =>
    ref ? git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo) : undefined;
  return { head: resolveOne(head), base: resolveOne(base), previous: resolveOne(previous) };
}

export function prepareCopy({ repo, copy, commits, workRoot }) {
  git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", repo, copy], workRoot);
  git(["fetch", "--quiet", "origin", "+refs/*:refs/source/*"], copy);
  git(["checkout", "--quiet", "--detach", commits.head], copy);
  git(["remote", "remove", "origin"], copy);
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
  const questions = reviewQuestions(
    readFileSync(join(repoRoot, ".agents/instructions/model-review.md"), "utf8"),
  );
  const commits = resolveCommits(options.repo, options);
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
    for (const child of activeChildren) child.kill("SIGKILL");
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
    const problems = await selfCheck({
      binary,
      copy,
      workRoot,
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
