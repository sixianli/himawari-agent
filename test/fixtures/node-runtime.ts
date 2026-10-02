import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { expect } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function recordRuntimeInstallation(runtimeRoot: string, newlyInstalled: boolean) {
  const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
  if (!output) return;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const storage =
    process.platform === "linux"
      ? spawnSync(
          "/usr/bin/findmnt",
          ["--target", runtimeRoot, "--output", "SOURCE,TARGET,FSTYPE", "--json"],
          {
            encoding: "utf8",
          },
        )
      : undefined;
  await writeFile(
    path.join(output, `runtime-installation-${randomUUID()}.json`),
    JSON.stringify({
      runtimeRoot: await realpath(runtimeRoot),
      newlyInstalled,
      installationScope: "one per test file",
      pageCacheState: "not observed",
      recordedAt: Date.now(),
      testFile: expect.getState().testPath,
      processId: process.pid,
      vitestWorkerId: process.env["VITEST_WORKER_ID"] ?? null,
      vitestPoolId: process.env["VITEST_POOL_ID"] ?? null,
      storage: storage && {
        exitCode: storage.status,
        stdout: storage.stdout,
        stderr: storage.stderr,
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
}

export async function installTestNodeRuntime(errorPrefix = "TEST_RUNTIME") {
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: context } = process.env;
  if (!artifact && !context) {
    const runtimeRoot = path.join(repositoryRoot, "dist/node-runtime");
    await recordRuntimeInstallation(runtimeRoot, false);
    return { runtimeRoot, close: async () => {} };
  }
  if (!artifact || !context) throw new Error(`${errorPrefix}_ARTIFACT_CONTEXT_REQUIRED`);
  const installation = await mkdtemp(path.join(testTemporaryRoot(), "runtime-install-"));
  const installed = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
      "--prefix",
      installation,
      "--artifact",
      artifact,
      "--context",
      context,
    ],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  if (installed.status !== 0) {
    await rm(installation, { recursive: true, force: true });
    throw new Error(`${errorPrefix}_INSTALL_FAILED:${installed.stderr}`);
  }
  const runtimeRoot = path.join(installation, "lib/himawari-agent");
  await recordRuntimeInstallation(runtimeRoot, true);
  return {
    runtimeRoot,
    close: async () => rm(installation, { recursive: true, force: true }),
  };
}

export async function expectTestRuntimeFile(filename: string): Promise<void> {
  const actual = await realpath(filename);
  const bytes = await readFile(actual);
  expect(bytes.byteLength).toBeGreaterThan(0);
  const developmentRoot = path.join(await realpath(repositoryRoot), "dist/node-runtime");
  const artifactRequested = Boolean(
    process.env["HIMAWARI_TEST_ARTIFACT"] || process.env["HIMAWARI_TEST_CONTEXT"],
  );
  const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
  if (output) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(output, `runtime-origin-${createHash("sha256").update(actual).digest("hex")}.json`),
      JSON.stringify({
        filename,
        actual,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        developmentRoot,
        artifactRequested,
      }),
      { mode: 0o600 },
    );
  }
  expect(actual.startsWith(`${developmentRoot}${path.sep}`)).toBe(!artifactRequested);
  if (artifactRequested) expect(actual).toContain("/lib/himawari-agent/");
}
