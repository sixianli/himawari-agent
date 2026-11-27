import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reflectionSection } from "../../scripts/check-pr-reflection.mjs";

const roots = [];
const servers = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

const red = (id, failedJobs = ["tooling", "ci/required"], extra = {}) => ({
  run: {
    id,
    name: "CI",
    event: "pull_request",
    head_branch: "feature",
    conclusion: "failure",
    created_at: "2026-11-27T10:00:00Z",
    ...extra,
  },
  jobs: [
    ...failedJobs.map((name) => ({ name, conclusion: "failure" })),
    { name: "static", conclusion: "success" },
  ],
});

async function github({ body, runs }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    const jobs = url.pathname.match(/^\/repos\/owner\/name\/actions\/runs\/(\d+)\/jobs$/);
    if (url.pathname === "/repos/owner/name/pulls/7") {
      response.end(
        JSON.stringify({ body, created_at: "2026-11-27T09:00:00Z", head: { ref: "feature" } }),
      );
    } else if (url.pathname === "/repos/owner/name/actions/runs") {
      response.end(JSON.stringify({ workflow_runs: runs.map((entry) => entry.run) }));
    } else if (jobs) {
      const entry = runs.find((candidate) => String(candidate.run.id) === jobs[1]);
      response.end(JSON.stringify({ jobs: entry?.jobs ?? [] }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { api: `http://127.0.0.1:${server.address().port}`, requests };
}

function check(api) {
  const root = mkdtempSync(join(tmpdir(), "pr-reflection-"));
  roots.push(root);
  const event = join(root, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
  return new Promise((done) => {
    const child = spawn("node", ["scripts/check-pr-reflection.mjs"], {
      env: {
        ...process.env,
        GITHUB_API_URL: api,
        GITHUB_REPOSITORY: "owner/name",
        GITHUB_EVENT_PATH: event,
        PR_REFLECTION_AGGREGATE_JOB: "ci/required",
        GH_TOKEN: "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

describe("a PR whose CI went red twice needs a written reflection before it merges", () => {
  it("refuses two red runs when the description has no reflection", async () => {
    const { api, requests } = await github({
      body: "## 为什么\n\n修 bug",
      runs: [red(21), red(22)],
    });
    const result = await check(api);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PR_REFLECTION_MISSING red=2 runs=21,22");
    expect(result.stderr).toContain("PR_REFLECTION_HELP");
    const listed = new URL(
      requests.find((url) => url.includes("/actions/runs?")),
      api,
    );
    expect(listed.searchParams.get("branch")).toBe("feature");
    expect(listed.searchParams.get("event")).toBe("pull_request");
    expect(listed.searchParams.get("created")).toBe(">=2026-11-27T09:00:00Z");
  });

  it("does not count red runs from an earlier PR on the same branch name", async () => {
    const { api } = await github({
      body: "",
      runs: [red(11, undefined, { created_at: "2026-11-27T08:00:00Z" }), red(21)],
    });
    const result = await check(api);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR_REFLECTION_RED pr=7 red=1");
  });

  it("refuses a reflection that leaves out one of the red runs", async () => {
    const body = "## 复盘\n\n- 21：格式没跑，已加推送前检查\n\n## 验证\n\n22 次通过";
    const { api } = await github({ body, runs: [red(21), red(22)] });
    const result = await check(api);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PR_REFLECTION_RUN_MISSING run=22 workflow="CI" jobs=tooling');
  });

  it("passes once the reflection names every red run", async () => {
    const body = "## 复盘\n\n- 21：格式没跑\n- 22：测试里重复声明权限\n";
    const { api } = await github({ body, runs: [red(21), red(22)] });
    const result = await check(api);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR_REFLECTION passed");
  });

  it("passes one red run, and does not count runs where only ci/required failed", async () => {
    const { api } = await github({
      body: "",
      runs: [red(21), red(23, ["ci/required"]), red(24, ["ci/required"])],
    });
    const result = await check(api);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR_REFLECTION_RED pr=7 red=1");
  });

  it("fails closed when GitHub cannot be read", async () => {
    const result = await check("http://127.0.0.1:9");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PR_REFLECTION failed");
  });

  it("reads only the reflection section", () => {
    expect(reflectionSection("## 为什么\n21\n### 复盘\n22 原因\n## 验证\n23")).toBe("22 原因");
    expect(reflectionSection("复盘 21")).toBeUndefined();
  });

  it("CI runs it in ci/required on pull requests, skipping the job by its real name", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const job = workflow.match(/\n {4}name: (ci\/required)\n/)?.[1];
    expect(job).toBe("ci/required");
    expect(workflow).toContain(`PR_REFLECTION_AGGREGATE_JOB: ${job}`);
    expect(workflow).toContain(
      'run: if [ "$GITHUB_EVENT_NAME" = pull_request ]; then node scripts/check-pr-reflection.mjs; fi',
    );
  });
});
