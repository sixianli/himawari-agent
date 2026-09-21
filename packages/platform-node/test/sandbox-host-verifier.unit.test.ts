import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SandboxHostBinding,
  SandboxRuntimeQualification,
} from "@himawari-agent/execution-contracts";
import { sandboxScopeSchema } from "@himawari-agent/execution-contracts";
import { afterEach, expect, it } from "vitest";
import {
  digestSandboxRuntime,
  resolveSandboxFileWorkspaceClaim,
  resolveSandboxWorkspaceClaim,
  verifySandboxHost,
} from "../src/capabilities/sandbox-host-verifier.js";
import { createDirectoryMoveJournal, resolveSandboxDirectoryMoveScope } from "../src/index.js";

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

function scopeFor(input: Awaited<ReturnType<typeof fixture>>) {
  return sandboxScopeSchema.parse({
    schemaVersion: "sandbox-scope.v1",
    ownerId: "owner",
    agentId: "agent",
    threadId: "thread",
    runId: "run",
    toolCallId: "call",
    parentToolCallId: null,
    parentRequestId: "run",
    hostId: input.hostId,
    handleRef: "handle",
    inputRef: "input",
    operation: "read",
    authorizationRef: "grant",
    modelRef: "model",
    profileRef: input.binding.profileRef,
    directoryGrant: {
      ref: "directory",
      revision: 1,
      canonicalRootId: "root",
      authorizationRef: "directory-grant",
      operations: ["read"],
    },
    networkAuthorizationRef: null,
    expiresAt: "2999-01-01T00:00:00.000Z",
  });
}
it("derives occupancy from current filesystem ancestors and detects directory replacement", async () => {
  const input = await fixture();
  const scope = scopeFor(input);
  const claim = await resolveSandboxWorkspaceClaim({ ...input, scope });
  const root = input.binding.roots[0];
  if (!root) throw new Error("fixture root missing");
  expect(claim.lineage.at(-1)).toEqual({ device: root.device, inode: root.inode });
  expect(claim.access).toBe("read");
  const nested = path.join(root.canonicalPath, "nested");
  await mkdir(nested, { mode: 0o700 });
  const identity = await stat(nested);
  const child = await resolveSandboxWorkspaceClaim({
    scope,
    binding: {
      ...input.binding,
      roots: [
        {
          ...root,
          canonicalPath: nested,
          device: String(identity.dev),
          inode: String(identity.ino),
        },
      ],
    },
  });
  expect(child.lineage.slice(0, -1)).toEqual(claim.lineage);
  expect(
    (
      await resolveSandboxWorkspaceClaim({
        ...input,
        scope: {
          ...scope,
          directoryGrant: { ...scope.directoryGrant, operations: ["read", "update"] },
        },
      })
    ).access,
  ).toBe("write");
  await rename(root.canonicalPath, `${root.canonicalPath}-old`);
  await mkdir(root.canonicalPath, { mode: 0o700 });
  await expect(resolveSandboxWorkspaceClaim({ ...input, scope })).rejects.toThrow("ROOT_CHANGED");
});
it("rejects foreign roots and symlink aliases rather than trusting root labels", async () => {
  const input = await fixture();
  const scope = scopeFor(input);
  await expect(
    resolveSandboxWorkspaceClaim({ ...input, scope: { ...scope, hostId: "other" } }),
  ).rejects.toThrow("ROOT_CHANGED");
  const root = input.binding.roots[0];
  if (!root) throw new Error("fixture root missing");
  const alias = `${root.canonicalPath}-alias`;
  await symlink(root.canonicalPath, alias);
  await expect(
    resolveSandboxWorkspaceClaim({
      scope,
      binding: { ...input.binding, roots: [{ ...root, canonicalPath: alias }] },
    }),
  ).rejects.toThrow("PATH_UNSAFE");
});

