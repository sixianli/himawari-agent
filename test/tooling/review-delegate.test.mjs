import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import {
  DEFAULT_REVIEW_MODELS,
  parseArgs,
  REVIEW_MODELS,
} from "../../scripts/model-review/opencode-review.mjs";

const [deepseek, glm] = REVIEW_MODELS;
const KEY = "pr-7";

const GIT_SETTINGS = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "maintenance.auto=false",
];
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-delegate-"));
  const run = (cwd, ...args) =>
    execFileSync("git", [...GIT_SETTINGS, ...args], {
      cwd,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const origin = join(root, "origin.git");
  execFileSync("git", [...GIT_SETTINGS, "init", "--quiet", "--bare", "-b", "main", origin], {
    env: GIT_ENV,
  });
  const mac = join(root, "mac");
  execFileSync("git", [...GIT_SETTINGS, "clone", "--quiet", origin, mac], {
    env: GIT_ENV,
    stdio: "ignore",
  });
  const commit = (cwd, files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
    run(cwd, "add", ".");
    run(cwd, "commit", "--quiet", "-m", message);
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
    models: REVIEW_MODELS.map((model) => model.split("/").pop()),
    providers: ["workbuddy-ai", "opendesign", "opencode-go"],
  };
  task.brief = briefPathFor(task);
  const tip = commit(
    mac,
    {
      [task.brief]: "material\n",
      "scripts/model-review/gateway.json": JSON.stringify({
        providers: task.providers.map((id) => ({ id })),
      }),
    },
    "brief",
  );
  task.tip = tip;
  run(mac, "push", "--quiet", "origin", "feature");
  const cloud = join(root, "cloud");
  execFileSync("git", [...GIT_SETTINGS, "clone", "--quiet", "-b", "feature", origin, cloud], {
    env: GIT_ENV,
    stdio: "ignore",
  });
  const record = (model, extra = {}) => ({
    at: "t",
    round: 1,
    mode: "code-review",
    model,
    head,
    base,
    previous: null,
    outcome: "ok",
    promptSha256: createHash("sha256").update("prompt\n").digest("hex"),
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
    bad({ providers: ["not-in-gateway-json"] }, "DELEGATE_INVALID providers");
    bad({ providers: [] }, "DELEGATE_INVALID providers");
    bad({ models: [] }, "DELEGATE_INVALID models");
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
      "--models",
      task.models.join(","),
      "--providers",
      "workbuddy-ai,opendesign,opencode-go",
    ]);
    expect(parsed.command).toBe("prompt");
    expect(parsed.task.brief).toBe(task.brief);
    expect(delegationPrompt(parsed.task)).toBe(delegationPrompt(task));
    expect(() => parseTask(["prompt", "--bogus"])).toThrow("DELEGATE_UNKNOWN --bogus");
    expect(() => parseTask(["check", "--reply-to", "session_abcdefgh1234"])).not.toThrow();
    expect(() => parseTask(["prompt", "--apply"])).toThrow("DELEGATE_NOT_FOR_COMMAND --apply");
    expect(() => parseTask(["wait", "--branch", "feature", "--mode", "plan"])).toThrow(
      "DELEGATE_NOT_FOR_COMMAND --mode",
    );
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
      f.commit(f.cloud, { [`.agents/reviews/${KEY}/later.md`]: "later\n" }, "after the check");
      f.push();
      f.run(f.mac, "fetch", "--quiet", "origin");
      expect(applyResult(f.task, { repo: f.mac, remote: result.remote })).toBe(remote);
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

describe("review delegation result check, hostile results", () => {
  const stage = (f, files, remove = []) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(f.cloud, path)), { recursive: true });
      writeFileSync(join(f.cloud, path), text);
    }
    for (const path of remove) rmSync(join(f.cloud, path));
  };
  const record = (f) => ({
    [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([f.record(deepseek), f.record(glm)]),
    ...f.files([deepseek, glm]),
  });
  const commitAll = (f, message) => {
    f.run(f.cloud, "add", "-A");
    f.run(f.cloud, "commit", "--quiet", "-m", message);
  };

  it(
    "[delegate] refuses symbolic links, deleted files and changes to old files",
    withFixture((f) => {
      const old = `.agents/reviews/${KEY}/verdicts.jsonl`;
      f.commit(f.mac, { [old]: "old\n" }, "old verdicts");
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, tip: f.run(f.mac, "rev-parse", "HEAD") };
      f.run(f.cloud, "pull", "--quiet", "--ff-only");
      const base = f.run(f.cloud, "rev-parse", "HEAD");
      const reset = () => {
        f.run(f.cloud, "reset", "--hard", "--quiet", base);
      };
      stage(f, record(f), []);
      rmSync(join(f.cloud, `.agents/reviews/${KEY}/round-1/${glm.split("/").pop()}.md`));
      symlinkSync(
        "/etc/passwd",
        join(f.cloud, `.agents/reviews/${KEY}/round-1/${glm.split("/").pop()}.md`),
      );
      commitAll(f, "symlink");
      f.push();
      expect(checkResult(task, { repo: f.mac }).reason).toContain("DELEGATION_IRREGULAR_FILE");
      reset();
      f.push(["--force"]);
      stage(f, record(f), [old]);
      commitAll(f, "delete");
      f.push();
      expect(checkResult(task, { repo: f.mac }).reason).toContain("DELEGATION_IRREGULAR_FILE");
      reset();
      f.push(["--force"]);
      stage(f, { ...record(f), [old]: "forged\n" });
      commitAll(f, "forged verdicts");
      f.push();
      expect(checkResult(task, { repo: f.mac }).reason).toContain("unexpected-file=");
    }),
  );

  it(
    "[delegate] refuses a merge commit and a history that touched code even if the final tree is clean",
    withFixture((f) => {
      stage(f, { "code.txt": "sneaky\n" });
      commitAll(f, "touch code");
      f.run(f.cloud, "-c", "user.name=t", "-c", "user.email=t@t", "revert", "--no-edit", "HEAD");
      stage(f, record(f));
      commitAll(f, "records");
      f.push();
      expect(checkResult(f.task, { repo: f.mac }).reason).toBe(
        'DELEGATION_OUTSIDE_RECORDS "code.txt"',
      );
      f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
      f.push(["--force"]);
      f.run(f.cloud, "checkout", "--quiet", "-b", "side");
      stage(f, record(f));
      commitAll(f, "side records");
      f.run(f.cloud, "checkout", "--quiet", "feature");
      stage(f, { [`.agents/reviews/${KEY}/note.md`]: "n\n" });
      commitAll(f, "note");
      f.run(f.cloud, "merge", "--no-ff", "--quiet", "-m", "merge", "side");
      f.push();
      expect(checkResult(f.task, { repo: f.mac }).reason).toBe("DELEGATION_MERGE_COMMIT");
    }),
  );

  it(
    "[delegate] checks the round, the models, the prompt hash and the outcome",
    withFixture((f) => {
      const tryRecords = (records, filesFor = [deepseek, glm]) => {
        stage(f, {
          [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger(records),
          ...f.files(filesFor),
        });
        commitAll(f, "attempt");
        f.push();
        const result = checkResult(f.task, { repo: f.mac });
        f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
        f.push(["--force"]);
        return result;
      };
      expect(
        tryRecords([f.record(deepseek, { round: 2 }), f.record(glm, { round: 2 })]).reason,
      ).toContain("round=2 expected=1");
      expect(tryRecords([f.record(deepseek)], [deepseek]).reason).toContain(`absent=${glm}`);
      expect(
        tryRecords([f.record(deepseek, { promptSha256: "0".repeat(64) }), f.record(glm)]).reason,
      ).toContain("prompt-hash=");
      const incomplete = tryRecords([f.record(deepseek, { outcome: "timeout" }), f.record(glm)]);
      expect(incomplete.status).toBe("ok");
      expect(incomplete.notOk).toEqual([deepseek]);
    }),
  );

  it(
    "[delegate] stops on a git failure instead of calling it a rewritten branch",
    withFixture((f) => {
      const task = { ...f.task, tip: "9".repeat(40) };
      expect(() => checkResult(task, { repo: f.mac })).toThrow("DELEGATE_GIT_FAILED");
    }),
  );
});

