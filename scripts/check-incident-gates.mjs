import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INCIDENT_LIST = "docs/incidents-and-gates.md";
export const INCIDENT_STATES = Object.freeze(["已落门槛", "缺门槛", "等 Andy", "仓库外"]);
const HARD_GATE_STATES = new Set(["已落门槛", "等 Andy", "仓库外"]);
const OPEN_STATES = new Set(INCIDENT_STATES.filter((state) => state !== "已落门槛"));
const SHORT_SYMPTOM_LENGTH = 80;
const COLUMNS = ["编号", "日期", "现象", "根因", "次数", "门槛（文件或命令）", "状态"];
const REPOSITORY_PATH = /`((?:\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_.-]+)`/g;
export const RULE_FILE = "scripts/check-incident-gates.mjs";
export const RULE_MARK = "INCIDENT_TRAILER_MISSING";
const INCIDENT_ID = /^I-\d{2,}$/;
const INCIDENT_LINE = /^Incident:[ \t]*(.*?)[ \t]*$/gm;
const FOLLOW_UP_LINE = /^Incident-follow-up:[ \t]*(.*?)[ \t]*$/gm;
const GITHUB_COMMITTER = "noreply@github.com";
const TEST_FILE = /(^|\/)test_[^/]+\.py$|\.test\.[cm]?[jt]sx?$|Tests\.swift$/;
const RUNNER_FILES = ["package.json"];
const RUNNER_DIRECTORIES = ["scripts/git-hooks", ".github/workflows"];

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function readIncidents(text) {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| 编号 |"));
  if (header < 0) return { incidents: [], errors: ["INCIDENT_TABLE_MISSING"] };
  const errors = [];
  if (cells(lines[header]).join("|") !== COLUMNS.join("|"))
    errors.push(`INCIDENT_TABLE_COLUMNS_CHANGED expected ${COLUMNS.join(" | ")}`);
  const incidents = [];
  let end = header + 2;
  for (; end < lines.length && lines[end].trimStart().startsWith("|"); end += 1) {
    const [id, date, symptom, cause, count, gate, state] = cells(lines[end]);
    incidents.push({ id, date, symptom, cause, count, gate, state });
  }
  for (const line of [...lines.slice(0, header), ...lines.slice(end)])
    if (/^\s*\|\s*I-\d/.test(line)) errors.push(`INCIDENT_ROW_OUTSIDE_TABLE ${cells(line)[0]}`);
  return { incidents, errors };
}

export function checkIncidentGates({ root = repositoryRoot } = {}) {
  const file = path.join(root, INCIDENT_LIST);
  if (!existsSync(file))
    return { incidents: [], errors: [`INCIDENT_LIST_MISSING ${INCIDENT_LIST}`] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { incidents: [], errors: [`INCIDENT_LIST_UNREADABLE ${INCIDENT_LIST}`] };
  }
  const { incidents, errors } = readIncidents(text);
  const runners = runnerText(root);
  const seen = new Set();
  for (const incident of incidents) {
    const where = incident.id || "(no id)";
    if (!/^I-\d{2,}$/.test(incident.id)) errors.push(`INCIDENT_ID_INVALID ${where}`);
    if (seen.has(incident.id)) errors.push(`INCIDENT_ID_REPEATED ${where}`);
    seen.add(incident.id);
    if (!/^\d{4}-\d{2}-\d{2}/.test(incident.date ?? ""))
      errors.push(`INCIDENT_DATE_INVALID ${where}`);
    for (const [name, value] of [
      ["symptom", incident.symptom],
      ["cause", incident.cause],
      ["gate", incident.gate],
    ])
      if (!value) errors.push(`INCIDENT_FIELD_EMPTY ${where} ${name}`);
    const count = Number.parseInt(incident.count ?? "", 10);
    if (!Number.isSafeInteger(count) || count < 1) errors.push(`INCIDENT_COUNT_INVALID ${where}`);
    if (!INCIDENT_STATES.includes(incident.state))
      errors.push(`INCIDENT_STATE_INVALID ${where} ${incident.state}`);
    if (count >= 3 && !HARD_GATE_STATES.has(incident.state))
      errors.push(`INCIDENT_THIRD_REPEAT_WITHOUT_HARD_GATE ${where} count=${count}`);
    const paths = [...(incident.gate ?? "").matchAll(REPOSITORY_PATH)].map((match) => match[1]);
    if (incident.state === "已落门槛" && paths.length === 0)
      errors.push(`INCIDENT_GATE_NOT_NAMED ${where}`);
    for (const relative of paths)
      if (!existsSync(path.join(root, relative)))
        errors.push(`INCIDENT_GATE_PATH_MISSING ${where} ${relative}`);
    if (
      count >= 3 &&
      incident.state === "已落门槛" &&
      paths.length > 0 &&
      !paths.some((relative) => runsAutomatically(relative, runners))
    )
      errors.push(`INCIDENT_GATE_NOT_AUTOMATIC ${where}`);
  }
  if (incidents.length === 0) errors.push("INCIDENT_TABLE_EMPTY");
  return { incidents, errors };
}

