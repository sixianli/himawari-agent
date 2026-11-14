import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateTask } from "../../scripts/model-review/delegate.mjs";
import {
  assertReviewed,
  buildPrompt,
  claimsFileSecretLike,
  expectedTools,
  parseArgs,
  parseUsage,
  REVIEW_MODELS,
  REVIEWS_DIR,
  reviewConfig,
  setRegisteredTestValues,
} from "../../scripts/model-review/opencode-review.mjs";
import {
  claimsProblems,
  locationsOf,
  parseClaims,
  parseClaimVerdicts,
  quoteInText,
} from "../../scripts/model-review/plan-claims.mjs";

const [deepseek, glm] = REVIEW_MODELS;
const REDACTION = "packages/sensitive-capture/src/redaction.ts";
const REDACTION_TEXT = [
  "export function maskSensitiveTexts(texts) {",
  "  const masked = mask(texts);",
  '  return masked.map((text) => text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"));',
  "}",
  "",
].join("\n");
const ADR = "docs/adr/0300-example.md";
const WRONG_SENTENCE = "`maskSensitiveTexts` 输出的占位编号随前面内容变化";
const RIGHT_SENTENCE = "`maskSensitiveTexts` 输出前把占位编号去掉";
const sha = (text) => createHash("sha256").update(text).digest("hex");

const claimLine = (id, verdict, location, sentence, code) =>
  `CLAIM|${id}|${verdict}|${location}|${sentence}|${code}`;
const CODE_LINE = 'text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]")';
const consistentAnswer = (extra = []) =>
  [
    claimLine("1", "一致", `${REDACTION}:3`, RIGHT_SENTENCE, CODE_LINE),
    ...extra,
    "没能核对的部分：无。",
    "",
  ].join("\n");
const wrongAnswer = () =>
  `${consistentAnswer([claimLine("2", "不一致", `${REDACTION}:3`, WRONG_SENTENCE, CODE_LINE)])}`;

const fixture = ({ adrText = `# 方案\n\n${RIGHT_SENTENCE}。\n`, withAdr = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "plan-claims-gate-"));
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
  const main = commit({ [REDACTION]: REDACTION_TEXT, "ci/rules/gitleaks.toml": "" }, "base");
  git("update-ref", "refs/remotes/origin/main", main);
  git("checkout", "--quiet", "-b", "feature");
  const reviewed = commit(
    withAdr ? { "code.txt": "feature\n", [ADR]: adrText } : { "code.txt": "feature\n" },
    "feature",
  );
  const codeLedger = `${REVIEWS_DIR}/pr-7/usage.jsonl`;
  const codeRecord = (model) => ({
    at: "2026-11-12T00:00:00.000Z",
    cost: 0.05,
    round: 1,
    mode: "code-review",
    model,
    head: reviewed,
    outcome: "ok",
    steps: 3,
    input: 10,
    cacheRead: 5,
    output: 2,
    reasoning: 1,
  });
  commit(
    {
      [codeLedger]: [deepseek, glm]
        .map((model) => `${JSON.stringify(codeRecord(model))}\n`)
        .join(""),
    },
    "code review records",
  );
  const claimsRecord = (overrides = {}) => ({
    at: "2026-11-12T01:00:00.000Z",
    cost: 0.08,
    round: 1,
    mode: "plan-claims",
    model: deepseek,
    head: reviewed,
    outcome: "ok",
    steps: 5,
    input: 100,
    cacheRead: 50,
    output: 20,
    reasoning: 10,
    claimsFile: ADR,
    claimsSha256: sha(adrText),
    ...overrides,
  });
  const writeClaims = ({ answer, verdicts, record = claimsRecord(), topic = "plan-x" }) => {
    const dir = `${REVIEWS_DIR}/topic-${topic}`;
    const files = {
      [`${dir}/usage.jsonl`]: `${JSON.stringify(record)}\n`,
      [`${dir}/round-${record.round}/deepseek-v4.1-flash.md`]: answer,
    };
    if (verdicts !== undefined)
      files[`${dir}/round-${record.round}/claims-verdicts.jsonl`] = verdicts;
    return commit(files, "claims records");
  };
  const check = (extra = {}) => assertReviewed({ repo, pr: 7, mainRef: "origin/main", ...extra });
  return { root, repo, git, commit, writeClaims, claimsRecord, check, reviewed };
};

