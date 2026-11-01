import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { release } from "node:os";
import { performance } from "node:perf_hooks";
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
import { verifyProtectedRuntime } from "./protected-runtime.js";
import type { SandboxRuntimeDigestRequest } from "./sandbox-runtime-digest-worker.js";

export interface SandboxRuntimeDigestResult {
  readonly digest: string;
  readonly reused: number;
  readonly hashed: number;
}

export interface RuntimeFingerprintLocation {
  readonly fingerprintFile?: string;
  readonly fingerprintWriteFile?: string;
  readonly trustedUid?: number;
}

export function runtimeFingerprintLocation(root: string): RuntimeFingerprintLocation {
  const configured = process.env["HIMAWARI_RUNTIME_FINGERPRINT_FILE"];
  if (configured && path.isAbsolute(configured))
    return { fingerprintFile: configured, trustedUid: process.getuid?.() ?? 0 };
  const protection = process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  if (!protection || !path.isAbsolute(protection)) return {};
  const home = process.env["HOME"];
  const token = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return {
    fingerprintFile: path.join(path.dirname(protection), "runtime-fingerprints.json"),
    ...(home && path.isAbsolute(home)
      ? { fingerprintWriteFile: path.join(home, "cache", `runtime-fingerprints-${token}.json`) }
      : {}),
    trustedUid: 0,
  };
}

function runDigestWorker(
  request: SandboxRuntimeDigestRequest,
  signal?: AbortSignal,
): Promise<SandboxRuntimeDigestResult> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(`./sandbox-runtime-digest-worker.${extension}`, import.meta.url),
      { workerData: request },
    );
    let received = false;
    const stop = () => {
      void worker.terminate();
      reject(new Error("SANDBOX_HOST_DIGEST_ABORTED"));
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    worker.once("message", (value: unknown) => {
      const result = value as Partial<SandboxRuntimeDigestResult> | null;
      if (typeof result?.digest !== "string" || !/^[a-f0-9]{64}$/.test(result.digest)) {
        reject(new Error("SANDBOX_HOST_DIGEST_INVALID"));
        return;
      }
      received = true;
      resolve({
        digest: result.digest,
        reused: Number(result.reused ?? 0),
        hashed: Number(result.hashed ?? 0),
      });
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", stop);
      if (!received) reject(new Error(`SANDBOX_HOST_DIGEST_WORKER_EXIT:${code}`));
    });
  });
}