function runnerText(root) {
  const texts = [];
  for (const file of RUNNER_FILES) {
    const full = path.join(root, file);
    if (existsSync(full)) texts.push(readFileSync(full, "utf8"));
  }
  for (const directory of RUNNER_DIRECTORIES) {
    const full = path.join(root, directory);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { withFileTypes: true }))
      if (entry.isFile()) texts.push(readFileSync(path.join(full, entry.name), "utf8"));
  }
  return texts.join("\n");
}

function runsAutomatically(relative, runners) {
  return TEST_FILE.test(relative) || runners.includes(relative);
}

export function readCommitIncidents(message) {
  const text = message
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const values = [...text.matchAll(INCIDENT_LINE)].map((match) => match[1]);
  const followUps = [...text.matchAll(FOLLOW_UP_LINE)].map((match) => match[1]);
  const invalid = [
    ...values.filter((value) => value !== "none" && !INCIDENT_ID.test(value)),
    ...followUps.filter((value) => !INCIDENT_ID.test(value)),
  ];
  return {
    declared: values.length + followUps.length > 0,
    occurrences: [...new Set(values.filter((value) => INCIDENT_ID.test(value)))],
    followUps: [...new Set(followUps.filter((value) => INCIDENT_ID.test(value)))],
    invalid,
  };
}

