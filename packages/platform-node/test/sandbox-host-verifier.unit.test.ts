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
import { SANDBOX_RUNTIME_VERSION, sandboxScopeSchema } from "@himawari-agent/execution-contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  digestSandboxRuntime,
  resolveSandboxFileWorkspaceClaim,
  resolveSandboxWorkspaceClaim,
  runtimeFingerprintLocation,
  sandboxHostIdentity,
  verifySandboxHost,
} from "../src/capabilities/sandbox-host-verifier.js";
import { createDirectoryMoveJournal, resolveSandboxDirectoryMoveScope } from "../src/index.js";

const artifactReads = vi.hoisted(() => vi.fn());
vi.mock("../src/capabilities/artifact-verifier.js", async (original) => {
  const verifier = await original<typeof import("../src/capabilities/artifact-verifier.js")>();
  return {
    ...verifier,
    digestRegularFile: (filePath: string) => {
      artifactReads(filePath);
      return verifier.digestRegularFile(filePath);
    },
  };
});

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
    srtVersion: SANDBOX_RUNTIME_VERSION,
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
it("[NL-4] keeps the host identity when files are created inside a workspace root", async () => {
  const input = await fixture();
  const before = await sandboxHostIdentity(input.binding);
  const workspace = input.binding.roots[0]?.canonicalPath ?? "";
  await writeFile(path.join(workspace, "note.txt"), "note");
  await mkdir(path.join(workspace, "nested"));
  expect(await sandboxHostIdentity(input.binding)).toBe(before);
});

it("[NL-4] changes the host identity when a workspace root or runner file is replaced", async () => {
  const input = await fixture();
  const before = await sandboxHostIdentity(input.binding);
  const workspace = input.binding.roots[0]?.canonicalPath ?? "";
  await rename(workspace, `${workspace}-old`);
  await mkdir(workspace, { mode: 0o700 });
  const replacedRoot = await sandboxHostIdentity(input.binding);
  expect(replacedRoot).not.toBe(before);
  await rename(input.binding.runner.path, `${input.binding.runner.path}.old`);
  await writeFile(input.binding.runner.path, "runner", { mode: 0o600 });
  expect(await sandboxHostIdentity(input.binding)).not.toBe(replacedRoot);
});

it("[NL-4] changes the host identity when the protection manifest metadata changes", async () => {
  const input = await fixture();
  const manifest = path.join(input.binding.privateRoot, "protection.json");
  await writeFile(manifest, "{}", { mode: 0o600 });
  vi.stubEnv("HIMAWARI_RUNTIME_PROTECTION_FILE", manifest);
  try {
    const before = await sandboxHostIdentity(input.binding);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await chmod(manifest, 0o400);
    expect(await sandboxHostIdentity(input.binding)).not.toBe(before);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("[R2-D25] trusts an unprotected installation without reading or comparing its files", async () => {
  const input = await fixture();
  await verifySandboxHost(input);
  const runtime = input.binding.runtimeRoot;
  await writeFile(path.join(runtime, "helper"), "changed");
  await writeFile(path.join(runtime, "injected.js"), "code", { mode: 0o600 });
  await writeFile(input.binding.executable.path, "EXECUTABLE");
  await writeFile(input.binding.runner.path, "RUNNER");
  await chmod(path.join(runtime, "helper"), 0o200);
  await mkdir(path.join(runtime, "unlisted"), { mode: 0o000 });
  artifactReads.mockClear();
  await verifySandboxHost(input);
  const other = digest("other runtime");
  await verifySandboxHost({
    ...input,
    binding: { ...input.binding, runtimeDigest: other },
    qualification: { ...input.qualification, runtimeDigest: other },
  });
  expect(artifactReads).not.toHaveBeenCalled();
});
it("[R2-D25] still rejects an unsafe runtime root without walking it", async () => {
  const input = await fixture();
  await chmod(input.binding.runtimeRoot, 0o777);
  await expect(verifySandboxHost(input)).rejects.toThrow("SANDBOX_HOST_PATH_UNSAFE");
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
it.each(["host", "os", "root", "symlink", "writable"])("rejects changed %s", async (mode) => {
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
  await expect(verifySandboxHost(input)).rejects.toThrow(/SANDBOX_HOST/);
});

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
  await writeFile(path.join(root.canonicalPath, "archive/a.txt"), "later edit");
  expect(await journal.recover()).toEqual(proof);
  expect(await readFile(path.join(root.canonicalPath, "archive/a.txt"), "utf8")).toBe("later edit");
  await unlink(path.join(privateDirectory, "directory-move-verified.json"));
  expect(await journal.recover()).toEqual(proof);
  await rename(
    path.join(root.canonicalPath, "archive"),
    path.join(root.canonicalPath, "moved-again"),
  );
  await mkdir(path.join(root.canonicalPath, "archive"));
  await expect(journal.recover()).rejects.toThrow("RESULT_UNKNOWN");
});

it("claims only the authenticated private copy and rejects arbitrary or replaced directories", async () => {
  const input = await fixture();
  const copyPath = path.join(
    input.binding.privateRoot,
    "workspace-copies",
    "copy-abcdef",
    "source",
  );
  await mkdir(copyPath, { recursive: true, mode: 0o700 });
  const info = await stat(copyPath);
  const scope = sandboxScopeSchema.parse({
    ...scopeFor(input),
    operation: "bash",
    workspaceCopy: {
      canonicalRootId: "workspace-copy:fixture",
      canonicalPath: copyPath,
      device: String(info.dev),
      inode: String(info.ino),
    },
  });
  const claim = await resolveSandboxWorkspaceClaim({ ...input, scope });
  expect(claim.access).toBe("write");
  expect(claim.canonicalRootId).toBe("workspace-copy:fixture");
  expect(claim.lineage.at(-1)).toEqual({ device: String(info.dev), inode: String(info.ino) });
  const copy = scope.workspaceCopy;
  const source = input.binding.roots[0];
  if (!copy || !source) throw new Error("Copy fixture root missing");
  await expect(
    resolveSandboxWorkspaceClaim({
      ...input,
      scope: {
        ...scope,
        workspaceCopy: {
          ...copy,
          canonicalPath: source.canonicalPath,
        },
      },
    }),
  ).rejects.toThrow("COPY_ROOT_INVALID");
  await rename(copyPath, copyPath + "-old");
  await mkdir(copyPath, { mode: 0o700 });
  await expect(resolveSandboxWorkspaceClaim({ ...input, scope })).rejects.toThrow(
    "COPY_ROOT_CHANGED",
  );
});

it("reuses the persisted fingerprint cache and falls back to a full hash when the cache lies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-cache-fallback-"));
  const runtime = await realpath(root);
  await chmod(runtime, 0o700);
  const cacheFile = path.join(runtime, "..", `${path.basename(runtime)}.fingerprints.json`);
  await writeFile(path.join(runtime, "a"), "alpha", { mode: 0o600 });
  await writeFile(path.join(runtime, "b"), "bravo", { mode: 0o600 });
  vi.stubEnv("HIMAWARI_RUNTIME_FINGERPRINT_FILE", cacheFile);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const expected = await digestSandboxRuntime(runtime);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(await digestSandboxRuntime(runtime, expected)).toBe(expected);
    expect(await digestSandboxRuntime(runtime, expected)).toBe(expected);
    const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.at(-1)).toMatchObject({ reused: 2, hashed: 0, retriedWithoutCache: false });
    const stored = JSON.parse(await readFile(cacheFile, "utf8"));
    stored.files.a.sha256 = "0".repeat(64);
    await writeFile(cacheFile, JSON.stringify(stored), { mode: 0o600 });
    expect(await digestSandboxRuntime(runtime, expected)).toBe(expected);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      retriedWithoutCache: true,
      reused: 0,
      hashed: 2,
    });
    await writeFile(path.join(runtime, "a"), "ALPHA", { mode: 0o600 });
    expect(await digestSandboxRuntime(runtime, expected)).not.toBe(expected);
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    await rm(runtime, { recursive: true, force: true });
    await rm(cacheFile, { force: true });
  }
}, 20_000);

