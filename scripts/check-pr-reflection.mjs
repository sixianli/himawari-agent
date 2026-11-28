import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { REPEAT_LIMIT } from "./check-incident-gates.mjs";
import { getJson } from "./check-incident-runs.mjs";

export const REFLECTION_HEADING = /^#{2,3}[ \t]*复盘[ \t]*$/m;
const PAGE_SIZE = 100;

export function reflectionSection(body) {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const start = text.search(REFLECTION_HEADING);
  if (start < 0) return undefined;
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const end = rest.search(/^#{1,3}[ \t]/m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export async function redRuns({ api, token, repository, branch, since, aggregateJob }) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      branch,
      event: "pull_request",
      status: "failure",
      created: `>=${since}`,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const body = await getJson(api, token, `/repos/${repository}/actions/runs?${query}`);
    const pageRuns = body.workflow_runs ?? [];
    for (const run of pageRuns)
      if (
        run.conclusion === "failure" &&
        run.head_branch === branch &&
        Date.parse(run.created_at) >= Date.parse(since)
      )
        runs.push(run);
    if (pageRuns.length < PAGE_SIZE) break;
  }
  const red = [];
  for (const run of runs) {
    const jobs = await getJson(
      api,
      token,
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=${PAGE_SIZE}`,
    );
    const failed = (jobs.jobs ?? [])
      .filter((job) => job.conclusion === "failure" && job.name !== aggregateJob)
      .map((job) => job.name);
    if (failed.length > 0)
      red.push({ id: String(run.id), workflow: run.name, jobs: failed.sort() });
  }
  return red.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

export const REFLECTION_LINES = Object.freeze([
  ["PR_REFLECTION_PREMISE_MISSING", /^[ \t]*(?:[-*][ \t]*)?共同前提[:：][ \t]*\S/m],
  ["PR_REFLECTION_VERIFICATION_MISSING", /^[ \t]*(?:[-*][ \t]*)?验证[:：][ \t]*\S/m],
]);

export function judgeReflection({ runs, body }) {
  if (runs.length < REPEAT_LIMIT) return [];
  const ids = runs.map((run) => run.id).join(",");
  const section = reflectionSection(body);
  if (section === undefined || section.length === 0)
    return [`PR_REFLECTION_MISSING red=${runs.length} runs=${ids}`];
  const missingLines = REFLECTION_LINES.filter(([, line]) => !line.test(section)).map(
    ([code]) => `${code} red=${runs.length}`,
  );
  return missingLines.concat(
    runs
      .filter((run) => !new RegExp(`(?<!\\d)${run.id}(?!\\d)`).test(section))
      .map(
        (run) =>
          `PR_REFLECTION_RUN_MISSING run=${run.id} workflow="${run.workflow}" jobs=${run.jobs.join(",")}`,
      ),
  );
}

export async function checkPrReflection({
  api = process.env.GITHUB_API_URL ?? "https://api.github.com",
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
  repository = process.env.GITHUB_REPOSITORY ?? "",
  eventPath = process.env.GITHUB_EVENT_PATH ?? "",
  aggregateJob = process.env.PR_REFLECTION_AGGREGATE_JOB ?? "",
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    return {
      errors: ["PR_REFLECTION_REPOSITORY_MISSING set GITHUB_REPOSITORY to owner/name"],
      notices: [],
    };
  if (!aggregateJob)
    return {
      errors: ["PR_REFLECTION_AGGREGATE_JOB_MISSING set PR_REFLECTION_AGGREGATE_JOB"],
      notices: [],
    };
  let number;
  try {
    number = JSON.parse(readFileSync(eventPath, "utf8")).pull_request?.number;
  } catch {
    number = undefined;
  }
  if (!Number.isSafeInteger(number))
    return {
      errors: ["PR_REFLECTION_EVENT_MISSING GITHUB_EVENT_PATH has no pull_request.number"],
      notices: [],
    };
  try {
    const pull = await getJson(api, token, `/repos/${repository}/pulls/${number}`);
    if (!Number.isFinite(Date.parse(pull.created_at ?? "")))
      return {
        errors: [`PR_REFLECTION_PR_CREATED_MISSING pr=${number}`],
        notices: [],
      };
    const runs = await redRuns({
      api,
      token,
      repository,
      branch: pull.head.ref,
      since: pull.created_at,
      aggregateJob,
    });
    return {
      errors: judgeReflection({ runs, body: pull.body }),
      notices: [`PR_REFLECTION_RED pr=${number} red=${runs.length} limit=${REPEAT_LIMIT}`],
    };
  } catch (error) {
    return {
      errors: [error.message.replace(/^INCIDENT_RUNS_UNAVAILABLE/, "PR_REFLECTION_UNAVAILABLE")],
      notices: [],
    };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write(`PR_REFLECTION_ARGUMENT_UNKNOWN ${process.argv.slice(2).join(" ")}\n`);
    process.exit(2);
  }
  const { errors, notices } = await checkPrReflection();
  for (const notice of notices) process.stdout.write(`${notice}\n`);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (
    errors.some(
      (error) =>
        error.startsWith("PR_REFLECTION_MISSING") ||
        error.startsWith("PR_REFLECTION_RUN_MISSING") ||
        REFLECTION_LINES.some(([code]) => error.startsWith(code)),
    )
  )
    process.stderr.write(
      `PR_REFLECTION_HELP this PR's CI went red ${REPEAT_LIMIT} or more times: add a "## 复盘" section to the PR description that names every red run id above, says why each one failed and what now stops it, has a line "共同前提：" naming the assumption the failures shared and a line "验证：" saying how the fix was checked, then re-run the failed ci/required job; see .claude/rules/incident-gates.md\n`,
    );
  process.stdout.write(
    `PR_REFLECTION ${errors.length === 0 ? "passed" : "failed"} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
