import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_ERROR_MESSAGE_MAX,
  apiErrorText,
  assertReviewed,
  budgetCheck,
  buildPrompt,
  COST_LIMIT_PER_MODEL_USD,
  checkGitArgs,
  checkProbeRequests,
  envFilesInHistory,
  expectedTools,
  FOCUS_SENTENCE,
  GIT_ENV,
  GIT_READ_COMMANDS,
  GIT_REFUSED,
  gitChildEnv,
  installedIntegrityProblems,
  installGitGuard,
  installOpencode,
  isTestFile,
  keepEarlierAttempt,
  killProcessGroup,
  LOW_FIX_MAX_FILES,
  LOW_FIX_MAX_LINES_PER_FILE,
  MIN_OUTPUT_TOKENS,
  MODEL_LENSES,
  ledgerLine,
  maskedRecordText,
  maskSecretLike,
  nextRound,
  OPENCODE_KEPT_ENV,
  OPENCODE_LOCK_DIR,
  OPENCODE_VERSION,
  opencodeBinary,
  opencodeChildEnv,
  opencodeEnv,
  opencodeInstallDir,
  parseArgs,
  parseUsage,
  parseVerdicts,
  prepareCopy,
  prepareRawDir,
  printable,
  probePlan,
  probeRefused,
  promptFileName,
  proxyCredentialProblems,
  QUESTIONS_PATH,
  questionsSource,
  RAW_FILE_SUFFIXES,
  RECORD_SECRET_RULES,
  REVIEW_MODELS,
  REVIEW_PARENT_CANARY_ENV,
  REVIEW_REPORT_DISCLAIMER,
  REVIEWS_DIR,
  RULE_16_SENTENCE,
  rawDir,
  readUsage,
  recordSecretProblems,
  recordText,
  resolveCommits,
  resultLine,
  retryAfterApiError,
  reviewConfig,
  reviewDir,
  reviewModel,
  reviewQuestions,
  reviewReport,
  roundForRun,
  roundsOnDisk,
  runOutcome,
  SHELL_LOG_NAME,
  SUBSTITUTES,
  secretLikeRules,
  spentOf,
  substituteFor,
  summarizeEvents,
  WRAP_UP_MIN_USD,
  WRAP_UP_PROMPT,
  WRAP_UP_RESERVE_USD,
  wrapUpReason,
  clearStopRequest,
  OWNER_STOPPED,
  requestStop,
  signalHandler,
  waitUnlessStopped,
} from "../../scripts/model-review/opencode-review.mjs";
import {
  completedCount,
  effectiveCost,
  GUARD_ENV,
  guardDecision,
  ledgerTotal,
  noteCost,
  SpendGuard,
} from "../../scripts/model-review/spend-guard.mjs";

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const instructions = readFileSync(
  new URL("../../.agents/instructions/model-review.md", import.meta.url),
  "utf8",
);

function toolRequest(names, overrides = {}) {
  return {
    model: "deepseek-v4.1-flash",
    max_tokens: 200000,
    reasoning_effort: "high",
    tools: names.map((name) => ({ type: "function", function: { name } })),
    ...overrides,
  };
}

describe("opencode review configuration", () => {
  it("allows only reading tools and the git read commands in code review", () => {
    const config = reviewConfig({ mode: "code-review" });
    expect(config.permission.edit).toBe("deny");
    expect(config.permission.webfetch).toBe("deny");
    expect(config.permission.websearch).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(Object.keys(config.permission.bash)[0]).toBe("*");
    expect(config.permission.bash["*"]).toBe("deny");
    for (const command of GIT_READ_COMMANDS) {
      expect(config.permission.bash[command]).toBe("allow");
      expect(config.permission.bash[`${command} *`]).toBe("allow");
    }
    const keys = Object.keys(config.permission.bash);
    for (const pattern of ["*--output*", "* -o*", "*difftool*", "*\t*", "*>*"]) {
      expect(config.permission.bash[pattern]).toBe("deny");
      expect(keys.indexOf(pattern)).toBeGreaterThan(keys.indexOf("git diff *"));
    }
    expect(config.permission.read["*.env"]).toBe("deny");
    expect(config.provider["opencode-go"].options).toBeUndefined();
  });

  it("[OpenCode 401] leaves the review credential to OpenCode and keeps the provider entry", () => {
    for (const mode of ["code-review", "plan", "plan-review"]) {
      for (const wrapUp of [false, true]) {
        const config = reviewConfig({ mode, wrapUp });
        expect(config.provider).toEqual({ "opencode-go": {} });
        expect(JSON.stringify(config)).not.toContain("apiKey");
        expect(JSON.stringify(config)).not.toContain("placeholder");
      }
    }
  });

  it("keeps the placeholder key and the local address for the self-check", () => {
    const baseURL = "http://127.0.0.1:9/v1";
    expect(reviewConfig({ mode: "code-review", baseURL }).provider).toEqual({
      "opencode-go": { options: { apiKey: "placeholder", baseURL } },
    });
  });

  it("opens web reading and web search only for the two plan modes", () => {
    for (const mode of ["plan", "plan-review"]) {
      expect(reviewConfig({ mode }).permission.webfetch).toBe("allow");
      expect(reviewConfig({ mode }).permission.websearch).toBe("allow");
      expect(expectedTools(mode)).toEqual([
        "bash",
        "glob",
        "grep",
        "read",
        "webfetch",
        "websearch",
      ]);
    }
    expect(reviewConfig({ mode: "code-review" }).permission.websearch).toBe("deny");
    expect(expectedTools("code-review")).toEqual(["bash", "glob", "grep", "read"]);
  });

  it("rejects an unknown mode", () => {
    expect(() => reviewConfig({ mode: "write" })).toThrow("MODE_UNKNOWN");
  });
});

describe("opencode review prompt", () => {
  it("takes the required questions from model-review.md", () => {
    const questions = reviewQuestions(instructions);
    expect(questions.length).toBeGreaterThanOrEqual(3);
    expect(questions[0]).toContain("请求开头");
  });

  it("puts fixed instructions before the per-review material", () => {
    const questions = reviewQuestions(instructions);
    const first = buildPrompt({
      mode: "code-review",
      questions,
      head: "aaa",
      base: "bbb",
      brief: "作者说 A",
    });
    const second = buildPrompt({
      mode: "code-review",
      questions,
      head: "ccc",
      base: "ddd",
      previous: "eee",
      brief: "作者说 B",
    });
    const fixedEnd = first.indexOf("---- 本次材料 ----");
    expect(fixedEnd).toBeGreaterThan(0);
    expect(second.slice(0, fixedEnd)).toBe(first.slice(0, fixedEnd));
    expect(first).toContain(RULE_16_SENTENCE);
    expect(first).toContain("对照代码核对");
    expect(first).toContain("git diff bbb..aaa");
    expect(second).toContain("git diff eee..ccc");
    expect(first).toContain("不能上网");
  });

  it("[model focus] asks every reviewer the cross-module question I-73 missed", () => {
    const questions = reviewQuestions(instructions);
    expect(questions).toHaveLength(4);
    expect(questions[3]).toContain("每一个使用它的地方都能接受吗");
  });

  it("[owner control] the section after the questions never adds a question, a line inside them does", () => {
    expect(reviewQuestions(instructions)).toHaveLength(4);
    const control = '<a id="owner-control"></a>';
    expect(instructions).toContain(control);
    expect(
      reviewQuestions(instructions.replace(control, `${control}\n\n1. 不是必问问题`)),
    ).toHaveLength(4);
    expect(
      reviewQuestions(instructions.replace(control, `5. 混进来的问题\n\n${control}`)),
    ).toHaveLength(5);
  });

  it("[model focus] gives each model its own focus and otherwise the same prompt", () => {
    const [deepseek, glm] = REVIEW_MODELS;
    const questions = reviewQuestions(instructions);
    const common = { questions, head: "h", base: "b", brief: "作者说" };
    for (const mode of ["code-review", "plan-review"]) {
      const a = buildPrompt({ ...common, mode, model: deepseek });
      const b = buildPrompt({ ...common, mode, model: glm });
      expect(a).toBe(buildPrompt({ ...common, mode, model: deepseek }));
      expect(a).toContain(MODEL_LENSES["deepseek-v4.1-flash"]);
      for (const lens of Object.values(MODEL_LENSES)) {
        expect(lens).toContain("有时只有你一个");
        expect(lens).not.toContain("另一个复核者侧重别的方面");
      }
      expect(a).not.toContain(MODEL_LENSES["glm-5.3-flash"]);
      expect(b).toContain(MODEL_LENSES["glm-5.3-flash"]);
      expect(b).not.toContain(MODEL_LENSES["deepseek-v4.1-flash"]);
      expect(a.replace(`${MODEL_LENSES["deepseek-v4.1-flash"]}\n`, "")).toBe(
        b.replace(`${MODEL_LENSES["glm-5.3-flash"]}\n`, ""),
      );
      expect(a.replace(`${MODEL_LENSES["deepseek-v4.1-flash"]}\n`, "")).toBe(
        buildPrompt({ ...common, mode }),
      );
      for (const [index, question] of questions.entries())
        for (const prompt of [a, b]) expect(prompt).toContain(`${index + 1}. ${question}`);
      expect(a.indexOf(MODEL_LENSES["deepseek-v4.1-flash"])).toBeLessThan(
        a.indexOf("---- 本次材料 ----"),
      );
    }
    expect(buildPrompt({ ...common, mode: "plan", model: deepseek })).toBe(
      buildPrompt({ ...common, mode: "plan", model: glm }),
    );
    expect(() => buildPrompt({ ...common, mode: "code-review", model: "x/other" })).toThrow(
      "LENS_UNKNOWN x/other",
    );
  });

  it("asks for an independent plan without any author's conclusion in plan mode", () => {
    const prompt = buildPrompt({ mode: "plan", questions: ["q"], head: "h", brief: "问题" });
    expect(prompt).toContain("没有给出任何人的方案");
    expect(prompt).toContain("websearch");
    expect(prompt).not.toContain("作者的说法");
    const review = buildPrompt({ mode: "plan-review", questions: ["q"], head: "h", brief: "方案" });
    expect(review).toContain("待审核的方案");
  });

  it("refuses an empty brief", () => {
    expect(() =>
      buildPrompt({ mode: "code-review", questions: ["q"], head: "a", base: "b", brief: "  " }),
    ).toThrow("BRIEF_EMPTY");
  });

  it("[review records] keeps each review's ledger in one fixed folder of the repository", () => {
    const common = ["--head", "a", "--brief", "b.md", "--repo", "/r"];
    const review = parseArgs([...common, "--base", "c", "--pr", "12"]);
    expect(review.out).toBe(join("/r", REVIEWS_DIR, "pr-12"));
    expect(reviewDir("/r", { topic: "x-1" })).toBe(join("/r", REVIEWS_DIR, "topic-x-1"));
    expect(parseArgs([...common, "--mode", "plan", "--topic", "t2"]).out).toBe(
      join("/r", REVIEWS_DIR, "topic-t2"),
    );
    expect(() => parseArgs([...common, "--base", "c"])).toThrow("ARG_REQUIRED --pr");
    expect(() => parseArgs([...common, "--mode", "plan"])).toThrow("ARG_REQUIRED --topic");
    expect(() => parseArgs([...common, "--base", "c", "--pr", "12", "--out", "o"])).toThrow(
      "ARG_OUT_ONLY_FOR_SELF_CHECK",
    );
    expect(() => parseArgs([...common, "--base", "c", "--pr", "1", "--topic", "t"])).toThrow(
      "ARG_PR_AND_TOPIC",
    );
    for (const bad of ["0", "-2", "1.5", "x"])
      expect(() => parseArgs([...common, "--base", "c", "--pr", bad])).toThrow("ARG_INVALID --pr");
    for (const bad of ["12", "Abc", "../x", "a/b", "a b", "", `a${"b".repeat(63)}`])
      expect(() => parseArgs([...common, "--mode", "plan", "--topic", bad])).toThrow(
        "ARG_INVALID --topic",
      );
    expect(parseArgs([...common, "--mode", "plan", "--self-check-only", "--out", "o"]).out).toMatch(
      /o$/,
    );
    expect(promptFileName(REVIEW_MODELS[1])).toBe("glm-5.3-flash.prompt.md");
    expect(recordText("a  \nb\t\n\nc ")).toBe("a\nb\n\nc\n");
    expect(recordText("a \r\nb\rc")).toBe("a\nb\nc\n");
    expect(printable("a\nREVIEW_CURRENT")).toBe('"a\\nREVIEW_CURRENT"');
    expect(printable("plain.txt")).toBe("plain.txt");
    expect(() => parseArgs(["--assert-reviewed", "--pr", "1", "--main-ref", "main\nx"])).toThrow(
      "ARG_INVALID --main-ref",
    );
    const rawRoot = mkdtempSync(join(tmpdir(), "opencode-raw-perm-"));
    try {
      const root = join(rawRoot, "himawari-review-raw");
      const dir = join(root, "abc", "pr-1", "round-1");
      mkdirSync(dir, { recursive: true });
      chmodSync(root, 0o777);
      chmodSync(dir, 0o777);
      prepareRawDir(dir, root);
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(rawRoot, { recursive: true, force: true });
    }
    for (const option of ["--main-ref", "--questions-ref"])
      expect(() =>
        parseArgs(
          option === "--main-ref"
            ? ["--assert-reviewed", "--pr", "1", option, "--help"]
            : ["--mode", "plan", "--topic", "t", "--head", "a", "--brief", "b", option, "--help"],
        ),
      ).toThrow(`ARG_INVALID ${option}`);
    const rawA = rawDir({ repo: "/a", pr: 7 }, 2);
    const rawB = rawDir({ repo: "/b", pr: 7 }, 2);
    expect(rawA).not.toBe(rawB);
    expect(rawA).toMatch(/himawari-review-raw\/[0-9a-f]{12}\/pr-7\/round-2$/);
    expect(opencodeInstallDir()).toMatch(
      new RegExp(`himawari-opencode-${OPENCODE_VERSION.replaceAll(".", "\\.")}-[0-9a-f]{12}$`),
    );
    expect(() => parseArgs(["--assert-reviewed", "--pr", "1", "--out", "o"])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND --out",
    );
    expect(() =>
      parseArgs(["--report", "--pr", "1", "--stop", "no-error", "--accept-unreviewed", "合并"]),
    ).toThrow("ARG_NOT_FOR_SUBCOMMAND --accept-unreviewed");
    expect(() => parseArgs(["--assert-reviewed", "--report", "--pr", "1"])).toThrow(
      "ARG_ASSERT_AND_REPORT",
    );
    expect(parseArgs(["--assert-reviewed", "--pr", "1", "--main-ref", "main"]).mainRef).toBe(
      "main",
    );
    expect(() =>
      parseArgs(["--assert-reviewed", "--pr", "1", "--accept-unreviewed", "合并\nREVIEW_CURRENT"]),
    ).toThrow("ARG_INVALID --accept-unreviewed");
    expect(() =>
      parseArgs(["--report", "--pr", "1", "--stop", "andy-decision", "--andy-quote", "a\rb"]),
    ).toThrow("ARG_INVALID --andy-quote");
    expect(() =>
      parseArgs([
        "--report",
        "--pr",
        "1",
        "--stop",
        "andy-decision",
        "--andy-quote",
        "a\u001b[2Jb",
      ]),
    ).toThrow("ARG_INVALID --andy-quote");
    expect(() =>
      parseArgs(["--assert-reviewed", "--pr", "1", "--accept-unreviewed", "合\u0008并"]),
    ).toThrow("ARG_INVALID --accept-unreviewed");
    expect(() =>
      parseArgs([
        "--mode",
        "plan",
        "--topic",
        "t",
        "--head",
        "a",
        "--brief",
        "b",
        "--questions-ref",
        "x\ny",
      ]),
    ).toThrow("ARG_INVALID --questions-ref");
    for (const extra of [
      ["--stop", "no-error"],
      ["--andy-quote", "q"],
      ["--main-ref", "main"],
    ])
      expect(() =>
        parseArgs(["--mode", "plan", "--topic", "t", "--head", "a", "--brief", "b", ...extra]),
      ).toThrow(`ARG_NOT_FOR_MODE ${extra[0]}`);
  });

  it("requires a base commit for code review", () => {
    expect(() => parseArgs(["--head", "a", "--brief", "b.md", "--pr", "1"])).toThrow(
      "ARG_REQUIRED --base",
    );
    expect(
      parseArgs(["--mode", "plan", "--head", "a", "--brief", "b.md", "--topic", "t"]).mode,
    ).toBe("plan");
  });
});

