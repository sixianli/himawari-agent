import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { release } from "node:os";
import { Worker } from "node:worker_threads";
import path from "node:path";
import type { SandboxWorkspaceClaim } from "@himawari-agent/application";
import {
  assertSandboxExecutionSupport,
  sandboxFileTargetSchema,
  type SandboxFileTarget,
  type SandboxExecutionPlan,
  type SandboxExecutionPlanCandidate,
  type SandboxExecutionPlanCandidateV2,
  type SandboxExecutionPlanV2,
  type SandboxHostBinding,
  type SandboxRuntimeQualification,
  type SandboxScope,
  sandboxExecutionPlanCandidateSchema,
  sandboxExecutionPlanCandidateV2Schema,
  sandboxExecutionPlanSchema,
  sandboxExecutionPlanV2Schema,
  sandboxHostBindingSchema,
  sandboxRuntimeQualificationSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import { digestRegularFile } from "./artifact-verifier.js";
import { verifyProtectedRuntime } from "./protected-runtime.js";
import type { SandboxRuntimeDigestRequest } from "./sandbox-runtime-digest-worker.js";

/** Same path/hash/size/mode digest as the installation artifact inventory.
 * Read the actual closure, including SRT helper files; a manifest hash alone
 * cannot establish that installed executable code is unchanged. */
export async function digestSandboxRuntime(root: string): Promise<string> {
  return (await auditSandboxRuntime(root)).digest;
}

function inspectSandboxRuntime(
  request: SandboxRuntimeDigestRequest,
): Promise<{ digest?: string; fingerprint: string }> {
  // Source checkout uses Node's native TypeScript erasure; packaged code uses
  // the compiled sibling. This keeps the same verifier in tests and releases.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(`./sandbox-runtime-digest-worker.${extension}`, import.meta.url),
      { workerData: request },
    );
    let received = false;
    worker.once("message", (value: unknown) => {
      const result = value as { digest?: unknown; fingerprint?: unknown } | null;
      if (
        typeof result?.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(result.fingerprint) ||
        (request.mode === "digest"
          ? typeof result.digest !== "string" || !/^[a-f0-9]{64}$/.test(result.digest)
          : result.digest !== undefined)
      ) {
        reject(new Error("SANDBOX_HOST_DIGEST_INVALID"));
        return;
      }
      received = true;
      resolve(result as { digest?: string; fingerprint: string });
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`SANDBOX_HOST_DIGEST_WORKER_EXIT:${code}`));
    });
  });
}

async function auditSandboxRuntime(root: string) {
  const result = await inspectSandboxRuntime({ root, mode: "digest" });
  return { digest: result.digest as string, fingerprint: result.fingerprint };
}

const runtimeAudits = new Map<string, string>();
async function unprotectedRuntimeMatches(root: string, expected: string): Promise<boolean> {
  const key = `${root}\0${expected}`;
  const audited = runtimeAudits.get(key);
  if (
    audited !== undefined &&
    (await inspectSandboxRuntime({ root, mode: "fingerprint" })).fingerprint === audited
  )
    return true;
  runtimeAudits.delete(key);
  const { digest, fingerprint } = await auditSandboxRuntime(root);
  if (digest !== expected) return false;
  runtimeAudits.set(key, fingerprint);
  return true;
}

async function checkedPath(filename: string, directory: boolean) {
  if (
    !path.isAbsolute(filename) ||
    path.normalize(filename) !== filename ||
    (await realpath(filename)) !== filename
  )
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  return checkedMetadata(filename, directory);
}
async function checkedMetadata(filename: string, directory: boolean) {
  const info = await lstat(filename);
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0)
  )
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  return info;
}

/** The binding/qualification must originate in the verified deployment snapshot.
 * This checks live host identity and bytes, and never issues a qualification or
 * treats inventory roots/domains as execution authority. Mutable installations
 * are audited per call; protected installations retain a process-local initial
 * audit only while administrator-owned deployment identity remains unchanged. */