const withFixture = (options, run) => {
  const f = fixture(options);
  try {
    return run(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
};

const claimsOnly = (result) => result.problems.filter((problem) => problem.startsWith("claims-"));

const modelWrongVerdict = (overrides = {}) =>
  `${JSON.stringify({
    id: "2",
    model: deepseek,
    quote: claimLine("2", "不一致", `${REDACTION}:3`, WRONG_SENTENCE, CODE_LINE),
    outcome: "model-wrong",
    evidenceFile: REDACTION,
    evidence: CODE_LINE,
    ...overrides,
  })}\n`;

describe("plan claims check: reading the model's answer", () => {
  it("[claims] lists every CLAIM line with its verdict, location, sentence and code", () => {
    const { claims, problems } = parseClaims(
      [
        "前言",
        claimLine("1", "一致", "a.ts:1", "句子一", "const a = 1"),
        `- ${claimLine("2", "不一致", "b.ts:2", "句子二", "x | y")}`,
        claimLine("3", "找不到", "-", "句子三", "-"),
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(claims.map((claim) => [claim.id, claim.verdict])).toEqual([
      ["1", "一致"],
      ["2", "不一致"],
      ["3", "找不到"],
    ]);
    expect(claims[1].code).toBe("x | y");
  });

  it("[claims] reports lines it cannot read and repeated ids instead of skipping them", () => {
    const { claims, problems } = parseClaims(
      [
        "CLAIM|1|大概一致|a.ts:1|句子|代码",
        "CLAIM|2|一致|a.ts:1",
        claimLine("3", "一致", "a.ts:1", "句子", "代码"),
        claimLine("3", "一致", "a.ts:2", "句子", "代码"),
      ].join("\n"),
    );
    expect(claims.map((claim) => claim.id)).toEqual(["3"]);
    expect(problems).toEqual(["line-1-malformed", "line-2-malformed", "line-4-duplicate-id 3"]);
  });

  it("[claims] a line that looks like a claim but is not in the format is reported, not skipped", () => {
    const { claims, problems } = parseClaims(
      [
        "CLAIM 1 | 一致 | a.ts:1 | 句 | 码",
        "`CLAIM|2|一致|a.ts:1|句|码`",
        "CLAIM：3",
        "1. CLAIM|5|一致|a.ts:1|句|码",
        "CLAIM_6|一致|a.ts:1|句|码",
        claimLine("4", "一致", "a.ts:1", "句", "const a = 1"),
        "普通文字里提到 CLAIM 这个词不算",
      ].join("\n"),
    );
    expect(claims.map((claim) => claim.id)).toEqual(["4"]);
    expect(problems).toEqual([
      "line-1-malformed",
      "line-2-malformed",
      "line-3-malformed",
      "line-4-malformed",
      "line-5-malformed",
    ]);
  });

  it("[claims] finds a code quote through changed spacing and elided parts, and refuses an invented one", () => {
    const text = "function f() {\n  return   a\n    + b;\n}\n";
    expect(quoteInText("return a + b;", text)).toBe(true);
    expect(quoteInText("`function f() {` … `+ b;`", text)).toBe(true);
    expect(quoteInText("return a - b;", text)).toBe(false);
    expect(quoteInText("  ", text)).toBe(false);
  });

  it("[claims] reads several evidence places from one location field and refuses a broken one", () => {
    expect(locationsOf("ci/policy.json:110,127")).toEqual([
      { path: "ci/policy.json", line: 110 },
      { path: "ci/policy.json", line: 127 },
    ]);
    expect(locationsOf("a.mjs:3,b/c.mjs:9-12")).toEqual([
      { path: "a.mjs", line: 3 },
      { path: "b/c.mjs", line: 9 },
    ]);
    expect(locationsOf("a.mjs:3")).toEqual([{ path: "a.mjs", line: 3 }]);
    expect(locationsOf("-")).toEqual([]);
    expect(locationsOf("127,a.mjs:3")).toEqual([]);
    expect(locationsOf("/etc/passwd:1,a.mjs:3")).toEqual([]);
  });

  it("[claims] accepts several quoted fragments joined by a full-width semicolon only when every fragment is in the file in that order", () => {
    const text = "MemoryHigh=19G\nMemoryMax=20G\nnote: 第一步；第二步\n";
    expect(quoteInText("MemoryHigh=19G；MemoryMax=20G", text)).toBe(true);
    expect(quoteInText("note: 第一步；第二步", text)).toBe(true);
    expect(quoteInText("MemoryHigh=19G；MemoryMax=21G", text)).toBe(false);
    expect(quoteInText("MemoryHigh=19G；20G", text)).toBe(false);
    expect(quoteInText("MemoryHigh=19G；", text)).toBe(true);
    expect(quoteInText("MemoryHigh=19G\\nMemoryMax=20G", text)).toBe(true);
    expect(quoteInText("MemoryMax=20G\\nMemoryHigh=19G", text)).toBe(false);
    expect(quoteInText("MemoryHigh=19G / MemoryMax=20G", text)).toBe(true);
    expect(quoteInText("MemoryMax=20G / MemoryHigh=19G", text)).toBe(false);
    const code = 'run([\n  "--",\n  ".github",\n]),\nnext();\n';
    expect(quoteInText('"--", /  ".github", / ]), / next();', code)).toBe(true);
    expect(quoteInText('"--", / ]), / ".github",', code)).toBe(false);
    expect(quoteInText("]), / ;", code)).toBe(false);
    expect(quoteInText("；", text)).toBe(false);
    expect(quoteInText("MemoryMax=20G；MemoryHigh=19G", text)).toBe(false);
    expect(quoteInText("MemoryHigh=19G；MemoryHigh=19G", text)).toBe(false);
    expect(quoteInText("MemoryMax=20G；note: 第一步", text)).toBe(true);
    expect(quoteInText("note: 第一步；MemoryMax=20G", text)).toBe(false);
    expect(quoteInText("note: 第一步 … MemoryMax=20G；MemoryHigh=19G", text)).toBe(true);
    expect(quoteInText("note: 第一步 … MemoryMax=21G；MemoryHigh=19G", text)).toBe(false);
  });

  it("[claims] checks the verdict file line by line", () => {
    expect(parseClaimVerdicts(modelWrongVerdict(), "v").length).toBe(1);
    const plan = JSON.stringify({
      id: "9",
      model: deepseek,
      quote: "q",
      outcome: "plan-fixed",
      change: "改了方案第 3 句",
    });
    expect(parseClaimVerdicts(`${plan}\n`, "v")[0].outcome).toBe("plan-fixed");
    expect(() => parseClaimVerdicts(modelWrongVerdict({ evidence: "" }), "v")).toThrow(
      "CLAIM_VERDICTS_INVALID v:1",
    );
    expect(() => parseClaimVerdicts(modelWrongVerdict({ outcome: "ignored" }), "v")).toThrow(
      "CLAIM_VERDICTS_INVALID v:1",
    );
    expect(() => parseClaimVerdicts(`${modelWrongVerdict()}${modelWrongVerdict()}`, "v")).toThrow(
      "CLAIM_VERDICTS_INVALID v:2",
    );
  });
});

describe("plan claims check: running it", () => {
  const argv = ["--mode", "plan-claims", "--head", "HEAD", "--topic", "t", "--claims-file", ADR];

  it("[claims] needs a committed file, a topic, and no hand-written brief; defaults to DeepSeek only", () => {
    const options = parseArgs(argv);
    expect(options.models).toEqual([deepseek]);
    expect(options.claimsFile).toBe(ADR);
    expect(options.out).toMatch(/\.agents\/reviews\/topic-t$/);
    expect(parseArgs([...argv, "--models", "deepseek-v4.1-flash,glm-5.3-flash"]).models).toEqual([
      deepseek,
      glm,
    ]);
    expect(() => parseArgs(argv.slice(0, -2))).toThrow("ARG_REQUIRED --claims-file");
    expect(() => parseArgs([...argv, "--brief", "x.md"])).toThrow("ARG_BRIEF_NOT_FOR_PLAN_CLAIMS");
    expect(() =>
      parseArgs([...argv.slice(0, 4), "--claims-file", "../x.md", "--topic", "t"]),
    ).toThrow("ARG_INVALID --claims-file");
    expect(() =>
      parseArgs([
        "--mode",
        "plan",
        "--head",
        "HEAD",
        "--topic",
        "t",
        "--brief",
        "b.md",
        "--claims-file",
        ADR,
      ]),
    ).toThrow("ARG_CLAIMS_FILE_ONLY_FOR_PLAN_CLAIMS");
    expect(() => parseArgs(["--assert-reviewed", "--pr", "7", "--claims-file", ADR])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND --claims-file",
    );
  });

  it("[claims] gives the model the plan, the line format, no web tools and no code-review questions", () => {
    const prompt = buildPrompt({
      mode: "plan-claims",
      model: deepseek,
      questions: [],
      head: "a".repeat(40),
      brief: `方案文件：${ADR}\n\n${WRONG_SENTENCE}\n`,
    });
    expect(prompt).toContain(
      "CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>",
    );
    expect(prompt).toContain(WRONG_SENTENCE);
    expect(prompt).not.toContain("必答问题");
    expect(prompt).not.toContain("websearch");
    expect(expectedTools("plan-claims")).toEqual(["bash", "glob", "grep", "read"]);
    const permission = reviewConfig({ mode: "plan-claims" }).permission;
    expect([permission.webfetch, permission.websearch, permission.edit]).toEqual([
      "deny",
      "deny",
      "deny",
    ]);
  });

  it("[claims] counts the claims ledger record only when its file name and hash are valid", () => {
    const record = {
      at: "2026-11-12T00:00:00.000Z",
      cost: 0.1,
      round: 1,
      mode: "plan-claims",
      model: deepseek,
      head: "a".repeat(40),
      outcome: "ok",
    };
    expect(() => parseUsage(`${JSON.stringify(record)}\n`, "u")).toThrow("USAGE_LEDGER_INVALID");
    const full = { ...record, claimsFile: ADR, claimsSha256: sha("x") };
    expect(parseUsage(`${JSON.stringify(full)}\n`, "u").length).toBe(1);
    expect(() => parseUsage(`${JSON.stringify({ ...full, claimsSha256: "abc" })}\n`, "u")).toThrow(
      "USAGE_LEDGER_INVALID",
    );
  });
});

describe("plan claims check: the merge gate", () => {
  it("[claims gate] a PR that adds an ADR with no claims record does not pass --assert-reviewed", () =>
    withFixture({}, (f) => {
      const result = f.check();
      expect(result.problems).toEqual([`claims-unchecked ${ADR}`]);
      expect(result.lines[0]).toMatch(/^REVIEW_NOT_CURRENT /);
    }));

  it("[claims gate] it passes once the record exists and every claim is consistent with the code", () =>
    withFixture({}, (f) => {
      f.writeClaims({ answer: consistentAnswer() });
      expect(f.check().problems).toEqual([]);
    }));

  it("[claims gate] the sentence that was wrong in the P5 plan is reported as inconsistent and blocks until judged", () =>
    withFixture({ adrText: `# 方案\n\n${WRONG_SENTENCE}。\n` }, (f) => {
      f.writeClaims({ answer: wrongAnswer() });
      expect(f.check().problems).toEqual([`claims-unjudged ${ADR} deepseek-v4.1-flash 2 不一致`]);
    }));

  it("[claims gate] a thread judgment that the model was wrong passes only with code text found in the repo", () =>
    withFixture({ adrText: `# 方案\n\n${WRONG_SENTENCE}。\n` }, (f) => {
      f.writeClaims({ answer: wrongAnswer(), verdicts: modelWrongVerdict() });
      expect(f.check().problems).toEqual([]);
      f.writeClaims({
        answer: wrongAnswer(),
        verdicts: modelWrongVerdict({ evidence: "text.replace(NOT_THERE, 1)" }),
      });
      expect(f.check().problems).toEqual([`claims-verdict-evidence ${ADR} deepseek-v4.1-flash 2`]);
    }));

  it("[claims gate] a plan-fixed note does not clear a flagged claim in the run of the current text", () =>
    withFixture({ adrText: `# 方案\n\n${WRONG_SENTENCE}。\n` }, (f) => {
      const note = JSON.stringify({
        id: "2",
        model: deepseek,
        quote: "q",
        outcome: "plan-fixed",
        change: "改了方案",
      });
      f.writeClaims({ answer: wrongAnswer(), verdicts: `${note}\n` });
      expect(f.check().problems).toEqual([`claims-unjudged ${ADR} deepseek-v4.1-flash 2 不一致`]);
    }));

  it("[claims gate] editing the ADR after the check makes the record stale, and re-checking passes", () =>
    withFixture({}, (f) => {
      f.writeClaims({ answer: consistentAnswer() });
      f.commit({ [ADR]: `# 方案\n\n${WRONG_SENTENCE}。\n` }, "edit adr");
      expect(claimsOnly(f.check())).toEqual([`claims-stale ${ADR}`]);
      const fixed = `# 方案\n\n${RIGHT_SENTENCE}，改动后重核。\n`;
      f.commit({ [ADR]: fixed }, "fix adr");
      f.writeClaims({
        answer: consistentAnswer(),
        record: f.claimsRecord({ claimsSha256: sha(fixed), at: "2026-11-12T02:00:00.000Z" }),
        topic: "plan-y",
      });
      expect(claimsOnly(f.check())).toEqual([]);
    }));

  it("[claims gate] a quote the model invented, or a location that does not exist, is not accepted as a check", () =>
    withFixture({}, (f) => {
      f.writeClaims({
        answer: [
          claimLine("1", "一致", `${REDACTION}:3`, RIGHT_SENTENCE, "return invented(value)"),
          claimLine("2", "一致", "no/such/file.ts:1", "另一句", "const a = 1"),
          claimLine("3", "一致", `${REDACTION}:99`, "第三句", CODE_LINE),
          "",
        ].join("\n"),
      });
      expect(f.check().problems).toEqual([
        `claims-evidence ${ADR} deepseek-v4.1-flash 1 code-quote-not-in-file`,
        `claims-evidence ${ADR} deepseek-v4.1-flash 2 location-file-missing`,
        `claims-evidence ${ADR} deepseek-v4.1-flash 3 location-line-out-of-range`,
      ]);
    }));

  it("[claims gate] an answer with no readable claim at all does not count as a check", () =>
    withFixture({}, (f) => {
      f.writeClaims({ answer: "我没找到需要核对的说法。\n" });
      expect(f.check().problems).toEqual([`claims-none ${ADR} deepseek-v4.1-flash`]);
    }));

  it("[claims gate] re-running until the answer happens to be all consistent does not erase the earlier flagged run", () =>
    withFixture({ adrText: `# 方案\n\n${WRONG_SENTENCE}。\n` }, (f) => {
      f.writeClaims({ answer: wrongAnswer() });
      f.writeClaims({
        answer: consistentAnswer(),
        record: f.claimsRecord({ at: "2026-11-12T05:00:00.000Z" }),
        topic: "plan-lucky",
      });
      expect(f.check().problems).toEqual([`claims-unjudged ${ADR} deepseek-v4.1-flash 2 不一致`]);
      f.writeClaims({
        answer: wrongAnswer(),
        verdicts: modelWrongVerdict(),
        record: f.claimsRecord(),
        topic: "plan-x",
      });
      expect(f.check().problems).toEqual([]);
    }));

  it("[claims gate] an ADR named like a secret cannot be recorded, so the gate says so instead of failing on the record scan", () => {
    const path = `docs/adr/0304-${["sk", "abcdefghijklmnopqrstuv"].join("-")}.md`;
    expect(() =>
      parseArgs(["--mode", "plan-claims", "--head", "HEAD", "--topic", "t", "--claims-file", path]),
    ).toThrow("ARG_INVALID --claims-file");
    return withFixture({ withAdr: false }, (f) => {
      f.commit({ [path]: "# 方案\n" }, "adr named like a key");
      expect(claimsOnly(f.check())).toEqual([`claims-name-unsupported ${path}`]);
    });
  });

  it("[claims] a registered test value in the file name is refused before anything is recorded", () => {
    const value = ["abcdef", "123456"].join("");
    setRegisteredTestValues([value]);
    try {
      expect(claimsFileSecretLike(`docs/adr/0305-${value}.md`)).toBe(true);
      expect(claimsFileSecretLike("docs/adr/0305-plain.md")).toBe(false);
    } finally {
      setRegisteredTestValues([]);
    }
  });

  it("[claims] a numbered or full-width prefix before CLAIM is reported too", () => {
    const { claims, problems } = parseClaims(
      [
        "1、CLAIM|1|一致|a.ts:1|句|码",
        "１. CLAIM|2|一致|a.ts:1|句|码",
        "1）CLAIM|3|一致|a.ts:1|句|码",
      ].join("\n"),
    );
    expect(claims).toEqual([]);
    expect(problems).toHaveLength(3);
  });

  it("[claims gate] a failed run does not count, and every run of the same text has to pass", () =>
    withFixture({}, (f) => {
      f.writeClaims({
        answer: consistentAnswer(),
        record: f.claimsRecord({ outcome: "timeout" }),
      });
      expect(f.check().problems).toEqual([`claims-run-failed ${ADR}`]);
      f.writeClaims({
        answer: wrongAnswer(),
        record: f.claimsRecord({ at: "2026-11-12T03:00:00.000Z" }),
        topic: "plan-z",
      });
      expect(f.check().problems).toEqual([`claims-unjudged ${ADR} deepseek-v4.1-flash 2 不一致`]);
    }));

  it("[claims gate] Andy's recorded skip waives it like the other review problems", () =>
    withFixture({}, (f) => {
      const result = f.check({ acceptUnreviewed: "Andy 说跳过" });
      expect(result.lines.join("\n")).toContain("REVIEW_OVERRIDE_WRITTEN");
    }));

  it("[claims gate] a PR with no new ADR is not asked for a claims record", () =>
    withFixture({ withAdr: false }, (f) => {
      expect(f.check().problems).toEqual([]);
      expect(
        claimsProblems({
          repo: f.repo,
          head: f.git("rev-parse", "HEAD"),
          mainRef: "origin/main",
          reviewsDir: REVIEWS_DIR,
          parseUsage,
        }),
      ).toEqual({ problems: [], files: [] });
    }));

  it("[claims gate] changing an ADR that already exists on main is not treated as a new plan", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-claims-existing-"));
    const repo = join(root, "repo");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
      const commit = (text) => {
        mkdirSync(join(repo, "docs/adr"), { recursive: true });
        writeFileSync(join(repo, ADR), text);
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "m");
      };
      commit("旧\n");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("checkout", "--quiet", "-b", "feature");
      commit("新\n");
      expect(
        claimsProblems({
          repo,
          head: git("rev-parse", "HEAD"),
          mainRef: "origin/main",
          reviewsDir: REVIEWS_DIR,
          parseUsage,
        }).problems,
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[claims gate] the command line exits non-zero for an unchecked ADR and zero once checked", () =>
    withFixture({}, (f) => {
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
      const before = run();
      expect(before.status).toBe(5);
      expect(before.stdout).toContain(`claims-unchecked ${ADR}`);
      f.writeClaims({ answer: consistentAnswer() });
      const after = run();
      expect(after.status).toBe(0);
      expect(after.stdout).toMatch(/REVIEW_CURRENT pr=7 /);
    }));

  it("[claims gate] a line number of 0 does not count as a place in the file", () =>
    withFixture({}, (f) => {
      f.writeClaims({
        answer: claimLine("1", "一致", `${REDACTION}:0`, RIGHT_SENTENCE, CODE_LINE),
      });
      expect(f.check().problems).toEqual([
        `claims-evidence ${ADR} deepseek-v4.1-flash 1 location-line-out-of-range`,
      ]);
    }));

  it("[claims gate] a malformed answer line, a broken verdicts file and a broken ledger each block", () =>
    withFixture({}, (f) => {
      f.writeClaims({ answer: `${consistentAnswer()}CLAIM|9|大概一致|a|b|c\n` });
      expect(f.check().problems).toEqual([
        `claims-answer-invalid ${ADR} deepseek-v4.1-flash line-3-malformed`,
      ]);
      f.writeClaims({
        answer: consistentAnswer(),
        verdicts: "不是 JSON\n",
        record: f.claimsRecord({ at: "2026-11-12T04:00:00.000Z" }),
        topic: "plan-v",
      });
      const both = claimsOnly(f.check());
      expect(both).toHaveLength(2);
      expect(both).toContainEqual(
        expect.stringMatching(
          /^claims-verdicts-invalid CLAIM_VERDICTS_INVALID .*claims-verdicts\.jsonl:1$/,
        ),
      );
      f.commit({ [`${REVIEWS_DIR}/topic-broken/usage.jsonl`]: "not json\n" }, "broken ledger");
      expect(claimsOnly(f.check())).toContain(
        `claims-ledger-invalid ${REVIEWS_DIR}/topic-broken/usage.jsonl`,
      );
    }));

  it("[claims gate] an ADR whose file name cannot be given to the check is reported instead of skipped", () =>
    withFixture({ withAdr: false }, (f) => {
      f.commit({ "docs/adr/0301-has space.md": "# 方案\n" }, "adr with a space");
      expect(claimsOnly(f.check())).toEqual(["claims-name-unsupported docs/adr/0301-has space.md"]);
    }));

  it("[claims gate] a file name with a tab or a newline is reported on one clean line", () =>
    withFixture({ withAdr: false }, (f) => {
      f.commit({ "docs/adr/0303-a\tb\nc.md": "# 方案\n" }, "adr with control characters");
      const [problem] = claimsOnly(f.check());
      expect(problem).toBe("claims-name-unsupported docs/adr/0303-a?b?c.md");
    }));

  it("[claims gate] an ADR with a non-ASCII name can be checked like any other", () => {
    const path = "docs/adr/0302-中文方案.md";
    const text = `# 方案\n\n${RIGHT_SENTENCE}。\n`;
    return withFixture({ withAdr: false }, (f) => {
      f.commit({ [path]: text }, "adr with a Chinese name");
      expect(claimsOnly(f.check())).toEqual([`claims-unchecked ${path}`]);
      f.writeClaims({
        answer: consistentAnswer(),
        record: f.claimsRecord({ claimsFile: path, claimsSha256: sha(text) }),
      });
      expect(claimsOnly(f.check())).toEqual([]);
    });
  });

  it("[claims gate] records of a stale run are not counted as unreviewed changes of the PR", () =>
    withFixture({}, (f) => {
      f.writeClaims({ answer: consistentAnswer() });
      f.commit({ [ADR]: `# 方案\n\n${RIGHT_SENTENCE}，又改了一句。\n` }, "edit adr");
      expect(f.check().problems).toEqual([`unreviewed ${ADR}`, `claims-stale ${ADR}`]);
    }));

  it("[claims gate] a record that names a model outside the two review models, or has no valid time, is refused", () => {
    const base = {
      cost: 0.1,
      round: 1,
      mode: "plan-claims",
      head: "a".repeat(40),
      outcome: "ok",
      claimsFile: ADR,
      claimsSha256: sha("x"),
    };
    const line = (extra) => `${JSON.stringify({ ...base, ...extra })}\n`;
    expect(parseUsage(line({ at: "2026-11-12T00:00:00.000Z", model: deepseek }), "u").length).toBe(
      1,
    );
    expect(() => parseUsage(line({ at: "2026-11-12 00:00", model: deepseek }), "u")).toThrow(
      "USAGE_LEDGER_INVALID",
    );
    expect(() => parseUsage(line({ at: "t", model: deepseek }), "u")).toThrow(
      "USAGE_LEDGER_INVALID",
    );
    expect(() =>
      parseUsage(line({ at: "2026-11-12T00:00:00.000Z", model: "other/model" }), "u"),
    ).toThrow("USAGE_LEDGER_INVALID");
  });

  it("[claims gate] both models' answers are checked when both ran", () =>
    withFixture({}, (f) => {
      f.writeClaims({ answer: consistentAnswer() });
      const dir = `${REVIEWS_DIR}/topic-plan-x`;
      f.commit(
        {
          [`${dir}/usage.jsonl`]: [
            f.claimsRecord(),
            f.claimsRecord({ model: glm, at: "2026-11-12T01:00:01.000Z" }),
          ]
            .map((record) => `${JSON.stringify(record)}\n`)
            .join(""),
          [`${dir}/round-1/glm-5.3-flash.md`]: wrongAnswer(),
        },
        "glm record",
      );
      expect(f.check().problems).toEqual([`claims-unjudged ${ADR} glm-5.3-flash 2 不一致`]);
    }));
});

describe("plan claims check: the pieces around it", () => {
  it("[claims] the two fixture plans differ in exactly the sentence the P5 plan got wrong", () => {
    const dir = join(import.meta.dirname, "fixtures/plan-claims");
    const wrong = readFileSync(join(dir, "plan-wrong.md"), "utf8");
    const right = readFileSync(join(dir, "plan-right.md"), "utf8");
    expect(wrong).toContain("`maskSensitiveTexts` 输出的占位编号随前面内容变化");
    expect(right).not.toContain("输出的占位编号随前面内容变化");
    expect(right).toContain("输出前把占位编号去掉");
  });

  it("[claims] the check is not asked to propose better plans", () => {
    const prompt = buildPrompt({
      mode: "plan-claims",
      model: deepseek,
      questions: [],
      head: "a".repeat(40),
      brief: "x",
    });
    expect(prompt).not.toContain("提出你认为更好的方案");
    expect(prompt).toContain("竖线字符换成全角");
  });

  it("[claims] it cannot be handed to a cloud thread, which has no way to pass the file", () => {
    expect(() =>
      validateTask({
        branch: "claude/x",
        tip: "a".repeat(40),
        mode: "plan-claims",
        head: "b".repeat(40),
        topic: "t",
        brief: "b.md",
      }),
    ).toThrow("DELEGATE_INVALID mode");
  });
});