describe("opencode review output", () => {
  it("reports a run cut off by the output limit as truncated", () => {
    const events = [
      {
        type: "step_finish",
        part: {
          reason: "length",
          tokens: { input: 900, output: 32000, reasoning: 31990, cache: { read: 0, write: 0 } },
          cost: 0.02,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const summary = summarizeEvents(events);
    expect(summary.outcome).toBe("truncated");
    expect(summary.usage.output).toBe(32000);
  });

  it("reads a refusal out of the error field when the command printed nothing", () => {
    const events = [
      {
        type: "tool_use",
        part: {
          tool: "bash",
          state: {
            input: { command: "git log -1 --output=../written.txt" },
            status: "error",
            output: "",
            error: `${GIT_REFUSED} --output`,
          },
        },
      },
      { type: "text", part: { text: "done" } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const [call] = summarizeEvents(events).toolCalls;
    expect(call.output).toBe(`${GIT_REFUSED} --output`);
    expect(probeRefused(call)).toBe(true);
  });

  it("adds up tokens across tool steps and keeps the final text", () => {
    const events = [
      {
        type: "tool_use",
        part: { tool: "read", state: { input: { filePath: "a.ts" }, status: "completed" } },
      },
      {
        type: "step_finish",
        part: {
          reason: "tool-calls",
          tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } },
          cost: 0.001,
        },
      },
      { type: "text", part: { text: "结论" } },
      {
        type: "step_finish",
        part: {
          reason: "stop",
          tokens: { input: 200, output: 20, reasoning: 5, cache: { read: 150, write: 0 } },
          cost: 0.002,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const summary = summarizeEvents(events);
    expect(summary.outcome).toBe("ok");
    expect(summary.text).toBe("结论");
    expect(summary.usage).toMatchObject({ steps: 2, input: 300, output: 30, cacheRead: 200 });
    expect(summary.toolCalls).toHaveLength(1);
  });

  it("reports a run with no answer text", () => {
    const events = JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: {} } });
    expect(summarizeEvents(events).outcome).toBe("no-text");
  });

  it("[api error] reads the service's refusal from a real run instead of calling it no text", () => {
    const events = readFileSync(
      new URL("./fixtures/opencode-review/deepseek-429-events.jsonl", import.meta.url),
      "utf8",
    );
    const summary = summarizeEvents(events);
    expect(summary.outcome).toBe("api-error");
    expect(summary.apiError).toEqual({
      message:
        "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 5 s)",
      statusCode: 429,
      retryable: true,
    });
    expect(summary.usage.steps).toBe(2);
    expect(apiErrorText(summary.apiError)).toMatch(/^429 Upstream request failed/);
  });

  it("[api error] keeps the error on one short line and treats a refusal without retry hints as final", () => {
    const event = (data) => JSON.stringify({ type: "error", error: { name: "APIError", data } });
    const long = summarizeEvents(
      event({ message: `a\nb\r\u001b[31m${"x".repeat(1000)}`, statusCode: 401 }),
    ).apiError;
    expect(long.message.startsWith("a b [31m")).toBe(true);
    expect(long.message).toHaveLength(API_ERROR_MESSAGE_MAX);
    expect(long.retryable).toBe(false);
    expect(
      summarizeEvents(event({ message: "busy", responseHeaders: { "retry-after": "5" } })).apiError
        .retryable,
    ).toBe(true);
    for (const headers of [
      { "retry-after": "" },
      { "retry-after": null },
      { "retry-after-ms": " " },
    ])
      expect(
        summarizeEvents(event({ message: "busy", responseHeaders: headers })).apiError.retryable,
      ).toBe(false);
    expect(summarizeEvents(JSON.stringify({ type: "error", error: {} })).apiError).toEqual({
      message: "unknown",
      statusCode: null,
      retryable: false,
    });
    expect(runOutcome(summarizeEvents(event({ message: "busy" })), { code: 1 })).toBe("api-error");
  });
});

describe("opencode review retry and substitute", () => {
  const failed = (apiError, usage = { cost: 0.01 }) => ({
    outcome: "api-error",
    summary: { apiError, usage },
  });
  const busy = { message: "busy", statusCode: 429, retryable: true };
  const room = { remainingMs: 20 * 60000, remainingUsd: 0.19, waitMs: 60000 };

  it("[api error] retries once only when the service said to and money and time are left", () => {
    expect(retryAfterApiError(failed(busy), room)).toBe("retry");
    expect(retryAfterApiError(failed({ ...busy, retryable: false }), room)).toBeNull();
    expect(retryAfterApiError({ outcome: "timeout", summary: { usage: {} } }, room)).toBeNull();
    expect(retryAfterApiError(failed(busy), { ...room, remainingUsd: 0.06 })).toBe("no-budget");
    expect(retryAfterApiError(failed(busy), { ...room, remainingMs: 70000 })).toBe("no-time");
    expect(retryAfterApiError(failed(busy, { cost: 0, costUnknown: true }), room)).toBe(
      "cost-unknown",
    );
  });

  const run = (outcome, apiError, retry = "retried") => ({
    record: { outcome },
    review: { summary: { apiError }, retry },
  });
  const deepseek = REVIEW_MODELS[0];
  const glm = REVIEW_MODELS[1];
  const later = { mode: "code-review", previous: "a".repeat(40), models: [deepseek] };

  it("[substitute] lets GLM take a later code-review round only when DeepSeek's service refused", () => {
    expect(SUBSTITUTES).toEqual({ [deepseek]: glm });
    expect(substituteFor({ ...later, runs: [run("api-error", busy)] })).toEqual({
      model: glm,
      for: deepseek,
    });
    const none = [
      { ...later, runs: [run("ok", null)] },
      { ...later, runs: [run("timeout", null)] },
      { ...later, runs: [run("api-error", { ...busy, retryable: false })] },
      { ...later, runs: [run("api-error", busy, "no-time")] },
      { ...later, runs: [run("api-error", busy, "no-budget")] },
      { ...later, runs: [run("api-error", busy, null)] },
      { ...later, previous: undefined, runs: [run("api-error", busy)] },
      { ...later, mode: "plan-review", runs: [run("api-error", busy)] },
      { ...later, models: [glm], runs: [run("api-error", busy)] },
      {
        ...later,
        models: [deepseek, glm],
        runs: [run("api-error", busy), run("ok", null)],
      },
    ];
    for (const options of none) expect(substituteFor(options)).toBeNull();
  });
});

describe("opencode review self-check", () => {
  const plan = probePlan("/work");
  const label = (probe) =>
    `${probe.tool} ${probe.args.command ?? probe.args.filePath ?? probe.args.pattern}`;
  const passingCalls = () =>
    plan.probes.map((probe) =>
      probe.kind === "allowed"
        ? { tool: "bash", input: probe.args, status: "completed", output: "abc123 commit" }
        : {
            tool: probe.tool,
            input: probe.args,
            status: "error",
            output: "The user has specified a rule which prevents you",
          },
    );
  const check = (overrides = {}) =>
    checkProbeRequests({
      mode: "code-review",
      requests: [{ model: "x", messages: [] }, toolRequest(["bash", "glob", "grep", "read"])],
      plan,
      toolCalls: passingCalls(),
      writtenFiles: [],
      ...overrides,
    });

  it("probes every write and outside-read shape the reviews found", () => {
    const commands = plan.probes.map((probe) => probe.args.command ?? "");
    for (const shape of [
      "--output=",
      "--out=",
      "--outp=",
      '"--output=',
      "--out\\put=",
      " -o/",
      " > ",
      " >> ",
      " 2>",
      " | tee ",
      "`touch",
      "$(touch",
      "; touch",
      "&& touch",
      "\ntouch",
      "difftool",
      "--no-index",
      "--no-inde ",
      '"--no-index"',
      "--no\\-index",
      "diff\t--no-index",
      "--contents",
    ]) {
      expect(commands.some((command) => command.includes(shape))).toBe(true);
    }
    expect(plan.probes.filter((probe) => probe.tool !== "bash").map((probe) => probe.tool)).toEqual(
      ["read", "read", "read", "grep", "grep", "glob", "glob"],
    );
    const environProbe = expect.objectContaining({
      kind: "read",
      tool: "read",
      args: { filePath: "/proc/self/environ" },
    });
    if (process.platform === "linux") expect(plan.probes).toContainEqual(environProbe);
    else expect(plan.probes).not.toContainEqual(environProbe);
    expect(
      plan.probes.filter((probe) => probe.kind === "allowed").map((probe) => probe.args.command),
    ).toEqual([
      "git log -1 --oneline",
      "git diff --stat HEAD",
      "git show --stat HEAD",
      "git blame -L 1,1 -- AGENTS.md",
      "git status --short",
    ]);
    expect(plan.probes[0]).toMatchObject({
      kind: "allowed",
      tool: "bash",
      args: { command: "git log -1 --oneline" },
    });
  });

  it("passes when every probe is refused and the plain git read runs", () => {
    expect(check()).toEqual([]);
  });

  it("matches calls to probes by content, not by order", () => {
    expect(check({ toolCalls: passingCalls().reverse() })).toEqual([]);
  });

  it("fails the request opencode sent with the old configuration", () => {
    const problems = check({
      requests: [
        toolRequest(["glob", "grep", "read", "skill", "task", "todowrite", "websearch"], {
          max_tokens: 32000,
        }),
      ],
    });
    expect(problems.some((problem) => problem.startsWith("PROBE_TOOLS_UNEXPECTED"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("PROBE_OUTPUT_CAP"))).toBe(true);
  });

  it("fails when reasoning is not high or the output limit is below the minimum", () => {
    const problems = check({
      requests: [
        toolRequest(["bash", "glob", "grep", "read"], {
          reasoning_effort: "low",
          max_tokens: MIN_OUTPUT_TOKENS - 1,
        }),
      ],
    });
    expect(problems).toEqual([
      "PROBE_OUTPUT_CAP deepseek-v4.1-flash 99999",
      "PROBE_REASONING deepseek-v4.1-flash low",
    ]);
  });

  it("fails when a probe wrote a file or read a file outside the copy", () => {
    const calls = passingCalls();
    const readIndex = plan.probes.findIndex((probe) => probe.kind === "read");
    calls[readIndex] = { ...calls[readIndex], status: "completed", output: `diff\n${plan.marker}` };
    const problems = check({ toolCalls: calls, writtenFiles: ["/work/probe-redirect"] });
    expect(problems).toEqual([
      `PROBE_READ_OUTSIDE ${label(plan.probes[readIndex])}`,
      `PROBE_NOT_REFUSED ${label(plan.probes[readIndex])}`,
      "PROBE_WROTE_FILE /work/probe-redirect",
    ]);
  });

  it("[review env] fails when a variable from the script's own environment reaches the model", () => {
    const calls = passingCalls();
    const index = plan.probes.findIndex(
      (probe) => probe.args.command === `git log $${REVIEW_PARENT_CANARY_ENV}`,
    );
    expect(plan.probes[index]).toMatchObject({ kind: "contained", leak: plan.marker });
    calls[index] = {
      ...calls[index],
      status: "completed",
      output: `fatal: ambiguous argument '${plan.marker}': unknown revision`,
    };
    expect(check({ toolCalls: calls })).toEqual([
      `PROBE_READ_OUTSIDE ${label(plan.probes[index])}`,
    ]);
  });

  it("fails when glob lists files outside the copy", () => {
    const calls = passingCalls();
    const globIndex = plan.probes.findIndex((probe) => probe.tool === "glob");
    calls[globIndex] = {
      ...calls[globIndex],
      status: "completed",
      output: "/work/outside-a.txt\n/work/outside-b.txt",
    };
    expect(check({ toolCalls: calls })).toEqual([
      `PROBE_READ_OUTSIDE ${label(plan.probes[globIndex])}`,
      `PROBE_NOT_REFUSED ${label(plan.probes[globIndex])}`,
    ]);
  });

  it("fails when a write probe ran without being refused, even if no file appeared", () => {
    const calls = passingCalls();
    const writeIndex = plan.probes.findIndex((probe) => probe.kind === "write");
    calls[writeIndex] = { ...calls[writeIndex], status: "completed", output: "" };
    expect(check({ toolCalls: calls })).toEqual([
      `PROBE_NOT_REFUSED ${label(plan.probes[writeIndex])}`,
    ]);
  });

  it("counts only an explicit refusal as refused", () => {
    expect(probeRefused({ status: "completed", output: `${GIT_REFUSED} --output\n` })).toBe(true);
    expect(
      probeRefused({
        status: "completed",
        output: "/bin/bash: line 1: f: restricted: cannot redirect output",
      }),
    ).toBe(true);
    expect(probeRefused({ status: "completed", output: "abc123 commit" })).toBe(false);
    expect(
      probeRefused({ status: "error", output: "/bin/bash: f: No such file or directory" }),
    ).toBe(false);
    expect(
      probeRefused({
        status: "completed",
        output: "The user has specified a rule which prevents you from doing that",
      }),
    ).toBe(true);
    expect(
      probeRefused({
        status: "completed",
        output: [
          "commit 9d1e6de5de7535d8bb73061a702dcf5534747127",
          "",
          `    工具以 \`${GIT_REFUSED} records-path\` 拒绝`,
          `    \`bash -r\` 的 \`: restricted\` 本来就出现在行中`,
          "    The user has specified a rule which prevents you 这句话也一样",
          "",
          " .agents/reviews/pr-312/round-3/judgments.md | 60 ++++++",
        ].join("\n"),
      }),
    ).toBe(false);
    expect(
      probeRefused({
        status: "completed",
        output: `1f16c11b fix(model-review): 自检只在不缩进的行里找 ${GIT_REFUSED} 这个字样\n`,
      }),
    ).toBe(false);
    expect(
      probeRefused({
        status: "completed",
        output: "1f16c11b fix: 别被提交标题里的 : restricted 骗了\n",
      }),
    ).toBe(false);
    expect(
      probeRefused({
        status: "completed",
        output:
          "1f16c11b fix: The user has specified a rule which prevents you 也可能出现在标题里\n",
      }),
    ).toBe(false);
    expect(
      probeRefused({
        status: "completed",
        output: [
          "commit aff8e4eebf86989c6d07890c3ad1197379363e2e",
          "Author: f: restricted <nobody@example.org>",
          "Date:   Sun Nov 8 16:30:00 2026 +0900",
          "",
          "    fix: 作者名也不该被当成 shell 的报错",
        ].join("\n"),
      }),
    ).toBe(false);
  });

  it("fails when a write probe failed for an unrelated reason", () => {
    const calls = passingCalls();
    const writeIndex = plan.probes.findIndex((probe) => probe.kind === "write");
    calls[writeIndex] = { ...calls[writeIndex], output: "No such file or directory" };
    expect(check({ toolCalls: calls })).toEqual([
      `PROBE_NOT_REFUSED ${label(plan.probes[writeIndex])}`,
    ]);
  });

  it("probes writes inside the copy, including after a cd", () => {
    const inside = plan.probes.filter((probe) => probe.file?.startsWith("/work/repo/"));
    expect(inside.map((probe) => probe.args.command)).toContain(
      "cd /work/repo && git log -1 > probe-inside-cd-redirect",
    );
  });

  it("fails when everything is blocked, so a deny-all config cannot pass", () => {
    const calls = passingCalls();
    calls[0] = { ...calls[0], status: "error", output: "denied" };
    expect(check({ toolCalls: calls })).toEqual([
      "PROBE_READ_COMMAND_BLOCKED bash git log -1 --oneline",
    ]);
  });

  it("fails when opencode did not run the commands through the sandbox shell", () => {
    expect(check({ shellCalls: 0 })).toEqual(["PROBE_SHELL_NOT_USED 0"]);
    expect(check({ shellCalls: 40 })).toEqual([]);
  });

  it("fails when the copy's own AGENTS.md reached the system prompt", () => {
    const heading = "# 项目指令";
    const request = toolRequest(["bash", "glob", "grep", "read"], {
      messages: [{ role: "system", content: `前文\n${heading}\n后文` }],
    });
    expect(check({ requests: [request], projectInstructions: heading })).toEqual([
      "PROBE_PROJECT_INSTRUCTIONS_LOADED deepseek-v4.1-flash",
    ]);
    const clean = toolRequest(["bash", "glob", "grep", "read"], {
      messages: [{ role: "system", content: "前文" }],
    });
    expect(check({ requests: [clean], projectInstructions: heading })).toEqual([]);
  });

  it("checks project instructions in user messages and limits for prefixed or unknown models", () => {
    const heading = "# 项目指令";
    const tools = ["bash", "glob", "grep", "read"];
    expect(
      check({
        requests: [toolRequest(tools, { messages: [{ role: "user", content: heading }] })],
        projectInstructions: heading,
      }),
    ).toEqual(["PROBE_PROJECT_INSTRUCTIONS_LOADED deepseek-v4.1-flash"]);
    expect(
      check({
        requests: [toolRequest(tools, { model: "opencode-go/glm-5.3-flash", max_tokens: 131072 })],
      }),
    ).toEqual([]);
    expect(check({ requests: [toolRequest(tools, { model: "other-model" })] })).toEqual([
      "PROBE_MODEL_UNKNOWN other-model",
      "PROBE_OUTPUT_CAP other-model 200000",
    ]);
  });

  it("fails when the output limit is above what the model accepts", () => {
    expect(
      check({
        requests: [
          toolRequest(["bash", "glob", "grep", "read"], {
            model: "glm-5.3-flash",
            max_tokens: 200000,
          }),
        ],
      }),
    ).toEqual(["PROBE_OUTPUT_CAP glm-5.3-flash 200000"]);
  });

  it("fails when a probe did not run or no request carried tools", () => {
    const calls = passingCalls();
    const missing = plan.probes[plan.probes.length - 1];
    expect(check({ toolCalls: calls.slice(0, -1) })).toEqual([`PROBE_NOT_RUN ${label(missing)}`]);
    expect(check({ requests: [] })).toEqual(["PROBE_NO_TOOL_REQUEST"]);
  });
});

function processState(
  pid,
  { platform = process.platform, read = readFileSync, signal = process.kill } = {},
) {
  try {
    if (platform !== "linux") {
      signal(pid, 0);
      return "alive";
    }
    return read(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
  } catch (error) {
    if (error.code === (platform === "linux" ? "ENOENT" : "ESRCH")) return "gone";
    throw error;
  }
}

describe("opencode review process cleanup", () => {
  it("reads a process that disappears mid-read as gone and keeps other errors", () => {
    const failing = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const linux = (read) => processState(42, { platform: "linux", read });
    expect(linux(() => "42 (sleep) S 1 42")).toBe("S");
    expect(linux(failing("ENOENT"))).toBe("gone");
    expect(() => linux(failing("EACCES"))).toThrow("EACCES");
    const darwin = (signal) => processState(42, { platform: "darwin", signal });
    expect(darwin(() => true)).toBe("alive");
    expect(darwin(failing("ESRCH"))).toBe("gone");
    expect(() => darwin(failing("EPERM"))).toThrow("EPERM");
  });

  it("kills the commands opencode started, not only opencode itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-kill-"));
    const pidFile = join(dir, "grandchild.pid");
    const child = spawn("sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise((resolveExit) => child.on("exit", resolveExit));
    let killed = false;
    try {
      while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "")
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      const grandchild = Number(readFileSync(pidFile, "utf8").trim());
      const state = () => processState(grandchild);
      expect(["Z", "X", "gone"]).not.toContain(state());
      killed = killProcessGroup(child, "SIGKILL");
      expect(killed).toBe(true);
      await exited;
      for (let attempt = 0; attempt < 100 && !["Z", "X", "gone"].includes(state()); attempt += 1)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(["Z", "X", "gone"]).toContain(state());
    } finally {
      if (!killed) killProcessGroup(child, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("opencode install integrity", () => {
  const lock = JSON.parse(readFileSync(join(OPENCODE_LOCK_DIR, "package-lock.json"), "utf8"));
  const tampered = `sha512-${createHash("sha512").update("tampered").digest("base64")}`;

  it("[opencode lock] pins opencode-ai and every platform package by sha512", () => {
    const manifest = JSON.parse(readFileSync(join(OPENCODE_LOCK_DIR, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "opencode-ai": OPENCODE_VERSION });
    const packages = Object.entries(lock.packages).filter(([name]) => name);
    expect(lock.packages["node_modules/opencode-ai"].version).toBe(OPENCODE_VERSION);
    for (const platform of ["darwin-arm64", "linux-x64"])
      expect(lock.packages[`node_modules/opencode-${platform}`]).toBeDefined();
    for (const [, entry] of packages) {
      expect(entry.version).toBe(OPENCODE_VERSION);
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
  });

  it("[opencode lock] reports an installed package whose digest differs from the lock", () => {
    const prefix = mkdtempSync(join(tmpdir(), "opencode-installed-"));
    try {
      const installed = (integrity) => {
        mkdirSync(join(prefix, "node_modules"), { recursive: true });
        writeFileSync(
          join(prefix, "node_modules", ".package-lock.json"),
          JSON.stringify({
            packages: {
              "node_modules/opencode-ai": lock.packages["node_modules/opencode-ai"],
              "node_modules/opencode-linux-x64": {
                ...lock.packages["node_modules/opencode-linux-x64"],
                integrity,
              },
            },
          }),
        );
      };
      expect(installedIntegrityProblems(prefix, lock)).toEqual(["installed-lock-missing"]);
      installed(lock.packages["node_modules/opencode-linux-x64"].integrity);
      expect(installedIntegrityProblems(prefix, lock)).toEqual([]);
      installed(tampered);
      expect(installedIntegrityProblems(prefix, lock)).toEqual([
        `node_modules/opencode-linux-x64 ${tampered}`,
      ]);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("[opencode lock] installs the locked version and refuses a download that does not match", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-install-"));
    try {
      const good = installOpencode({ prefix: join(root, "good") });
      expect(execFileSync(good, ["--version"], { encoding: "utf8" }).trim()).toBe(OPENCODE_VERSION);
      const installedLock = join(root, "good", "node_modules", ".package-lock.json");
      writeFileSync(installedLock, "{ not json");
      expect(installedIntegrityProblems(join(root, "good"), lock)).toEqual([
        "installed-lock-unreadable",
      ]);
      expect(installOpencode({ prefix: join(root, "good") })).toBe(good);
      expect(installedIntegrityProblems(join(root, "good"), lock)).toEqual([]);
      const badLock = join(root, "bad-lock");
      mkdirSync(badLock);
      writeFileSync(
        join(badLock, "package.json"),
        readFileSync(join(OPENCODE_LOCK_DIR, "package.json")),
      );
      const changed = structuredClone(lock);
      changed.packages["node_modules/opencode-ai"].integrity = tampered;
      writeFileSync(join(badLock, "package-lock.json"), JSON.stringify(changed, null, 2));
      expect(() => installOpencode({ prefix: join(root, "bad"), lockDir: badLock })).toThrow(
        /^OPENCODE_INTEGRITY_MISMATCH/,
      );
      expect(existsSync(join(root, "bad", "node_modules", ".bin", "opencode"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300000);
});

describe("opencode review installed guard", () => {
  it("runs the model's commands in restricted bash with the git guard in front", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-guard-"));
    try {
      const copy = join(root, "repo");
      const isolatedGit = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      };
      execFileSync("git", ["clone", "--quiet", "--depth", "3", `file://${process.cwd()}`, copy], {
        env: isolatedGit,
      });
      const blamed = join(copy, "AGENTS.md");
      writeFileSync(blamed, `<a id="probe-commit"></a>\n${readFileSync(blamed, "utf8")}`);
      execFileSync(
        "git",
        [
          "-c",
          "user.name=f: restricted",
          "-c",
          "user.email=nobody@example.org",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "--all",
          "-m",
          `${GIT_REFUSED} --output bash: line 1: x: restricted`,
          "-m",
          "The user has specified a rule which prevents you",
        ],
        { cwd: copy, env: isolatedGit },
      );
      const guard = installGitGuard(root);
      const canary = `CANARY_${randomBytes(8).toString("hex")}`;
      const env = {
        ...process.env,
        PATH: `${guard.binDir}:${process.env.PATH}`,
        REVIEW_TEST_CANARY: canary,
      };
      const viaShell = (command, extraEnv = {}) => {
        const result = spawnSync(guard.shell, ["-c", command], {
          cwd: copy,
          env: { ...env, ...extraEnv },
          encoding: "utf8",
        });
        return { status: result.status, text: result.stdout + result.stderr };
      };
      const guardRefused = viaShell('git log -1 "--output=../written.txt"').text;
      const redirectRefused = viaShell("git log -1 --oneline > written.txt").text;
      const cdRefused = viaShell(`cd ${root}`).text;
      expect(guardRefused).toContain(GIT_REFUSED);
      expect(redirectRefused).toContain("restricted");
      expect(cdRefused).toContain("restricted");
      for (const output of [guardRefused, redirectRefused, cdRefused])
        expect(probeRefused({ status: "completed", output })).toBe(true);
      const localized = viaShell(`cd ${root}`, { LC_ALL: "ja_JP.UTF-8", LANG: "ja_JP.UTF-8" });
      expect(probeRefused({ status: "completed", output: localized.text })).toBe(true);
      const locale = viaShell("env", {
        LC_ALL: "ja_JP.UTF-8",
        LC_MESSAGES: "ja_JP.UTF-8",
        LANGUAGE: "ja_JP",
      }).text.split("\n");
      expect(locale.some((line) => line.startsWith("LC_ALL="))).toBe(false);
      expect(locale).toContain("LC_MESSAGES=C");
      expect(locale).toContain("LANGUAGE=C");
      expect(locale).toContain("LC_CTYPE=ja_JP.UTF-8");
      const bare = viaShell("env", { LC_ALL: "", LC_CTYPE: "", LANG: "" }).text.split("\n");
      expect(bare.filter((line) => line.startsWith("LC_CTYPE="))).toEqual(["LC_CTYPE="]);
      for (const command of [
        "git log -1 --oneline",
        "git show --stat HEAD",
        "git blame -L 1,1 -- AGENTS.md",
        "git status --short",
      ]) {
        const allowedRun = viaShell(command);
        expect(allowedRun.status).toBe(0);
        expect(probeRefused({ status: "completed", output: allowedRun.text })).toBe(false);
      }
      viaShell("export GIT_EXTERNAL_DIFF=touch; git diff HEAD~1 HEAD");
      viaShell(
        "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=touch; git diff HEAD~1 HEAD",
      );
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: copy, encoding: "utf8" })).toBe(
        "",
      );
      expect(existsSync(join(root, "written.txt"))).toBe(false);
      expect(viaShell("export GIT_EXTERNAL_DIFF=env; git diff HEAD~1 HEAD").text).not.toContain(
        canary,
      );
      expect(readFileSync(join(root, SHELL_LOG_NAME), "utf8").trim().split("\n").length).toBe(13);
      const allowed = viaShell("git log -1 --format=%H");
      expect(allowed.status).toBe(0);
      expect(allowed.text.trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("[review env] passes opencode only the listed variables, never tokens or keys", () => {
    const parent = {
      PATH: "/bin",
      HOME: "/h",
      HTTPS_PROXY: "http://proxy:1",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      XDG_DATA_HOME: "/data",
      GITHUB_TOKEN: "ghs_secret",
      GH_TOKEN: "gh_secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      OPENCODE_API_KEY: "oc_secret",
      OPENCODE_PURE: "1",
      HIMAWARI_SPEND_GUARD: "/elsewhere/limits.json",
      NODE_OPTIONS: "--require x",
      GIT_EXTERNAL_DIFF: "touch",
    };
    expect(opencodeEnv(parent)).toEqual({
      PATH: "/bin",
      HOME: "/h",
      HTTPS_PROXY: "http://proxy:1",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      XDG_DATA_HOME: "/data",
    });
    for (const name of OPENCODE_KEPT_ENV) expect(name).not.toMatch(/TOKEN|SECRET|KEY|PASS/);
  });

  it("[review env] extraEnv cannot take over the guard path, the shell or the config", () => {
    const gitGuard = {
      binDir: "/guard/bin",
      shell: "/guard/shell/bash",
      configHome: "/guard/home",
    };
    const env = opencodeChildEnv({
      parentEnv: { PATH: "/usr/bin", HOME: "/h", LC_CTYPE: "zh_CN.UTF-8" },
      cwd: "/work",
      configPath: "/work/opencode.json",
      limitsPath: "/work/limits.json",
      gitGuard,
      extraEnv: {
        LC_CTYPE: "ja_JP.UTF-8",
        PATH: "/attacker/bin",
        SHELL: "/bin/bash",
        OPENCODE_CONFIG: "/attacker/opencode.json",
        XDG_CONFIG_HOME: "/attacker/home",
        GIT_CONFIG_GLOBAL: "/attacker/gitconfig",
        [GUARD_ENV]: "/attacker/limits.json",
        REVIEW_TEST_MARKER: "kept",
      },
    });
    expect(env.PATH).toBe(`/guard/bin${delimiter}/usr/bin`);
    expect(env.SHELL).toBe("/guard/shell/bash");
    expect(env.OPENCODE_CONFIG).toBe("/work/opencode.json");
    expect(env.XDG_CONFIG_HOME).toBe("/guard/home");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env[GUARD_ENV]).toBe("/work/limits.json");
    expect(env.LC_CTYPE).toBe("zh_CN.UTF-8");
    expect(env.REVIEW_TEST_MARKER).toBe("kept");
  });

  it("[review env] extraEnv cannot supply the spend guard when the run has none", () => {
    const env = opencodeChildEnv({
      parentEnv: { PATH: "/usr/bin" },
      cwd: "/work",
      configPath: "/work/opencode.json",
      limitsPath: undefined,
      gitGuard: { binDir: "/guard/bin", shell: "/guard/shell/bash", configHome: "/guard/home" },
      extraEnv: { [GUARD_ENV]: "/attacker/limits.json" },
    });
    expect(GUARD_ENV in env).toBe(false);
  });

  it("[review env] opencode and everything it starts report errors in English", () => {
    const env = opencodeChildEnv({
      parentEnv: {
        PATH: "/usr/bin",
        LANG: "ja_JP.UTF-8",
        LC_ALL: "ja_JP.UTF-8",
        LC_CTYPE: "ja_JP.UTF-8",
      },
      cwd: "/work",
      configPath: "/work/opencode.json",
      limitsPath: "/work/limits.json",
      gitGuard: { binDir: "/guard/bin", shell: "/guard/shell/bash", configHome: "/guard/home" },
      extraEnv: { LC_ALL: "ja_JP.UTF-8", LC_MESSAGES: "ja_JP.UTF-8", LANGUAGE: "ja_JP" },
    });
    expect("LC_ALL" in env).toBe(false);
    expect(env.LC_MESSAGES).toBe("C");
    expect(env.LANGUAGE).toBe("C");
    expect(env.LANG).toBe("ja_JP.UTF-8");
    expect(env.LC_CTYPE).toBe("ja_JP.UTF-8");
  });

  it("[review env] the character locale comes from LC_ALL, then LC_CTYPE, then LANG", () => {
    const base = {
      cwd: "/work",
      configPath: "/work/opencode.json",
      limitsPath: "/work/limits.json",
      gitGuard: { binDir: "/guard/bin", shell: "/guard/shell/bash", configHome: "/guard/home" },
      extraEnv: {},
    };
    const fromAll = opencodeChildEnv({
      ...base,
      parentEnv: { PATH: "/usr/bin", LC_ALL: "zh_CN.UTF-8" },
    });
    expect("LC_ALL" in fromAll).toBe(false);
    expect(fromAll.LC_CTYPE).toBe("zh_CN.UTF-8");
    expect(fromAll.LC_MESSAGES).toBe("C");
    const fromNothing = opencodeChildEnv({ ...base, parentEnv: { PATH: "/usr/bin" } });
    expect("LC_CTYPE" in fromNothing).toBe(false);
    expect(fromNothing.LC_MESSAGES).toBe("C");
    const ctypeOf = (parentEnv) =>
      opencodeChildEnv({ ...base, parentEnv: { PATH: "/usr/bin", ...parentEnv } }).LC_CTYPE;
    expect(ctypeOf({ LC_ALL: "zh_CN.UTF-8", LC_CTYPE: "ja_JP.UTF-8", LANG: "C" })).toBe(
      "zh_CN.UTF-8",
    );
    expect(ctypeOf({ LC_CTYPE: "ja_JP.UTF-8", LANG: "C" })).toBe("ja_JP.UTF-8");
    expect(ctypeOf({ LANG: "zh_CN.UTF-8" })).toBe("zh_CN.UTF-8");
    expect(ctypeOf({ LC_ALL: "", LC_CTYPE: "", LANG: "zh_CN.UTF-8" })).toBe("zh_CN.UTF-8");
    expect(ctypeOf({ LC_ALL: "", LC_CTYPE: "", LANG: "" })).toBe("");
  });

  it("[review env] the real self-check passes with secrets in the script's environment", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-env-"));
    try {
      const brief = join(root, "brief.md");
      writeFileSync(brief, "self-check\n");
      const secret = `SECRET_${randomBytes(8).toString("hex")}`;
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--self-check-only",
          "--mode",
          "plan",
          "--head",
          "HEAD",
          "--brief",
          brief,
          "--out",
          join(root, "out"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_TOKEN: secret,
            AWS_SECRET_ACCESS_KEY: secret,
            HIMAWARI_REVIEW_GATEWAY: "",
          },
          timeout: 540000,
        },
      );
      const text = result.stdout + result.stderr;
      expect(text).toContain("SELF_CHECK_OK");
      expect(result.status).toBe(0);
      expect(text).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600000);

  it("strips git and loader variables before the real git runs", () => {
    const env = gitChildEnv({
      PATH: "/bin",
      HOME: "/h",
      GIT_EXTERNAL_DIFF: "touch",
      GIT_DIR: "/elsewhere/.git",
      GIT_CONFIG_COUNT: "1",
      LD_PRELOAD: "/x.so",
      NODE_OPTIONS: "--require x",
      GIT_PAGER: "less",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      ...GIT_ENV,
      LC_MESSAGES: "C",
      LANGUAGE: "C",
    });
  });

  it("makes the real git report errors in English without losing the character locale", () => {
    expect(gitChildEnv({ PATH: "/bin", LC_ALL: "", LANG: "ja_JP.UTF-8" }).LC_CTYPE).toBe(
      "ja_JP.UTF-8",
    );
    expect(gitChildEnv({ PATH: "/bin", LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" })).toEqual({
      PATH: "/bin",
      LANG: "ja_JP.UTF-8",
      ...GIT_ENV,
      LC_CTYPE: "ja_JP.UTF-8",
      LC_MESSAGES: "C",
      LANGUAGE: "C",
    });
  });
});

describe("opencode review git guard", () => {
  it("lets the five read subcommands through with ordinary options", () => {
    expect(checkGitArgs(["diff", "--stat", "origin/main", "HEAD"])).toBeNull();
    expect(checkGitArgs(["log", "-5", "--oneline"])).toBeNull();
    expect(checkGitArgs(["show", "HEAD:AGENTS.md"])).toBeNull();
    expect(checkGitArgs(["diff", "HEAD", "--", "--output"])).toBeNull();
    expect(checkGitArgs(["log", "-Sfoo", "-n5"])).toBeNull();
    expect(checkGitArgs(["blame", "-L1,20", "AGENTS.md"])).toBeNull();
  });

  it("[review records] refuses git paths into earlier review records and options that print them anyway", () => {
    expect(checkGitArgs(["show", `HEAD:${REVIEWS_DIR}/pr-1/usage.jsonl`])).toBe(
      `records-path HEAD:${REVIEWS_DIR}/pr-1/usage.jsonl`,
    );
    expect(checkGitArgs(["log", "-p", "--", `${REVIEWS_DIR}/pr-1`])).toBe(
      `records-path ${REVIEWS_DIR}/pr-1`,
    );
    expect(checkGitArgs(["diff", "-a", "HEAD~1", "HEAD"])).toBe("-a");
    expect(checkGitArgs(["diff", "-pa", "HEAD~1", "HEAD"])).toBe("-pa");
    expect(checkGitArgs(["diff", "--text", "HEAD~1", "HEAD"])).toBe("--text");
    expect(checkGitArgs(["diff", "--binary", "HEAD~1", "HEAD"])).toBe("--binary");
    expect(checkGitArgs(["log", "--all", "--oneline"])).toBeNull();
    expect(checkGitArgs(["log", "-Sagents", "-n3"])).toBeNull();
  });

  it("refuses other subcommands and options that write or read outside the copy", () => {
    expect(checkGitArgs(["difftool", "-y"])).toBe("subcommand difftool");
    expect(checkGitArgs(["push"])).toBe("subcommand push");
    expect(checkGitArgs([])).toBe("subcommand (none)");
    expect(checkGitArgs(["-C", "/", "log"])).toBe("subcommand -C");
    expect(checkGitArgs(["log", "--output=/tmp/x"])).toBe("--output");
    expect(checkGitArgs(["diff", "--out=/tmp/x"])).toBe("--out");
    expect(checkGitArgs(["diff", "--no-inde", "/a", "/b"])).toBe("--no-inde");
    expect(checkGitArgs(["blame", "--contents", "/a"])).toBe("--contents");
    expect(checkGitArgs(["diff", "--ext-diff"])).toBe("--ext-diff");
    expect(checkGitArgs(["diff", "-o/tmp/x"])).toBe("-o/tmp/x");
    expect(checkGitArgs(["log", "-O/tmp/order"])).toBe("-O/tmp/order");
    expect(checkGitArgs(["diff", "-pO/etc/hostname"])).toBe("-pO/etc/hostname");
    expect(checkGitArgs(["blame", "-S", "/etc/hostname"])).toBe("-S");
    expect(checkGitArgs(["blame", "-nS/etc/hostname"])).toBe("-nS/etc/hostname");
    expect(checkGitArgs(["blame", "--ignore-revs-file=/a"])).toBe("--ignore-revs-file");
    expect(checkGitArgs(["diff", "--pathspec-from-file=/a"])).toBe("--pathspec-from-file");
    expect(checkGitArgs(["show", "--help"])).toBe("--help");
    expect(checkGitArgs(["log", "--show-signature"])).toBe("--show-signature");
  });
});

describe("opencode review run outcome", () => {
  const ok = { outcome: "ok" };
  it("reports a stop, a crash or a spawn failure instead of ok", () => {
    expect(runOutcome(ok, { code: 0 })).toBe("ok");
    expect(runOutcome(ok, { code: 0, stopReason: "cost-limit" })).toBe("cost-limit");
    expect(runOutcome(ok, { code: null, stopReason: "timeout" })).toBe("timeout");
    expect(runOutcome(ok, { code: 1 })).toBe("exit-1");
    expect(runOutcome(ok, { code: null, signal: "SIGKILL" })).toBe("signal-SIGKILL");
    expect(runOutcome(ok, { code: null, spawnError: "EACCES" })).toBe("spawn-error");
    expect(runOutcome({ outcome: "truncated" }, { code: 0 })).toBe("truncated");
  });

  it("caps each model's spend so both stay under Andy's 0.5 dollar line", () => {
    expect(COST_LIMIT_PER_MODEL_USD * 2).toBeLessThanOrEqual(0.5);
  });

  it("reads usage from events recorded in a real review run", () => {
    const events = readFileSync(
      new URL("./fixtures/opencode-review/glm-events.jsonl", import.meta.url),
      "utf8",
    );
    const summary = summarizeEvents(events);
    expect(summary.outcome).toBe("ok");
    expect(summary.usage.steps).toBe(3);
    expect(summary.usage.cacheRead).toBe(58752);
    expect(summary.toolCalls[0]).toMatchObject({ tool: "bash", status: "completed" });
    expect(summary.text).toContain("复核报告");
  });

  it("rejects a timeout that is not a positive number", () => {
    for (const value of ["abc", "0", "-3"]) {
      expect(() =>
        parseArgs([
          "--head",
          "a",
          "--base",
          "b",
          "--brief",
          "b.md",
          "--pr",
          "1",
          "--timeout-minutes",
          value,
        ]),
      ).toThrow("ARG_INVALID --timeout-minutes");
    }
  });
});

describe("opencode review repository copy", () => {
  it("checks out a commit that only a remote-tracking ref points to, and drops the remote", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-review-copy-"));
    try {
      const source = join(root, "source");
      const run = (args, cwd = source) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      execFileSync("git", ["init", "--quiet", "-b", "main", source]);
      run([
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "base",
      ]);
      const base = run(["rev-parse", "HEAD"]);
      mkdirSync(join(source, ".opencode", "plugins"), { recursive: true });
      writeFileSync(
        join(source, ".opencode", "plugins", "run.ts"),
        "export const P = async () => ({});\n",
      );
      mkdirSync(join(source, "nested"));
      writeFileSync(join(source, "nested", "opencode.jsonc"), "{}\n");
      symlinkSync("/etc/hostname", join(source, "nested", "outside-link"));
      symlinkSync("opencode.jsonc", join(source, "nested", "inside-link"));
      writeFileSync(join(source, "nested", "kept.txt"), "kept\n");
      run(["add", "."]);
      run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "head"]);
      const head = run(["rev-parse", "HEAD"]);
      run(["update-ref", "refs/remotes/origin/feature", head]);
      run(["reset", "--quiet", "--hard", base]);
      const commits = resolveCommits(source, { head: "origin/feature", base: "main" });
      expect(commits).toEqual({ head, base, previous: undefined });
      const copy = join(root, "copy");
      prepareCopy({ repo: source, copy, commits, workRoot: root });
      expect(run(["rev-parse", "HEAD"], copy)).toBe(head);
      expect(run(["remote"], copy)).toBe("");
      expect(existsSync(join(copy, ".opencode"))).toBe(false);
      expect(existsSync(join(copy, "nested", "opencode.jsonc"))).toBe(false);
      expect(lstatExists(join(copy, "nested", "outside-link"))).toBe(false);
      expect(lstatExists(join(copy, "nested", "inside-link"))).toBe(true);
      expect(existsSync(join(copy, "nested", "kept.txt"))).toBe(true);
      expect(run(["reflog", "--all"], copy)).toBe("");
      expect(existsSync(join(copy, ".git", "FETCH_HEAD"))).toBe(false);
      expect(run(["log", "-1", "--format=%s", base], copy)).toBe("base");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[review records] keeps earlier review records out of the copy the models read", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-review-records-"));
    try {
      const source = join(root, "source");
      const run = (args, cwd = source) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      execFileSync("git", ["init", "--quiet", "-b", "main", source]);
      writeFileSync(join(source, "code.txt"), "one\n");
      run(["add", "."]);
      run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base"]);
      const base = run(["rev-parse", "HEAD"]);
      mkdirSync(join(source, REVIEWS_DIR, "pr-1", "round-1"), { recursive: true });
      writeFileSync(
        join(source, REVIEWS_DIR, "pr-1", "usage.jsonl"),
        '{"cost":0.1,"cacheRead":5}\n',
      );
      writeFileSync(
        join(source, REVIEWS_DIR, "pr-1", "round-1", "glm-5.3-flash.md"),
        "EARLIER_VERDICT\n",
      );
      writeFileSync(join(source, "code.txt"), "two\n");
      run(["add", "."]);
      run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "head"]);
      const head = run(["rev-parse", "HEAD"]);
      const copy = join(root, "copy");
      prepareCopy({ repo: source, copy, commits: { head, base }, workRoot: root });
      expect(existsSync(join(copy, "code.txt"))).toBe(true);
      expect(existsSync(join(copy, REVIEWS_DIR))).toBe(false);
      expect(run(["status", "--porcelain", "--untracked-files=all"], copy)).toBe("");
      run(["checkout", "--quiet", "--", "."], copy);
      expect(existsSync(join(copy, REVIEWS_DIR))).toBe(false);
      const diff = run(["diff", `${base}..${head}`], copy);
      expect(diff).toContain("+two");
      expect(diff).not.toContain("EARLIER_VERDICT");
      expect(diff).not.toContain("cacheRead");
      expect(diff).toContain("Binary files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to review a history that ever held an .env file", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-review-env-"));
    try {
      const source = join(root, "source");
      const run = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
      const commit = (message) =>
        run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message]);
      execFileSync("git", ["init", "--quiet", "-b", "main", source]);
      mkdirSync(join(source, "app"));
      writeFileSync(join(source, "app", ".env.example"), "KEY=\n");
      run(["add", "."]);
      commit("template");
      writeFileSync(join(source, "app", ".env"), "KEY=secret\n");
      run(["add", "."]);
      commit("secret");
      run(["rm", "--quiet", "app/.env"]);
      commit("remove");
      const head = run(["rev-parse", "HEAD"]);
      expect(() =>
        prepareCopy({ repo: source, copy: join(root, "copy"), commits: { head }, workRoot: root }),
      ).toThrow("ENV_FILE_IN_HISTORY app/.env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds an .env file that only a merge commit added", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-review-merge-env-"));
    try {
      const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      const as = ["-c", "user.name=t", "-c", "user.email=t@t"];
      execFileSync("git", ["init", "--quiet", "-b", "main", root]);
      run([...as, "commit", "--quiet", "--allow-empty", "-m", "base"]);
      run(["checkout", "--quiet", "-b", "side"]);
      run([...as, "commit", "--quiet", "--allow-empty", "-m", "side"]);
      run(["checkout", "--quiet", "main"]);
      run([...as, "commit", "--quiet", "--allow-empty", "-m", "main"]);
      run([...as, "merge", "--quiet", "--no-commit", "side"]);
      writeFileSync(join(root, ".env"), "KEY=secret\n");
      run(["add", ".env"]);
      run([...as, "commit", "--quiet", "-m", "merge"]);
      expect(run(["log", "--all", "--format=", "--name-only"])).toBe("");
      expect(envFilesInHistory(root)).toEqual([".env"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the review questions from the base commit, not from the change under review", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-review-questions-"));
    try {
      const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      execFileSync("git", ["init", "--quiet", "-b", "main", root]);
      mkdirSync(join(root, ".agents", "instructions"), { recursive: true });
      writeFileSync(join(root, QUESTIONS_PATH), instructions);
      run(["add", "."]);
      run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "base"]);
      const base = run(["rev-parse", "HEAD"]);
      writeFileSync(join(root, QUESTIONS_PATH), '<a id="checklist"></a>\n\n- 写得好吗？\n');
      run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-am", "weaken"]);
      expect(reviewQuestions(questionsSource(root, { base }))).toEqual(
        reviewQuestions(instructions),
      );
      expect(() => reviewQuestions(questionsSource(root, { base }, "HEAD"))).toThrow(
        "REVIEW_CHECKLIST_EMPTY",
      );
      expect(reviewQuestions(questionsSource(root, { base: "HEAD" }, base))).toEqual(
        reviewQuestions(instructions),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a ref that does not exist", () => {
    expect(() => resolveCommits(process.cwd(), { head: "no-such-ref-for-review" })).toThrow(
      "GIT_FAILED",
    );
  });
});

function startScriptedModel(reply, record = (parsed) => parsed) {
  const requests = [];
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
      const parsed = JSON.parse(body);
      const main =
        (Array.isArray(parsed.tools) && parsed.tools.length > 0) ||
        JSON.stringify(parsed.messages ?? []).includes(WRAP_UP_PROMPT);
      if (main) requests.push(record(parsed));
      const send = (payload) =>
        response.write(
          `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: parsed.model, ...payload })}\n\n`,
        );
      const step = main ? reply(parsed, requests.length) : { text: "title" };
      const callId = `call-${requests.length}`;
      if (step.status) {
        response.writeHead(step.status, {
          "content-type": "application/json",
          ...(step.retryAfter ? { "retry-after": String(step.retryAfter) } : {}),
        });
        response.end(JSON.stringify({ error: { type: "server_error", message: "BUSY_CELL" } }));
        return;
      }
      const answer = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant" };
        if (step.thinking) delta.reasoning_content = step.thinking;
        if (step.text) delta.content = step.text;
        if (step.tool)
          delta.tool_calls = [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ filePath: "AGENTS.md" }) },
            },
          ];
        send({ choices: [{ index: 0, delta, finish_reason: null }] });
        send({
          choices: [{ index: 0, delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }],
          usage: {
            prompt_tokens: step.promptTokens ?? 1,
            completion_tokens: 1,
            total_tokens: (step.promptTokens ?? 1) + 1,
          },
        });
        response.end("data: [DONE]\n\n");
      };
      const holdMs = (step.holdUntil ?? 0) - Date.now();
      if (holdMs > 0) setTimeout(answer, holdMs);
      else answer();
    });
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, requests, port: server.address().port }),
    ),
  );
}

async function withScriptedReview(reply, run, { record } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opencode-wrap-"));
  const { server, requests, port } = await startScriptedModel(reply, record);
  try {
    const copy = join(root, "repo");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${process.cwd()}`, copy]);
    const gitGuard = installGitGuard(root);
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const configPath = join(root, "review.json");
    const wrapUpConfigPath = join(root, "wrap-up.json");
    writeFileSync(configPath, JSON.stringify(reviewConfig({ mode: "plan", baseURL })));
    writeFileSync(
      wrapUpConfigPath,
      JSON.stringify(reviewConfig({ mode: "plan", baseURL, wrapUp: true })),
    );
    const review = (options = {}) =>
      reviewModel({
        binary: opencodeBinary(),
        cwd: copy,
        configPath,
        wrapUpConfigPath,
        gitGuard,
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 120000,
        ...options,
      });
    return await run({ review, requests, port });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
}

function slowStepFinishBinary(dir) {
  const path = join(dir, "slow-opencode.sh");
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      "set -o pipefail",
      `${JSON.stringify(opencodeBinary())} "$@" | while IFS= read -r line; do`,
      `  case "$line" in *'"step_finish"'*) sleep 1; printf 'x' >> ${JSON.stringify(join(dir, "delayed"))};; esac`,
      `  printf '%s\\n' "$line"`,
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

function isWrapUp(request) {
  return JSON.stringify(request.messages ?? []).includes(WRAP_UP_PROMPT);
}

function expectAppendedTo(earlier, later) {
  expect(later.tools).toEqual(earlier.tools);
  expect(later.messages.slice(0, earlier.messages.length)).toEqual(earlier.messages);
  expect(later.messages.length).toBeGreaterThan(earlier.messages.length);
}

describe("opencode review wrap-up", () => {
  it("has no step limit and tells the model to go straight to what it needs", () => {
    expect(reviewConfig({ mode: "plan" }).agent).toBeUndefined();
    for (const mode of ["code-review", "plan", "plan-review"]) {
      const prompt = buildPrompt({ mode, questions: ["q"], head: "h", base: "b", brief: "x" });
      expect(prompt.slice(0, prompt.indexOf("---- 本次材料 ----"))).toContain(FOCUS_SENTENCE);
    }
  });

  it("gives the wrap-up turn a single step and turns every allowed tool into ask, so a tool call ends the run", () => {
    for (const mode of ["code-review", "plan", "plan-review"]) {
      const config = reviewConfig({ mode, wrapUp: true });
      expect(config.agent).toEqual({ build: { steps: 1 } });
      const askedAs = JSON.parse(
        JSON.stringify(reviewConfig({ mode }).permission).replaceAll('"allow"', '"ask"'),
      );
      expect(config.permission).toEqual(askedAs);
      expect(JSON.stringify(config.permission)).not.toContain('"allow"');
    }
  });

  it("never asks again after a hard stop or a crash", () => {
    const empty = { outcome: "no-text" };
    for (const run of [
      { code: null, stopReason: "timeout" },
      { code: null, stopReason: "cost-limit" },
      { code: null, stopReason: "cost-unknown" },
      { code: null, stopReason: "wrap-up-tool-call" },
      { code: null, spawnError: "EACCES" },
      { code: 1 },
      { code: null, signal: "SIGKILL" },
    ])
      expect(wrapUpReason(empty, run)).toBeNull();
    expect(wrapUpReason(empty, { code: 0 })).toBe("no-text");
    expect(wrapUpReason({ outcome: "ok" }, { code: 0 })).toBeNull();
    expect(wrapUpReason(empty, { code: null, stopReason: "wrap-up-cost" })).toBe("cost");
    expect(wrapUpReason(empty, { code: null, stopReason: "wrap-up-time" })).toBe("time");
  });

  it("counts only numeric step costs", () => {
    const events = [
      { type: "step_finish", part: { reason: "tool-calls", tokens: {}, cost: "0.5" } },
      { type: "step_finish", part: { reason: "stop", tokens: {}, cost: 0.002 } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(summarizeEvents(events).usage.cost).toBe(0.002);
    expect(summarizeEvents(events).usage.costUnknown).toBe(true);
    expect(spentOf([{ cost: 0.002, costUnknown: true }])).toBe(COST_LIMIT_PER_MODEL_USD);
    expect(spentOf([{ cost: 0.19, costUnknown: true }])).toBeCloseTo(0.19 + WRAP_UP_RESERVE_USD);
    expect(spentOf([{ cost: 0.3, costUnknown: true }])).toBeCloseTo(0.3 + WRAP_UP_RESERVE_USD);
    const negative = JSON.stringify({
      type: "step_finish",
      part: { reason: "stop", tokens: {}, cost: -1 },
    });
    expect(summarizeEvents(negative).usage).toMatchObject({ cost: 0, costUnknown: true });
  });

  const reviewBurst = async (costs) => {
    const root = mkdtempSync(join(tmpdir(), "opencode-burst-"));
    try {
      const step = (cost) =>
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_burst",
          part: { reason: "tool-calls", tokens: {}, cost },
        });
      const binary = join(root, "fake-opencode");
      writeFileSync(
        binary,
        [
          "#!/bin/sh",
          'case "$*" in *--session*) exit 0 ;; esac',
          `printf '%s\\n' ${costs.map((cost) => `'${step(cost)}'`).join(" ")}`,
          "exec sleep 30",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      return await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard: installGitGuard(root),
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("checks the spending line at every step, even when several steps arrive together", async () => {
    const withRoom = await reviewBurst([0.08, 0.08]);
    expect(withRoom.runs[0].stopReason).toBe("wrap-up-cost");
    expect(withRoom.wrapUpSkipped).toBeNull();
    expect(withRoom.runs).toHaveLength(2);

    const overTheCap = await reviewBurst([0.08, 0.08, 0.08]);
    expect(overTheCap.runs[0].stopReason).toBe("wrap-up-cost");
    expect(overTheCap.wrapUpSkipped).toBe("no-budget");
    expect(overTheCap.runs).toHaveLength(1);
  }, 120000);

  it("does not keep spending after a step whose cost is unknown, even if the follow-up line was reached first", async () => {
    const result = await reviewBurst([0.16, "未知"]);
    expect(result.runs[0].stopReason).toBe("wrap-up-cost");
    expect(result.wrapUpSkipped).toBe("cost-unknown");
    expect(result.runs).toHaveLength(1);
  }, 60000);

  it("puts an unknown cost before a lack of budget when both apply", async () => {
    const result = await reviewBurst([0.19, "未知"]);
    expect(result.wrapUpSkipped).toBe("cost-unknown");
  }, 60000);

  it("stops at once on a step whose cost cannot be read, including a negative one", async () => {
    for (const cost of ["未知", -1]) {
      const result = await reviewBurst([0.01, cost]);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].stopReason).toBe("cost-unknown");
      expect(result.outcome).toBe("cost-unknown");
      expect(result.wrapUp).toBeNull();
      expect(result.wrapUpSkipped).toBeNull();
      expect(result.summary.usage.costUnknown).toBe(true);
    }
  }, 120000);

  it("keeps the model's thinking from the event stream", () => {
    const events = [
      { type: "reasoning", part: { type: "reasoning", text: "方案在思考里" } },
      { type: "step_finish", part: { reason: "stop", tokens: {}, cost: 0.001 } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const summary = summarizeEvents(events);
    expect(summary.outcome).toBe("no-text");
    expect(summary.thinking).toBe("方案在思考里");
  });

  it("asks once more when the answer stays in the thinking, and gets it", async () => {
    await withScriptedReview(
      (_request, index) =>
        index === 1 ? { thinking: "THOUGHT_ONLY" } : { text: "WRAPPED_ANSWER" },
      async ({ review, requests }) => {
        const result = await review();
        expect(result.wrapUp).toBe("no-text");
        expect(result.outcome).toBe("ok");
        expect(result.summary.text).toBe("WRAPPED_ANSWER");
        expect(result.summary.thinking).toContain("THOUGHT_ONLY");
        expect(requests).toHaveLength(2);
        expect(isWrapUp(requests[1])).toBe(true);
        expectAppendedTo(requests[0], requests[1]);
        const appended = JSON.stringify(requests[1].messages.slice(requests[0].messages.length));
        expect(appended).toContain(WRAP_UP_PROMPT);
        expect(appended).toContain("MAXIMUM STEPS REACHED");
        expect(appended).toContain("Respond with text only");
      },
    );
  }, 120000);

  it("stops reading near the spending cap and still gets a conclusion", async () => {
    await withScriptedReview(
      (request) =>
        isWrapUp(request) ? { text: "COST_WRAPPED" } : { tool: true, promptTokens: 220000 },
      async ({ review, requests }) => {
        const result = await review();
        expect(result.wrapUp).toBe("cost");
        expect(result.outcome).toBe("ok");
        expect(result.summary.text).toBe("COST_WRAPPED");
        expect(result.summary.usage.cost).toBeLessThanOrEqual(COST_LIMIT_PER_MODEL_USD);
        expect(requests.filter(isWrapUp)).toHaveLength(1);
        expectAppendedTo(requests.at(-2), requests.at(-1));
      },
    );
  }, 120000);

  it("stops reading near the time limit and still gets a conclusion", async () => {
    await withScriptedReview(
      (request) => (isWrapUp(request) ? { text: "TIME_WRAPPED" } : { tool: true }),
      async ({ review, requests }) => {
        const result = await review({ timeoutMs: 90000 });
        expect(result.wrapUp).toBe("time");
        expect(result.outcome).toBe("ok");
        expect(result.summary.text).toBe("TIME_WRAPPED");
        expect(requests.filter((request) => request.wrapUp)).toHaveLength(1);
        expect(requests.every((request) => Object.keys(request).join() === "wrapUp")).toBe(true);
      },
      { record: (request) => ({ wrapUp: isWrapUp(request) }) },
    );
  }, 120000);

  const stepFinishCount = (run) =>
    run.stdout.split("\n").filter((line) => line.includes('"step_finish"')).length;
  const mainRequests = (requests) => requests.filter((request) => !isWrapUp(request));
  const withoutGuardConfig = (dir, port) => {
    const path = join(dir, "no-guard.json");
    const config = reviewConfig({ mode: "plan", baseURL: `http://127.0.0.1:${port}/v1` });
    delete config.plugin;
    writeFileSync(path, JSON.stringify(config));
    return path;
  };

  it("[I-77] sends no request after the spending line even when the parent reads step_finish a second late", async () => {
    const slow = mkdtempSync(join(tmpdir(), "opencode-slow-"));
    try {
      await withScriptedReview(
        (request) =>
          isWrapUp(request) ? { text: "COST_WRAPPED" } : { tool: true, promptTokens: 120000 },
        async ({ review, requests }) => {
          const result = await review({ binary: slowStepFinishBinary(slow) });
          const first = result.runs[0];
          expect(first.stopReason).toBe("wrap-up-cost");
          expect(first.guard.reason).toBe("wrap-up-cost");
          expect(mainRequests(requests)).toHaveLength(first.guard.allowed);
          const perStep = first.guard.totalCostUsd / first.guard.allowed;
          expect(first.guard.totalCostUsd).toBeGreaterThanOrEqual(0.15);
          expect((first.guard.allowed - 1) * perStep).toBeLessThan(0.15);
          expect(stepFinishCount(first)).toBeLessThan(first.guard.allowed);
          expect(result.summary.usage.cost).toBeGreaterThanOrEqual(first.guard.totalCostUsd);
          expect(result.summary.text).toBe("COST_WRAPPED");
        },
      );
    } finally {
      rmSync(slow, { recursive: true, force: true });
    }
  }, 120000);

  it("[I-77] sends no request after the wrap-up time even when the parent reads step_finish a second late", async () => {
    const slow = mkdtempSync(join(tmpdir(), "opencode-slow-"));
    try {
      const timeoutMs = 30000;
      let pastWrapUp = Number.POSITIVE_INFINITY;
      await withScriptedReview(
        (request) =>
          isWrapUp(request) ? { text: "TIME_WRAPPED" } : { tool: true, holdUntil: pastWrapUp },
        async ({ review, requests }) => {
          pastWrapUp = Date.now() + timeoutMs - Math.floor(timeoutMs / 5) + 500;
          const result = await review({ binary: slowStepFinishBinary(slow), timeoutMs });
          const first = result.runs[0];
          expect(first.stopReason).toBe("wrap-up-time");
          expect(first.guard.reason).toBe("wrap-up-time");
          expect(first.guard.allowed).toBe(1);
          expect(mainRequests(requests)).toHaveLength(first.guard.allowed);
          expect(first.inFlight).toBe(false);
          expect(result.summary.usage.cost).toBeGreaterThanOrEqual(first.guard.totalCostUsd);
        },
      );
    } finally {
      rmSync(slow, { recursive: true, force: true });
    }
  }, 120000);

  it("[I-77] without the guard plugin the same run sends requests the parent never saw", async () => {
    const slow = mkdtempSync(join(tmpdir(), "opencode-slow-"));
    try {
      await withScriptedReview(
        (request) =>
          isWrapUp(request) ? { text: "COST_WRAPPED" } : { tool: true, promptTokens: 120000 },
        async ({ review, requests, port }) => {
          const result = await review({
            binary: slowStepFinishBinary(slow),
            configPath: withoutGuardConfig(slow, port),
          });
          const first = result.runs[0];
          expect(first.guard).toBeNull();
          expect(mainRequests(requests).length).toBeGreaterThan(15);
        },
      );
    } finally {
      rmSync(slow, { recursive: true, force: true });
    }
  }, 120000);

  const killedWithMarker = async (marker, timeoutMs = 3000) => {
    const root = mkdtempSync(join(tmpdir(), "opencode-inflight-"));
    try {
      const binary = join(root, "fake-opencode");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'if (process.argv.includes("--session")) process.exit(0);',
          'const limits = JSON.parse(fs.readFileSync(process.env.HIMAWARI_SPEND_GUARD, "utf8"));',
          `fs.writeFileSync(limits.markerPath, JSON.stringify(${JSON.stringify({ loaded: true, reason: null, totalCostUsd: 0.01, allowed: 2, completed: 1, at: 0, ...marker })}));`,
          'console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "tool-calls", tokens: {}, cost: 0.01 } }));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      return await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard: installGitGuard(root),
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("[I-77] counts a request still in flight when the parent has to kill the run", async () => {
    const result = await killedWithMarker({});
    expect(result.runs[0].stopReason).toBe("wrap-up-time");
    expect(result.runs[0].inFlight).toBe(true);
    expect(result.summary.usage.inFlight).toBe(true);
    expect(spentOf([{ cost: 0.01, inFlight: true }])).toBe(COST_LIMIT_PER_MODEL_USD);
    expect(spentOf([{ cost: 0.19, inFlight: true }])).toBeCloseTo(0.19 + WRAP_UP_RESERVE_USD);
  }, 60000);

  it("[owner stop] a stop request ends the running model, records what it spent and opens no follow-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-owner-stop-"));
    const ready = join(root, "ready");
    try {
      const binary = join(root, "fake-opencode");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const limits = JSON.parse(fs.readFileSync(process.env.HIMAWARI_SPEND_GUARD, "utf8"));',
          `fs.writeFileSync(limits.markerPath, JSON.stringify(${JSON.stringify({ loaded: true, reason: null, totalCostUsd: 0.03, allowed: 2, completed: 1, at: 0 })}));`,
          'console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "tool-calls", tokens: {}, cost: 0.03 } }));',
          `fs.writeFileSync(${JSON.stringify(ready)}, "1");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const gitGuard = installGitGuard(root);
      const running = reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard,
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
      while (!existsSync(ready)) await new Promise((wait) => setTimeout(wait, 50));
      requestStop();
      const result = await running;
      expect(result.outcome).toBe(OWNER_STOPPED);
      expect(result.runs).toHaveLength(1);
      expect(result.summary.usage.cost).toBeCloseTo(0.03);
      expect(result.summary.usage.inFlight).toBe(true);
      const late = await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard,
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
      expect(late.outcome).toBe(OWNER_STOPPED);
    } finally {
      clearStopRequest();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("[owner stop] a stop request cuts short the wait before an API-error retry", async () => {
    try {
      const started = Date.now();
      const waiting = waitUnlessStopped(60000);
      setTimeout(() => requestStop(), 50);
      await waiting;
      expect(Date.now() - started).toBeLessThan(5000);
      const after = Date.now();
      await waitUnlessStopped(60000);
      expect(Date.now() - after).toBeLessThan(1000);
    } finally {
      clearStopRequest();
    }
  });

  it("[owner stop] the first signal asks the models to stop, the second one or the grace period forces the exit", async () => {
    const calls = [];
    const make = (running, graceMs = 60000) =>
      signalHandler({
        running: () => running,
        requestStop: (reason) => calls.push(`stop ${reason}`),
        cleanup: () => calls.push("cleanup"),
        exit: (code) => calls.push(`exit ${code}`),
        graceMs,
      });
    make(false)("SIGTERM");
    expect(calls).toEqual(["cleanup", "exit 143"]);
    calls.length = 0;
    const handler = make(true);
    handler("SIGINT");
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`]);
    handler("SIGINT");
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`, "cleanup", "exit 130"]);
    calls.length = 0;
    const slow = make(true, 20);
    slow("SIGTERM");
    await new Promise((wait) => setTimeout(wait, 100));
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`, "cleanup", "exit 143"]);
    calls.length = 0;
    const settled = make(true, 20);
    settled("SIGTERM");
    settled.dispose();
    await new Promise((wait) => setTimeout(wait, 100));
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`]);
  });

  it("[I-77] hands the first run's recorded cost to the resumed run as its starting point", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-start-"));
    try {
      const binary = join(root, "fake-opencode");
      const startFile = join(root, "starting.txt");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const limits = JSON.parse(fs.readFileSync(process.env.HIMAWARI_SPEND_GUARD, "utf8"));',
          'if (process.argv.includes("--session")) {',
          `  fs.writeFileSync(${JSON.stringify(startFile)}, String(limits.startingUsd));`,
          '  console.log(JSON.stringify({ type: "text", sessionID: "ses_x", part: { text: "ANSWER" } }));',
          '  console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "stop", tokens: {}, cost: 0.001 } }));',
          "  process.exit(0);",
          "}",
          'console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "tool-calls", tokens: {}, cost: 0.16 } }));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const result = await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard: installGitGuard(root),
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
      expect(result.runs).toHaveLength(2);
      expect(Number(readFileSync(startFile, "utf8"))).toBeCloseTo(0.16);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("[I-77] keeps the reason the guard wrote even when the parent's timer fires before the process exits", async () => {
    const result = await killedWithMarker({ reason: "wrap-up-cost", allowed: 1, completed: 1 });
    expect(result.runs[0].stopReason).toBe("wrap-up-cost");
    expect(result.runs[0].inFlight).toBe(false);
  }, 60000);

  it("[I-77] lets the single wrap-up request through even though the money line was already crossed", async () => {
    await withScriptedReview(
      (request) =>
        isWrapUp(request) ? { text: "COST_WRAPPED" } : { tool: true, promptTokens: 120000 },
      async ({ review, requests }) => {
        const result = await review();
        expect(result.runs).toHaveLength(2);
        expect(requests.filter(isWrapUp)).toHaveLength(1);
        expect(result.outcome).toBe("ok");
        expect(result.runs[1].guard.totalCostUsd).toBeGreaterThanOrEqual(
          result.runs[0].guard.totalCostUsd,
        );
        expect(result.runs[1].guard.completed).toBeLessThanOrEqual(result.runs[1].guard.allowed);
      },
    );
  }, 120000);

  it("[I-77] still loads the guard when the environment asks opencode to skip external plugins", async () => {
    const saved = process.env.OPENCODE_PURE;
    process.env.OPENCODE_PURE = "1";
    try {
      await withScriptedReview(
        () => ({ text: "FIRST_ANSWER" }),
        async ({ review }) => {
          const result = await review();
          expect(result.runs[0].guard.loaded).toBe(true);
          expect(result.runs[0].guard.allowed).toBe(1);
        },
      );
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_PURE;
      else process.env.OPENCODE_PURE = saved;
    }
  }, 120000);

  it("stops the wrap-up turn at its first tool call instead of letting it keep reading", async () => {
    const slow = mkdtempSync(join(tmpdir(), "opencode-slow-"));
    try {
      await withScriptedReview(
        (_request, index) =>
          index === 1 ? { thinking: "THOUGHT_ONLY" } : { tool: true, promptTokens: 100000 },
        async ({ review, requests }) => {
          const result = await review({ binary: slowStepFinishBinary(slow) });
          expect(result.wrapUp).toBe("no-text");
          expect(result.outcome).toBe("wrap-up-tool-call");
          expect(requests.filter(isWrapUp)).toHaveLength(1);
          expect(result.summary.usage.cost).toBeGreaterThan(0.01);
          const wrapUpCall = result.summary.toolCalls.at(-1);
          expect(wrapUpCall.status).toBe("error");
          expect(wrapUpCall.output).toContain("rejected permission");
          const stepFinishes = result.stdout
            .split("\n")
            .filter((line) => line.includes('"step_finish"')).length;
          expect(stepFinishes).toBeGreaterThanOrEqual(2);
          expect(readFileSync(join(slow, "delayed"), "utf8")).toHaveLength(stepFinishes);
        },
      );
    } finally {
      rmSync(slow, { recursive: true, force: true });
    }
  }, 120000);

  it("records cost-limit when the wrap-up step that calls a tool also runs past the remaining money", async () => {
    await withScriptedReview(
      (request, index) =>
        index === 1
          ? { thinking: "THOUGHT_ONLY" }
          : { tool: true, promptTokens: isWrapUp(request) ? 4000000 : 1 },
      async ({ review }) => {
        const result = await review();
        expect(result.wrapUp).toBe("no-text");
        expect(result.summary.toolCalls.length).toBeGreaterThan(0);
        expect(result.outcome).toBe("cost-limit");
      },
    );
  }, 120000);

  it("skips the wrap-up turn when too little money is left for it, and says why", async () => {
    await withScriptedReview(
      () => ({ thinking: "THOUGHT_ONLY", promptTokens: 10000 }),
      async ({ review, requests }) => {
        const result = await review({ costLimit: WRAP_UP_MIN_USD + 0.001 });
        expect(result.wrapUp).toBe("cost");
        expect(result.wrapUpSkipped).toBe("no-budget");
        expect(result.outcome).toBe("wrap-up-cost");
        expect(requests.filter(isWrapUp)).toHaveLength(0);
      },
    );
  }, 120000);

  it("[api error] waits and runs the review again after the service stays busy, and adds up both costs", async () => {
    await withScriptedReview(
      (_request, index) =>
        index <= 6 ? { status: 429, retryAfter: 1 } : { text: "AFTER_RETRY", promptTokens: 1000 },
      async ({ review, requests }) => {
        const started = Date.now();
        const result = await review({ retryWaitMs: 3000 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
        expect(result.outcome).toBe("ok");
        expect(result.retry).toBe("retried");
        expect(result.retriedAfter).toContain("BUSY_CELL");
        expect(result.summary.text).toBe("AFTER_RETRY");
        expect(result.summary.apiError).toBeNull();
        expect(result.runs).toHaveLength(2);
        expect(requests).toHaveLength(7);
        expect(requests[6].messages).toEqual(requests[0].messages);
      },
    );
  }, 120000);

  it("[api error] retries only once and records the service error when it is still busy", async () => {
    await withScriptedReview(
      () => ({ status: 429, retryAfter: 1 }),
      async ({ review, requests }) => {
        const result = await review({ retryWaitMs: 1000 });
        expect(result.outcome).toBe("api-error");
        expect(result.retry).toBe("retried");
        expect(result.summary.apiError).toMatchObject({ statusCode: 429, retryable: true });
        expect(result.runs).toHaveLength(2);
        expect(requests).toHaveLength(12);
      },
    );
  }, 120000);

  it("[owner stop] a stop during the wait before an API-error retry ends it at once and does not retry", async () => {
    await withScriptedReview(
      () => ({ status: 429, retryAfter: 1 }),
      async ({ review, requests }) => {
        try {
          const started = Date.now();
          const running = review({ retryWaitMs: 60000, timeoutMs: 300000 });
          while (requests.length < 6) await new Promise((wait) => setTimeout(wait, 50));
          await new Promise((wait) => setTimeout(wait, 1000));
          requestStop();
          const result = await running;
          expect(Date.now() - started).toBeLessThan(45000);
          expect(result.outcome).toBe(OWNER_STOPPED);
          expect(result.retry).toBe(OWNER_STOPPED);
          expect(result.runs).toHaveLength(1);
          expect(requests).toHaveLength(6);
        } finally {
          clearStopRequest();
        }
      },
    );
  }, 120000);

  it("[api error] does not retry a refusal the service marks as final", async () => {
    await withScriptedReview(
      () => ({ status: 401 }),
      async ({ review }) => {
        const result = await review({ retryWaitMs: 1000 });
        expect(result.outcome).toBe("api-error");
        expect(result.summary.apiError).toMatchObject({ statusCode: 401, retryable: false });
        expect(result.retry).toBeNull();
        expect(result.runs).toHaveLength(1);
      },
    );
  }, 120000);

  it("does not ask again when the first answer is already there", async () => {
    await withScriptedReview(
      () => ({ text: "FIRST_ANSWER" }),
      async ({ review, requests }) => {
        const result = await review();
        expect(result.wrapUp).toBeNull();
        expect(result.summary.text).toBe("FIRST_ANSWER");
        expect(requests).toHaveLength(1);
      },
    );
  }, 120000);
});

async function authorizationSent({ savedKey, environmentKey }) {
  const root = mkdtempSync(join(tmpdir(), "opencode-credential-"));
  const headers = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") headers.push(request.headers.authorization ?? null);
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"credential probe"}}');
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const dataHome = join(root, "data");
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  if (savedKey) {
    writeFileSync(
      join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api", key: savedKey } }),
    );
  }
  const isolated = {
    XDG_DATA_HOME: dataHome,
    OPENCODE_API_KEY: environmentKey,
    OPENCODE_AUTH_CONTENT: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(isolated).map((name) => [name, process.env[name]]),
  );
  const setEnv = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  setEnv(isolated);
  try {
    const copy = join(root, "repo");
    mkdirSync(copy);
    execFileSync("git", ["init", "--quiet"], { cwd: copy });
    const review = reviewConfig({ mode: "code-review" });
    const provider = review.provider["opencode-go"];
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const configPath = join(root, "review.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...review,
        provider: { "opencode-go": { ...provider, options: { ...provider.options, baseURL } } },
      }),
    );
    await reviewModel({
      binary: opencodeBinary(),
      cwd: copy,
      configPath,
      wrapUpConfigPath: configPath,
      gitGuard: installGitGuard(root),
      model: "opencode-go/deepseek-v4.1-flash",
      prompt: "REVIEW_TASK",
      timeoutMs: 60000,
    });
    return headers;
  } finally {
    setEnv(previous);
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
}

describe("opencode review credentials", () => {
  it("[OpenCode 401] sends the key saved by opencode auth login, not a placeholder", async () => {
    const savedKey = `saved-${randomBytes(6).toString("hex")}`;
    const headers = await authorizationSent({ savedKey });
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBe(`Bearer ${savedKey}`);
  }, 120000);

  it("[OpenCode 401] prefers the key saved by opencode auth login over OPENCODE_API_KEY", async () => {
    const savedKey = `saved-${randomBytes(6).toString("hex")}`;
    const headers = await authorizationSent({
      savedKey,
      environmentKey: `environment-${randomBytes(6).toString("hex")}`,
    });
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBe(`Bearer ${savedKey}`);
  }, 120000);

  it("[OpenCode 401] sends no key of its own when none is saved, so the cloud proxy can add one", async () => {
    const headers = await authorizationSent({ savedKey: null });
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBeNull();
  }, 120000);
});

const fakeOpenAiKey = ["sk", "abcdefghijklmnopqrstuv"].join("-");

describe("opencode review record masking", () => {
  it("masks text the machine-secret scan would report, rule by rule", () => {
    const samples = {
      "openai-api-key": fakeOpenAiKey,
      "github-token": ["gh", "p_", "A".repeat(24)].join(""),
      "aws-access-key": ["AKIA", "B".repeat(16)].join(""),
      "jwt-token": ["eyJ", "a".repeat(10), ".", "b".repeat(10), ".", "c".repeat(10)].join(""),
      "authorization-bearer": ["Bearer", "x".repeat(16)].join(" "),
      "credential-assignment": ["pass", "word: ", "y".repeat(14)].join(""),
      "private-key-any-block": [
        ["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" "),
        "z".repeat(40),
        ["-----END", "ENCRYPTED PRIVATE KEY-----"].join(" "),
      ].join("\n"),
      "private-key-header": `说明 ${["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" ")} 后面只有文字`,
      "private-key-block": [
        ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
        "z".repeat(20),
        ["-----END", "PRIVATE KEY-----"].join(" "),
      ].join("\n"),
    };
    expect(Object.keys(samples).sort()).toEqual(RECORD_SECRET_RULES.map(([id]) => id).sort());
    for (const [id, sample] of Object.entries(samples)) {
      expect(secretLikeRules(`说明 ${sample} 结束`)).toContain(id);
      const masked = maskSecretLike(`说明 ${sample} 结束`);
      expect(masked).toContain(`[已遮盖:${id}]`);
      expect(masked).not.toContain(sample);
      expect(secretLikeRules(masked)).toEqual([]);
    }
  });

  it("[round-2 R2-1] masks private-key headers of any case and prefix, as gitleaks does", () => {
    for (const label of [
      "OPENSSH PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "pgp private key block",
      "FOO_BAR-BAZ PRIVATE KEY",
    ]) {
      const text = `x -----BEGIN ${label}----- y`;
      expect(secretLikeRules(text)).toContain("private-key-header");
      expect(maskSecretLike(text)).toBe("x [已遮盖:private-key-header] y");
    }
    expect(secretLikeRules("-----BEGIN CERTIFICATE-----")).toEqual([]);
  });

  it("[round-3 R3-1] masks the body of non-RSA private key blocks, not only the header", () => {
    const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(3);
    for (const label of ["ENCRYPTED PRIVATE KEY", "DSA PRIVATE KEY", "pgp private key block"]) {
      const text = `a -----BEGIN ${label}-----\n${body}\n-----END ${label}----- b`;
      const masked = maskSecretLike(text);
      expect(masked).not.toContain(body);
      expect(secretLikeRules(masked)).toEqual([]);
    }
    const lone = `-----BEGIN PRIVATE KEY----- ${"说明".repeat(5000)}`;
    expect(maskSecretLike(lone)).toContain("说明说明");
  });

  it("[round-2 R2-2] a ledger line stays valid JSON when a field ends in secret-like text", () => {
    const tail = ["pass", "word: ", "y".repeat(14)].join("");
    const record = {
      mode: "override",
      quote: tail,
      problems: [tail, "ok"],
      nested: { files: [tail] },
      cost: 0,
    };
    const line = ledgerLine(record);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.quote).toBe("[已遮盖:credential-assignment]");
    expect(parsed.problems).toEqual(["[已遮盖:credential-assignment]", "ok"]);
    expect(parsed.nested.files).toEqual(["[已遮盖:credential-assignment]"]);
    expect(parsed.cost).toBe(0);
    expect(secretLikeRules(line)).toEqual([]);
  });

  it("[round-2 R2-3] every ledger writer goes through ledgerLine, none stringifies and masks afterwards", () => {
    const source = readFileSync(
      new URL("../../scripts/model-review/opencode-review.mjs", import.meta.url),
      "utf8",
    );
    const appends = [
      ...source.matchAll(
        /appendFileSync\(\s*(?:ledgerFile|join\(options\.out, "usage\.jsonl"\)),([\s\S]*?)\)\s*;\s*\n/g,
      ),
    ];
    expect(appends.length).toBe(3);
    for (const [, body] of appends) {
      expect(body).toContain("ledgerLine(");
      expect(body).not.toContain("JSON.stringify");
      expect(body).not.toContain("maskSecretLike(");
    }
  });

  it("leaves ordinary review prose alone, including short sk- words and key names", () => {
    const prose = "- 低度：sk-short 太短不算；apiKey 这个字段名没有值；Bearer 后面没有令牌";
    expect(secretLikeRules(prose)).toEqual([]);
    expect(maskedRecordText(prose)).toBe(`${prose}\n`);
  });

  it("uses exactly the rules of scripts/scan-machine-secrets.mjs, so the two cannot drift apart", () => {
    const scan = readFileSync(
      new URL("../../scripts/scan-machine-secrets.mjs", import.meta.url),
      "utf8",
    );
    for (const [id, pattern] of RECORD_SECRET_RULES) {
      if (id === "private-key-header" || id === "private-key-any-block") continue;
      expect(scan).toContain(`"${id}"`);
      expect(scan).toContain(pattern.toString());
    }
    const scanIds = [...scan.matchAll(/^\s*\[?\s*"([a-z-]+)",/gm)].map((match) => match[1]);
    const recordOnly = RECORD_SECRET_RULES.map(([id]) => id).filter((id) => !scanIds.includes(id));
    expect(recordOnly).toEqual(["private-key-any-block", "private-key-header"]);
    expect(scanIds.sort()).toEqual(
      RECORD_SECRET_RULES.map(([id]) => id)
        .filter((id) => !recordOnly.includes(id))
        .sort(),
    );
  });
});

