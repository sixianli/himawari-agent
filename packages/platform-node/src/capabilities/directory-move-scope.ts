import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath, type SandboxWorkspaceClaim } from "@himawari-agent/application";
import {
  relativeFilePath,
  type SandboxDirectoryMove,
  type SandboxHostBinding,
  type SandboxScope,
  sandboxDirectoryMoveSchema,
} from "@himawari-agent/execution-contracts";
import { resolveSandboxWorkspaceClaim } from "./sandbox-host-verifier.js";

/** Resolve actual host identities, never accept a model-provided resource list. */
export async function resolveSandboxDirectoryMoveScope(input: {
  readonly binding: SandboxHostBinding;
  readonly scope: SandboxScope;
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
}): Promise<{
  readonly claims: readonly SandboxWorkspaceClaim[];
  readonly target: SandboxDirectoryMove;
}> {
  const scope = structuredClone(input.scope);
  if (scope.operation !== "move_directory" || !scope.directoryGrant.operations.includes("move"))
    throw new Error("SANDBOX_DIRECTORY_MOVE_DENIED");
  const source = normalizeRelativePath(input.sourceRelativePath);
  const destination = normalizeRelativePath(input.destinationRelativePath);
  relativeFilePath.parse(source);
  relativeFilePath.parse(destination);
  if (source === destination || destination.startsWith(`${source}/`))
    throw new Error("SANDBOX_DIRECTORY_MOVE_PATH_INVALID");
  const directory = await resolveSandboxWorkspaceClaim(input);
  const root = input.binding.roots.find(
    (item) => item.canonicalRootId === directory.canonicalRootId,
  );
  if (!root) throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  const observations: { filename: string; device: string; inode: string }[] = [];
  const parents = async (relative: string, includeTarget: boolean) => {
    const result = [...directory.lineage];
    let filename = root.canonicalPath;
    const parts = relative.split("/");
    for (const part of includeTarget ? parts : parts.slice(0, -1)) {
      filename = path.join(filename, part);
      const info = await lstat(filename);
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== root.device)
        throw new Error("SANDBOX_HOST_PATH_CHANGED");
      const identity = { device: String(info.dev), inode: String(info.ino) };
      result.push(identity);
      observations.push({ filename, ...identity });
    }
    return result;
  };
  const sourceChain = await parents(source, true);
  const destinationChain = await parents(destination, false);
  const existing = await lstat(path.join(root.canonicalPath, destination)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing) throw new Error("HOST_FILE_TARGET_EXISTS");
  for (const observed of observations) {
    const info = await lstat(observed.filename);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      String(info.dev) !== observed.device ||
      String(info.ino) !== observed.inode
    )
      throw new Error("SANDBOX_HOST_PATH_CHANGED");
  }
  const fresh = await resolveSandboxWorkspaceClaim(input);
  if (JSON.stringify(fresh.lineage) !== JSON.stringify(directory.lineage))
    throw new Error("SANDBOX_HOST_ROOT_CHANGED");
  const sourceIdentity = sourceChain.at(-1);
  if (!sourceIdentity) throw new Error("SANDBOX_HOST_PATH_CHANGED");
  const ref = (value: unknown) =>
    `workspace:${createHash("sha256")
      .update(JSON.stringify([directory.hostId, value]))
      .digest("hex")}`;
  const slot = (
    relative: string,
    lineage: SandboxWorkspaceClaim["lineage"],
    identity: typeof sourceIdentity | null,
  ): SandboxWorkspaceClaim => {
    const name = relative.split("/").at(-1)?.normalize("NFC").toLowerCase();
    if (!name) throw new Error("SANDBOX_DIRECTORY_MOVE_PATH_INVALID");
    return {
      ...directory,
      ref: ref([lineage.at(-1), name]),
      access: "write",
      lineage,
      file: { name, identity, atomicPublish: false },
    };
  };
  return {
    claims: [
      {
        ...directory,
        ref: ref([sourceIdentity, "directory"]),
        access: "write" as const,
        lineage: sourceChain,
      },
      slot(source, sourceChain.slice(0, -1), sourceIdentity),
      slot(destination, destinationChain, null),
    ].sort((a, b) => a.ref.localeCompare(b.ref)),
    target: sandboxDirectoryMoveSchema.parse({
      schemaVersion: "sandbox-directory-move.v1",
      sourceRelativePath: source,
      destinationRelativePath: destination,
      sourceIdentity,
      sourceLineage: sourceChain.slice(directory.lineage.length - 1),
      destinationLineage: destinationChain.slice(directory.lineage.length - 1),
    }),
  };
}