export async function verifySandboxHost(input: {
  readonly binding: SandboxHostBinding;
  readonly qualification: SandboxRuntimeQualification;
  readonly hostId: string;
  readonly plan?:
    | SandboxExecutionPlanCandidate
    | SandboxExecutionPlan
    | SandboxExecutionPlanCandidateV2
    | SandboxExecutionPlanV2;
}): Promise<void> {
  const binding = sandboxHostBindingSchema.parse(input.binding);
  const qualification = sandboxRuntimeQualificationSchema.parse(input.qualification);
  const plan =
    input.plan === undefined
      ? undefined
      : input.plan.schemaVersion === "sandbox-execution.v2"
        ? "semanticFingerprint" in input.plan
          ? sandboxExecutionPlanV2Schema.parse(input.plan)
          : sandboxExecutionPlanCandidateV2Schema.parse(input.plan)
        : "semanticFingerprint" in input.plan
          ? sandboxExecutionPlanSchema.parse(input.plan)
          : sandboxExecutionPlanCandidateSchema.parse(input.plan);
  if (plan) {
    const legacy = [{ schemaVersion: "sandbox-execution.v1", mode: "foreground" }] as const;
    const declared = (value: typeof binding.supportedExecutions) =>
      value ?? (plan.schemaVersion === "sandbox-execution.v1" ? legacy : undefined);
    assertSandboxExecutionSupport(
      {
        schemaVersion: plan.schemaVersion,
        mode: plan.schemaVersion === "sandbox-execution.v2" ? plan.mode : "foreground",
      },
      [declared(binding.supportedExecutions), declared(qualification.supportedExecutions)],
    );
  }
  if (
    binding.hostId !== input.hostId ||
    qualification.hostId !== input.hostId ||
    qualification.platform !== process.platform ||
    qualification.architecture !== process.arch ||
    qualification.osRelease !== release() ||
    qualification.profileRef !== binding.profileRef ||
    qualification.runtimeDigest !== binding.runtimeDigest ||
    qualification.runnerDigest !== binding.runner.sha256
  )
    throw new Error("SANDBOX_HOST_QUALIFICATION_CHANGED");
  if (
    plan &&
    (plan.identity.hostId !== input.hostId ||
      plan.capabilityRef !== binding.capabilityRef ||
      plan.capabilityVersion !== binding.capabilityVersion ||
      plan.binding.profileRef !== binding.profileRef ||
      plan.binding.runtimeDigest !== binding.runtimeDigest ||
      plan.binding.runnerDigest !== binding.runner.sha256 ||
      plan.binding.qualificationRef !== qualification.qualificationRef ||
      plan.binding.requiredGuarantees.some(
        (item) => !qualification.guarantees.some((value) => value === item),
      ) ||
      Object.entries(plan.resourceCeiling).some(
        ([key, value]) =>
          value >
          binding.maximumResourceCeiling[key as keyof typeof binding.maximumResourceCeiling],
      ))
  )
    throw new Error("SANDBOX_HOST_PLAN_CHANGED");
  await checkedPath(binding.privateRoot, true);
  for (const root of binding.roots) {
    const current = await checkedPath(root.canonicalPath, true);
    if (String(current.dev) !== root.device || String(current.ino) !== root.inode)
      throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  }
  for (const filename of binding.readOnlyToolchainPaths) {
    const info = await lstat(filename);
    await checkedPath(filename, info.isDirectory());
  }
  await checkedPath(binding.executable.path, false);
  await checkedPath(binding.runner.path, false);
  if (
    await verifyProtectedRuntime(binding.runtimeRoot, binding.runtimeDigest, digestSandboxRuntime, [
      binding.executable,
      binding.runner,
    ])
  )
    return;
  if (
    (await digestRegularFile(binding.executable.path)) !== `sha256:${binding.executable.sha256}` ||
    (await digestRegularFile(binding.runner.path)) !== `sha256:${binding.runner.sha256}` ||
    !(await unprotectedRuntimeMatches(binding.runtimeRoot, binding.runtimeDigest))
  )
    throw new Error("SANDBOX_HOST_ARTIFACT_CHANGED");
}

/** Current host directory identities for R2 occupancy. Scope must already have
 * passed the existing directory/Grant/parent checks; inventory never grants access. */
/** Resolve only an authenticated scope under this host's private copy store.
 * No model path, arbitrary private directory, or source grant can select this root. */
