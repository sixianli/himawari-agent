import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectArtifactFiles,
  contentDigest,
  digestFile,
} from "../../scripts/ci/artifact-files.mjs";
import { fileSha256, repositoryRoot, safeRelativePath } from "../../scripts/ci/contracts.mjs";
import {
  assertArtifactRecord,
  runArchiveTool,
  sourceTreeDigest,
  verifyArtifact,
  verifyArtifactMain,
  verifyExtractedArtifact,
} from "../../scripts/ci/verify-artifact.mjs";
import { packageNodeRuntime } from "../../scripts/package-node-runtime.mjs";

const directories = [];
const python = process.env.HIMAWARI_CI_PYTHON;
const helper = path.join(repositoryRoot, "scripts/ci/artifact-archive.py");
const context = {
  repository: "sixianli/himawari-agent",
  event: "workflow_dispatch",
  runId: "12345",
  attempt: 1,
  testedSha: "a".repeat(40),
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  policySha256: "c".repeat(64),
  toolchainSha256: "d".repeat(64),
  initialization: true,
};
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "himawari-artifact-test-"));
  directories.push(temporary);
  const payload = path.join(temporary, "payload");
  const entrypoints = {
    himawari: "node_modules/@himawari-agent/admin-cli/dist/main.js",
    agentService: "node_modules/@himawari-agent/agent-service/dist/main.js",
    executionWorker: "node_modules/@himawari-agent/execution-worker/dist/main.js",
  };
  const runtime = {
    schemaVersion: 1,
    entrypoints,
    externalDependencyClosure: { "better-sqlite3": { name: "better-sqlite3", version: "12.8.0" } },
  };
  const files = {
    "browser/index.html": "<html>fixture</html>",
    "runtime/runtime-manifest.json": JSON.stringify(runtime),
    "runtime/node_modules/better-sqlite3/package.json": JSON.stringify({
      name: "better-sqlite3",
      version: "12.8.0",
    }),
    "runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node":
      "structural fixture, never executed",
    "runtime/node_modules/@himawari-agent/persistence-sqlite/dist/migrations/0001.sql":
      "CREATE TABLE fixture(value);",
    ...Object.fromEntries(
      Object.values(entrypoints).map((entry) => [`runtime/${entry}`, "console.log('fixture');"]),
    ),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(payload, name)), { recursive: true });
    await writeFile(path.join(payload, name), content, { mode: 0o644 });
  }
  const records = await collectArtifactFiles(payload, { normalizeModes: true });
  const record = {
    schemaVersion: 1,
    context,
    platform: { os: process.platform, arch: process.arch, abi: process.versions.modules },
    node: process.versions.node,
    lockSha256: fileSha256(path.join(repositoryRoot, "package-lock.json")),
    sourceTreeSha256: await sourceTreeDigest(repositoryRoot),
    contentSha256: contentDigest(records),
    generatedAt: "2026-09-03T00:00:00.000Z",
    files: records,
    entrypoints,
    externalDependencyClosure: runtime.externalDependencyClosure,
    migrations: records.filter((file) => file.path.endsWith(".sql")).map((file) => file.path),
  };
  await writeFile(path.join(payload, "artifact-record.json"), JSON.stringify(record), {
    mode: 0o644,
  });
  return { temporary, payload, record };
}

async function archiveExtractionFixture() {
  const { temporary, payload } = await fixture();
  const binary = Buffer.concat(
    Array.from({ length: 4096 }, (_, index) =>
      createHash("sha256").update(`artifact-extraction-${index}`).digest(),
    ),
  );
  const additions = [
    ["shared/deep/path/empty.txt", Buffer.alloc(0), 0o644],
    ["shared/deep/path/binary.bin", binary, 0o600],
    ["shared/deep/path/executable", Buffer.from("exit 0\n"), 0o755],
    ["shared/deep/path/read-only.txt", Buffer.from("read only\n"), 0o444],
    [`shared/deep/${"long-name-".repeat(20)}.txt`, Buffer.from("PAX long path\n"), 0o644],
  ];
  for (const [name, bytes, mode] of additions) {
    const filename = path.join(payload, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    await chmod(filename, mode);
  }
  const records = await collectArtifactFiles(payload);
  const contents = new Map(
    await Promise.all(
      records.map(async (record) => [record.path, await readFile(path.join(payload, record.path))]),
    ),
  );
  const archive = path.join(temporary, "extraction.tar.gz");
  runArchiveTool("create", payload, archive, { python });
  const parent = path.join(temporary, "existing-private-parent");
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);
  return {
    temporary,
    archive,
    parent,
    extraction: path.join(parent, "new-parent/nested/extraction"),
    records,
    contents,
  };
}

