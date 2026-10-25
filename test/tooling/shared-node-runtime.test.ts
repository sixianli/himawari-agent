import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSharedRuntime,
  describeRuntimeTree,
  openRuntimeTree,
  removeSharedRuntime,
  sealRuntimeTree,
  selectRuntimeSource,
  verifySharedRuntime,
} from "../fixtures/shared-node-runtime.ts";

const temporaryRoots: string[] = [];
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await openRuntimeTree(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function fakeInstallation(): Promise<string> {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "himawari-shared-runtime-"));
  temporaryRoots.push(prefix);
  const runtimeRoot = path.join(prefix, "lib/himawari-agent");
  await mkdir(path.join(runtimeRoot, "node_modules/@himawari-agent/admin-cli/dist"), {
    recursive: true,
    mode: 0o755,
  });
  await writeFile(
    path.join(runtimeRoot, "runtime-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, entrypoints: { himawari: "node_modules/@himawari-agent/admin-cli/dist/main.js" } })}\n`,
    { mode: 0o644 },
  );
  await writeFile(
    path.join(runtimeRoot, "node_modules/@himawari-agent/admin-cli/dist/main.js"),
    "process.stdout.write('himawari');\n",
    { mode: 0o644 },
  );
  await mkdir(path.join(prefix, "bin"), { mode: 0o755 });
  await writeFile(path.join(prefix, "bin/himawari"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return prefix;
}

describe("[R2-T8] shared read-only runtime installation", () => {
  it("[R2-T8] rejects an announced shared runtime whose contents changed", async () => {
    const prefix = await fakeInstallation();
    const shared = await describeRuntimeTree(prefix);
    await expect(assertSharedRuntime(shared)).resolves.toBeUndefined();

    await openRuntimeTree(prefix);
    await writeFile(
      path.join(prefix, "lib/himawari-agent/runtime-manifest.json"),
      `${JSON.stringify({ schemaVersion: 2 })}\n`,
    );
    await sealRuntimeTree(prefix);

    await expect(assertSharedRuntime(shared)).rejects.toThrow("SHARED_RUNTIME_MISMATCH");
    await expect(verifySharedRuntime(shared)).rejects.toThrow("SHARED_RUNTIME_MODIFIED");
    await expect(
      selectRuntimeSource({
        shared,
        artifact: "artifact.tgz",
        context: "context.json",
        errorPrefix: "TEST_RUNTIME",
      }),
    ).rejects.toThrow("SHARED_RUNTIME_MISMATCH");
  });

  it("[R2-T8] keeps today's decisions when the run has no shared runtime", async () => {
    await expect(
      selectRuntimeSource({
        shared: undefined,
        artifact: undefined,
        context: undefined,
        errorPrefix: "TEST_RUNTIME",
      }),
    ).resolves.toEqual({ kind: "development" });
    await expect(
      selectRuntimeSource({
        shared: undefined,
        artifact: "artifact.tgz",
        context: undefined,
        errorPrefix: "PREPARED_RUNNER",
      }),
    ).rejects.toThrow("PREPARED_RUNNER_ARTIFACT_CONTEXT_REQUIRED");
    await expect(
      selectRuntimeSource({
        shared: undefined,
        artifact: undefined,
        context: "context.json",
        errorPrefix: "TEST_RUNTIME",
      }),
    ).rejects.toThrow("TEST_RUNTIME_ARTIFACT_CONTEXT_REQUIRED");
    await expect(
      selectRuntimeSource({
        shared: undefined,
        artifact: "artifact.tgz",
        context: "context.json",
        errorPrefix: "TEST_RUNTIME",
      }),
    ).rejects.toThrow("TEST_RUNTIME_SHARED_RUNTIME_REQUIRED");

    const prefix = await fakeInstallation();
    const shared = await describeRuntimeTree(prefix);
    await expect(
      selectRuntimeSource({
        shared,
        artifact: "artifact.tgz",
        context: "context.json",
        errorPrefix: "TEST_RUNTIME",
      }),
    ).resolves.toEqual({ kind: "shared", shared });
  });

  it("[R2-T8] seals the shared runtime read-only", async () => {
    const prefix = await fakeInstallation();
    const shared = await describeRuntimeTree(prefix);

    expect((await lstat(shared.runtimeRoot)).mode & 0o777).toBe(0o555);
    expect((await lstat(path.join(shared.runtimeRoot, "runtime-manifest.json"))).mode & 0o777).toBe(
      0o444,
    );
    expect((await lstat(path.join(prefix, "bin/himawari"))).mode & 0o777).toBe(0o555);
    await expect(
      readFile(path.join(shared.runtimeRoot, "runtime-manifest.json"), "utf8"),
    ).resolves.toContain("schemaVersion");

    if (!asRoot) {
      await expect(
        writeFile(path.join(shared.runtimeRoot, "runtime-manifest.json"), "changed\n"),
      ).rejects.toThrow();
      await expect(
        writeFile(path.join(shared.runtimeRoot, "added.js"), "added\n"),
      ).rejects.toThrow();
      await expect(writeFile(path.join(prefix, "bin/added"), "added\n")).rejects.toThrow();
    }
  });

  it("[R2-T8] verifies the tree and restores write permission before removing it", async () => {
    const cleanPrefix = await fakeInstallation();
    const clean = await describeRuntimeTree(cleanPrefix);
    await expect(removeSharedRuntime(clean)).resolves.toBeUndefined();
    await expect(lstat(cleanPrefix)).rejects.toThrow();

    const changedPrefix = await fakeInstallation();
    const changed = await describeRuntimeTree(changedPrefix);
    await openRuntimeTree(changedPrefix);
    await writeFile(
      path.join(changedPrefix, "lib/himawari-agent/runtime-manifest.json"),
      `${JSON.stringify({ schemaVersion: 3 })}\n`,
    );
    await sealRuntimeTree(changedPrefix);

    await expect(verifySharedRuntime(changed)).rejects.toThrow("SHARED_RUNTIME_MODIFIED");
    await expect(removeSharedRuntime(changed)).rejects.toThrow("SHARED_RUNTIME_MODIFIED");
    await expect(lstat(changedPrefix)).rejects.toThrow();
  });
});
