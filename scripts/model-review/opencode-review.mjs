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
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  binaryProblem,
  CLIENT_KEY,
  creditReserve,
  floorDecision,
  GATEWAY_PROVIDER_ID,
  gatewayTiming,
  getJson,
  groupId,
  groupName,
  installGateway,
  LOOPBACK_NO_PROXY,
  postJson,
  readGatewayConfig,
  sha256File,
  startGateway,
  stopAllGateways,
  summarizeGatewayUsage,
  workbuddyAccountUid,
} from "./gateway.mjs";
import {
  CLAIM_PROBLEM_VERDICTS,
  CLAIMS_LINE_FORMAT,
  blobAt as claimsBlobAt,
  blobSha256 as claimsBlobSha256,
  claimsProblems,
  parseClaims,
  safe,
  validClaimsFile,
} from "./plan-claims.mjs";
import { GUARD_ENV } from "./spend-guard.mjs";

export const OPENCODE_VERSION = "1.19.5";
export const REVIEW_MODELS_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "review-models.json",
);

export function reviewModelsProblems(config) {
  const problems = [];
  const names = (list) =>
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((name) => typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(name)) &&
    new Set(list).size === list.length;
  if (!names(config?.allowed)) problems.push("allowed");
  const allowed = names(config?.allowed) ? config.allowed : [];
  const shortNames = allowed.map((name) => name.split("/").pop());
  if (new Set(shortNames).size !== shortNames.length) problems.push("allowed.short-name-repeats");
  if (!names(config?.default) || config.default.some((name) => !allowed.includes(name)))
    problems.push("default");
  const substitutes = config?.substitutes;
  if (
    substitutes === null ||
    typeof substitutes !== "object" ||
    Array.isArray(substitutes) ||
    Object.entries(substitutes).some(
      ([from, to]) => !allowed.includes(from) || !allowed.includes(to) || from === to,
    )
  )
    problems.push("substitutes");
  if (!Number.isSafeInteger(config?.lowDeferFromRound) || config.lowDeferFromRound < 2)
    problems.push("lowDeferFromRound");
  return problems;
}

export function readReviewModels(path = REVIEW_MODELS_CONFIG_PATH) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`REVIEW_MODELS_CONFIG_INVALID unreadable ${error.message}`);
  }
  const problems = reviewModelsProblems(config);
  if (problems.length > 0) throw new Error(`REVIEW_MODELS_CONFIG_INVALID ${problems.join(",")}`);
  return config;
}

const reviewModels = readReviewModels();
export const REVIEW_MODELS = reviewModels.allowed;
export const DEFAULT_REVIEW_MODELS = reviewModels.default;
export const LOW_DEFER_FROM_ROUND = reviewModels.lowDeferFromRound;
export const REASONING_VARIANT = "high";
export const OUTPUT_TOKEN_MAX = 200000;
export const MIN_OUTPUT_TOKENS = 100000;
export const MODEL_OUTPUT_LIMITS = { "deepseek-v4.1-flash": 384000, "glm-5.3-flash": 131072 };
export const MODES = ["code-review", "plan", "plan-review", "plan-claims"];
export const OFFLINE_MODES = ["code-review", "plan-claims"];
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
export const OWNER_STOPPED = "owner-stopped";
export const STOP_GRACE_MS = 30000;
export const GUARD_DEFERS_TO_PARENT = ["cost-unknown", "wrap-up-tool-call", OWNER_STOPPED];
export const SPEND_GUARD_PATH = join(dirname(fileURLToPath(import.meta.url)), "spend-guard.mjs");
export const ASK_FIRST_LINE_USD = {
  "code-review": 1,
  plan: 0.5,
  "plan-review": 0.5,
  "plan-claims": 0.5,
};
export const FOCUS_SENTENCE =
  "做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。";
export const WRAP_UP_PROMPT =
  "现在停止读代码和调用工具。根据你已经读到的内容，按上面要求的输出格式写出完整结论；结论要写在正文里，不要只写在思考里。没核实的地方标「未核实」。";
export const RULE_16_SENTENCE = "列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const GATEWAYS = ["magpie"];
export const GATEWAY_CHOICES = [...GATEWAYS, "direct"];
export const PASSTHROUGH_PROMPT = "passthrough probe: owner probe-owner@example.com";

