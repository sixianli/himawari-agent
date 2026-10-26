import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const [profile, srtPath, programPath] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert(["hermes-rehearsal", "cloud-__PKT_LABEL__-change"].includes(profile));
assert.equal(process.platform, "linux");
assert(process.getuid() > 0);
assert.equal(srtPath, "/usr/bin/bwrap");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function identity(requestedPath, apparmorPath, minimum) {
  assert(path.isAbsolute(requestedPath));
  const resolved = await realpath(requestedPath);
  const metadata = await lstat(resolved);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.mode & 0o111);
  const versionOutput = execFileSync(resolved, ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
  const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(versionOutput);
  assert(match, "BWRAP_VERSION_UNRECOGNIZED");
  const version = match.slice(1).map(Number);
  const minimumSatisfied = minimum === null || version[0] > 0 || version[1] > 11 || version[1] === 11 && version[2] >= 2;
  const result = { requestedPath, realpath: resolved, version: match.slice(1).join("."), versionOutput, sha256: hash(await readFile(resolved)), minimum, minimumSatisfied, executionProbePerformed: false, apparmorProfile: { path: apparmorPath, present: false } };
  try {
    const info = await lstat(apparmorPath);
    assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o022));
    result.apparmorProfile = { path: apparmorPath, present: true, sha256: hash(await readFile(apparmorPath)) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return result;
}
const srt = await identity(srtPath, "/etc/apparmor.d/bwrap", null);
const program = await identity(programPath, "/etc/apparmor.d/bwrap-0.11.2", "0.11.2");
if (profile === "cloud-__PKT_LABEL__-change") {
  assert.equal(programPath, "/usr/local/libexec/bubblewrap-0.11.2/bwrap");
  assert(program.minimumSatisfied, "PROGRAM_STDIO_BWRAP_MINIMUM_VERSION_REQUIRED");
  assert(srt.apparmorProfile.present && program.apparmorProfile.present, "CLOUD_BWRAP_APPARMOR_PROFILE_REQUIRED");
}
console.log(JSON.stringify({ schema: "himawari-__PKT_LABEL__-deployment-bwrap-identities.v1", profile, nonProduction: profile === "hermes-rehearsal", productionQualificationIssued: false, srt, program, sameBinaryRequired: false, programStdioBackendQualified: false, passed: true }));
