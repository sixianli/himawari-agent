import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = "__BUILDER_SOURCE__";
const evidence = "__BUILDER_EVIDENCE_ROOT__/sixth-source-inputs-01";
const tool = "__BUILDER_EVIDENCE_ROOT__/sixth-source-inputs-01/capture-build-source-inputs.mjs";
const output = path.join(evidence, "source-build-inputs.json");
const revision = "__REVISION__";
const expectedDigest = "__EXPECTED_DIGEST__";
const parentKeys = ["device", "inode", "uid", "gid", "mode", "type"];
const entrypoints = ["scripts/ci/build.mjs", "scripts/package-node-runtime.mjs", "scripts/generate-artifact-manifest.mjs", "scripts/check-control-center-build.mjs"];
const report = { schema: "himawari-p5-build-source-inputs-capture.v1", passed: false, startedAt: new Date().toISOString(), hostname: os.hostname(), uid: process.getuid(), gid: process.getgid(), node: process.version, source, sourceHead: revision, expectedSourceTreeSha256: expectedDigest, output, stage: "environment", records: [], inputReadbacks: [], modules: [], error: null, sourceWritesPerformed: false, permissionChangesPerformed: false, artifactVerificationPerformed: false };
let outputHandle;
let outputCreated;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(data) {
  return createHash("sha256").update(data).digest("hex");
}

function identity(info) {
  return { device: String(info.dev), inode: String(info.ino), uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o777n), type: Number(info.mode & 0o170000n), nlink: Number(info.nlink), bytes: Number(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}

function same(left, right, keys = Object.keys(left)) {
  return keys.every((key) => left[key] === right[key]);
}

function failure(error) {
  return { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.path ? { path: error.path } : {}) };
}

