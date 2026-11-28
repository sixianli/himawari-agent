import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runsAutomaticallyIn } from "./check-incident-gates.mjs";
import { changedFiles, getJson } from "./check-incident-runs.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_AREAS_FILE = "ci/core-areas.json";
export const SAFETY_HEADING = /^#{2,3}[ \t]*安全依据[ \t]*$/m;
const BACKTICKED_PATH = /`([^`\s]+)`/g;

export function readAreas(root) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(root, CORE_AREAS_FILE), "utf8"));
  } catch {
    return { areas: [], errors: [`PR_SAFETY_AREAS_UNREADABLE ${CORE_AREAS_FILE}`] };
  }
  const areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
  const errors = [];
  if (areas.length === 0) errors.push(`PR_SAFETY_AREAS_EMPTY ${CORE_AREAS_FILE}`);
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  for (const area of areas)
    for (const prefix of area.paths ?? [])
      if (!tracked.some((file) => file.startsWith(prefix)))
        errors.push(`PR_SAFETY_AREA_PATH_MATCHES_NOTHING area="${area.name}" path=${prefix}`);
  return { areas, errors };
}

export function touchedAreas(changed, areas) {
  return areas.filter((area) =>
    changed.some((file) => (area.paths ?? []).some((prefix) => file.startsWith(prefix))),
  );
}

export function safetySection(body) {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const start = text.search(SAFETY_HEADING);
  if (start < 0) return undefined;
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const end = rest.search(/^#{1,3}[ \t]/m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export function judgeSafety({ root, changed, areas, body }) {
  const touched = touchedAreas(changed, areas);
  if (touched.length === 0) return [];
  const names = touched.map((area) => area.name).join("、");
  const section = safetySection(body);
  if (section === undefined || section.length === 0) return [`PR_SAFETY_MISSING areas=${names}`];
  const named = [...section.matchAll(BACKTICKED_PATH)].map((match) => match[1]);
  if (named.some((file) => runsAutomaticallyIn(root, file))) return [];
  return [
    `PR_SAFETY_TEST_MISSING areas=${names} named=${named.length === 0 ? "none" : named.join(",")}`,
  ];
}

export async function checkPrSafety({
  root = repositoryRoot,
  api = process.env.GITHUB_API_URL ?? "https://api.github.com",
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
  repository = process.env.GITHUB_REPOSITORY ?? "",
  eventPath = process.env.GITHUB_EVENT_PATH ?? "",
} = {}) {
  const { areas, errors } = readAreas(root);
  if (errors.length > 0) return { errors, notices: [] };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    return {
      errors: ["PR_SAFETY_REPOSITORY_MISSING set GITHUB_REPOSITORY to owner/name"],
      notices: [],
    };
  let number;
  try {
    number = JSON.parse(readFileSync(eventPath, "utf8")).pull_request?.number;
  } catch {
    number = undefined;
  }
  const changed = Number.isSafeInteger(number) ? changedFiles(root, eventPath) : undefined;
  if (changed === undefined)
    return {
      errors: ["PR_SAFETY_EVENT_MISSING GITHUB_EVENT_PATH has no pull_request with a base commit"],
      notices: [],
    };
  const touched = touchedAreas(changed, areas);
  if (touched.length === 0) return { errors: [], notices: [`PR_SAFETY_NOT_CORE pr=${number}`] };
  try {
    const pull = await getJson(api, token, `/repos/${repository}/pulls/${number}`);
    return {
      errors: judgeSafety({ root, changed, areas, body: pull.body }),
      notices: [`PR_SAFETY_CORE pr=${number} areas=${touched.map((area) => area.name).join("、")}`],
    };
  } catch (error) {
    return {
      errors: [error.message.replace(/^INCIDENT_RUNS_UNAVAILABLE/, "PR_SAFETY_UNAVAILABLE")],
      notices: [],
    };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write(`PR_SAFETY_ARGUMENT_UNKNOWN ${process.argv.slice(2).join(" ")}\n`);
    process.exit(2);
  }
  const { errors, notices } = await checkPrSafety();
  for (const notice of notices) process.stdout.write(`${notice}\n`);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.some((error) => /^PR_SAFETY_(MISSING|TEST_MISSING)/.test(error)))
    process.stderr.write(
      `PR_SAFETY_HELP this PR changes a core area listed in ${CORE_AREAS_FILE}: add a "## 安全依据" section to the PR description that says why the change is safe and names, in backticks, at least one test file that CI runs and that covers the change, then re-run the failed ci/required job; see .claude/rules/incident-gates.md\n`,
    );
  process.stdout.write(
    `PR_SAFETY ${errors.length === 0 ? "passed" : "failed"} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