describe("review delegation command line", () => {
  const cli = (f, command, ...extra) => {
    const t = f.task;
    const result = spawnSync(
      process.execPath,
      [
        "scripts/model-review/delegate.mjs",
        command,
        "--repo",
        f.mac,
        "--mode",
        t.mode,
        "--pr",
        String(t.pr),
        "--base",
        t.base,
        "--head",
        t.head,
        "--branch",
        t.branch,
        "--tip",
        t.tip,
        "--models",
        t.models.join(","),
        ...extra,
      ],
      { encoding: "utf8" },
    );
    return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
  };

  it(
    "[delegate] exits 3 while waiting, 0 with the results, 5 when it refuses and 2 on bad usage",
    withFixture((f) => {
      expect(cli(f, "check")).toMatchObject({ status: 3 });
      expect(cli(f, "check").out).toMatch(/^DELEGATION_PENDING remote=/);
      f.cloudCommit({ "code.txt": "sneaky\n" });
      f.push();
      expect(cli(f, "check")).toMatchObject({
        status: 5,
        out: 'DELEGATION_OUTSIDE_RECORDS "code.txt"',
      });
      f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
      const remote = f.cloudCommit({});
      f.push(["--force"]);
      const done = cli(f, "check", "--apply");
      expect(done.status).toBe(0);
      expect(done.out).toContain("DELEGATION_RESULT_OK");
      expect(done.out).toContain(`DELEGATION_APPLIED head=${remote}`);
      expect(cli(f, "bogus")).toMatchObject({ status: 2, err: "DELEGATE_USAGE prompt|check|wait" });
      expect(cli(f, "prompt", "--apply")).toMatchObject({
        status: 2,
        err: "DELEGATE_NOT_FOR_COMMAND --apply",
      });
    }),
  );

  it(
    "[delegate] exits 4 and says so when a model did not finish, but still brings the records home",
    withFixture((f) => {
      f.commit(
        f.cloud,
        {
          [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
            f.record(deepseek, { outcome: "timeout" }),
            f.record(glm),
          ]),
          ...f.files([deepseek, glm]),
        },
        "one timed out",
      );
      f.push();
      const done = cli(f, "check", "--apply");
      expect(done.status).toBe(4);
      expect(done.out).toContain(`DELEGATION_RESULT_INCOMPLETE`);
      expect(done.out).toContain(`not-ok=${deepseek}`);
      expect(done.out).toContain("DELEGATION_APPLIED");
    }),
  );
});