it("keeps the trusted fingerprint file beside the root-owned protection record and stages writes under HOME", () => {
  vi.stubEnv(
    "HIMAWARI_RUNTIME_PROTECTION_FILE",
    "/opt/himawari/operations/x/runtime-protection.json",
  );
  vi.stubEnv("HOME", "/var/lib/himawari/state");
  try {
    const root = "/opt/himawari/releases/r1/lib/himawari-agent";
    const location = runtimeFingerprintLocation(root);
    expect(location).toMatchObject({
      fingerprintFile: "/opt/himawari/operations/x/runtime-fingerprints.json",
      trustedUid: 0,
    });
    expect(location.fingerprintWriteFile).toMatch(
      /^\/var\/lib\/himawari\/state\/cache\/runtime-fingerprints-[a-f0-9]{16}\.json$/,
    );
    expect(runtimeFingerprintLocation(root)).toEqual(location);
    expect(runtimeFingerprintLocation(`${root}2`).fingerprintWriteFile).not.toBe(
      location.fingerprintWriteFile,
    );
    vi.stubEnv("HIMAWARI_RUNTIME_PROTECTION_FILE", "");
    expect(runtimeFingerprintLocation(root)).toEqual({});
  } finally {
    vi.unstubAllEnvs();
  }
});

it("reuses the cache file a publish step wrote once it is made readable", async () => {
  const operations = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-published-ops-")));
  const runtime = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-published-root-")));
  await chmod(runtime, 0o755);
  await writeFile(path.join(runtime, "a"), "alpha", { mode: 0o644 });
  await writeFile(path.join(runtime, "b"), "bravo", { mode: 0o644 });
  const published = path.join(operations, "runtime-fingerprints.json");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    vi.stubEnv("HIMAWARI_RUNTIME_FINGERPRINT_FILE", published);
    const expected = await digestSandboxRuntime(runtime);
    await chmod(published, 0o644);
    expect(await digestSandboxRuntime(runtime, expected)).toBe(expected);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      reused: 2,
      hashed: 0,
      retriedWithoutCache: false,
    });
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    await Promise.all(
      [operations, runtime].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
}, 20_000);

it("stops the digest worker when the caller aborts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-digest-abort-"));
  const runtime = await realpath(root);
  await chmod(runtime, 0o700);
  await writeFile(path.join(runtime, "a"), "alpha", { mode: 0o600 });
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(digestSandboxRuntime(runtime, undefined, controller.signal)).rejects.toThrow(
      "SANDBOX_HOST_DIGEST_ABORTED",
    );
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});
