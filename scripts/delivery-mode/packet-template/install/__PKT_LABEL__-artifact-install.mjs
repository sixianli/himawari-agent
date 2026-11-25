import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { checkoutFromCache, fetchBundleIntoCache, sourceCachePath } from "./source-cache.mjs";

const head = "__PKT_COMMIT__";
const expected = { "__PKT_BUNDLE_NAME__": "__PKT_BUNDLE_SHA256__", "candidate.tar.gz": "__PKT_ARTIFACT_SHA256__", "context.json": "__PKT_CONTEXT_SHA256__" };
const fail = (condition, message) => { if (!condition) throw new Error(message); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const [input, work, prefix, evidence] = process.argv.slice(2);
fail(process.argv.length === 6 && process.platform === "linux" && process.arch === "__PKT_NODE_ARCH__" && process.version === "v22.22.3", "P5_ENVIRONMENT_INVALID");
for (const value of [input, work, prefix, evidence]) fail(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value, "P5_ARGUMENT_INVALID");
fail(realpathSync(input) === input && realpathSync(evidence) === evidence && !existsSync(work) && !existsSync(prefix), "P5_TARGET_NOT_FRESH");
fail(!evidence.startsWith(work + path.sep) && !input.startsWith(work + path.sep) && !work.startsWith(prefix + path.sep) && !prefix.startsWith(work + path.sep), "P5_PATH_OVERLAP");
const materials = JSON.parse(readFileSync(path.join(input, "p5-materials.json")));
const rehearsal = hostname() === "__PKT_REHEARSAL_HOSTNAME__";
fail((rehearsal && materials.purpose === "hermes-rehearsal" && materials.nonProduction === true && materials.nodeAlreadyInstalled === true) || (!rehearsal && hostname() === "__PKT_HOSTNAME__" && materials.purpose === "cloud-__PKT_LABEL__-install" && materials.nonProduction === false && materials.nodeAlreadyInstalled === true), "P5_MATERIAL_PURPOSE_INVALID");
fail(materials.schemaVersion === 2 && materials.sourceHead === head && materials.files.length === 7, "P5_MATERIALS_INVALID");
for (const item of materials.files) {
  fail([ ...Object.keys(expected), "node-modules.tar.gz", "node-modules.json", "npm-ls.json", "python-3.12.10.tar.gz" ].includes(item.name), "P5_MATERIAL_NAME_INVALID");
  const filename = path.join(input, item.name), info = lstatSync(filename);
  fail(info.isFile() && !info.isSymbolicLink() && info.size === item.bytes && hash(readFileSync(filename)) === item.sha256 && (!expected[item.name] || expected[item.name] === item.sha256), `P5_MATERIAL_CHANGED:${item.name}`);
}
fail(new Set(materials.files.map((item) => item.name)).size === 7, "P5_MATERIALS_DUPLICATE");
fail(hash(readFileSync(process.execPath)) === materials.nodeSha256, "__PKT_LABEL_UPPER___NODE_CHANGED");
mkdirSync(work, { mode: 0o700 });
fail(realpathSync(work) === work, "P5_WORK_PATH_UNSAFE");
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: work, LANG: "C.UTF-8", TMPDIR: work };
const run = (command, args, name, timeout = 300_000) => {
  try {
    const output = execFileSync(command, args, { cwd: work, env, timeout, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (name) writeFileSync(path.join(evidence, `${name}.stdout`), output, { mode: 0o600, flag: "wx" });
    return output.trim();
  } catch (error) {
    if (name) {
      writeFileSync(path.join(evidence, `${name}.stdout`), error.stdout ?? "", { mode: 0o600, flag: "wx" });
      writeFileSync(path.join(evidence, `${name}.stderr`), error.stderr ?? String(error), { mode: 0o600, flag: "wx" });
    }
    throw error;
  }
};
const bundle = path.join(input, "__PKT_BUNDLE_NAME__"), checkout = path.join(work, "source");
fail(run("git", ["bundle", "list-heads", bundle], "bundle-heads") === `${head} HEAD`, "P5_BUNDLE_HEADS_INVALID");
const cache = sourceCachePath(prefix);
fetchBundleIntoCache(cache, bundle, head, run, existsSync(cache));
checkoutFromCache(cache, checkout, head, run);
fail(run("git", ["-C", checkout, "rev-parse", "HEAD"]) === head && run("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"]) === "", "P5_SOURCE_IDENTITY_INVALID");
const pythonRoot = path.join(work, "python");
mkdirSync(pythonRoot, { mode: 0o700 });
const pythonArchive = path.join(input, "python-3.12.10.tar.gz");
const entries = run("tar", ["-tzf", pythonArchive], "python-entries").split("\n");
fail(entries.length > 0 && entries.every((entry) => entry && !entry.startsWith("/") && !entry.split("/").includes("..")), "P5_PYTHON_ARCHIVE_PATH_INVALID");
run("tar", ["-xzf", pythonArchive, "--no-same-owner", "-C", pythonRoot], "python-extract");
const python = path.join(pythonRoot, "python/bin/python3");
fail(run(python, ["--version"], "python-version") === "Python 3.12.10", "P5_PYTHON_VERSION_INVALID");
env.HIMAWARI_CI_PYTHON = python;
const dependencies = JSON.parse(readFileSync(path.join(input, "node-modules.json")));
fail(dependencies.schemaVersion === 2 && dependencies.scope === "whole-locked-node-modules" && dependencies.sourceHead === head && dependencies.node === "v22.22.3" && dependencies.lockCheck.exitCode === 0 && dependencies.packageLockSha256 === hash(readFileSync(path.join(checkout, "package-lock.json"))) && dependencies.archive.sha256 === materials.files.find((item) => item.name === "node-modules.tar.gz").sha256 && dependencies.lockCheck.outputSha256 === hash(readFileSync(path.join(input, "npm-ls.json"))), "P5_DEPENDENCIES_IDENTITY_INVALID");
run("/usr/bin/python3", ["-I", path.join(path.dirname(new URL(import.meta.url).pathname), "extract-node-modules.py"), path.join(input, "node-modules.tar.gz"), path.join(input, "node-modules.json"), checkout], "dependencies-extract");
const moduleEntries = [];
function moduleReadback(directory, relative) {
  const info = lstatSync(directory), item = { path: relative, type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file", mode: info.mode & 0o777 };
  if (info.isDirectory()) { moduleEntries.push(item); for (const name of readdirSync(directory).sort()) moduleReadback(path.join(directory, name), `${relative}/${name}`); }
  else if (info.isSymbolicLink()) moduleEntries.push({ ...item, link: readlinkSync(directory) });
  else { fail(info.isFile(), "P5_MODULE_READBACK_TYPE_INVALID"); const bytes = readFileSync(directory); moduleEntries.push({ ...item, bytes: bytes.length, sha256: hash(bytes) }); }
}
for (const relative of dependencies.dependencyRoots) moduleReadback(path.join(checkout, relative), relative);
const canonical = (items) => JSON.stringify(items.map((item) => Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => a.path.localeCompare(b.path)));
fail(canonical(moduleEntries) === canonical(dependencies.entries), "P5_MODULE_TREE_READBACK_FAILED");
fail(run("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"]) === "", "P5_SOURCE_NOT_CLEAN");
const sourceInputProof = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../materials/source-build-inputs.json"))).sourceBuildInputProof;
const expectedSourceTreeSha256 = "__PKT_SOURCE_TREE_SHA256__";
fail(sourceInputProof?.schemaVersion === 1 && sourceInputProof.sourceHead === head && sourceInputProof.sourceTreeSha256 === expectedSourceTreeSha256 && Array.isArray(sourceInputProof.records) && sourceInputProof.records.length === __PKT_SOURCE_INPUT_RECORD_COUNT__, "P5_SOURCE_BUILD_INPUT_PROOF_INVALID");
const sourceInputRecords = sourceInputProof.records.map((record) => {
  fail(record && Object.keys(record).sort().join(",") === "mode,path,sha256" && typeof record.path === "string" && /^[A-Za-z0-9._/-]+$/.test(record.path) && !path.isAbsolute(record.path) && record.path.split("/").every((part) => part && part !== "." && part !== "..") && /^[a-f0-9]{64}$/.test(record.sha256) && [0o644, 0o664].includes(record.mode), "P5_SOURCE_BUILD_INPUT_RECORD_INVALID");
  return { path: record.path, sha256: record.sha256, mode: record.mode };
});
fail(new Set(sourceInputRecords.map((record) => record.path)).size === sourceInputRecords.length && sourceInputRecords.every((record, index) => index === 0 || sourceInputRecords[index - 1].path < record.path) && hash(JSON.stringify(sourceInputRecords)) === expectedSourceTreeSha256, "P5_SOURCE_BUILD_INPUT_RECORDS_CHANGED");
const { sourceTreeDigest } = await import(pathToFileURL(path.join(checkout, "scripts/ci/verify-artifact.mjs")));
const sourceTreeBefore = await sourceTreeDigest(checkout);
const sourceInputReadbacks = sourceInputRecords.map((record) => {
  const filename = path.join(checkout, record.path), info = lstatSync(filename), bytes = readFileSync(filename);
  fail(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && realpathSync(filename) === filename && hash(bytes) === record.sha256, `P5_SOURCE_BUILD_INPUT_BYTES_CHANGED:${record.path}`);
  return { ...record, beforeMode: info.mode & 0o777, device: info.dev, inode: info.ino, bytes: bytes.length };
});
for (const record of sourceInputReadbacks) {
  const filename = path.join(checkout, record.path), before = lstatSync(filename);
  fail(before.dev === record.device && before.ino === record.inode && before.uid === process.getuid() && before.nlink === 1 && (before.mode & 0o777) === record.beforeMode && hash(readFileSync(filename)) === record.sha256, `P5_SOURCE_BUILD_INPUT_CHANGED_BEFORE_MODE:${record.path}`);
  chmodSync(filename, record.mode);
  const after = lstatSync(filename);
  fail(after.isFile() && after.dev === record.device && after.ino === record.inode && after.uid === process.getuid() && after.nlink === 1 && (after.mode & 0o777) === record.mode && realpathSync(filename) === filename && hash(readFileSync(filename)) === record.sha256, `P5_SOURCE_BUILD_INPUT_CHANGED_AFTER_MODE:${record.path}`);
}
const sourceTreeAfter = await sourceTreeDigest(checkout);
fail(sourceTreeAfter === expectedSourceTreeSha256 && run("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"]) === "", "P5_SOURCE_BUILD_INPUT_RESTORATION_FAILED");
writeFileSync(path.join(evidence, "source-build-inputs-readback.json"), JSON.stringify({ schemaVersion: 1, passed: true, scope: "permission restoration in owned validation source only; original artifact verification still required", sourceHead: head, sourceTreeBefore, sourceTreeAfter, expectedSourceTreeSha256, changedModes: sourceInputReadbacks.filter((record) => record.beforeMode !== record.mode).length, records: sourceInputReadbacks, checkedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const installer = path.join(checkout, "scripts/install-node-runtime.mjs");
const installArgs = ["--no-global-search-paths", installer, "--artifact", path.join(input, "candidate.tar.gz"), "--context", path.join(input, "context.json"), "--expected-sha256", expected["candidate.tar.gz"], "--prefix", prefix];
writeFileSync(path.join(evidence, "install-command.json"), JSON.stringify({ executable: process.execPath, args: installArgs, sourceHead: head, materials, python, runtimeDoesNotDependOnValidationMaterials: true }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
run(process.execPath, installArgs, "install");
const uiVerified = path.join(work, "ui-verified");
run(process.execPath, ["--no-global-search-paths", path.join(checkout, "scripts/ci/verify-artifact.mjs"), "--archive", path.join(input, "candidate.tar.gz"), "--context", path.join(input, "context.json"), "--extract-to", uiVerified, "--expected-sha256", expected["candidate.tar.gz"]], "ui-verifier");
const manifestText = readFileSync(path.join(uiVerified, "artifact-record.json"), "utf8");
const { assertArtifactRecord } = await import(pathToFileURL(path.join(checkout, "scripts/ci/verify-artifact.mjs")));
const manifest = assertArtifactRecord(JSON.parse(manifestText));
const installationFiles = manifest.files.filter((item) => item.path.startsWith("runtime/")).map((item) => ({ ...item, path: `lib/himawari-agent/${item.path.slice(8)}` }));
const browserFiles = manifest.files.filter((item) => item.path.startsWith("browser/"));
fail(browserFiles.length > 0, "P5_BROWSER_MISSING");
const ui = path.join(prefix, "share/control-center");
mkdirSync(path.join(prefix, "share"), { mode: 0o755 });
cpSync(path.join(uiVerified, "browser"), ui, { recursive: true, errorOnExist: true, force: false });
for (const file of browserFiles) {
  const relative = file.path.slice(8), filename = path.join(ui, relative), info = lstatSync(filename);
  fail(info.isFile() && !info.isSymbolicLink() && info.size === file.bytes && hash(readFileSync(filename)) === file.sha256, `P5_BROWSER_READBACK_FAILED:${relative}`);
  chmodSync(filename, 0o644);
  installationFiles.push({ ...file, path: `share/control-center/${relative}`, mode: 0o644 });
}
writeFileSync(path.join(evidence, "browser-readback.json"), JSON.stringify({ staticRoot: ui, files: browserFiles.length, sourceArchiveSha256: expected["candidate.tar.gz"], contentSha256: hash(JSON.stringify(browserFiles)), copiedOnlyAfterCompleteVerifier: true }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
for (const command of ["himawari", "himawari-agent-service", "himawari-execution-worker"]) {
  const filename = path.join(prefix, "bin", command), info = lstatSync(filename), bytes = readFileSync(filename);
  fail(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o755, `P5_WRAPPER_UNSAFE:${command}`);
  installationFiles.push({ path: `bin/${command}`, sha256: hash(bytes), bytes: bytes.length, mode: 0o755 });
}
installationFiles.sort((a, b) => a.path.localeCompare(b.path));
const runtime = path.join(prefix, "lib/himawari-agent");
const { digestSandboxRuntime } = await import(pathToFileURL(path.join(runtime, "node_modules/@himawari-agent/platform-node/dist/capabilities/sandbox-host-verifier.js")));
const digest = await digestSandboxRuntime(prefix), expectedDigest = hash(JSON.stringify(installationFiles));
fail(digest === expectedDigest, "P5_INSTALLED_CHECKER_MISMATCH");
writeFileSync(path.join(evidence, "installed-checker.json"), JSON.stringify({ passed: true, installedRuntime: realpathSync(runtime), prefix, digest, expectedDigest, files: installationFiles.length, checkedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const prefixInfo = lstatSync(prefix);
writeFileSync(path.join(evidence, "installed-owned.json"), JSON.stringify({ schemaVersion: 1, phase: "p5", paths: [{ path: prefix, device: prefixInfo.dev, inode: prefixInfo.ino, uid: prefixInfo.uid, gid: prefixInfo.gid, kind: "directory" }], createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const workInfo = lstatSync(work);
writeFileSync(path.join(evidence, "validation-owned.json"), JSON.stringify({ schemaVersion: 1, phase: "p5-validation", paths: [{ path: work, device: workInfo.dev, inode: workInfo.ino, uid: workInfo.uid, gid: workInfo.gid, kind: "directory" }], createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
for (const item of materials.files) fail(hash(readFileSync(path.join(input, item.name))) === item.sha256, `P5_MATERIAL_CHANGED_AFTER_INSTALL:${item.name}`);
process.stdout.write(JSON.stringify({ passed: true, prefix, digest, evidence, validationMaterialsRemoved: false, validationRetainedUntilFullP8: true }) + "\n");
