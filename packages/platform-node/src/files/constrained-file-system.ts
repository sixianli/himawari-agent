import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
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
    const before = await this.#requiredSafeIdentity(grant, relativePath);
    if (identityKey(before) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    const recoveryRoot = path.join(grant.displayPath, ".himawari-recovery");
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    const recovery = path.join(
      recoveryRoot,
      `${createHash("sha256").update(relativePath).digest("hex")}-${randomUUID()}.bak`,
    );
    await copyFile(target, recovery, constants.COPYFILE_EXCL);
    const temporary = path.join(path.dirname(target), `.himawari-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const immediatelyBeforeRename = await this.#requiredSafeIdentity(grant, relativePath);
    if (identityKey(immediatelyBeforeRename) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    await rename(temporary, target);
    return this.#requiredSafeIdentity(grant, relativePath);
  }

  async trash(grant: HostDirectoryGrant, relativePath: string, expected: HostFileIdentity) {
    const target = await this.#resolve(grant, relativePath, true);
    const current = await this.#requiredSafeIdentity(grant, relativePath);
    if (identityKey(current) !== identityKey(expected))
      throw new Error("HOST_FILE_IDENTITY_CHANGED");
    const trashRoot = path.join(grant.displayPath, ".himawari-trash");
    await mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const trashRelativePath = `.himawari-trash/${randomUUID()}.trash`;
    await rename(target, path.join(grant.displayPath, trashRelativePath));
    return { identity: current, trashRelativePath };
  }

  async restore(
    grant: HostDirectoryGrant,
    trashRelativePath: string,
    originalRelativePath: string,
  ) {
    if (!trashRelativePath.startsWith(".himawari-trash/"))
      throw new Error("HOST_TRASH_PATH_UNSAFE");
    const source = await this.#resolve(grant, trashRelativePath, true);
    const target = await this.#resolve(grant, originalRelativePath, false, true);
    if (await lstat(target).catch(() => undefined)) throw new Error("HOST_RESTORE_TARGET_EXISTS");
    await rename(source, target);
    return this.#requiredSafeIdentity(grant, originalRelativePath);
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
    const root = await realpath(grant.displayPath);
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
