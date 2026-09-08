import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { compileSandboxPolicy, type SandboxPolicyInput } from "./policy.ts";

/** Worker-only policy preparation. The existing journal freezes the compiled
 * digest in the first start transaction, before the task can execute. Scratch is private per job;
 * an existing directory is inspected, never chmod'ed or silently replaced. */
export async function prepareJobPolicy(
  value: Omit<SandboxPolicyInput, "privateDirectory"> & {
    readonly privateRoot: string;
    readonly jobId: string;
  },
) {
  const input = structuredClone(value);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.jobId) ||
    !path.isAbsolute(input.privateRoot) ||
    (await realpath(input.privateRoot)) !== input.privateRoot
  )
    throw new Error("SANDBOX_PRIVATE_DIRECTORY_INVALID");
  const privateDirectory = path.join(input.privateRoot, input.jobId);
  try {
    await mkdir(privateDirectory, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
      throw error;
  }
  const metadata = await lstat(privateDirectory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  )
    throw new Error("SANDBOX_PRIVATE_DIRECTORY_INVALID");
  const policy: SandboxPolicyInput = {
    workspace: input.workspace,
    writable: input.writable,
    privateDirectory,
    readOnlyToolchainPaths: [...input.readOnlyToolchainPaths],
    protectedPaths: [...input.protectedPaths],
    allowedDomains: [...input.allowedDomains],
  };
  return { policy, compiled: await compileSandboxPolicy(policy) };
}
