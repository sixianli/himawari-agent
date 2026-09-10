import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import type { SandboxWorkspaceClaim } from "@himawari-agent/application";
import {
  assertSandboxExecutionSupport,
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

/** Same path/hash/size/mode digest as the installation artifact inventory.
 * Read the actual closure, including SRT helper files; a manifest hash alone
 * cannot establish that installed executable code is unchanged. */
export async function digestSandboxRuntime(root: string): Promise<string> {
  const files: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const visit = async (directory: string, prefix: string) => {
    const before = await checkedPath(directory, true);
    const entries = await readdir(directory, { withFileTypes: true });
    // Bound concurrent file reads across the entire walk: directories remain
    // sequential. Verify every byte and the same before/after metadata without
    // turning filesystem latency into one round trip per file.
    const leaves = entries.filter((entry) => !entry.isDirectory());
    for (let offset = 0; offset < leaves.length; offset += 8) {
      await Promise.all(
        leaves.slice(offset, offset + 8).map(async (entry) => {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          const filename = path.join(directory, entry.name);
          const metadata = await checkedPath(filename, false);
          const sha256 = (await digestRegularFile(filename)).slice(7);
          const after = await checkedPath(filename, false);
          if (!sameFile(metadata, after)) throw new Error("SANDBOX_HOST_CHANGED");
          files.push({ path: relative, sha256, bytes: metadata.size, mode: metadata.mode & 0o777 });
        }),
      );
    }
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      await visit(
        path.join(directory, entry.name),
        prefix ? `${prefix}/${entry.name}` : entry.name,
      );
    }
    if (!sameFile(before, await checkedPath(directory, true)))
      throw new Error("SANDBOX_HOST_CHANGED");
  };
  await visit(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

async function checkedPath(filename: string, directory: boolean) {
  if (
    !path.isAbsolute(filename) ||
    path.normalize(filename) !== filename ||
    (await realpath(filename)) !== filename
  )
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  const info = await lstat(filename);
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0)
  )
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  return info;
}
function sameFile(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/** The binding/qualification must originate in the verified deployment snapshot.
 * This checks live host identity and bytes, and never issues a qualification or
 * treats inventory roots/domains as execution authority. Do not cache across jobs. */
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
    (await digestRegularFile(binding.executable.path)) !== `sha256:${binding.executable.sha256}` ||
    (await digestRegularFile(binding.runner.path)) !== `sha256:${binding.runner.sha256}` ||
    (await digestSandboxRuntime(binding.runtimeRoot)) !== binding.runtimeDigest
  )
    throw new Error("SANDBOX_HOST_ARTIFACT_CHANGED");
}

/** Current host directory identities for R2 occupancy. Scope must already have
 * passed the existing directory/Grant/parent checks; inventory never grants access. */
export async function resolveSandboxWorkspaceClaim(input: {
  readonly binding: SandboxHostBinding;
  readonly scope: SandboxScope;
}): Promise<SandboxWorkspaceClaim> {
  const binding = sandboxHostBindingSchema.parse(input.binding);
  const scope = sandboxScopeSchema.parse(input.scope);
  const root = binding.roots.find(
    (item) => item.canonicalRootId === scope.directoryGrant.canonicalRootId,
  );
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
    access: scope.directoryGrant.operations.every((operation) => operation === "read")
      ? "read"
      : "write",
    lineage: Object.freeze(
      metadata.map((info) => Object.freeze({ device: String(info.dev), inode: String(info.ino) })),
    ),
  });
}
