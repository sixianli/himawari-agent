import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getDefaultWritePaths, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

export const SRT_VERSION = "0.0.75" as const;

/** Infrastructure input resolved from protected scope and host inventory, never model arguments.
 * Compilation does not authorize execution or establish platform qualification. */
export interface SandboxPolicyInput {
  readonly workspace: string;
  readonly writable: boolean;
  readonly privateDirectory: string;
  readonly readOnlyToolchainPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly allowedUnixSockets?: readonly string[];
}

export interface CompiledSandboxPolicy {
  readonly version: typeof SRT_VERSION;
  readonly policyJson: string;
  readonly policyDigest: string;
  readonly cwd: string;
  readonly privateDirectory: string;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function literalPath(value: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value === path.parse(value).root ||
    path.normalize(value) !== value ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[*?[\]{}]/u.test(value)
  )
    throw new Error("SRT_POLICY_PATH_INVALID");
  return value;
}

async function canonicalProtectedPath(value: string): Promise<string> {
  literalPath(value);
  let parent = value;
  for (;;) {
    try {
      const canonical = await realpath(parent);
      if (canonical !== parent) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL");
      return value;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      parent = path.dirname(parent);
    }
  }
}

async function canonicalPath(value: string, directory: boolean): Promise<string> {
  literalPath(value);
  if ((await realpath(value)) !== value) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL");
  const metadata = await stat(value);
  if (directory ? !metadata.isDirectory() : !metadata.isDirectory() && !metadata.isFile()) {
    throw new Error("SRT_POLICY_PATH_TYPE_INVALID");
  }
  return value;
}

/** A conservative default-deny candidate. Qualification must verify the compiled policy
 * on the target OS; SRT allowRead alone would not deny access outside the workspace. */
export async function compileSandboxPolicy(
  input: SandboxPolicyInput,
): Promise<CompiledSandboxPolicy> {
  const keys = [
    "workspace",
    "writable",
    "privateDirectory",
    "readOnlyToolchainPaths",
    "protectedPaths",
    "allowedDomains",
    "allowedUnixSockets",
  ];
  if (
    !input ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    typeof input.writable !== "boolean"
  ) {
    throw new Error("SRT_POLICY_INPUT_INVALID");
  }
  if (
    ![input.readOnlyToolchainPaths, input.protectedPaths, input.allowedDomains].every(Array.isArray)
  ) {
    throw new Error("SRT_POLICY_INPUT_INVALID");
  }
  // Copy before the first await: callers cannot change policy during path resolution.
  const workspaceInput = input.workspace;
  const privateInput = input.privateDirectory;
  const writable = input.writable;
  const toolchainInput = [...input.readOnlyToolchainPaths];
  const protectedInput = [...input.protectedPaths];
  const domains = [...input.allowedDomains];
  const sockets = [...(input.allowedUnixSockets ?? [])];
  const workspace = await canonicalPath(workspaceInput, true);
  const privateDirectory = await canonicalPath(privateInput, true);
  if (contains(workspace, privateDirectory) || contains(privateDirectory, workspace)) {
    throw new Error("SRT_POLICY_PRIVATE_DIRECTORY_OVERLAP");
  }
  const toolchains = [
    ...new Set(await Promise.all(toolchainInput.map((entry) => canonicalPath(entry, false)))),
  ].sort();
  const protectedPaths = [
    ...new Set(await Promise.all(protectedInput.map(canonicalProtectedPath))),
  ].sort();
  const allows = [workspace, privateDirectory, ...toolchains];
  for (const protectedPath of protectedPaths) {
    // The root read deny already protects host data outside explicit exceptions.
    // Explicit secret/control paths may not be reopened through an exception.
    if (allows.some((entry) => contains(protectedPath, entry)))
      throw new Error("SRT_POLICY_PROTECTED_PATH_REOPENED");
  }
  if (
    toolchains.some(
      (entry) =>
        contains(workspace, entry) ||
        contains(privateDirectory, entry) ||
        contains(entry, workspace) ||
        contains(entry, privateDirectory),
    )
  ) {
    throw new Error("SRT_POLICY_TOOLCHAIN_OVERLAP");
  }
  for (const domain of domains) {
    // This infrastructure package cannot import product contracts. Independently
    // revalidate the primitive boundary before handing exact host:port rules to SRT.
    const parts = typeof domain === "string" ? domain.split(":") : [];
    const host = parts[0] ?? "";
    const port = parts[1] ?? "";
    if (
      parts.length !== 2 ||
      host.length > 253 ||
      !/^[1-9][0-9]{0,4}$/.test(port) ||
      Number(port) > 65535 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    ) {
      throw new Error("SRT_POLICY_DOMAIN_INVALID");
    }
  }
  if (
    sockets.length > 1 ||
    sockets.some(
      (socket) =>
        !contains(privateDirectory, literalPath(socket)) ||
        path.dirname(socket) !== privateDirectory,
    )
  )
    throw new Error("SRT_POLICY_SOCKET_INVALID");
  const policy = SandboxRuntimeConfigSchema.parse({
    network: {
      allowedDomains: [...new Set(domains)].sort(),
      deniedDomains: [],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowUnixSockets: sockets,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: ["/", ...protectedPaths],
      allowRead: [...new Set(allows)].sort(),
      allowWrite: writable ? [workspace, privateDirectory].sort() : [privateDirectory],
      denyWrite: [
        ...new Set([
          ...protectedPaths,
          // SDK HOME defaults must refer to the Job Host's private HOME in both
          // processes. Do not mutate the parent environment to compile a policy.
          ...getDefaultWritePaths()
            .filter((entry) => !entry.startsWith("/dev/"))
            .map((entry) =>
              contains(homedir(), entry)
                ? path.join(privateDirectory, path.relative(homedir(), entry))
                : entry,
            ),
        ]),
      ].sort(),
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowPty: false,
  });
  const policyJson = JSON.stringify(policy);
  return Object.freeze({
    version: SRT_VERSION,
    policyJson,
    policyDigest: createHash("sha256").update(policyJson).digest("hex"),
    cwd: workspace,
    privateDirectory,
  });
}
