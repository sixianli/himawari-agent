import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
  installGitGuard,
  killProcessGroup,
  MIN_OUTPUT_TOKENS,
  nextRound,
  opencodeBinary,
  parseArgs,
  prepareCopy,
  probePlan,
  probeRefused,
  QUESTIONS_PATH,
  questionsSource,
  REVIEW_MODELS,
  RULE_16_SENTENCE,
  readUsage,
  roundsOnDisk,
  resolveCommits,
  reviewConfig,
  reviewModel,
  reviewQuestions,
  runOutcome,
  SHELL_LOG_NAME,
  spentOf,
  summarizeEvents,
  WRAP_UP_MIN_USD,
  WRAP_UP_PROMPT,
  WRAP_UP_RESERVE_USD,
  wrapUpReason,
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

  it("requires a base commit for code review", () => {
    expect(() => parseArgs(["--head", "a", "--brief", "b.md", "--out", "o"])).toThrow(
      "ARG_REQUIRED --base",
    );
    expect(parseArgs(["--mode", "plan", "--head", "a", "--brief", "b.md", "--out", "o"]).mode).toBe(
      "plan",
    );
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
      ["read", "read", "grep", "grep", "glob"],
    );
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
  it("kills the commands opencode started, not only opencode itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-kill-"));
    const pidFile = join(dir, "grandchild.pid");
    const child = spawn("sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise((resolveExit) => child.on("exit", resolveExit));
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "")
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(killProcessGroup(child, "SIGKILL")).toBe(true);
    await exited;
    const state = () =>
      existsSync(`/proc/${grandchild}/stat`)
        ? readFileSync(`/proc/${grandchild}/stat`, "utf8").split(") ")[1]?.[0]
        : "gone";
    for (let attempt = 0; attempt < 100 && !["Z", "X", "gone"].includes(state()); attempt += 1)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(["Z", "X", "gone"]).toContain(state());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("opencode review installed guard", () => {
  it("runs the model's commands in restricted bash with the git guard in front", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-guard-"));
    try {
      const copy = join(root, "repo");
      execFileSync("git", ["clone", "--quiet", "--depth", "3", `file://${process.cwd()}`, copy]);
      const guard = installGitGuard(root);
      const canary = `CANARY_${randomBytes(8).toString("hex")}`;
      const env = {
        ...process.env,
        PATH: `${guard.binDir}:${process.env.PATH}`,
        REVIEW_TEST_CANARY: canary,
      };
      const viaShell = (command) => {
        const result = spawnSync(guard.shell, ["-c", command], {
          cwd: copy,
          env,
          encoding: "utf8",
        });
        return { status: result.status, text: result.stdout + result.stderr };
      };
      expect(viaShell('git log -1 "--output=../written.txt"').text).toContain(GIT_REFUSED);
      expect(viaShell("git log -1 --oneline > written.txt").text).toContain("restricted");
      expect(viaShell(`cd ${root}`).text).toContain("restricted");
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
      expect(readFileSync(join(root, SHELL_LOG_NAME), "utf8").trim().split("\n").length).toBe(6);
      const allowed = viaShell("git log -1 --format=%H");
      expect(allowed.status).toBe(0);
      expect(allowed.text.trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

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
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", ...GIT_ENV });
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
      expect(run(["reflog", "--all"], copy)).toBe("");
      expect(existsSync(join(copy, ".git", "FETCH_HEAD"))).toBe(false);
      expect(run(["log", "-1", "--format=%s", base], copy)).toBe("base");
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

function startScriptedModel(reply) {
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
      if (main) requests.push(parsed);
      const send = (payload) =>
        response.write(
          `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: parsed.model, ...payload })}\n\n`,
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      const step = main ? reply(parsed, requests.length) : { text: "title" };
      const delta = { role: "assistant" };
      if (step.thinking) delta.reasoning_content = step.thinking;
      if (step.text) delta.content = step.text;
      if (step.tool)
        delta.tool_calls = [
          {
            index: 0,
            id: `call-${requests.length}`,
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
    });
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, requests, port: server.address().port }),
    ),
  );
}

async function withScriptedReview(reply, run) {
  const root = mkdtempSync(join(tmpdir(), "opencode-wrap-"));
  const { server, requests, port } = await startScriptedModel(reply);
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
    return await run({ review, requests });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
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

  it("gives the wrap-up turn a single step and the same tools as the review", () => {
    const config = reviewConfig({ mode: "plan", wrapUp: true });
    expect(config.agent).toEqual({ build: { steps: 1 } });
    expect(config.permission).toEqual(reviewConfig({ mode: "plan" }).permission);
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
      async ({ review }) => {
        const result = await review({ timeoutMs: 90000 });
        expect(result.wrapUp).toBe("time");
        expect(result.outcome).toBe("ok");
        expect(result.summary.text).toBe("TIME_WRAPPED");
      },
    );
  }, 120000);

  it("stops the wrap-up turn at its first tool call instead of letting it keep reading", async () => {
    await withScriptedReview(
      (_request, index) =>
        index === 1 ? { thinking: "THOUGHT_ONLY" } : { tool: true, promptTokens: 100000 },
      async ({ review, requests }) => {
        const result = await review();
        expect(result.wrapUp).toBe("no-text");
        expect(result.outcome).toBe("wrap-up-tool-call");
        expect(requests.filter(isWrapUp)).toHaveLength(1);
        expect(result.summary.usage.cost).toBeGreaterThan(0.01);
      },
    );
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
      ]) {
        writeFileSync(join(dir, "usage.jsonl"), `${bad}\n`);
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

  it("numbers rounds from what the folder already holds", () => {
    expect(nextRound([])).toBe(1);
    expect(nextRound([record(0.1, 1), record(0.1, 1), record(0.1, 2)])).toBe(3);
    expect(nextRound([{ cost: 0.1 }])).toBe(2);
  });

  it("reruns only the models asked for", () => {
    const base = ["--mode", "plan", "--head", "a", "--brief", "b.md", "--out", "o"];
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
