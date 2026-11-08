import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyResult,
  briefPathFor,
  checkResult,
  delegationPrompt,
  parseTask,
  reviewArgv,
  validateTask,
  waitForBranch,
} from "../../scripts/model-review/delegate.mjs";
import { REVIEW_MODELS } from "../../scripts/model-review/opencode-review.mjs";

const [deepseek, glm] = REVIEW_MODELS;
const KEY = "pr-7";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-delegate-"));
  const run = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const mac = join(root, "mac");
  execFileSync("git", ["clone", "--quiet", origin, mac], { stdio: "ignore" });
  const commit = (cwd, files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
    run(cwd, "add", ".");
    run(cwd, ...identity, "commit", "--quiet", "-m", message);
    return run(cwd, "rev-parse", "HEAD");
  };
  commit(mac, { "code.txt": "base\n" }, "base");
  run(mac, "branch", "-M", "main");
  run(mac, "push", "--quiet", "origin", "main");
  const base = run(mac, "rev-parse", "HEAD");
  run(mac, "checkout", "--quiet", "-b", "feature");
  const head = commit(mac, { "code.txt": "feature\n" }, "feature");
  const task = {
    branch: "feature",
    mode: "code-review",
    pr: 7,
    base,
    head,
    providers: ["workbuddy-ai", "opendesign", "opencode-go"],
  };
  task.brief = briefPathFor(task);
  const tip = commit(mac, { [task.brief]: "material\n" }, "brief");
  task.tip = tip;
  run(mac, "push", "--quiet", "origin", "feature");
  const cloud = join(root, "cloud");
  execFileSync("git", ["clone", "--quiet", "-b", "feature", origin, cloud], { stdio: "ignore" });
  const record = (model, extra = {}) => ({
    at: "t",
    round: 1,
    mode: "code-review",
    model,
    head,
    base,
    previous: null,
    outcome: "ok",
    cost: 0.05,
    steps: 3,
    input: 10,
    cacheRead: 5,
    output: 2,
    reasoning: 1,
    gateway: "magpie",
    providers: { "workbuddy-ai": { requests: 4, failed: 0, credits: 1.5 } },
    ...extra,
  });
  const files = (models) =>
    Object.fromEntries(
      models.flatMap((model) => {
        const name = model.split("/").pop();
        return [
          [`.agents/reviews/${KEY}/round-1/${name}.md`, "answer\n"],
          [`.agents/reviews/${KEY}/round-1/${name}.prompt.md`, "prompt\n"],
        ];
      }),
    );
  const ledger = (records) => records.map((item) => `${JSON.stringify(item)}\n`).join("");
  const push = (extra = []) => run(cloud, "push", "--quiet", ...extra, "origin", "feature");
  const cloudCommit = (extraFiles, message = "result") =>
    commit(
      cloud,
      {
        [`.agents/reviews/${KEY}/usage.jsonl`]: ledger([record(deepseek), record(glm)]),
        ...files([deepseek, glm]),
        ...extraFiles,
      },
      message,
    );
  return { root, run, mac, cloud, task, record, files, ledger, commit, push, cloudCommit };
}