describe("review delegation result check, odd ledgers and a broken remote", () => {
  it(
    "[delegate] refuses a result with no new record and one with a broken ledger",
    withFixture((f) => {
      f.commit(
        f.mac,
        { [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([f.record(deepseek)]) },
        "earlier",
      );
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, tip: f.run(f.mac, "rev-parse", "HEAD") };
      f.run(f.cloud, "pull", "--quiet", "--ff-only");
      f.commit(f.cloud, { [`.agents/reviews/${KEY}/note.md`]: "n\n" }, "note only");
      f.push();
      expect(checkResult(task, { repo: f.mac }).reason).toBe("DELEGATION_NO_NEW_RECORDS");
      f.commit(
        f.cloud,
        {
          [`.agents/reviews/${KEY}/usage.jsonl`]: `${f.ledger([f.record(deepseek)])}{"mode":"plan"}\n`,
        },
        "broken line",
      );
      f.push();
      expect(checkResult(task, { repo: f.mac }).reason).toMatch(/^DELEGATION_LEDGER_INVALID/);
    }),
  );

  it(
    "[delegate] stops on an unreachable origin instead of guessing",
    withFixture((f) => {
      f.run(f.mac, "remote", "set-url", "origin", join(f.root, "does-not-exist.git"));
      expect(() => checkResult(f.task, { repo: f.mac })).toThrow("DELEGATE_GIT_FAILED");
    }),
  );
});