export function isLoopbackURL(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function launchModel(model, gateway) {
  return gateway ? `${GATEWAY_PROVIDER_ID}/group/${groupName(model)}` : model;
}

export function gatewayProvider({ baseURL, config }) {
  if (!isLoopbackURL(baseURL)) throw new Error(`GATEWAY_NOT_LOOPBACK ${baseURL}`);
  const models = Object.fromEntries(
    REVIEW_MODELS.map((model) => {
      const entry = config.models[model];
      if (!entry) throw new Error(`GATEWAY_MODEL_UNKNOWN ${model}`);
      return [
        `group/${groupName(model)}`,
        {
          name: entry.name,
          limit: { context: entry.context, output: entry.output },
          tool_call: true,
          reasoning: true,
          attachment: false,
          modalities: { input: ["text"], output: ["text"] },
          cost: entry.cost,
          variants: { [REASONING_VARIANT]: { reasoningEffort: REASONING_VARIANT } },
        },
      ];
    }),
  );
  return {
    npm: "@ai-sdk/openai-compatible",
    name: GATEWAY_PROVIDER_ID,
    options: { baseURL, apiKey: CLIENT_KEY },
    models,
  };
}

export function gatewayOpencodeEnv(env = process.env) {
  const list = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").filter(Boolean);
  const merged = [...new Set([...list, ...LOOPBACK_NO_PROXY.split(",")])].join(",");
  return { NO_PROXY: merged, no_proxy: merged, OPENCODE_ENABLE_EXA: "1" };
}

export function outputBounds(shortName, gateway) {
  if (gateway) {
    const model = REVIEW_MODELS.find((name) => groupId(name) === shortName);
    const output = model ? gateway.config.models[model]?.output : undefined;
    return output ? { min: output, max: output } : null;
  }
  const max = MODEL_OUTPUT_LIMITS[shortName];
  return max === undefined ? null : { min: MIN_OUTPUT_TOKENS, max };
}

export function reviewConfig({ mode, baseURL, wrapUp = false, gateway } = {}) {
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
    provider: gateway
      ? { [GATEWAY_PROVIDER_ID]: gatewayProvider(gateway) }
      : { "opencode-go": provider },
    permission: {
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
      glob: "allow",
      grep: "allow",
      bash,
      edit: "deny",
      webfetch: OFFLINE_MODES.includes(mode) ? "deny" : "allow",
      websearch: OFFLINE_MODES.includes(mode) ? "deny" : "allow",
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
  if (!OFFLINE_MODES.includes(mode)) tools.push("webfetch", "websearch");
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
      "输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。",
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
  "plan-claims": {
    role: "你是方案里“关于代码和文档现状的说法”的核对者。",
    network: "不能上网。",
    task: "下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。",
    output: `输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：\n${CLAIMS_LINE_FORMAT}\n序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。`,
    materialTitle: "待核对的方案：",
  },
};

export const LENS_MODES = ["code-review", "plan-review"];
export const MODEL_LENSES = {
  "deepseek-v4.1-flash":
    "你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。",
  "glm-5.3-flash":
    "你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。",
};

export function lensFor(mode, model) {
  if (!LENS_MODES.includes(mode) || !model) return null;
  const lens = MODEL_LENSES[model.split("/").pop()];
  if (!lens) throw new Error(`LENS_UNKNOWN ${model}`);
  return lens;
}

export function buildPrompt({
  mode,
  model,
  questions,
  head,
  base,
  previous,
  priorFindings,
  claimsBase,
  brief,
}) {
  if (!MODES.includes(mode)) throw new Error(`MODE_UNKNOWN ${mode}`);
  if (!brief || !brief.trim()) throw new Error("BRIEF_EMPTY");
  const text = MODE_TEXT[mode];
  const lens = lensFor(mode, model);
  const fixed = [
    text.role,
    `你能用的工具：read、grep、glob${OFFLINE_MODES.includes(mode) ? "" : "、websearch、webfetch"}，以及 ${GIT_READ_COMMANDS.join("、")} 这几条 git 命令。不能修改任何文件，不能运行别的命令。${text.network}`,
    text.task,
    FOCUS_SENTENCE,
    ...(mode === "plan-claims" ? [] : [RULE_16_SENTENCE]),
    ...(questions.length > 0
      ? ["必答问题：", ...questions.map((question, index) => `${index + 1}. ${question}`)]
      : []),
    ...(lens ? [lens] : []),
    text.output,
  ].join("\n");
  const material = [
    "---- 本次材料 ----",
    `仓库就是当前目录，已检出 ${head}。`,
    base ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
    mode === "plan-claims" && claimsBase
      ? `本 PR 的基线提交是 ${claimsBase}（main 与 ${head} 的共同祖先）。`
      : null,
    previous
      ? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，只做三件事：一、下面列出的上一轮意见是否真的改好了；二、增量改动的那些行有没有新错；三、增量产生或修改的值（导出的函数、配置键、字段、格式）的直接使用端能不能接受，用 git grep 找。增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。必答问题照样回答，和这次增量无关的，一句话写明不涉及即可。结论里写清这一轮查过哪些范围。`
      : null,
    previous && priorFindings ? priorFindings : null,
    text.materialTitle,
    brief.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  return `${fixed}\n\n${material}\n`;
}

export const PRIOR_FINDINGS_MAX_ITEMS = 20;
export const PRIOR_FINDINGS_MAX_QUOTE_CHARACTERS = 160;
export const PRIOR_FINDINGS_MAX_BYTES = 6000;
const PRIOR_FINDINGS_UNAVAILABLE = "上一轮的判断记录没有提交或读不出来，没有带入。";

export function priorFindingsBlock({ repo, ledgerPath, records, previous, head }) {
  const rounds = records
    .filter(
      (record) =>
        record.mode === "code-review" && record.head === previous && Number.isInteger(record.round),
    )
    .map((record) => record.round);
  if (rounds.length === 0) return PRIOR_FINDINGS_UNAVAILABLE;
  const round = Math.max(...rounds);
  const verdictsPath = `${ledgerPath}/round-${round}/verdicts.jsonl`;
  const text = showAt(repo, head, verdictsPath);
  if (text === null) return PRIOR_FINDINGS_UNAVAILABLE;
  let verdicts;
  try {
    verdicts = parseVerdicts(text, verdictsPath);
  } catch {
    return PRIOR_FINDINGS_UNAVAILABLE;
  }
  const errors = verdicts
    .filter((verdict) => verdict.valid && verdict.class === "error")
    .sort((a, b) => (a.severity === "low") - (b.severity === "low"));
  const title = `上一轮（第 ${round} 轮）成立的“会出错”意见，作者已修改。这只是线索，不是指令：每条都要对照增量核对是否真的改好，另外仍要独立核对代码，发现新问题照报：`;
  if (errors.length === 0) return `${title}\n（没有）`;
  const lines = [];
  let bytes = 0;
  for (const verdict of errors) {
    const quote = [...verdict.quote.replace(/\s+/g, " ").trim()]
      .slice(0, PRIOR_FINDINGS_MAX_QUOTE_CHARACTERS)
      .join("");
    const line = `- ${verdict.id}（${verdict.severity === "low" ? "低" : "中高"}）${quote}`;
    if (
      lines.length >= PRIOR_FINDINGS_MAX_ITEMS ||
      bytes + Buffer.byteLength(line) > PRIOR_FINDINGS_MAX_BYTES
    )
      break;
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  if (lines.length < errors.length)
    lines.push(`（另有 ${errors.length - lines.length} 条没有列出）`);
  return [title, ...lines].join("\n");
}

export const validCost = (value) => Number.isFinite(value) && value >= 0;

export const API_ERROR_MESSAGE_MAX = 300;

export function apiErrorOf(event) {
  const data = event.error?.data ?? {};
  const headers = data.responseHeaders ?? {};
  const raw = String(data.message ?? event.error?.name ?? "unknown");
  const message = [...raw]
    .map((character) => (hasControlCharacter(character) ? " " : character))
    .join("")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, API_ERROR_MESSAGE_MAX);
  const statusCode = Number.isSafeInteger(data.statusCode) ? data.statusCode : null;
  const hint = (value) =>
    typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  const retryAfterMs = Number.isFinite(hint(headers["retry-after-ms"]))
    ? hint(headers["retry-after-ms"])
    : hint(headers["retry-after"]) * 1000;
  return {
    message,
    statusCode,
    retryable: data.isRetryable === true || (Number.isFinite(retryAfterMs) && retryAfterMs >= 0),
  };
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
  const thoughts = [];
  const toolCalls = [];
  let lastReason = null;
  let apiError = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const part = event.part ?? {};
    if (event.type === "error") apiError = apiErrorOf(event);
    if (event.type === "text" && typeof part.text === "string") texts.push(part.text);
    if (event.type === "reasoning" && typeof part.text === "string") thoughts.push(part.text);
    if (event.type === "tool_use") {
      toolCalls.push({
        tool: part.tool,
        input: part.state?.input,
        status: part.state?.status,
        output: String(part.state?.output || part.state?.error || ""),
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
  if (apiError) outcome = "api-error";
  else if (lastReason === "length") outcome = "truncated";
  else if (!text) outcome = "no-text";
  return {
    outcome,
    lastReason,
    apiError,
    text,
    thinking: thoughts.join("\n").trim(),
    usage,
    toolCalls,
  };
}

export const OPENCODE_LOCK_DIR = join(dirname(fileURLToPath(import.meta.url)), "opencode-lock");
export const OPENCODE_LOCK_FILES = ["package.json", "package-lock.json"];

export function installedIntegrityProblems(prefix, lock) {
  const installedPath = join(prefix, "node_modules", ".package-lock.json");
  if (!existsSync(installedPath)) return ["installed-lock-missing"];
  let installed;
  try {
    installed = JSON.parse(readFileSync(installedPath, "utf8")).packages ?? {};
  } catch {
    return ["installed-lock-unreadable"];
  }
  const problems = [];
  if (!installed["node_modules/opencode-ai"]) problems.push("node_modules/opencode-ai missing");
  for (const [name, entry] of Object.entries(installed)) {
    const expected = lock.packages?.[name];
    if (!expected?.integrity || expected.integrity !== entry.integrity)
      problems.push(`${name} ${entry.integrity ?? "no-integrity"}`);
  }
  return problems;
}

function npmCi(prefix, lockDir, binary) {
  rmSync(prefix, { recursive: true, force: true });
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

function installBesideThenRename(prefix, lockDir, binary, lock) {
  const staging = `${prefix}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    npmCi(staging, lockDir, join(staging, "node_modules", ".bin", "opencode"));
    const stagedProblems = installedIntegrityProblems(staging, lock);
    if (stagedProblems.length > 0)
      throw new Error(`OPENCODE_INTEGRITY_MISMATCH ${prefix} ${stagedProblems.join(" | ")}`);
    try {
      renameSync(staging, prefix);
    } catch {
      if (!existsSync(binary)) {
        rmSync(prefix, { recursive: true, force: true });
        try {
          renameSync(staging, prefix);
        } catch (error) {
          if (!existsSync(binary)) throw error;
        }
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function installOpencode({ prefix, lockDir = OPENCODE_LOCK_DIR }) {
  const lock = JSON.parse(readFileSync(join(lockDir, "package-lock.json"), "utf8"));
  const binary = join(prefix, "node_modules", ".bin", "opencode");
  const reused = existsSync(binary);
  if (!reused) installBesideThenRename(prefix, lockDir, binary, lock);
  let problems = installedIntegrityProblems(prefix, lock);
  if (problems.length > 0 && reused) {
    process.stderr.write(`OPENCODE_REINSTALL ${prefix} ${problems.join(" | ")}\n`);
    rmSync(prefix, { recursive: true, force: true });
    installBesideThenRename(prefix, lockDir, binary, lock);
    problems = installedIntegrityProblems(prefix, lock);
  }
  if (problems.length > 0)
    throw new Error(`OPENCODE_INTEGRITY_MISMATCH ${prefix} ${problems.join(" | ")}`);
  return binary;
}

export function opencodeInstallDir(lockDir = OPENCODE_LOCK_DIR) {
  const lockDigest = createHash("sha256")
    .update(readFileSync(join(lockDir, "package-lock.json")))
    .digest("hex")
    .slice(0, 12);
  return join(homedir(), ".cache", `himawari-opencode-${OPENCODE_VERSION}-${lockDigest}`);
}

export function opencodeBinary() {
  if (process.env.HIMAWARI_OPENCODE_BIN) return process.env.HIMAWARI_OPENCODE_BIN;
  return installOpencode({ prefix: opencodeInstallDir() });
}

const activeChildren = new Set();
const activeStops = new Set();
let stopRequested = null;

export function requestStop(reason = OWNER_STOPPED) {
  stopRequested = reason;
  for (const stop of activeStops) stop(reason);
}

export function waitUnlessStopped(ms) {
  return new Promise((resolveWait) => {
    if (stopRequested) return resolveWait();
    const done = () => {
      clearTimeout(timer);
      activeStops.delete(done);
      resolveWait();
    };
    const timer = setTimeout(done, ms);
    activeStops.add(done);
  });
}

export function clearStopRequest() {
  stopRequested = null;
}

export function signalHandler({
  running,
  requestStop: ask,
  cleanup,
  exit,
  graceMs = STOP_GRACE_MS,
}) {
  let received = 0;
  let timer = null;
  const handle = (signal) => {
    received += 1;
    const code = signal === "SIGINT" ? 130 : 143;
    if (!running() || received > 1) {
      clearTimeout(timer);
      cleanup();
      exit(code);
      return;
    }
    console.log(`REVIEW_STOPPING ${signal}`);
    ask(OWNER_STOPPED);
    timer = setTimeout(() => {
      cleanup();
      exit(code);
    }, graceMs);
  };
  handle.dispose = () => clearTimeout(timer);
  return handle;
}

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
export const GIT_KEPT_ENV = ["PATH", "HOME", "LANG", "TERM"];

export function englishMessages(env) {
  const ctype = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value);
  return {
    ...(ctype === undefined ? {} : { LC_CTYPE: ctype }),
    LC_MESSAGES: "C",
    LANGUAGE: "C",
  };
}
export const REVIEW_CANARY_ENV = "REVIEW_CANARY";
export const REVIEW_PARENT_CANARY_ENV = "REVIEW_PARENT_CANARY";
export const OPENCODE_KEPT_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
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

export const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

export function proxyCredentialProblems(env) {
  return PROXY_ENV.filter((name) =>
    /^(?:[a-z][a-z0-9+.-]*:)?(?:\/\/)?[^/?#]*@/i.test((env[name] ?? "").trim()),
  );
}

export function opencodeEnv(env) {
  return Object.fromEntries(
    OPENCODE_KEPT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
}
export const SHELL_LOG_NAME = "review-shell.log";

export function opencodeChildEnv({ parentEnv, cwd, configPath, limitsPath, gitGuard, extraEnv }) {
  const env = {
    ...opencodeEnv(parentEnv),
    ...extraEnv,
    PWD: cwd,
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    [GUARD_ENV]: limitsPath,
    XDG_CONFIG_HOME: gitGuard.configHome,
    OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(OUTPUT_TOKEN_MAX),
    GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PAGER: "cat",
    PAGER: "cat",
    ...englishMessages(parentEnv),
    PATH: `${gitGuard.binDir}${delimiter}${parentEnv.PATH ?? ""}`,
    SHELL: gitGuard.shell,
  };
  delete env.LC_ALL;
  if (!limitsPath) delete env[GUARD_ENV];
  return env;
}

export function gitChildEnv(env) {
  const kept = Object.fromEntries(
    GIT_KEPT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
  return { ...kept, ...GIT_ENV, ...englishMessages(env) };
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
      'ctype="$LC_ALL"',
      'if [ -z "$ctype" ]; then ctype="$LC_CTYPE"; fi',
      'if [ -z "$ctype" ]; then ctype="$LANG"; fi',
      "unset LC_ALL",
      'if [ -n "$ctype" ]; then LC_CTYPE="$ctype"; export LC_CTYPE; fi',
      "export LC_MESSAGES=C",
      "export LANGUAGE=C",
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
        env: opencodeChildEnv({
          parentEnv: process.env,
          cwd,
          configPath,
          limitsPath: guardFiles?.limitsPath,
          gitGuard,
          extraEnv,
        }),
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
    activeStops.add(stop);
    if (stopRequested) stop(stopRequested);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(wrapUpTimer);
      clearTimeout(killTimer);
      killProcessGroup(child, "SIGKILL");
      activeChildren.delete(child);
      activeStops.delete(stop);
      const marker = guardFiles ? readGuardMarker(guardFiles.markerPath) : null;
      const inFlight = Boolean(stopReason && marker && marker.allowed > marker.completed);
      if (marker?.reason && !GUARD_DEFERS_TO_PARENT.includes(stopReason))
        stopReason = marker.reason;
      resolvePromise({ stdout, stderr, stopReason, guard: marker, inFlight, ...result });
    };
    child.stdout.setEncoding("utf8");
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
    child.stderr.setEncoding("utf8");
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

export const API_ERROR_RETRY_WAIT_MS = 60000;
export const SUBSTITUTES = reviewModels.substitutes;

export function apiErrorText(apiError) {
  return `${apiError.statusCode ?? "-"} ${apiError.message}`;
}

export function substituteFor({ mode, models, runs }) {
  if (mode !== "code-review" || models.length !== 1) return null;
  const replacement = SUBSTITUTES[models[0]];
  const [run] = runs;
  if (!replacement || run.record.outcome !== "api-error" || run.review.retry !== "retried")
    return null;
  if (!run.review.summary.apiError?.retryable) return null;
  return { model: replacement, for: models[0] };
}

export function retryAfterApiError(result, { remainingMs, remainingUsd, waitMs }) {
  if (result.outcome !== "api-error" || !result.summary.apiError?.retryable) return null;
  if (result.summary.usage.costUnknown) return "cost-unknown";
  if (remainingUsd < WRAP_UP_RESERVE_USD + WRAP_UP_MIN_USD) return "no-budget";
  if (remainingMs - waitMs < WRAP_UP_MIN_MS * 4) return "no-time";
  return "retry";
}

export async function reviewModel(options) {
  const {
    timeoutMs,
    costLimit = COST_LIMIT_PER_MODEL_USD,
    retryWaitMs = API_ERROR_RETRY_WAIT_MS,
  } = options;
  const deadline = Date.now() + timeoutMs;
  const first = await reviewOnce({ ...options, costLimit, startingUsd: 0 });
  const remainingUsd = costLimit - first.summary.usage.cost;
  const decision = retryAfterApiError(first, {
    remainingMs: deadline - Date.now(),
    remainingUsd,
    waitMs: retryWaitMs,
  });
  if (decision !== "retry" || stopRequested)
    return { ...first, retry: decision === "retry" ? null : decision };
  await waitUnlessStopped(retryWaitMs);
  if (stopRequested) return { ...first, retry: OWNER_STOPPED, outcome: OWNER_STOPPED };
  const second = await reviewOnce({
    ...options,
    timeoutMs: deadline - Date.now(),
    costLimit,
    startingUsd: first.summary.usage.cost,
  });
  const stdout = `${first.stdout}${first.stdout.endsWith("\n") ? "" : "\n"}${second.stdout}`;
  const usage = { ...summarizeEvents(stdout).usage };
  usage.cost = first.summary.usage.cost + second.summary.usage.cost;
  for (const flag of ["costUnknown", "inFlight"])
    if (first.summary.usage[flag] || second.summary.usage[flag]) usage[flag] = true;
  return {
    ...second,
    runs: [...first.runs, ...second.runs],
    stdout,
    stderr: `${first.stderr}${second.stderr}`,
    summary: { ...second.summary, usage },
    retry: "retried",
    retriedAfter: first.summary.apiError.message,
  };
}

async function reviewOnce({
  binary,
  cwd,
  configPath,
  wrapUpConfigPath,
  gitGuard,
  model,
  prompt,
  timeoutMs,
  costLimit,
  startingUsd,
  extraEnv = {},
}) {
  const deadline = Date.now() + timeoutMs;
  const reserveMs = Math.min(WRAP_UP_RESERVE_MAX_MS, Math.floor(timeoutMs / 5));
  const ownLimit = costLimit - startingUsd;
  const first = await runOpencode({
    binary,
    cwd,
    configPath,
    gitGuard,
    model,
    prompt,
    timeoutMs,
    costLimit: ownLimit,
    wrapUpCost: ownLimit - WRAP_UP_RESERVE_USD,
    wrapUpMs: timeoutMs - reserveMs,
    extraEnv,
    guard: { totalUsd: ownLimit, stopAtUsd: ownLimit - WRAP_UP_RESERVE_USD },
  });
  const firstSummary = applyGuardUsage(summarizeEvents(first.stdout), [first]);
  const wrapUp = wrapUpReason(firstSummary, first);
  const session = wrapUp ? sessionOf(first.stdout) : null;
  const remainingMs = deadline - Date.now();
  const remainingUsd = ownLimit - firstSummary.usage.cost;
  const skipped = !wrapUp
    ? null
    : stopRequested
      ? OWNER_STOPPED
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
      outcome: skipped === OWNER_STOPPED ? OWNER_STOPPED : runOutcome(firstSummary, first),
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
    extraEnv,
    guard: { totalUsd: ownLimit, startingUsd: firstSummary.usage.cost },
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

export const LOW_FIX_MAX_FILES = 5;
export const LOW_FIX_MAX_LINES_PER_FILE = 30;
export const VERDICT_CLASSES = ["error", "better"];
export const VERDICT_SEVERITIES = ["low", "medium-high"];
const VERDICT_TEXT_FIELDS = ["id", "model", "quote"];
const LOW_MODEL_SEVERITY = /^(?:低|low|minor|轻微|nit)/i;

export function isTestFile(path) {
  if (/\.md$/i.test(path)) return false;
  return (
    /(?:^|\/)(?:test|tests|__tests__)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.(?:py|go|rs)$/.test(path) ||
    /(?:^|\/)[A-Z][A-Za-z0-9]*Test\.java$/.test(path)
  );
}

export function parseVerdicts(text, path) {
  const seen = new Set();
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim())
    .map(({ line, number }) => {
      let verdict;
      try {
        verdict = JSON.parse(line);
      } catch {
        verdict = null;
      }
      const filled = (field) =>
        typeof verdict?.[field] === "string" && verdict[field].trim() !== "";
      const valid =
        verdict !== null &&
        typeof verdict === "object" &&
        VERDICT_TEXT_FIELDS.every(filled) &&
        REVIEW_MODELS.includes(verdict.model) &&
        typeof verdict.valid === "boolean" &&
        VERDICT_CLASSES.includes(verdict.class) &&
        !hasLineBreak(verdict) &&
        (!verdict.valid ||
          verdict.class !== "error" ||
          (VERDICT_SEVERITIES.includes(verdict.severity) &&
            filled("trigger") &&
            filled("consequence") &&
            filled("modelSeverity") &&
            (verdict.severity !== "low" ||
              LOW_MODEL_SEVERITY.test(verdict.modelSeverity.trim()) ||
              filled("reason"))));
      if (!valid || seen.has(verdict.id)) throw new Error(`VERDICTS_INVALID ${path}:${number}`);
      seen.add(verdict.id);
      return verdict;
    });
}

function showAt(repo, commit, path) {
  const shown = gitStatus(["show", `${commit}:${path}`], repo);
  return shown.status === 0 ? shown.stdout : null;
}

export function lowFixProblems({ repo, ledgerPath, round, from, to, mainRef, skip }) {
  const problems = [];
  const verdictsPath = `${ledgerPath}/round-${round}/verdicts.jsonl`;
  const text = showAt(repo, to, verdictsPath);
  if (text === null)
    return { problems: [`verdicts-not-committed round-${round}`], files: [], errors: [] };
  let verdicts;
  try {
    verdicts = parseVerdicts(text, verdictsPath);
  } catch (error) {
    return { problems: [error.message], files: [], errors: [] };
  }
  const answers = new Map();
  for (const verdict of verdicts) {
    if (!answers.has(verdict.model))
      answers.set(
        verdict.model,
        showAt(repo, to, `${ledgerPath}/round-${round}/${verdict.model.split("/").pop()}.md`),
      );
    if (!answers.get(verdict.model)?.includes(verdict.quote))
      problems.push(`quote-not-found ${printable(verdict.id)}`);
  }
  const errors = verdicts.filter((verdict) => verdict.valid && verdict.class === "error");
  for (const verdict of errors)
    if (verdict.severity !== "low") problems.push(`not-low ${printable(verdict.id)}`);
  if (errors.length === 0) problems.push("no-low-errors");
  const result = gitStatus(["diff", "-z", "--no-renames", "--numstat", from, to], repo);
  if (result.status !== 0) throw new Error(`GIT_FAILED git diff: ${result.stderr.trim()}`);
  const fields = result.stdout.split("\0");
  const changes = [];
  const ownFiles = mainRef ? new Set(unreviewedFiles(repo, from, to, ledgerPath, mainRef)) : null;
  for (const entry of fields) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3].startsWith(`${ledgerPath}/`) || skip?.has(match[3])) continue;
    if (ownFiles && !ownFiles.has(match[3])) continue;
    const lines = match[1] === "-" ? Infinity : Number(match[1]) + Number(match[2]);
    changes.push({ file: match[3], lines, added: match[1] === "-" ? 0 : Number(match[1]) });
  }
  if (changes.length === 0) problems.push("no-changes");
  if (changes.length > LOW_FIX_MAX_FILES)
    problems.push(`too-many-files ${changes.length} max=${LOW_FIX_MAX_FILES}`);
  for (const change of changes)
    if (change.lines > LOW_FIX_MAX_LINES_PER_FILE)
      problems.push(
        `too-many-lines ${printable(change.file)} ${change.lines} max=${LOW_FIX_MAX_LINES_PER_FILE}`,
      );
  for (const change of changes)
    if (/[\r\n]/.test(change.file))
      problems.push(`file-name-has-line-break ${printable(change.file)}`);
  const docsOnly = changes.every((change) => /\.md$/i.test(change.file));
  if (
    changes.length > 0 &&
    !docsOnly &&
    !changes.some((change) => isTestFile(change.file) && change.added > 0)
  )
    problems.push("no-test-change");
  return { problems, files: changes.map((change) => change.file), errors };
}

export function coveragePoints(records) {
  const reviews = records.filter((record) => record.mode === "code-review");
  const rounds = [...new Set(reviews.map((record) => record.round ?? 1))].sort((a, b) => a - b);
  const points = [];
  for (const round of rounds) {
    const passed = reviews.filter(
      (record) => (record.round ?? 1) === round && record.outcome === "ok",
    );
    const inRound = reviews.filter((record) => (record.round ?? 1) === round);
    const direct = (model) =>
      passed.some((record) => record.model === model && record.substitute === undefined);
    const stoodIn = (model) =>
      inRound.some(
        (record) =>
          record.model === model && record.substitute === undefined && record.outcome !== "ok",
      ) &&
      passed.some(
        (record) =>
          record.substitute === true &&
          record.substituteFor === model &&
          record.model === SUBSTITUTES[model],
      );
    const requested = [
      ...new Set(
        inRound
          .filter(
            (record) => record.substitute === undefined && REVIEW_MODELS.includes(record.model),
          )
          .map((record) => record.model),
      ),
    ];
    const complete = (models) =>
      models.length > 0 && models.every((model) => direct(model) || stoodIn(model));
    const needed = complete(requested)
      ? requested
      : complete(DEFAULT_REVIEW_MODELS)
        ? DEFAULT_REVIEW_MODELS
        : [];
    const covering = passed.filter((record) =>
      record.substitute === true
        ? needed.includes(record.substituteFor) &&
          record.model === SUBSTITUTES[record.substituteFor]
        : record.substitute === undefined && needed.includes(record.model),
    );
    if (covering.length === 0) continue;
    const heads = [...new Set(covering.map((record) => record.head))];
    if (heads.length !== 1)
      throw new Error(`REVIEW_ROUND_HEADS_DIFFER ${round} ${heads.join(",")}`);
    const previous = [...new Set(covering.map((record) => record.previous ?? null))];
    const by = needed.some((model) => !direct(model))
      ? "substitute"
      : needed === requested
        ? "requested"
        : "default";
    points.push({ round, head: heads[0], previous: previous.length === 1 ? previous[0] : "", by });
    for (const [index, record] of records.entries())
      if (record.mode === "low-fix" && record.round === round)
        points.push({
          index,
          round,
          head: record.head,
          from: record.from,
          files: record.files,
          findings: record.findings,
          by: "low-fix",
        });
  }
  return points;
}

export function walkChain(points, { isAncestor, lowFixCheck }) {
  let accepted = [];
  let broken = null;
  for (const point of points) {
    if (point.by !== "low-fix" && point.previous === null) {
      accepted = [point];
      broken = null;
      continue;
    }
    if (accepted.length === 0 || broken) continue;
    const covered = accepted.at(-1).head;
    const problems = [];
    if (point.by === "low-fix") {
      if (point.from !== covered || !isAncestor(covered, point.head)) problems.push("chain-broken");
      else if (accepted.at(-1).by === "low-fix") problems.push("second-low-fix");
      else problems.push(...lowFixCheck(point));
    } else if (
      !point.previous ||
      !isAncestor(point.previous, covered) ||
      !isAncestor(covered, point.head)
    )
      problems.push("chain-broken");
    if (problems.length === 0) accepted.push(point);
    else broken = { point, problems };
  }
  return { accepted, broken };
}

function gitStatus(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}

export const OVERRIDABLE_PROBLEMS = [
  "unreviewed ",
  "ledger-not-committed",
  "no-complete-round",
  "chain-broken ",
  "not-ancestor ",
  "low-fix-invalid ",
  "claims-",
];

function changedOutside(repo, from, to, ledgerPath) {
  const result = gitStatus(["diff", "-z", "--no-renames", "--name-only", from, to], repo);
  if (result.status !== 0) throw new Error(`GIT_FAILED git diff: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
}

function ownChangePrints(repo, commit, mainRef, ledgerPath, only) {
  const base = gitStatus(["merge-base", mainRef, commit], repo);
  if (base.status !== 0) return null;
  const baseCommit = base.stdout.trim();
  const names = gitStatus(["diff", "-z", "--no-renames", "--name-only", baseCommit, commit], repo);
  if (names.status !== 0) return null;
  const prints = new Map();
  for (const file of names.stdout.split("\0")) {
    if (!file || file.startsWith(`${ledgerPath}/`) || (only && !only.has(file))) continue;
    if (file.includes("\uFFFD")) return null;
    const diff = spawnSync(
      "git",
      [
        "diff",
        "-U0",
        "--binary",
        "--inter-hunk-context=0",
        "--no-textconv",
        "--no-ext-diff",
        "--no-renames",
        baseCommit,
        commit,
        "--",
        `:(literal)${file}`,
      ],
      { cwd: repo, maxBuffer: 1 << 28 },
    );
    if (diff.status !== 0 || diff.stdout.length === 0) return null;
    const stable = diff.stdout
      .toString("latin1")
      .split("\n")
      .filter((line) => !line.startsWith("@@ ") && !line.startsWith("index "))
      .join("\n");
    prints.set(file, createHash("sha256").update(Buffer.from(stable, "latin1")).digest("hex"));
  }
  return prints;
}

export function unreviewedFiles(repo, from, to, ledgerPath, mainRef) {
  const outside = changedOutside(repo, from, to, ledgerPath);
  if (!mainRef || outside.length === 0) return outside;
  const only = new Set(outside);
  const reviewed = ownChangePrints(repo, from, mainRef, ledgerPath, only);
  const current = ownChangePrints(repo, to, mainRef, ledgerPath, only);
  if (!reviewed || !current) return outside;
  return outside.filter((file) => reviewed.get(file) !== current.get(file)).sort();
}

export function assertReviewed({ repo, pr, mainRef = "origin/main", acceptUnreviewed, acceptLow }) {
  const ledgerPath = `${REVIEWS_DIR}/${reviewKey({ pr })}`;
  const head = git(["rev-parse", "HEAD"], repo);
  const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
  const records = shown.status === 0 ? parseUsage(shown.stdout, `HEAD:${ledgerPath}`) : null;
  const claims = claimsProblems({
    repo,
    head,
    mainRef,
    reviewsDir: REVIEWS_DIR,
    parseUsage,
    looksSecret: claimsFileSecretLike,
  });
  const claimsOwned = new Set(claims.files);
  const unreviewed = (from, to) =>
    unreviewedFiles(repo, from, to, ledgerPath, mainRef).filter((file) => !claimsOwned.has(file));
  const isAncestor = (from, to) =>
    gitStatus(["merge-base", "--is-ancestor", from, to], repo).status === 0;
  const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const lowFixCheck = (point) => {
    const check = lowFixProblems({
      repo,
      ledgerPath,
      round: point.round,
      from: point.from,
      to: point.head,
      mainRef,
      skip: claimsOwned,
    });
    const problems = [...check.problems];
    if (check.problems.length === 0 && !sameList(point.files, check.files.map(maskSecretLike))) {
      const legacy = lowFixProblems({
        repo,
        ledgerPath,
        round: point.round,
        from: point.from,
        to: point.head,
        skip: claimsOwned,
      });
      if (legacy.problems.length > 0 || !sameList(point.files, legacy.files.map(maskSecretLike)))
        problems.push("files-differ");
    }
    if (
      check.problems.length === 0 &&
      !sameList(
        point.findings,
        check.errors.map((verdict) => maskSecretLike(verdict.id)),
      )
    )
      problems.push("findings-differ");
    return problems;
  };
  const points = records ? coveragePoints(records) : [];
  const { accepted, broken } = walkChain(points, { isAncestor, lowFixCheck });
  const complete = accepted.at(-1) ?? null;
  const chainProblems = broken
    ? broken.problems.map((problem) =>
        problem === "chain-broken"
          ? `chain-broken round=${broken.point.round} ${broken.point.head}`
          : `low-fix-invalid round=${broken.point.round} ${problem}`,
      )
    : [];
  const problems = [];
  let outsideFiles = [];
  if (!records) problems.push("ledger-not-committed");
  else if (!complete) problems.push("no-complete-round");
  else if (chainProblems.length > 0) problems.push(...chainProblems);
  else if (!isAncestor(complete.head, head)) problems.push(`not-ancestor ${complete.head}`);
  else {
    outsideFiles = unreviewed(complete.head, head);
    for (const file of outsideFiles) problems.push(`unreviewed ${printable(file)}`);
  }
  problems.push(...claims.problems);
  problems.push(
    ...recordSecretProblems({
      repo,
      ledgerPath,
      otherFiles: [...outsideFiles, ...claims.files],
    }),
  );
  if (gitStatus(["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`], repo).status !== 0)
    problems.push(`main-ref-missing ${printable(mainRef)}`);
  else if (gitStatus(["merge-base", "--is-ancestor", mainRef, head], repo).status !== 0)
    problems.push(`main-not-merged ${printable(mainRef)}`);
  const summary = `pr=${pr} round=${complete?.round ?? "none"} reviewed=${complete?.head ?? "none"} head=${head}`;
  const chain =
    accepted.length > 1
      ? [`REVIEW_CHAIN ${accepted.map((point) => `round-${point.round}:${point.by}`).join(" ")}`]
      : [];
  const lines =
    problems.length === 0
      ? [`REVIEW_CURRENT ${summary}`, ...chain]
      : [`REVIEW_NOT_CURRENT ${summary}`, ...chain, ...problems.map((problem) => `  ${problem}`)];
  const blocking = problems.filter(
    (problem) => !OVERRIDABLE_PROBLEMS.some((prefix) => problem.startsWith(prefix)),
  );
  const overridable = problems.length > 0 && blocking.length === 0;
  if (problems.length > 0 && acceptUnreviewed && !overridable)
    lines.push(
      `REVIEW_OVERRIDE_REFUSED not-review-problems ${blocking.map((problem) => problem.split(" ")[0]).join(",")}`,
    );
  const recorded =
    overridable && records
      ? records
          .filter((record) => record.mode === "override" && record.head)
          .reverse()
          .find(
            (record) =>
              gitStatus(["merge-base", "--is-ancestor", record.head, head], repo).status === 0 &&
              unreviewed(record.head, head).length === 0,
          )
      : undefined;
  const ledgerFile = join(repo, ledgerPath, "usage.jsonl");
  const ledgerMatchesHead = () =>
    (existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "") ===
    (shown.status === 0 ? shown.stdout : "");
  let lowFixed = false;
  let lowFixRefused = false;
  if (acceptLow !== undefined) {
    const reasons = [];
    if (problems.length === 0) reasons.push("nothing-unreviewed");
    else if (!problems.every((problem) => problem.startsWith("unreviewed ")))
      reasons.push("only-unreviewed-files");
    else if (complete.round !== acceptLow) reasons.push(`not-last-round last=${complete.round}`);
    else if (complete.by === "low-fix") reasons.push(`already-low-fixed round=${acceptLow}`);
    const check =
      reasons.length === 0
        ? lowFixProblems({
            repo,
            ledgerPath,
            round: acceptLow,
            from: complete.head,
            to: head,
            mainRef,
            skip: claimsOwned,
          })
        : null;
    if (check) reasons.push(...check.problems);
    if (reasons.length === 0 && !ledgerMatchesHead()) reasons.push("ledger-differs-from-HEAD");
    if (reasons.length > 0) {
      lines.push(`REVIEW_LOW_FIX_REFUSED ${reasons.join(" ")}`);
      lowFixRefused = true;
      const refusalsFile = join(repo, ledgerPath, "low-fix-refusals.jsonl");
      if (existsSync(dirname(refusalsFile)))
        try {
          appendFileSync(
            refusalsFile,
            ledgerLine({
              at: new Date().toISOString(),
              round: acceptLow,
              head,
              reasons: reasons.map((reason) => reason.split(" ")[0]),
            }),
          );
        } catch (error) {
          lines.push(`REVIEW_LOW_FIX_REFUSAL_NOT_RECORDED ${printable(error.code ?? "error")}`);
        }
    } else {
      appendFileSync(
        ledgerFile,
        `${shown.stdout && !shown.stdout.endsWith("\n") ? "\n" : ""}${ledgerLine({
          at: new Date().toISOString(),
          mode: "low-fix",
          cost: 0,
          round: acceptLow,
          head,
          from: complete.head,
          files: check.files,
          findings: check.errors.map((verdict) => verdict.id),
        })}`,
      );
      lines.push(
        `REVIEW_LOW_FIX round=${acceptLow} from=${complete.head} head=${head} files=${check.files.map(printable).join(",")}`,
      );
      lowFixed = true;
    }
  }
  const overridden = Boolean(recorded) || lowFixed;
  if (recorded)
    lines.push(`REVIEW_OVERRIDE quote=${printable(recorded.quote)} recorded=${recorded.head}`);
  else if (overridable && acceptUnreviewed) {
    const onDisk = shown.status === 0 ? shown.stdout : "";
    if (!ledgerMatchesHead()) lines.push("REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD");
    else {
      mkdirSync(dirname(ledgerFile), { recursive: true });
      appendFileSync(
        ledgerFile,
        `${onDisk && !onDisk.endsWith("\n") ? "\n" : ""}${ledgerLine({ at: new Date().toISOString(), mode: "override", cost: 0, head, quote: acceptUnreviewed, problems })}`,
      );
      lines.push(`REVIEW_OVERRIDE_WRITTEN quote=${acceptUnreviewed} commit-and-rerun`);
    }
  }
  return {
    round: complete?.round ?? null,
    reviewed: complete?.head ?? null,
    head,
    problems,
    lines,
    overridden,
    lowFixRefused,
    accepted,
  };
}

export const REVIEW_REPORT_DISCLAIMER = "复核模型只读代码、不运行代码；复核通过不等于测试通过。";
export const STOP_REASONS = {
  "no-error": () => "没有“会出错”的意见",
  "three-rounds": () => "连续三轮没过，按规则停下等 Andy 决定",
  "andy-decision": (quote) => `Andy 裁定：${quote}`,
  "run-failed": () => "有模型没跑完（outcome 不是 ok）",
};

const SKELETON_SKIPPED_SECTIONS = /必答|侧重|结论|总结|summary|conclusion/i;

export function deferredLowLines({ repo, ledgerPath, records }) {
  const lines = [];
  const rounds = [
    ...new Set(
      records
        .filter((record) => record.mode === "code-review")
        .map((record) => record.round ?? 1)
        .filter((round) => round >= LOW_DEFER_FROM_ROUND),
    ),
  ].sort((a, b) => a - b);
  for (const round of rounds) {
    if (records.some((record) => record.mode === "low-fix" && record.round === round)) continue;
    const path = `${ledgerPath}/round-${round}/verdicts.jsonl`;
    const text = showAt(repo, "HEAD", path);
    if (text === null) {
      lines.push(`  第 ${round} 轮 verdicts.jsonl 没有提交，列不出这一轮的低意见`);
      continue;
    }
    const errors = parseVerdicts(text, path).filter(
      (verdict) => verdict.valid && verdict.class === "error",
    );
    if (errors.length === 0 || errors.some((verdict) => verdict.severity !== "low")) continue;
    for (const verdict of errors)
      lines.push(
        `  第 ${round} 轮 ${printable(verdict.id)} ${verdict.model.split("/").pop()}：${printable(verdict.quote)}｜${printable(verdict.trigger)} → ${printable(verdict.consequence)}`,
      );
  }
  return lines;
}

function latestReviewRound(repo, pr) {
  const ledgerPath = `${REVIEWS_DIR}/${reviewKey({ pr })}`;
  const usagePath = join(repo, ledgerPath, "usage.jsonl");
  if (!existsSync(usagePath)) throw new Error(`ROUND_LEDGER_MISSING ${ledgerPath}`);
  const records = parseUsage(readFileSync(usagePath, "utf8"), usagePath).filter(
    (record) => record.mode === "code-review",
  );
  if (records.length === 0) throw new Error(`ROUND_NONE ${ledgerPath}`);
  const round = Math.max(...records.map((record) => record.round ?? 1));
  const own = records.filter((record) => (record.round ?? 1) === round);
  const ok = own.filter((record) => record.outcome === "ok");
  if (ok.length === 0) throw new Error(`ROUND_NOT_OK round-${round}`);
  return { ledgerPath, round, records: ok, dir: join(repo, ledgerPath, `round-${round}`) };
}

export function skeletonFindings(answer) {
  const findings = [];
  let skipped = false;
  for (const line of answer.split("\n")) {
    const section = /^##\s+(.*)$/.exec(line);
    if (section) {
      skipped = SKELETON_SKIPPED_SECTIONS.test(section[1]);
      continue;
    }
    if (!skipped && /^###\s+\S/.test(line)) findings.push(line);
  }
  return findings;
}

export function judgeSkeleton({ repo, pr }) {
  const { ledgerPath, round, records, dir } = latestReviewRound(repo, pr);
  const target = join(dir, "verdicts.jsonl");
  if (existsSync(target))
    throw new Error(`JUDGE_SKELETON_EXISTS ${ledgerPath}/round-${round}/verdicts.jsonl`);
  const lines = [];
  for (const record of records) {
    const short = record.model.split("/").pop();
    const answer = readFileSync(join(dir, `${short}.md`), "utf8");
    skeletonFindings(answer).forEach((quote, index) => {
      lines.push(
        JSON.stringify({
          id: `${records.length > 1 ? `${short}-` : ""}${index + 1}`,
          model: record.model,
          quote,
          valid: null,
          class: null,
          severity: null,
          trigger: "",
          consequence: "",
          modelSeverity: "",
          why: "",
        }),
      );
    });
  }
  if (lines.length === 0)
    throw new Error(
      `JUDGE_SKELETON_NONE round-${round} 答案里没有找到以「### 」开头的意见，读答案后手写 verdicts.jsonl；确实没有意见就写一个空文件`,
    );
  writeFileSync(target, `${lines.join("\n")}\n`);
  return [
    `JUDGE_SKELETON round=${round} findings=${lines.length} path=${ledgerPath}/round-${round}/verdicts.jsonl`,
    "填好 valid、class、why；成立的会出错再填 severity、trigger、consequence、modelSeverity（判低而模型没给低时加 reason）。不是意见的行删掉，漏掉的意见照格式补一行。",
  ];
}

const VERDICT_LABEL = (verdict) =>
  !verdict.valid
    ? "不成立"
    : verdict.class === "better"
      ? "成立，可以更好"
      : `成立，会出错，${verdict.severity === "low" ? "低" : "中高"}`;

export function finishRound({ repo, pr }) {
  const { ledgerPath, round, records, dir } = latestReviewRound(repo, pr);
  const path = `${ledgerPath}/round-${round}/verdicts.jsonl`;
  const target = join(dir, "verdicts.jsonl");
  if (!existsSync(target)) throw new Error(`FINISH_ROUND_NO_VERDICTS ${path}`);
  const verdicts = parseVerdicts(readFileSync(target, "utf8"), path);
  const problems = [];
  const answers = new Map();
  for (const verdict of verdicts) {
    if (!answers.has(verdict.model)) {
      const file = join(dir, `${verdict.model.split("/").pop()}.md`);
      answers.set(verdict.model, existsSync(file) ? readFileSync(file, "utf8") : "");
    }
    if (!answers.get(verdict.model).includes(verdict.quote))
      problems.push(`quote-not-found ${printable(verdict.id)}`);
    if ((!verdict.valid || verdict.class === "better") && !String(verdict.why ?? "").trim())
      problems.push(`why-missing ${printable(verdict.id)}`);
    if (
      ["why", "trigger", "consequence", "reason"].some(
        (field) =>
          verdict[field] !== undefined &&
          (typeof verdict[field] !== "string" || hasControlCharacter(verdict[field])),
      )
    )
      problems.push(`control-character ${printable(verdict.id)}`);
  }
  if (!COMMIT_PATTERN.test(records[0].base ?? "")) problems.push("base-invalid");
  if (problems.length > 0) throw new Error(`FINISH_ROUND_REFUSED ${problems.join(" ")}`);
  const errors = verdicts.filter((verdict) => verdict.valid && verdict.class === "error");
  const high = errors.filter((verdict) => verdict.severity !== "low");
  const low = errors.filter((verdict) => verdict.severity === "low");
  const better = verdicts.filter((verdict) => verdict.valid && verdict.class === "better");
  const models = [...new Set(records.map((record) => record.model.split("/").pop()))].join("、");
  const judgment = [
    `# PR ${pr} 第 ${round} 轮判断（${models}）`,
    "",
    ...verdicts.map((verdict) => {
      const basis = [
        verdict.why,
        verdict.trigger && `触发：${verdict.trigger}`,
        verdict.consequence && `后果：${verdict.consequence}`,
        verdict.reason && `判低理由：${verdict.reason}`,
      ]
        .filter((part) => String(part ?? "").trim())
        .join("；");
      return `- ${verdict.id}（${verdict.model.split("/").pop()}）${VERDICT_LABEL(verdict)}：${verdict.quote}${basis ? `。${basis}` : ""}`;
    }),
    "",
  ].join("\n");
  writeFileSync(join(dir, "judgments.md"), judgment);
  const record = records[0];
  const reviewed = record.head;
  const lines = [
    `ROUND_SUMMARY pr=${pr} round=${round} reviewed=${reviewed} mediumHigh=${high.length} low=${low.length} better=${better.length} invalid=${verdicts.filter((verdict) => !verdict.valid).length}`,
    `JUDGMENTS_WRITTEN ${ledgerPath}/round-${round}/judgments.md`,
  ];
  const gateway = record.gateway ? ` --gateway ${record.gateway}` : "";
  if (high.length > 0)
    lines.push(
      `NEXT fix-and-rereview node scripts/model-review/opencode-review.mjs --mode code-review --base ${record.base} --head <修改后的提交> --previous ${reviewed} --pr ${pr} --brief <材料文件>${gateway}`,
    );
  else if (low.length > 0 && round < LOW_DEFER_FROM_ROUND)
    lines.push(
      `NEXT fix-low-then node scripts/model-review/opencode-review.mjs --assert-reviewed --pr ${pr} --accept-low ${round}`,
    );
  else if (low.length > 0)
    lines.push(
      `NEXT low-deferred 第 ${round} 轮只剩低意见，不修，--report 会列出：${low.map((verdict) => printable(verdict.id)).join(",")}`,
    );
  else
    lines.push(
      `NEXT done node scripts/model-review/opencode-review.mjs --assert-reviewed --pr ${pr}`,
    );
  if (better.length > 0)
    lines.push(
      `BETTER ${better.map((verdict) => `${printable(verdict.id)}：${printable(verdict.quote)}`).join(" ｜ ")}`,
    );
  return lines;
}

export function reviewReport({ repo, pr, mainRef, stop, andyQuote }) {
  if (!Object.hasOwn(STOP_REASONS, stop)) throw new Error("ARG_INVALID --stop");
  const ledgerPath = `${REVIEWS_DIR}/${reviewKey({ pr })}`;
  const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
  if (shown.status !== 0) throw new Error(`REPORT_LEDGER_NOT_COMMITTED ${ledgerPath}`);
  const records = parseUsage(shown.stdout, `HEAD:${ledgerPath}`);
  const reviews = records.filter((record) => record.mode === "code-review");
  const rounds = [...new Set(reviews.map((record) => record.round ?? 1))];
  const latest = Math.max(0, ...rounds);
  const gate = assertReviewed({ repo, pr, mainRef });
  const latestComplete =
    latest > 0 && gate.accepted.some((point) => point.round === latest && point.by !== "low-fix");
  const consistent = {
    "no-error": latestComplete && gate.problems.length === 0,
    "three-rounds":
      new Set(
        reviews
          .filter((record) => record.outcome !== OWNER_STOPPED)
          .map((record) => record.round ?? 1),
      ).size >= 3,
    "andy-decision": Boolean(andyQuote?.trim()),
    "run-failed": latest > 0 && !latestComplete,
  }[stop];
  if (!consistent) throw new Error(`REPORT_STOP_INCONSISTENT ${stop}`);
  const onChain = (index) =>
    gate.accepted.some((point) => point.by === "low-fix" && point.index === index);
  const lowFixLines = [...records.entries()]
    .filter(([, record]) => record.mode === "low-fix")
    .flatMap(([index, record]) => {
      if (!onChain(index))
        return [
          `REVIEW_LOW_FIX_NOT_IN_CHAIN round=${record.round} head=${record.head} files=${record.files.map(printable).join(",")}`,
        ];
      const path = `${ledgerPath}/round-${record.round}/verdicts.jsonl`;
      const text = gitStatus(["show", `${record.head}:${path}`], repo);
      const verdicts = parseVerdicts(text.stdout, path);
      return [
        `REVIEW_LOW_FIX round=${record.round} from=${record.from} head=${record.head} files=${record.files.map(printable).join(",")}`,
        ...record.findings.map((id) => {
          const verdict = verdicts.find((item) => item.id === id);
          return `  ${printable(id)} ${verdict.model.split("/").pop()}：${printable(verdict.quote)}`;
        }),
      ];
    });
  const deferredLines = deferredLowLines({ repo, ledgerPath, records });
  const overrideLines = records
    .filter((record) => record.mode === "override")
    .map(
      (record) =>
        `REVIEW_OVERRIDE_RECORD head=${record.head} quote=${printable(record.quote)} problems=${(record.problems ?? []).map(printable).join(",") || "none"}`,
    );
  return [
    `REVIEW_REPORT pr=${pr}`,
    ...reviews.map(resultLine),
    `REVIEW_SPENT_TOTAL ${spentOf(records).toFixed(4)}`,
    ...(lowFixLines.length > 0 ? ["低严重度已改、未复核：", ...lowFixLines] : []),
    ...(deferredLines.length > 0
      ? [`低严重度未修（第 ${LOW_DEFER_FROM_ROUND} 轮起只列不修）：`, ...deferredLines]
      : []),
    ...(overrideLines.length > 0 ? ["Andy 说跳过复核的记录：", ...overrideLines] : []),
    ...gate.lines,
    `停下的原因：${STOP_REASONS[stop](andyQuote)}`,
    REVIEW_REPORT_DISCLAIMER,
  ];
}

export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const NOTE_MODES = ["override", "low-fix"];

function hasLineBreak(value) {
  if (typeof value === "string") return /[\r\n]/.test(value);
  if (value && typeof value === "object") return Object.values(value).some(hasLineBreak);
  return false;
}

export function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

export function printable(text) {
  return hasControlCharacter(text) ? JSON.stringify(text) : text;
}

export function providersValid(providers) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return false;
  return Object.values(providers).every(
    (slot) =>
      slot &&
      typeof slot === "object" &&
      Number.isSafeInteger(slot.requests) &&
      slot.requests >= 0 &&
      Number.isSafeInteger(slot.failed) &&
      slot.failed >= 0 &&
      ["credits", "usd"].every(
        (key) => slot[key] === undefined || (Number.isFinite(slot[key]) && slot[key] >= 0),
      ),
  );
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
      const modeValid =
        record?.mode === undefined ||
        MODES.includes(record.mode) ||
        NOTE_MODES.includes(record.mode);
      const fieldsValid =
        !MODES.includes(record?.mode) ||
        ["head", "model", "outcome"].every(
          (field) => typeof record[field] === "string" && record[field] !== "",
        );
      const headValid =
        record?.mode === undefined ||
        record.mode === "override" ||
        COMMIT_PATTERN.test(record.head);
      const lowFixValid =
        record?.mode !== "low-fix" ||
        (Number.isSafeInteger(record.round) &&
          COMMIT_PATTERN.test(record.from ?? "") &&
          record.cost === 0 &&
          [record.files, record.findings].every(
            (list) =>
              Array.isArray(list) &&
              list.length > 0 &&
              list.every((item) => typeof item === "string" && item !== ""),
          ));
      const overrideValid =
        record?.mode !== "override" ||
        (COMMIT_PATTERN.test(record.head ?? "") &&
          typeof record.quote === "string" &&
          record.quote.trim() !== "" &&
          (record.problems === undefined ||
            (Array.isArray(record.problems) &&
              record.problems.every((problem) => typeof problem === "string"))));
      const claimsValid =
        record?.mode !== "plan-claims" ||
        (validClaimsFile(record.claimsFile) &&
          /^[0-9a-f]{64}$/.test(record.claimsSha256 ?? "") &&
          REVIEW_MODELS.includes(record.model) &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(record.at ?? "") &&
          Number.isFinite(Date.parse(record.at)));
      const gatewayValid =
        record?.gateway === undefined ||
        (GATEWAYS.includes(record.gateway) &&
          providersValid(record.providers) &&
          (record.gatewayDropped === undefined ||
            (Array.isArray(record.gatewayDropped) &&
              record.gatewayDropped.every((id) => typeof id === "string" && id !== ""))));
      const singleLine = !hasLineBreak(record ?? {});
      if (
        !Number.isFinite(record?.cost) ||
        record.cost < 0 ||
        !roundValid ||
        !modeValid ||
        !fieldsValid ||
        !headValid ||
        !overrideValid ||
        !lowFixValid ||
        !claimsValid ||
        !gatewayValid ||
        !singleLine
      )
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
  const recorded = records
    .filter((record) => !NOTE_MODES.includes(record.mode))
    .map((record) => record.round ?? 1);
  return Math.max(0, ...recorded, ...rounds) + 1;
}

export function roundForRun({
  records,
  rounds,
  requested,
  mode,
  models,
  head,
  prompts,
  promptsOnDisk,
}) {
  if (requested === undefined) return nextRound(records, rounds);
  const inRound = records.filter(
    (record) => !NOTE_MODES.includes(record.mode) && (record.round ?? 1) === requested,
  );
  if (inRound.length === 0 && !rounds.includes(requested))
    throw new Error(`ROUND_NOT_FOUND ${requested}`);
  const otherMode = inRound.find((record) => record.mode !== undefined && record.mode !== mode);
  if (otherMode) throw new Error(`ROUND_MODE_MISMATCH ${requested} ${otherMode.mode} ${mode}`);
  for (const model of models) {
    if (inRound.some((record) => record.model === model && record.outcome === "ok"))
      throw new Error(`ROUND_ALREADY_HAS_RESULT ${requested} ${model}`);
  }
  if (inRound.some((record) => !record.head))
    throw new Error(`ROUND_CANNOT_VERIFY ${requested} head`);
  const heads = new Set(inRound.map((record) => record.head));
  if ([...heads].some((recorded) => recorded !== head))
    throw new Error(`ROUND_HEAD_MISMATCH ${requested} ${[...heads].join(",")} ${head}`);
  for (const model of models) {
    const onDisk = promptsOnDisk[model] ?? null;
    const recordedDigests = inRound
      .filter((record) => record.model === model && record.promptSha256)
      .map((record) => record.promptSha256);
    const recordedFileDigests = inRound
      .filter((record) => record.model === model && record.promptFileSha256)
      .map((record) => record.promptFileSha256);
    const digest = createHash("sha256").update(prompts[model]).digest("hex");
    if (onDisk === null && recordedDigests.length === 0)
      throw new Error(`ROUND_CANNOT_VERIFY ${requested} ${model}`);
    if (
      (onDisk !== null &&
        onDisk !== maskSecretLike(prompts[model]) &&
        onDisk !== maskSecretLike(prompts[model], { registeredValues: false }) &&
        !recordedFileDigests.includes(createHash("sha256").update(onDisk).digest("hex"))) ||
      recordedDigests.some((recorded) => recorded !== digest)
    )
      throw new Error(`ROUND_PROMPT_MISMATCH ${requested} ${model}`);
  }
  return requested;
}

export const KEPT_FILE_SUFFIXES = [".prompt.md", ".md", ".stderr.txt"];
export const RAW_FILE_SUFFIXES = [".jsonl", ".thinking.md", ".magpie-usage.jsonl"];

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
    ...(process.platform === "linux"
      ? [{ tool: "read", args: { filePath: "/proc/self/environ" } }]
      : []),
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

export function probeModelList() {
  return JSON.stringify({
    object: "list",
    data: REVIEW_MODELS.map((model) => ({ id: groupId(model), object: "model" })),
  });
}

function startStatusServer(status) {
  let hits = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(request.method === "POST" ? status : 200, {
        "content-type": "application/json",
      });
      if (request.method === "POST") hits += 1;
      response.end(
        request.method === "POST" ? '{"error":{"message":"probe down"}}' : probeModelList(),
      );
    });
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, hits: () => hits, port: server.address().port }),
    ),
  );
}

