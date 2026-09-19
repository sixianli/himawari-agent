import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  link,
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
  HostFilePublication,
  HostFilePublishHooks,
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
    expected?: HostFileIdentity,
    consistency: "current_path" | "opened_version" = "current_path",
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new Error("HOST_FILE_READ_REJECTED");
    const parentChain = await this.#captureParentChain(grant, relativePath);
    const target = await this.#resolve(grant, relativePath, true);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      rejectUnsafeObject(info);
      if (!info.isFile() || info.size > maximumBytes) throw new Error("HOST_FILE_READ_REJECTED");
      const observed = identity(target, info);
      const same = (left: HostFileIdentity, right: HostFileIdentity) =>
        left.canonicalPath === right.canonicalPath &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.linkCount === right.linkCount &&
        left.sizeBytes === right.sizeBytes &&
        left.modifiedAtMillis === right.modifiedAtMillis;
      if (expected && !same(observed, expected)) throw new Error("HOST_FILE_IDENTITY_CHANGED");
      await this.#assertParentChain(grant, relativePath, parentChain);
      const bytes = new Uint8Array(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error("HOST_FILE_CONTENT_CHANGED");
        offset += bytesRead;
      }
      const after = await handle.stat();
      // Atomic replacement unlinks the old inode without changing its bytes.
      // Only explicitly versioned reads may finish from that opened descriptor;
      // verification and write baselines still require the current path.
      const openedVersion =
        consistency === "opened_version" && info.nlink === 1 && after.nlink === 0;
      const afterIdentity = identity(target, after);
      if (
        !same(
          observed,
          openedVersion ? { ...afterIdentity, linkCount: observed.linkCount } : afterIdentity,
        ) ||
        (!openedVersion && info.ctimeMs !== after.ctimeMs)
      )
        throw new Error("HOST_FILE_CONTENT_CHANGED");
      await this.#assertParentChain(grant, relativePath, parentChain);
      const current = await this.inspect(grant, relativePath);
      if (
        !current ||
        (!same(observed, current) &&
          !(
            openedVersion &&
            current.device === observed.device &&
            current.inode !== observed.inode
          ))
      )
        throw new Error("HOST_FILE_IDENTITY_CHANGED");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async createExclusive(
    grant: HostDirectoryGrant,
    relativePath: string,
    bytes: Uint8Array,
    hooks?: HostFilePublishHooks,
  ) {
    bytes = new Uint8Array(bytes);
    grant = structuredClone(grant);
    const publication = await this.stagePublication(grant, bytes, 0o600);
    return this.publishPrepared(grant, relativePath, publication, null, new Uint8Array(), hooks);
  }

  async replaceAtomic(
    grant: HostDirectoryGrant,
    relativePath: string,
    expected: HostFileIdentity,
    bytes: Uint8Array,
    previousBytes: Uint8Array,
    hooks?: HostFilePublishHooks,
  ) {
    grant = structuredClone(grant);
    expected = { ...expected };
    previousBytes = new Uint8Array(previousBytes);
    const publication = await this.stagePublication(grant, bytes, expected.mode & 0o777);
    return this.publishPrepared(grant, relativePath, publication, expected, previousBytes, hooks);
  }

  /** Preparation writes only our private recovery area, never the target or its parents. */
  async stagePublication(grant: HostDirectoryGrant, bytes: Uint8Array, mode = 0o600) {
    return this.#stage(structuredClone(grant), new Uint8Array(bytes), mode);
  }

  async readPublication(grant: HostDirectoryGrant, publication: HostFilePublication) {
    grant = structuredClone(grant);
    publication = structuredClone(publication);
    await this.#assertStaged(grant, publication);
    return this.read(
      grant,
      publication.stagedRelativePath,
      Math.max(1, publication.identity.sizeBytes),
      publication.identity,
    );
  }

  /** Caller owns commit admission. A prepared inode is never regenerated on conflict. */
  async publishPrepared(
    grant: HostDirectoryGrant,
    relativePath: string,
    publication: HostFilePublication,
    expected: HostFileIdentity | null,
    previousBytes: Uint8Array,
    hooks?: HostFilePublishHooks,
  ) {
    grant = structuredClone(grant);
    publication = structuredClone(publication);
    expected = expected ? { ...expected } : null;
    previousBytes = new Uint8Array(previousBytes);
    await this.#assertStaged(grant, publication);
    const target = await this.#resolve(grant, relativePath, expected !== null, expected === null);
    const parentChain = await this.#captureParentChain(grant, relativePath);
    const recoveryRoot = path.dirname(publication.identity.canonicalPath);
    const assertUnchanged = async () => {
      if (!expected) return;
      const before = await this.#requiredSafeIdentity(grant, relativePath);
      if (identityKey(before) !== identityKey(expected))
        throw new Error("HOST_FILE_IDENTITY_CHANGED");
      const current = await this.read(grant, relativePath, Math.max(1, previousBytes.byteLength));
      if (!Buffer.from(current).equals(previousBytes)) throw new Error("HOST_FILE_CONTENT_CHANGED");
    };
    await assertUnchanged();
    if (expected) {
      const recovery = path.join(
        recoveryRoot,
        `${createHash("sha256").update(relativePath).digest("hex")}-${randomUUID()}.bak`,
      );
      await this.#assertParentChain(grant, relativePath, parentChain);
      await copyFile(target, recovery, constants.COPYFILE_EXCL);
      const backup = await open(recovery, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await backup.sync();
      } finally {
        await backup.close();
      }
      await syncDirectory(recoveryRoot);
    }
    await hooks?.beforePublish(publication);
    await this.#assertParentChain(grant, relativePath, parentChain);
    await this.#assertStaged(grant, publication);
    await assertUnchanged();
    await hooks?.assertCurrentAuthority?.();
    // External uncooperative writers are detected, not a strict filesystem CAS.
    if (expected) await rename(publication.identity.canonicalPath, target);
    else {
      await link(publication.identity.canonicalPath, target);
      await unlink(publication.identity.canonicalPath);
    }
    await syncDirectory(path.dirname(target));
    await syncDirectory(recoveryRoot);
    return this.#requiredSafeIdentity(grant, relativePath);
  }

  async recoverPublication(
    grant: HostDirectoryGrant,
    relativePath: string,
    publication: HostFilePublication,
  ): Promise<HostFileIdentity> {
    const targetParent = await this.#captureParentChain(grant, relativePath);
    const normalized = normalizeRelativePath(relativePath);
    const root = await this.#resolveRoot(grant);
    const target = path.join(root, normalized);
    const stage = await this.#publicationPath(grant, publication);
    const current = await lstat(target);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink > 2 ||
      identityKey(identity(target, current)) !== identityKey(publication.identity) ||
      current.size !== publication.identity.sizeBytes ||
      current.mtimeMs !== publication.identity.modifiedAtMillis
    )
      throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
    const staged = await lstat(stage).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (staged) {
      if (
        !staged.isFile() ||
        staged.isSymbolicLink() ||
        staged.dev !== current.dev ||
        staged.ino !== current.ino
      )
        throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
      // A crash between link and unlink left our private alias. No other alias
      // may be removed, and bytes alone cannot authorize this recovery.
      await unlink(stage);
      await syncDirectory(path.dirname(stage));
    } else if (current.nlink !== 1) throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
    await this.#assertParentChain(grant, relativePath, targetParent);
    await syncDirectory(path.dirname(target));
    return this.#requiredSafeIdentity(grant, relativePath);
  }

  async #publicationPath(grant: HostDirectoryGrant, publication: HostFilePublication) {
    if (!/^\.himawari-recovery\/staged-[0-9a-f-]{36}\.tmp$/.test(publication.stagedRelativePath))
      throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
    const directory = await this.#resolve(grant, ".himawari-recovery", true);
    const filename = path.join(directory, path.basename(publication.stagedRelativePath));
    if (filename !== publication.identity.canonicalPath)
      throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
    return filename;
  }

  async #assertStaged(grant: HostDirectoryGrant, publication: HostFilePublication) {
    const filename = await this.#publicationPath(grant, publication);
    const info = await lstat(filename);
    rejectUnsafeObject(info);
    if (
      !info.isFile() ||
      identityKey(identity(filename, info)) !== identityKey(publication.identity) ||
      info.size !== publication.identity.sizeBytes ||
      info.mtimeMs !== publication.identity.modifiedAtMillis
    )
      throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
  }

  async #stage(
    grant: HostDirectoryGrant,
    bytes: Uint8Array,
    mode: number,
  ): Promise<HostFilePublication> {
    const directory = await this.#ensureControlledDirectory(grant, ".himawari-recovery");
    const name = `staged-${randomUUID()}.tmp`;
    const filename = path.join(directory, name);
    const handle = await open(
      filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let complete = false;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
      const info = await handle.stat();
      rejectUnsafeObject(info);
      if (!info.isFile() || info.size !== bytes.byteLength)
        throw new Error("HOST_FILE_PUBLICATION_UNVERIFIED");
      await syncDirectory(directory);
      complete = true;
      return {
        stagedRelativePath: `.himawari-recovery/${name}`,
        identity: identity(filename, info),
      };
    } finally {
      await handle.close();
      if (!complete) await unlink(filename).catch(() => undefined);
    }
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
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await syncDirectory(path.dirname(current));
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
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
      throw new Error("HOST_RECOVERY_DIRECTORY_UNSAFE");
    await syncDirectory(path.dirname(safe));
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

/** Failure here is an uncertain durability result, never a successful receipt. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