describe("opencode review merge gate", () => {
  const [deepseek, glm] = REVIEW_MODELS;
  const ok = (round, head, model, extra = {}) => ({
    at: "t",
    cost: 0.05,
    round,
    mode: "code-review",
    model,
    head,
    outcome: "ok",
    steps: 3,
    input: 10,
    cacheRead: 5,
    output: 2,
    reasoning: 1,
    ...extra,
  });
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-merge-gate-"));
    const repo = join(root, "repo");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
    const commit = (files, message) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const ledger = `${REVIEWS_DIR}/pr-7/usage.jsonl`;
    const writeLedger = (records) =>
      commit({ [ledger]: records.map((r) => `${JSON.stringify(r)}\n`).join("") }, "records");
    const main = commit({ "code.txt": "base\n" }, "base");
    git("update-ref", "refs/remotes/origin/main", main);
    git("checkout", "--quiet", "-b", "feature");
    const reviewed = commit({ "code.txt": "feature\n" }, "feature");
    const check = (extra = {}) => assertReviewed({ repo, pr: 7, mainRef: "origin/main", ...extra });
    return { root, repo, git, commit, writeLedger, main, reviewed, check, ledger };
  };

  it("[merge gate] passes when only the PR's own records changed after the last complete round", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const result = f.check();
      expect(result.problems).toEqual([]);
      expect(result.lines[0]).toMatch(
        new RegExp(`^REVIEW_CURRENT pr=7 round=1 reviewed=${f.reviewed} head=[0-9a-f]{40}$`),
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] refuses records that carry secret-like text and accepts the masked form", () => {
    const f = fixture();
    try {
      const note = `${fakeOpenAiKey} is a split fake value\n`;
      f.commit({ [`${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md`]: note }, "raw record");
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      expect(f.check().problems).toEqual([
        `record-secret-like ${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md openai-api-key`,
      ]);
      f.commit(
        { [`${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md`]: maskedRecordText(note) },
        "masked record",
      );
      expect(f.check().problems).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] refuses a lone private-key header in a record that cannot be waived", () => {
    const f = fixture();
    try {
      const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
      f.commit(
        { [`${REVIEWS_DIR}/pr-7/round-1/glm-5.3-flash.md`]: `只有开头 ${header} 后面是文字\n` },
        "lone header",
      );
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const problems = f.check({ acceptUnreviewed: "Andy 说跳过" }).problems;
      expect(problems).toContain(
        `record-secret-like ${REVIEWS_DIR}/pr-7/round-1/glm-5.3-flash.md private-key-header`,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[round-3 R3-2] a secret-like change to another PR's records is refused even with --accept-unreviewed", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit(
        { [`${REVIEWS_DIR}/pr-9/round-1/deepseek-v4.1-flash.md`]: `${fakeOpenAiKey}\n` },
        "other pr record",
      );
      const result = f.check({ acceptUnreviewed: "Andy 说跳过" });
      expect(result.problems).toContain(
        `record-secret-like ${REVIEWS_DIR}/pr-9/round-1/deepseek-v4.1-flash.md openai-api-key`,
      );
      expect(result.overridden).toBeFalsy();
      f.commit(
        {
          [`${REVIEWS_DIR}/pr-9/round-1/deepseek-v4.1-flash.md`]: maskedRecordText(
            `${fakeOpenAiKey}\n`,
          ),
        },
        "masked",
      );
      expect(f.check().problems.filter((p) => p.startsWith("record-"))).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] reports record-unreadable when the records cannot be listed", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    try {
      expect(recordSecretProblems({ repo: notARepo, ledgerPath: `${REVIEWS_DIR}/pr-7` })).toEqual([
        `record-unreadable ${REVIEWS_DIR}/pr-7`,
      ]);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("[merge gate] fails on any other change after the review, including a merge of main", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ "docs/rule.md": "tightened\n" }, "small fix after review");
      expect(f.check().problems).toEqual(["unreviewed docs/rule.md"]);
      f.git("checkout", "--quiet", "main");
      const ahead = f.commit({ "other.txt": "main moved\n" }, "main moved");
      f.git("update-ref", "refs/remotes/origin/main", ahead);
      f.git("checkout", "--quiet", "feature");
      expect(f.check().problems).toEqual([
        "unreviewed docs/rule.md",
        "main-not-merged origin/main",
      ]);
      f.git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "merge",
        "--quiet",
        "--no-edit",
        "origin/main",
      );
      expect(f.check().problems).toEqual(["unreviewed docs/rule.md", "unreviewed other.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] accepts record files with non-ASCII names and appends overrides on a new line", () => {
    const f = fixture();
    try {
      const rounds = [1, 2, 3].flatMap((round) => [
        ok(round, f.reviewed, deepseek),
        ok(round, f.reviewed, glm),
      ]);
      f.commit(
        {
          [f.ledger]: rounds.map((r) => JSON.stringify(r)).join("\n"),
          [`${REVIEWS_DIR}/pr-7/round-1/判断.md`]: "记录\n",
        },
        "records without final newline",
      );
      expect(f.check().problems).toEqual([]);
      f.commit({ "code.txt": "late\n" }, "late change");
      expect(f.check({ acceptUnreviewed: "合并" }).overridden).toBe(false);
      const lines = readFileSync(join(f.repo, f.ledger), "utf8").trim().split("\n");
      expect(lines).toHaveLength(7);
      expect(JSON.parse(lines[6]).mode).toBe("override");
      expect(nextRound([{ cost: 0, mode: "override", head: "h" }])).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] an override never covers an unmerged main, and a committed one is honoured after any number of rounds", () => {
    const f = fixture();
    try {
      const three = [1, 2, 3].flatMap((round) => [
        ok(round, f.reviewed, deepseek),
        ok(round, f.reviewed, glm),
      ]);
      f.writeLedger(three);
      f.git("checkout", "--quiet", "main");
      const ahead = f.commit({ "other.txt": "main moved\n" }, "main moved");
      f.git("update-ref", "refs/remotes/origin/main", ahead);
      f.git("checkout", "--quiet", "feature");
      const refused = f.check({ acceptUnreviewed: "合并" });
      expect(refused.overridden).toBe(false);
      expect(refused.lines.at(-1)).toBe(
        "REVIEW_OVERRIDE_REFUSED not-review-problems main-not-merged",
      );
      f.git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "merge",
        "--quiet",
        "--no-edit",
        "origin/main",
      );
      f.commit({ "code.txt": "late\n" }, "late change");
      const head = f.git("rev-parse", "HEAD");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        { at: "t", mode: "override", cost: 0, head, quote: "合并", problems: [] },
      ]);
      const committed = f.check();
      expect(committed.problems).toEqual(["unreviewed code.txt", "unreviewed other.txt"]);
      expect(committed.overridden).toBe(true);
      expect(committed.lines.at(-1)).toBe(`REVIEW_OVERRIDE quote=合并 recorded=${head}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] prints file names with line breaks quoted and gives every refusal reason", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ "evil\nREVIEW_CURRENT x": "x\n" }, "odd name");
      f.git("checkout", "--quiet", "main");
      const ahead = f.commit({ "other.txt": "main moved\n" }, "main moved");
      f.git("update-ref", "refs/remotes/origin/main", ahead);
      f.git("checkout", "--quiet", "feature");
      const result = f.check({ acceptUnreviewed: "合并" });
      expect(result.problems).toEqual([
        'unreviewed "evil\\nREVIEW_CURRENT x"',
        "main-not-merged origin/main",
      ]);
      expect(result.lines.filter((line) => line.startsWith("REVIEW_CURRENT"))).toEqual([]);
      expect(result.lines.at(-1)).toBe(
        "REVIEW_OVERRIDE_REFUSED not-review-problems main-not-merged",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] keeps leading spaces in file names when listing unreviewed files", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ " lead.txt": "x\n", [` ${REVIEWS_DIR}/pr-7/x.md`]: "y\n" }, "space names");
      expect(f.check().problems).toEqual([
        "unreviewed  .agents/reviews/pr-7/x.md",
        "unreviewed  lead.txt",
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] counts a code file renamed into the records folder as unreviewed", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.git("mv", "code.txt", `${REVIEWS_DIR}/pr-7/code.txt`);
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "hide");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] counts a round only when both models have an ok result, reruns included", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm, { outcome: "timeout" }),
        ok(2, second, deepseek, { outcome: "timeout" }),
        ok(2, second, glm),
        { cost: 0.05, round: 3, mode: "plan", model: glm, head: f.reviewed, outcome: "ok" },
      ]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
      const head = f.git("rev-parse", "HEAD");
      f.git("checkout", "--quiet", head);
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm, { outcome: "timeout" }),
        ok(1, f.reviewed, glm),
        ok(2, second, deepseek, { outcome: "timeout" }),
        ok(2, second, glm),
      ]);
      const result = f.check();
      expect(result.round).toBe(1);
      expect(result.problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] a DeepSeek round after a full round covers the later commit", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, second, deepseek, { previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 2, reviewed: second, problems: [] });
      expect(result.lines[1]).toBe("REVIEW_CHAIN round-1:both round-2:deepseek");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] refuses a single-model round whose previous commit skips unreviewed work", () => {
    const f = fixture();
    try {
      const unreviewed = f.commit({ "code.txt": "unreviewed\n" }, "unreviewed");
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      for (const extra of [{ previous: unreviewed }, {}, { previous: null }]) {
        f.writeLedger([...first, ok(2, unreviewed, deepseek, extra)]);
        expect(f.check().problems).toEqual([`chain-broken round=2 ${unreviewed}`]);
      }
      f.writeLedger([...first, ok(2, unreviewed, deepseek, { previous: f.main })]);
      expect(f.check()).toMatchObject({ round: 2, problems: [] });
      const third = f.commit({ "code.txt": "third\n" }, "third");
      f.writeLedger([
        ...first,
        ok(2, unreviewed, deepseek, { previous: f.reviewed }),
        ok(3, third, deepseek, { previous: unreviewed }),
        ok(3, third, glm, { previous: unreviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 3, problems: [] });
      expect(result.lines[1]).toBe("REVIEW_CHAIN round-1:both round-2:deepseek round-3:both");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] counts GLM alone only when it stood in for DeepSeek", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      f.writeLedger([...first, ok(2, second, glm)]);
      expect(f.check()).toMatchObject({ round: 1, problems: ["unreviewed code.txt"] });
      f.writeLedger([...first, ok(2, second, glm, { substitute: true, substituteFor: glm })]);
      expect(f.check()).toMatchObject({ round: 1, problems: ["unreviewed code.txt"] });
      f.writeLedger([
        ...first,
        ok(2, second, deepseek, { outcome: "api-error", previous: f.reviewed }),
        ok(2, second, glm, { substitute: true, substituteFor: deepseek, previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 2, problems: [] });
      expect(result.lines[1]).toBe("REVIEW_CHAIN round-1:both round-2:substitute");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] refuses a DeepSeek round on a commit the full round never led to", () => {
    const f = fixture();
    try {
      f.git("checkout", "--quiet", "-b", "side", f.main);
      const rewritten = f.commit({ "code.txt": "rewritten\n" }, "rewritten");
      f.git("checkout", "--quiet", "feature");
      f.git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "merge",
        "--quiet",
        "-s",
        "ours",
        "-m",
        "take side",
        "side",
      );
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, rewritten, deepseek, { previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result.problems).toEqual([`chain-broken round=2 ${rewritten}`]);
      const broken = f.check({ acceptUnreviewed: "合并" });
      expect(broken.overridden).toBe(false);
      expect(broken.lines.at(-1)).toBe("REVIEW_OVERRIDE_WRITTEN quote=合并 commit-and-rerun");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] the report accepts a DeepSeek-only last round and flags a failed one", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      const report = (stop) => reviewReport({ repo: f.repo, pr: 7, mainRef: "origin/main", stop });
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      f.writeLedger([...first, ok(2, second, deepseek, { previous: f.reviewed })]);
      expect(report("no-error").at(-2)).toBe("停下的原因：没有“会出错”的意见");
      expect(() => report("run-failed")).toThrow("REPORT_STOP_INCONSISTENT run-failed");
      f.writeLedger([
        ...first,
        ok(2, second, deepseek, { outcome: "timeout", previous: f.reviewed }),
      ]);
      expect(() => report("no-error")).toThrow("REPORT_STOP_INCONSISTENT no-error");
      expect(report("run-failed").at(-2)).toBe("停下的原因：有模型没跑完（outcome 不是 ok）");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  const answer = "严重度：低。tools.mjs:3 少了一个空行检查。";
  const verdict = (extra = {}) => ({
    id: "V1",
    model: deepseek,
    quote: "tools.mjs:3 少了一个空行检查",
    valid: true,
    class: "error",
    severity: "low",
    trigger: "输入为空行",
    consequence: "多打印一行空白",
    modelSeverity: "低",
    ...extra,
  });
  const lowFixFixture = (verdicts = [verdict()]) => {
    const f = fixture();
    const roundDir = `${REVIEWS_DIR}/pr-7/round-1`;
    f.commit(
      {
        [`${roundDir}/deepseek-v4.1-flash.md`]: `${answer}\n`,
        [`${roundDir}/verdicts.jsonl`]: verdicts.map((v) => `${JSON.stringify(v)}\n`).join(""),
      },
      "verdicts",
    );
    f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
    const commitLedgerOnDisk = () =>
      f.commit({ [f.ledger]: readFileSync(join(f.repo, f.ledger), "utf8") }, "low-fix record");
    return { ...f, commitLedgerOnDisk };
  };

  it("[low fix] accepts a small fix with a test change for a round whose errors are all low", () => {
    const f = lowFixFixture();
    try {
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      const accepted = f.check({ acceptLow: 1 });
      expect(accepted.overridden).toBe(true);
      expect(accepted.lines.at(-1)).toMatch(
        /^REVIEW_LOW_FIX round=1 from=[0-9a-f]{40} head=[0-9a-f]{40} files=code\.txt,test\/code\.test\.mjs$/,
      );
      const records = parseUsage(readFileSync(join(f.repo, f.ledger), "utf8"), "ledger");
      expect(records.at(-1)).toMatchObject({
        mode: "low-fix",
        cost: 0,
        round: 1,
        from: f.reviewed,
        files: ["code.txt", "test/code.test.mjs"],
        findings: ["V1"],
      });
      expect(nextRound(records)).toBe(2);
      f.commitLedgerOnDisk();
      const after = f.check();
      expect(after.problems).toEqual([]);
      expect(after.lines[1]).toBe("REVIEW_CHAIN round-1:both round-1:low-fix");
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "no-error",
      });
      expect(report).toContain("低严重度已改、未复核：");
      expect(report).toContain(`  V1 deepseek-v4.1-flash：${verdict().quote}`);
      f.commit({ "code.txt": "again\n" }, "later change");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] allows one low-fix per round and reports the quotes from the record's own commit", () => {
    const f = lowFixFixture();
    try {
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      expect(f.check({ acceptLow: 1 }).overridden).toBe(true);
      const firstFix = f.commitLedgerOnDisk();
      f.commit(
        {
          [`${REVIEWS_DIR}/pr-7/round-1/verdicts.jsonl`]: `${JSON.stringify(verdict({ quote: "改过的原话" }))}\n`,
        },
        "edit verdicts after acceptance",
      );
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "no-error",
      });
      expect(report).toContain(`  V1 deepseek-v4.1-flash：${verdict().quote}`);
      f.commit(
        { "code.txt": "fixed again\n", "test/code.test.mjs": "check again\n" },
        "second fix",
      );
      expect(f.check({ acceptLow: 1 }).lines.at(-1)).toBe(
        "REVIEW_LOW_FIX_REFUSED already-low-fixed round=1",
      );
      const ledger = readFileSync(join(f.repo, f.ledger), "utf8");
      const head = f.git("rev-parse", "HEAD");
      const lowFix = JSON.parse(ledger.trim().split("\n").at(-1));
      f.commit(
        {
          [f.ledger]: `${ledger}${JSON.stringify({ ...lowFix, head, from: lowFix.head })}\n`,
        },
        "hand-written second low-fix",
      );
      expect(f.check().problems).toEqual(["low-fix-invalid round=1 second-low-fix"]);
      expect(firstFix).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] needs a test file with added lines and refuses file names with line breaks", () => {
    const refusal = (prepare) => {
      const f = lowFixFixture();
      try {
        prepare(f);
        return f.check({ acceptLow: 1 }).lines.at(-1);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    };
    expect(
      refusal((f) => f.commit({ "code.txt": "fixed\n", "test/README.md": "notes\n" }, "fix")),
    ).toBe("REVIEW_LOW_FIX_REFUSED no-test-change");
    expect(
      refusal((f) => {
        f.commit({ "test/old.test.mjs": "old\n" }, "add a test");
        f.writeLedger([
          ok(1, f.git("rev-parse", "HEAD"), deepseek),
          ok(1, f.git("rev-parse", "HEAD"), glm),
        ]);
        f.git("rm", "-q", "test/old.test.mjs");
        f.commit({ "code.txt": "fixed\n" }, "delete the test");
      }),
    ).toBe("REVIEW_LOW_FIX_REFUSED no-test-change");
    expect(
      refusal((f) =>
        f.commit({ "code.txt": "fixed\n", "test/odd\nname.test.mjs": "check\n" }, "fix"),
      ),
    ).toBe('REVIEW_LOW_FIX_REFUSED file-name-has-line-break "test/odd\\nname.test.mjs"');
  });

  it("[low fix] the report lists only low-fix records on the chain and marks the rest", () => {
    const f = lowFixFixture();
    try {
      const fixed = f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
      const record = {
        at: "t",
        mode: "low-fix",
        cost: 0,
        round: 1,
        head: fixed,
        from: f.reviewed,
        files: ["code.txt", "test/code.test.mjs"],
        findings: ["V1"],
      };
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      f.writeLedger([...first, record, { ...record, round: 99 }]);
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "no-error",
      });
      expect(report).toContain(`  V1 deepseek-v4.1-flash：${verdict().quote}`);
      expect(report).toContain(
        `REVIEW_LOW_FIX_NOT_IN_CHAIN round=99 head=${fixed} files=code.txt,test/code.test.mjs`,
      );
      expect(report.filter((line) => line.startsWith("REVIEW_LOW_FIX "))).toHaveLength(1);
      f.writeLedger([...first, record, { ...record, findings: ["V9"] }]);
      const duplicated = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "andy-decision",
        andyQuote: "看一下",
      });
      expect(duplicated.filter((line) => line.startsWith("REVIEW_LOW_FIX "))).toHaveLength(1);
      expect(duplicated).toContain(
        `REVIEW_LOW_FIX_NOT_IN_CHAIN round=1 head=${fixed} files=code.txt,test/code.test.mjs`,
      );
      expect(duplicated.join("\n")).not.toContain("V9 ");
      f.git("rm", "-q", `${REVIEWS_DIR}/pr-7/round-1/verdicts.jsonl`);
      const dropped = f.commit({ "other.txt": "x\n" }, "drop verdicts");
      f.writeLedger([...first, { ...record, head: dropped }]);
      const missing = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "andy-decision",
        andyQuote: "看一下",
      });
      expect(missing).toContain(
        "REVIEW_LOW_FIX_NOT_IN_CHAIN round=1 head=" +
          dropped +
          " files=code.txt,test/code.test.mjs",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] lets a docs-only fix through without a test change", () => {
    const f = lowFixFixture();
    try {
      f.commit({ "docs/rule.md": "wording\n" }, "doc fix");
      expect(f.check({ acceptLow: 1 }).overridden).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] refuses medium or high errors, missing tests, oversized fixes and unproven quotes", () => {
    const refusal = (verdicts, files) => {
      const f = lowFixFixture(verdicts);
      try {
        if (files) f.commit(files, "fix");
        const result = f.check({ acceptLow: 1 });
        expect(result.overridden).toBe(false);
        expect(existsSync(join(f.repo, f.ledger))).toBe(true);
        expect(readFileSync(join(f.repo, f.ledger), "utf8")).not.toContain("low-fix");
        return result.lines.find((line) => line.startsWith("REVIEW_LOW_FIX_REFUSED"));
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    };
    const small = { "code.txt": "fixed\n", "test/code.test.mjs": "check\n" };
    expect(refusal([verdict({ severity: "medium-high", modelSeverity: "高" })], small)).toBe(
      "REVIEW_LOW_FIX_REFUSED not-low V1",
    );
    expect(refusal([verdict()], { "code.txt": "fixed\n" })).toBe(
      "REVIEW_LOW_FIX_REFUSED no-test-change",
    );
    const many = Object.fromEntries(
      Array.from({ length: LOW_FIX_MAX_FILES + 1 }, (_, index) => [
        `test/f${index}.test.mjs`,
        "x\n",
      ]),
    );
    expect(refusal([verdict()], many)).toBe(
      `REVIEW_LOW_FIX_REFUSED too-many-files ${LOW_FIX_MAX_FILES + 1} max=${LOW_FIX_MAX_FILES}`,
    );
    const long = "x\n".repeat(LOW_FIX_MAX_LINES_PER_FILE + 1);
    expect(refusal([verdict()], { "test/code.test.mjs": long })).toBe(
      `REVIEW_LOW_FIX_REFUSED too-many-lines test/code.test.mjs ${LOW_FIX_MAX_LINES_PER_FILE + 1} max=${LOW_FIX_MAX_LINES_PER_FILE}`,
    );
    expect(refusal([verdict({ quote: "模型没说过这句" })], small)).toBe(
      "REVIEW_LOW_FIX_REFUSED quote-not-found V1",
    );
    expect(refusal([verdict({ class: "better" })], small)).toBe(
      "REVIEW_LOW_FIX_REFUSED no-low-errors",
    );
    expect(refusal([verdict()])).toBe("REVIEW_LOW_FIX_REFUSED nothing-unreviewed");
  });

  it("[low fix] refuses a round that is not the last one covered and a round without verdicts", () => {
    const f = lowFixFixture();
    try {
      const second = f.commit({ "code.txt": "second\n" }, "second");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, second, deepseek, { previous: f.reviewed }),
      ]);
      f.commit({ "test/code.test.mjs": "check\n" }, "fix");
      expect(f.check({ acceptLow: 1 }).lines.at(-1)).toBe(
        "REVIEW_LOW_FIX_REFUSED not-last-round last=2",
      );
      expect(f.check({ acceptLow: 2 }).lines.at(-1)).toBe(
        "REVIEW_LOW_FIX_REFUSED verdicts-not-committed round-2",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] checks a low-fix record against the evidence at its own commit and its own lists", () => {
    const record = (head, extra = {}) => ({
      at: "t",
      mode: "low-fix",
      cost: 0,
      round: 1,
      head,
      files: ["code.txt", "test/code.test.mjs"],
      findings: ["V1"],
      ...extra,
    });
    const f = fixture();
    try {
      const fixed = f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
      const roundDir = `${REVIEWS_DIR}/pr-7/round-1`;
      f.commit(
        {
          [`${roundDir}/deepseek-v4.1-flash.md`]: `${answer}\n`,
          [`${roundDir}/verdicts.jsonl`]: `${JSON.stringify(verdict())}\n`,
        },
        "evidence added after the fix",
      );
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        record(fixed, { from: f.reviewed }),
      ]);
      expect(f.check().problems).toEqual([
        "low-fix-invalid round=1 verdicts-not-committed round-1",
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
    const g = lowFixFixture();
    try {
      const fixed = g.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
      const first = [ok(1, g.reviewed, deepseek), ok(1, g.reviewed, glm)];
      g.writeLedger([...first, record(fixed, { from: g.reviewed, files: ["test/code.test.mjs"] })]);
      expect(g.check().problems).toEqual(["low-fix-invalid round=1 files-differ"]);
      g.writeLedger([...first, record(fixed, { from: g.reviewed, findings: ["V9"] })]);
      expect(g.check().problems).toEqual(["low-fix-invalid round=1 findings-differ"]);
      g.writeLedger([...first, record(fixed, { from: g.reviewed })]);
      expect(g.check().problems).toEqual([]);
    } finally {
      rmSync(g.root, { recursive: true, force: true });
    }
  });

  it("[low fix] a refused --accept-low exits non-zero even when nothing is unreviewed", () => {
    const f = lowFixFixture();
    try {
      const run = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--assert-reviewed",
          "--pr",
          "7",
          "--repo",
          f.repo,
          "--accept-low",
          "1",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(run.stdout).toContain("REVIEW_LOW_FIX_REFUSED nothing-unreviewed");
      expect(run.status).toBe(5);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);

  it("[low fix] checks a hand-written low-fix record again at the gate", () => {
    const f = lowFixFixture();
    try {
      const fixed = f.commit({ "code.txt": "fixed\n" }, "fix without test");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        {
          at: "t",
          mode: "low-fix",
          cost: 0,
          round: 1,
          head: fixed,
          from: f.reviewed,
          files: ["code.txt"],
          findings: ["V1"],
        },
      ]);
      expect(f.check().problems).toEqual(["low-fix-invalid round=1 no-test-change"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] reads the committed ledger, not the working tree", () => {
    const f = fixture();
    try {
      expect(f.check().problems).toEqual(["ledger-not-committed"]);
      mkdirSync(join(f.repo, REVIEWS_DIR, "pr-7"), { recursive: true });
      writeFileSync(
        join(f.repo, f.ledger),
        `${JSON.stringify(ok(1, f.reviewed, deepseek))}\n${JSON.stringify(ok(1, f.reviewed, glm))}\n`,
      );
      expect(f.check().problems).toEqual(["ledger-not-committed"]);
      f.writeLedger([ok(1, f.reviewed, deepseek)]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] fails when the reviewed commit is not in the branch any more", () => {
    const f = fixture();
    try {
      f.git("checkout", "--quiet", "main");
      f.git("checkout", "--quiet", "-b", "rewritten");
      f.commit({ "code.txt": "other\n" }, "rewritten");
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      expect(f.check().problems[0]).toBe(`not-ancestor ${f.reviewed}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] records Andy's words after one round and passes only once the record is committed", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ "code.txt": "after one round\n" }, "early fix");
      const result = f.check({ acceptUnreviewed: "合并" });
      expect(result.problems).toEqual(["unreviewed code.txt"]);
      expect(result.overridden).toBe(false);
      expect(result.lines.at(-1)).toBe("REVIEW_OVERRIDE_WRITTEN quote=合并 commit-and-rerun");
      const written = readFileSync(join(f.repo, f.ledger), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(written.at(-1)).toMatchObject({
        mode: "override",
        cost: 0,
        quote: "合并",
        problems: ["unreviewed code.txt"],
      });
      f.git("add", ".");
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "override");
      const later = f.check();
      expect(later.overridden).toBe(true);
      expect(later.lines.at(-1)).toBe(`REVIEW_OVERRIDE quote=合并 recorded=${written.at(-1).head}`);
      f.commit({ "code.txt": "changed again\n" }, "after override");
      expect(f.check().overridden).toBe(false);
      writeFileSync(join(f.repo, f.ledger), "{}\n");
      const dirty = f.check({ acceptUnreviewed: "合并" });
      expect(dirty.overridden).toBe(false);
      expect(dirty.lines.at(-1)).toBe("REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] Andy can skip review on a PR with no review at all, once his words are committed", () => {
    const f = fixture();
    try {
      const bare = f.check();
      expect(bare.problems).toEqual(["ledger-not-committed"]);
      const written = f.check({ acceptUnreviewed: "跳过复核，合并" });
      expect(written.overridden).toBe(false);
      expect(written.lines.at(-1)).toBe(
        "REVIEW_OVERRIDE_WRITTEN quote=跳过复核，合并 commit-and-rerun",
      );
      expect(JSON.parse(readFileSync(join(f.repo, f.ledger), "utf8"))).toMatchObject({
        mode: "override",
        quote: "跳过复核，合并",
        head: f.reviewed,
        problems: ["ledger-not-committed"],
      });
      f.git("add", ".");
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "override");
      const later = f.check();
      expect(later.problems).toEqual(["no-complete-round"]);
      expect(later.overridden).toBe(true);
      expect(later.lines.at(-1)).toBe(
        `REVIEW_OVERRIDE quote=跳过复核，合并 recorded=${f.reviewed}`,
      );
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "andy-decision",
        andyQuote: "跳过复核，合并",
      });
      expect(report).toContain(
        `REVIEW_OVERRIDE_RECORD head=${f.reviewed} quote=跳过复核，合并 problems=ledger-not-committed`,
      );
      const odd = {
        at: "t",
        mode: "override",
        cost: 0,
        head: f.reviewed,
        quote: "x",
        problems: "y",
      };
      for (const problems of ["y", [3]]) {
        f.writeLedger([{ ...odd, problems }]);
        expect(() => f.check()).toThrow("USAGE_LEDGER_INVALID");
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] the script answers before installing opencode or spending", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const run = () =>
        spawnSync(
          process.execPath,
          [
            "scripts/model-review/opencode-review.mjs",
            "--assert-reviewed",
            "--pr",
            "7",
            "--repo",
            f.repo,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
          },
        );
      const pass = run();
      expect(pass.status).toBe(0);
      expect(pass.stdout).toMatch(/^REVIEW_CURRENT pr=7 round=1 /);
      f.commit({ "code.txt": "unreviewed\n" }, "late change");
      const fail = run();
      expect(fail.status).toBe(5);
      expect(fail.stdout).toMatch(/^REVIEW_NOT_CURRENT pr=7 /);
      expect(fail.stdout).toContain("unreviewed code.txt");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);
  it("[review report] prints the fixed lines from the committed ledger", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const lines = reviewReport({ repo: f.repo, pr: 7, mainRef: "origin/main", stop: "no-error" });
      expect(lines[0]).toBe("REVIEW_REPORT pr=7");
      expect(lines[1]).toBe(resultLine(ok(1, f.reviewed, deepseek)));
      expect(lines[2]).toBe(resultLine(ok(1, f.reviewed, glm)));
      expect(lines[3]).toBe("REVIEW_SPENT_TOTAL 0.1000");
      expect(lines[4]).toMatch(/^REVIEW_CURRENT pr=7 round=1 /);
      expect(lines.at(-2)).toBe("停下的原因：没有“会出错”的意见");
      expect(lines.at(-1)).toBe(REVIEW_REPORT_DISCLAIMER);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review report] refuses a stop reason the ledger does not support", () => {
    const f = fixture();
    try {
      const report = (stop, extra = {}) =>
        reviewReport({ repo: f.repo, pr: 7, mainRef: "origin/main", stop, ...extra });
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm, { outcome: "timeout" })]);
      expect(() => report("no-error")).toThrow("REPORT_STOP_INCONSISTENT no-error");
      expect(report("run-failed").at(-2)).toBe("停下的原因：有模型没跑完（outcome 不是 ok）");
      expect(() => report("three-rounds")).toThrow("REPORT_STOP_INCONSISTENT three-rounds");
      expect(() => report("andy-decision")).toThrow("REPORT_STOP_INCONSISTENT andy-decision");
      expect(report("andy-decision", { andyQuote: "这条不改" }).at(-2)).toBe(
        "停下的原因：Andy 裁定：这条不改",
      );
      expect(() => report("whatever")).toThrow("ARG_INVALID --stop");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, f.reviewed, deepseek),
        ok(2, f.reviewed, glm),
        ok(3, f.reviewed, deepseek),
        ok(3, f.reviewed, glm),
      ]);
      expect(() => report("run-failed")).toThrow("REPORT_STOP_INCONSISTENT run-failed");
      expect(report("three-rounds").at(-2)).toBe(
        "停下的原因：连续三轮没过，按规则停下等 Andy 决定",
      );
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(2, f.reviewed, deepseek),
        ok(3, f.reviewed, deepseek, { outcome: OWNER_STOPPED }),
      ]);
      expect(() => report("three-rounds")).toThrow("REPORT_STOP_INCONSISTENT three-rounds");
      f.commit({ "code.txt": "late\n" }, "late change");
      expect(() => report("no-error")).toThrow("REPORT_STOP_INCONSISTENT no-error");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review report] the script prints the report and fails on an inconsistent stop reason", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const run = (stop) =>
        spawnSync(
          process.execPath,
          [
            "scripts/model-review/opencode-review.mjs",
            "--report",
            "--pr",
            "7",
            "--repo",
            f.repo,
            "--stop",
            stop,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
          },
        );
      const good = run("no-error");
      expect(good.status).toBe(0);
      expect(good.stdout.trim().split("\n").at(-1)).toBe(REVIEW_REPORT_DISCLAIMER);
      const bad = run("run-failed");
      expect(bad.status).toBe(2);
      expect(bad.stderr.trim()).toBe("REPORT_STOP_INCONSISTENT run-failed");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);
});

