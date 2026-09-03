import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type {
  HostDirectoryGrant,
  HostFileIdentity,
  HostFilePlatformPort,
} from "@himawari-agent/application";
import { identityKey, normalizeRelativePath } from "@himawari-agent/application";

export class ConstrainedHostFileSystem implements HostFilePlatformPort {
  async inspectRoot(root: string): Promise<HostFileIdentity> {
    const canonical = await realpath(root);
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("HOST_ROOT_UNSAFE");
    return identity(canonical, info);
  }

  async inspect(
    grant: HostDirectoryGrant,
    relativePath: string,
  ): Promise<HostFileIdentity | undefined> {
    const target = await this.#resolve(grant, relativePath, false).catch((error) => {
      if (error instanceof Error && error.message === "HOST_PATH_COMPONENT_MISSING") return null;
      throw error;
    });
    if (!target) return undefined;
    const info = await lstat(target).catch(() => undefined);
    if (!info) return undefined;
    rejectUnsafeObject(info);
    return identity(target, info);
  }

  async read(
    grant: HostDirectoryGrant,
    relativePath: string,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    const target = await this.#resolve(grant, relativePath, true);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      rejectUnsafeObject(info);
      if (!info.isFile() || info.size > maximumBytes) throw new Error("HOST_FILE_READ_REJECTED");
      const bytes = new Uint8Array(info.size);
      await handle.read(bytes, 0, bytes.length, 0);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async createExclusive(grant: HostDirectoryGrant, relativePath: string, bytes: Uint8Array) {
    const target = await this.#resolve(grant, relativePath, false, true);
    const handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return this.#requiredSafeIdentity(grant, relativePath);
  }

  async replaceAtomic(
    grant: HostDirectoryGrant,
    relativePath: string,
    expected: HostFileIdentity,
    bytes: Uint8Array,
  ) {
    const target = await this.#resolve(grant, relativePath, true);
    const parentChain = await this.#captureParentChain(grant, relativePath);
    const before = await this.#requiredSafeIdentity(grant, relativePath);
    if (identityKey(before) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    const recoveryRoot = await this.#ensureControlledDirectory(grant, ".himawari-recovery");
    const recovery = path.join(
      recoveryRoot,
      `${createHash("sha256").update(relativePath).digest("hex")}-${randomUUID()}.bak`,
    );
    await this.#assertParentChain(grant, relativePath, parentChain);
    await copyFile(target, recovery, constants.COPYFILE_EXCL);
    const temporary = path.join(path.dirname(target), `.himawari-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const immediatelyBeforeRename = await this.#requiredSafeIdentity(grant, relativePath);
      if (identityKey(immediatelyBeforeRename) !== identityKey(expected))
        throw new Error("HOST_FILE_IDENTITY_CHANGED");
      await this.#assertParentChain(grant, relativePath, parentChain);
      await rename(temporary, target);
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) await unlink(temporary).catch(() => undefined);
    }
    return this.#requiredSafeIdentity(grant, relativePath);
  }

  async move(
    grant: HostDirectoryGrant,
    sourceRelativePath: string,
    destinationRelativePath: string,
    expected: HostFileIdentity,
  ) {
    const source = await this.#resolve(grant, sourceRelativePath, true);
    const destination = await this.#resolve(grant, destinationRelativePath, false, true);
    const sourceChain = await this.#captureParentChain(grant, sourceRelativePath);
    const destinationChain = await this.#captureParentChain(grant, destinationRelativePath);
    if (await lstat(destination).catch(() => undefined)) throw new Error("HOST_FILE_TARGET_EXISTS");
    const current = await this.#requiredSafeIdentity(grant, sourceRelativePath);
    if (identityKey(current) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    await this.#assertParentChain(grant, sourceRelativePath, sourceChain);
    await this.#assertParentChain(grant, destinationRelativePath, destinationChain);
    await rename(source, destination);
    return this.#requiredSafeIdentity(grant, destinationRelativePath);
  }

  async trash(
    grant: HostDirectoryGrant,
    relativePath: string,
    expected: HostFileIdentity,
    recoveryKey: string,
  ) {
    const trashRoot = await this.#ensureControlledDirectory(grant, ".himawari-trash");
    const trashRelativePath = `.himawari-trash/${createHash("sha256").update(recoveryKey).digest("hex")}.trash`;
    const current = await this.inspect(grant, relativePath);
    if (!current) {
      const recovered = await this.#requiredSafeIdentity(grant, trashRelativePath);
      if (identityKey(recovered) !== identityKey(expected))
        throw new Error("HOST_FILE_IDENTITY_CHANGED");
      return { identity: recovered, trashRelativePath };
    }
    if (identityKey(current) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    const target = await this.#resolve(grant, relativePath, true);
    if (await this.inspect(grant, trashRelativePath)) throw new Error("HOST_FILE_TARGET_EXISTS");
    await rename(target, path.join(trashRoot, path.basename(trashRelativePath)));
    return { identity: current, trashRelativePath };
  }

  async restore(
    grant: HostDirectoryGrant,
    trashRelativePath: string,
    originalRelativePath: string,
    expected: HostFileIdentity,
  ) {
    if (!trashRelativePath.startsWith(".himawari-trash/"))
      throw new Error("HOST_TRASH_PATH_UNSAFE");
    const restored = await this.inspect(grant, originalRelativePath);
    if (restored) {
      if (identityKey(restored) !== identityKey(expected))
        throw new Error("HOST_RESTORE_TARGET_EXISTS");
      if (await this.inspect(grant, trashRelativePath)) throw new Error("HOST_RECOVERY_AMBIGUOUS");
      return restored;
    }
    const sourceIdentity = await this.#requiredSafeIdentity(grant, trashRelativePath);
    if (identityKey(sourceIdentity) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    const source = await this.#resolve(grant, trashRelativePath, true);
    const target = await this.#resolve(grant, originalRelativePath, false, true);
    await rename(source, target);
    return this.#requiredSafeIdentity(grant, originalRelativePath);
  }

  async inventoryDeletion(grant: HostDirectoryGrant, relativePath: string) {
    const normalized = normalizeRelativePath(relativePath);
    const target = await this.#resolve(grant, normalized, true).catch((error) => {
      if (error instanceof Error && error.message === "HOST_PATH_COMPONENT_MISSING") return null;
      throw error;
    });
    if (!target) return [];
    const rootInfo = await lstat(await realpath(grant.displayPath));
    const results: Array<{
      relativePath: string;
      identity: HostFileIdentity;
      digest: string | null;
      kind: "file" | "directory";
    }> = [];
    const visit = async (absolute: string, relative: string): Promise<void> => {
      const info = await lstat(absolute);
      rejectUnsafeObject(info);
      if (String(info.dev) !== String(rootInfo.dev)) throw new Error("HOST_PATH_ESCAPE_BLOCKED");
      if (info.isDirectory()) {
        const entries = await readdir(absolute);
        for (const entry of entries.sort()) {
          await visit(path.join(absolute, entry), `${relative}/${entry}`);
        }
        results.push({
          relativePath: relative,
          identity: identity(absolute, info),
          digest: null,
          kind: "directory",
        });
        return;
      }
      if (!info.isFile()) throw new Error("HOST_FILE_READ_REJECTED");
      const bytes = await this.read(grant, relative, 16 * 1024 * 1024);
      results.push({
        relativePath: relative,
        identity: identity(absolute, info),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        kind: "file",
      });
    };
    await visit(target, normalized);
    return Object.freeze(results.map((result) => Object.freeze(result)));
  }

  async deletePermanently(
    grant: HostDirectoryGrant,
    targets: readonly import("@himawari-agent/application").PermanentDeletionTarget[],
  ): Promise<void> {
    // Detect stale approvals across the complete inventory before the first destructive step.
    for (const target of targets) await this.#verifyDeletionTarget(grant, target);
    for (const target of targets) {
      const absolute = await this.#verifyDeletionTarget(grant, target);
      if (!absolute) continue;
      if (target.kind === "directory") await rmdir(absolute);
      else await unlink(absolute);
    }
  }

  async #verifyDeletionTarget(
    grant: HostDirectoryGrant,
    target: import("@himawari-agent/application").PermanentDeletionTarget,
  ): Promise<string | null> {
    const current = await this.inspect(grant, target.relativePath);
    if (!current) return null;
    if (identityKey(current) !== identityKey(target.identity))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    const absolute = await this.#resolve(grant, target.relativePath, true);
    const info = await lstat(absolute);
    const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
    if (kind !== target.kind) throw new Error("HOST_FILE_KIND_CHANGED");
    if (kind === "file") {
      const bytes = await this.read(grant, target.relativePath, 16 * 1024 * 1024);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== target.digest)
        throw new Error("HOST_FILE_CONTENT_CHANGED");
      const after = await this.inspect(grant, target.relativePath);
      if (!after || identityKey(after) !== identityKey(target.identity))
        throw new Error("HOST_FILE_IDENTITY_CHANGED");
    } else if (target.digest !== null) throw new Error("HOST_FILE_CONTENT_CHANGED");
    return absolute;
  }

  async storageObservation(grant: HostDirectoryGrant) {
    const root = await this.#resolveRoot(grant);
    const info = await statfs(root);
    return Object.freeze({
      availableBytes: Number(info.bavail) * Number(info.bsize),
      totalBytes: Number(info.blocks) * Number(info.bsize),
    });
  }

  async #requiredSafeIdentity(grant: HostDirectoryGrant, relativePath: string) {
    const result = await this.inspect(grant, relativePath);
    if (!result) throw new Error("HOST_FILE_MISSING");
    return result;
  }

  async #resolve(
    grant: HostDirectoryGrant,
    relativePath: string,
    requireTarget: boolean,
    createParents = false,
  ): Promise<string> {
    const normalized = normalizeRelativePath(relativePath);
    const root = await this.#resolveRoot(grant);
    const rootInfo = await lstat(root);
    if (`${rootInfo.dev}:${rootInfo.ino}` !== grant.canonicalRootId)
      throw new Error("HOST_ROOT_IDENTITY_CHANGED");
    const parts = normalized.split("/");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const isTarget = index === parts.length - 1;
      let info = await lstat(current).catch(() => undefined);
      if (!info && !isTarget && createParents) {
        await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (!info) {
        if (isTarget && !requireTarget) break;
        throw new Error("HOST_PATH_COMPONENT_MISSING");
      }
      if (info.isSymbolicLink() || String(info.dev) !== String(rootInfo.dev))
        throw new Error("HOST_PATH_ESCAPE_BLOCKED");
      if (!isTarget && !info.isDirectory()) throw new Error("HOST_PATH_COMPONENT_NOT_DIRECTORY");
      if (isTarget) rejectUnsafeObject(info);
    }
    return current;
  }

  async #resolveRoot(grant: HostDirectoryGrant): Promise<string> {
    const root = await realpath(grant.displayPath);
    const rootInfo = await lstat(root);
    if (`${rootInfo.dev}:${rootInfo.ino}` !== grant.canonicalRootId)
      throw new Error("HOST_ROOT_IDENTITY_CHANGED");
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("HOST_ROOT_UNSAFE");
    return root;
  }

  async #ensureControlledDirectory(
    grant: HostDirectoryGrant,
    relativePath: string,
  ): Promise<string> {
    const target = await this.#resolve(grant, relativePath, false);
    await mkdir(target, { mode: 0o700 }).catch(async (error) => {
      const info = await lstat(target).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw error;
    });
    const safe = await this.#resolve(grant, relativePath, true);
    const info = await lstat(safe);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("HOST_PATH_ESCAPE_BLOCKED");
    return safe;
  }

  async #captureParentChain(
    grant: HostDirectoryGrant,
    relativePath: string,
  ): Promise<readonly string[]> {
    const normalized = normalizeRelativePath(relativePath);
    const parts = normalized.split("/").slice(0, -1);
    const chain = [grant.canonicalRootId];
    let current = await this.#resolveRoot(grant);
    for (const part of parts) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("HOST_PATH_ESCAPE_BLOCKED");
      chain.push(`${info.dev}:${info.ino}`);
    }
    return Object.freeze(chain);
  }

  async #assertParentChain(
    grant: HostDirectoryGrant,
    relativePath: string,
    expected: readonly string[],
  ): Promise<void> {
    const current = await this.#captureParentChain(grant, relativePath);
    if (
      current.length !== expected.length ||
      current.some((value, index) => value !== expected[index])
    )
      throw new Error("HOST_PATH_PARENT_CHANGED");
  }
}

function rejectUnsafeObject(info: Awaited<ReturnType<typeof lstat>>): void {
  if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
    throw new Error("HOST_LINK_ESCAPE_BLOCKED");
}

function identity(
  canonicalPath: string,
  info: Awaited<ReturnType<typeof lstat>>,
): HostFileIdentity {
  return Object.freeze({
    canonicalPath,
    device: String(info.dev),
    inode: String(info.ino),
    mode: Number(info.mode),
    linkCount: Number(info.nlink),
    sizeBytes: Number(info.size),
    modifiedAtMillis: Number(info.mtimeMs),
  });
}