function probeUpstream(id, port) {
  return {
    id,
    kind: "custom",
    url: `http://127.0.0.1:${port}/v1`,
    models: REVIEW_MODELS.map(groupId),
  };
}

async function probeGateway({ gateway, root, upstreams, members }) {
  const live = await startGateway({
    install: gateway.install,
    config: gateway.config,
    root,
    models: Object.keys(members),
    providers: upstreams,
    members,
  });
  try {
    live.addGroups([]);
    await live.serve();
  } catch (error) {
    live.stop();
    throw error;
  }
  return live;
}

function probeMembers(id) {
  return Object.fromEntries(REVIEW_MODELS.map((model) => [model, [`${id}/${groupId(model)}`]]));
}

export function asDirect(text, model) {
  return text
    .split(`${GATEWAY_PROVIDER_ID}/group/${groupName(model)}`)
    .join(model)
    .split(`group/${groupName(model)}`)
    .join(groupId(model));
}

export function systemAsDirect(messages, model) {
  return (messages ?? []).map((message) =>
    message?.role === "system" ? JSON.parse(asDirect(JSON.stringify(message), model)) : message,
  );
}

export function passthroughProblems(direct, via, model) {
  if (!direct || !via) return ["GATEWAY_PASSTHROUGH_NO_REQUEST"];
  const problems = [];
  if (JSON.stringify(direct.messages) !== JSON.stringify(systemAsDirect(via.messages, model)))
    problems.push("GATEWAY_PASSTHROUGH_MESSAGES_CHANGED");
  if (JSON.stringify(direct.tools) !== JSON.stringify(via.tools))
    problems.push("GATEWAY_PASSTHROUGH_TOOLS_CHANGED");
  if (!JSON.stringify(via.messages ?? []).includes(PASSTHROUGH_PROMPT))
    problems.push("GATEWAY_PASSTHROUGH_PROMPT_MASKED");
  return problems;
}

