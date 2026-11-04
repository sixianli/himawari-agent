import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import type {
  SandboxHostBinding,
  SandboxRuntimeQualification,
} from "@himawari-agent/execution-contracts";
import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  createReusingSandboxHostVerifier,
  digestSandboxRuntime,
} from "../src/capabilities/sandbox-host-verifier.js";

const realpathCalls = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: (...args: Parameters<typeof fs.realpath>) => {
      realpathCalls(args[0]);
      return fs.realpath(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  realpathCalls.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-host-reuse-")));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const privateRoot = path.join(root, "private");
  await Promise.all(
    [runtime, workspace, privateRoot].map((value) => mkdir(value, { mode: 0o700 })),
  );
  await writeFile(path.join(runtime, "runner.js"), "runner", { mode: 0o600 });
  await writeFile(path.join(runtime, "node"), "executable", { mode: 0o700 });
  const info = await stat(workspace);
  const binding: SandboxHostBinding = {
    schemaVersion: "sandbox-host-binding.v1",
    capabilityRef: "test",
    capabilityVersion: "1",
    artifactDigest: `sha256:${digest("artifact")}`,
    hostId: "host",
    profileRef: "mac",
    runtimeRoot: runtime,
    runtimeDigest: await digestSandboxRuntime(runtime),
    executable: { path: path.join(runtime, "node"), sha256: digest("executable") },
    runner: { path: path.join(runtime, "runner.js"), sha256: digest("runner") },
    privateRoot,
    roots: [
      {
        canonicalRootId: "root",
        canonicalPath: workspace,
        device: String(info.dev),
        inode: String(info.ino),
      },
    ],
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
    maximumResourceCeiling: {
      maxWallTimeMs: 1000,
      maxCpuTimeMs: 1000,
      maxMemoryBytes: 1000,
      maxOutputBytes: 1000,
      maxProgressEvents: 10,
    },
  };
  const linux = process.platform === "linux";
  const qualification: SandboxRuntimeQualification = {
    schemaVersion: "sandbox-runtime-qualification.v1",
    qualificationRef: "test-evidence-only",
    hostId: "host",
    profileRef: "mac",
    srtVersion: SANDBOX_RUNTIME_VERSION,
    platform: linux ? "linux" : "darwin",
    architecture: process.arch as "arm64" | "x64",
    osRelease: release(),
    runtimeDigest: binding.runtimeDigest,
    runnerDigest: binding.runner.sha256,
    evidenceDigest: digest("test-only"),
    resourceMode: "observe_and_stop",
    terminationMode: linux ? "verified_tree" : "best_effort",
    guarantees: [
      "filesystem_default_deny",
      "network_allowlist",
      "clean_environment",
      "bounded_output",
      "wall_clock_stop",
      "resource_observation",
      "durable_start_admission",
      "unknown_quarantine",
      "restart_reconciliation",
      ...(linux
        ? (["task_tree_termination", "worker_crash_cleanup"] as const)
        : (["best_effort_stop"] as const)),
    ],
    limitations: linux ? [] : ["detached_descendants_may_survive_stop"],
  };
  return { binding, qualification, hostId: "host" };
}

it("[TG-2] checks the host files once and reuses the result while nothing on disk changed", async () => {
  const input = await fixture();
  let now = 1_000;
  const verify = createReusingSandboxHostVerifier({
    reuseMs: 10_000,
    now: () => now,
    wallClockMs: () => Date.now() + 60_000,
  });
  await verify(input);
  expect(realpathCalls).toHaveBeenCalled();
  realpathCalls.mockClear();
  await writeFile(path.join(input.binding.roots[0]?.canonicalPath ?? "", "note.txt"), "note");
  now += 9_000;
  await verify(input);
  await verify(input);
  expect(realpathCalls).not.toHaveBeenCalled();
  now += 1_000;
  await verify(input);
  expect(realpathCalls).toHaveBeenCalled();
});

it("[TG-2] checks again in full when a host path is replaced, rewritten or made unsafe", async () => {
  const input = await fixture();
  const verify = createReusingSandboxHostVerifier({
    reuseMs: 10_000,
    now: () => 1_000,
    wallClockMs: () => Date.now() + 60_000,
  });
  await verify(input);
  await chmod(input.binding.runtimeRoot, 0o777);
  await expect(verify(input)).rejects.toThrow("SANDBOX_HOST_PATH_UNSAFE");
  await chmod(input.binding.runtimeRoot, 0o700);
  await verify(input);
  realpathCalls.mockClear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(input.binding.executable.path, "EXECUTABLE");
  await verify(input);
  expect(realpathCalls).toHaveBeenCalled();
  const workspace = input.binding.roots[0]?.canonicalPath ?? "";
  await rename(workspace, `${workspace}-old`);
  await mkdir(workspace, { mode: 0o700 });
  await expect(verify(input)).rejects.toThrow("SANDBOX_HOST_ROOT_CHANGED");
});

it("[TG-2] still checks the plan against the binding on every call", async () => {
  const input = await fixture();
  const verify = createReusingSandboxHostVerifier({
    reuseMs: 10_000,
    now: () => 1_000,
    wallClockMs: () => Date.now() + 60_000,
  });
  await verify(input);
  await expect(verify({ ...input, hostId: "other-host" })).rejects.toThrow(
    "SANDBOX_HOST_QUALIFICATION_CHANGED",
  );
});

it("[TG-2] does not reuse a check when a host file changed too recently to trust its timestamps", async () => {
  const input = await fixture();
  const verify = createReusingSandboxHostVerifier({ reuseMs: 10_000, now: () => 1_000 });
  await verify(input);
  realpathCalls.mockClear();
  await verify(input);
  expect(realpathCalls).toHaveBeenCalled();
});
