import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_READ_COMMANDS,
  MIN_OUTPUT_TOKENS,
  RULE_16_SENTENCE,
  buildPrompt,
  checkProbeRequests,
  expectedTools,
  parseArgs,
  prepareCopy,
  resolveCommits,
  reviewConfig,
  reviewQuestions,
  summarizeEvents,
} from "../../scripts/model-review/opencode-review.mjs";

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
    for (const command of GIT_READ_COMMANDS)
      expect(config.permission.bash[`${command}*`]).toBe("allow");
    expect(config.permission.bash["* --output*"]).toBe("deny");
    expect(config.permission.bash["* -o*"]).toBe("deny");
    expect(config.permission.read["*.env"]).toBe("deny");
    expect(config.provider["opencode-go"].options.baseURL).toBeUndefined();
  });

  it("opens webfetch only for plan discussions", () => {
    expect(reviewConfig({ mode: "discussion" }).permission.webfetch).toBe("allow");
    expect(expectedTools("discussion")).toEqual(["bash", "glob", "grep", "read", "webfetch"]);
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

  it("refuses an empty brief", () => {
    expect(() =>
      buildPrompt({ mode: "code-review", questions: ["q"], head: "a", base: "b", brief: "  " }),
    ).toThrow("BRIEF_EMPTY");
  });

  it("requires a base commit for code review", () => {
    expect(() => parseArgs(["--head", "a", "--brief", "b.md", "--out", "o"])).toThrow(
      "ARG_REQUIRED --base",
    );
    expect(
      parseArgs(["--mode", "discussion", "--head", "a", "--brief", "b.md", "--out", "o"]).mode,
    ).toBe("discussion");
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
});

describe("opencode review self-check", () => {
  const refused = [{ tool: "bash", status: "error" }];

  it("passes a request with the read-only tools, a raised output limit and high reasoning", () => {
    const requests = [{ model: "x", messages: [] }, toolRequest(["bash", "glob", "grep", "read"])];
    expect(
      checkProbeRequests({
        mode: "code-review",
        requests,
        probeWritten: false,
        toolCalls: refused,
      }),
    ).toEqual([]);
  });

  it("fails the request opencode sent with the old configuration", () => {
    const requests = [
      toolRequest(["glob", "grep", "read", "skill", "task", "todowrite", "websearch"], {
        max_tokens: 32000,
      }),
    ];
    const problems = checkProbeRequests({
      mode: "code-review",
      requests,
      probeWritten: false,
      toolCalls: refused,
    });
    expect(problems.some((problem) => problem.startsWith("PROBE_TOOLS_UNEXPECTED"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("PROBE_OUTPUT_CAP"))).toBe(true);
  });

  it("fails when reasoning is not high or the output limit is below the minimum", () => {
    const requests = [
      toolRequest(["bash", "glob", "grep", "read"], {
        reasoning_effort: "low",
        max_tokens: MIN_OUTPUT_TOKENS - 1,
      }),
    ];
    const problems = checkProbeRequests({
      mode: "code-review",
      requests,
      probeWritten: false,
      toolCalls: refused,
    });
    expect(problems).toEqual([
      "PROBE_OUTPUT_CAP deepseek-v4.1-flash 99999",
      "PROBE_REASONING deepseek-v4.1-flash low",
    ]);
  });

  it("fails when git wrote a file or the write was not refused", () => {
    const requests = [toolRequest(["bash", "glob", "grep", "read"])];
    expect(
      checkProbeRequests({ mode: "code-review", requests, probeWritten: true, toolCalls: [] }),
    ).toEqual(["PROBE_GIT_OUTPUT_WROTE_FILE", "PROBE_GIT_OUTPUT_NOT_REFUSED"]);
  });

  it("fails when no request carried tools", () => {
    expect(
      checkProbeRequests({
        mode: "code-review",
        requests: [],
        probeWritten: false,
        toolCalls: refused,
      }),
    ).toEqual(["PROBE_NO_TOOL_REQUEST"]);
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
      run([
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "head",
      ]);
      const head = run(["rev-parse", "HEAD"]);
      run(["update-ref", "refs/remotes/origin/feature", head]);
      run(["reset", "--quiet", "--hard", base]);
      const commits = resolveCommits(source, { head: "origin/feature", base: "main" });
      expect(commits).toEqual({ head, base, previous: undefined });
      const copy = join(root, "copy");
      prepareCopy({ repo: source, copy, commits, workRoot: root });
      expect(run(["rev-parse", "HEAD"], copy)).toBe(head);
      expect(run(["remote"], copy)).toBe("");
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