function relativePath(value) {
  require(typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\") && path.posix.normalize(value) === value && value.split("/").every((part) => part && part !== "." && part !== ".."), "BUILD_CAPTURE_RELATIVE_PATH_INVALID:" + value);
  return value;
}

async function parentChain(filename) {
  const result = [];
  let current = path.dirname(filename);
  while (true) {
    const info = await lstat(current, { bigint: true });
    require(info.isDirectory() && !info.isSymbolicLink() && await realpath(current) === current && [0, __BUILDER_UID__].includes(Number(info.uid)), "BUILD_CAPTURE_PARENT_UNSAFE:" + current);
    result.push({ path: current, identity: identity(info) });
    if (current === path.parse(current).root) break;
    current = path.dirname(current);
  }
  return result;
}

async function checkParents(values) {
  for (const value of values) {
    const info = await lstat(value.path, { bigint: true });
    require(info.isDirectory() && !info.isSymbolicLink() && await realpath(value.path) === value.path && same(value.identity, identity(info), parentKeys), "BUILD_CAPTURE_PARENT_CHANGED:" + value.path);
  }
}

async function stableRead(filename) {
  require(path.isAbsolute(filename) && path.normalize(filename) === filename && await realpath(filename) === filename, "BUILD_CAPTURE_FILE_PATH_UNSAFE:" + filename);
  const parents = await parentChain(filename);
  const before = await lstat(filename, { bigint: true });
  require(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && [0, __BUILDER_UID__].includes(Number(before.uid)), "BUILD_CAPTURE_FILE_NOT_ORDINARY:" + filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    require(same(identity(before), identity(opened)), "BUILD_CAPTURE_FILE_CHANGED_BEFORE_OPEN:" + filename);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(filename, { bigint: true });
    require(same(identity(before), identity(after)) && same(identity(after), identity(named)) && bytes.length === Number(after.size) && await realpath(filename) === filename, "BUILD_CAPTURE_FILE_CHANGED_DURING_READ:" + filename);
    await checkParents(parents);
    return { bytes, proof: { path: filename, before: identity(before), after: identity(after), bytes: bytes.length, sha256: hash(bytes), parents } };
  } finally {
    await handle.close();
  }
}

function git(args) {
  return execFileSync("/usr/bin/git", ["--no-pager", "-C", source, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", HOME: "__BUILDER_HOME__", LANG: "C.UTF-8", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
}

function blob(relative) {
  return git(["cat-file", "blob", revision + ":" + relativePath(relative)]);
}

async function matchingGitFile(relative) {
  const value = await stableRead(path.join(source, relativePath(relative)));
  require(value.proof.before.uid === __BUILDER_UID__ && value.bytes.equals(blob(relative)), "BUILD_CAPTURE_GIT_REVISION_BYTES_DIFFERENT:" + relative);
  return value;
}

async function selectedInputs(relativeModuleClosure) {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean);
  const deleted = new Set(git(["ls-files", "--deleted", "-z"]).toString("utf8").split("\0").filter(Boolean));
  const imports = await relativeModuleClosure(source, entrypoints);
  const inputs = [...new Set([
    ...imports,
    "scripts/ci/artifact-archive.py",
    ...files.filter((filename) => !deleted.has(filename) && /^(?:apps\/|packages\/|assets\/|tsconfig[^/]*\.json$|package(?:-lock)?\.json$|ci\/(?:toolchain-lock|policy|coverage-policy|policy\.schema|result\.schema|coverage\.schema)\.json$)/u.test(filename) && !/(?:^|\/)(?:dist|node_modules|test)(?:\/|$)|\.test\./u.test(filename)),
  ])].sort();
  require(inputs.length > 0, "BUILD_CAPTURE_INPUTS_EMPTY");
  inputs.forEach(relativePath);
  return { files, deleted: [...deleted].sort(), imports, inputs };
}

try {
  require(process.platform === "linux" && process.arch === "__BUILDER_ARCH__" && process.version === "v22.22.3" && process.versions.modules === "127" && os.hostname() === "__BUILDER_HOSTNAME__" && process.getuid() === __BUILDER_UID__ && process.geteuid() === __BUILDER_UID__ && process.argv.length === 2 && fileURLToPath(import.meta.url) === tool, "BUILD_CAPTURE_FIXED_HERMES_ENVIRONMENT_REQUIRED");
  process.umask(0o077);
  for (const directory of [source, evidence]) {
    const info = await lstat(directory, { bigint: true });
    require(info.isDirectory() && !info.isSymbolicLink() && info.uid === __BUILDER_UID__n && await realpath(directory) === directory, "BUILD_CAPTURE_FIXED_DIRECTORY_UNSAFE:" + directory);
    if (directory === evidence) require((info.mode & 0o777n) === 0o700n, "BUILD_CAPTURE_EVIDENCE_MODE_INVALID");
  }
  report.sourceParents = await parentChain(path.join(source, "package.json"));
  report.evidenceParents = await parentChain(output);
  outputHandle = await open(output, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  outputCreated = identity(await outputHandle.stat({ bigint: true }));
  require(outputCreated.uid === __BUILDER_UID__ && outputCreated.mode === 0o600 && outputCreated.nlink === 1 && outputCreated.type === 0o100000, "BUILD_CAPTURE_OUTPUT_UNSAFE");
  report.tool = (await stableRead(tool)).proof;
  report.nodeIdentity = (await stableRead(await realpath(process.execPath))).proof;
  require(git(["rev-parse", "--verify", revision + "^{commit}"]).toString("utf8").trim() === revision, "BUILD_CAPTURE_GIT_REVISION_UNAVAILABLE");
  report.sourceGitHead = git(["rev-parse", "HEAD"]).toString("utf8").trim();
  require(report.sourceGitHead === revision && git(["status", "--porcelain", "--untracked-files=all"]).toString("utf8").trim() === "", "BUILD_CAPTURE_CLEAN_TESTED_HEAD_REQUIRED");
  report.stage = "source-modules";
  const moduleBefore = new Map();
  for (const relative of ["scripts/ci/verify-artifact.mjs", "scripts/ci/source-inputs.mjs", "scripts/ci/artifact-files.mjs", "scripts/ci/contracts.mjs"]) {
    const value = await matchingGitFile(relative);
    moduleBefore.set(relative, value.proof);
    report.modules.push({ path: relative, sha256: value.proof.sha256, bytes: value.proof.bytes, before: value.proof.before, after: null });
  }
  require(moduleBefore.get("scripts/ci/verify-artifact.mjs").sha256 === "4e6f42c70e40b8c76ebbccdecf3e2cc5d6486a3f66f73e72a9edbfb6eac3f418" && moduleBefore.get("scripts/ci/source-inputs.mjs").sha256 === "d56996d46d915c08eab68f8ba67808f31c667a3177312e5cb303836a1b6e9fac", "BUILD_CAPTURE_PRODUCT_MODULE_IDENTITY_DIFFERENT");
  const { sourceTreeDigest } = await import(pathToFileURL(path.join(source, "scripts/ci/verify-artifact.mjs")));
  const { relativeModuleClosure } = await import(pathToFileURL(path.join(source, "scripts/ci/source-inputs.mjs")));
  report.stage = "original-product-digest-before";
  report.sourceTreeDigestBefore = await sourceTreeDigest(source);
  require(report.sourceTreeDigestBefore === expectedDigest, "BUILD_CAPTURE_ORIGINAL_DIGEST_BEFORE_DIFFERENT");
  report.stage = "input-records";
  const selectionBefore = await selectedInputs(relativeModuleClosure);
  report.selectionBefore = selectionBefore;
  for (const relative of selectionBefore.inputs) {
    const value = await matchingGitFile(relative);
    report.records.push({ path: relative, sha256: value.proof.sha256, mode: value.proof.before.mode });
    report.inputReadbacks.push({ path: relative, gitRevision: revision, gitBlobSha256: value.proof.sha256, gitBytesMatched: true, bytes: value.proof.bytes, before: value.proof.before, after: null, parents: value.proof.parents });
  }
  report.aggregateFieldOrder = ["path", "sha256", "mode"];
  report.aggregateJsonSha256 = hash(JSON.stringify(report.records));
  require(report.aggregateJsonSha256 === expectedDigest, "BUILD_CAPTURE_AGGREGATE_DIFFERENT");
  report.stage = "original-product-digest-after";
  report.sourceTreeDigestAfter = await sourceTreeDigest(source);
  require(report.sourceTreeDigestAfter === expectedDigest && report.sourceTreeDigestAfter === report.sourceTreeDigestBefore, "BUILD_CAPTURE_ORIGINAL_DIGEST_AFTER_DIFFERENT");
  const selectionAfter = await selectedInputs(relativeModuleClosure);
  report.selectionAfter = selectionAfter;
  require(JSON.stringify(selectionAfter) === JSON.stringify(selectionBefore), "BUILD_CAPTURE_INPUT_SELECTION_CHANGED");
  for (const value of report.inputReadbacks) {
    const actual = await matchingGitFile(value.path);
    value.after = actual.proof.after;
    value.afterSha256 = actual.proof.sha256;
    require(same(value.before, value.after) && actual.proof.sha256 === value.gitBlobSha256 && actual.proof.bytes === value.bytes, "BUILD_CAPTURE_INPUT_CHANGED_AFTER_DIGEST:" + value.path);
    await checkParents(value.parents);
  }
  for (const module of report.modules) {
    const value = await matchingGitFile(module.path);
    module.after = value.proof.after;
    require(same(module.before, module.after) && value.proof.sha256 === module.sha256, "BUILD_CAPTURE_SOURCE_MODULE_CHANGED:" + module.path);
  }
  await checkParents(report.sourceParents);
  require(report.sourceGitHead === git(["rev-parse", "HEAD"]).toString("utf8").trim(), "BUILD_CAPTURE_SOURCE_HEAD_CHANGED");
  report.sourceBuildInputProof = { schemaVersion: 1, sourceHead: revision, sourceTreeSha256: expectedDigest, records: report.records };
  report.stage = "complete";
  report.passed = true;
} catch (error) {
  report.error = failure(error);
  report.passed = false;
} finally {
  report.finishedAt = new Date().toISOString();
  if (outputHandle) {
    try {
      await checkParents(report.evidenceParents);
      const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
      let written = 0;
      while (written < bytes.length) {
        const value = await outputHandle.write(bytes, written, bytes.length - written, written);
        require(value.bytesWritten > 0, "BUILD_CAPTURE_OUTPUT_WRITE_FAILED");
        written += value.bytesWritten;
      }
      await outputHandle.sync();
      const actual = identity(await outputHandle.stat({ bigint: true }));
      const named = identity(await lstat(output, { bigint: true }));
      require(same(actual, named) && same(outputCreated, actual, ["device", "inode", "uid", "gid", "mode", "type", "nlink"]) && actual.bytes === bytes.length && await realpath(output) === output, "BUILD_CAPTURE_OUTPUT_CHANGED");
      const readback = await outputHandle.readFile({ encoding: null });
      require(readback.equals(bytes), "BUILD_CAPTURE_OUTPUT_READBACK_DIFFERENT");
      report.outputReadback = { path: output, bytes: bytes.length, sha256: hash(readback), identity: actual };
      await checkParents(report.evidenceParents);
    } catch (error) {
      report.passed = false;
      report.outputError = failure(error);
    } finally {
      await outputHandle.close();
    }
  }
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = report.passed && report.outputReadback && !report.outputError ? 0 : 1;
}
