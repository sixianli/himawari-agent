import { existsSync, readFileSync } from "node:fs";
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
  const { incidents, errors } = readIncidents(readFileSync(file, "utf8"));
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
  }
  if (incidents.length === 0) errors.push("INCIDENT_TABLE_EMPTY");
  return { incidents, errors };
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
  const { incidents, errors } = checkIncidentGates();
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
