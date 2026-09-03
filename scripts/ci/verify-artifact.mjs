import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import { collectArtifactFiles, contentDigest, digestFile, jsonFile } from "./artifact-files.mjs";
import {
  fileSha256,
  parseArguments,
  readJson,
  repositoryRoot,
  safeRelativePath,
  sha256,
  validateRecord,
} from "./contracts.mjs";
import { relativeModuleClosure } from "./source-inputs.mjs";

const text = { type: "string", minLength: 1 };
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const closed = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const mapOf = (value) => ({ type: "object", additionalProperties: value });
const fileSchema = closed({
  path: text,
  sha256: digest,
  bytes: { type: "integer", minimum: 0 },
  mode: { enum: [0o644, 0o755] },
});
const recordSchema = closed({
  schemaVersion: { const: 1 },
  context: readJson(path.join(repositoryRoot, "ci/result.schema.json")).definitions.Context,
  platform: closed({
    os: { enum: ["linux", "darwin"] },
    arch: { enum: ["x64", "arm64"] },
    abi: { const: "127" },
  }),
  node: text,
  lockSha256: digest,
  sourceTreeSha256: digest,
  contentSha256: digest,
  generatedAt: text,
  files: { type: "array", minItems: 1, items: fileSchema },
  entrypoints: closed({ himawari: text, agentService: text, executionWorker: text }),
  externalDependencyClosure: mapOf(closed({ name: text, version: text })),
  migrations: { type: "array", minItems: 1, uniqueItems: true, items: text },
});
const ajv = new Ajv({ strict: true, allErrors: true });
const validRecord = ajv.compile(recordSchema);

export function assertArtifactRecord(value) {
  if (!validRecord(value)) throw new Error(`ARTIFACT_SCHEMA:${ajv.errorsText(validRecord.errors)}`);
  if (new Set(value.files.map((file) => file.path)).size !== value.files.length)
    throw new Error("ARTIFACT_DUPLICATE_FILE");
  for (const file of value.files)
    if (!safeRelativePath(file.path) || file.path === "artifact-record.json")
      throw new Error("ARTIFACT_UNSAFE_FILE");
  for (const migration of value.migrations)
    if (!value.files.some((file) => file.path === migration))
      throw new Error("ARTIFACT_MIGRATION_NOT_LISTED");
  return value;
}

export function runArchiveTool(
  operation,
  source,
  destination,
  { python = process.env.HIMAWARI_CI_PYTHON } = {},
) {
  if (!python || !path.isAbsolute(python)) throw new Error("ARTIFACT_LOCKED_PYTHON_REQUIRED");
  const version = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== "Python 3.12.10")
    throw new Error("ARTIFACT_PYTHON_VERSION_MISMATCH");
  const command = spawnSync(
    python,
    [
      "-B",
      path.join(repositoryRoot, "scripts/ci/artifact-archive.py"),
      operation,
      source,
      destination,
    ],
    { encoding: "utf8", timeout: 300_000 },
  );
  if (command.error || command.status !== 0)
    throw new Error(`ARTIFACT_ARCHIVE_FAILED:${command.error?.message ?? command.stderr}`);
}

export async function sourceTreeDigest(root) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const imports = await relativeModuleClosure(root, [
    "scripts/ci/build.mjs",
    "scripts/package-node-runtime.mjs",
    "scripts/generate-artifact-manifest.mjs",
    "scripts/check-control-center-build.mjs",
  ]);
  const inputs = [
    ...new Set([
      ...imports,
      "scripts/ci/artifact-archive.py",
      ...files.filter(
        (filename) =>
          /^(?:apps\/|packages\/|tsconfig[^/]*\.json$|package(?:-lock)?\.json$|ci\/(?:toolchain-lock|policy|coverage-policy|policy\.schema|result\.schema|coverage\.schema)\.json$)/u.test(
            filename,
          ) && !/(?:^|\/)(?:dist|node_modules|test)(?:\/|$)|\.test\./u.test(filename),
      ),
    ]),
  ].sort();
  if (!inputs.length) throw new Error("ARTIFACT_BUILD_INPUTS_EMPTY");
  const records = [];
  for (const filename of inputs) {
    const absolute = path.join(root, filename);
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) throw new Error(`ARTIFACT_BUILD_INPUT_NOT_REGULAR:${filename}`);
    records.push({
      path: filename,
      sha256: await digestFile(absolute),
      mode: metadata.mode & 0o777,
    });
  }
  return sha256(JSON.stringify(records));
}