describe("opencode review spending", () => {
  const record = (cost, round = 1) => ({ cost, round });

  it("refuses a run that could take the task past the ask-first line", () => {
    expect(budgetCheck({ mode: "plan", records: [], models: REVIEW_MODELS })).toBeNull();
    expect(
      budgetCheck({ mode: "plan", records: [record(0.12), record(0.14)], models: REVIEW_MODELS }),
    ).toMatch(/^BUDGET_NEEDS_APPROVAL /);
    expect(
      budgetCheck({
        mode: "plan",
        records: [record(0.12), record(0.14)],
        models: REVIEW_MODELS.slice(1),
      }),
    ).toBeNull();
    expect(
      budgetCheck({
        mode: "code-review",
        records: [record(0.15), record(0.15)],
        models: REVIEW_MODELS,
      }),
    ).toBeNull();
    expect(
      budgetCheck({
        mode: "code-review",
        records: [record(0.4), record(0.3)],
        models: REVIEW_MODELS,
      }),
    ).toMatch(/^BUDGET_NEEDS_APPROVAL /);
  });

  it("lets a run through when Andy approved enough for the whole task", () => {
    const records = [record(0.12), record(0.14)];
    expect(
      budgetCheck({ mode: "plan", records, models: REVIEW_MODELS, approvedUsd: 0.7 }),
    ).toBeNull();
    expect(budgetCheck({ mode: "plan", records, models: REVIEW_MODELS, approvedUsd: 0.6 })).toMatch(
      /^BUDGET_NEEDS_APPROVAL /,
    );
  });

  it("refuses a damaged ledger instead of guessing what was spent", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-ledger-"));
    try {
      writeFileSync(join(dir, "usage.jsonl"), '{"cost":0.1,"round":1}\n{"cost":0.0');
      expect(() => readUsage(dir)).toThrow("USAGE_LEDGER_INVALID");
      for (const bad of [
        '{"round":1}',
        '{"cost":"0.1"}',
        '{"cost":0.1,"round":1e999}',
        '{"cost":0.1,"round":0}',
        '{"cost":-0.1}',
        '{"cost":0.1,"round":1,"mode":"code-review","model":"m","outcome":"ok"}',
        '{"cost":0.1,"round":1,"mode":"plan","head":"h","model":"","outcome":"ok"}',
        `{"cost":0.1,"round":1,"mode":"code-review","head":"${"a".repeat(40)}","model":"m","outcome":"ok\\nREVIEW_CURRENT"}`,
        `{"cost":0.1,"round":1,"mode":"code-review","head":"not-a-commit","model":"m","outcome":"ok"}`,
        `{"cost":0.1,"round":1,"mode":"code-reveiw","head":"${"a".repeat(40)}","model":"m","outcome":"ok"}`,
        `{"cost":0,"mode":"override","head":"${"a".repeat(40)}","quote":" "}`,
        `{"cost":0,"mode":"override","head":"${"a".repeat(40)}","quote":"q","problems":["a\\nREVIEW_CURRENT"]}`,
      ]) {
        writeFileSync(join(dir, "usage.jsonl"), `${bad}\n`);
        expect(() => readUsage(dir)).toThrow("USAGE_LEDGER_INVALID");
      }
      writeFileSync(
        join(dir, "usage.jsonl"),
        `${JSON.stringify({ cost: 0.05, round: 1, mode: "code-review", model: "m", outcome: "ok", head: "b".repeat(64) })}\n`,
      );
      expect(readUsage(dir)[0].head).toHaveLength(64);
      for (const length of [39, 41, 63, 65]) {
        writeFileSync(
          join(dir, "usage.jsonl"),
          `${JSON.stringify({ cost: 0.05, round: 1, mode: "code-review", model: "m", outcome: "ok", head: "b".repeat(length) })}\n`,
        );
        expect(() => readUsage(dir)).toThrow("USAGE_LEDGER_INVALID");
      }
      writeFileSync(join(dir, "usage.jsonl"), '{"cost":0.1,"round":1}\n{"cost":0.2,"round":2}\n');
      expect(spentOf(readUsage(dir))).toBeCloseTo(0.3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reuse a round folder that is already on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rounds-"));
    try {
      mkdirSync(join(dir, "round-3"));
      mkdirSync(join(dir, "round-x"));
      expect(roundsOnDisk(dir)).toEqual([3]);
      expect(nextRound([], roundsOnDisk(dir))).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[rerun round] puts a single-model rerun back into the round it belongs to", () => {
    const [deepseek, glm] = REVIEW_MODELS;
    const records = [
      { cost: 0.1, round: 1, model: deepseek, head: "h1", outcome: "ok" },
      { cost: 0.1, round: 1, model: glm, head: "h1", outcome: "ok" },
      { cost: 0.1, round: 2, model: deepseek, head: "h2", outcome: "ok" },
      { cost: 0.1, round: 2, model: glm, head: "h2", outcome: "timeout" },
    ];
    const run = (overrides) =>
      roundForRun({
        records,
        rounds: [1, 2],
        models: [glm],
        head: "h2",
        prompts: { [glm]: "P", [deepseek]: "D" },
        promptsOnDisk: { [glm]: "P", [deepseek]: "D" },
        ...overrides,
      });
    expect(run({ requested: undefined })).toBe(3);
    expect(run({ requested: 2 })).toBe(2);
    expect(() => run({ requested: 2, models: [deepseek] })).toThrow(
      `ROUND_ALREADY_HAS_RESULT 2 ${deepseek}`,
    );
    expect(() => run({ requested: 1 })).toThrow(`ROUND_ALREADY_HAS_RESULT 1 ${glm}`);
    expect(() => run({ requested: 3 })).toThrow("ROUND_NOT_FOUND 3");
    expect(() => run({ requested: 2, head: "h3" })).toThrow("ROUND_HEAD_MISMATCH 2 h2 h3");
    expect(() => run({ requested: 2, prompts: { [glm]: "other brief" } })).toThrow(
      `ROUND_PROMPT_MISMATCH 2 ${glm}`,
    );
    expect(() => run({ requested: 2, promptsOnDisk: {} })).toThrow(`ROUND_CANNOT_VERIFY 2 ${glm}`);
    expect(run({ requested: 2, prompts: { [glm]: "P", [deepseek]: "changed" } })).toBe(2);
    expect(
      parseArgs(["--head", "a", "--brief", "b", "--topic", "t", "--mode", "plan", "--round", "2"])
        .round,
    ).toBe(2);
    for (const bad of ["0", "-1", "1.5", "x"])
      expect(() =>
        parseArgs([
          "--head",
          "a",
          "--brief",
          "b",
          "--topic",
          "t",
          "--mode",
          "plan",
          "--round",
          bad,
        ]),
      ).toThrow("ARG_INVALID --round");
  });

  it("refuses a prompt over the size limit before spending or writing records", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-large-"));
    try {
      const brief = join(dir, "brief.md");
      writeFileSync(brief, "x".repeat(100001));
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--mode",
          "plan",
          "--head",
          "HEAD",
          "--topic",
          "prompt-too-large-probe",
          "--brief",
          brief,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).toBe("PROMPT_TOO_LARGE");
      expect(existsSync(join(REVIEWS_DIR, "topic-prompt-too-large-probe"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("[rerun round] falls back to the ledger's prompt digest when the prompt file is gone", () => {
    const [, glm] = REVIEW_MODELS;
    const digest = createHash("sha256").update("P").digest("hex");
    const records = [
      { cost: 0.1, round: 1, model: glm, head: "h", outcome: "timeout", promptSha256: digest },
    ];
    const run = (prompt) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: prompt },
        promptsOnDisk: {},
      });
    expect(run("P")).toBe(1);
    expect(() => run("other brief")).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
  });

  it("[rerun round] accepts the masked prompt file that the run itself wrote, and refuses a changed one", () => {
    const [, glm] = REVIEW_MODELS;
    const prompt = `问题里引用了 ${fakeOpenAiKey} 这个值\n`;
    const digest = createHash("sha256").update(prompt).digest("hex");
    const records = [
      { cost: 0.1, round: 1, model: glm, head: "h", outcome: "timeout", promptSha256: digest },
    ];
    const run = (onDisk) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: prompt },
        promptsOnDisk: { [glm]: onDisk },
      });
    expect(maskSecretLike(prompt)).not.toBe(prompt);
    expect(run(maskSecretLike(prompt))).toBe(1);
    expect(() => run(prompt)).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
    expect(() => run(`${maskSecretLike(prompt)}\n`)).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
  });

  it("[rerun round] refuses a round whose records have no commit to compare", () => {
    const [, glm] = REVIEW_MODELS;
    const digest = createHash("sha256").update("P").digest("hex");
    expect(() =>
      roundForRun({
        records: [{ cost: 0.1, round: 1, model: glm, outcome: "timeout", promptSha256: digest }],
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: "P" },
        promptsOnDisk: {},
      }),
    ).toThrow("ROUND_CANNOT_VERIFY 1 head");
  });

  it("[rerun round] refuses another mode's round and ignores override records", () => {
    const [, glm] = REVIEW_MODELS;
    const digest = createHash("sha256").update("P").digest("hex");
    const base = {
      cost: 0.1,
      round: 1,
      model: glm,
      head: "h",
      outcome: "timeout",
      promptSha256: digest,
    };
    const run = (records, mode) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        mode,
        models: [glm],
        head: "h",
        prompts: { [glm]: "P" },
        promptsOnDisk: {},
      });
    expect(() => run([{ ...base, mode: "plan" }], "plan-review")).toThrow(
      "ROUND_MODE_MISMATCH 1 plan plan-review",
    );
    expect(run([{ ...base, mode: "plan" }], "plan")).toBe(1);
    expect(
      run(
        [
          { ...base, mode: "code-review" },
          { cost: 0, mode: "override", head: "other" },
        ],
        "code-review",
      ),
    ).toBe(1);
  });

  it("[review env] refuses to start when a proxy address carries a user name or password", () => {
    expect(
      proxyCredentialProblems({
        HTTPS_PROXY: "http://127.0.0.1:8080",
        http_proxy: "http://u:p@proxy:3128",
      }),
    ).toEqual(["http_proxy"]);
    expect(proxyCredentialProblems({ HTTPS_PROXY: "https://token@proxy" })).toEqual([
      "HTTPS_PROXY",
    ]);
    expect(proxyCredentialProblems({ NO_PROXY: "a@b" })).toEqual([]);
    expect(proxyCredentialProblems({ HTTP_PROXY: " http://u:p@proxy:3128" })).toEqual([
      "HTTP_PROXY",
    ]);
    expect(proxyCredentialProblems({ https_proxy: "u:p@proxy:3128" })).toEqual(["https_proxy"]);
    expect(proxyCredentialProblems({ http_proxy: "//u:p@proxy:3128" })).toEqual(["http_proxy"]);
    expect(
      proxyCredentialProblems({ https_proxy: "proxy:3128", HTTP_PROXY: "http://proxy/a@b" }),
    ).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "opencode-proxy-"));
    try {
      const brief = join(dir, "brief.md");
      writeFileSync(brief, "material\n");
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--mode",
          "plan",
          "--head",
          "HEAD",
          "--topic",
          "proxy-probe",
          "--brief",
          brief,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HTTPS_PROXY: "http://user:secret@proxy:3128",
            HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode",
          },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).toBe("PROXY_HAS_CREDENTIALS HTTPS_PROXY");
      expect(result.stderr).not.toContain("secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("[rerun round] keeps the failed attempt's files next to the new ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-attempt-"));
    try {
      expect(keepEarlierAttempt(join(dir, "missing"), "glm-5.3-flash")).toBeNull();
      expect(keepEarlierAttempt(dir, "glm-5.3-flash")).toBeNull();
      writeFileSync(join(dir, "glm-5.3-flash.prompt.md"), "prompt");
      writeFileSync(join(dir, "glm-5.3-flash.md"), "first");
      writeFileSync(join(dir, "glm-5.3-flash.stderr.txt"), "first err");
      writeFileSync(join(dir, "deepseek-v4.1-flash.md"), "other model");
      expect(keepEarlierAttempt(dir, "glm-5.3-flash")).toBe(1);
      writeFileSync(join(dir, "glm-5.3-flash.md"), "second");
      expect(keepEarlierAttempt(dir, "glm-5.3-flash")).toBe(2);
      writeFileSync(join(dir, "glm-5.3-flash.jsonl"), "raw");
      writeFileSync(join(dir, "glm-5.3-flash.magpie-usage.jsonl"), "usage");
      expect(keepEarlierAttempt(dir, "glm-5.3-flash", RAW_FILE_SUFFIXES)).toBe(1);
      expect(readdirSync(dir).sort()).toEqual([
        "deepseek-v4.1-flash.md",
        "glm-5.3-flash.attempt-1.jsonl",
        "glm-5.3-flash.attempt-1.magpie-usage.jsonl",
        "glm-5.3-flash.attempt-1.md",
        "glm-5.3-flash.attempt-1.prompt.md",
        "glm-5.3-flash.attempt-1.stderr.txt",
        "glm-5.3-flash.attempt-2.md",
      ]);
      expect(readFileSync(join(dir, "glm-5.3-flash.attempt-1.md"), "utf8")).toBe("first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[rerun round] the script refuses a rerun into a round that already has the result, before spending", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rerun-"));
    try {
      const brief = join(dir, "brief.md");
      writeFileSync(brief, "material\n");
      const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const repo = join(dir, "repo");
      execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${process.cwd()}`, repo]);
      const out = join(repo, ".agents", "reviews", "topic-rerun");
      mkdirSync(join(out, "round-1"), { recursive: true });
      writeFileSync(
        join(out, "usage.jsonl"),
        `${JSON.stringify({ cost: 0.1, round: 1, model: REVIEW_MODELS[1], head, outcome: "ok" })}\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--mode",
          "plan",
          "--head",
          head,
          "--brief",
          brief,
          "--repo",
          repo,
          "--topic",
          "rerun",
          "--models",
          "glm-5.3-flash",
          "--round",
          "1",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).toBe(`ROUND_ALREADY_HAS_RESULT 1 ${REVIEW_MODELS[1]}`);
      expect(readdirSync(join(out, "round-1"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("numbers rounds from what the folder already holds", () => {
    expect(nextRound([])).toBe(1);
    expect(nextRound([record(0.1, 1), record(0.1, 1), record(0.1, 2)])).toBe(3);
    expect(nextRound([{ cost: 0.1 }])).toBe(2);
  });

  it("[review chain] needs both models in the first code-review round and defaults to DeepSeek later", () => {
    const base = ["--head", "a", "--base", "b", "--brief", "b.md", "--pr", "7"];
    expect(parseArgs(base).models).toEqual(REVIEW_MODELS);
    expect(() => parseArgs([...base, "--models", "deepseek-v4.1-flash"])).toThrow(
      "ARG_FIRST_ROUND_NEEDS_BOTH_MODELS",
    );
    expect(parseArgs([...base, "--models", "glm-5.3-flash", "--round", "1"]).models).toEqual([
      REVIEW_MODELS[1],
    ]);
    expect(parseArgs([...base, "--previous", "c"]).models).toEqual([REVIEW_MODELS[0]]);
    expect(
      parseArgs([...base, "--previous", "c", "--models", "deepseek-v4.1-flash,glm-5.3-flash"])
        .models,
    ).toEqual(REVIEW_MODELS);
    const plan = ["--mode", "plan", "--head", "a", "--brief", "b.md", "--topic", "t"];
    expect(parseArgs([...plan, "--models", "glm-5.3-flash"]).models).toEqual([REVIEW_MODELS[1]]);
    expect(
      parseArgs([
        "--mode",
        "plan-review",
        "--head",
        "a",
        "--brief",
        "b.md",
        "--topic",
        "t",
        "--models",
        "deepseek-v4.1-flash",
      ]).models,
    ).toEqual([REVIEW_MODELS[0]]);
  });

  it("[review chain] gives DeepSeek the same fixed prompt with or without a previous round", () => {
    const questions = reviewQuestions(instructions);
    const common = { mode: "code-review", model: REVIEW_MODELS[0], questions, base: "b" };
    const first = buildPrompt({ ...common, head: "h1", brief: "第一轮" });
    const later = buildPrompt({ ...common, head: "h2", previous: "h1", brief: "第二轮" });
    const fixedEnd = first.indexOf("---- 本次材料 ----");
    expect(later.slice(0, fixedEnd)).toBe(first.slice(0, fixedEnd));
    expect(first.slice(0, fixedEnd)).toContain("规则文件、说明文档和代码是否一致");
  });

  it("[low fix] reads verdict lines strictly and needs a reason when the thread lowers the model's severity", () => {
    const line = (extra = {}) =>
      JSON.stringify({
        id: "V1",
        model: REVIEW_MODELS[0],
        quote: "原话",
        valid: true,
        class: "error",
        severity: "low",
        trigger: "触发",
        consequence: "后果",
        modelSeverity: "低",
        ...extra,
      });
    expect(parseVerdicts(`${line()}\n\n`, "v")).toHaveLength(1);
    expect(
      parseVerdicts(line({ valid: false, severity: undefined, trigger: "" }), "v"),
    ).toHaveLength(1);
    expect(parseVerdicts(line({ class: "better", severity: undefined }), "v")).toHaveLength(1);
    expect(
      parseVerdicts(line({ modelSeverity: "中", reason: "只在手动调试时出现" }), "v"),
    ).toHaveLength(1);
    for (const bad of [
      line({ modelSeverity: "中" }),
      line({ trigger: " " }),
      line({ consequence: undefined }),
      line({ severity: "medium" }),
      line({ model: "x/other" }),
      line({ class: "nit" }),
      line({ quote: "第一行\n第二行" }),
      line({ valid: "yes" }),
      "not json",
    ])
      expect(() => parseVerdicts(bad, "v")).toThrow("VERDICTS_INVALID v:1");
    expect(() => parseVerdicts(`${line()}\n${line({ quote: "另一句" })}\n`, "v")).toThrow(
      "VERDICTS_INVALID v:2",
    );
    expect(parseVerdicts(`${line()}\n${line({ id: "V2" })}\n`, "v")).toHaveLength(2);
  });

  it("[low fix] tells test files apart from code", () => {
    for (const path of [
      "test/a.mjs",
      "packages/x/test/a.ts",
      "src/a.test.ts",
      "a.spec.mjs",
      "x/__tests__/b.js",
    ])
      expect(isTestFile(path)).toBe(true);
    for (const path of [
      "src/a.ts",
      "testing/a.ts",
      "docs/test.md",
      "latest/a.mjs",
      "test/README.md",
      "test/README.MD",
    ])
      expect(isTestFile(path)).toBe(false);
  });

  it("[low fix] keeps low-fix records out of round numbers and rejects malformed ones", () => {
    const commit = "a".repeat(40);
    const good = {
      at: "t",
      mode: "low-fix",
      cost: 0,
      round: 1,
      head: commit,
      from: commit,
      files: ["a"],
      findings: ["V1"],
    };
    expect(nextRound(parseUsage(JSON.stringify(good), "l"))).toBe(1);
    for (const bad of [
      { ...good, from: undefined },
      { ...good, cost: 0.1 },
      { ...good, files: [] },
      { ...good, findings: [""] },
      { ...good, round: undefined },
    ])
      expect(() => parseUsage(JSON.stringify(bad), "l")).toThrow("USAGE_LEDGER_INVALID l:1");
    const base = ["--head", "a", "--base", "b", "--brief", "b.md", "--pr", "7"];
    expect(() => parseArgs([...base, "--accept-low", "1"])).toThrow(
      "ARG_ACCEPT_LOW_ONLY_WITH_ASSERT",
    );
    expect(parseArgs(["--assert-reviewed", "--pr", "7", "--accept-low", "2"]).acceptLow).toBe(2);
    expect(() => parseArgs(["--assert-reviewed", "--pr", "7", "--accept-low", "0"])).toThrow(
      "ARG_INVALID --accept-low",
    );
    expect(() =>
      parseArgs([
        "--assert-reviewed",
        "--pr",
        "7",
        "--accept-low",
        "1",
        "--accept-unreviewed",
        "x",
      ]),
    ).toThrow("ARG_ACCEPT_LOW_AND_UNREVIEWED");
    expect(() =>
      parseArgs(["--report", "--pr", "7", "--stop", "no-error", "--accept-low", "1"]),
    ).toThrow("ARG_NOT_FOR_SUBCOMMAND --accept-low");
  });

  it("reruns only the models asked for", () => {
    const base = ["--mode", "plan", "--head", "a", "--brief", "b.md", "--topic", "t"];
    expect(parseArgs(base).models).toEqual(REVIEW_MODELS);
    expect(parseArgs([...base, "--models", "deepseek-v4.1-flash"]).models).toEqual([
      "opencode-go/deepseek-v4.1-flash",
    ]);
    expect(() => parseArgs([...base, "--models", "kimi-k3"])).toThrow("ARG_INVALID --models");
    expect(
      parseArgs([...base, "--models", " glm-5.3-flash , opencode-go/deepseek-v4.1-flash"]).models,
    ).toEqual(["opencode-go/glm-5.3-flash", "opencode-go/deepseek-v4.1-flash"]);
    for (const bad of ["glm-5.3-flash,", "glm-5.3-flash,glm-5.3-flash", ""])
      expect(() => parseArgs([...base, "--models", bad])).toThrow("ARG_INVALID --models");
    expect(parseArgs([...base, "--approved-usd", "0.7"]).approvedUsd).toBe(0.7);
    expect(() => parseArgs([...base, "--approved-usd", "x"])).toThrow("ARG_INVALID --approved-usd");
  });
});

describe("spend guard decisions", () => {
  const limits = { totalUsd: 0.2, stopAtUsd: 0.15, deadlineAt: 2000, wrapUpAt: 1000 };

  it("[I-77] stops in the same order the parent does", () => {
    expect(guardDecision(limits, { cost: 0.01, allowed: 1 }, 0)).toBeNull();
    expect(guardDecision(limits, { cost: 0.01, allowed: 1, unknown: true }, 0)).toBe(
      "cost-unknown",
    );
    expect(guardDecision(limits, { cost: 0.15, allowed: 1 }, 0)).toBe("wrap-up-cost");
    expect(guardDecision(limits, { cost: 0.21, allowed: 1 }, 0)).toBe("cost-limit");
    expect(guardDecision(limits, { cost: 0, allowed: 1 }, 1000)).toBe("wrap-up-time");
    expect(guardDecision(limits, { cost: 0, allowed: 1 }, 2000)).toBe("timeout");
    expect(guardDecision({ totalUsd: 1, stopAfterRequests: 2 }, { cost: 0, allowed: 2 }, 0)).toBe(
      "request-limit",
    );
  });

  it("[I-77] lets the wrap-up turn through with only a total line", () => {
    const wrapUpLimits = { totalUsd: 0.2, deadlineAt: 2000 };
    expect(guardDecision(wrapUpLimits, { cost: 0.16, allowed: 0 }, 1500)).toBeNull();
  });

  it("[I-77] keeps earlier costs when compaction drops those messages from later requests", () => {
    const ledger = new Map();
    noteCost(ledger, { role: "assistant", id: "a", cost: 0.05 });
    noteCost(ledger, { role: "assistant", id: "b", cost: 0.04 });
    noteCost(ledger, { role: "assistant", id: "b", cost: 0.06 });
    noteCost(ledger, { role: "assistant", id: "c", cost: -1 });
    noteCost(ledger, { role: "assistant", id: "d", cost: Number.NaN });
    noteCost(ledger, { role: "user", id: "e", cost: 9 });
    expect(ledgerTotal(ledger)).toBeCloseTo(0.11);
    noteCost(ledger, { role: "assistant", id: "a", cost: 0.05, time: { completed: 1 } });
    expect(completedCount(ledger)).toBe(1);
  });

  it("[I-77] counts only this process's own steps as completed, and treats an unreadable cost as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-guard-unit-"));
    const saved = process.env.HIMAWARI_SPEND_GUARD;
    try {
      const markerPath = join(dir, "marker.json");
      writeFileSync(
        join(dir, "limits.json"),
        JSON.stringify({ markerPath, totalUsd: 1, deadlineAt: Date.now() + 60000 }),
      );
      process.env.HIMAWARI_SPEND_GUARD = join(dir, "limits.json");
      const guard = await SpendGuard();
      const done = (id, cost) => ({
        info: { role: "assistant", id, cost, time: { completed: 1 } },
        parts: [],
      });
      await guard["experimental.chat.messages.transform"](
        {},
        { messages: [done("a", 0.1), done("b", 0.1)] },
      );
      await guard["chat.params"]({ agent: "build" });
      const read = () => JSON.parse(readFileSync(markerPath, "utf8"));
      expect(read()).toMatchObject({ allowed: 1, completed: 0, totalCostUsd: 0.2 });
      await guard.event({
        event: { type: "message.updated", properties: { info: done("c", 0.01).info } },
      });
      expect(read()).toMatchObject({ allowed: 1, completed: 1 });
      await guard["experimental.chat.messages.transform"](
        {},
        { messages: [done("d", Number.NaN)] },
      );
      await expect(guard["chat.params"]({ agent: "build" })).rejects.toThrow("cost-unknown");
      expect(read().reason).toBe("cost-unknown");
    } finally {
      if (saved === undefined) delete process.env.HIMAWARI_SPEND_GUARD;
      else process.env.HIMAWARI_SPEND_GUARD = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[I-77] adds the money the parent already counted when the resumed history no longer shows it", () => {
    const limits = { startingUsd: 0.16 };
    expect(effectiveCost(limits, { baselineCost: 0.05 }, 0.05)).toBe(0.16);
    expect(effectiveCost(limits, { baselineCost: 0.05 }, 0.07)).toBeCloseTo(0.18);
    expect(effectiveCost({}, { baselineCost: 0.05 }, 0.07)).toBe(0.07);
    expect(effectiveCost(limits, { baselineCost: 0.2 }, 0.2)).toBe(0.2);
  });

  it("[I-77] starts the guard's count at the money the parent already recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-guard-start-"));
    const saved = process.env.HIMAWARI_SPEND_GUARD;
    try {
      const run = async (startingUsd) => {
        const markerPath = join(dir, `marker-${startingUsd}.json`);
        writeFileSync(
          join(dir, "limits.json"),
          JSON.stringify({
            markerPath,
            totalUsd: 0.2,
            startingUsd,
            deadlineAt: Date.now() + 60000,
          }),
        );
        process.env.HIMAWARI_SPEND_GUARD = join(dir, "limits.json");
        const guard = await SpendGuard();
        await guard["experimental.chat.messages.transform"]({}, { messages: [] });
        const verdict = guard["chat.params"]({ agent: "build" });
        return { verdict, read: () => JSON.parse(readFileSync(markerPath, "utf8")) };
      };
      const open = await run(0.1);
      await open.verdict;
      expect(open.read()).toMatchObject({ allowed: 1, totalCostUsd: 0.1 });
      const over = await run(0.21);
      await expect(over.verdict).rejects.toThrow("cost-limit");
      expect(over.read()).toMatchObject({ allowed: 0, reason: "cost-limit" });
    } finally {
      if (saved === undefined) delete process.env.HIMAWARI_SPEND_GUARD;
      else process.env.HIMAWARI_SPEND_GUARD = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[I-77] does nothing without limits, so a missing plugin file is caught by the self-check", async () => {
    const saved = process.env.HIMAWARI_SPEND_GUARD;
    delete process.env.HIMAWARI_SPEND_GUARD;
    try {
      expect(await SpendGuard()).toEqual({});
    } finally {
      if (saved !== undefined) process.env.HIMAWARI_SPEND_GUARD = saved;
    }
  });
});