export async function digestSandboxRuntime(
  root: string,
  expectedDigest?: string,
  signal?: AbortSignal,
): Promise<string> {
  const location = runtimeFingerprintLocation(root);
  const startedAt = performance.now();
  let result = await runDigestWorker({ root, ...location }, signal);
  let retried = false;
  if (
    location.fingerprintFile &&
    expectedDigest !== undefined &&
    result.digest !== expectedDigest &&
    result.reused > 0
  ) {
    retried = true;
    result = await runDigestWorker({ root, ...location, rebuild: true }, signal);
  }
  console.error(
    JSON.stringify({
      component: "platform-node",
      event: "sandbox_runtime.digest_completed",
      reused: result.reused,
      hashed: result.hashed,
      retriedWithoutCache: retried,
      durationMs: Math.round(performance.now() - startedAt),
    }),
  );
  return result.digest;
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

export interface SandboxHostVerificationInput {
  readonly binding: SandboxHostBinding;
  readonly qualification: SandboxRuntimeQualification;
  readonly hostId: string;
  readonly plan?:
    | SandboxExecutionPlanCandidate
    | SandboxExecutionPlan
    | SandboxExecutionPlanCandidateV2
    | SandboxExecutionPlanV2;
}

export async function verifySandboxHost(
  input: SandboxHostVerificationInput,
  options: { readonly deferContentAudit?: boolean } = {},
): Promise<void> {
  await verifySandboxHostFiles(assertSandboxHostPlan(input), options);
}

function assertSandboxHostPlan(input: SandboxHostVerificationInput): SandboxHostBinding {
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
  return binding;
}

async function verifySandboxHostFiles(
  binding: SandboxHostBinding,
  options: { readonly deferContentAudit?: boolean } = {},
): Promise<void> {
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
  await checkedPath(binding.runtimeRoot, true);
  await checkedPath(binding.executable.path, false);
  await checkedPath(binding.runner.path, false);
  await verifyProtectedRuntime(
    binding.runtimeRoot,
    binding.runtimeDigest,
    (root, signal) => digestSandboxRuntime(root, binding.runtimeDigest, signal),
    [binding.executable, binding.runner],
    options,
  );
}

export function createReusingSandboxHostVerifier(options: {
  readonly reuseMs: number;
  readonly settleMs?: number;
  readonly now?: () => number;
  readonly wallClockMs?: () => number;
}): (input: SandboxHostVerificationInput) => Promise<void> {
  const now = options.now ?? (() => performance.now());
  const wallClockMs = options.wallClockMs ?? (() => Date.now());
  const settleMs = options.settleMs ?? 2_000;
  const verified = new Map<string, number>();
  return async (input) => {
    const binding = assertSandboxHostPlan(input);
    const before = await sandboxHostFileState(binding);
    const checkedAt = now();
    for (const [key, at] of verified)
      if (!(checkedAt >= at && checkedAt - at < options.reuseMs)) verified.delete(key);
    if (verified.has(before.key)) return;
    const startedAtWallMs = wallClockMs();
    await verifySandboxHostFiles(binding);
    const after = await sandboxHostFileState(binding);
    if (after.key === before.key && startedAtWallMs - after.newestFileChangeMs >= settleMs)
      verified.set(before.key, checkedAt);
  };
}

async function sandboxHostFileState(
  binding: SandboxHostBinding,
): Promise<{ readonly key: string; readonly newestFileChangeMs: number }> {
  const protection = process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  const paths = [
    binding.privateRoot,
    ...binding.roots.map((root) => root.canonicalPath),
    ...binding.readOnlyToolchainPaths,
    binding.runtimeRoot,
    binding.executable.path,
    binding.runner.path,
    ...(protection === undefined ? [] : [protection]),
  ];
  const states = await Promise.all(
    paths.map(async (filename) => {
      const info = await lstat(filename, { bigint: true });
      const file = info.isFile();
      return {
        line: [
          filename,
          info.dev,
          info.ino,
          info.mode,
          info.uid,
          ...(file ? [info.size, info.mtimeNs, info.ctimeNs] : []),
        ].join(":"),
        changedMs: file
          ? Number(info.ctimeNs > info.mtimeNs ? info.ctimeNs : info.mtimeNs) / 1e6
          : 0,
      };
    }),
  );
  return {
    key: createHash("sha256")
      .update(JSON.stringify([binding, protection ?? null]))
      .update(states.map((state) => state.line).join("\n"))
      .digest("hex"),
    newestFileChangeMs: Math.max(0, ...states.map((state) => state.changedMs)),
  };
}

export async function sandboxHostIdentity(input: SandboxHostBinding): Promise<string> {
  const binding = sandboxHostBindingSchema.parse(input);
  const protection = process.env["HIMAWARI_RUNTIME_PROTECTION_FILE"];
  const paths = [
    binding.privateRoot,
    ...binding.roots.map((root) => root.canonicalPath),
    ...binding.readOnlyToolchainPaths,
    binding.runtimeRoot,
    binding.executable.path,
    binding.runner.path,
  ];
  const identities = await Promise.all(
    paths.map(async (filename) => {
      const info = await lstat(filename, { bigint: true });
      return [filename, info.dev, info.ino, info.mode, info.uid].join(":");
    }),
  );
  if (protection !== undefined) {
    const info = await lstat(protection, { bigint: true });
    identities.push([protection, info.dev, info.ino, info.mode, info.uid, info.ctimeNs].join(":"));
  }
  return createHash("sha256").update(identities.join("\n")).digest("hex");
}

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