async function observeArchiveExtraction(value, umask) {
  const report = path.join(value.temporary, "mkdir-observation.json");
  const script = [
    "import json,os,runpy,sys",
    "from pathlib import Path",
    "helper,archive,destination,umask,report=sys.argv[1:]",
    "os.umask(int(umask,8))",
    "root=Path(destination)",
    "created=set()",
    "repeated=0",
    "original=Path.mkdir",
    "def observed(self,*args,**kwargs):",
    " global repeated",
    " try:",
    "  result=original(self,*args,**kwargs)",
    " except FileExistsError:",
    "  if self in created and (self==root or root in self.parents): repeated+=1",
    "  raise",
    " else:",
    "  if self==root or root in self.parents: created.add(self)",
    "  return result",
    "Path.mkdir=observed",
    "sys.argv=[helper,'extract',archive,destination]",
    "try:",
    " runpy.run_path(helper,run_name='__main__')",
    "finally:",
    " Path.mkdir=original",
    " with open(report,'x') as output:",
    "  json.dump({'repeatedCreatedDirectoryEexist':repeated},output)",
  ].join("\n");
  const result = spawnSync(python, [
    "-B",
    "-c",
    script,
    helper,
    value.archive,
    value.extraction,
    umask,
    report,
  ]);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout).toHaveLength(0);
  return JSON.parse(await readFile(report, "utf8"));
}

async function assertExtractedBytesAndModes(value) {
  expect(await collectArtifactFiles(value.extraction)).toEqual(value.records);
  for (const record of value.records)
    expect(await readFile(path.join(value.extraction, record.path))).toEqual(
      value.contents.get(record.path),
    );
  const expectedDirectories = new Set([""]);
  for (const record of value.records) {
    let parent = path.posix.dirname(record.path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const actualDirectories = [];
  const visit = async (directory) => {
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    actualDirectories.push(path.relative(value.extraction, directory).split(path.sep).join("/"));
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
  };
  await visit(value.extraction);
  expect(actualDirectories.sort()).toEqual([...expectedDirectories].sort());
  for (const name of ["new-parent", "new-parent/nested"])
    expect((await lstat(path.join(value.parent, name))).mode & 0o777).toBe(0o755);
  expect((await lstat(value.parent)).mode & 0o777).toBe(0o700);
}

async function gzipExtractionFixture(fault = "valid", rawBytes = 10_240) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "himawari-gzip-test-"));
  directories.push(temporary);
  const archive = path.join(temporary, "input.tar.gz");
  const extraction = path.join(temporary, "new-parent/nested/extraction");
  const script = [
    "import gzip,io,sys,tarfile",
    "from pathlib import Path",
    "archive,fault,raw_bytes=sys.argv[1:]",
    "raw=io.BytesIO()",
    "with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as tar:",
    " member=tarfile.TarInfo('../escape' if fault=='unsafe-crc' else 'good')",
    " member.mode=0o644",
    " member.size=1",
    " tar.addfile(member,io.BytesIO(b'x'))",
    "data=raw.getvalue()",
    "size=int(raw_bytes)",
    "data=data[:size] if size<len(data) else data+bytes(size-len(data))",
    "if fault=='truncated-tar': data=data[:512]",
    "encoded=bytearray(gzip.compress(data,mtime=0))",
    "if fault in ('crc','unsafe-crc'): encoded[-8]^=1",
    "elif fault=='header': encoded[0]=0",
    "elif fault=='length': encoded[-4]^=1",
    "elif fault=='truncated-trailer': encoded=encoded[:-4]",
    "elif fault=='truncated-body': encoded=encoded[:len(encoded)//2]",
    "elif fault=='bad-second-member': encoded+=gzip.compress(b'padding',mtime=0)[:-4]",
    "Path(archive).write_bytes(encoded)",
  ].join("\n");
  const created = spawnSync(python, ["-B", "-c", script, archive, fault, String(rawBytes)]);
  expect(created.error).toBeUndefined();
  expect(created.status, created.stderr.toString()).toBe(0);
  return { temporary, archive, extraction };
}