export function checkCommitMessage(message, known) {
  const { declared, occurrences, followUps, invalid } = readCommitIncidents(message);
  const errors = [];
  if (!declared) errors.push(`${RULE_MARK} commit-msg`);
  for (const value of invalid) errors.push(`INCIDENT_TRAILER_INVALID commit-msg ${value}`);
  for (const id of [...occurrences, ...followUps])
    if (!known.has(id)) errors.push(`INCIDENT_TRAILER_UNKNOWN commit-msg ${id}`);
  return errors;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function ruleActivation(root) {
  const found = git(root, [
    "log",
    "--reverse",
    "--format=%H",
    "-S",
    RULE_MARK,
    "HEAD",
    "--",
    RULE_FILE,
  ])
    .split("\n")
    .filter(Boolean);
  return found[0] ?? "";
}

function requiredCommits(root, activation) {
  if (!activation) return new Set();
  return new Set(
    git(root, ["rev-list", "--no-merges", "--ancestry-path", `${activation}..HEAD`])
      .split("\n")
      .filter(Boolean)
      .concat(activation),
  );
}

export function checkIncidentHistory({ root = repositoryRoot, incidents } = {}) {
  const errors = [];
  try {
    if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true")
      return [
        "INCIDENT_HISTORY_SHALLOW the clone is shallow, so repeat counts cannot be read; run git fetch --unshallow origin",
      ];
  } catch {
    return ["INCIDENT_HISTORY_UNAVAILABLE not a git checkout, so repeat counts cannot be read"];
  }
  const table = new Map(
    incidents.map((incident) => [incident.id, Number.parseInt(incident.count ?? "", 10)]),
  );
  const required = requiredCommits(root, ruleActivation(root));
  const log = git(root, ["log", "--no-merges", "--format=%H%x00%ce%x00%B%x1e", "HEAD"]);
  const seen = new Map();
  for (const record of log.split("\x1e")) {
    const [sha, committer, message] = record.replace(/^\n/, "").split("\0");
    if (!sha || message === undefined) continue;
    const short = sha.slice(0, 12);
    const { declared, occurrences, followUps, invalid } = readCommitIncidents(message);
    if (required.has(sha) && committer !== GITHUB_COMMITTER) {
      if (!declared) errors.push(`${RULE_MARK} ${short}`);
      for (const value of invalid) errors.push(`INCIDENT_TRAILER_INVALID ${short} ${value}`);
    }
    for (const id of [...occurrences, ...followUps])
      if (!table.has(id)) errors.push(`INCIDENT_TRAILER_UNKNOWN ${short} ${id}`);
    for (const id of occurrences) seen.set(id, [...(seen.get(id) ?? []), short]);
  }
  for (const [id, commits] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
    const count = table.get(id);
    if (Number.isSafeInteger(count) && count < commits.length)
      errors.push(
        `INCIDENT_COUNT_BELOW_HISTORY ${id} table=${count} commits=${commits.length} ${commits.join(",")}`,
      );
  }
  return errors;
}

function firstSentence(text) {
  const end = text.search(/[。！？]/);
  const characters = Array.from(end < 0 ? text : text.slice(0, end + 1));
  return characters.length > SHORT_SYMPTOM_LENGTH
    ? `${characters.slice(0, SHORT_SYMPTOM_LENGTH).join("")}…`
    : characters.join("");
}

export function openIncidentLines(incidents) {
  return incidents
    .filter((incident) => OPEN_STATES.has(incident.state))
    .map(
      (incident) =>
        `${incident.id} | ${incident.state} | ${incident.date} | ${firstSentence(incident.symptom ?? "")}`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsGiven = process.argv.slice(2);
  if (argumentsGiven[0] === "--commit-msg" && argumentsGiven.length === 2) {
    let merging = false;
    try {
      merging = existsSync(git(repositoryRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim());
    } catch {}
    if (!merging) {
      const { incidents, errors: listErrors } = checkIncidentGates();
      const known = new Set(incidents.map((incident) => incident.id));
      const errors = [
        ...listErrors,
        ...checkCommitMessage(readFileSync(argumentsGiven[1], "utf8"), known),
      ];
      for (const error of errors) process.stderr.write(`${error}\n`);
      if (errors.length > 0) {
        process.stderr.write(
          "INCIDENT_TRAILER_HELP every commit needs a line `Incident: I-<n>` (this commit fixes one more occurrence of that incident), `Incident-follow-up: I-<n>` (more work on an occurrence already counted) or `Incident: none`; see .claude/rules/incident-gates.md\n",
        );
        process.exit(1);
      }
    }
    process.exit(0);
  }
  const unknown = argumentsGiven.filter((argument) => argument !== "--open");
  if (unknown.length > 0) {
    process.stderr.write(`INCIDENT_ARGUMENT_UNKNOWN ${unknown.join(" ")}\n`);
    process.exit(2);
  }
  const { incidents, errors } = checkIncidentGates();
  if (!process.argv.includes("--open") && errors.length === 0)
    errors.push(...checkIncidentHistory({ incidents }));
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (process.argv.includes("--open") && errors.length > 0) {
    process.stdout.write(`INCIDENT_OPEN unavailable errors=${errors.length}\n`);
  } else if (process.argv.includes("--open")) {
    const lines = openIncidentLines(incidents);
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.stdout.write(`INCIDENT_OPEN count=${lines.length} total=${incidents.length}\n`);
  }
  process.stdout.write(
    `INCIDENT_GATES ${errors.length === 0 ? "passed" : "failed"} incidents=${incidents.length} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