export async function verifyExtractedArtifact(
  directory,
  {
    root = repositoryRoot,
    context,
    expectedPlatform = { os: process.platform, arch: process.arch, abi: process.versions.modules },
  } = {},
) {
  validateRecord("Context", context);
  const record = assertArtifactRecord(await jsonFile(path.join(directory, "artifact-record.json")));
  for (const field of Object.keys(context))
    if (record.context[field] !== context[field])
      throw new Error(`ARTIFACT_CONTEXT_MISMATCH:${field}`);
  for (const field of ["os", "arch", "abi"])
    if (record.platform[field] !== expectedPlatform[field])
      throw new Error(`ARTIFACT_PLATFORM_MISMATCH:${field}`);
  if (record.node !== process.versions.node) throw new Error("ARTIFACT_NODE_VERSION_MISMATCH");
  if (record.lockSha256 !== fileSha256(path.join(root, "package-lock.json")))
    throw new Error("ARTIFACT_LOCK_MISMATCH");
  if (record.sourceTreeSha256 !== (await sourceTreeDigest(root)))
    throw new Error("ARTIFACT_BUILD_INPUT_MISMATCH");
  const files = (await collectArtifactFiles(directory)).filter(
    (file) => file.path !== "artifact-record.json",
  );
  if (
    JSON.stringify(files) !== JSON.stringify(record.files) ||
    contentDigest(files) !== record.contentSha256
  )
    throw new Error("ARTIFACT_CONTENT_MISMATCH");
  const runtime = await jsonFile(path.join(directory, "runtime/runtime-manifest.json"));
  if (
    JSON.stringify(runtime.entrypoints) !== JSON.stringify(record.entrypoints) ||
    JSON.stringify(runtime.externalDependencyClosure) !==
      JSON.stringify(record.externalDependencyClosure)
  )
    throw new Error("ARTIFACT_RUNTIME_IDENTITY_MISMATCH");
  for (const entry of Object.values(record.entrypoints))
    if (!safeRelativePath(entry) || !files.some((file) => file.path === `runtime/${entry}`))
      throw new Error("ARTIFACT_ENTRYPOINT_MISSING");
  if (
    !files.some((file) => file.path === "browser/index.html") ||
    !files.some((file) => /runtime\/node_modules\/better-sqlite3\/.*\.node$/u.test(file.path))
  )
    throw new Error("ARTIFACT_REQUIRED_PAYLOAD_MISSING");
  if (files.some((file) => file.path.startsWith("runtime/node_modules/@himawari-agent/testing/")))
    throw new Error("ARTIFACT_TEST_ADAPTER_INCLUDED");
  const migrations = files
    .filter((file) =>
      /^runtime\/node_modules\/@himawari-agent\/persistence-sqlite\/dist\/migrations\/[^/]+\.sql$/u.test(
        file.path,
      ),
    )
    .map((file) => file.path);
  if (JSON.stringify(migrations) !== JSON.stringify(record.migrations))
    throw new Error("ARTIFACT_MIGRATION_MISMATCH");
  for (const [location, identity] of Object.entries(record.externalDependencyClosure)) {
    if (!safeRelativePath(location)) throw new Error("ARTIFACT_DEPENDENCY_PATH");
    const manifest = await jsonFile(
      path.join(directory, "runtime/node_modules", location, "package.json"),
    );
    if (manifest.name !== identity.name || manifest.version !== identity.version)
      throw new Error("ARTIFACT_DEPENDENCY_IDENTITY_MISMATCH");
  }
  return record;
}

export async function verifyArtifact({
  archive,
  context,
  root = repositoryRoot,
  extractTo,
  expectedSha256,
  python,
} = {}) {
  if (!archive || !path.isAbsolute(archive)) throw new Error("ARTIFACT_ABSOLUTE_ARCHIVE_REQUIRED");
  const before = await digestFile(archive);
  if (expectedSha256 && before !== expectedSha256)
    throw new Error("ARTIFACT_ARCHIVE_DIGEST_MISMATCH");
  const temporary = extractTo
    ? null
    : await mkdtemp(path.join(os.tmpdir(), "himawari-artifact-verify-"));
  const target = extractTo ?? path.join(temporary, "payload");
  try {
    runArchiveTool("extract", archive, target, { python });
    const manifest = await verifyExtractedArtifact(target, { root, context });
    if ((await digestFile(archive)) !== before)
      throw new Error("ARTIFACT_CHANGED_DURING_VERIFICATION");
    const { size } = await import("node:fs/promises").then(({ stat }) => stat(archive));
    return { manifest, sha256: before, bytes: size, ...(extractTo ? { root: target } : {}) };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyArtifactMain(
  argv = process.argv.slice(2),
  { root = repositoryRoot, stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const args = parseArguments(argv, [
      "--archive",
      "--context",
      "--extract-to",
      "--expected-sha256",
    ]);
    const result = await verifyArtifact({
      root,
      archive: args["--archive"],
      context: JSON.parse(await readFile(args["--context"], "utf8")),
      extractTo: args["--extract-to"],
      expectedSha256: args["--expected-sha256"],
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await verifyArtifactMain();
}