async function observeGzipExtraction(value, maximumBytes) {
  const script = [
    "import json,os,runpy,sys,tempfile",
    "from pathlib import Path",
    "helper,archive,destination,maximum=sys.argv[1:]",
    "module=runpy.run_path(helper)",
    "extract=module['extract']",
    "configured=extract.__globals__.get('MAX_EXTRACT_BYTES')",
    "if configured is not None and configured!=2*1024**3+256*1024**2: raise AssertionError('unexpected production cap')",
    "if maximum!='default': extract.__globals__['MAX_EXTRACT_BYTES']=int(maximum)",
    "original=tempfile.TemporaryFile",
    "observations=[]",
    "def observed(*args,**kwargs):",
    " result=original(*args,**kwargs)",
    " info=os.fstat(result.fileno())",
    " observations.append({'dir':str(kwargs.get('dir')),'mode':info.st_mode&0o777,'links':info.st_nlink})",
    " return result",
    "tempfile.TemporaryFile=observed",
    "try:",
    " sys.argv=[helper,'extract',archive,destination]",
    " module['main']()",
    "finally:",
    " tempfile.TemporaryFile=original",
    " print(json.dumps({'configuredMaximum':configured,'temporaryFiles':observations}))",
  ].join("\n");
  const entries = (await readdir(value.temporary)).sort();
  const parentMode = (await lstat(value.temporary)).mode;
  const result = spawnSync(python, [
    "-B",
    "-c",
    script,
    helper,
    value.archive,
    value.extraction,
    maximumBytes === undefined ? "default" : String(maximumBytes),
  ]);
  expect(result.error).toBeUndefined();
  const observation = JSON.parse(result.stdout.toString());
  return { result, observation, entries, parentMode };
}

async function assertGzipExtractionRejected(value, observed, message) {
  expect(observed.result.status).not.toBe(0);
  expect(observed.result.stderr.toString()).toContain(message);
  expect(existsSync(value.extraction)).toBe(false);
  expect(existsSync(path.join(value.temporary, "new-parent"))).toBe(false);
  expect((await readdir(value.temporary)).sort()).toEqual(observed.entries);
  expect((await lstat(value.temporary)).mode).toBe(observed.parentMode);
  for (const file of observed.observation.temporaryFiles) {
    expect(file.dir).toBe(value.temporary);
    expect(file.mode).toBe(0o600);
    expect(file.links).toBe(0);
  }
}

async function serialArtifactDigest(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

async function collectArtifactFilesSerialReference(root, { normalizeModes = false } = {}) {
  const output = [];
  const visit = async (directory, prefix = "") => {
    if (normalizeModes) await chmod(directory, 0o755);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelativePath(name)) throw new Error(`ARTIFACT_UNSAFE_PATH:${name}`);
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`ARTIFACT_LINK_FORBIDDEN:${name}`);
      if (entry.isDirectory()) await visit(filename, name);
      else if (entry.isFile() && entry.name === ".DS_Store") continue;
      else if (entry.isFile()) {
        const info = await lstat(filename);
        const mode = normalizeModes ? (info.mode & 0o111 ? 0o755 : 0o644) : info.mode & 0o777;
        if (normalizeModes) await chmod(filename, mode);
        output.push({
          path: name,
          sha256: await serialArtifactDigest(filename),
          bytes: info.size,
          mode,
        });
      } else throw new Error(`ARTIFACT_SPECIAL_FILE:${name}`);
    }
  };
  await visit(root);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function artifactDirectoryModes(root) {
  const output = [];
  const visit = async (directory) => {
    output.push({
      path: path.relative(root, directory),
      mode: (await lstat(directory)).mode & 0o777,
    });
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
  };
  await visit(root);
  return output;
}

async function setComparisonDirectoryModes(root) {
  await chmod(root, 0o770);
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) await setComparisonDirectoryModes(path.join(root, entry.name));
}

