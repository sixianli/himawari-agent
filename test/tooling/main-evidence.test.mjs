import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeGate } from "../../scripts/ci/gate-log.mjs";
import {
  discoverEvidence,
  githubJson,
  githubLog,
  main,
  pushIdentity,
  verifyGate,
} from "../../scripts/ci/main-evidence.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const sha = (n) => String(n).repeat(40);
const repository = "sixianli/himawari-agent";
const temporaries = [];
afterEach(() => {
  for (const root of temporaries.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const bytes = readFileSync("ci/policy.json");
  const policy = { ...JSON.parse(bytes), bytes };
  const toolchainBytes = Buffer.from("fixture-toolchain");
  const identity = { before: sha(1), after: sha(2), head: sha(3), tree: sha(4) };
  const candidate = { ...identity, pr: 42, runId: 123, attempt: 2, jobId: 789 };
  const context = {
    repository,
    event: "pull_request",
    runId: "123",
    attempt: 2,
    baseSha: sha(1),
    headSha: sha(3),
    testedSha: sha(5),
    policySha256: hash(bytes),
    toolchainSha256: hash(toolchainBytes),
    initialization: false,
  };
  const expected = policy.checks
    .filter((c) => c.id !== "required")
    .flatMap((c) => c.members.filter((m) => m.paused !== true).map((m) => `${c.id}/${m.key}`));
  const summary = {
    schemaVersion: 1,
    ...context,
    status: "passed",
    expected,
    observed: [...expected],
    missing: [],
    failures: [],
    checks: expected.map((id) => {
      const [checkId, matrixKey] = id.split("/");
      return { checkId, matrixKey, status: "passed", reasons: [] };
    }),
  };
  const testedCommit = {
    sha: sha(5),
    tree: { sha: sha(4) },
    parents: [{ sha: sha(1) }, { sha: sha(3) }],
  };
  return { identity, candidate, context, summary, testedCommit, policy, toolchainBytes };
}
describe("main 轻量路径的完整证据", () => {
  it("接受同一父提交、源代码树和验证配置的完整 PR 验收", () => {
    expect(verifyGate(fixture())).toMatchObject({ mode: "light", runId: 123, attempt: 2 });
  });
  it.each([
    [
      "合并后内容变化",
      (f) => {
        f.testedCommit.tree.sha = sha(6);
      },
    ],
    [
      "main 已前进",
      (f) => {
        f.identity.before = sha(6);
      },
    ],
    [
      "旧 attempt",
      (f) => {
        f.context.attempt = 1;
      },
    ],
    [
      "手动 CI",
      (f) => {
        f.context.event = "workflow_dispatch";
      },
    ],
    [
      "不同仓库",
      (f) => {
        f.context.repository = "example/repo";
      },
    ],
    [
      "工具链变化",
      (f) => {
        f.toolchainBytes = Buffer.from("changed");
      },
    ],
    [
      "策略变化",
      (f) => {
        f.policy.bytes = Buffer.from("changed");
      },
    ],
    [
      "旧 base",
      (f) => {
        f.context.baseSha = sha(6);
      },
    ],
    [
      "伪造摘要身份",
      (f) => {
        f.summary.headSha = sha(6);
      },
    ],
    [
      "缺少检查",
      (f) => {
        f.summary.observed.pop();
      },
    ],
    [
      "重复检查",
      (f) => {
        f.summary.observed.push(f.summary.observed[0]);
      },
    ],
    [
      "失败检查",
      (f) => {
        f.summary.checks[0].status = "failed";
      },
    ],
    [
      "有失败原因",
      (f) => {
        f.summary.failures.push({ reason: "failed" });
      },
    ],
    [
      "缺少完整矩阵",
      (f) => {
        f.summary.expected.pop();
      },
    ],
    [
      "merge 父提交不符",
      (f) => {
        f.testedCommit.parents.reverse();
      },
    ],
  ])("拒绝%s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(() => verifyGate(f)).toThrow(/^MAIN_/);
  });
  it("[ADR-0268] PR 上只跑了相关测试的验收不能当 main 的证据，标成 full 的可以", () => {
    const related = fixture();
    related.summary.scope = "related";
    expect(() => verifyGate(related)).toThrow("MAIN_GATE_RELATED_SCOPE");
    const full = fixture();
    full.summary.scope = "full";
    expect(verifyGate(full)).toMatchObject({ mode: "light" });
  });
});
function apiData() {
  return [
    [
      {
        number: 42,
        merged_at: "2026-09-15T00:00:00Z",
        merge_commit_sha: sha(2),
        base: { ref: "main", repo: { full_name: repository } },
        head: { sha: sha(3), repo: { full_name: repository } },
      },
    ],
    {
      workflow_runs: [
        {
          id: 123,
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
          event: "pull_request",
          path: ".github/workflows/ci.yml",
          repository: { full_name: repository },
          head_sha: sha(3),
          pull_requests: [{ number: 42 }],
          updated_at: "2026-09-15T00:00:00Z",
        },
      ],
    },
    {
      total_count: 2,
      jobs: [
        {
          id: 788,
          name: "policy",
          run_id: 123,
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
        },
        {
          id: 789,
          name: "ci/required",
          run_id: 123,
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  ];
}
const timestamped = (text) =>
  text
    .split("\n")
    .map((line) => `2026-09-15T00:00:00.1234567Z ${line}`)
    .join("\n");
function gateLog(f = fixture()) {
  return timestamped(
    [
      "##[group]Run .ci-output/tools/bin/node scripts/ci/required.mjs",
      "##[endgroup]",
      encodeGate({ context: f.context, summary: f.summary }),
      "passed: 7/7 reports",
    ].join("\n"),
  );
}
it("只选择真实合并 PR 的最新有效完整 CI，并从 ci/required 的日志取回汇总结论", async () => {
  const data = apiData();
  const f = fixture();
  const requested = [];
  const result = await discoverEvidence({
    identity: f.identity,
    api: async () => data.shift(),
    logs: async (endpoint) => {
      requested.push(endpoint);
      return gateLog(f);
    },
    now: Date.parse("2026-09-15T01:00:00Z"),
  });
  expect(result.candidate).toMatchObject({ pr: 42, runId: 123, attempt: 2, jobId: 789 });
  expect(result.gate).toEqual({ context: f.context, summary: f.summary });
  expect(requested).toEqual([`/repos/${repository}/actions/jobs/789/logs`]);
});
it.each([
  "stale",
  "wrong-workflow",
  "gate-job-failed",
  "wrong-attempt",
  "two-gate-jobs",
  "extra-failed-gate-job",
  "fork",
  "no-gate-in-log",
  "two-gates-in-log",
  "digest-mismatch",
  "truncated-log",
])("拒绝不适用的 API 证据：%s", async (mode) => {
  const data = apiData();
  let log = gateLog();
  if (mode === "stale") data[1].workflow_runs[0].updated_at = "2026-09-12T00:00:00Z";
  if (mode === "wrong-workflow") data[1].workflow_runs[0].path = ".github/workflows/other.yml";
  if (mode === "gate-job-failed") data[2].jobs[1].conclusion = "failure";
  if (mode === "wrong-attempt") data[2].jobs[1].run_attempt = 1;
  if (mode === "two-gate-jobs") data[2].jobs.push({ ...data[2].jobs[1], id: 790 });
  if (mode === "extra-failed-gate-job")
    data[2].jobs.push({ ...data[2].jobs[1], id: 790, conclusion: "failure" });
  if (mode === "fork") data[0][0].head.repo.full_name = "someone/fork";
  if (mode === "no-gate-in-log") log = timestamped("passed: 7/7 reports");
  if (mode === "two-gates-in-log") log = `${log}\n${gateLog()}`;
  if (mode === "digest-mismatch") log = log.replace(/[a-f0-9]{64}/u, "0".repeat(64));
  if (mode === "truncated-log") log = log.slice(0, log.indexOf("HIMAWARI_GATE_END"));
  await expect(
    discoverEvidence({
      identity: fixture().identity,
      api: async () => data.shift(),
      logs: async () => log,
      now: Date.parse("2026-09-15T01:00:00Z"),
    }),
  ).rejects.toThrow(/^MAIN_/);
});
describe("下载 ci/required 的日志", () => {
  const endpoint = `/repos/${repository}/actions/jobs/789/logs`;
  it("只给 GitHub 接口带令牌，跟随一次 HTTPS 跳转且不把令牌带到存储地址", async () => {
    const calls = [];
    const text = await githubLog(endpoint, {
      token: "tok",
      fetcher: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1)
          return {
            status: 302,
            ok: false,
            headers: new Headers({ location: "https://logs.example.test/job?sig=x" }),
          };
        return { status: 200, ok: true, text: async () => "log text" };
      },
    });
    expect(text).toBe("log text");
    expect(calls[0].url).toBe(`https://api.github.com${endpoint}`);
    expect(calls[0].options.redirect).toBe("manual");
    expect(calls[0].options.headers.Authorization).toBe("Bearer tok");
    expect(calls[1].url).toBe("https://logs.example.test/job?sig=x");
    expect(calls[1].options.headers).toBeUndefined();
    expect(calls[1].options.redirect).toBe("error");
  });
  it.each([
    ["非 HTTPS 跳转", "http://logs.example.test/job"],
    ["跳转地址带账号", "https://user:pass@logs.example.test/job"],
    ["跳转地址无效", "not a url"],
  ])("拒绝%s", async (_name, location) => {
    await expect(
      githubLog(endpoint, {
        fetcher: async () => ({ status: 302, ok: false, headers: new Headers({ location }) }),
      }),
    ).rejects.toThrow("MAIN_LOG_UNAVAILABLE");
  });
  it("拒绝其他接口路径和失败的下载", async () => {
    await expect(githubLog(`/repos/${repository}/actions/runs/1/logs`)).rejects.toThrow(
      "MAIN_API_PATH",
    );
    await expect(
      githubLog(endpoint, { fetcher: async () => ({ status: 404, ok: false }) }),
    ).rejects.toThrow("MAIN_LOG_UNAVAILABLE");
  });
});
it("HTTP 拒绝、重定向、超时不会得到轻量授权", async () => {
  await expect(
    githubJson(`/repos/${repository}/pulls`, {
      fetcher: async (_url, options) => {
        expect(options.redirect).toBe("error");
        expect(options.signal).toBeDefined();
        return { ok: false };
      },
    }),
  ).rejects.toThrow("MAIN_API_UNAVAILABLE");
});
it("真实 Git merge 识别；缺少证据和下载失败回到完整 CI", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "main-evidence-test-"));
  temporaries.push(root);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  writeFileSync(path.join(root, "value"), "before");
  git(["add", "."]);
  git(["commit", "-m", "before"]);
  const before = git(["rev-parse", "HEAD"]);
  git(["checkout", "-b", "feature"]);
  writeFileSync(path.join(root, "value"), "after");
  git(["commit", "-am", "after"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["checkout", "main"]);
  git(["merge", "--no-ff", "feature", "-m", "merge"]);
  const after = git(["rev-parse", "HEAD"]);
  const eventPath = path.join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({ before, after }));
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: after,
    GITHUB_EVENT_PATH: eventPath,
  };
  expect(pushIdentity({ root, env })).toMatchObject({ before, after, head });
  expect(await main(["verify"], { root, env })).toMatchObject({ mode: "full" });
  expect(
    await main(["discover"], {
      root,
      env,
      api: async () => {
        throw new Error("network timeout");
      },
    }),
  ).toMatchObject({ mode: "full" });
  mkdirSync(path.join(root, "ci"));
  const f = fixture();
  const identity = pushIdentity({ root, env });
  const context = { ...f.context, baseSha: before, headSha: head, testedSha: after };
  const summary = { ...f.summary, ...context };
  writeFileSync(path.join(root, "ci/policy.json"), f.policy.bytes);
  writeFileSync(path.join(root, "ci/toolchain-lock.json"), f.toolchainBytes);
  const evidence = path.join(root, ".ci-output/main-evidence");
  mkdirSync(path.join(evidence, "gate"));
  writeFileSync(
    path.join(evidence, "candidate.json"),
    JSON.stringify({ ...f.candidate, ...identity }),
  );
  writeFileSync(path.join(evidence, "gate/context.json"), JSON.stringify(context));
  writeFileSync(path.join(evidence, "gate/summary.json"), JSON.stringify(summary));
  const api = async () => ({
    sha: after,
    tree: { sha: identity.tree },
    parents: [{ sha: before }, { sha: head }],
  });
  expect(await main(["verify"], { root, env, api })).toMatchObject({
    mode: "light",
    testedSha: after,
  });
  rmSync(evidence, { recursive: true, force: true });
  const discovery = apiData();
  discovery[0][0].merge_commit_sha = after;
  discovery[0][0].head.sha = head;
  discovery[1].workflow_runs[0].head_sha = head;
  discovery[1].workflow_runs[0].updated_at = new Date().toISOString();
  expect(
    await main(["discover"], {
      root,
      env,
      api: async () => discovery.shift(),
      logs: async () => gateLog({ ...f, context, summary }),
    }),
  ).toMatchObject({ runId: 123, attempt: 2, jobId: 789 });
  expect(JSON.parse(readFileSync(path.join(evidence, "gate/summary.json"), "utf8"))).toEqual(
    summary,
  );
  expect(await main(["verify"], { root, env, api })).toMatchObject({
    mode: "light",
    testedSha: after,
  });
  summary.checks.pop();
  writeFileSync(path.join(evidence, "gate/summary.json"), JSON.stringify(summary));
  expect(await main(["verify"], { root, env, api })).toMatchObject({
    mode: "full",
    reason: "MAIN_COMPLETE_GATE_REQUIRED",
  });
  git(["add", "ci"]);
  git(["commit", "-m", "policy"]);
  expect(() => pushIdentity({ root, env })).toThrow("MAIN_CHECKOUT_MISMATCH");
});
