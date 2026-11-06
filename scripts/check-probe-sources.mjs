import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECORD = "scripts/delivery-mode/probe-sources.json";
const BOOTSTRAP = "scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs";
const SOURCE_DIRECTORY = "packages/runtime-sandbox/src/";
const BUILT_NAME = /^[a-z-]+\.js$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PACKET_CHECK_ENTRY = /(?<=^|\n)\s+"([a-z-]+\.js)": "([0-9a-f]{64})",(?=\n|$)/g;
const REFRESH_HINT =
  "PROBE_SOURCES_REFRESH build the candidate on Hermes, put the new runtime-sandbox/dist digests into the probe bootstrap and both digests into " +
  RECORD;
const PASSED_NOTE =
  "PROBE_SOURCES_NOTE built digests are only compared with a real build by the packet check on Hermes";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readPlainFile(root, relative) {
  const full = path.join(root, relative);
  if (!existsSync(full)) return { missing: true };
  try {
    if (!lstatSync(full).isFile()) return { unreadable: true };
    return { bytes: readFileSync(full) };
  } catch {
    return { unreadable: true };
  }
}

function recordProblems(record) {
  if (record?.bootstrap !== BOOTSTRAP) return ["PROBE_SOURCES_RECORD_INVALID bootstrap"];
  if (!Array.isArray(record.files) || record.files.length === 0)
    return ["PROBE_SOURCES_RECORD_INVALID files"];
  const problems = record.files.flatMap((file, index) =>
    typeof file?.built === "string" &&
    BUILT_NAME.test(file.built) &&
    typeof file.source === "string" &&
    file.source === `${SOURCE_DIRECTORY}${file.built.replace(/\.js$/, ".ts")}` &&
    typeof file.builtSha256 === "string" &&
    DIGEST.test(file.builtSha256) &&
    typeof file.sourceSha256 === "string" &&
    DIGEST.test(file.sourceSha256)
      ? []
      : [`PROBE_SOURCES_RECORD_INVALID files[${index}]`],
  );
  const names = record.files.map((file) => file?.built);
  if (new Set(names).size !== names.length)
    problems.push("PROBE_SOURCES_RECORD_INVALID duplicate built");
  return problems;
}

function bootstrapDigests(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const start = lines.indexOf("const originals = {");
  const end = start === -1 ? -1 : lines.indexOf("};", start + 1);
  if (end === -1) return null;
  const parsed = { entries: [], malformed: [], outside: [] };
  const entryLines = new Set();
  for (const match of normalized.matchAll(PACKET_CHECK_ENTRY)) {
    const nameAt = match.index + match[0].indexOf('"');
    const line = normalized.slice(0, nameAt).split("\n").length - 1;
    entryLines.add(line);
    parsed.entries.push([match[1], match[2]]);
    if (line <= start || line >= end) parsed.outside.push(match[1]);
  }
  lines.forEach((line, index) => {
    const inside = index > start && index < end;
    if (inside && !entryLines.has(index) && /[0-9a-f]{64}/.test(line))
      parsed.malformed.push(line.trim());
  });
  return parsed;
}

export function probeSourceProblems(root) {
  const recordFile = readPlainFile(root, RECORD);
  if (recordFile.missing) return [`PROBE_SOURCES_RECORD_MISSING ${RECORD}`];
  if (recordFile.unreadable) return [`PROBE_SOURCES_RECORD_UNREADABLE ${RECORD}`];
  let record;
  try {
    record = JSON.parse(recordFile.bytes.toString("utf8"));
  } catch {
    return ["PROBE_SOURCES_RECORD_INVALID json"];
  }
  const invalid = recordProblems(record);
  if (invalid.length) return invalid;
  const bootstrapFile = readPlainFile(root, BOOTSTRAP);
  if (bootstrapFile.missing) return [`PROBE_BOOTSTRAP_MISSING ${BOOTSTRAP}`];
  if (bootstrapFile.unreadable) return [`PROBE_BOOTSTRAP_UNREADABLE ${BOOTSTRAP}`];
  const text = bootstrapFile.bytes.toString("utf8");
  const parsed = bootstrapDigests(text);
  if (!parsed || parsed.entries.length + parsed.malformed.length === 0)
    return [`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND ${BOOTSTRAP}`];
  const { entries, malformed } = parsed;
  const recorded = new Map(entries);
  const problems = [
    ...malformed.map((line) => `PROBE_BOOTSTRAP_ENTRY_FORMAT ${line}`),
    ...parsed.outside.map((name) => `PROBE_BOOTSTRAP_ENTRY_OUTSIDE_ORIGINALS ${name}`),
  ];
  if (recorded.size !== entries.length) problems.push("PROBE_BOOTSTRAP_DUPLICATE_NAME");
  const listed = new Set(record.files.map((file) => file.built));
  for (const name of recorded.keys())
    if (!listed.has(name)) problems.push(`PROBE_SOURCE_UNLISTED ${name}`);
  for (const file of record.files) {
    if (recorded.get(file.built) !== file.builtSha256)
      problems.push(
        `PROBE_BUILT_DIGEST_MISMATCH ${file.built} bootstrap=${recorded.get(file.built) ?? "absent"} record=${file.builtSha256}`,
      );
    const source = readPlainFile(root, file.source);
    if (source.missing) {
      problems.push(`PROBE_SOURCE_MISSING ${file.source}`);
      continue;
    }
    if (source.unreadable) {
      problems.push(`PROBE_SOURCE_UNREADABLE ${file.source}`);
      continue;
    }
    const actual = sha256(source.bytes);
    if (actual !== file.sourceSha256)
      problems.push(
        `PROBE_SOURCE_CHANGED ${file.source} recorded=${file.sourceSha256.slice(0, 12)} now=${actual.slice(0, 12)}`,
      );
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = probeSourceProblems(path.resolve(process.argv[2] ?? "."));
  for (const problem of problems) console.log(problem);
  console.log(problems.length ? REFRESH_HINT : PASSED_NOTE);
  console.log(`PROBE_SOURCES ${problems.length ? "failed" : "passed"}`);
  process.exitCode = problems.length ? 1 : 0;
}
