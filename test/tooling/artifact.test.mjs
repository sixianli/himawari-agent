import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectArtifactFiles,
  contentDigest,
  digestFile,
} from "../../scripts/ci/artifact-files.mjs";
import { fileSha256, repositoryRoot } from "../../scripts/ci/contracts.mjs";
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

describe("same-artifact verification", () => {
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
    record.files = (await collectArtifactFiles(payload)).filter(
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
    const output = path.join(temporary, "runtime");
    await packageNodeRuntime({
      root: temporary,
      buildRoot: path.join(temporary, "compiled"),
      runtimeRoot: output,
    });
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
    ).rejects.toThrow();
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
  it.each(["../escape", "/absolute", "symbolic", "hardlink", "duplicate", "fifo"])(
    "preflights and rejects malicious tar %s before writing any member",
    async (fault) => {
      const { temporary } = await fixture();
      const archive = path.join(temporary, "bad.tar.gz");
      const extraction = path.join(temporary, "extraction");
      const script =
        "import io,sys,tarfile\np,f=sys.argv[1:]\nwith tarfile.open(p,'w:gz') as t:\n a=tarfile.TarInfo('good');a.size=1;a.mode=0o644;t.addfile(a,io.BytesIO(b'x'))\n b=tarfile.TarInfo('good' if f=='duplicate' else f);b.mode=0o644\n if f in ('symbolic','hardlink','fifo'):b.type={'symbolic':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}[f];b.linkname='../escape'\n else:b.size=1\n t.addfile(b,io.BytesIO(b'x') if b.size else None)\n";
      expect(spawnSync(python, ["-c", script, archive, fault]).status).toBe(0);
      expect(() => runArchiveTool("extract", archive, extraction, { python })).toThrow();
      expect(existsSync(extraction)).toBe(false);
      expect(spawnSync(python, ["-B", helper, "stream", archive]).status).not.toBe(0);
    },
  );
});