async function passthroughProbe({ binary, copy, workRoot, gitGuard, mode, gateway }) {
  const { server, requests, port } = await startProbeServer([]);
  let live = null;
  try {
    const directPath = join(workRoot, "passthrough-direct.json");
    writeFileSync(
      directPath,
      JSON.stringify(reviewConfig({ mode, baseURL: `http://127.0.0.1:${port}/v1` }), null, 2),
    );
    live = await probeGateway({
      gateway,
      root: join(workRoot, "gateway-passthrough"),
      upstreams: [probeUpstream("probe", port)],
      members: probeMembers("probe"),
    });
    const viaPath = join(workRoot, "passthrough-gateway.json");
    writeFileSync(
      viaPath,
      JSON.stringify(
        reviewConfig({ mode, gateway: { baseURL: live.baseURL, config: gateway.config } }),
        null,
        2,
      ),
    );
    const main = (list) =>
      list.find((request) => Array.isArray(request.tools) && request.tools.length > 0);
    const model = REVIEW_MODELS[0];
    await runOpencode({
      binary,
      cwd: copy,
      configPath: directPath,
      gitGuard,
      model,
      prompt: PASSTHROUGH_PROMPT,
      timeoutMs: 60000,
    });
    const direct = main(requests);
    const before = requests.length;
    await runOpencode({
      binary,
      cwd: copy,
      configPath: viaPath,
      gitGuard,
      model: launchModel(model, gateway),
      prompt: PASSTHROUGH_PROMPT,
      timeoutMs: 60000,
      extraEnv: gatewayOpencodeEnv(),
    });
    return passthroughProblems(direct, main(requests.slice(before)), model);
  } finally {
    live?.stop();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function failoverProbe({ workRoot, gateway }) {
  const down = await startStatusServer(500);
  const up = await startProbeServer([]);
  let live = null;
  try {
    const model = REVIEW_MODELS[0];
    live = await probeGateway({
      gateway,
      root: join(workRoot, "gateway-failover"),
      upstreams: [probeUpstream("probe-down", down.port), probeUpstream("probe", up.port)],
      members: { [model]: [`probe-down/${groupId(model)}`, `probe/${groupId(model)}`] },
    });
    const answer = await postJson(`${live.baseURL}/chat/completions`, {
      model: `group/${groupName(model)}`,
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: "failover probe" }],
    });
    const problems = [];
    if (answer.status !== 200) problems.push(`GATEWAY_FAILOVER_STATUS ${answer.status}`);
    if (answer.headers["x-magpie-provider"] !== "probe")
      problems.push(`GATEWAY_FAILOVER_PROVIDER ${answer.headers["x-magpie-provider"] ?? "none"}`);
    if (down.hits() === 0) problems.push("GATEWAY_FAILOVER_NOT_TRIED");
    return problems;
  } finally {
    live?.stop();
    await new Promise((resolveClose) => down.server.close(resolveClose));
    await new Promise((resolveClose) => up.server.close(resolveClose));
  }
}

