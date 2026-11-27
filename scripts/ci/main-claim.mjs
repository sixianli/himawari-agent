import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { touchesAppleClient } from "./apple-scope.mjs";
import { findGreenBase, getJson, getPages, gh } from "./main-green.mjs";

export function marker(runId) {
  return `<!-- main-claim:${runId} -->`;
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

export const scopes = {
  apple: {
    owns: touchesAppleClient,
    who: "改了苹果客户端的 PR",
    advice:
      "请做这个 PR 的线程认领：看运行日志里的失败原因，因页面改动多出的无障碍问题修页面，不调高登记表的数；查清与本 PR 无关时在这里说明。",
  },
  any: {
    owns: () => true,
    who: "PR",
    advice:
      "请做这个 PR 的线程认领：看运行日志里的失败原因，是本 PR 的改动弄坏的就修；是外网网站变了或连不上，在这里写明是哪个网站、怎样变的，再改测试或换网站，不加重试。",
  },
};

export function claimComment({ scope, workflow, failed, head, base, runUrl, runId, pulls }) {
  const { who, advice } = scopes[scope];
  const range = base
    ? `上次这些作业全部通过是在 \`${base.slice(0, 9)}\`，从那以后合进 main 的${who}：${pulls.map((pr) => `#${pr}`).join("、")}。`
    : "最近的运行里找不到这些作业全部通过的一次，只列出这个提交所属的 PR。";
  return [
    marker(runId),
    `main 上 \`${workflow}\` 在 \`${head.slice(0, 9)}\` 失败：${failed.map((name) => `\`${name}\``).join("、")}（${runUrl}）。`,
    range,
    advice,
  ].join("\n\n");
}

async function main() {
  const [workflow, scope, ...prefixes] = process.argv.slice(2);
  if (!workflow || !Object.hasOwn(scopes, scope ?? "") || prefixes.length === 0) {
    process.stderr.write(
      `usage: main-claim.mjs <workflow file> <${Object.keys(scopes).join("|")}> <job name prefix>...\n`,
    );
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
    process.stdout.write("MAIN_CLAIM nothing-failed\n");
    return;
  }
  const base = await findGreenBase({ repo, workflow, prefixes, runId, getJson, getPages });
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
    if (scopes[scope].owns(files)) touching.push(number);
  }
  const body = claimComment({
    scope,
    workflow,
    failed,
    head,
    base,
    runUrl,
    runId,
    pulls: touching,
  });
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
    `MAIN_CLAIM failed=${failed.join(",")} base=${base ?? "none"} pulls=${touching.join(",") || "none"}\n`,
  );
  if (touching.length === 0) {
    process.stdout.write(
      `::warning::MAIN_CLAIM_NOBODY 没找到合进 main 的${scopes[scope].who}，失败原因见运行日志\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
