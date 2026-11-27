import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INCIDENT_LIST } from "../../scripts/check-incident-gates.mjs";
import { readRunClaims, RUN_RULE_FILE } from "../../scripts/check-incident-runs.mjs";

const roots = [];
const servers = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

const header = `| 编号 | 日期 | 现象 | 根因 | 次数 | 门槛（文件或命令） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |`;
const row = (count) => `| I-01 | 2026-11-27 | 现象 | 根因 | ${count} | 无 | 缺门槛 |`;
const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];

function commit(root, message) {
  writeFileSync(join(root, "work.txt"), `${message}\n${Math.random()}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", [...identity, "commit", "-q", "--no-verify", "-m", message], { cwd: root });
}

function repository(count = "1") {
  const root = mkdtempSync(join(tmpdir(), "incident-runs-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, INCIDENT_LIST), `# 清单\n\n${header}\n${row(count)}\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  copyFileSync("scripts/check-incident-gates.mjs", join(root, "scripts/check-incident-gates.mjs"));
  copyFileSync(RUN_RULE_FILE, join(root, RUN_RULE_FILE));
  commit(root, "add the rule\n\nIncident: none");
  return root;
}

const run = (id, name = "Deploy production", extra = {}) => ({
  id,
  name,
  event: "workflow_run",
  head_branch: "main",
  conclusion: "failure",
  html_url: `https://example.invalid/runs/${id}`,
  ...extra,
});

async function github(runs) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/repos/owner/name") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (url.pathname === "/repos/owner/name/actions/runs") {
      response.end(JSON.stringify({ workflow_runs: runs }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { api: `http://127.0.0.1:${server.address().port}`, requests };
}

function check(root, api) {
  return new Promise((done) => {
    const child = spawn("node", [join(root, RUN_RULE_FILE)], {
      cwd: root,
      env: { ...process.env, GITHUB_API_URL: api, GITHUB_REPOSITORY: "owner/name", GH_TOKEN: "" },
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

describe("failed runs on the default branch are counted without anyone remembering to", () => {
  it("refuses three unclaimed failures of one workflow and asks only for runs since the rule", async () => {
    const root = repository();
    const { api, requests } = await github([run(11), run(12), run(13)]);
    const result = await check(root, api);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'INCIDENT_RUNS_UNCLAIMED workflow="Deploy production" failures=3 runs=11,12,13',
    );
    expect(result.stderr).toContain("INCIDENT_RUNS_HELP");
    const listed = new URL(
      requests.find((url) => url.includes("/actions/runs")),
      api,
    );
    expect(listed.searchParams.get("branch")).toBe("main");
    expect(listed.searchParams.get("status")).toBe("failure");
    expect(listed.searchParams.get("created")).toMatch(/^>=\d{4}-\d{2}-\d{2}T/);
  });

  it("passes two failures, failures on other branches, pull requests and other conclusions", async () => {
    const root = repository();
    const { api } = await github([
      run(11),
      run(12),
      run(13, "Deploy production", { head_branch: "feature" }),
      run(14, "Deploy production", { event: "pull_request" }),
      run(15, "Deploy production", { conclusion: "cancelled" }),
      run(16, "CI"),
    ]);
    const result = await check(root, api);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'INCIDENT_RUNS_PENDING workflow="Deploy production" failures=2',
    );
  });

  it("passes once a commit claims the runs and the incident counts at least that many", async () => {
    const root = repository("2");
    commit(root, "fix: deploy\n\nIncident: I-01\nIncident-run: 11, 12 I-01");
    const { api } = await github([run(11), run(12), run(13, "CI")]);
    const result = await check(root, api);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INCIDENT_RUNS passed");
  });

  it("refuses a claim the incident count does not cover, so the third run still needs a gate", async () => {
    const root = repository("2");
    commit(root, "fix: deploy\n\nIncident: I-01\nIncident-run: 11 12 13 I-01");
    const { api } = await github([run(11), run(12), run(13)]);
    const result = await check(root, api);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INCIDENT_COUNT_BELOW_RUNS I-01 table=2 claimedRuns=3");
  });

  it("refuses claims naming an incident the list does not have", async () => {
    const root = repository();
    commit(root, "fix: x\n\nIncident: none\nIncident-run: 11 I-77");
    const { api } = await github([run(11)]);
    const result = await check(root, api);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INCIDENT_RUN_CLAIM_UNKNOWN run=11 I-77");
  });

  it("fails closed when GitHub cannot be read", async () => {
    const root = repository();
    const result = await check(root, "http://127.0.0.1:9");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("INCIDENT_RUNS failed");
  });

  it("reads claim lines strictly", () => {
    expect(readRunClaims("Incident-run: 11 12 I-01\n")).toEqual({
      claims: [
        { run: "11", incident: "I-01" },
        { run: "12", incident: "I-01" },
      ],
      invalid: [],
    });
    expect(readRunClaims("Incident-run: I-01\nIncident-run: 1x I-01\n").invalid).toEqual([
      "I-01",
      "1x I-01",
    ]);
  });

  it("CI runs this check in ci/required on pull requests with read access to Actions", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain(
      'run: if [ "$GITHUB_EVENT_NAME" = pull_request ]; then node scripts/check-incident-runs.mjs; fi',
    );
    expect(workflow).toMatch(/name: ci\/required[\s\S]*?permissions:[\s\S]*?actions: read/);
  });
});
