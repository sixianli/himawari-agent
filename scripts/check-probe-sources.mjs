import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const RECORD = "scripts/delivery-mode/probe-sources.json";
const REFRESH_HINT =
  "PROBE_SOURCES_REFRESH build the candidate on Hermes, put the new runtime-sandbox/dist digests into the probe bootstrap and both digests into " +
  RECORD;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function probeSourceProblems(root) {
  const recordPath = path.join(root, RECORD);
  if (!existsSync(recordPath)) return [`PROBE_SOURCES_RECORD_MISSING ${RECORD}`];
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const bootstrapPath = path.join(root, record.bootstrap);
  if (!existsSync(bootstrapPath)) return [`PROBE_BOOTSTRAP_MISSING ${record.bootstrap}`];
  const recorded = new Map(
    [
      ...readFileSync(bootstrapPath, "utf8").matchAll(/^\s+"([a-z-]+\.js)": "([0-9a-f]{64})",$/gm),
    ].map((match) => [match[1], match[2]]),
  );
  const problems = [];
  const listed = new Set(record.files.map((file) => file.built));
  for (const name of recorded.keys())
    if (!listed.has(name)) problems.push(`PROBE_SOURCE_UNLISTED ${name}`);
  for (const file of record.files) {
    if (recorded.get(file.built) !== file.builtSha256)
      problems.push(
        `PROBE_BUILT_DIGEST_MISMATCH ${file.built} bootstrap=${recorded.get(file.built) ?? "absent"} record=${file.builtSha256}`,
      );
    const sourcePath = path.join(root, file.source);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = probeSourceProblems(path.resolve(process.argv[2] ?? "."));
  for (const problem of problems) console.log(problem);
  if (problems.length) console.log(REFRESH_HINT);
  console.log(`PROBE_SOURCES ${problems.length ? "failed" : "passed"}`);
  process.exitCode = problems.length ? 1 : 0;
}
