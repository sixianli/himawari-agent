import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function findGreenBase({ repo, workflow, prefixes, runId, getJson, getPages }) {
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
  return greenBase(runs, jobsByRun, prefixes, runId);
}

export async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function getJson(endpoint) {
  return JSON.parse(await gh(["api", "-X", "GET", endpoint]));
}

export async function getPages(endpoint, pick) {
  const out = await gh(["api", "-X", "GET", "--paginate", "--slurp", endpoint]);
  return JSON.parse(out).flatMap(pick);
}