function startProbeServer(probes) {
  const requests = [];
  const served = new Map();
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(probeModelList());
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

export const REFUSAL_PATTERNS = [
  /^The user has specified a rule which prevents you/,
  new RegExp(`^${GIT_REFUSED} \\S`),
  /^(?:\S*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted/,
];

export function probeRefused(call) {
  return String(call.output ?? "")
    .split("\n")
    .some((line) => REFUSAL_PATTERNS.some((pattern) => pattern.test(line)));
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
  gateway,
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
    const bounds = outputBounds(String(request.model).split("/").pop(), gateway);
    if (!bounds) problems.push(`PROBE_MODEL_UNKNOWN ${request.model}`);
    if (!(request.max_tokens >= bounds?.min) || !(request.max_tokens <= bounds?.max))
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

export const SELF_CHECK_CACHE_ENV = "HIMAWARI_REVIEW_SELFCHECK_CACHE";
export const SELF_CHECK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SELF_CHECK_CACHE_SMALL_FILE_BYTES = 1024 * 1024;

export function selfCheckCacheDir(env = process.env) {
  const setting = env[SELF_CHECK_CACHE_ENV];
  if (setting === "off") return null;
  return setting || join(homedir(), ".cache", "himawari-review-selfcheck");
}

function fileFingerprint(path) {
  try {
    const stat = statSync(path);
    return {
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: stat.size < SELF_CHECK_CACHE_SMALL_FILE_BYTES ? sha256File(path) : null,
    };
  } catch {
    return { path, missing: true };
  }
}

export function outsideImports(dir) {
  const seen = new Set();
  const outside = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const match of text.matchAll(/(?:from|import\()\s*["'](\.\.?\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), match[1]);
      if (dirname(target) !== dir) outside.add(target);
      visit(target);
    }
  };
  for (const name of readdirSync(dir)
    .filter((item) => item.endsWith(".mjs"))
    .sort())
    visit(join(dir, name));
  return [...outside].sort();
}

export const SELF_CHECK_CACHE_ENV_KEYS = [...OPENCODE_KEPT_ENV, "LC_ALL"];

export function selfCheckCacheKey({ binary, mode, gateway, env = process.env }) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const scripts = readdirSync(scriptDir)
    .filter((name) => /\.(?:mjs|json)$/.test(name))
    .sort()
    .map((name) => [name, sha256File(join(scriptDir, name))]);
  const imported = outsideImports(scriptDir).map((file) => [
    relative(scriptDir, file),
    existsSync(file) ? sha256File(file) : null,
  ]);
  const kept = SELF_CHECK_CACHE_ENV_KEYS.map((name) => [name, env[name] ?? null]);
  const which = (name) =>
    spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  return createHash("sha256")
    .update(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        mode,
        scripts,
        imported,
        env: kept,
        config: reviewConfig({ mode, baseURL: "http://127.0.0.1:0/v1" }),
        binary: fileFingerprint(binary),
        git: fileFingerprint(which("git")),
        bash: fileFingerprint(which("bash")),
        gateway: gateway ? { install: gateway.install, config: gateway.config } : null,
      }),
    )
    .digest("hex");
}

export function selfCheckCacheHit({ key, now = Date.now(), env = process.env }) {
  const dir = selfCheckCacheDir(env);
  if (!dir) return false;
  try {
    const record = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"));
    return (
      record?.key === key &&
      Number.isFinite(record.at) &&
      now - record.at < SELF_CHECK_CACHE_MAX_AGE_MS &&
      record.at <= now
    );
  } catch {
    return false;
  }
}

export function selfCheckCacheWrite({ key, now = Date.now(), env = process.env }) {
  const dir = selfCheckCacheDir(env);
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${key}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ key, at: now })}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch {}
}

