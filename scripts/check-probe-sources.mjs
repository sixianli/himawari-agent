import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECORD = "scripts/delivery-mode/probe-sources.json";
const REFRESH_HINT =
  "PROBE_SOURCES_REFRESH build the candidate on Hermes, put the new runtime-sandbox/dist digests into the probe bootstrap and both digests into " +
  RECORD +
  "; changing only sourceSha256 without a Hermes build leaves the packet check to fail later";
const DIGEST = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

function recordProblems(root, record) {
  if (typeof record?.bootstrap !== "string" || !inside(root, record.bootstrap))
    return ["PROBE_SOURCES_RECORD_INVALID bootstrap"];
  if (!Array.isArray(record.files) || record.files.length === 0)
    return ["PROBE_SOURCES_RECORD_INVALID files"];
  return record.files.flatMap((file, index) =>
    typeof file?.built === "string" &&
    typeof file.source === "string" &&
    inside(root, file.source) &&
    DIGEST.test(file.builtSha256) &&
    DIGEST.test(file.sourceSha256)
      ? []
      : [`PROBE_SOURCES_RECORD_INVALID files[${index}]`],
  );
}

export function probeSourceProblems(root) {
  const recordPath = path.join(root, RECORD);
  if (!existsSync(recordPath)) return [`PROBE_SOURCES_RECORD_MISSING ${RECORD}`];
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    return ["PROBE_SOURCES_RECORD_INVALID json"];
  }
  const invalid = recordProblems(root, record);
  if (invalid.length) return invalid;
  const bootstrapPath = inside(root, record.bootstrap);
  if (!existsSync(bootstrapPath)) return [`PROBE_BOOTSTRAP_MISSING ${record.bootstrap}`];
  const recorded = new Map(
    [...readFileSync(bootstrapPath, "utf8").matchAll(/"([^"\n]+)"\s*:\s*"([0-9a-f]{64})"/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  if (recorded.size === 0) return [`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND ${record.bootstrap}`];
  const problems = [];
  const listed = new Set(record.files.map((file) => file.built));
  for (const name of recorded.keys())
    if (!listed.has(name)) problems.push(`PROBE_SOURCE_UNLISTED ${name}`);
  for (const file of record.files) {
    if (recorded.get(file.built) !== file.builtSha256)
      problems.push(
        `PROBE_BUILT_DIGEST_MISMATCH ${file.built} bootstrap=${recorded.get(file.built) ?? "absent"} record=${file.builtSha256}`,
      );
    const sourcePath = inside(root, file.source);
    if (!existsSync(sourcePath)) {
      problems.push(`PROBE_SOURCE_MISSING ${file.source}`);
      continue;
    }
    const actual = sha256(readFileSync(sourcePath));
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
  if (problems.length) console.log(REFRESH_HINT);
  console.log(`PROBE_SOURCES ${problems.length ? "failed" : "passed"}`);
  process.exitCode = problems.length ? 1 : 0;
}