const withFixture = (body) => () => {
  const f = fixture();
  try {
    body(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
};

describe("review delegation prompt", () => {
  const f = fixture();
  const { task } = f;
  rmSync(f.root, { recursive: true, force: true });

  it("[delegate] writes a self-contained, byte-stable task for the cloud thread", () => {
    const text = delegationPrompt({ ...task, replyTo: "session_014uWGaKsHWkBLzcUrmNkG6S" });
    expect(text).toBe(delegationPrompt({ ...task, replyTo: "session_014uWGaKsHWkBLzcUrmNkG6S" }));
    expect(text).toContain(`结果必须正好是 ${task.tip}`);
    expect(text).toContain(`--head ${task.head}`);
    expect(text).toContain("--gateway magpie --require-gateway");
    expect(text).toContain(task.brief);
    expect(text).toContain(".agents/reviews/pr-7/ 下新增或改动的文件");
    expect(text).toContain("session_014uWGaKsHWkBLzcUrmNkG6S");
    expect(text).toContain("timeout 或 no-text");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(delegationPrompt(task)).not.toContain("session_");
  });

  it("[delegate] never lets a re-run be re-run again, and always requires the gateway", () => {
    const rerun = delegationPrompt({ ...task, round: 2, models: ["glm-5.3-flash"] });
    expect(rerun).toContain("本身就是补跑，不再补跑");
    expect(rerun).toContain("--round 2");
    expect(reviewArgv(task)).toContain("--require-gateway");
    expect(reviewArgv({ ...task, round: 2, models: ["glm-5.3-flash"] })).toContain("--models");
  });

  it("[delegate] refuses anything that could break out of the task text", () => {
    const bad = (extra, code) =>
      expect(() => delegationPrompt({ ...task, ...extra })).toThrow(code);
    bad({ branch: "feature branch" }, "DELEGATE_INVALID branch");
    bad({ branch: "a/../b" }, "DELEGATE_INVALID branch");
    bad({ branch: "x\nrm -rf" }, "DELEGATE_INVALID branch");
    bad({ tip: "abc" }, "DELEGATE_INVALID tip");
    bad({ head: "abc" }, "DELEGATE_INVALID head");
    bad({ replyTo: "session x;y" }, "DELEGATE_INVALID reply-to");
    bad({ mode: "write" }, "DELEGATE_INVALID mode");
    bad({ topic: "x" }, "DELEGATE_INVALID pr-or-topic");
    bad({ providers: ["a b"] }, "DELEGATE_INVALID providers");
    bad({ models: ["not-a-review-model"] }, "DELEGATE_INVALID models");
    bad({ approvedUsd: -1 }, "DELEGATE_INVALID approved-usd");
    bad({ brief: ".agents/reviews/pr-7/briefs/other.md" }, "DELEGATE_INVALID brief");
    bad({ brief: "../../etc/passwd" }, "DELEGATE_INVALID brief");
    expect(() => validateTask(task)).not.toThrow();
  });

  it("[delegate] reads the same fields from the command line", () => {
    const parsed = parseTask([
      "prompt",
      "--mode",
      "code-review",
      "--pr",
      "7",
      "--base",
      task.base,
      "--head",
      task.head,
      "--branch",
      "feature",
      "--tip",
      task.tip,
      "--providers",
      "workbuddy-ai,opendesign,opencode-go",
    ]);
    expect(parsed.command).toBe("prompt");
    expect(parsed.task.brief).toBe(task.brief);
    expect(delegationPrompt(parsed.task)).toBe(delegationPrompt(task));
    expect(() => parseTask(["prompt", "--bogus"])).toThrow("DELEGATE_UNKNOWN --bogus");
  });
});

describe("review delegation result check", () => {
  it(
    "[delegate] says pending until the branch moves",
    withFixture((f) => {
      expect(checkResult(f.task, { repo: f.mac }).status).toBe("pending");
    }),
  );

  it(
    "[delegate] accepts a result that only adds records for the delegated review, and fast-forwards to it",
    withFixture((f) => {
      const remote = f.cloudCommit({});
      f.push();
      const result = checkResult(f.task, { repo: f.mac });
      expect(result).toMatchObject({ status: "ok", remote });
      expect(result.added).toHaveLength(2);
      expect(result.spent).toBeCloseTo(0.1);
      expect(applyResult(f.task, { repo: f.mac })).toBe(remote);
    }),
  );

  it(
    "[delegate] refuses to fast-forward when the local branch moved on",
    withFixture((f) => {
      f.cloudCommit({});
      f.push();
      expect(checkResult(f.task, { repo: f.mac }).status).toBe("ok");
      f.commit(f.mac, { "local.txt": "x\n" }, "local");
      expect(() => applyResult(f.task, { repo: f.mac })).toThrow("DELEGATION_LOCAL_MOVED");
    }),
  );

  it(
    "[delegate] refuses a branch that was rewritten so the handed-over tip is gone",
    withFixture((f) => {
      f.run(f.cloud, "reset", "--hard", "--quiet", f.task.head);
      f.cloudCommit({});
      f.push(["--force"]);
      const result = checkResult(f.task, { repo: f.mac });
      expect(result.status).toBe("rejected");
      expect(result.reason).toMatch(/^DELEGATION_REWRITTEN/);
    }),
  );

  it(
    "[delegate] refuses a result that also touches code",
    withFixture((f) => {
      f.cloudCommit({ "code.txt": "sneaky\n" });
      f.push();
      expect(checkResult(f.task, { repo: f.mac }).reason).toBe(
        'DELEGATION_OUTSIDE_RECORDS "code.txt"',
      );
    }),
  );

  it(
    "[delegate] refuses a ledger whose earlier lines were changed",
    withFixture((f) => {
      f.commit(
        f.mac,
        { [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([f.record(deepseek, { cost: 0.01 })]) },
        "earlier",
      );
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, tip: f.run(f.mac, "rev-parse", "HEAD") };
      f.run(f.cloud, "pull", "--quiet", "--ff-only");
      f.commit(
        f.cloud,
        {
          [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
            f.record(deepseek, { cost: 0.0 }),
            f.record(glm),
          ]),
          ...f.files([deepseek, glm]),
        },
        "rewrite",
      );
      f.push();
      expect(checkResult(task, { repo: f.mac }).reason).toBe("DELEGATION_LEDGER_REWRITTEN");
    }),
  );

  it(
    "[delegate] refuses records that do not match what was handed over",
    withFixture((f) => {
      const cases = [
        [{ head: "1".repeat(40) }, "head="],
        [{ mode: "plan" }, "mode=plan"],
        [{ gateway: undefined, providers: undefined }, "gateway=undefined"],
        [
          { providers: { "something-else": { requests: 1, failed: 0, credits: 1 } } },
          "provider=something-else",
        ],
        [{ model: "opencode-go/unknown-model" }, "model=opencode-go/unknown-model"],
        [{ base: "2".repeat(40) }, "base="],
      ];
      for (const [extra, expected] of cases) {
        f.commit(
          f.cloud,
          {
            [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
              f.record(deepseek, extra),
              f.record(glm),
            ]),
            ...f.files([deepseek, glm]),
          },
          "mismatch",
        );
        f.push();
        const result = checkResult(f.task, { repo: f.mac });
        expect(result.status).toBe("rejected");
        expect(result.reason).toContain("DELEGATION_RECORD_MISMATCH");
        expect(result.reason).toContain(expected);
        f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
        f.push(["--force"]);
      }
    }),
  );

  it(
    "[delegate] refuses a result without the model answers or without any new record",
    withFixture((f) => {
      f.commit(
        f.cloud,
        { [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([f.record(deepseek)]) },
        "no answer file",
      );
      f.push();
      expect(checkResult(f.task, { repo: f.mac }).reason).toContain("missing=round-1/");
      f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
      f.push(["--force"]);
      f.commit(f.cloud, { [`.agents/reviews/${KEY}/note.md`]: "x\n" }, "only a note");
      f.push();
      expect(checkResult(f.task, { repo: f.mac }).reason).toBe("DELEGATION_NO_LEDGER");
    }),
  );
});

describe("review delegation wait", () => {
  it("[delegate] stops as soon as the branch moves and gives up after the limit", async () => {
    const seen = [];
    const answers = ["a", "a", "b"];
    const moved = await waitForBranch({
      branch: "feature",
      tip: "a",
      lsRemote: () => answers.shift(),
      sleep: async (ms) => seen.push(ms),
      minutes: 10,
      intervalSeconds: 120,
    });
    expect(moved).toEqual({ moved: true, sha: "b" });
    expect(seen).toEqual([120000, 120000]);
    let polls = 0;
    const gaveUp = await waitForBranch({
      branch: "feature",
      tip: "a",
      lsRemote: () => {
        polls += 1;
        return "a";
      },
      sleep: async () => {},
      minutes: 10,
      intervalSeconds: 120,
    });
    expect(gaveUp.moved).toBe(false);
    expect(polls).toBe(5);
  });
});