export async function selfCheck({
  binary,
  copy,
  workRoot,
  gitGuard,
  mode,
  timeoutMs,
  gateway,
  cached = false,
}) {
  const plan = probePlan(
    workRoot,
    git(["ls-files"], copy)
      .split("\n")
      .find((file) => file && !/\s/.test(file)),
  );
  for (const file of plan.outsideFiles) writeFileSync(file, `${plan.marker}\n${file}\n`);
  const { server, requests, port } = await startProbeServer(plan.probes);
  let live = null;
  const savedCanary = process.env[REVIEW_PARENT_CANARY_ENV];
  process.env[REVIEW_PARENT_CANARY_ENV] = plan.marker;
  try {
    if (gateway)
      live = await probeGateway({
        gateway,
        root: join(workRoot, "gateway-probe"),
        upstreams: [probeUpstream("probe", port)],
        members: probeMembers("probe"),
      });
    const configPath = join(workRoot, "probe-opencode.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        live
          ? reviewConfig({ mode, gateway: { baseURL: live.baseURL, config: gateway.config } })
          : reviewConfig({ mode, baseURL: `http://127.0.0.1:${port}/v1` }),
        null,
        2,
      ),
    );
    const problems = [];
    for (const model of cached ? REVIEW_MODELS.slice(0, 1) : REVIEW_MODELS) {
      const before = requests.length;
      const run = await runOpencode({
        binary,
        cwd: copy,
        configPath,
        gitGuard,
        model: launchModel(model, gateway),
        prompt: "probe",
        timeoutMs,
        extraEnv: { [REVIEW_CANARY_ENV]: plan.marker, ...(gateway ? gatewayOpencodeEnv() : {}) },
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
          gateway,
        }).map((problem) => `${model}: ${problem}`),
      );
    }
    live?.stop();
    live = null;
    if (!cached)
      problems.push(...(await guardProbe({ binary, copy, workRoot, gitGuard, mode, gateway })));
    if (gateway) {
      if (!cached)
        problems.push(
          ...(await passthroughProbe({ binary, copy, workRoot, gitGuard, mode, gateway })),
          ...(await failoverProbe({ workRoot, gateway })),
        );
      const changed = binaryProblem(gateway.install);
      if (changed) problems.push(changed);
    }
    return problems;
  } finally {
    live?.stop();
    if (savedCanary === undefined) delete process.env[REVIEW_PARENT_CANARY_ENV];
    else process.env[REVIEW_PARENT_CANARY_ENV] = savedCanary;
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

export const GUARD_PROBE_OPEN_USD = 1e9;
export const GUARD_PROBE_REQUESTS = 3;

function startLoopServer() {
  let mainRequests = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(probeModelList());
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

async function guardProbe({ binary, copy, workRoot, gitGuard, mode, gateway }) {
  const { server, mainRequests, port } = await startLoopServer();
  let live = null;
  try {
    if (gateway)
      live = await probeGateway({
        gateway,
        root: join(workRoot, "gateway-guard"),
        upstreams: [probeUpstream("probe", port)],
        members: probeMembers("probe"),
      });
    const configPath = join(workRoot, "guard-probe-opencode.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        live
          ? reviewConfig({ mode, gateway: { baseURL: live.baseURL, config: gateway.config } })
          : reviewConfig({ mode, baseURL: `http://127.0.0.1:${port}/v1` }),
        null,
        2,
      ),
    );
    const run = await runOpencode({
      binary,
      cwd: copy,
      configPath,
      gitGuard,
      model: launchModel(REVIEW_MODELS[0], gateway),
      prompt: "probe",
      timeoutMs: 20000,
      extraEnv: gateway ? gatewayOpencodeEnv() : {},
      guard: { totalUsd: GUARD_PROBE_OPEN_USD, stopAfterRequests: GUARD_PROBE_REQUESTS },
    });
    const problems = [];
    if (!run.guard?.loaded) problems.push("GUARD_PROBE_NOT_LOADED");
    else if (mainRequests() !== GUARD_PROBE_REQUESTS)
      problems.push(`GUARD_PROBE_REQUESTS expected=${GUARD_PROBE_REQUESTS} got=${mainRequests()}`);
    else if (run.stopReason !== "request-limit")
      problems.push(`GUARD_PROBE_REASON ${run.stopReason}`);
    if (gateway && !(summarizeEvents(run.stdout).usage.cost > 0))
      problems.push("GATEWAY_COST_NOT_COUNTED");
    return problems;
  } finally {
    live?.stop();
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

export function questionsSource(repo, commits, questionsRef) {
  const ref = questionsRef
    ? git(["rev-parse", "--verify", "--quiet", `${questionsRef}^{commit}`], repo)
    : (commits.base ?? commits.head);
  return git(["show", `${ref}:${QUESTIONS_PATH}`], repo);
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
  const repoId = createHash("sha256").update(resolve(options.repo)).digest("hex").slice(0, 12);
  return join(tmpdir(), "himawari-review-raw", repoId, reviewKey(options), `round-${round}`);
}

export function recordText(text) {
  return `${text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "")}\n`;
}

export const RECORD_SECRET_RULES = Object.freeze([
  [
    "private-key-block",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ],
  [
    "private-key-any-block",
    /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi,
  ],
  ["private-key-header", /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi],
  ["authorization-bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  ["jwt-token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["openai-api-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ["github-token", /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "credential-assignment",
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi,
  ],
]);

const REGISTERED_VALUE_RULE_ID = "registered-test-value";
const REGISTERED_VALUE_MIN_LENGTH = 12;
let registeredTestValues = [];

export function setRegisteredTestValues(values) {
  registeredTestValues = [...new Set(values)].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : 1),
  );
}

export function registeredTestValuesFromToml(text) {
  const values = new Set();
  for (const match of text.matchAll(/^regexes\s*=\s*\[\s*'''\^([^\n]*?)\$'''\s*\]\s*$/gm)) {
    const literal = match[1].replaceAll("\\.", ".");
    if (literal.length >= REGISTERED_VALUE_MIN_LENGTH && /^[A-Za-z0-9_\-=.:/ ]+$/.test(literal))
      values.add(literal);
  }
  return [...values];
}

export function loadRegisteredTestValues(repo, ref) {
  const shown = gitStatus(["show", `${ref}:ci/rules/gitleaks.toml`], repo);
  if (shown.status !== 0) throw new Error(`REGISTERED_VALUES_UNREADABLE ${ref}`);
  return registeredTestValuesFromToml(shown.stdout);
}

function registeredValuesPattern() {
  if (registeredTestValues.length === 0) return null;
  return new RegExp(
    registeredTestValues.map((value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"),
    "g",
  );
}

export function maskSecretLike(text, { registeredValues = true } = {}) {
  const registered = registeredValues ? registeredValuesPattern() : null;
  let masked = text;
  for (const [id, pattern] of RECORD_SECRET_RULES)
    masked = masked.replace(new RegExp(pattern.source, pattern.flags), `[已遮盖:${id}]`);
  return registered ? masked.replace(registered, `[已遮盖:${REGISTERED_VALUE_RULE_ID}]`) : masked;
}

export function registerTestValuesFromRefs(repo, refs) {
  const values = [];
  for (const ref of refs) {
    if (gitStatus(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo).status !== 0)
      continue;
    values.push(...loadRegisteredTestValues(repo, ref));
  }
  setRegisteredTestValues(values);
}

export function secretLikeRules(text) {
  return RECORD_SECRET_RULES.filter(([, pattern]) =>
    new RegExp(pattern.source, pattern.flags).test(text),
  ).map(([id]) => id);
}

export function maskedRecordText(text) {
  return maskSecretLike(recordText(text));
}

function maskSecretLikeDeep(value) {
  if (typeof value === "string") return maskSecretLike(value);
  if (Array.isArray(value)) return value.map(maskSecretLikeDeep);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskSecretLikeDeep(item)]),
    );
  return value;
}

export function claimsFileSecretLike(file) {
  return maskSecretLike(file) !== file;
}

export function ledgerLine(record) {
  return `${JSON.stringify(maskSecretLikeDeep(record))}\n`;
}

function recordFileProblems(repo, files) {
  const problems = [];
  for (const file of files) {
    const shown = gitStatus(["show", `HEAD:${file}`], repo);
    if (shown.status !== 0) {
      problems.push(`record-unreadable ${printable(file)}`);
      continue;
    }
    for (const id of secretLikeRules(shown.stdout))
      problems.push(`record-secret-like ${printable(file)} ${id}`);
  }
  return problems;
}

export function recordSecretProblems({ repo, ledgerPath, otherFiles = [] }) {
  const listed = gitStatus(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ledgerPath], repo);
  if (listed.status !== 0) return [`record-unreadable ${printable(ledgerPath)}`];
  const others = otherFiles.filter(
    (file) =>
      file.startsWith(`${REVIEWS_DIR}/`) &&
      gitStatus(["cat-file", "-e", `HEAD:${file}`], repo).status === 0,
  );
  return recordFileProblems(repo, [...listed.stdout.split("\0").filter(Boolean), ...others]);
}

export function prepareRawDir(dir, root = join(tmpdir(), "himawari-review-raw")) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function promptFileName(model) {
  return `${model.split("/").pop()}.prompt.md`;
}

export const SUBCOMMAND_ONLY_OPTIONS = ["--main-ref", "--stop", "--andy-quote"];
export const ROUND_TOOL_OPTIONS = ["--judge-skeleton", "--finish-round", "--pr", "--repo"];
export const ASSERT_OPTIONS = [
  "--assert-reviewed",
  "--pr",
  "--repo",
  "--main-ref",
  "--accept-unreviewed",
  "--accept-low",
];
export const REPORT_OPTIONS = [
  "--report",
  "--pr",
  "--repo",
  "--main-ref",
  "--stop",
  "--andy-quote",
];

export function gatewayRequiredProblem(options, env) {
  if (!options.requireGateway || options.selfCheckOnly) return null;
  if (env.HIMAWARI_REVIEW_GATEWAY !== "magpie") return "not-cloud";
  return PROXY_ENV.some((name) => (env[name] ?? "").trim() !== "") ? null : "no-proxy";
}

