import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  deferredLowLines,
  finishRound,
  judgeSkeleton,
  LOW_DEFER_FROM_ROUND,
  parseArgs,
  skeletonFindings,
} from "../../scripts/model-review/opencode-review.mjs";

const deepseek = "opencode-go/deepseek-v4.1-flash";
const head = "a".repeat(40);
const base = "b".repeat(40);
const answer = [
  "## 结论",
  "### 不是意见",
  "## 问题",
  "### 1. 中：失败请求被算成缓存没命中",
  "正文",
  "### 2. 低：日志没清理控制字符",
  "## 推测",
  "### A. 低（未核实）：格式没核实",
  "## 必答问题",
  "### 1. 会不会改变请求开头？",
].join("\n");

function fixture(round, verdicts, overrides = {}) {
  const repo = mkdtempSync(join(tmpdir(), "round-tools-"));
  const dir = join(repo, ".agents", "reviews", "pr-7", `round-${round}`);
  mkdirSync(dir, { recursive: true });
  const record = {
    mode: "code-review",
    round,
    model: deepseek,
    head,
    base,
    outcome: "ok",
    cost: 0.05,
    ...overrides,
  };
  writeFileSync(
    join(repo, ".agents", "reviews", "pr-7", "usage.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
  writeFileSync(join(dir, "deepseek-v4.1-flash.md"), answer);
  if (verdicts)
    writeFileSync(
      join(dir, "verdicts.jsonl"),
      `${verdicts.map((verdict) => JSON.stringify({ model: deepseek, ...verdict })).join("\n")}\n`,
    );
  return { repo, dir };
}

const high = {
  id: "1",
  quote: "### 1. 中：失败请求被算成缓存没命中",
  valid: true,
  class: "error",
  severity: "medium-high",
  trigger: "失败请求",
  consequence: "多记一次",
  modelSeverity: "中",
};
const low = {
  id: "2",
  quote: "### 2. 低：日志没清理控制字符",
  valid: true,
  class: "error",
  severity: "low",
  trigger: "带控制字符",
  consequence: "日志混入控制序列",
  modelSeverity: "低",
};
const wrong = {
  id: "A",
  quote: "### A. 低（未核实）：格式没核实",
  valid: false,
  class: "error",
  why: "真实文件就是这个格式",
};

describe("review round tools", () => {
  it("[review-cost] the skeleton takes findings and skips the conclusion and the required questions", () => {
    expect(skeletonFindings(answer)).toEqual([
      "### 1. 中：失败请求被算成缓存没命中",
      "### 2. 低：日志没清理控制字符",
      "### A. 低（未核实）：格式没核实",
    ]);
    const { repo, dir } = fixture(1);
    try {
      expect(judgeSkeleton({ repo, pr: 7 })[0]).toContain("findings=3");
      const lines = readFileSync(join(dir, "verdicts.jsonl"), "utf8").trim().split("\n");
      expect(lines.map((line) => JSON.parse(line).quote)).toEqual(skeletonFindings(answer));
      expect(JSON.parse(lines[0]).valid).toBeNull();
      expect(() => judgeSkeleton({ repo, pr: 7 })).toThrow("JUDGE_SKELETON_EXISTS");
      rmSync(join(dir, "verdicts.jsonl"));
      writeFileSync(join(dir, "deepseek-v4.1-flash.md"), "## 问题\n1. 没用标题的意见\n");
      expect(() => judgeSkeleton({ repo, pr: 7 })).toThrow("JUDGE_SKELETON_NONE");
      expect(existsSync(join(dir, "verdicts.jsonl"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("[review-cost] finishing a round writes judgments and names the next step with the right --previous", () => {
    const cases = [
      [1, [high, low, wrong], "NEXT fix-and-rereview"],
      [2, [low, wrong], "NEXT fix-low-then"],
      [LOW_DEFER_FROM_ROUND, [low, wrong], "NEXT low-deferred"],
      [2, [wrong], "NEXT done"],
    ];
    for (const [round, verdicts, next] of cases) {
      const { repo, dir } = fixture(round, verdicts);
      try {
        const lines = finishRound({ repo, pr: 7 });
        expect(lines[0]).toContain(`reviewed=${head}`);
        expect(lines.find((line) => line.startsWith("NEXT"))).toContain(next);
        if (next === "NEXT fix-and-rereview")
          expect(lines.join("\n")).toContain(
            `--base ${base} --head <修改后的提交> --previous ${head}`,
          );
        const judgments = readFileSync(join(dir, "judgments.md"), "utf8");
        expect(judgments).toContain(
          "不成立：### A. 低（未核实）：格式没核实。真实文件就是这个格式",
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it("[review-cost] [negative] finishing refuses a rejection without reasons and a quote not in the answer", () => {
    const { repo } = fixture(1, [
      { ...wrong, why: "" },
      { ...low, quote: "### 9. 编的" },
      { ...high, id: "3", why: "\u001b[31m" },
    ]);
    try {
      expect(() => finishRound({ repo, pr: 7 })).toThrow(
        "FINISH_ROUND_REFUSED why-missing A quote-not-found 2 control-character 3",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("[review-cost] the report lists unfixed lows only from the third round on", () => {
    for (const round of [LOW_DEFER_FROM_ROUND - 1, LOW_DEFER_FROM_ROUND]) {
      const { repo } = fixture(round, [low, wrong]);
      try {
        const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        git("init", "-q");
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
        const lines = deferredLowLines({
          repo,
          ledgerPath: ".agents/reviews/pr-7",
          records: [{ mode: "code-review", round }],
        });
        if (round < LOW_DEFER_FROM_ROUND) expect(lines).toEqual([]);
        else
          expect(lines).toEqual([
            `  第 ${round} 轮 2 deepseek-v4.1-flash：### 2. 低：日志没清理控制字符｜带控制字符 → 日志混入控制序列`,
          ]);
        expect(
          deferredLowLines({
            repo,
            ledgerPath: ".agents/reviews/pr-7",
            records: [
              { mode: "code-review", round },
              { mode: "low-fix", round },
            ],
          }),
        ).toEqual([]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it("[review-cost] [negative] the report says when a round's verdicts were not committed and walks only recorded rounds", () => {
    const { repo } = fixture(LOW_DEFER_FROM_ROUND);
    try {
      const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
      const started = Date.now();
      expect(
        deferredLowLines({
          repo,
          ledgerPath: ".agents/reviews/pr-7",
          records: [
            { mode: "code-review", round: LOW_DEFER_FROM_ROUND },
            { mode: "code-review", round: Number.MAX_SAFE_INTEGER },
          ],
        }),
      ).toEqual([
        `  第 ${LOW_DEFER_FROM_ROUND} 轮 verdicts.jsonl 没有提交，列不出这一轮的低意见`,
        `  第 ${Number.MAX_SAFE_INTEGER} 轮 verdicts.jsonl 没有提交，列不出这一轮的低意见`,
      ]);
      expect(Date.now() - started).toBeLessThan(10000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("[review-cost] [negative] finishing refuses a ledger base that is not a commit", () => {
    for (const bad of ["main; touch pwned", undefined]) {
      const { repo, dir } = fixture(1, [high], { base: bad });
      try {
        expect(() => finishRound({ repo, pr: 7 })).toThrow("FINISH_ROUND_REFUSED base-invalid");
        expect(existsSync(join(dir, "judgments.md"))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it("[review-cost] an incremental round asks only for the increment and what it affects", () => {
    const prompt = buildPrompt({
      mode: "code-review",
      model: deepseek,
      questions: [],
      head,
      base,
      previous: base,
      brief: "x",
    });
    expect(prompt).toContain(`这一轮先看 git diff ${base}..${head} 的增量`);
    expect(prompt).toContain("只有能指出增量里的哪一行、通过哪条调用或数据流影响到它时才去看");
    expect(prompt).not.toContain("但可以读任何文件");
  });

  it("[review-cost] [negative] the round tools take only --pr and --repo", () => {
    expect(parseArgs(["--finish-round", "--pr", "7"]).finishRound).toBe(true);
    expect(() => parseArgs(["--finish-round", "--pr", "7", "--stop", "no-error"])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND --stop",
    );
    expect(() => parseArgs(["--judge-skeleton"])).toThrow("ARG_REQUIRED --pr");
  });
});

describe("review card", () => {
  it("[review-cost] every anchor and option the card names exists", () => {
    const card = readFileSync(".agents/instructions/model-review-card.md", "utf8");
    const full = readFileSync(".agents/instructions/model-review.md", "utf8");
    const script = readFileSync("scripts/model-review/opencode-review.mjs", "utf8");
    const anchors = [...card.matchAll(/model-review\.md#([a-z0-9-]+)/g)].map((match) => match[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(full).toContain(`<a id="${anchor}"></a>`);
    const options = [
      ...new Set([...card.matchAll(/(?<![\w-])--[a-z][a-z-]+/g)].map((match) => match[0])),
    ];
    expect(options).toContain("--finish-round");
    expect(card.length).toBeLessThan(12000);
    for (const option of options) expect(script).toContain(`"${option}"`);
    for (const [, path] of card.matchAll(/\]\((\.\.\/\.\.\/docs\/adr\/[^)#]+)\)/g))
      expect(readFileSync(join(".agents/instructions", path), "utf8").length).toBeGreaterThan(0);
  });

  it("[review-cost] [negative] the card says how to fill every placeholder the next-round command prints", () => {
    const card = readFileSync(".agents/instructions/model-review-card.md", "utf8");
    const script = readFileSync("scripts/model-review/opencode-review.mjs", "utf8");
    const nextLine = script.split("\n").find((line) => line.includes("NEXT fix-and-rereview"));
    const placeholders = [...nextLine.matchAll(/<[^<>$]+>/g)].map((match) => match[0]);
    expect(placeholders).toEqual(["<修改后的提交>", "<本轮材料>", "<整份 PR 材料>"]);
    const mainThread = card.slice(
      card.indexOf('<a id="main-thread">'),
      card.indexOf('<a id="each-round">'),
    );
    for (const placeholder of placeholders) expect(mainThread).toContain(`\`${placeholder}\` 换成`);
  });

  it("[review-cost] [negative] the main thread starts a subagent only after an ok review that exited 0", () => {
    const card = readFileSync(".agents/instructions/model-review-card.md", "utf8");
    const mainThread = card.slice(
      card.indexOf('<a id="main-thread">'),
      card.indexOf('<a id="each-round">'),
    );
    expect(mainThread).toContain("退出码是 0、输出里有 `outcome=ok` 的 `REVIEW_RESULT`");
    expect(card).toContain("`ROUND_NOT_OK`");
    for (const next of ["fix-and-rereview", "fix-low-then", "low-deferred", "done"])
      expect(mainThread).toMatch(new RegExp(`[\`\\s]${next}\``));
    expect(mainThread).toContain("`--approved-usd <他同意的总额>`");
    expect(mainThread).toContain("这一轮该跑的每个模型都有 `outcome=ok`");
    expect(card).not.toContain("每一轮复核交给");
  });

  it("[review-cost] [negative] every subcommand the subagent may run parses as written", () => {
    const agent = readFileSync(".claude/agents/code-review-round.md", "utf8");
    const allowed = agent.slice(agent.indexOf("不花钱的子命令"), agent.indexOf("不做的"));
    const commands = [...allowed.matchAll(/`(--[^`]+)`/g)].map((match) => match[1]);
    expect(commands.length).toBe(5);
    const fill = { "<编号>": "7", "<轮次>": "2", "<原因>": "no-error" };
    for (const command of commands)
      expect(() => parseArgs(command.split(" ").map((part) => fill[part] ?? part))).not.toThrow();
    expect(() => parseArgs(["--accept-low", "2", "--pr", "7"])).toThrow();
  });

  it("[review-cost] [negative] the card names every --stop reason the report accepts", () => {
    const card = readFileSync(".agents/instructions/model-review-card.md", "utf8");
    const script = readFileSync("scripts/model-review/opencode-review.mjs", "utf8");
    expect(card).not.toContain("--stop no-error`");
    for (const stop of ["no-error", "three-rounds", "andy-decision", "run-failed"]) {
      expect(script).toContain(`"${stop}"`);
      expect(card).toContain(`\`${stop}\``);
    }
  });
});
