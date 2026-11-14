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
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readGatewayConfig } from "../../scripts/model-review/gateway.mjs";
import {
  API_ERROR_MESSAGE_MAX,
  apiErrorText,
  buildPrompt,
  COST_LIMIT_PER_MODEL_USD,
  checkGitArgs,
  checkProbeRequests,
  DEFAULT_REVIEW_MODELS,
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
  killProcessGroup,
  MIN_OUTPUT_TOKENS,
  MODEL_LENSES,
  MODEL_OUTPUT_LIMITS,
  OPENCODE_KEPT_ENV,
  OPENCODE_LOCK_DIR,
  OPENCODE_VERSION,
  opencodeChildEnv,
  opencodeEnv,
  opencodeInstallDir,
  parseArgs,
  prepareCopy,
  prepareRawDir,
  printable,
  probePlan,
  probeRefused,
  promptFileName,
  QUESTIONS_PATH,
  questionsSource,
  SELF_CHECK_CACHE_ENV,
  SELF_CHECK_CACHE_MAX_AGE_MS,
  selfCheckCacheDir,
  selfCheckCacheHit,
  selfCheckCacheKey,
  selfCheckCacheWrite,
  REVIEW_MODELS,
  REVIEW_PARENT_CANARY_ENV,
  REVIEWS_DIR,
  RULE_16_SENTENCE,
  rawDir,
  readReviewModels,
  recordText,
  resolveCommits,
  retryAfterApiError,
  reviewConfig,
  reviewDir,
  reviewModel,
  reviewModelsProblems,
  reviewQuestions,
  runOutcome,
  SHELL_LOG_NAME,
  SUBSTITUTES,
  spentOf,
  substituteFor,
  summarizeEvents,
  WRAP_UP_PROMPT,
  WRAP_UP_RESERVE_USD,
  wrapUpReason,
} from "../../scripts/model-review/opencode-review.mjs";
import { GUARD_ENV } from "../../scripts/model-review/spend-guard.mjs";
import {
  expectAppendedTo,
  firstChangedMessage,
  instructions,
  isWrapUp,
  lstatExists,
  processState,
  slowStepFinishBinary,
  toolRequest,
  withScriptedReview,
} from "./opencode-review.fixtures.mjs";

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