describe("same-artifact verification", () => {
  it.each([
    ["0002", false],
    ["0077", false],
    ["0002", true],
    ["0077", true],
  ])(
    "[R2-D15] matches the original serial inventory for one archive under umask %s with normalizeModes %s",
    async (umask, normalizeModes) => {
      const value = await archiveExtractionFixture();
      await observeArchiveExtraction(value, umask);
      const reference = {
        ...value,
        temporary: path.join(value.temporary, "serial-reference-observation"),
        extraction: path.join(value.parent, "serial-reference/extraction"),
      };
      await mkdir(reference.temporary, { mode: 0o700 });
      await observeArchiveExtraction(reference, umask);
      for (const root of [value.extraction, reference.extraction]) {
        const finder = path.join(root, "shared/deep/path/.DS_Store");
        await writeFile(finder, "ignored Finder state\n");
        await chmod(finder, 0o600);
        if (normalizeModes) await setComparisonDirectoryModes(root);
      }
      const expected = await collectArtifactFilesSerialReference(reference.extraction, {
        normalizeModes,
      });
      const actual = await collectArtifactFiles(value.extraction, { normalizeModes });
      expect(actual).toEqual(expected);
      expect(contentDigest(actual)).toBe(contentDigest(expected));
      expect(actual.map((file) => file.path)).toEqual(
        actual.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
      );
      for (const file of expected) {
        for (const root of [value.extraction, reference.extraction]) {
          const filename = path.join(root, file.path);
          const bytes = await readFile(filename);
          const info = await lstat(filename);
          expect(bytes).toEqual(value.contents.get(file.path));
          expect(bytes.length).toBe(file.bytes);
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
          expect(info.mode & 0o777).toBe(file.mode);
        }
      }
      const expectedDirectories = await artifactDirectoryModes(reference.extraction);
      expect(await artifactDirectoryModes(value.extraction)).toEqual(expectedDirectories);
      expect(expectedDirectories.every((entry) => entry.mode === 0o755)).toBe(true);
      for (const root of [value.extraction, reference.extraction]) {
        const finder = path.join(root, "shared/deep/path/.DS_Store");
        expect((await lstat(finder)).mode & 0o777).toBe(0o600);
        expect(await readFile(finder, "utf8")).toBe("ignored Finder state\n");
        expect(expected.some((file) => file.path.endsWith(".DS_Store"))).toBe(false);
      }
      expect((await lstat(value.parent)).mode & 0o777).toBe(0o700);
    },
  );
  it.each([
    ["header", "BadGzipFile"],
    ["crc", "BadGzipFile"],
    ["length", "BadGzipFile"],
    ["truncated-trailer", "EOFError"],
    ["truncated-body", "EOFError"],
    ["bad-second-member", "EOFError"],
    ["unsafe-crc", "BadGzipFile"],
    ["truncated-tar", "ReadError"],
  ])(
    "[R2-D15] rejects compressed archive %s before creating extraction ancestors",
    async (fault, message) => {
      const value = await gzipExtractionFixture(fault);
      const observed = await observeGzipExtraction(value);
      await assertGzipExtractionRejected(value, observed, message);
    },
  );
  it.each([10_239, 10_240])(
    "[R2-D15] permits a gzip stream of %i bytes within a reduced test cap",
    async (bytes) => {
      const value = await gzipExtractionFixture("valid", bytes);
      const observed = await observeGzipExtraction(value, 10_240);
      expect(observed.result.status, observed.result.stderr.toString()).toBe(0);
      expect(await readFile(path.join(value.extraction, "good"))).toEqual(Buffer.from("x"));
      expect((await lstat(path.join(value.extraction, "good"))).mode & 0o777).toBe(0o644);
      for (const file of observed.observation.temporaryFiles) {
        expect(file.dir).toBe(value.temporary);
        expect(file.mode).toBe(0o600);
        expect(file.links).toBe(0);
      }
    },
  );
  it("[R2-D15] rejects one raw byte over a reduced gzip cap without leaving files", async () => {
    const value = await gzipExtractionFixture("valid", 10_241);
    const observed = await observeGzipExtraction(value, 10_240);
    await assertGzipExtractionRejected(value, observed, "ARTIFACT_SIZE_LIMIT");
  });
  it.each(["0002", "0077"])(
    "[R2-D15] preserves exact bytes, paths and modes under umask %s",
    async (umask) => {
      const value = await archiveExtractionFixture();
      await observeArchiveExtraction(value, umask);
      await assertExtractedBytesAndModes(value);
    },
  );
  it.each(["0002", "0077"])(
    "[R2-D15] avoids repeated mkdir for directories created inside extraction under umask %s",
    async (umask) => {
      const value = await archiveExtractionFixture();
      const observation = await observeArchiveExtraction(value, umask);
      expect(observation.repeatedCreatedDirectoryEexist).toBe(0);
    },
  );
  it("requires an absolute archive and the fixed Python interpreter", async () => {
    await expect(verifyArtifact({ archive: "relative.tar.gz", context })).rejects.toThrow(
      "ARTIFACT_ABSOLUTE_ARCHIVE_REQUIRED",
    );
    expect(() => runArchiveTool("extract", "/input", "/output", { python: "" })).toThrow(
      "ARTIFACT_LOCKED_PYTHON_REQUIRED",
    );
    expect(() =>
      runArchiveTool("extract", "/input", "/output", { python: "/usr/bin/false" }),
    ).toThrow("ARTIFACT_PYTHON_VERSION_MISMATCH");
  });
  it("ignores Finder .DS_Store files written after packaging at any depth", async () => {
    const { payload } = await fixture();
    for (const directory of ["", "runtime", "runtime/node_modules/better-sqlite3/build"])
      await writeFile(path.join(payload, directory, ".DS_Store"), "Finder view state");
    await expect(verifyExtractedArtifact(payload, { context })).resolves.toBeDefined();
    expect(
      (await collectArtifactFiles(payload)).filter((file) => file.path.endsWith(".DS_Store")),
    ).toEqual([]);
  });
  it.each([
    ["similar name", "runtime/DS_Store"],
    ["suffixed name", "runtime/.DS_Store.js"],
    ["directory", "runtime/.DS_Store/index.js"],
  ])("still rejects an unrecorded file with a %s", async (_kind, name) => {
    const { payload } = await fixture();
    await mkdir(path.dirname(path.join(payload, name)), { recursive: true });
    await writeFile(path.join(payload, name), "unrecorded", { mode: 0o644 });
    await expect(verifyExtractedArtifact(payload, { context })).rejects.toThrow(
      "ARTIFACT_CONTENT_MISMATCH",
    );
  });
  it("still rejects a .DS_Store symbolic link", async () => {
    const { payload } = await fixture();
    await symlink("/etc/hosts", path.join(payload, "runtime/.DS_Store"));
    await expect(verifyExtractedArtifact(payload, { context })).rejects.toThrow(
      "ARTIFACT_LINK_FORBIDDEN:runtime/.DS_Store",
    );
  });
  it.each([
    ["node-version", "ARTIFACT_NODE_VERSION_MISMATCH"],
    ["source-tree", "ARTIFACT_BUILD_INPUT_MISMATCH"],
    ["entrypoint", "ARTIFACT_ENTRYPOINT_MISSING"],
    ["native-binary", "ARTIFACT_REQUIRED_PAYLOAD_MISSING"],
    ["test-adapter", "ARTIFACT_TEST_ADAPTER_INCLUDED"],
    ["dependency-identity", "ARTIFACT_DEPENDENCY_IDENTITY_MISMATCH"],
    ["runtime-identity", "ARTIFACT_RUNTIME_IDENTITY_MISMATCH"],
  ])("rejects internally rehashed but invalid %s payload", async (fault, code) => {
    const { payload, record } = await fixture();
    if (fault === "node-version") record.node = "1.0.0";
    if (fault === "source-tree") record.sourceTreeSha256 = "0".repeat(64);
    if (fault === "entrypoint")
      await rm(path.join(payload, "runtime", record.entrypoints.himawari));
    if (fault === "native-binary")
      await rm(
        path.join(payload, "runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
      );
    if (fault === "test-adapter") {
      const directory = path.join(payload, "runtime/node_modules/@himawari-agent/testing");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "index.js"), "export {};", { mode: 0o644 });
    }
    if (fault === "dependency-identity")
      await writeFile(
        path.join(payload, "runtime/node_modules/better-sqlite3/package.json"),
        JSON.stringify({ name: "better-sqlite3", version: "0.0.0" }),
      );
    if (fault === "runtime-identity")
      await writeFile(
        path.join(payload, "runtime/runtime-manifest.json"),
        JSON.stringify({ entrypoints: {}, externalDependencyClosure: {} }),
      );
    // Match the packager after inserting new files; umask must not replace the
    // intended payload rejection with an unrelated noncanonical-mode error.
    record.files = (await collectArtifactFiles(payload, { normalizeModes: true })).filter(
      (file) => file.path !== "artifact-record.json",
    );
    record.contentSha256 = contentDigest(record.files);
    await writeFile(path.join(payload, "artifact-record.json"), JSON.stringify(record));
    await expect(verifyExtractedArtifact(payload, { context })).rejects.toThrow(code);
  });
  it("packages nested import-only dependencies and rejects missing mandatory dependencies", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "himawari-closure-test-"));
    directories.push(temporary);
    const roots = [
      "apps/admin-cli",
      "apps/agent-service",
      "apps/execution-worker",
      "packages/application",
      "packages/domain",
      "packages/execution-contracts",
      "packages/gateway-contracts",
      "packages/integration-github",
      "packages/memory-mem0",
      "packages/persistence-sqlite",
      "packages/platform-node",
      "packages/runtime-pi",
      "packages/runtime-sandbox",
    ];
    await writeFile(
      path.join(temporary, "package.json"),
      JSON.stringify({ name: "fixture", type: "module" }),
    );
    for (const relative of roots) {
      const original = JSON.parse(
        await readFile(path.join(repositoryRoot, relative, "package.json"), "utf8"),
      );
      await mkdir(path.join(temporary, relative, "src/migrations"), { recursive: true });
      await writeFile(
        path.join(temporary, relative, "package.json"),
        JSON.stringify({
          ...original,
          dependencies: relative === "apps/admin-cli" ? { "outer-fixture": "1.0.0" } : {},
        }),
      );
      const compiled = path.join(temporary, "compiled", relative, "src");
      await mkdir(compiled, { recursive: true });
      await writeFile(path.join(compiled, "main.js"), "export {}; ");
    }
    const nativeSource = "packages/platform-node/src/files/rename-native.c";
    await mkdir(path.join(temporary, path.dirname(nativeSource)), { recursive: true });
    await cp(path.join(repositoryRoot, nativeSource), path.join(temporary, nativeSource));
    await mkdir(path.join(temporary, "compiled", path.dirname(nativeSource)), { recursive: true });
    const outer = path.join(temporary, "node_modules/outer-fixture");
    const inner = path.join(outer, "node_modules/inner-fixture");
    await mkdir(inner, { recursive: true });
    await writeFile(
      path.join(outer, "package.json"),
      JSON.stringify({
        name: "outer-fixture",
        version: "1.0.0",
        type: "module",
        exports: { ".": { import: "./index.js" } },
        dependencies: { "inner-fixture": "1.0.0" },
      }),
    );
    await writeFile(
      path.join(inner, "package.json"),
      JSON.stringify({
        name: "inner-fixture",
        version: "1.0.0",
        type: "module",
        exports: { ".": { import: "./index.js" } },
      }),
    );
    await writeFile(path.join(outer, "index.js"), "import 'inner-fixture';");
    await writeFile(path.join(inner, "index.js"), "export const value = 1;");
    await chmod(outer, 0o775);
    await chmod(path.join(outer, "index.js"), 0o775);
    const output = path.join(temporary, "runtime");
    await packageNodeRuntime({
      root: temporary,
      buildRoot: path.join(temporary, "compiled"),
      runtimeRoot: output,
    });
    expect((await lstat(path.join(output, "node_modules/outer-fixture"))).mode & 0o022).toBe(0);
    expect(
      (await lstat(path.join(output, "node_modules/outer-fixture/index.js"))).mode & 0o777,
    ).toBe(0o755);
    const manifest = JSON.parse(await readFile(path.join(output, "runtime-manifest.json"), "utf8"));
    expect(
      manifest.externalDependencyClosure["outer-fixture/node_modules/inner-fixture"].version,
    ).toBe("1.0.0");
    await rm(inner, { recursive: true });
    await expect(
      packageNodeRuntime({
        root: temporary,
        buildRoot: path.join(temporary, "compiled"),
        runtimeRoot: path.join(temporary, "broken-runtime"),
      }),
    ).rejects.toThrow(/inner-fixture/);
  });

  it("checks exact regular-file bytes, modes, dependency identity and platform", async () => {
    const { payload } = await fixture();
    expect((await verifyExtractedArtifact(payload, { context })).context).toEqual(context);
  });
  it.each([
    [
      "single byte",
      async ({ payload }) => writeFile(path.join(payload, "browser/index.html"), "changed"),
    ],
    [
      "missing migration",
      async ({ payload }) =>
        rm(
          path.join(
            payload,
            "runtime/node_modules/@himawari-agent/persistence-sqlite/dist/migrations/0001.sql",
          ),
        ),
    ],
    [
      "missing dependency",
      async ({ payload }) =>
        rm(path.join(payload, "runtime/node_modules/better-sqlite3/package.json")),
    ],
    [
      "extra file",
      async ({ payload }) => writeFile(path.join(payload, "unlisted.js"), "unexpected"),
    ],
    [
      "wrong source SHA",
      async ({ payload, record }) => {
        record.context = { ...record.context, testedSha: "e".repeat(40) };
        await writeFile(path.join(payload, "artifact-record.json"), JSON.stringify(record));
      },
    ],
    [
      "wrong ABI",
      async ({ payload, record }) => {
        record.platform.abi = "999";
        await writeFile(path.join(payload, "artifact-record.json"), JSON.stringify(record));
      },
    ],
    [
      "wrong OS",
      async ({ payload, record }) => {
        record.platform.os = process.platform === "darwin" ? "linux" : "darwin";
        await writeFile(path.join(payload, "artifact-record.json"), JSON.stringify(record));
      },
    ],
    [
      "wrong lock",
      async ({ payload, record }) => {
        record.lockSha256 = "f".repeat(64);
        await writeFile(path.join(payload, "artifact-record.json"), JSON.stringify(record));
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    const value = await fixture();
    await mutate(value);
    await expect(verifyExtractedArtifact(value.payload, { context })).rejects.toThrow();
  });
  it("keeps generation time outside the payload content digest", async () => {
    const { record } = await fixture();
    const copy = structuredClone(record);
    copy.generatedAt = "2026-09-04T00:00:00.000Z";
    expect(copy.contentSha256).toBe(record.contentSha256);
    expect(() => assertArtifactRecord({ ...copy, unknown: true })).toThrow();
  });
  it("leaves Finder .DS_Store files out of the archive", async () => {
    const { temporary, payload, record } = await fixture();
    const clean = path.join(temporary, "clean.tar.gz");
    const withFinder = path.join(temporary, "finder.tar.gz");
    runArchiveTool("create", payload, clean, { python });
    for (const directory of ["", "runtime/node_modules"])
      await writeFile(path.join(payload, directory, ".DS_Store"), "Finder view state");
    runArchiveTool("create", payload, withFinder, { python });
    expect(await digestFile(withFinder)).toBe(await digestFile(clean));
    const extracted = path.join(temporary, "extracted");
    await verifyArtifact({ archive: withFinder, context, python, extractTo: extracted });
    expect(existsSync(path.join(extracted, ".DS_Store"))).toBe(false);
    expect(existsSync(path.join(extracted, "runtime/node_modules/.DS_Store"))).toBe(false);
    expect(record.files.some((file) => file.path.endsWith(".DS_Store"))).toBe(false);
  });
  it("creates a deterministic archive, verifies it, and streams prevalidated members", async () => {
    const { temporary, payload, record } = await fixture();
    const first = path.join(temporary, "first.tar.gz");
    const second = path.join(temporary, "second.tar.gz");
    runArchiveTool("create", payload, first, { python });
    runArchiveTool("create", payload, second, { python });
    expect(await digestFile(first)).toBe(await digestFile(second));
    expect((await verifyArtifact({ archive: first, context, python })).manifest.contentSha256).toBe(
      record.contentSha256,
    );
    await expect(
      verifyArtifact({ archive: first, context, python, expectedSha256: "0".repeat(64) }),
    ).rejects.toThrow("DIGEST");
    const streamed = spawnSync(python, ["-B", helper, "stream", first]);
    expect(streamed.status, streamed.stderr.toString()).toBe(0);
    let offset = 0;
    let count = 0;
    while (offset < streamed.stdout.length) {
      const end = streamed.stdout.indexOf(10, offset);
      const header = JSON.parse(streamed.stdout.subarray(offset, end).toString());
      offset = end + 1 + header.size;
      count += 1;
    }
    expect(offset).toBe(streamed.stdout.length);
    expect(count).toBe(record.files.length + 1);
    const contextFile = path.join(temporary, "context.json");
    await writeFile(contextFile, JSON.stringify(context));
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    expect(await verifyArtifactMain(["--shell", "untrusted"], { stdout, stderr })).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Invalid or duplicate argument"),
    );
    expect(
      await verifyArtifactMain(
        [
          "--archive",
          first,
          "--context",
          contextFile,
          "--extract-to",
          path.join(temporary, "cli-extraction"),
          "--expected-sha256",
          await digestFile(first),
        ],
        { stdout, stderr },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.write.mock.calls[0][0]).manifest.contentSha256).toBe(
      record.contentSha256,
    );
  });
  it.each([
    ["../escape", "ARTIFACT_UNSAFE_PATH"],
    ["/absolute", "ARTIFACT_UNSAFE_PATH"],
    ["symbolic", "ARTIFACT_NON_REGULAR_MEMBER"],
    ["hardlink", "ARTIFACT_NON_REGULAR_MEMBER"],
    ["duplicate", "ARTIFACT_DUPLICATE_MEMBER"],
    ["fifo", "ARTIFACT_NON_REGULAR_MEMBER"],
    ["unsafe-mode", "ARTIFACT_UNSAFE_MODE"],
    ["file-before-child", "ARTIFACT_FILE_DIRECTORY_COLLISION"],
    ["child-before-file", "ARTIFACT_FILE_DIRECTORY_COLLISION"],
    ["empty", "ARTIFACT_EMPTY_ARCHIVE"],
    ["late-directory", "ARTIFACT_NON_REGULAR_MEMBER"],
  ])(
    "[R2-D15] preflights and rejects malicious tar %s before writing any member",
    async (fault, code) => {
      const { temporary } = await fixture();
      const archive = path.join(temporary, "bad.tar.gz");
      const extraction = path.join(temporary, "new-parent/nested/extraction");
      const parentMode = (await lstat(temporary)).mode;
      const script = [
        "import io,sys,tarfile",
        "p,f=sys.argv[1:]",
        "with tarfile.open(p,'w:gz') as t:",
        " if f!='empty':",
        "  names=['tree','tree/leaf'] if f=='file-before-child' else ['tree/leaf','tree'] if f=='child-before-file' else ['good','good' if f=='duplicate' else f]",
        "  for index,name in enumerate(names):",
        "   info=tarfile.TarInfo(name)",
        "   info.mode=0o775 if index==1 and f=='unsafe-mode' else 0o644",
        "   if index==1 and f in ('symbolic','hardlink','fifo','late-directory'):",
        "    info.type={'symbolic':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE,'late-directory':tarfile.DIRTYPE}[f]",
        "    info.linkname='../escape'",
        "   else: info.size=1",
        "   t.addfile(info,io.BytesIO(b'x') if info.size else None)",
      ].join("\n");
      expect(spawnSync(python, ["-c", script, archive, fault]).status).toBe(0);
      expect(() => runArchiveTool("extract", archive, extraction, { python })).toThrow(code);
      expect(existsSync(extraction)).toBe(false);
      expect(existsSync(path.join(temporary, "new-parent"))).toBe(false);
      expect((await lstat(temporary)).mode).toBe(parentMode);
      const streamed = spawnSync(python, ["-B", helper, "stream", archive]);
      expect(streamed.status).not.toBe(0);
      expect(streamed.stderr.toString()).toContain(code);
      expect(streamed.stdout).toHaveLength(0);
    },
  );
  it("[R2-D15] keeps the earlier nested link error ahead of a later unsafe root path", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "himawari-artifact-test-"));
    directories.push(temporary);
    const root = path.join(temporary, "inventory");
    await mkdir(path.join(root, "a-early"), { recursive: true });
    await writeFile(path.join(root, "00-readable.txt"), "valid earlier bytes\n");
    await symlink("missing", path.join(root, "a-early/first-link"));
    await writeFile(path.join(root, "z\\unsafe"), "later unsafe path\n");
    const expected = "ARTIFACT_LINK_FORBIDDEN:a-early/first-link";
    await expect(collectArtifactFilesSerialReference(root)).rejects.toMatchObject({
      message: expected,
    });
    await expect(collectArtifactFiles(root)).rejects.toMatchObject({ message: expected });
  });
  it("[R2-D15] preserves EACCES from an earlier unreadable real file and restores its permissions", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "himawari-artifact-test-"));
    directories.push(temporary);
    const root = path.join(temporary, "inventory");
    await mkdir(root);
    const bytes = Buffer.alloc(128 * 1024, 0x5a);
    for (const name of ["a-denied.txt", "b-readable.txt", "c-readable.txt", "d-readable.txt"])
      await writeFile(path.join(root, name), bytes, { mode: 0o644 });
    const blocked = path.join(root, "a-denied.txt");
    await chmod(blocked, 0o000);
    try {
      expect((await lstat(blocked)).mode & 0o777).toBe(0o000);
      const expected = { code: "EACCES", syscall: "open", path: blocked };
      await expect(collectArtifactFilesSerialReference(root)).rejects.toMatchObject(expected);
      await expect(collectArtifactFiles(root)).rejects.toMatchObject(expected);
    } finally {
      await chmod(blocked, 0o644);
    }
    expect((await lstat(blocked)).mode & 0o777).toBe(0o644);
    expect(await readFile(blocked)).toEqual(bytes);
  });
});
