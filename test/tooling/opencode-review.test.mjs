import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  COST_LIMIT_PER_MODEL_USD,
  checkGitArgs,
  checkProbeRequests,
  expectedTools,
  GIT_READ_COMMANDS,
  GIT_REFUSED,
  MIN_OUTPUT_TOKENS,
  parseArgs,
  prepareCopy,
  probePlan,
  probeRefused,
  RULE_16_SENTENCE,
  resolveCommits,
  reviewConfig,
  reviewQuestions,
  runOutcome,
  summarizeEvents,
} from "../../scripts/model-review/opencode-review.mjs";

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
      ["read", "grep", "glob"],
    );
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
      "PROBE_WROTE_FILE /work/probe-redirect",
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

  it("counts the git guard's refusal as refused", () => {
    expect(probeRefused({ status: "completed", output: `${GIT_REFUSED} --output\n` })).toBe(true);
    expect(probeRefused({ status: "completed", output: "abc123 commit" })).toBe(false);
  });

  it("fails when everything is blocked, so a deny-all config cannot pass", () => {
    const calls = passingCalls();
    calls[0] = { ...calls[0], status: "error", output: "denied" };
    expect(check({ toolCalls: calls })).toEqual([
      "PROBE_READ_COMMAND_BLOCKED bash git log -1 --oneline",
    ]);
  });

  it("fails when a probe did not run or no request carried tools", () => {
    const calls = passingCalls();
    const missing = plan.probes[plan.probes.length - 1];
    expect(check({ toolCalls: calls.slice(0, -1) })).toEqual([`PROBE_NOT_RUN ${label(missing)}`]);
    expect(check({ requests: [] })).toEqual(["PROBE_NO_TOOL_REQUEST"]);
  });
});

describe("opencode review git guard", () => {
  it("lets the five read subcommands through with ordinary options", () => {
    expect(checkGitArgs(["diff", "--stat", "origin/main", "HEAD"])).toBeNull();
    expect(checkGitArgs(["log", "-5", "--oneline"])).toBeNull();
    expect(checkGitArgs(["show", "HEAD:AGENTS.md"])).toBeNull();
    expect(checkGitArgs(["diff", "HEAD", "--", "--output"])).toBeNull();
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
          "--out",
          "o",
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