describe("opencode review model list", () => {
  const valid = {
    allowed: ["a/one", "a/two"],
    default: ["a/one"],
    substitutes: { "a/one": "a/two" },
    lowDeferFromRound: 3,
  };
  const changed = (change) => Object.assign({}, valid, change);

  it("[review models] reads the allowed, default and substitute models from the committed file", () => {
    const config = readReviewModels();
    expect(REVIEW_MODELS).toEqual(config.allowed);
    expect(DEFAULT_REVIEW_MODELS).toEqual(config.default);
    expect(SUBSTITUTES).toEqual(config.substitutes);
    expect(DEFAULT_REVIEW_MODELS).toEqual(["opencode-go/deepseek-v4.1-flash"]);
    for (const model of REVIEW_MODELS) {
      const name = model.split("/").pop();
      expect(MODEL_LENSES[name]).toEqual(expect.any(String));
      expect(MODEL_OUTPUT_LIMITS[name]).toEqual(expect.any(Number));
      expect(readGatewayConfig(undefined, REVIEW_MODELS).models[model]).toBeDefined();
    }
    expect(reviewModelsProblems(valid)).toEqual([]);
    expect(reviewModelsProblems(changed({ default: valid.allowed, substitutes: {} }))).toEqual([]);
  });

  it("[review models] refuses a list that is empty, repeats, or names a model outside the allowed ones", () => {
    const bad = [
      [changed({ allowed: [] }), "allowed"],
      [changed({ allowed: ["a/one", "a/one"] }), "allowed"],
      [changed({ allowed: ["a/one", "b/one"], substitutes: {} }), "allowed.short-name-repeats"],
      [changed({ allowed: ["one"] }), "allowed"],
      [changed({ default: [] }), "default"],
      [changed({ default: ["a/three"] }), "default"],
      [changed({ default: "a/one" }), "default"],
      [changed({ substitutes: { "a/one": "a/three" } }), "substitutes"],
      [changed({ substitutes: { "a/one": "a/one" } }), "substitutes"],
      [changed({ substitutes: undefined }), "substitutes"],
      [changed({ lowDeferFromRound: undefined }), "lowDeferFromRound"],
      [changed({ lowDeferFromRound: 1 }), "lowDeferFromRound"],
      [changed({ lowDeferFromRound: "3" }), "lowDeferFromRound"],
      [null, "allowed"],
    ];
    for (const [config, problem] of bad) expect(reviewModelsProblems(config)).toContain(problem);
    const dir = mkdtempSync(join(tmpdir(), "review-models-"));
    try {
      const path = join(dir, "review-models.json");
      expect(() => readReviewModels(path)).toThrow("REVIEW_MODELS_CONFIG_INVALID unreadable");
      writeFileSync(path, JSON.stringify(changed({ default: [] })));
      expect(() => readReviewModels(path)).toThrow("REVIEW_MODELS_CONFIG_INVALID default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("[substitute] lets GLM take a code-review round, the first included, only when DeepSeek's service refused", () => {
    expect(SUBSTITUTES).toEqual({ [deepseek]: glm });
    for (const options of [later, { ...later, previous: undefined }])
      expect(substituteFor({ ...options, runs: [run("api-error", busy)] })).toEqual({
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

describe("opencode review process cleanup", () => {
  it("reads a process that disappears mid-read as gone and keeps other errors", () => {
    const failing = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const linux = (read) => processState(42, { platform: "linux", read });
    expect(linux(() => "42 (sleep) S 1 42")).toBe("S");
    expect(linux(failing("ENOENT"))).toBe("gone");
    expect(linux(failing("ESRCH"))).toBe("gone");
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

  it("[opencode lock] two processes installing into the same fresh prefix both end up with a working binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-install-race-"));
    try {
      const prefix = join(root, "shared");
      const script = fileURLToPath(
        new URL("../../scripts/model-review/opencode-review.mjs", import.meta.url),
      );
      const runOne = () =>
        new Promise((resolveRun) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import { installOpencode } from ${JSON.stringify(pathToFileURL(script).href)}; console.log(installOpencode({ prefix: ${JSON.stringify(prefix)} }));`,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk) => {
            out += chunk;
          });
          child.stderr.on("data", (chunk) => {
            err += chunk;
          });
          child.on("close", (status) => resolveRun({ status, out: out.trim(), err }));
        });
      const [first, second] = await Promise.all([runOne(), runOne()]);
      expect([
        first.status,
        second.status,
        first.err.includes("OPENCODE_INSTALL_FAILED"),
        second.err.includes("OPENCODE_INSTALL_FAILED"),
      ]).toEqual([0, 0, false, false]);
      const binary = join(prefix, "node_modules", ".bin", "opencode");
      expect([first.out, second.out]).toEqual([binary, binary]);
      expect(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()).toBe(
        OPENCODE_VERSION,
      );
      expect(readdirSync(root)).toEqual(["shared"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300000);

  it("[opencode lock] two processes healing the same leftover prefix both end up with a working binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-install-heal-race-"));
    try {
      const prefix = join(root, "shared");
      mkdirSync(join(prefix, "node_modules"), { recursive: true });
      writeFileSync(join(prefix, "node_modules", "partial"), "half-installed");
      const script = pathToFileURL(
        fileURLToPath(new URL("../../scripts/model-review/opencode-review.mjs", import.meta.url)),
      ).href;
      const code = `import { installOpencode } from ${JSON.stringify(script)}; installOpencode({ prefix: ${JSON.stringify(prefix)} });`;
      const run = () =>
        new Promise((done) => {
          spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" }).on(
            "close",
            done,
          );
        });
      expect(await Promise.all([run(), run()])).toEqual([0, 0]);
      expect(readdirSync(root)).toEqual(["shared"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300000);

  it("[opencode lock] a leftover non-empty prefix without a binary is replaced by a fresh install", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-install-leftover-"));
    try {
      const prefix = join(root, "shared");
      mkdirSync(join(prefix, "node_modules"), { recursive: true });
      writeFileSync(join(prefix, "node_modules", "partial"), "half-installed");
      const binary = installOpencode({ prefix });
      expect(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()).toBe(
        OPENCODE_VERSION,
      );
      expect(readdirSync(root)).toEqual(["shared"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300000);

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

  it("[self-check cache] only a pass for the same code, binary, mode and tools counts, and it expires", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-selfcheck-cache-"));
    try {
      const binary = join(root, "opencode");
      writeFileSync(binary, "#!/bin/sh\necho one\n");
      const env = { [SELF_CHECK_CACHE_ENV]: join(root, "cache") };
      const key = selfCheckCacheKey({ binary, mode: "code-review", gateway: null });
      expect(selfCheckCacheKey({ binary, mode: "code-review", gateway: null })).toBe(key);
      expect(selfCheckCacheHit({ key, env })).toBe(false);
      selfCheckCacheWrite({ key, now: 1000, env });
      expect(selfCheckCacheHit({ key, now: 1000, env })).toBe(true);
      expect(selfCheckCacheHit({ key, now: 1000 + SELF_CHECK_CACHE_MAX_AGE_MS - 1, env })).toBe(
        true,
      );
      expect(selfCheckCacheHit({ key, now: 1000 + SELF_CHECK_CACHE_MAX_AGE_MS, env })).toBe(false);
      expect(selfCheckCacheHit({ key, now: 500, env })).toBe(false);
      expect(selfCheckCacheKey({ binary, mode: "plan", gateway: null })).not.toBe(key);
      writeFileSync(binary, "#!/bin/sh\necho two\n");
      const changed = selfCheckCacheKey({ binary, mode: "code-review", gateway: null });
      expect(changed).not.toBe(key);
      expect(selfCheckCacheHit({ key: changed, now: 1000, env })).toBe(false);
      writeFileSync(join(root, "cache", `${key}.json`), "not json");
      expect(selfCheckCacheHit({ key, now: 1000, env })).toBe(false);
      writeFileSync(join(root, "cache", `${key}.json`), JSON.stringify({ key: "x", at: 1000 }));
      expect(selfCheckCacheHit({ key, now: 1000, env })).toBe(false);
      expect(selfCheckCacheDir({ [SELF_CHECK_CACHE_ENV]: "off" })).toBeNull();
      selfCheckCacheWrite({ key: "k".repeat(64), env: { [SELF_CHECK_CACHE_ENV]: "off" } });
      expect(selfCheckCacheHit({ key, now: 1000, env: { [SELF_CHECK_CACHE_ENV]: "off" } })).toBe(
        false,
      );
      expect(selfCheckCacheDir({})).toMatch(/himawari-review-selfcheck$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
});

describe("opencode review wrap-up", () => {
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
});

describe("append-only failure message", () => {
  it("points at the first differing character, even deep inside a long message", () => {
    const long = "x".repeat(5000);
    const earlier = {
      messages: [
        { role: "user", content: "a" },
        { role: "tool", content: `${long}OLD` },
      ],
    };
    const later = {
      messages: [
        { role: "user", content: "a" },
        { role: "tool", content: `${long}NEW` },
        { role: "user", content: "b" },
      ],
    };
    const message = firstChangedMessage(earlier, later);
    expect(message).toContain("message 1 of 2 changed (later request has 3)");
    expect(message).toContain("first difference at character 5026");
    expect(message).toContain("OLD");
    expect(message).toContain("NEW");
    expect(
      firstChangedMessage(earlier, { messages: [...earlier.messages, { role: "user" }] }),
    ).toBe("");
  });
});
