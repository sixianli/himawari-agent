import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateTimeoutMs,
  createGithub,
  createRepo,
  emptyState,
  failedLabel,
  processQueue,
  queueLabel,
  reviewChecker,
  reviewPaused,
  runGraceMs,
  splitGroups,
  touchesProtected,
  validateState,
} from "../../scripts/ci/merge-queue.mjs";
import { REVIEW_NOT_COVERED_EXIT } from "../../scripts/model-review/exit-codes.mjs";

const repository = "sixianli/himawari-agent";
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const temporaries = [];
afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

function setup({ mode = "fast" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mq-test-"));
  temporaries.push(root);
  const origin = path.join(root, "origin.git");
  git(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
  const scratch = path.join(root, "scratch");
  git(root, ["clone", "--quiet", origin, scratch]);
  git(scratch, ["config", "diff.renames", "true"]);
  git(scratch, ["checkout", "--quiet", "-B", "main"]);
  write(scratch, {
    DELIVERY_MODE: `${mode}\n`,
    "a.txt": "a\n",
    "b.txt": "b\n",
    "ci/policy.json": "{}\n",
  });
  git(scratch, ["add", "-A"]);
  git(scratch, ["commit", "--quiet", "-m", "seed"]);
  git(scratch, ["push", "--quiet", "origin", "main"]);
  const runner = path.join(root, "runner");
  git(root, ["clone", "--quiet", origin, runner]);
  const fake = new FakeGithub({ origin, scratch });
  return { root, origin, scratch, runner, fake, repo: createRepo({ cwd: runner }) };
}

function mainSha(origin) {
  return git(origin, ["rev-parse", "refs/heads/main"]);
}

class FakeGithub {
  constructor({ origin, scratch }) {
    this.repository = repository;
    this.origin = origin;
    this.scratch = scratch;
    this.prs = new Map();
    this.checks = new Map();
    this.runs = [];
    this.calls = [];
    this.nextRun = 1000;
    this.clock = 0;
    this.mergeTamper = null;
  }
  addPr(number, files, { check = "success", label = true, from = "main", moves = [] } = {}) {
    git(this.scratch, ["fetch", "--quiet", "origin", "main"]);
    git(this.scratch, [
      "checkout",
      "--quiet",
      "-B",
      `pr-${number}`,
      from === "main" ? "origin/main" : from,
    ]);
    write(this.scratch, files);
    for (const [from, to] of moves) {
      mkdirSync(path.dirname(path.join(this.scratch, to)), { recursive: true });
      git(this.scratch, ["mv", from, to]);
    }
    git(this.scratch, ["add", "-A"]);
    git(this.scratch, ["commit", "--quiet", "-m", `pr ${number}`]);
    const head = git(this.scratch, ["rev-parse", "HEAD"]);
    git(this.scratch, ["push", "--quiet", "--force", "origin", `${head}:refs/pull/${number}/head`]);
    this.clock += 1;
    this.prs.set(number, {
      number,
      state: "open",
      draft: false,
      base: { ref: "main", repo: { full_name: repository } },
      head: { sha: head, repo: { full_name: repository } },
      labels: label ? [{ name: queueLabel }] : [],
      labeledAt: `2026-11-14T00:00:${String(this.clock).padStart(2, "0")}Z`,
    });
    this.checks.set(head, check);
    return head;
  }
  async listQueued() {
    this.calls.push(["listQueued"]);
    return [...this.prs.values()]
      .filter((pr) => pr.state === "open" && pr.labels.some((l) => l.name === queueLabel))
      .map((pr) => pr.number);
  }
  async pull(number) {
    return structuredClone(this.prs.get(number));
  }
  async labeledAt(number) {
    return this.prs.get(number).labeledAt;
  }
  async requiredCheck(sha) {
    const state = this.checks.get(sha) ?? "missing";
    return { state, url: `check-${sha.slice(0, 7)}` };
  }
  async dispatch(branch, baseSha) {
    this.calls.push(["dispatch", branch, baseSha]);
    const sha = git(this.origin, ["rev-parse", `refs/heads/${branch}`]);
    this.nextRun += 1;
    this.runs.push({
      id: this.nextRun,
      attempt: 1,
      branch,
      sha,
      status: "queued",
      conclusion: null,
      required: null,
      url: `run-${this.nextRun}`,
    });
  }
  async findRun(branch, sha) {
    const run = this.runs.filter((r) => r.branch === branch && r.sha === sha).at(-1);
    return run ? { ...run } : null;
  }
  async requiredJobConclusion(run) {
    return this.runs.find((r) => r.id === run.id).required;
  }
  async cancel(runId) {
    this.calls.push(["cancel", runId]);
    const run = this.runs.find((r) => r.id === runId);
    run.status = "completed";
    run.conclusion = "cancelled";
  }
  async merge(number, sha) {
    this.calls.push(["merge", number, sha]);
    const pr = this.prs.get(number);
    if (pr.head.sha !== sha) return { merged: false, status: 409 };
    git(this.scratch, ["fetch", "--quiet", "origin", "main", `refs/pull/${number}/head`]);
    git(this.scratch, ["checkout", "--quiet", "-B", "merge-work", "origin/main"]);
    git(this.scratch, ["merge", "--quiet", "--no-ff", "-m", `Merge pull request #${number}`, sha]);
    if (this.mergeTamper === number) {
      write(this.scratch, { "tamper.txt": "x\n" });
      git(this.scratch, ["add", "-A"]);
      git(this.scratch, ["commit", "--quiet", "--amend", "--no-edit"]);
    }
    git(this.scratch, ["push", "--quiet", "origin", "HEAD:main"]);
    pr.state = "closed";
    return { merged: true };
  }
  async removeLabel(number, label) {
    this.calls.push(["removeLabel", number, label]);
    const pr = this.prs.get(number);
    pr.labels = pr.labels.filter((l) => l.name !== label);
  }
  async addLabel(number, label) {
    this.calls.push(["addLabel", number, label]);
    this.prs.get(number).labels.push({ name: label });
  }
  async comment(number, body) {
    this.calls.push(["comment", number, body]);
  }
  finish(conclusion, required = conclusion) {
    const run = this.runs.at(-1);
    run.status = "completed";
    run.conclusion = conclusion;
    run.required = required;
  }
}

const okReview = () => ({ ok: true, output: "REVIEW_CURRENT" });
let tag = 0;
const nextTag = () => {
  tag += 1;
  return `run-${tag}`;
};
const step = (env, overrides = {}) =>
  processQueue({
    github: env.fake,
    repo: env.repo,
    checkReview: okReview,
    runTag: nextTag(),
    now: () => Date.parse("2026-11-14T01:00:00Z"),
    ...overrides,
  });
const remoteBranches = (origin) =>
  git(origin, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n");
const remoteState = (origin) =>
  JSON.parse(git(origin, ["show", "refs/heads/merge-queue-state:state.json"]));
const commentsFor = (fake, number) =>
  fake.calls.filter((c) => c[0] === "comment" && c[1] === number).map((c) => c[2]);

describe("review pause", () => {
  it("lets every PR through the review step while OpenCode review is paused", () => {
    expect(reviewPaused(1, "a", "b")).toEqual({ ok: true, broken: false, output: "REVIEW_PAUSED" });
  });
});

describe("合并队列 [ADR-0268]", () => {
  it("把就绪的 PR 按加标签顺序合成候选，推到唯一的 mq 分支并以当前 main 为基线触发完整 CI", async () => {
    const env = setup();
    const head2 = env.fake.addPr(2, { "c.txt": "c\n" });
    const head1 = env.fake.addPr(1, { "d.txt": "d\n" });
    const main = mainSha(env.origin);
    const state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([2, 1]);
    expect(state.candidate.prs.map((pr) => pr.head)).toEqual([head2, head1]);
    expect(state.candidate.base).toBe(main);
    const dispatch = env.fake.calls.find((c) => c[0] === "dispatch");
    expect(dispatch[1]).toMatch(/^mq\/run-\d+$/);
    expect(dispatch[2]).toBe(main);
    expect(remoteBranches(env.origin)).toContain(`refs/heads/${state.candidate.branch}`);
    expect(remoteState(env.origin)).toEqual(state);
    expect(git(env.origin, ["show", `${state.candidate.sha}:c.txt`])).toBe("c");
  });

  it("候选的完整 CI 通过后逐个合并，每次合并后核对 main 的树和候选一致，去掉标签并删掉候选分支", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    const first = await step(env);
    env.fake.finish("success");
    const state = await step(env);
    expect(state.candidate).toBeNull();
    expect(state.stopped).toBeNull();
    expect(env.fake.calls.filter((c) => c[0] === "merge").map((c) => c[1])).toEqual([1, 2]);
    expect(git(env.origin, ["rev-parse", "main^{tree}"])).toBe(
      git(env.origin, ["rev-parse", `${first.candidate.sha}^{tree}`]),
    );
    expect(remoteBranches(env.origin)).not.toContain(`refs/heads/${first.candidate.branch}`);
    expect(env.fake.prs.get(1).labels).toEqual([]);
    expect(commentsFor(env.fake, 2)[0]).toContain("合并队列已合入 main");
  });

  it("多个 PR 的候选失败后拆成两半分别测；单个 PR 的候选失败才移出队列", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    env.fake.addPr(3, { "e.txt": "e\n" });
    await step(env);
    env.fake.finish("failure");
    let state = await step(env);
    expect(state.groups).toEqual([[1, 2], [3]]);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1, 2]);
    expect(state.candidate.fromGroup).toBe(true);
    expect(env.fake.calls.some((c) => c[0] === "addLabel")).toBe(false);

    env.fake.finish("failure");
    state = await step(env);
    expect(state.groups).toEqual([[1], [2], [3]]);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1]);

    env.fake.finish("failure");
    state = await step(env);
    expect(env.fake.prs.get(1).labels.map((l) => l.name)).toEqual([failedLabel]);
    expect(commentsFor(env.fake, 1)[0]).toContain("完整 CI 没过");
    expect(state.groups).toEqual([[2], [3]]);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([2]);

    env.fake.finish("success");
    state = await step(env);
    expect(state.groups).toEqual([[3]]);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([3]);
    env.fake.finish("success");
    state = await step(env);
    expect(state).toMatchObject({ candidate: null, groups: [] });
    expect(env.fake.calls.filter((c) => c[0] === "merge").map((c) => c[1])).toEqual([2, 3]);
  });

  it("两半各自都过、合在一起才失败时，先合入的一半成为新 main，后一半在它上面重测并继续拆，直到找出单个 PR", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    await step(env);
    env.fake.finish("failure");
    let state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1]);
    env.fake.finish("success");
    state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([2]);
    expect(state.candidate.base).toBe(mainSha(env.origin));
    env.fake.finish("failure");
    state = await step(env);
    expect(state.candidate).toBeNull();
    expect(state.groups).toEqual([]);
    expect(env.fake.prs.get(2).labels.map((l) => l.name)).toEqual([failedLabel]);
  });

  it("改了 .github、ci 或 scripts/ci 的 PR 不进候选，移出队列并说明要按原流程手动合并", async () => {
    const env = setup();
    env.fake.addPr(1, { "ci/policy.json": '{"x":1}\n' });
    env.fake.addPr(2, { "scripts/ci/run.mjs": "x\n" });
    env.fake.addPr(3, { "c.txt": "c\n" });
    const state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([3]);
    expect(commentsFor(env.fake, 1)[0]).toContain("ci/policy.json");
    expect(commentsFor(env.fake, 2)[0]).toContain("scripts/ci/run.mjs");
    expect(env.fake.prs.get(1).labels.map((l) => l.name)).toEqual([failedLabel]);
  });

  it("把 CI 自身的文件改名移出保护目录的 PR 同样移出队列", async () => {
    const env = setup();
    env.fake.addPr(1, {}, { moves: [["ci/policy.json", "docs/policy.json"]] });
    env.fake.addPr(2, { "c.txt": "c\n" });
    const state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([2]);
    expect(commentsFor(env.fake, 1)[0]).toContain("ci/policy.json");
    expect(env.fake.prs.get(1).labels.map((l) => l.name)).toEqual([failedLabel]);
  });

  it("PR 上的 ci/required 还在跑或还没有时不进候选也不移出；失败时移出", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" }, { check: "pending" });
    env.fake.addPr(2, { "d.txt": "d\n" }, { check: "missing" });
    env.fake.addPr(3, { "e.txt": "e\n" }, { check: "failure" });
    const state = await step(env);
    expect(state.candidate).toBeNull();
    expect(env.fake.prs.get(1).labels.map((l) => l.name)).toEqual([queueLabel]);
    expect(env.fake.prs.get(2).labels.map((l) => l.name)).toEqual([queueLabel]);
    expect(env.fake.prs.get(3).labels.map((l) => l.name)).toEqual([failedLabel]);
    expect(env.fake.calls.some((c) => c[0] === "dispatch")).toBe(false);
  });

  it("复核没覆盖最新提交的 PR 移出队列，评论里带上复核检查的输出", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    const state = await step(env, {
      checkReview: () => ({ ok: false, output: "REVIEW_MISSING pr=1 unreviewed c.txt" }),
    });
    expect(state.candidate).toBeNull();
    expect(commentsFor(env.fake, 1)[0]).toContain("REVIEW_MISSING pr=1 unreviewed c.txt");
  });

  it("和排在前面的 PR 冲突的 PR 移出队列，其余照常进候选", async () => {
    const env = setup();
    env.fake.addPr(1, { "a.txt": "one\n" });
    env.fake.addPr(2, { "a.txt": "two\n" });
    env.fake.addPr(3, { "c.txt": "c\n" });
    const state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1, 3]);
    expect(commentsFor(env.fake, 2)[0]).toContain("冲突");
  });

  it("候选还在跑时 main 被别的方式改了：取消候选的 CI、丢掉候选，在新 main 上重建", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    const first = await step(env);
    git(env.scratch, ["fetch", "--quiet", "origin"]);
    git(env.scratch, ["checkout", "--quiet", "-B", "side", "origin/main"]);
    write(env.scratch, { "z.txt": "z\n" });
    git(env.scratch, ["add", "-A"]);
    git(env.scratch, ["commit", "--quiet", "-m", "side"]);
    git(env.scratch, ["push", "--quiet", "origin", "HEAD:main"]);
    const state = await step(env);
    expect(env.fake.calls).toContainEqual(["cancel", env.fake.runs[0].id]);
    expect(remoteBranches(env.origin)).not.toContain(`refs/heads/${first.candidate.branch}`);
    expect(state.candidate.base).toBe(mainSha(env.origin));
    expect(state.candidate.branch).not.toBe(first.candidate.branch);
  });

  it("候选通过后、合并前 PR 有新推送或被去掉标签：一个都不合，丢掉候选", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    await step(env);
    env.fake.finish("success");
    env.fake.prs.get(2).labels = [];
    const state = await step(env);
    expect(env.fake.calls.some((c) => c[0] === "merge")).toBe(false);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1]);
  });

  it("合并后 main 的树和候选里那一步不一致时停下队列，不再合后面的 PR", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    await step(env);
    env.fake.finish("success");
    env.fake.mergeTamper = 1;
    const state = await step(env);
    expect(state.stopped.reason).toContain("#1");
    expect(remoteBranches(env.origin).filter((b) => b.startsWith("refs/heads/mq/"))).toEqual([]);
    expect(env.fake.calls.filter((c) => c[0] === "merge").map((c) => c[1])).toEqual([1]);
    expect(remoteState(env.origin).stopped).not.toBeNull();
    env.fake.mergeTamper = null;
    env.fake.addPr(3, { "e.txt": "e\n" });
    const after = await step(env);
    expect(after.candidate).toBeNull();
    expect(env.fake.calls.filter((c) => c[0] === "dispatch")).toHaveLength(1);
    const resumed = await step(env, { resume: true });
    expect(resumed.stopped).toBeNull();
    expect(resumed.candidate.prs.map((pr) => pr.number)).toContain(3);
  });

  it("候选的 CI 被取消时丢掉候选重建，不移出 PR；超时则取消后重建", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    await step(env);
    env.fake.finish("cancelled");
    let state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1]);
    expect(env.fake.calls.some((c) => c[0] === "addLabel")).toBe(false);
    const created = Date.parse(state.candidate.createdAt);
    state = await step(env, { now: () => created + candidateTimeoutMs + 1 });
    expect(state.undecided).toBe(2);
    expect(env.fake.calls.filter((c) => c[0] === "cancel")).toHaveLength(1);
    expect(state.candidate.branch).toMatch(/^mq\//);
  });

  it("触发后迟迟找不到候选的运行时丢掉候选重建", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    const first = await step(env);
    env.fake.runs = [];
    const waiting = await step(env);
    expect(waiting.candidate.branch).toBe(first.candidate.branch);
    const created = Date.parse(first.candidate.createdAt);
    const state = await step(env, { now: () => created + runGraceMs + 1 });
    expect(state.candidate.branch).not.toBe(first.candidate.branch);
  });

  it.each([
    ["success", "skipped"],
    ["startup_failure", null],
    ["timed_out", "cancelled"],
    ["failure", null],
  ])(
    "CI 结论 %s、ci/required 为 %s 时不算 PR 的错：不合并、不移出，丢掉候选重建",
    async (conclusion, required) => {
      const env = setup();
      env.fake.addPr(1, { "c.txt": "c\n" });
      const first = await step(env);
      env.fake.finish(conclusion, required);
      const state = await step(env);
      expect(env.fake.calls.some((c) => c[0] === "merge")).toBe(false);
      expect(env.fake.calls.some((c) => c[0] === "addLabel")).toBe(false);
      expect(state.candidate.branch).not.toBe(first.candidate.branch);
      expect(remoteBranches(env.origin)).not.toContain(`refs/heads/${first.candidate.branch}`);
    },
  );

  it("候选的完整 CI 连续 3 次没有结论时停下队列，人工恢复后从零计数", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    await step(env);
    let state;
    for (let round = 1; round <= 3; round += 1) {
      env.fake.finish("startup_failure", null);
      state = await step(env);
      expect(state.undecided).toBe(round);
    }
    expect(state.stopped.reason).toContain("连续 3 次");
    expect(state.candidate).toBeNull();
    expect(remoteBranches(env.origin).filter((b) => b.startsWith("refs/heads/mq/"))).toEqual([]);
    expect(env.fake.calls.filter((c) => c[0] === "dispatch")).toHaveLength(3);
    const resumed = await step(env, { resume: true });
    expect(resumed).toMatchObject({ stopped: null, undecided: 0 });
    expect(resumed.candidate.prs.map((pr) => pr.number)).toEqual([1]);
    env.fake.finish("success");
    expect((await step(env)).undecided).toBe(0);
  });

  it("CI 给出结论后计数清零，即使随后因 main 被改而丢掉候选；找不到运行也计入没有结论", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    await step(env);
    env.fake.finish("startup_failure", null);
    expect((await step(env)).undecided).toBe(1);
    env.fake.finish("success");
    git(env.scratch, ["fetch", "--quiet", "origin"]);
    git(env.scratch, ["checkout", "--quiet", "-B", "side", "origin/main"]);
    write(env.scratch, { "z.txt": "z\n" });
    git(env.scratch, ["add", "-A"]);
    git(env.scratch, ["commit", "--quiet", "-m", "side"]);
    git(env.scratch, ["push", "--quiet", "origin", "HEAD:main"]);
    let state = await step(env);
    expect(state.undecided).toBe(0);
    expect(env.fake.calls.some((c) => c[0] === "merge")).toBe(false);
    for (let round = 1; round <= 3; round += 1) {
      env.fake.runs = [];
      const created = Date.parse(state.candidate.createdAt);
      state = await step(env, { now: () => created + runGraceMs + 1 });
      expect(state.undecided).toBe(round);
    }
    expect(state.stopped.reason).toContain("run-missing");
  });

  it("复核检查没有正常退出时这一轮不建候选，不移出，也不再检查后面的 PR", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    const checked = [];
    const state = await step(env, {
      checkReview: (number) => {
        checked.push(number);
        return { ok: false, broken: true, output: "x".repeat(5000) };
      },
    });
    expect(checked).toEqual([1]);
    expect(state.candidate).toBeNull();
    expect(state.reviewBroken).toBe(1);
    expect(env.fake.prs.get(1).labels.map((l) => l.name)).toEqual([queueLabel]);
    expect(env.fake.calls.some((c) => c[0] === "comment")).toBe(false);
  });

  it("复核检查连续 3 轮没有正常退出时停下队列；中途正常退出一次就清零；出问题的那轮不动待测分组", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    await step(env);
    env.fake.finish("failure");
    let state = await step(env);
    expect(state.groups).toEqual([[1], [2]]);
    env.fake.finish("success");
    state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([2]);
    env.fake.runs.at(-1).status = "completed";
    env.fake.runs.at(-1).conclusion = "cancelled";
    env.fake.runs.at(-1).required = "cancelled";
    const broken = () => ({ ok: false, broken: true, output: "killed" });
    state = await step(env, { checkReview: broken });
    expect(state).toMatchObject({ candidate: null, groups: [[2]], reviewBroken: 1 });
    state = await step(env, { checkReview: broken });
    expect(state.reviewBroken).toBe(2);
    state = await step(env);
    expect(state.reviewBroken).toBe(0);
    env.fake.runs.at(-1).status = "completed";
    env.fake.runs.at(-1).conclusion = "cancelled";
    env.fake.runs.at(-1).required = "cancelled";
    for (let round = 1; round <= 3; round += 1) state = await step(env, { checkReview: broken });
    expect(state.stopped.reason).toContain("复核检查连续 3 轮");
    expect(env.fake.prs.get(2).labels.map((l) => l.name)).toEqual([queueLabel]);
  });

  it("状态里没有的 mq 分支（上次推了分支却没存下状态）在建新候选前删掉，不建候选时不动", async () => {
    const env = setup();
    git(env.origin, ["update-ref", "refs/heads/mq/orphan", mainSha(env.origin)]);
    await step(env);
    expect(remoteBranches(env.origin)).toContain("refs/heads/mq/orphan");
    env.fake.addPr(1, { "c.txt": "c\n" });
    const state = await step(env);
    const branches = remoteBranches(env.origin).filter((b) => b.startsWith("refs/heads/mq/"));
    expect(branches).toEqual([`refs/heads/${state.candidate.branch}`]);
  });

  it("完整模式下队列什么都不做", async () => {
    const env = setup({ mode: "full" });
    env.fake.addPr(1, { "c.txt": "c\n" });
    const state = await step(env);
    expect(state).toEqual(emptyState());
    expect(env.fake.calls.some((c) => c[0] === "dispatch")).toBe(false);
  });

  it("草稿、来自 fork 或目标不是 main 的 PR 移出队列", async () => {
    const env = setup();
    env.fake.addPr(1, { "c.txt": "c\n" });
    env.fake.addPr(2, { "d.txt": "d\n" });
    env.fake.addPr(3, { "e.txt": "e\n" });
    env.fake.prs.get(1).draft = true;
    env.fake.prs.get(2).head.repo.full_name = "someone/fork";
    env.fake.prs.get(3).base.ref = "dev";
    const state = await step(env);
    expect(state.candidate).toBeNull();
    for (const n of [1, 2, 3])
      expect(env.fake.prs.get(n).labels.map((l) => l.name)).toEqual([failedLabel]);
  });

  it("一批最多 5 个 PR", async () => {
    const env = setup();
    for (let n = 1; n <= 7; n += 1) env.fake.addPr(n, { [`f${n}.txt`]: `${n}\n` });
    const state = await step(env);
    expect(state.candidate.prs.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("合并队列的辅助逻辑 [ADR-0268]", () => {
  it("只认 .github、ci、scripts/ci 及其下的文件，同名前缀的其他目录不算", () => {
    expect(
      touchesProtected([
        ".github/workflows/ci.yml",
        "ci/policy.json",
        "scripts/ci/x.mjs",
        "ci",
        "circle.txt",
        "scripts/cil/x",
        "docs/ci/a.md",
      ]),
    ).toEqual([".github/workflows/ci.yml", "ci/policy.json", "scripts/ci/x.mjs", "ci"]);
  });

  it("拆分时前一半多一个，剩下的分组排在后面", () => {
    expect(splitGroups([1, 2, 3], [[9]])).toEqual([[1, 2], [3], [9]]);
  });

  it("状态文件格式不对时拒绝", () => {
    expect(() => validateState({ version: 2 })).toThrow("MQ_STATE_VERSION");
    expect(() => validateState({ ...emptyState(), groups: [[]] })).toThrow("MQ_STATE_GROUPS");
    expect(() => validateState({ ...emptyState(), undecided: -1 })).toThrow("MQ_STATE_UNDECIDED");
    expect(() =>
      validateState({ ...emptyState(), candidate: { branch: "x", sha: "1".repeat(40) } }),
    ).toThrow("MQ_STATE_CANDIDATE");
  });

  it("复核检查在 PR 头的临时检出上运行 main 的复核脚本，主线基准用 main 和 PR 头的共同祖先", () => {
    const env = setup();
    const head = env.fake.addPr(1, { "c.txt": "c\n" });
    git(env.scratch, ["checkout", "--quiet", "-B", "side", "origin/main"]);
    write(env.scratch, { "z.txt": "z\n" });
    git(env.scratch, ["add", "-A"]);
    git(env.scratch, ["commit", "--quiet", "-m", "side"]);
    git(env.scratch, ["push", "--quiet", "origin", "HEAD:main"]);
    const base = git(env.origin, ["rev-parse", "main~1"]);
    const script = path.join(env.root, "fake-review.mjs");
    writeFileSync(
      script,
      'import { execFileSync } from "node:child_process";\nconst a = process.argv.slice(2);\nconst repo = a[a.indexOf("--repo") + 1];\nconsole.log(JSON.stringify({ a, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() }));\nprocess.exitCode = a.includes("fail") ? 5 : 0;\n',
    );
    const main = env.repo.fetchMain();
    env.repo.fetchPull(1);
    const result = reviewChecker({ repo: env.repo, script })(1, head, main);
    expect(result.ok).toBe(true);
    const printed = JSON.parse(result.output);
    expect(printed.head).toBe(head);
    expect(printed.a.slice(0, 3)).toEqual(["--assert-reviewed", "--pr", "1"]);
    expect(printed.a[printed.a.indexOf("--main-ref") + 1]).toBe(base);
    expect(git(env.runner, ["worktree", "list"]).split("\n")).toHaveLength(1);
    const slow = path.join(env.root, "slow-review.mjs");
    writeFileSync(slow, "setTimeout(() => {}, 60_000);\n");
    const stuck = reviewChecker({ repo: env.repo, script: slow, timeout: 300 })(1, head, main);
    expect(stuck).toMatchObject({ ok: false, broken: true });
    expect(reviewChecker({ repo: env.repo, script })(1, head, main).broken).toBe(false);
    const exits = path.join(env.root, "exit-review.mjs");
    writeFileSync(exits, "process.exitCode = Number(process.env.MQ_TEST_EXIT);\n");
    const verdictFor = (code) => {
      process.env.MQ_TEST_EXIT = String(code);
      try {
        return reviewChecker({ repo: env.repo, script: exits })(1, head, main);
      } finally {
        delete process.env.MQ_TEST_EXIT;
      }
    };
    expect(verdictFor(REVIEW_NOT_COVERED_EXIT)).toMatchObject({ ok: false, broken: false });
    for (const code of [1, 2, 3, 4, 130, 143])
      expect(verdictFor(code)).toMatchObject({ ok: false, broken: true });
    expect(git(env.runner, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("GitHub 接口：加标签前先建标签，标签已存在（422 already_exists）不算错，其他 422 照样报错", async () => {
    const seen = [];
    let labelError = "already_exists";
    const request = async (url, init) => {
      seen.push([init.method, url.replace(/^.*\/repos\/[^/]+\/[^/]+/u, ""), init.body]);
      const creating = url.endsWith("/repos/sixianli/himawari-agent/labels");
      const status = creating ? 422 : 200;
      const body = creating
        ? JSON.stringify({
            message: "m".repeat(400),
            errors: [{ resource: "Label", code: labelError }],
          })
        : "[]";
      return { ok: status === 200, status, text: async () => body };
    };
    const github = createGithub({ token: "t", repository, request });
    await github.addLabel(7, failedLabel);
    expect(seen.map(([method, route]) => [method, route])).toEqual([
      ["POST", "/labels"],
      ["POST", "/issues/7/labels"],
    ]);
    expect(JSON.parse(seen[0][2]).name).toBe(failedLabel);
    labelError = "invalid";
    await expect(github.addLabel(7, failedLabel)).rejects.toThrow(/^MQ_GITHUB_422/u);
  });

  it("GitHub 接口：合并遇到 405 时重试，四次都失败返回未合并；找运行只认同分支同提交的 ci.yml 手动触发", async () => {
    const seen = [];
    const responses = [405, 405, 200];
    const request = async (url, init) => {
      seen.push([init.method, url, init.body]);
      if (url.endsWith("/merge")) {
        const status = responses.shift() ?? 405;
        return { ok: status === 200, status, text: async () => "{}" };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            workflow_runs: [
              {
                id: 5,
                run_attempt: 1,
                head_branch: "mq/1",
                head_sha: "a".repeat(40),
                event: "workflow_dispatch",
                path: ".github/workflows/ci.yml",
                repository: { full_name: repository },
                status: "completed",
                conclusion: "success",
              },
              {
                id: 9,
                run_attempt: 1,
                head_branch: "mq/1",
                head_sha: "b".repeat(40),
                event: "workflow_dispatch",
                path: ".github/workflows/ci.yml",
                repository: { full_name: repository },
                status: "completed",
                conclusion: "success",
              },
              {
                id: 7,
                run_attempt: 2,
                head_branch: "mq/1",
                head_sha: "a".repeat(40),
                event: "workflow_dispatch",
                path: ".github/workflows/ci.yml",
                repository: { full_name: repository },
                status: "in_progress",
                conclusion: null,
              },
            ],
          }),
      };
    };
    const github = createGithub({ token: "t", repository, request, sleep: async () => {} });
    expect(await github.merge(4, "a".repeat(40))).toEqual({ merged: true });
    expect(JSON.parse(seen[0][2])).toEqual({ merge_method: "merge", sha: "a".repeat(40) });
    expect(await github.merge(4, "a".repeat(40))).toEqual({ merged: false, status: 405 });
    const run = await github.findRun("mq/1", "a".repeat(40));
    expect(run).toMatchObject({ id: 7, attempt: 2, status: "in_progress" });
  });

  it("工作流只在 main 的检出上运行队列脚本，不检出 PR 代码，不用 pull_request_target", () => {
    const text = readFileSync(".github/workflows/merge-queue.yml", "utf8");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/head\.sha|head_ref|head\.ref|github\.event\.workflow_run\.head/u);
    expect(text).toMatch(/ref: main/u);
    expect(text).toContain("run: node scripts/ci/merge-queue.mjs");
    expect(text).toMatch(/group: merge-queue\n\s+cancel-in-progress: false/u);
  });

  it("合并队列暂停期间只能手动触发，不随 CI 结束或定时自动跑", () => {
    const text = readFileSync(".github/workflows/merge-queue.yml", "utf8");
    const triggers = text.slice(text.indexOf("on:"), text.indexOf("permissions:"));
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/workflow_run:|schedule:|cron:/u);
    expect(readFileSync(".agents/instructions/delivery-mode.md", "utf8")).toContain(
      "`.github/workflows/merge-queue.yml` 只保留手动触发",
    );
  });
});