it.each(["content", "file-link", "directory-link", "writable"])(
  "revalidates nested runtime leaves and rejects %s changes",
  async (change) => {
    const input = await fixture();
    const directory = path.join(input.binding.runtimeRoot, "nested");
    await mkdir(directory, { mode: 0o700 });
    await Promise.all(
      Array.from({ length: 18 }, (_, index) =>
        writeFile(path.join(directory, `helper-${index}`), "nested-helper", { mode: 0o600 }),
      ),
    );
    const expected = await digestSandboxRuntime(input.binding.runtimeRoot);
    Object.assign(input.binding, { runtimeDigest: expected });
    Object.assign(input.qualification, { runtimeDigest: expected });
    await verifySandboxHost(input);
    const target = path.join(directory, "helper-0");
    if (change === "content") await writeFile(target, "changed-helper");
    if (change === "writable") await chmod(target, 0o666);
    if (change === "file-link") {
      const outside = path.join(input.binding.privateRoot, "helper");
      await rename(target, outside);
      await symlink(outside, target);
    }
    if (change === "directory-link") {
      const outside = path.join(input.binding.privateRoot, "nested");
      await rename(directory, outside);
      await symlink(outside, directory);
    }
    await expect(verifySandboxHost(input)).rejects.toThrow(/SANDBOX_HOST/);
  },
);

it("resolves file slots and inode identities without locking sibling files", async () => {
  const input = await fixture();
  const scope = scopeFor(input);
  const root = input.binding.roots[0];
  if (!root) throw new Error("fixture root missing");
  await mkdir(path.join(root.canonicalPath, "notes"));
  await writeFile(path.join(root.canonicalPath, "notes", "A.txt"), "first");
  const resolve = (relativePath: string) =>
    resolveSandboxFileWorkspaceClaim({ ...input, scope, relativePath, access: "read" });
  const existing = await resolve("notes/A.txt");
  const absent = await resolve("notes/B.txt");
  expect(existing.file?.name).toBe("a.txt");
  expect(existing.file?.identity).toEqual({
    device: String((await stat(path.join(root.canonicalPath, "notes/A.txt"))).dev),
    inode: String((await stat(path.join(root.canonicalPath, "notes/A.txt"))).ino),
  });
  expect(absent.file).toEqual({ name: "b.txt", identity: null, atomicPublish: false });
  expect(existing.lineage).toEqual(absent.lineage);
  expect(existing.ref).not.toBe(absent.ref);
  expect((await resolve("new-parent/file.txt")).file).toBeUndefined();
  await link(
    path.join(root.canonicalPath, "notes/A.txt"),
    path.join(root.canonicalPath, "alias.txt"),
  );
  await expect(resolve("alias.txt")).rejects.toThrow("FILE_UNSAFE");
  await expect(resolve("../outside")).rejects.toThrow();
  await expect(resolve(".git/config")).rejects.toThrow();
  await symlink(path.join(root.canonicalPath, "notes"), path.join(root.canonicalPath, "linked"));
  await expect(resolve("linked/B.txt")).rejects.toThrow("PATH_UNSAFE");
});

it("resolves directory source, source slot and destination slot without serializing sibling files", async () => {
  const f = await fixture();
  const base = scopeFor(f);
  const root = f.binding.roots[0];
  if (!root) throw new Error("fixture root missing");
  await mkdir(path.join(root.canonicalPath, "reports"));
  await mkdir(path.join(root.canonicalPath, "diary"));
  const scope = {
    ...base,
    operation: "move_directory",
    directoryGrant: { ...base.directoryGrant, operations: ["read", "move"] as const },
  };
  const resolved = await resolveSandboxDirectoryMoveScope({
    ...f,
    scope,
    sourceRelativePath: "reports",
    destinationRelativePath: "archive",
  });
  expect(resolved.claims).toHaveLength(3);
  expect(resolved.claims.filter((claim) => claim.file)).toHaveLength(2);
  expect(resolved.target.sourceLineage).toHaveLength(2);
  expect(resolved.target.destinationLineage).toHaveLength(1);
  await expect(
    resolveSandboxDirectoryMoveScope({
      ...f,
      scope,
      sourceRelativePath: "reports",
      destinationRelativePath: "diary",
    }),
  ).rejects.toThrow("TARGET_EXISTS");
  await expect(
    resolveSandboxDirectoryMoveScope({
      ...f,
      scope,
      sourceRelativePath: "reports",
      destinationRelativePath: "reports/child",
    }),
  ).rejects.toThrow("PATH_INVALID");
  await rename(path.join(root.canonicalPath, "reports"), path.join(root.canonicalPath, "old"));
  await mkdir(path.join(root.canonicalPath, "reports"));
  const replaced = await resolveSandboxDirectoryMoveScope({
    ...f,
    scope,
    sourceRelativePath: "reports",
    destinationRelativePath: "archive",
  });
  expect(replaced.target.sourceIdentity).not.toEqual(resolved.target.sourceIdentity);
});

