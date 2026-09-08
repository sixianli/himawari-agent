import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import type {
  SandboxHostBinding,
  SandboxRuntimeQualification,
} from "@himawari-agent/execution-contracts";
import { afterEach, expect, it } from "vitest";
import {
  digestSandboxRuntime,
  verifySandboxHost,
} from "../src/capabilities/sandbox-host-verifier.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-host-verifier-")));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const privateRoot = path.join(root, "private");
  await Promise.all(
    [runtime, workspace, privateRoot].map((value) => mkdir(value, { mode: 0o700 })),
  );
  await writeFile(path.join(runtime, "runner.js"), "runner", { mode: 0o600 });
  await writeFile(path.join(runtime, "node"), "executable", { mode: 0o700 });
  await writeFile(path.join(runtime, "helper"), "helper", { mode: 0o600 });
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
  const qualification: SandboxRuntimeQualification = {
    schemaVersion: "sandbox-runtime-qualification.v1",
    qualificationRef: "test-evidence-only",
    hostId: "host",
    profileRef: "mac",
    srtVersion: "0.0.75",
    platform: "darwin",
    architecture: process.arch as "arm64" | "x64",
    osRelease: release(),
    runtimeDigest: binding.runtimeDigest,
    runnerDigest: binding.runner.sha256,
    evidenceDigest: digest("test-only"),
    resourceMode: "observe_and_stop",
    terminationMode: "best_effort",
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
      "best_effort_stop",
    ],
    limitations: ["detached_descendants_may_survive_stop"],
  };
  if (process.platform === "linux") {
    Object.assign(qualification, {
      platform: "linux",
      terminationMode: "verified_tree",
      limitations: [],
      guarantees: [
        ...qualification.guarantees.filter((value) => value !== "best_effort_stop"),
        "task_tree_termination",
        "worker_crash_cleanup",
      ],
    });
  }
  return { binding, qualification, hostId: "host" };
}
it("checks the complete installed closure again on every verification", async () => {
  const input = await fixture();
  await verifySandboxHost(input);
  await writeFile(path.join(input.binding.runtimeRoot, "helper"), "changed");
  await expect(verifySandboxHost(input)).rejects.toThrow("SANDBOX_HOST_ARTIFACT_CHANGED");
});
it("uses the installation inventory digest convention", async () => {
  const input = await fixture();
  const files = [
    { path: "helper", sha256: digest("helper"), bytes: 6, mode: 0o600 },
    { path: "node", sha256: digest("executable"), bytes: 10, mode: 0o700 },
    { path: "runner.js", sha256: digest("runner"), bytes: 6, mode: 0o600 },
  ];
  expect(input.binding.runtimeDigest).toBe(digest(JSON.stringify(files)));
});
it.each(["host", "os", "root", "symlink", "writable", "added"])(
  "rejects changed %s",
  async (mode) => {
    const input = await fixture();
    if (mode === "host") input.hostId = "other";
    if (mode === "os") Object.assign(input.qualification, { osRelease: "other" });
    if (mode === "root") {
      const root = input.binding.roots[0]?.canonicalPath;
      if (!root) throw new Error("fixture root missing");
      await rename(root, `${root}-old`);
      await mkdir(root);
    }
    if (mode === "symlink") {
      const runner = input.binding.runner.path;
      await rename(runner, `${runner}.old`);
      await symlink(`${runner}.old`, runner);
    }
    if (mode === "writable") await chmod(input.binding.runner.path, 0o666);
    if (mode === "added")
      await writeFile(path.join(input.binding.runtimeRoot, "injected.js"), "code");
    await expect(verifySandboxHost(input)).rejects.toThrow(/SANDBOX_HOST/);
  },
);

it.each(["valid", "final", "qualification", "runner", "capability", "guarantee", "ceiling"])(
  "binds the job to the live host: %s",
  async (mode) => {
    const input = await fixture();
    const plan = {
      schemaVersion: "sandbox-execution.v1" as const,
      identity: {
        jobId: "job",
        attemptId: "attempt",
        invocationId: "invocation",
        receiptRef: "receipt",
        hostId: input.hostId,
        ownerId: "owner",
        agentId: "agent",
        threadId: "thread",
        runId: "run",
        toolCallId: "tool",
      },
      handleRef: "handle",
      inputRef: "input",
      operation: "execute",
      capabilityRef: "test",
      capabilityVersion: "1",
      authorizationRef: "authorization",
      modelRef: "model",
      executionLease: {
        executionLeaseId: "lease",
        expectedLeaseRevision: 1,
        authorityLeaseId: "authority",
        authorityFencingToken: 1,
        deploymentId: "deployment",
        authorityEpoch: 1,
        fencingToken: 1,
        consumerId: "consumer",
      },
      requestedAt: "2026-09-08T00:00:00.000Z",
      originalDeadlineAt: "2026-09-08T00:01:00.000Z",
      effectiveDeadlineAt: "2026-09-08T00:01:00.000Z",
      resourceCeiling: { ...input.binding.maximumResourceCeiling },
      binding: {
        scopeRef: "scope",
        scopeDigest: digest("scope"),
        profileRef: input.binding.profileRef,
        runtimeDigest: input.binding.runtimeDigest,
        runnerDigest: input.binding.runner.sha256,
        qualificationRef: input.qualification.qualificationRef,
        requiredGuarantees: ["filesystem_default_deny"],
      },
    };
    if (mode === "qualification") plan.binding.qualificationRef = "other";
    if (mode === "runner") plan.binding.runnerDigest = digest("other");
    if (mode === "capability") plan.capabilityRef = "other";
    if (mode === "guarantee") plan.binding.requiredGuarantees = ["unproven"];
    if (mode === "ceiling") plan.resourceCeiling.maxMemoryBytes++;
    if (mode === "final")
      Object.assign(plan, { semanticFingerprint: `sha256:${digest("receipt")}` });
    if (mode === "valid" || mode === "final")
      await expect(verifySandboxHost({ ...input, plan })).resolves.toBeUndefined();
    else
      await expect(verifySandboxHost({ ...input, plan })).rejects.toThrow(
        "SANDBOX_HOST_PLAN_CHANGED",
      );
  },
);
