import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { touchesAppleClient } from "./apple-scope.mjs";

const execFileAsync = promisify(execFile);

export function marker(runId) {
  return `<!-- apple-main-claim:${runId} -->`;
}

export function isGreen(jobs, prefixes) {
  return prefixes.every((prefix) => {
    const matching = jobs.filter((job) => job.name.startsWith(prefix));
    return matching.length > 0 && matching.every((job) => job.conclusion === "success");
  });
}

export function greenBase(runs, jobsByRun, prefixes, currentRunId) {
  const earlier = runs
    .filter((run) => String(run.id) !== String(currentRunId))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const run of earlier) {
    if (isGreen(jobsByRun.get(run.id) ?? [], prefixes)) return run.head_sha;
  }
  return null;
}

export function failedJobs(jobs, prefixes) {
  return jobs
    .filter((job) => prefixes.some((prefix) => job.name.startsWith(prefix)))
    .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
    .map((job) => job.name);
}

export function alreadyClaimed(comments, runId) {
  return comments.some((comment) => String(comment.body ?? "").includes(marker(runId)));
}

export function claimComment({ workflow, failed, head, base, runUrl, runId, pulls }) {
  const range = base
    ? `上次这些作业全部通过是在 \`${base.slice(0, 9)}\`，从那以后合进 main、改了苹果客户端的 PR：${pulls.map((pr) => `#${pr}`).join("、")}。`
    : "最近的运行里找不到这些作业全部通过的一次，只列出这个提交所属的 PR。";
  return [
    marker(runId),
    `main 上 \`${workflow}\` 在 \`${head.slice(0, 9)}\` 失败：${failed.map((name) => `\`${name}\``).join("、")}（${runUrl}）。`,
    range,
    "请做这个 PR 的线程认领：看运行日志里的失败原因，因页面改动多出的无障碍问题修页面，不调高登记表的数；查清与本 PR 无关时在这里说明。",
  ].join("\n\n");
}

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function getJson(endpoint) {
  return JSON.parse(await gh(["api", "-X", "GET", endpoint]));
}

async function getPages(endpoint, pick) {
  const out = await gh(["api", "-X", "GET", "--paginate", "--slurp", endpoint]);
  return JSON.parse(out).flatMap(pick);
}

async function main() {
  const [workflow, ...prefixes] = process.argv.slice(2);
  if (!workflow || prefixes.length === 0) {
    process.stderr.write("usage: apple-main-claim.mjs <workflow file> <job name prefix>...\n");
    process.exit(64);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const head = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}`;
  const current = await getPages(
    `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    (page) => page.jobs,
  );
  const failed = failedJobs(current, prefixes);
  if (failed.length === 0) {
    process.stdout.write("APPLE_CLAIM nothing-failed\n");
    return;
  }
  const { workflow_runs: runs } = await getJson(
    `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&event=push&status=completed&per_page=40`,
  );
  const jobsByRun = new Map();
  for (const run of runs) {
    jobsByRun.set(
      run.id,
      await getPages(
        `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        (page) => page.jobs,
      ),
    );
    if (String(run.id) !== String(runId) && isGreen(jobsByRun.get(run.id), prefixes)) break;
  }
  const base = greenBase(runs, jobsByRun, prefixes, runId);
  const commits = base
    ? (await getJson(`repos/${repo}/compare/${base}...${head}`)).commits.map((commit) => commit.sha)
    : [head];
  const pulls = new Set();
  for (const sha of commits) {
    for (const pr of await getJson(`repos/${repo}/commits/${sha}/pulls`)) {
      if (pr.merged_at && pr.base?.ref === "main") pulls.add(pr.number);
    }
  }
  const touching = [];
  for (const number of [...pulls].sort((a, b) => a - b)) {
    const files = await getPages(`repos/${repo}/pulls/${number}/files?per_page=100`, (page) =>
      page.map((file) => file.filename),
    );
    if (touchesAppleClient(files)) touching.push(number);
  }
  const body = claimComment({ workflow, failed, head, base, runUrl, runId, pulls: touching });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
  for (const number of touching) {
    const comments = await getPages(
      `repos/${repo}/issues/${number}/comments?per_page=100`,
      (page) => page,
    );
    if (alreadyClaimed(comments, runId)) continue;
    await gh([
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${number}/comments`,
      "-f",
      `body=${body}`,
    ]);
  }
  process.stdout.write(
    `APPLE_CLAIM failed=${failed.join(",")} base=${base ?? "none"} pulls=${touching.join(",") || "none"}\n`,
  );
  if (touching.length === 0) {
    process.stdout.write(
      "::warning::APPLE_CLAIM_NOBODY 没找到改了苹果客户端的 PR，失败原因见运行日志\n",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
