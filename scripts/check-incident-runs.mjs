import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkIncidentGates } from "./check-incident-gates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_RULE_FILE = "scripts/check-incident-runs.mjs";
export const RUN_RULE_MARK = "INCIDENT_RUNS_UNCLAIMED";
export const REPEAT_LIMIT = 3;
const PAGE_SIZE = 100;
const CLAIM_LINE = /^Incident-run:[ \t]*(.*?)[ \t]*$/gm;
const RUN_ID = /^\d+$/;
const INCIDENT_ID = /^I-\d{2,}$/;
const REPOSITORY_TOKEN =
  /(?<![A-Za-z0-9_./-])((?:\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_.-]+)/g;

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function readRunClaims(message) {
  const claims = [];
  const invalid = [];
  for (const match of message.matchAll(CLAIM_LINE)) {
    const words = match[1].split(/[\s,]+/).filter(Boolean);
    const incident = words.at(-1);
    const runs = words.slice(0, -1);
    if (
      !INCIDENT_ID.test(incident ?? "") ||
      runs.length === 0 ||
      !runs.every((run) => RUN_ID.test(run))
    )
      invalid.push(match[1]);
    else for (const run of runs) claims.push({ run, incident });
  }
  return { claims, invalid };
}

export function readHistory(root) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true")
    throw new Error(
      "INCIDENT_HISTORY_SHALLOW the clone is shallow, so claims cannot be read; run git fetch --unshallow origin",
    );
  const activation = git(root, [
    "log",
    "--reverse",
    "--format=%H %cI",
    "-S",
    RUN_RULE_MARK,
    "HEAD",
    "--",
    RUN_RULE_FILE,
  ])
    .split("\n")
    .filter(Boolean)[0];
  const since = activation ? activation.split(" ")[1] : "";
  const log = git(root, ["log", "--format=%H%x00%B%x1e", "HEAD"]);
  const claims = new Map();
  const errors = [];
  for (const record of log.split("\x1e")) {
    const [sha, message] = record.replace(/^\n/, "").split("\0");
    if (!sha || message === undefined) continue;
    const found = readRunClaims(message);
    for (const value of found.invalid)
      errors.push(`INCIDENT_RUN_CLAIM_INVALID ${sha.slice(0, 12)} ${value}`);
    for (const claim of found.claims) claims.set(claim.run, claim.incident);
  }
  return { since, claims, errors };
}