export function parseArgs(argv, { defaultGateway = "" } = {}) {
  const options = {
    mode: "code-review",
    repo: repoRoot,
    timeoutMinutes: 25,
    models: DEFAULT_REVIEW_MODELS,
  };
  const given = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    given.add(key);
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
    else if (key === "--claims-file") {
      options.claimsFile = take();
      if (!validClaimsFile(options.claimsFile) || claimsFileSecretLike(options.claimsFile))
        throw new Error("ARG_INVALID --claims-file");
    } else if (key === "--out") options.out = resolve(take());
    else if (key === "--pr") {
      options.pr = Number(take());
      if (!Number.isSafeInteger(options.pr) || options.pr <= 0) throw new Error("ARG_INVALID --pr");
    } else if (key === "--topic") {
      options.topic = take();
      if (!TOPIC_PATTERN.test(options.topic)) throw new Error("ARG_INVALID --topic");
    } else if (key === "--timeout-minutes") options.timeoutMinutes = Number(take());
    else if (key === "--self-check-only") options.selfCheckOnly = true;
    else if (key === "--require-gateway") options.requireGateway = true;
    else if (key === "--assert-reviewed") options.assertReviewed = true;
    else if (key === "--report") options.report = true;
    else if (key === "--judge-skeleton") options.judgeSkeleton = true;
    else if (key === "--finish-round") options.finishRound = true;
    else if (key === "--stop") options.stop = take();
    else if (key === "--andy-quote") {
      options.andyQuote = take();
      if (hasControlCharacter(options.andyQuote)) throw new Error("ARG_INVALID --andy-quote");
    } else if (key === "--main-ref") {
      options.mainRef = take();
      if (options.mainRef.startsWith("-") || hasControlCharacter(options.mainRef))
        throw new Error("ARG_INVALID --main-ref");
    } else if (key === "--questions-ref") {
      options.questionsRef = take();
      if (options.questionsRef.startsWith("-") || hasControlCharacter(options.questionsRef))
        throw new Error("ARG_INVALID --questions-ref");
    } else if (key === "--accept-unreviewed") {
      options.acceptUnreviewed = take();
      if (!options.acceptUnreviewed.trim() || hasControlCharacter(options.acceptUnreviewed))
        throw new Error("ARG_INVALID --accept-unreviewed");
    } else if (key === "--accept-low") {
      options.acceptLow = Number(take());
      if (!Number.isSafeInteger(options.acceptLow) || options.acceptLow <= 0)
        throw new Error("ARG_INVALID --accept-low");
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
    } else if (key === "--gateway") {
      options.gateway = take();
      if (!GATEWAY_CHOICES.includes(options.gateway)) throw new Error("ARG_INVALID --gateway");
    } else if (key === "--providers") {
      options.providers = [
        ...new Set(
          take()
            .split(",")
            .map((id) => id.trim()),
        ),
      ];
      if (options.providers.some((id) => !id || hasControlCharacter(id)))
        throw new Error("ARG_INVALID --providers");
    } else if (key === "--approved-usd") {
      options.approvedUsd = Number(take());
      if (!Number.isFinite(options.approvedUsd) || options.approvedUsd <= 0)
        throw new Error("ARG_INVALID --approved-usd");
    } else throw new Error(`ARG_UNKNOWN ${key}`);
  }
  if (!MODES.includes(options.mode)) throw new Error(`MODE_UNKNOWN ${options.mode}`);
  if (options.judgeSkeleton || options.finishRound) {
    if (options.judgeSkeleton && options.finishRound) throw new Error("ARG_SKELETON_AND_FINISH");
    const extra = [...given].filter((key) => !ROUND_TOOL_OPTIONS.includes(key));
    if (extra.length > 0) throw new Error(`ARG_NOT_FOR_SUBCOMMAND ${extra.join(" ")}`);
    if (options.pr === undefined) throw new Error("ARG_REQUIRED --pr");
    return options;
  }
  if (options.assertReviewed || options.report) {
    if (options.assertReviewed && options.report) throw new Error("ARG_ASSERT_AND_REPORT");
    const allowed = options.report ? REPORT_OPTIONS : ASSERT_OPTIONS;
    const extra = [...given].filter((key) => !allowed.includes(key));
    if (extra.length > 0) throw new Error(`ARG_NOT_FOR_SUBCOMMAND ${extra.join(" ")}`);
    if (options.pr === undefined) throw new Error("ARG_REQUIRED --pr");
    if (options.report && options.stop === undefined) throw new Error("ARG_REQUIRED --stop");
    if (options.acceptLow !== undefined && options.acceptUnreviewed !== undefined)
      throw new Error("ARG_ACCEPT_LOW_AND_UNREVIEWED");
    return options;
  }
  if (options.gateway === undefined && defaultGateway) {
    if (!GATEWAY_CHOICES.includes(defaultGateway))
      throw new Error("ARG_INVALID HIMAWARI_REVIEW_GATEWAY");
    options.gateway = defaultGateway;
  }
  if (options.gateway === "direct") delete options.gateway;
  if (options.requireGateway && options.gateway !== "magpie")
    throw new Error("GATEWAY_REQUIRED not-magpie");
  if (options.providers && options.gateway !== "magpie")
    throw new Error("ARG_PROVIDERS_NEED_GATEWAY");
  if (options.providers && options.selfCheckOnly)
    throw new Error("ARG_PROVIDERS_NOT_FOR_SELF_CHECK");
  if (options.acceptUnreviewed !== undefined)
    throw new Error("ARG_ACCEPT_UNREVIEWED_ONLY_WITH_ASSERT");
  if (options.acceptLow !== undefined) throw new Error("ARG_ACCEPT_LOW_ONLY_WITH_ASSERT");
  const subcommandOnly = [...given].filter((key) => SUBCOMMAND_ONLY_OPTIONS.includes(key));
  if (subcommandOnly.length > 0) throw new Error(`ARG_NOT_FOR_MODE ${subcommandOnly.join(" ")}`);
  const claimsMode = options.mode === "plan-claims";
  if (claimsMode && options.brief) throw new Error("ARG_BRIEF_NOT_FOR_PLAN_CLAIMS");
  if (!claimsMode && options.claimsFile) throw new Error("ARG_CLAIMS_FILE_ONLY_FOR_PLAN_CLAIMS");
  if (claimsMode && !options.claimsFile) throw new Error("ARG_REQUIRED --claims-file");
  for (const required of claimsMode ? ["head"] : ["head", "brief"]) {
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

export function gatewayRecordFields(usage, config, model, { requested = false } = {}) {
  const unknown = { gateway: "magpie", providers: {}, costUnknown: true };
  if (usage === null)
    return requested
      ? { ...unknown, costUnknownWhy: "usage-unreadable" }
      : { gateway: "magpie", providers: {} };
  try {
    const { byModel, unattributed, unreadableByModel } = summarizeGatewayUsage(usage, config);
    const providers = byModel[model] ?? {};
    if (!providersValid(providers)) return { ...unknown, costUnknownWhy: "providers-invalid" };
    const unreadable = unattributed + (unreadableByModel[model] ?? 0);
    const recorded = Object.values(providers).reduce((total, slot) => total + slot.requests, 0);
    const missing = recorded < Number(requested);
    return unreadable > 0 || missing
      ? {
          ...unknown,
          providers,
          costUnknownWhy: `unreadable=${unreadable} recorded=${recorded} requested=${Number(requested)}`,
        }
      : { gateway: "magpie", providers };
  } catch {
    return { ...unknown, costUnknownWhy: "usage-invalid" };
  }
}

export function providerMoneyUsd(providers, creditProvider) {
  return Object.entries(providers ?? {})
    .filter(([provider]) => provider !== creditProvider)
    .reduce((total, [, slot]) => total + (slot.usd ?? 0), 0);
}

export function withProviderMoney(record, creditProvider) {
  if (!record.gateway) return record;
  const money = providerMoneyUsd(record.providers, creditProvider);
  return money > record.cost ? { ...record, cost: money, costFromProviders: record.cost } : record;
}

export function gatewayRequested(review) {
  const allowed = review.runs.reduce((total, run) => total + (run.guard?.allowed ?? 0), 0);
  return Math.max(review.summary.usage.steps, allowed);
}

export function timingLine(record) {
  const seconds = (ms) => (Number.isFinite(ms) ? Math.round(ms / 1000) : "-");
  const timing = record.gatewayTiming;
  return [
    `REVIEW_TIMING ${record.model}`,
    `selfCheck=${seconds(record.selfCheckMs)}s`,
    `run=${seconds(record.runMs)}s`,
    `steps=${record.steps}`,
    ...(timing
      ? [
          `requests=${timing.requests}`,
          `model=${seconds(timing.modelMs)}s`,
          `firstToken=${seconds(timing.firstTokenMs)}s`,
          `slowest=${seconds(timing.slowestMs)}s`,
          `cacheMisses=${timing.cacheMisses}`,
          `missTokens=${timing.missTokens}`,
        ]
      : []),
  ].join(" ");
}

export function gatewayUsageLine(record) {
  const parts = Object.entries(record.providers ?? {}).map(
    ([provider, slot]) =>
      `${provider} requests=${slot.requests} failed=${slot.failed}${slot.credits === undefined ? "" : ` credits=${slot.credits.toFixed(2)}`}${slot.usd === undefined ? "" : ` usd=${slot.usd.toFixed(4)}`}`,
  );
  const dropped = record.gatewayDropped?.length
    ? ` dropped=${record.gatewayDropped.join(",")}`
    : "";
  return `GATEWAY_USAGE ${record.model} ${parts.length ? parts.join(" ; ") : "none"}${dropped}`;
}

export function reserveModels({ mode, models }) {
  const substitute = SUBSTITUTES[models[0]];
  if (mode === "code-review" && models.length === 1 && substitute) return [...models, substitute];
  return models;
}

function tryWrite(path, text) {
  try {
    writeFileSync(path, text);
  } catch (error) {
    console.log(`REVIEW_DIAGNOSTIC_NOT_SAVED ${error.message}`);
  }
}

export function usesCreditProvider(drop, creditProvider) {
  return !drop.includes(creditProvider);
}

export async function startLiveGateway({
  gateway,
  workRoot,
  records,
  models,
  reserveFor = models,
  accountUid = () => workbuddyAccountUid(process.env),
  only,
}) {
  const { config } = gateway;
  const ids = config.providers.map((provider) => provider.id);
  const unrequested = ids.filter((id) => only && !only.includes(id));
  for (const id of unrequested) console.log(`GATEWAY_PROVIDER_DROPPED ${id} requested`);
  const wantsCredit = !unrequested.includes(config.creditProvider);
  const uid = wantsCredit ? accountUid() : null;
  const withCredit = config.providers
    .filter((provider) => !unrequested.includes(provider.id))
    .map((provider) =>
      provider.signIn ? (uid ? { ...provider, signIn: { uid } } : null) : provider,
    )
    .filter(Boolean);
  if (wantsCredit && !uid)
    console.log(`GATEWAY_CREDIT_FLOOR ${config.creditProvider} sign-in-unavailable`);
  const startOnce = (providers, root) =>
    startGateway({
      install: gateway.install,
      config,
      root,
      models: reserveFor,
      providers,
      log: (line) => console.log(line),
    });
  const start = async (providers, root) => {
    try {
      return await startOnce(providers, root);
    } catch (error) {
      throw error.message.startsWith("GATEWAY_PREFLIGHT_FAILED")
        ? error
        : new Error(`GATEWAY_PREFLIGHT_FAILED ${error.message}`);
    }
  };
  let live;
  let drop = [...unrequested, ...(wantsCredit && !uid ? [config.creditProvider] : [])];
  try {
    live = await start(withCredit, join(workRoot, "gateway-live"));
  } catch (error) {
    if (!withCredit.some((provider) => provider.id === config.creditProvider)) throw error;
    console.log(`GATEWAY_CREDIT_FLOOR ${config.creditProvider} start-failed ${error.message}`);
    drop = [...drop, config.creditProvider];
    live = await start(
      withCredit.filter((provider) => provider.id !== config.creditProvider),
      join(workRoot, "gateway-live-fallback"),
    );
  }
  if (usesCreditProvider(drop, config.creditProvider)) {
    const left = live.quota(config.creditProvider);
    const reserve = creditReserve({
      records,
      models: reserveFor,
      costLimitUsd: COST_LIMIT_PER_MODEL_USD,
      provider: config.creditProvider,
      fallback: config.defaultCreditsPerUsd,
    });
    const decision = floorDecision({ left, reserve, floor: config.creditFloor });
    if (decision.use)
      console.log(
        `GATEWAY_CREDITS ${config.creditProvider} left=${left.toFixed(2)} reserve=${reserve.toFixed(2)} floor=${config.creditFloor}`,
      );
    else {
      console.log(`GATEWAY_CREDIT_FLOOR ${config.creditProvider} ${decision.reason}`);
      drop = [...drop, config.creditProvider];
    }
  }
  const dropProviders = (missing) => {
    const unavailable = [...new Set(missing.map((member) => member.split("/")[0]))];
    for (const provider of unavailable)
      console.log(
        `GATEWAY_PROVIDER_DROPPED ${provider} missing=${missing.filter((member) => member.startsWith(`${provider}/`)).join(",")}`,
      );
    drop = [...drop, ...unavailable];
  };
  const addGroups = () => {
    for (;;) {
      try {
        live.addGroups(drop);
        return;
      } catch (error) {
        const member = error.message.match(/knows no model "([^"]+)"/)?.[1];
        if (!member || drop.includes(member.split("/")[0])) throw error;
        dropProviders([member]);
      }
    }
  };
  const missingMembers = async () => {
    const listed = await getJson(`${live.baseURL}/models`);
    if (listed.status !== 200) throw new Error(`GATEWAY_PREFLIGHT_FAILED models=${listed.status}`);
    const ids = new Set((listed.json?.data ?? []).map((item) => item.id));
    return models.flatMap((model) =>
      config.models[model].members.filter(
        (member) => !drop.includes(member.split("/")[0]) && !ids.has(member),
      ),
    );
  };
  try {
    addGroups();
    await live.serve();
    const missing = await missingMembers();
    if (missing.length > 0) {
      dropProviders(missing);
      live.stop();
      addGroups();
      await live.serve();
      const still = await missingMembers();
      if (still.length > 0) throw new Error(`GATEWAY_PREFLIGHT_FAILED missing=${still.join(",")}`);
    }
  } catch (error) {
    live.stop();
    throw error.message.startsWith("GATEWAY_PREFLIGHT_FAILED")
      ? error
      : new Error(`GATEWAY_PREFLIGHT_FAILED ${error.message}`);
  }
  return { live, drop: ids.filter((id) => drop.includes(id)) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    defaultGateway: process.env.HIMAWARI_REVIEW_GATEWAY,
  });
  if (options.report) {
    for (const line of reviewReport(options)) console.log(line);
    return;
  }
  if (options.judgeSkeleton) {
    for (const line of judgeSkeleton(options)) console.log(line);
    return;
  }
  if (options.finishRound) {
    for (const line of finishRound(options)) console.log(line);
    return;
  }
  if (options.assertReviewed) {
    const result = assertReviewed(options);
    for (const line of result.lines) console.log(line);
    if ((result.problems.length > 0 && !result.overridden) || result.lowFixRefused)
      process.exitCode = 5;
    return;
  }
  const missingProxy = gatewayRequiredProblem(options, process.env);
  if (missingProxy) throw new Error(`GATEWAY_REQUIRED ${missingProxy}`);
  const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
  const unknownProvider = (options.providers ?? []).find(
    (id) => !gatewayConfig.providers.some((provider) => provider.id === id),
  );
  if (unknownProvider) throw new Error(`ARG_INVALID --providers ${unknownProvider}`);
  const timeoutMs = options.timeoutMinutes * 60 * 1000;
  const commits = resolveCommits(options.repo, options);
  registerTestValuesFromRefs(options.repo, [commits.base ?? commits.head, "origin/main"]);
  if (options.claimsFile && claimsFileSecretLike(options.claimsFile))
    throw new Error(`CLAIMS_FILE_SECRET_LIKE ${options.claimsFile}`);
  const claimsMode = options.mode === "plan-claims";
  const claimsBlob = claimsMode
    ? claimsBlobAt(options.repo, commits.head, options.claimsFile)
    : null;
  if (claimsMode && claimsBlob === null)
    throw new Error(`CLAIMS_FILE_NOT_COMMITTED ${options.claimsFile} ${commits.head}`);
  const claimsRecord = claimsMode
    ? {
        claimsFile: options.claimsFile,
        claimsSha256: claimsBlobSha256(options.repo, commits.head, options.claimsFile),
      }
    : {};
  const questions = claimsMode
    ? []
    : reviewQuestions(questionsSource(options.repo, commits, options.questionsRef));
  const brief = claimsMode
    ? recordText(
        `方案文件：${options.claimsFile}（在提交 ${commits.head} 里的内容）\n\n${claimsBlob.toString("utf8")}`,
      )
    : recordText(readFileSync(options.brief, "utf8"));
  const claimsBase = claimsMode
    ? (() => {
        const base = spawnSync("git", ["merge-base", "origin/main", commits.head], {
          cwd: options.repo,
          encoding: "utf8",
        });
        return base.status === 0 ? base.stdout.trim() : null;
      })()
    : null;
  const priorFindings =
    commits.previous && !options.selfCheckOnly
      ? priorFindingsBlock({
          repo: options.repo,
          ledgerPath: `${REVIEWS_DIR}/${reviewKey(options)}`,
          records: readUsage(options.out),
          previous: commits.previous,
          head: commits.head,
        })
      : null;
  const prompts = Object.fromEntries(
    options.models.map((model) => [
      model,
      buildPrompt({ ...options, ...commits, model, questions, priorFindings, claimsBase, brief }),
    ]),
  );
  for (const prompt of Object.values(prompts))
    if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE");
  const proxyProblems = proxyCredentialProblems(process.env);
  if (proxyProblems.length > 0) throw new Error(`PROXY_HAS_CREDENTIALS ${proxyProblems.join(" ")}`);
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
        mode: options.mode,
        models: options.models,
        head: commits.head,
        prompts,
        promptsOnDisk: Object.fromEntries(
          options.models.map((model) => [model, promptOnDisk(model)]),
        ),
      });
  const binary = opencodeBinary();
  const gateway = gatewayConfig ? { install: installGateway(), config: gatewayConfig } : null;
  if (gateway) {
    const changed = binaryProblem(gateway.install);
    if (changed) throw new Error(changed);
  }
  const workRoot = mkdtempSync(join(tmpdir(), "opencode-review-"));
  const copy = join(workRoot, "repo");
  const cleanup = () => {
    stopAllGateways();
    for (const child of activeChildren) killProcessGroup(child, "SIGKILL");
    rmSync(workRoot, { recursive: true, force: true });
  };
  let modelsRunning = false;
  const onSignal = signalHandler({
    running: () => modelsRunning,
    requestStop,
    cleanup,
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  console.log(`REVIEW_PID ${process.pid}`);
  try {
    const removed = prepareCopy({ repo: options.repo, copy, commits, workRoot });
    if (removed.length > 0) console.log(`UNSAFE_PROJECT_FILES_REMOVED ${removed.length}`);
    const gitGuard = installGitGuard(workRoot);
    const selfCheckStartedAt = Date.now();
    const cacheKey = selfCheckCacheDir()
      ? selfCheckCacheKey({ binary, mode: options.mode, gateway })
      : null;
    const cached =
      Boolean(cacheKey) && !options.selfCheckOnly && selfCheckCacheHit({ key: cacheKey });
    const problems = await selfCheck({
      binary,
      copy,
      workRoot,
      gitGuard,
      mode: options.mode,
      timeoutMs: 180000,
      gateway,
      cached,
    });
    if (problems.length > 0) {
      console.error(`SELF_CHECK_FAILED ${problems.join(" | ")}`);
      process.exitCode = 3;
      return;
    }
    if (cacheKey && !cached) selfCheckCacheWrite({ key: cacheKey });
    const selfCheckMs = Date.now() - selfCheckStartedAt;
    console.log(
      `SELF_CHECK_OK ms=${selfCheckMs} cache=${cacheKey ? (cached ? "hit" : "miss") : "off"}`,
    );
    if (options.selfCheckOnly) return;
    let liveGateway = null;
    if (gateway) {
      liveGateway = await startLiveGateway({
        gateway,
        workRoot,
        records,
        models: options.models,
        reserveFor: reserveModels(options),
        only: options.providers,
      });
    }
    const routed = liveGateway
      ? { baseURL: liveGateway.live.baseURL, config: gateway.config }
      : undefined;
    const configPath = join(workRoot, "opencode.json");
    writeFileSync(
      configPath,
      JSON.stringify(reviewConfig({ mode: options.mode, gateway: routed }), null, 2),
    );
    const wrapUpConfigPath = join(workRoot, "opencode-wrap-up.json");
    writeFileSync(
      wrapUpConfigPath,
      JSON.stringify(reviewConfig({ mode: options.mode, wrapUp: true, gateway: routed }), null, 2),
    );
    const roundDir = join(options.out, `round-${round}`);
    const roundRawDir = rawDir(options, round);
    mkdirSync(roundDir, { recursive: true });
    prepareRawDir(roundRawDir);
    console.log(`REVIEW_RAW_DIR ${roundRawDir}`);
    const runOne = async (model, prompt, extra = {}) => {
      const name = model.split("/").pop();
      keepEarlierAttempt(roundDir, name);
      keepEarlierAttempt(roundRawDir, name, RAW_FILE_SUFFIXES);
      writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));
      const runStartedAt = Date.now();
      const review = await reviewModel({
        binary,
        cwd: copy,
        configPath,
        wrapUpConfigPath,
        gitGuard,
        model: launchModel(model, routed),
        prompt,
        timeoutMs,
        extraEnv: routed ? gatewayOpencodeEnv() : {},
      });
      const runMs = Date.now() - runStartedAt;
      writeFileSync(join(roundRawDir, `${name}.jsonl`), review.stdout);
      const gatewayUsage = liveGateway ? await liveGateway.live.stableUsage() : null;
      const timing = liveGateway ? gatewayTiming(gatewayUsage, model) : null;
      const { summary } = review;
      writeFileSync(join(roundDir, `${name}.md`), maskedRecordText(summary.text));
      if (summary.thinking)
        writeFileSync(join(roundRawDir, `${name}.thinking.md`), `${summary.thinking}\n`);
      const assembled = {
        at: new Date().toISOString(),
        round,
        mode: options.mode,
        model,
        head: commits.head,
        base: commits.base ?? null,
        previous: commits.previous ?? null,
        promptSha256: createHash("sha256").update(prompt).digest("hex"),
        promptFileSha256: createHash("sha256").update(maskSecretLike(prompt)).digest("hex"),
        ...claimsRecord,
        outcome: review.outcome,
        wrapUp: review.wrapUp,
        wrapUpSkipped: review.wrapUpSkipped,
        lastReason: summary.lastReason,
        exitCode: review.runs.at(-1).code,
        ...summary.usage,
        toolCalls: summary.toolCalls.length,
        selfCheckMs,
        runMs,
        ...(timing ? { gatewayTiming: timing } : {}),
        ...(summary.apiError ? { apiError: apiErrorText(summary.apiError) } : {}),
        ...(review.retry ? { retry: review.retry } : {}),
        ...(review.retriedAfter ? { retriedAfter: review.retriedAfter } : {}),
        ...(liveGateway
          ? {
              ...gatewayRecordFields(gatewayUsage, gateway.config, model, {
                requested: gatewayRequested(review),
              }),
              ...(liveGateway.drop.length ? { gatewayDropped: liveGateway.drop } : {}),
            }
          : {}),
        ...extra,
      };
      const record = gateway
        ? withProviderMoney(assembled, gateway.config.creditProvider)
        : assembled;
      appendFileSync(join(options.out, "usage.jsonl"), ledgerLine(record));
      if (record.costUnknownWhy) {
        console.log(`GATEWAY_COST_UNKNOWN ${model} ${record.costUnknownWhy}`);
        tryWrite(
          join(roundRawDir, `${name}.magpie-usage.jsonl`),
          (gatewayUsage ?? []).map((line) => `${JSON.stringify(line)}\n`).join(""),
        );
      }
      if (record.outcome !== "ok" && review.stderr.trim()) {
        writeFileSync(join(roundDir, `${name}.stderr.txt`), maskedRecordText(review.stderr));
      }
      return { record, review };
    };
    modelsRunning = true;
    const runs = await Promise.all(options.models.map((model) => runOne(model, prompts[model])));
    const results = runs.map((run) => run.record);
    const substitute = stopRequested ? null : substituteFor({ ...options, ...commits, runs });
    if (substitute) {
      const substitutePrompt = buildPrompt({
        ...options,
        ...commits,
        model: substitute.model,
        questions,
        priorFindings,
        claimsBase,
        brief,
      });
      const refused =
        Buffer.byteLength(substitutePrompt) > 100000
          ? "PROMPT_TOO_LARGE"
          : budgetCheck({
              mode: options.mode,
              records: readUsage(options.out),
              models: [substitute.model],
              approvedUsd: options.approvedUsd,
            });
      if (refused) console.log(`REVIEW_SUBSTITUTE_SKIPPED ${substitute.model} ${refused}`);
      else {
        console.log(`REVIEW_SUBSTITUTE ${substitute.model} for=${substitute.for}`);
        const { record } = await runOne(substitute.model, substitutePrompt, {
          substitute: true,
          substituteFor: substitute.for,
        });
        results.push(record);
      }
    }
    for (const record of results) {
      console.log(resultLine(record));
      if (record.gateway) console.log(gatewayUsageLine(record));
      console.log(timingLine(record));
    }
    for (const rest of liveGateway?.live.rests() ?? []) console.log(`GATEWAY_REST ${rest}`);
    if (gateway) {
      const changed = binaryProblem(gateway.install);
      if (changed) {
        console.error(changed);
        process.exitCode = 4;
      }
    }
    if (claimsMode) {
      for (const record of results.filter((item) => item.outcome === "ok")) {
        const name = record.model.split("/").pop();
        const answer = readFileSync(join(roundDir, `${name}.md`), "utf8");
        const { claims, problems } = parseClaims(answer);
        const flagged = claims.filter((claim) => CLAIM_PROBLEM_VERDICTS.includes(claim.verdict));
        console.log(
          `CLAIMS_SUMMARY ${name} round=${round} total=${claims.length} consistent=${claims.length - flagged.length} flagged=${flagged.length} malformed=${problems.length}`,
        );
        for (const claim of flagged)
          console.log(
            `CLAIMS_FLAGGED ${name} ${claim.id} ${claim.verdict} ${safe(claim.location)}`,
          );
        if (claims.length === 0 || problems.length > 0) {
          console.log(`CLAIMS_PARSE_FAILED ${name}`);
          process.exitCode = 4;
        }
      }
    }
    const totalSpent = spentOf(readUsage(options.out));
    console.log(`REVIEW_SPENT_TOTAL ${totalSpent.toFixed(4)} ${options.out}`);
    const covered = results.some((record) => record.substitute && record.outcome === "ok");
    if (
      results.some(
        (record) => record.outcome !== "ok" && !(covered && record.model === results[0].model),
      )
    )
      process.exitCode = 4;
    if (stopRequested) {
      console.log(`REVIEW_STOPPED ${OWNER_STOPPED}`);
      process.exitCode = 130;
    }
  } finally {
    onSignal.dispose();
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