export async function resolveSandboxWorkspaceRoot(input: {
  readonly binding: SandboxHostBinding;
  readonly scope: SandboxScope;
}) {
  const { binding, scope } = input;
  if (!scope.workspaceCopy)
    return binding.roots.find(
      (root) => root.canonicalRootId === scope.directoryGrant.canonicalRootId,
    );
  const root = scope.workspaceCopy;
  const manager = path.dirname(root.canonicalPath);
  if (
    scope.operation !== "bash" ||
    scope.directoryGrant.operations.join() !== "read" ||
    !root.canonicalRootId.startsWith("workspace-copy:") ||
    path.dirname(manager) !== path.join(binding.privateRoot, "workspace-copies") ||
    path.basename(root.canonicalPath) !== "source" ||
    !/^[A-Za-z0-9._:-]+-[A-Za-z0-9]+$/.test(path.basename(manager)) ||
    !binding.roots.some((item) => item.canonicalRootId === scope.directoryGrant.canonicalRootId)
  )
    throw new Error("SANDBOX_COPY_ROOT_INVALID");
  await checkedPath(manager, true);
  const info = await checkedPath(root.canonicalPath, true);
  if (String(info.dev) !== root.device || String(info.ino) !== root.inode)
    throw new Error("SANDBOX_COPY_ROOT_CHANGED");
  return root;
}