async function getJson(api, token, route) {
  const response = await fetch(`${api}${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`INCIDENT_RUNS_UNAVAILABLE ${route} status=${response.status}`);
  return response.json();
}

export async function failedRuns({ api, token, repository, since }) {
  const repo = await getJson(api, token, `/repos/${repository}`);
  const branch = repo.default_branch;
  const runs = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      branch,
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
        run.event !== "pull_request" &&
        run.head_branch === branch
      )
        runs.push({ id: String(run.id), workflow: run.name, path: run.path, url: run.html_url });
    if (pageRuns.length < PAGE_SIZE) break;
  }
  return runs;
}

export function workflowScope(root, workflowPath) {
  const scope = new Set();
  if (!workflowPath) return scope;
  const file = path.join(root, workflowPath);
  scope.add(workflowPath);
  if (!existsSync(file)) return scope;
  for (const match of readFileSync(file, "utf8").matchAll(REPOSITORY_TOKEN)) {
    const relative = match[1].replace(/\/+$/, "");
    const full = path.join(root, relative);
    if (relative === workflowPath || !existsSync(full)) continue;
    scope.add(statSync(full).isDirectory() ? `${relative}/` : `${path.posix.dirname(relative)}/`);
  }
  return scope;
}

export function touchesScope(changed, scope) {
  return changed.some((file) =>
    [...scope].some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)),
  );
}

export function changedFiles(root, eventPath) {
  if (!eventPath || !existsSync(eventPath)) return undefined;
  const base = JSON.parse(readFileSync(eventPath, "utf8")).pull_request?.base?.sha;
  if (!/^[0-9a-f]{40}$/.test(base ?? "")) return undefined;
  return git(root, ["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
}

export function judgeRuns({ runs, claims, incidents, related = () => true }) {
  const errors = [];
  const table = new Map(
    incidents.map((incident) => [incident.id, Number.parseInt(incident.count ?? "", 10)]),
  );
  const claimedPerIncident = new Map();
  for (const [run, incident] of claims) {
    if (!table.has(incident)) {
      errors.push(`INCIDENT_RUN_CLAIM_UNKNOWN run=${run} ${incident}`);
      continue;
    }
    claimedPerIncident.set(incident, (claimedPerIncident.get(incident) ?? 0) + 1);
  }
  for (const [incident, claimed] of [...claimedPerIncident].sort(([a], [b]) => a.localeCompare(b)))
    if (table.get(incident) < claimed)
      errors.push(
        `INCIDENT_COUNT_BELOW_RUNS ${incident} table=${table.get(incident)} claimedRuns=${claimed}`,
      );
  const unclaimed = new Map();
  for (const run of runs)
    if (!claims.has(run.id))
      unclaimed.set(run.workflow, [...(unclaimed.get(run.workflow) ?? []), run]);
  const notices = [];
  for (const [workflow, list] of [...unclaimed].sort(([a], [b]) => a.localeCompare(b))) {
    const ids = list.map((run) => run.id).join(",");
    if (list.length >= REPEAT_LIMIT && related(list[0]))
      errors.push(`${RUN_RULE_MARK} workflow="${workflow}" failures=${list.length} runs=${ids}`);
    else if (list.length >= REPEAT_LIMIT)
      notices.push(
        `INCIDENT_RUNS_UNCLAIMED_ELSEWHERE workflow="${workflow}" failures=${list.length} runs=${ids} not blocking changes that leave this workflow alone; the change that fixes it must claim them`,
      );
    else
      notices.push(
        `INCIDENT_RUNS_PENDING workflow="${workflow}" failures=${list.length} runs=${ids}`,
      );
  }
  return { errors, notices };
}

export async function checkIncidentRuns({
  root = repositoryRoot,
  api = process.env.GITHUB_API_URL ?? "https://api.github.com",
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
  repository = process.env.GITHUB_REPOSITORY ?? "",
  eventPath = process.env.GITHUB_EVENT_PATH ?? "",
  report = false,
} = {}) {
  const { incidents, errors: listErrors } = checkIncidentGates({ root });
  if (listErrors.length > 0) return { errors: listErrors, notices: [] };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    return {
      errors: ["INCIDENT_RUNS_REPOSITORY_MISSING set GITHUB_REPOSITORY to owner/name"],
      notices: [],
    };
  let history;
  try {
    history = readHistory(root);
  } catch (error) {
    return { errors: [error.message], notices: [] };
  }
  if (!history.since)
    return {
      errors: history.errors,
      notices: ["INCIDENT_RUNS_NOT_ACTIVE rule not in history yet"],
    };
  let runs;
  try {
    runs = await failedRuns({ api, token, repository, since: history.since });
  } catch (error) {
    return { errors: [...history.errors, error.message], notices: [] };
  }
  let changed;
  try {
    changed = report ? [] : changedFiles(root, eventPath);
  } catch (error) {
    return {
      errors: [...history.errors, `INCIDENT_RUNS_DIFF_UNAVAILABLE ${error.message}`],
      notices: [],
    };
  }
  const related = (run) =>
    changed === undefined || touchesScope(changed, workflowScope(root, run.path));
  const judged = judgeRuns({ runs, claims: history.claims, incidents, related });
  return {
    errors: [...history.errors, ...judged.errors],
    notices: [`INCIDENT_RUNS_SINCE ${history.since} failed=${runs.length}`, ...judged.notices],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extra = process.argv.slice(2);
  const report = extra.length === 1 && extra[0] === "--report";
  if (extra.length > 0 && !report) {
    process.stderr.write(`INCIDENT_ARGUMENT_UNKNOWN ${extra.join(" ")}\n`);
    process.exit(2);
  }
  const { errors, notices } = await checkIncidentRuns({ report });
  if (report && process.env.GITHUB_STEP_SUMMARY) {
    const lines = notices.filter(
      (notice) =>
        notice.startsWith("INCIDENT_RUNS_UNCLAIMED_ELSEWHERE") ||
        notice.startsWith("INCIDENT_RUNS_PENDING"),
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## main 上还没认领的失败运行\n\n${lines.length === 0 ? "没有。" : lines.map((line) => `- ${line}`).join("\n")}\n`,
    );
  }
  for (const notice of notices) process.stdout.write(`${notice}\n`);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.some((error) => error.startsWith(RUN_RULE_MARK)))
    process.stderr.write(
      "INCIDENT_RUNS_HELP failed runs on the default branch must be claimed: add a commit line `Incident-run: <run id> [<run id> ...] I-<n>` and make that incident's count at least the number of claimed runs; see .claude/rules/incident-gates.md\n",
    );
  process.stdout.write(
    `INCIDENT_RUNS ${errors.length === 0 ? "passed" : "failed"} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
