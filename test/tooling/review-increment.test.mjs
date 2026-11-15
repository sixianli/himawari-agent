import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INCREMENT_BEGIN,
  INCREMENT_CONFIG_PATH,
  INCREMENT_END,
  incrementRecordValid,
  parseIncrementConfig,
  shadowCommand,
  shadowRunsDone,
  toolSummary,
  toolSummaryValid,
} from "../../scripts/model-review/increment.mjs";
import {
  budgetCheck,
  buildPrompt,
  dailySpend,
  linkedLedgerRecords,
  parseArgs,
  parseUsage,
  planIncrement,
  rawDir,
  resultLine,
  reviewQuestions,
  withIncrement,
} from "../../scripts/model-review/opencode-review.mjs";
import {
  backfillIncrements,
  bucketLabel,
  bucketStats,
  renderCsv,
} from "../../scripts/model-review/review-speed-report.mjs";
import { instructions } from "./opencode-review.fixtures.mjs";

const config = parseIncrementConfig(readFileSync(INCREMENT_CONFIG_PATH, "utf8"));
const ledgerPath = ".agents/reviews/pr-9";

function sandbox(run) {
  const root = mkdtempSync(join(tmpdir(), "review-increment-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  const write = (file, text) => {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet", "-b", "main");
    write("shared.txt", "one\ntwo\nthree\n");
    write("main-only.txt", "m1\n");
    const root0 = commit("root");
    git("checkout", "--quiet", "-b", "pr");
    write("pr.txt", "a\n");
    const previous = commit("pr first");
    return run({ repo, git, write, commit, root0, previous });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const plan = (repo, previous, head, extra = {}) =>
  planIncrement({
    repo,
    commits: { previous, head, base: previous },
    config,
    ledgerPath,
    promptBytes: 10000,
    mainRef: "main",
    ...extra,
  });

describe("increment config", () => {
  it("the checked-in config passes its own validation", () => {
    expect(config.shadowFullTotal).toBe(10);
    expect(config.reportBucketLines.length).toBeGreaterThan(0);
  });

  it("refuses wrong types, out-of-range values, unknown keys and unsorted buckets", () => {
    const good = JSON.parse(readFileSync(INCREMENT_CONFIG_PATH, "utf8"));
    const bad = [
      ["{", "json"],
      ["[]", "shape"],
      [JSON.stringify({ ...good, extra: 1 }), "unknown-key extra"],
      [JSON.stringify({ ...good, contextLines: -1 }), "contextLines"],
      [JSON.stringify({ ...good, inlineDiffMaxBytes: 95000 }), "inlineDiffMaxBytes"],
      [JSON.stringify({ ...good, maxFilesListed: "200" }), "maxFilesListed"],
      [JSON.stringify({ ...good, shadowFullTotal: 1.5 }), "shadowFullTotal"],
      [JSON.stringify({ ...good, reportBucketLines: [100, 30] }), "reportBucketLines"],
      [JSON.stringify({ ...good, reportBucketLines: [] }), "reportBucketLines"],
    ];
    for (const [text, reason] of bad)
      expect(() => parseIncrementConfig(text)).toThrow(`INCREMENT_CONFIG_INVALID ${reason}`);
  });
});

describe("increment scope from real git history", () => {
  it("[ADR 0280] gives the model only the PR's own change, not what merging main brought in", () => {
    sandbox(({ repo, git, write, commit, previous }) => {
      git("checkout", "--quiet", "main");
      write("main-only.txt", "m1\nm2 from main\n");
      for (let index = 0; index < 50; index += 1) write(`main/${index}.txt`, `main ${index}\n`);
      commit("main moves");
      git("checkout", "--quiet", "pr");
      git("merge", "--quiet", "--no-edit", "main");
      write("pr.txt", "a\nb own change\n");
      const head = commit("pr second");
      const planned = plan(repo, previous, head);
      expect(planned.record).toMatchObject({
        fallback: null,
        files: 1,
        lines: 1,
        merged: true,
        binary: 0,
        mainOverlap: 0,
        truncated: false,
      });
      expect(planned.record.rawLines).toBeGreaterThan(50);
      expect(planned.block.startsWith(INCREMENT_BEGIN)).toBe(true);
      expect(planned.block.endsWith(INCREMENT_END)).toBe(true);
      expect(planned.block).toContain("+b own change");
      expect(planned.block).not.toContain("m2 from main");
      expect(planned.block).not.toContain("main/1.txt");
      expect(plan(repo, previous, head).block).toBe(planned.block);
    });
  });

  it("[ADR 0280] a round that only merged main is empty and spends nothing", () => {
    sandbox(({ repo, git, write, commit, previous }) => {
      git("checkout", "--quiet", "main");
      write("main-only.txt", "m1\nm2\n");
      commit("main moves");
      git("checkout", "--quiet", "pr");
      git("merge", "--quiet", "--no-edit", "main");
      const head = git("rev-parse", "HEAD");
      expect(plan(repo, previous, head)).toEqual({ empty: true });
    });
  });

  it("[ADR 0280] keeps what was written by hand to resolve a merge conflict, and shows main's side separately", () => {
    sandbox(({ repo, git, write, commit }) => {
      git("checkout", "--quiet", "main");
      write("shared.txt", "one\nTWO main\nthree\n");
      commit("main edits shared");
      git("checkout", "--quiet", "pr");
      write("shared.txt", "one\ntwo pr\nthree\n");
      const reviewed = commit("pr edits shared");
      spawnSync("git", ["merge", "--quiet", "--no-edit", "main"], { cwd: repo });
      write("shared.txt", "one\ntwo resolved by hand\nthree\n");
      const head = commit("merge main by hand");
      const planned = plan(repo, reviewed, head);
      expect(planned.record.files).toBe(1);
      expect(planned.record.mainOverlap).toBe(1);
      expect(planned.block).toContain("+two resolved by hand");
      expect(planned.block).toContain("main 自己对 shared.txt 的改动");
      expect(planned.block).toContain("+TWO main");
    });
  });

  it("[ADR 0280] lists binary files by git's own judgement and never inlines their bytes", () => {
    sandbox(({ repo, write, commit, previous }) => {
      writeFileSync(join(repo, "picture.txt"), Buffer.from([0, 1, 2, 0, 255, 0]));
      write("pr.txt", "a\nb\n");
      const head = commit("binary with a text name");
      const planned = plan(repo, previous, head);
      expect(planned.record.binary).toBe(1);
      expect(planned.block).toContain("模型看不了内容的二进制文件");
      expect(planned.block).toContain("picture.txt");
      expect(planned.block).not.toContain("Binary files");
    });
  });

  it("[ADR 0280] truncates whole files to fit the prompt limit and says how to fetch the rest", () => {
    sandbox(({ repo, write, commit, previous }) => {
      for (let index = 0; index < 6; index += 1)
        write(`big-${index}.txt`, `${"x".repeat(80)}\n`.repeat(200));
      const head = commit("big change");
      const planned = plan(repo, previous, head, { promptBytes: 100000 - 40000 });
      expect(planned.record.truncated).toBe(true);
      expect(Buffer.byteLength(planned.block)).toBeLessThanOrEqual(40000 - 1);
      expect(planned.block).toContain("已截断");
      expect(planned.block).toContain(`git diff ${previous}..${head} -- <文件>`);
      const inlined = planned.block.split("\n").filter((line) => line.startsWith("+++ b/")).length;
      expect(inlined).toBeGreaterThan(0);
      expect(inlined).toBeLessThan(6);
    });
  });

  it("[ADR 0280] falls back to the old full-range review instead of silently reviewing less", () => {
    sandbox(({ repo, write, commit, previous }) => {
      write("pr.txt", "a\nb\n");
      const head = commit("change");
      expect(plan(repo, previous, head, { config: null })).toEqual({
        record: { fallback: "config-missing" },
        block: null,
      });
      expect(plan(repo, previous, head, { mainRef: "no-such-ref" }).record.fallback).toBe(
        "main-ref-missing",
      );
      expect(plan(repo, previous, head, { promptBytes: 99990 }).record.fallback).toBe("too-large");
    });
  });

  it("[ADR 0280] falls back when main and the PR share no merge base", () => {
    sandbox(({ repo, git, write, commit, previous }) => {
      git("checkout", "--quiet", "--orphan", "unrelated");
      git("rm", "-rq", "--cached", ".");
      write("other.txt", "x\n");
      git("add", "other.txt");
      git("commit", "--quiet", "-m", "unrelated root");
      git("checkout", "--quiet", "-f", "pr");
      write("pr.txt", "a\nb\n");
      const head = commit("change");
      expect(plan(repo, previous, head, { mainRef: "unrelated" }).record.fallback).toBe(
        "merge-base-failed",
      );
    });
  });

  it("[ADR 0280] inlines every file that fits once the truncation list shrinks", () => {
    sandbox(({ repo, write, commit, previous }) => {
      for (let index = 0; index < 3; index += 1)
        write(`mid-${index}.txt`, `${"y".repeat(60)}\n`.repeat(15));
      const head = commit("three files");
      const full = plan(repo, previous, head);
      expect(full.record.truncated).toBe(false);
      const tight = plan(repo, previous, head, {
        promptBytes: 100000 - 1 - Buffer.byteLength(full.block),
      });
      expect(tight.record.truncated).toBe(false);
      expect(tight.block).toBe(full.block);
    });
  });

  it("[ADR 0280] leaves plan-claims records out of the increment like the merge check does", () => {
    sandbox(({ repo, write, commit, previous }) => {
      write(".agents/reviews/claims-x/usage.jsonl", "{}\n");
      const head = commit("claims record");
      expect(plan(repo, previous, head).empty).toBeUndefined();
      expect(
        plan(repo, previous, head, {
          skip: () => new Set([".agents/reviews/claims-x/usage.jsonl"]),
        }),
      ).toEqual({ empty: true });
    });
  });

  it("[ADR 0280] falls back instead of failing when the scoped prompt passes the limit", () => {
    const planned = { record: { files: 1 }, block: "B" };
    const prompts = { m: "old" };
    const big = withIncrement({
      planned,
      prompts,
      promptsWith: () => ({ m: "x".repeat(100001) }),
    });
    expect(big).toEqual({ planned: { record: { fallback: "too-large" }, block: null }, prompts });
    const fits = withIncrement({ planned, prompts, promptsWith: () => ({ m: "new" }) });
    expect(fits).toEqual({ planned, prompts: { m: "new" } });
  });
});

describe("increment prompt", () => {
  const questions = reviewQuestions(instructions);
  const base = { mode: "code-review", questions, head: "ccc", base: "ddd", brief: "作者说 B" };

  it("[ADR 0280] keeps the fixed prefix byte for byte and puts the increment after the brief", () => {
    const full = buildPrompt(base);
    const scoped = buildPrompt({
      ...base,
      previous: "eee",
      increment: `${INCREMENT_BEGIN}\nX\n${INCREMENT_END}`,
    });
    const fixedEnd = full.indexOf("---- 本次材料 ----");
    expect(scoped.slice(0, fixedEnd)).toBe(full.slice(0, fixedEnd));
    expect(scoped).not.toContain("git diff ddd..ccc");
    expect(scoped).toContain("“这个改动”指本轮增量加上一轮意见的修复");
    expect(scoped.indexOf("作者说 B")).toBeLessThan(scoped.indexOf(INCREMENT_BEGIN));
    expect(scoped.trimEnd().endsWith(INCREMENT_END)).toBe(true);
  });

  it("[ADR 0280] a fallback round keeps the old wording exactly", () => {
    const old = buildPrompt({ ...base, previous: "eee" });
    expect(buildPrompt({ ...base, previous: "eee", increment: null })).toBe(old);
    expect(old).toContain("先运行 git diff ddd..ccc 看改动");
    expect(old).toContain("这一轮先看 git diff eee..ccc 的增量");
  });
});

describe("increment ledger fields", () => {
  const head = "a".repeat(40);
  const ok = (extra) =>
    JSON.stringify({ mode: "code-review", head, model: "m", outcome: "ok", cost: 0.01, ...extra });
  const increment = {
    fallback: null,
    files: 1,
    lines: 3,
    rawLines: 40,
    binary: 0,
    mainOverlap: 0,
    inlineBytes: 120,
    merged: true,
    truncated: false,
  };
  const summary = { byTool: { grep: 2, read: 3 }, topReads: [["a.mjs", 2]] };

  it("[I-73] accepts well-formed increment, tool summary and shadow fields", () => {
    const records = parseUsage(
      [
        ok({ increment, toolSummary: summary }),
        ok({ increment: { fallback: "config-missing" } }),
        ok({ shadow: true }),
      ].join("\n"),
      "t",
    );
    expect(records).toHaveLength(3);
  });

  it("[I-73] rejects negative counts, wrong types, line breaks and a false shadow flag", () => {
    const bad = [
      { increment: { ...increment, lines: -1 } },
      { increment: { ...increment, merged: "yes" } },
      { increment: { fallback: "Bad Reason" } },
      { increment: [] },
      { toolSummary: { byTool: { read: -1 }, topReads: [] } },
      { toolSummary: { byTool: {}, topReads: [["a\nb", 1]] } },
      { toolSummary: { byTool: {}, topReads: [["a", 0]] } },
      { toolSummary: { byTool: {}, topReads: [["a\u0007", 1]] } },
      { toolSummary: { byTool: { "Bad Tool!": 1 }, topReads: [] } },
      { shadow: false },
    ];
    for (const extra of bad)
      expect(() => parseUsage(ok(extra), "t")).toThrow("USAGE_LEDGER_INVALID");
    expect(incrementRecordValid(undefined)).toBe(true);
    expect(toolSummaryValid(undefined)).toBe(true);
  });

  it("summarises tool calls with a fixed order, a cap and no control characters", () => {
    const calls = [
      { tool: "read", input: { filePath: "/tmp/x/repo/b.mjs" } },
      { tool: "read", input: { filePath: "/tmp/x/repo/a.mjs" } },
      { tool: "read", input: { filePath: "/tmp/x/repo/b.mjs" } },
      { tool: "read", input: { filePath: "/tmp/x/repo/c​\u0007.mjs" } },
      { tool: "grep", input: { pattern: "x" } },
      { tool: "Bad Tool!", input: {} },
    ];
    const result = toolSummary(calls, 2);
    expect(Object.keys(result.byTool)).toEqual(["grep", "other", "read"]);
    expect(result.byTool.read).toBe(4);
    expect(result.topReads).toEqual([
      ["b.mjs", 2],
      ["a.mjs", 1],
    ]);
    expect(toolSummary(calls, 5).topReads.map(([path]) => path)).toContain("c??.mjs");
    expect(toolSummaryValid(result)).toBe(true);
  });

  it("[review report] shows the increment and the shadow mark on each result line", () => {
    const line = resultLine({
      round: 2,
      model: "m",
      outcome: "ok",
      steps: 1,
      input: 1,
      cacheRead: 1,
      output: 1,
      reasoning: 1,
      cost: 0.01,
      increment,
      shadow: true,
    });
    expect(line).toContain("increment=files-1-lines-3");
    expect(line.endsWith(" shadow")).toBe(true);
    expect(
      resultLine({
        round: 2,
        model: "m",
        outcome: "ok",
        cost: 0,
        increment: { fallback: "diff-failed" },
      }),
    ).toContain("increment=fallback-diff-failed");
  });
});

describe("shadow full review", () => {
  const args = ["--head", "a", "--base", "b", "--brief", "b.md", "--pr", "7"];

  it("[ADR 0280] writes outside the review chain and its own raw folder", () => {
    const options = parseArgs([...args, "--shadow"]);
    expect(options.out.endsWith(join(".agents", "reviews", "pr-7", "shadow"))).toBe(true);
    expect(rawDir(options, 1)).not.toBe(rawDir(parseArgs(args), 1));
  });

  it("[ADR 0280] refuses shadow with --previous, --round, self-check or another mode", () => {
    expect(() => parseArgs([...args, "--shadow", "--previous", "c"])).toThrow(
      "ARG_SHADOW_NOT_WITH_PREVIOUS",
    );
    expect(() => parseArgs([...args, "--shadow", "--round", "2"])).toThrow(
      "ARG_SHADOW_NOT_WITH_ROUND",
    );
    expect(() => parseArgs([...args, "--shadow", "--self-check-only"])).toThrow(
      "ARG_SHADOW_NOT_FOR_SELF_CHECK",
    );
    expect(() =>
      parseArgs(["--mode", "plan", "--head", "a", "--brief", "b.md", "--topic", "t", "--shadow"]),
    ).toThrow("ARG_SHADOW_ONLY_FOR_CODE_REVIEW");
  });

  it("[ADR 0280] counts finished shadow runs and adds their spend to the day total", () => {
    const repo = mkdtempSync(join(tmpdir(), "review-shadow-"));
    try {
      const dir = join(repo, ".agents", "reviews", "pr-7");
      mkdirSync(join(dir, "shadow"), { recursive: true });
      const at = "2026-11-15T01:00:00.000Z";
      writeFileSync(
        join(dir, "usage.jsonl"),
        `${JSON.stringify({ mode: "code-review", head: "a".repeat(40), model: "m", outcome: "ok", cost: 0.1, at })}\n`,
      );
      writeFileSync(
        join(dir, "shadow", "usage.jsonl"),
        [
          { outcome: "ok", cost: 0.05 },
          { outcome: "timeout", cost: 0.02 },
        ]
          .map((item) =>
            JSON.stringify({
              mode: "code-review",
              head: "b".repeat(40),
              model: "m",
              shadow: true,
              at,
              ...item,
            }),
          )
          .join("\n"),
      );
      expect(shadowRunsDone(join(repo, ".agents", "reviews"))).toBe(1);
      const day = dailySpend(repo, "2026-11-15");
      expect(day.total).toBeCloseTo(0.17);
      expect(day.items.map((item) => item.key)).toEqual(["pr-7", "pr-7/shadow"]);
      writeFileSync(
        join(dir, "shadow", "usage.jsonl"),
        [
          { round: 1, model: "a" },
          { round: 1, model: "b" },
          { round: 2, model: "a" },
        ]
          .map((item) => JSON.stringify({ outcome: "ok", cost: 0, ...item }))
          .join("\n"),
      );
      expect(shadowRunsDone(join(repo, ".agents", "reviews"))).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("shadow spend and command", () => {
  it("[ADR 0280] counts the shadow ledger in the next ordinary round's budget", () => {
    const root = mkdtempSync(join(tmpdir(), "review-shadow-budget-"));
    try {
      const out = join(root, "pr-7");
      mkdirSync(join(out, "shadow"), { recursive: true });
      writeFileSync(join(out, "usage.jsonl"), "");
      writeFileSync(
        join(out, "shadow", "usage.jsonl"),
        `${JSON.stringify({ mode: "code-review", head: "b".repeat(40), model: "m", outcome: "ok", cost: 0.15, shadow: true })}\n`,
      );
      const linked = linkedLedgerRecords({ out });
      expect(linked.map((record) => record.cost)).toEqual([0.15]);
      expect(linkedLedgerRecords({ out, selfCheckOnly: true })).toEqual([]);
      const parent = [{ cost: 0.7, round: 1 }];
      const models = ["opencode-go/deepseek-v4.1-flash"];
      expect(budgetCheck({ mode: "code-review", records: parent, models })).toBeNull();
      expect(budgetCheck({ mode: "code-review", records: [...parent, ...linked], models })).toMatch(
        /^BUDGET_NEEDS_APPROVAL /,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[ADR 0280] the suggested shadow command keeps the brief path whole and the run's choices", () => {
    const command = shadowCommand({
      pr: 7,
      base: "b",
      head: "h",
      brief: "/tmp/my brief; it's.md",
      gateway: "magpie",
      models: ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
      providers: ["p1"],
      approvedUsd: 1.5,
    });
    const argv = spawnSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    }).stdout.split("\n");
    expect(argv[argv.indexOf("--brief") + 1]).toBe("/tmp/my brief; it's.md");
    expect(argv[argv.indexOf("--models") + 1]).toBe(
      "opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash",
    );
    expect(argv[argv.indexOf("--providers") + 1]).toBe("p1");
    expect(argv[argv.indexOf("--approved-usd") + 1]).toBe("1.5");
    expect(argv[argv.indexOf("--gateway") + 1]).toBe("magpie");
  });
});

describe("speed report by increment size", () => {
  const round = (over) => ({
    pr: 1,
    mode: "code-review",
    model: "m",
    outcome: "ok",
    round: 2,
    previous: "p",
    steps: 30,
    cost: 0.05,
    runMs: 500000,
    ...over,
  });

  it("[ADR 0280] buckets incremental rounds by their own lines, before and after the cut", () => {
    expect(bucketLabel(0, [30, 100])).toBe("0-30");
    expect(bucketLabel(31, [30, 100])).toBe("31-100");
    expect(bucketLabel(101, [30, 100])).toBe(">100");
    const rounds = [
      round({ at: "2026-11-14T00:00:00Z", backfilledLines: 10, steps: 40 }),
      round({ pr: 2, at: "2026-11-16T00:00:00Z", increment: { lines: 12 }, steps: 8 }),
      round({ pr: 3, at: "2026-11-16T00:00:00Z", steps: 9 }),
      round({ pr: 4, at: "2026-11-16T00:00:00Z", previous: null, steps: 50 }),
    ];
    const stats = bucketStats(rounds, [30, 100], "2026-11-15T00:00:00Z");
    expect(stats.unknown).toBe(1);
    expect(stats.rows[0]).toMatchObject({
      label: "0-30",
      before: { rounds: 1, steps: 40 },
      after: { rounds: 1, steps: 8 },
    });
    expect(stats.rows[2].after.rounds).toBe(0);
    expect(renderCsv(rounds).split("\n")[0]).toContain("incrementLines");
  });

  it("[ADR 0280] does not backfill a round that fell back to the old full-range prompt", () => {
    sandbox(({ repo, write, commit, previous }) => {
      write("pr.txt", "a\nb\n");
      const head = commit("change");
      const fellBack = round({ head, previous, increment: { fallback: "too-large" } });
      const old = round({ head, previous });
      backfillIncrements([fellBack, old], repo, "main");
      expect(fellBack.backfilledLines).toBeUndefined();
      expect(old.backfilledLines).toBe(1);
    });
  });
});