export async function resolveSandboxWorkspaceClaim(input: {
  readonly binding: SandboxHostBinding;
  readonly scope: SandboxScope;
}): Promise<SandboxWorkspaceClaim> {
  const binding = sandboxHostBindingSchema.parse(input.binding);
  const scope = sandboxScopeSchema.parse(input.scope);
  const root = await resolveSandboxWorkspaceRoot({ binding, scope });
  if (
    !root ||
    scope.hostId !== binding.hostId ||
    scope.profileRef !== binding.profileRef ||
    scope.directoryGrant.operations.length === 0
  )
    throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  const before = await checkedPath(root.canonicalPath, true);
  if (String(before.dev) !== root.device || String(before.ino) !== root.inode)
    throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  const paths: string[] = [];
  for (let current = root.canonicalPath; ; current = path.dirname(current)) {
    paths.unshift(current);
    if (path.dirname(current) === current) break;
  }
  const metadata = await Promise.all(
    paths.map(async (filename) => {
      const info = await lstat(filename, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SANDBOX_HOST_PATH_UNSAFE");
      return info;
    }),
  );
  const after = await checkedPath(root.canonicalPath, true);
  if (before.dev !== after.dev || before.ino !== after.ino)
    throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  for (let index = 0; index < paths.length; index++) {
    const filename = paths[index];
    const prior = metadata[index];
    if (!filename || !prior) throw new Error("SANDBOX_HOST_ROOT_CHANGED");
    const current = await lstat(filename, { bigint: true });
    if (current.dev !== prior.dev || current.ino !== prior.ino || !current.isDirectory())
      throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  }
  return Object.freeze({
    ref: `workspace:${createHash("sha256")
      .update(JSON.stringify([binding.hostId, scope.directoryGrant.ref, root.canonicalRootId]))
      .digest("hex")}`,
    hostId: binding.hostId,
    canonicalRootId: root.canonicalRootId,
    access:
      !scope.workspaceCopy &&
      scope.directoryGrant.operations.every((operation) => operation === "read")
        ? "read"
        : "write",
    lineage: Object.freeze(
      metadata.map((info) => Object.freeze({ device: String(info.dev), inode: String(info.ino) })),
    ),
  });
}

/** Exact-file coordination for the installed fixed-target Operations contract.
 * Missing parents retain directory coverage until a parent-creation protocol is
 * available. Neither this resolver nor a model annotation grants filesystem I/O. */
export async function resolveSandboxFileScope(input: {
  readonly binding: SandboxHostBinding;
  readonly scope: SandboxScope;
  readonly relativePath: string;
  readonly access: "read" | "write";
}): Promise<{ readonly claim: SandboxWorkspaceClaim; readonly target: SandboxFileTarget }> {
  input = {
    binding: sandboxHostBindingSchema.parse(input.binding),
    scope: sandboxScopeSchema.parse(input.scope),
    relativePath: input.relativePath,
    access: input.access,
  };
  if (
    !["read", "write"].includes(input.access) ||
    (input.access === "read" && !input.scope.directoryGrant.operations.includes("read"))
  )
    throw new Error("SANDBOX_FILE_ACCESS_DENIED");
  const directory = await resolveSandboxWorkspaceClaim(input);
  const root = input.binding.roots.find(
    (item) => item.canonicalRootId === directory.canonicalRootId,
  );
  const parts = input.relativePath.split("/");
  if (
    !root ||
    path.isAbsolute(input.relativePath) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part === ".env" ||
        part.startsWith(".himawari-") ||
        Array.from(part).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  if (input.access === "write" && directory.access !== "write")
    throw new Error("SANDBOX_FILE_ACCESS_DENIED");
  const lineage = [...directory.lineage];
  const parents: { path: string; device: string; inode: string }[] = [];
  let current = root.canonicalPath;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const info = await lstat(current, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info)
      return {
        claim: directory,
        target: sandboxFileTargetSchema.parse({
          schemaVersion: "sandbox-file-target.v1",
          relativePath: input.relativePath,
          lineage: lineage.slice(directory.lineage.length - 1),
          before: null,
          missingParents: parts.length - 1 - parents.length,
        }),
      };
    if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== root.device)
      throw new Error("SANDBOX_HOST_PATH_UNSAFE");
    const identity = { device: String(info.dev), inode: String(info.ino) };
    parents.push({ path: current, ...identity });
    lineage.push(identity);
  }
  const name = parts.at(-1);
  if (!name || Buffer.byteLength(name) > 255) throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  const target = path.join(current, name);
  const info = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    info &&
    (!info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      String(info.dev) !== root.device)
  )
    throw new Error("SANDBOX_HOST_FILE_UNSAFE");
  let versionDigest: string | undefined;
  if (info) {
    if (!input.scope.directoryGrant.operations.includes("read") || info.size > 16n * 1024n * 1024n)
      throw new Error("SANDBOX_HOST_FILE_UNSAFE");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        before.size !== info.size ||
        before.mtimeNs !== info.mtimeNs ||
        before.ctimeNs !== info.ctimeNs ||
        before.nlink !== 1n
      )
        throw new Error("SANDBOX_FILE_VERSION_CHANGED");
      const bytes = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < bytes.length; ) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("SANDBOX_FILE_VERSION_CHANGED");
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await lstat(target, { bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.nlink !== 1n
      )
        throw new Error("SANDBOX_FILE_VERSION_CHANGED");
      versionDigest = createHash("sha256").update(bytes).digest("hex");
    } finally {
      await handle.close();
    }
  }
  const fresh = await resolveSandboxWorkspaceClaim(input);
  if (JSON.stringify(fresh.lineage) !== JSON.stringify(directory.lineage))
    throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  for (const parent of parents) {
    const after = await lstat(parent.path, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      String(after.dev) !== parent.device ||
      String(after.ino) !== parent.inode
    )
      throw new Error("SANDBOX_HOST_PATH_CHANGED");
  }
  const slotName = name.normalize("NFC").toLowerCase();
  const claim = Object.freeze({
    ...directory,
    ref: `workspace:${createHash("sha256")
      .update(JSON.stringify([input.binding.hostId, lineage.at(-1), slotName]))
      .digest("hex")}`,
    access: input.access,
    lineage: Object.freeze(lineage),
    file: Object.freeze({
      name: slotName,
      identity: info ? { device: String(info.dev), inode: String(info.ino) } : null,
      atomicPublish: input.access === "write",
      ...(versionDigest === undefined ? {} : { versionDigest }),
    }),
  });
  return {
    claim,
    target: sandboxFileTargetSchema.parse({
      schemaVersion: "sandbox-file-target.v1",
      relativePath: input.relativePath,
      lineage: lineage.slice(directory.lineage.length - 1),
      before: claim.file.identity ? { ...claim.file.identity, contentDigest: versionDigest } : null,
    }),
  };
}
export async function resolveSandboxFileWorkspaceClaim(
  input: Parameters<typeof resolveSandboxFileScope>[0],
): Promise<SandboxWorkspaceClaim> {
  return (await resolveSandboxFileScope(input)).claim;
}