it("moves a real directory without overwrite and recovers inode-bound results without replay", async () => {
  const f = await fixture();
  const root = f.binding.roots[0];
  if (!root) throw new Error("fixture root missing");
  const info = await stat(root.canonicalPath);
  const canonicalRootId = `${info.dev}:${info.ino}`;
  const binding = { ...f.binding, roots: [{ ...root, canonicalRootId }] };
  const base = scopeFor(f);
  const scope = {
    ...base,
    operation: "move_directory",
    directoryGrant: {
      ...base.directoryGrant,
      canonicalRootId,
      operations: ["read", "move"] as const,
    },
  };
  await mkdir(path.join(root.canonicalPath, "reports"));
  await writeFile(path.join(root.canonicalPath, "reports", "a.txt"), "retained");
  const resolved = await resolveSandboxDirectoryMoveScope({
    binding,
    scope,
    sourceRelativePath: "reports",
    destinationRelativePath: "archive",
  });
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "directory-move-journal-"));
  roots.push(privateDirectory);
  const executable = path.join(privateDirectory, "rename-native");
  execFileSync("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    fileURLToPath(new URL("../src/files/rename-native.c", import.meta.url)),
    "-o",
    executable,
  ]);
  const context = {
    scope: { ...scope, directoryMove: resolved.target },
    workspace: root.canonicalPath,
    privateDirectory,
    directoryRenameExecutable: executable,
  };
  // Call the native boundary directly with a destination created after resolution.
  await mkdir(path.join(root.canonicalPath, "archive"));
  const occupied = await stat(path.join(root.canonicalPath, "archive"));
  const argv = [
    root.canonicalPath,
    "reports",
    "archive",
    String(info.dev),
    String(info.ino),
    resolved.target.sourceIdentity.device,
    resolved.target.sourceIdentity.inode,
  ];
  expect(() => execFileSync(executable, argv, { stdio: "pipe" })).toThrow();
  expect((await stat(path.join(root.canonicalPath, "archive"))).ino).toBe(occupied.ino);
  expect(await readFile(path.join(root.canonicalPath, "reports/a.txt"), "utf8")).toBe("retained");
  await rm(path.join(root.canonicalPath, "archive"), { recursive: true });
  if (process.platform === "linux") {
    const machineRoot = await stat("/");
    const otherDevice = await stat("/dev/shm");
    expect(otherDevice.dev).not.toBe(info.dev);
    expect(() =>
      execFileSync(
        executable,
        [
          "/",
          path.relative("/", path.join(root.canonicalPath, "reports")),
          `dev/shm/himawari-never-created-${info.ino}`,
          String(machineRoot.dev),
          String(machineRoot.ino),
          resolved.target.sourceIdentity.device,
          resolved.target.sourceIdentity.inode,
        ],
        { stdio: "pipe" },
      ),
    ).toThrow();
    expect(await readFile(path.join(root.canonicalPath, "reports/a.txt"), "utf8")).toBe("retained");
  }
  const journal = createDirectoryMoveJournal(context);
  const proof = await journal.execute();
  expect(await readFile(path.join(root.canonicalPath, "archive/a.txt"), "utf8")).toBe("retained");
  expect(await journal.recover()).toEqual(proof);
  await expect(journal.execute()).rejects.toThrow();
  // The original durable receipt is historical even after a later user edit.
  await writeFile(path.join(root.canonicalPath, "archive/a.txt"), "later edit");
  expect(await journal.recover()).toEqual(proof);
  expect(await readFile(path.join(root.canonicalPath, "archive/a.txt"), "utf8")).toBe("later edit");
  // Without the final receipt, matching source identity still explains the FS/DB gap.
  await unlink(path.join(privateDirectory, "directory-move-verified.json"));
  expect(await journal.recover()).toEqual(proof);
  await rename(
    path.join(root.canonicalPath, "archive"),
    path.join(root.canonicalPath, "moved-again"),
  );
  await mkdir(path.join(root.canonicalPath, "archive"));
  await expect(journal.recover()).rejects.toThrow("RESULT_UNKNOWN");
});
