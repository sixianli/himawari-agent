import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import { type SandboxScope, sandboxDirectoryMoveSchema } from "@himawari-agent/execution-contracts";
import { ConstrainedHostFileSystem } from "./constrained-file-system.js";

export interface DirectoryMoveProof {
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
  readonly device: string;
  readonly inode: string;
}
/** The fixed runner owns this private directory. Its receipt binds an inode, not
 * merely a destination name. Recovery is inspection only after resource release. */
export function createDirectoryMoveJournal(input: {
  readonly scope: SandboxScope;
  readonly workspace: string;
  readonly privateDirectory: string;
  readonly directoryRenameExecutable?: string;
}) {
  input = structuredClone(input);
  const target = sandboxDirectoryMoveSchema.parse(input.scope.directoryMove);
  const bindingDigest = createHash("sha256").update(JSON.stringify(input.scope)).digest("hex");
  const platform = new ConstrainedHostFileSystem(
    input.directoryRenameExecutable
      ? { directoryRenameExecutable: input.directoryRenameExecutable }
      : {},
  );
  const grant: HostDirectoryGrant = {
    id: input.scope.directoryGrant.ref,
    revision: input.scope.directoryGrant.revision,
    hostId: input.scope.hostId,
    canonicalRootId: input.scope.directoryGrant.canonicalRootId,
    displayPath: input.workspace,
    operations: input.scope.directoryGrant.operations,
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: input.scope.directoryGrant.authorizationRef,
    expiresAt: input.scope.expiresAt,
    revokedAt: null,
  };
  const proof: DirectoryMoveProof = {
    sourceRelativePath: target.sourceRelativePath,
    destinationRelativePath: target.destinationRelativePath,
    ...target.sourceIdentity,
  };
  const parent = async () => {
    const stat = await lstat(input.privateDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("HOST_DIRECTORY_JOURNAL_UNSAFE");
    return `${stat.dev}:${stat.ino}`;
  };
  const read = async (kind: "intent" | "verified") => {
    const before = await parent();
    const fd = await open(
      path.join(input.privateDirectory, `directory-move-${kind}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!fd) return undefined;
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 32768)
        throw new Error("HOST_DIRECTORY_JOURNAL_UNSAFE");
      const value = JSON.parse(await fd.readFile("utf8"));
      const after = await fd.stat();
      const current = await lstat(path.join(input.privateDirectory, `directory-move-${kind}.json`));
      if (
        before !== (await parent()) ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.isSymbolicLink() ||
        info.size !== after.size ||
        info.mtimeMs !== after.mtimeMs ||
        info.ctimeMs !== after.ctimeMs ||
        value.bindingDigest !== bindingDigest ||
        JSON.stringify(value.proof) !== JSON.stringify(proof)
      )
        throw new Error("HOST_DIRECTORY_JOURNAL_CHANGED");
      return proof;
    } finally {
      await fd.close();
    }
  };
  const write = async (kind: "intent" | "verified") => {
    const before = await parent();
    const fd = await open(
      path.join(input.privateDirectory, `directory-move-${kind}.json`),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(JSON.stringify({ bindingDigest, proof }));
      await fd.sync();
    } finally {
      await fd.close();
    }
    const directory = await open(input.privateDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (before !== (await parent())) throw new Error("HOST_DIRECTORY_JOURNAL_CHANGED");
  };
  const parents = async () => {
    for (const [relative, expected] of [
      [target.sourceRelativePath, target.sourceLineage.slice(0, -1)],
      [target.destinationRelativePath, target.destinationLineage],
    ] as const) {
      const parts = relative.split("/").slice(0, -1);
      if (expected.length !== parts.length + 1) throw new Error("HOST_DIRECTORY_PARENT_CHANGED");
      let filename = input.workspace;
      for (let index = 0; index < expected.length; index++) {
        if (index) {
          const part = parts[index - 1];
          if (!part) throw new Error("HOST_DIRECTORY_PARENT_CHANGED");
          filename = path.join(filename, part);
        }
        const info = await lstat(filename);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          String(info.dev) !== expected[index]?.device ||
          String(info.ino) !== expected[index]?.inode
        )
          throw new Error("HOST_DIRECTORY_PARENT_CHANGED");
      }
    }
  };
  const observe = async () => {
    await parents();
    const source = await platform.inspect(grant, target.sourceRelativePath);
    const destination = await platform.inspect(grant, target.destinationRelativePath);
    if (
      source ||
      !destination ||
      (destination.mode & constants.S_IFMT) !== constants.S_IFDIR ||
      destination.device !== proof.device ||
      destination.inode !== proof.inode
    )
      throw new Error("HOST_DIRECTORY_RESULT_UNKNOWN");
    await parents();
    return proof;
  };
  return {
    async execute(): Promise<DirectoryMoveProof> {
      if (
        input.scope.operation !== "move_directory" ||
        !grant.operations.includes("move") ||
        grant.expiresAt <= new Date().toISOString()
      )
        throw new Error("HOST_DIRECTORY_MOVE_DENIED");
      await parents();
      const source = await platform.inspect(grant, target.sourceRelativePath);
      if (!source || source.device !== proof.device || source.inode !== proof.inode)
        throw new Error("HOST_DIRECTORY_IDENTITY_CHANGED");
      await write("intent");
      if (grant.expiresAt <= new Date().toISOString())
        throw new Error("HOST_DIRECTORY_MOVE_DENIED");
      await platform.move(grant, target.sourceRelativePath, target.destinationRelativePath, source);
      const result = await observe();
      await write("verified");
      return result;
    },
    async recover(): Promise<DirectoryMoveProof | undefined> {
      if (!(await read("intent"))) return undefined;
      if (await read("verified")) return proof;
      return observe();
    },
  };
}
