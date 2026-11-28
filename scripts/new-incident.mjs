import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { INCIDENT_LIST, readIncidents } from "./check-incident-gates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 4;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ATTEMPTS = 100;

export function jstDate(now = new Date()) {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextIncidentId(existing, { now = new Date(), pick = randomInt } = {}) {
  const stamp = jstDate(now).slice(2).replaceAll("-", "");
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const suffix = Array.from({ length: SUFFIX_LENGTH }, () => ALPHABET[pick(ALPHABET.length)]);
    const id = `I-${stamp}-${suffix.join("")}`;
    if (!existing.has(id)) return id;
  }
  throw new Error("INCIDENT_NEW_NO_FREE_ID");
}

export function insertIncidentRow(text, row) {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| 编号 |"));
  if (header < 0) throw new Error("INCIDENT_TABLE_MISSING");
  let end = header + 2;
  while (end < lines.length && lines[end].trimStart().startsWith("|")) end += 1;
  lines.splice(end, 0, row);
  return lines.join("\n");
}

function idsOnMain(root) {
  try {
    const text = execFileSync("git", ["show", `origin/main:${INCIDENT_LIST}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
    return readIncidents(text).incidents.map((incident) => incident.id);
  } catch {
    return [];
  }
}

export function addIncident(symptom, { root = repositoryRoot, now = new Date(), pick } = {}) {
  const text = (symptom ?? "").trim();
  if (!text || /[|\n]/.test(text)) throw new Error("INCIDENT_NEW_SYMPTOM_INVALID");
  const file = path.join(root, INCIDENT_LIST);
  const list = readFileSync(file, "utf8");
  const existing = new Set([
    ...readIncidents(list).incidents.map((incident) => incident.id),
    ...idsOnMain(root),
  ]);
  const id = nextIncidentId(existing, { now, pick });
  const row = `| ${id} | ${jstDate(now)} | ${text} | 待查 | 1 | 待定 | 缺门槛 |`;
  writeFileSync(file, insertIncidentRow(list, row));
  return id;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const symptom = process.argv.slice(2).join(" ");
  try {
    process.stdout.write(`${addIncident(symptom)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error.message}\nUsage: npm run incident:new -- <一句话现象，不含 | 和换行>\n`,
    );
    process.exit(2);
  }
}