describe("review delegation result check, legitimate edge cases", () => {
  const cloudFiles = (f, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(f.cloud, path)), { recursive: true });
      writeFileSync(join(f.cloud, path), text);
    }
  };
  const commitCloud = (f, message) => {
    f.run(f.cloud, "add", "-A");
    f.run(f.cloud, "commit", "--quiet", "-m", message);
    f.push();
  };

  it(
    "[delegate] accepts the unknown and none providers, rejects an invented one even without a list",
    withFixture((f) => {
      const task = { ...f.task, providers: undefined };
      const write = (providers) => {
        cloudFiles(f, {
          [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
            f.record(deepseek, { providers }),
            f.record(glm),
          ]),
          ...f.files([deepseek, glm]),
        });
        commitCloud(f, "providers");
        const result = checkResult(task, { repo: f.mac });
        f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
        f.push(["--force"]);
        return result;
      };
      expect(
        write({ unknown: { requests: 1, failed: 1 }, none: { requests: 1, failed: 1 } }).status,
      ).toBe("ok");
      expect(write({ "made-up": { requests: 1, failed: 0, credits: 1 } }).reason).toContain(
        "provider=made-up",
      );
    }),
  );

  it(
    "[delegate] refuses control characters anywhere in the new records",
    withFixture((f) => {
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek, { outcome: "ok\u001b[2J" }),
          f.record(glm),
        ]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "escape");
      expect(checkResult(f.task, { repo: f.mac }).reason).toBe("DELEGATION_CONTROL_CHARACTER");
    }),
  );

  it(
    "[delegate] refuses invisible direction-changing characters in the new records",
    withFixture((f) => {
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek, { outcome: "ok\u202e" }),
          f.record(glm),
        ]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "bidi");
      expect(checkResult(f.task, { repo: f.mac }).reason).toBe("DELEGATION_CONTROL_CHARACTER");
    }),
  );

  it(
    "[delegate] does not call a model incomplete when a rerun in the same round succeeded",
    withFixture((f) => {
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek, { outcome: "timeout" }),
          f.record(deepseek),
          f.record(glm),
        ]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "rerun");
      expect(checkResult(f.task, { repo: f.mac })).toMatchObject({ status: "ok", notOk: [] });
    }),
  );

  it(
    "[delegate] does not let a model's own failure be hidden by its success as a substitute",
    withFixture((f) => {
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek),
          f.record(glm, { outcome: "timeout" }),
          f.record(glm, { substitute: true, substituteFor: deepseek }),
        ]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "substitute");
      expect(checkResult(f.task, { repo: f.mac })).toMatchObject({ status: "ok", notOk: [glm] });
    }),
  );

  it(
    "[delegate] stops with a clear code when the handover gateway.json is not valid",
    withFixture((f) => {
      f.commit(f.mac, { "scripts/model-review/gateway.json": "{not json" }, "broken config");
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, providers: undefined, tip: f.run(f.mac, "rev-parse", "HEAD") };
      f.run(f.cloud, "pull", "--quiet", "origin", "feature");
      cloudFiles(f, { [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([f.record(deepseek)]) });
      commitCloud(f, "result");
      expect(() => checkResult(task, { repo: f.mac })).toThrow("DELEGATION_NO_GATEWAY_CONFIG");
    }),
  );

  it(
    "[delegate] checks the stored prompt file against promptFileSha256 when the prompt was masked",
    withFixture((f) => {
      const masked = "prompt [masked]\n";
      const sha = (text) => createHash("sha256").update(text).digest("hex");
      const attempt = (fileSha) => {
        cloudFiles(f, {
          [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
            f.record(deepseek, { promptFileSha256: fileSha }),
            f.record(glm),
          ]),
          ...f.files([deepseek, glm]),
          [`.agents/reviews/${KEY}/round-1/${deepseek.split("/").pop()}.prompt.md`]: masked,
        });
        commitCloud(f, "masked");
        const result = checkResult(f.task, { repo: f.mac });
        f.run(f.cloud, "reset", "--hard", "--quiet", f.task.tip);
        f.push(["--force"]);
        return result;
      };
      expect(attempt(sha(masked)).status).toBe("ok");
      expect(attempt(sha("other\n")).reason).toContain("prompt-hash=");
    }),
  );

  it(
    "[delegate] refuses appended ledger lines that repeat a line already in the ledger",
    withFixture((f) => {
      const earlier = f.record(deepseek, { round: 1, outcome: "timeout" });
      f.commit(f.mac, { [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([earlier]) }, "earlier");
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, tip: f.run(f.mac, "rev-parse", "HEAD"), round: 1 };
      f.run(f.cloud, "pull", "--quiet", "origin", "feature");
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([earlier, earlier]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "replay");
      expect(checkResult(task, { repo: f.mac }).reason).toBe("DELEGATION_LEDGER_DUPLICATE");
    }),
  );

  it(
    "[delegate] counts round folders that already exist at the handover when it expects the next round",
    withFixture((f) => {
      f.commit(
        f.mac,
        { [`.agents/reviews/${KEY}/round-1/orphan.md`]: "x\n" },
        "folder without record",
      );
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, tip: f.run(f.mac, "rev-parse", "HEAD") };
      f.run(f.cloud, "pull", "--quiet", "--ff-only");
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek, { round: 2 }),
          f.record(glm, { round: 2 }),
        ]),
        ...Object.fromEntries(
          Object.entries(f.files([deepseek, glm])).map(([path, text]) => [
            path.replace("round-1", "round-2"),
            text,
          ]),
        ),
      });
      commitCloud(f, "round two");
      expect(checkResult(task, { repo: f.mac })).toMatchObject({ status: "ok" });
    }),
  );

  it(
    "[delegate] lets a re-run move the earlier attempt aside, including its error file",
    withFixture((f) => {
      const name = glm.split("/").pop();
      const dir = `.agents/reviews/${KEY}/round-1`;
      f.commit(
        f.mac,
        {
          [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
            f.record(deepseek),
            f.record(glm, { outcome: "timeout" }),
          ]),
          ...f.files([deepseek, glm]),
          [`${dir}/${name}.stderr.txt`]: "failed\n",
        },
        "first attempt",
      );
      f.run(f.mac, "push", "--quiet", "origin", "feature");
      const task = { ...f.task, tip: f.run(f.mac, "rev-parse", "HEAD"), round: 1, models: [name] };
      f.run(f.cloud, "pull", "--quiet", "--ff-only");
      f.run(f.cloud, "mv", `${dir}/${name}.stderr.txt`, `${dir}/${name}.attempt-1.stderr.txt`);
      cloudFiles(f, {
        [`${dir}/${name}.attempt-1.md`]: "answer\n",
        [`${dir}/${name}.attempt-1.prompt.md`]: "prompt\n",
        [`${dir}/${name}.md`]: "second answer\n",
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek),
          f.record(glm, { outcome: "timeout" }),
          f.record(glm),
        ]),
      });
      commitCloud(f, "re-run");
      expect(checkResult(task, { repo: f.mac })).toMatchObject({ status: "ok" });
      f.run(f.cloud, "rm", "--quiet", `${dir}/${name}.attempt-1.stderr.txt`);
      commitCloud(f, "drop the moved error file");
      expect(checkResult(task, { repo: f.mac }).reason).toContain("DELEGATION_IRREGULAR_FILE");
    }),
  );

  it(
    "[delegate] expects only the configured default models when the task names none, first round included",
    withFixture((f) => {
      const task = { ...f.task, models: undefined };
      expect(parseArgs(reviewArgv(task)).models).toEqual(DEFAULT_REVIEW_MODELS);
      expect(reviewArgv(task).join(" ")).toContain(
        `--models ${DEFAULT_REVIEW_MODELS.map((model) => model.split("/").pop()).join(",")} `,
      );
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger(
          DEFAULT_REVIEW_MODELS.map((m) => f.record(m)),
        ),
        ...f.files(DEFAULT_REVIEW_MODELS),
      });
      commitCloud(f, "default models only");
      expect(checkResult(task, { repo: f.mac })).toMatchObject({ status: "ok", notOk: [] });
      const unasked = REVIEW_MODELS.find((model) => !DEFAULT_REVIEW_MODELS.includes(model));
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          ...DEFAULT_REVIEW_MODELS.map((m) => f.record(m)),
          f.record(unasked),
        ]),
        ...f.files([unasked]),
      });
      commitCloud(f, "a model nobody asked for");
      expect(checkResult(task, { repo: f.mac }).reason).toContain(`model=${unasked}`);
    }),
  );

  it(
    "[delegate] does not call a result incomplete when a substitute covered the failed model, and survives an odd model name",
    withFixture((f) => {
      const task = { ...f.task, previous: f.task.base, models: undefined };
      const base = { previous: f.task.base };
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek, { ...base, outcome: "api-error" }),
          f.record(glm, { ...base, substitute: true, substituteFor: deepseek }),
        ]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "substituted");
      expect(checkResult(task, { repo: f.mac })).toMatchObject({ status: "ok", notOk: [] });
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([f.record("opencode-go/*")]),
      });
      commitCloud(f, "odd model");
      expect(checkResult(task, { repo: f.mac }).reason).toContain("model=opencode-go/*");
    }),
  );

  it(
    "[delegate] prices a result with an unknown cost the way the review script does",
    withFixture((f) => {
      cloudFiles(f, {
        [`.agents/reviews/${KEY}/usage.jsonl`]: f.ledger([
          f.record(deepseek, { costUnknown: true }),
          f.record(glm),
        ]),
        ...f.files([deepseek, glm]),
      });
      commitCloud(f, "unknown cost");
      const result = checkResult(f.task, { repo: f.mac });
      expect(result.estimated).toBe(true);
      expect(result.spent).toBeGreaterThanOrEqual(0.2);
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
    await expect(
      waitForBranch({ branch: "b", tip: "a", lsRemote: () => "a", intervalSeconds: 0 }),
    ).rejects.toThrow("DELEGATE_INVALID interval");
    await expect(
      waitForBranch({
        branch: "b",
        tip: "a",
        lsRemote: () => "a",
        minutes: 1,
        intervalSeconds: 600,
      }),
    ).rejects.toThrow("DELEGATE_INVALID interval");
    await expect(
      waitForBranch({ branch: "b", tip: "a", lsRemote: () => "a", minutes: Number.NaN }),
    ).rejects.toThrow("DELEGATE_INVALID minutes");
    await expect(
      waitForBranch({ branch: "b", tip: "a", lsRemote: () => "a", minutes: 100000 }),
    ).rejects.toThrow("DELEGATE_INVALID minutes");
    let flaky = 0;
    const survived = await waitForBranch({
      branch: "b",
      tip: "a",
      lsRemote: () => {
        flaky += 1;
        if (flaky <= 2) throw new Error("DELEGATE_GIT_FAILED ls-remote");
        return "z";
      },
      sleep: async () => {},
    });
    expect(survived).toEqual({ moved: true, sha: "z" });
    await expect(
      waitForBranch({
        branch: "b",
        tip: "a",
        lsRemote: () => {
          throw new Error("DELEGATE_GIT_FAILED ls-remote");
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("DELEGATE_GIT_FAILED");
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
    expect(polls).toBe(6);
  });
});
