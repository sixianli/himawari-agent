import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, inject } from "vitest";
import { selectRuntimeSource } from "./shared-node-runtime.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface TestNodeRuntime {
  readonly prefix: string;
  readonly runtimeRoot: string;
  readonly shared: boolean;
  readonly installationScope: string;
  readonly installElapsedMs: number | undefined;
  close(): Promise<void>;
}

async function recordRuntimeInstallation(
  runtimeRoot: string,
  newlyInstalled: boolean,
  installationScope: string,
  installElapsedMs?: number,
) {
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
      installationScope,
      installElapsedMs: installElapsedMs ?? null,
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

export async function installTestNodeRuntime(
  errorPrefix = "TEST_RUNTIME",
): Promise<TestNodeRuntime> {
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: context } = process.env;
  const source = await selectRuntimeSource({
    shared: inject("sharedNodeRuntime"),
    artifact,
    context,
    errorPrefix,
  });
  if (source.kind === "shared") {
    await recordRuntimeInstallation(
      source.shared.runtimeRoot,
      false,
      "one per test run",
      source.shared.installElapsedMs,
    );
    return {
      prefix: source.shared.prefix,
      runtimeRoot: source.shared.runtimeRoot,
      shared: true,
      installationScope: "one per test run",
      installElapsedMs: source.shared.installElapsedMs,
      close: async () => {},
    };
  }
  const runtimeRoot = path.join(repositoryRoot, "dist/node-runtime");
  await recordRuntimeInstallation(runtimeRoot, false, "development build");
  return {
    prefix: path.dirname(runtimeRoot),
    runtimeRoot,
    shared: false,
    installationScope: "development build",
    installElapsedMs: undefined,
    close: async () => {},
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
