import { constants, type BigIntStats } from "node:fs";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statfsSync,
} from "node:fs";
import {
  HOST_READ_ONLY_ERROR_CODES as CODES,
  HostReadOnlyError,
  type HostDirectoryGrant,
  type HostReadOnlyDirectoryEntry,
  type HostReadOnlyEntryKind,
  type HostReadOnlyPort,
  type HostWorkspaceSnapshot,
  type HostWorkspaceSnapshotEntry,
  type HostWorkspaceSnapshotPort,
} from "@himawari-agent/application";
import {
  firstProtectedDirectoryEntry,
  isProtectedDirectoryEntry,
  isRejectedPathComponent,
} from "@himawari-agent/execution-contracts";

export class DescriptorRelativeReadOnly implements HostReadOnlyPort, HostWorkspaceSnapshotPort {
  readonly available: boolean;

  constructor() {
    this.available = process.platform === "linux" && procAvailable();
  }

  async listDirectory(input: {
    readonly grant: HostDirectoryGrant;
    readonly relativePath: string;
  }): Promise<readonly HostReadOnlyDirectoryEntry[]> {
    const parts = relativeComponents(input.relativePath);
    if (firstProtectedDirectoryEntry(parts) !== undefined)
      throw new HostReadOnlyError(CODES.PROTECTED);
    return this.#withRoot(input.grant, (rootFd, device) => {
      const directory = openDirectoryFrom(rootFd, parts, device);
      try {
        const names = readdirSync(`${PROC_FD}/${directory.fd}`);
        const entries: HostReadOnlyDirectoryEntry[] = [];
        for (const name of names) {
          let info: BigIntStats;
          try {
            info = lstatSync(`${PROC_FD}/${directory.fd}/${name}`, { bigint: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          entries.push(Object.freeze({ name, kind: kindOf(info) }));
        }
        return Object.freeze(entries);
      } finally {
        if (directory.owned) closeSync(directory.fd);
      }
    });
  }

  async inspectEntry(input: {
    readonly grant: HostDirectoryGrant;
    readonly relativePath: string;
  }): Promise<HostReadOnlyEntryKind | null> {
    const parts = relativeComponents(input.relativePath);
    if (parts.length === 0) return "directory";
    if (firstProtectedDirectoryEntry(parts) !== undefined)
      throw new HostReadOnlyError(CODES.PROTECTED);
    return this.#withRoot(input.grant, (rootFd, device) => {
      const directory = openDirectoryFrom(rootFd, parts.slice(0, -1), device);
      try {
        let info: BigIntStats;
        try {
          info = lstatSync(`${PROC_FD}/${directory.fd}/${parts[parts.length - 1]}`, {
            bigint: true,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new HostReadOnlyError(CODES.LINK_ESCAPE);
        }
        return kindOf(info);
      } finally {
        if (directory.owned) closeSync(directory.fd);
      }
    });
  }

  async readFile(input: {
    readonly grant: HostDirectoryGrant;
    readonly relativePath: string;
    readonly maximumBytes: number;
  }): Promise<Uint8Array> {
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1)
      throw new HostReadOnlyError(CODES.LENGTH_EXCEEDED);
    const parts = relativeComponents(input.relativePath);
    if (parts.length === 0) throw new HostReadOnlyError(CODES.NOT_REGULAR);
    if (firstProtectedDirectoryEntry(parts) !== undefined)
      throw new HostReadOnlyError(CODES.PROTECTED);
    const limit = BigInt(input.maximumBytes);
    return this.#withRoot(input.grant, (rootFd, device) => {
      const directory = openDirectoryFrom(rootFd, parts.slice(0, -1), device);
      try {
        const procPath = `${PROC_FD}/${directory.fd}/${parts[parts.length - 1]}`;
        let before: BigIntStats;
        try {
          before = lstatSync(procPath, { bigint: true });
        } catch (error) {
          throw mapPathError(error);
        }
        if (before.isSymbolicLink()) throw new HostReadOnlyError(CODES.LINK_ESCAPE);
        if (!before.isFile()) throw new HostReadOnlyError(CODES.NOT_REGULAR);
        if (before.nlink !== 1n) throw new HostReadOnlyError(CODES.HARDLINK);
        if (before.dev !== device) throw new HostReadOnlyError(CODES.LINK_ESCAPE);
        if (before.size > limit) throw new HostReadOnlyError(CODES.LENGTH_EXCEEDED);
        let handle: number;
        try {
          handle = openSync(
            procPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          throw mapPathError(error);
        }
        try {
          const info = fstatSync(handle, { bigint: true });
          if (!info.isFile()) throw new HostReadOnlyError(CODES.NOT_REGULAR);
          if (info.nlink !== 1n) throw new HostReadOnlyError(CODES.HARDLINK);
          if (info.dev !== device || info.ino !== before.ino)
            throw new HostReadOnlyError(CODES.CONTENT_CHANGED);
          if (info.size > limit) throw new HostReadOnlyError(CODES.LENGTH_EXCEEDED);
          const size = Number(info.size);
          const buffer = Buffer.allocUnsafe(size);
          let offset = 0;
          while (offset < size) {
            const read = readSync(handle, buffer, offset, size - offset, offset);
            if (read === 0) throw new HostReadOnlyError(CODES.CONTENT_CHANGED);
            offset += read;
          }
          const after = fstatSync(handle, { bigint: true });
          if (
            after.ino !== info.ino ||
            after.size !== info.size ||
            after.mtimeNs !== info.mtimeNs ||
            after.ctimeNs !== info.ctimeNs
          )
            throw new HostReadOnlyError(CODES.CONTENT_CHANGED);
          return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } finally {
          closeSync(handle);
        }
      } finally {
        if (directory.owned) closeSync(directory.fd);
      }
    });
  }

  async snapshotWorkspace(input: {
    readonly grant: HostDirectoryGrant;
    readonly maximumEntries: number;
  }): Promise<HostWorkspaceSnapshot> {
    if (!Number.isSafeInteger(input.maximumEntries) || input.maximumEntries < 1)
      throw new HostReadOnlyError(CODES.LENGTH_EXCEEDED);
    return this.#withRoot(input.grant, (rootFd, device) => {
      const entries: HostWorkspaceSnapshotEntry[] = [];
      const pending: string[] = [""];
      let complete = true;
      while (complete && pending.length > 0) {
        const path = pending.pop() ?? "";
        let directory: { readonly fd: number; readonly owned: boolean };
        try {
          directory = openDirectoryFrom(rootFd, relativeComponents(path), device);
        } catch (error) {
          if (error instanceof HostReadOnlyError) continue;
          throw error;
        }
        try {
          const names = readdirSync(`${PROC_FD}/${directory.fd}`).sort();
          const children: string[] = [];
          for (const name of names) {
            const child = path === "" ? name : `${path}/${name}`;
            if (isRejectedPathComponent(name) || isProtectedDirectoryEntry(child, name)) continue;
            if (entries.length >= input.maximumEntries) {
              complete = false;
              break;
            }
            let info: BigIntStats;
            try {
              info = lstatSync(`${PROC_FD}/${directory.fd}/${name}`, { bigint: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            const kind = snapshotKindOf(info);
            entries.push(
              Object.freeze({
                path: child,
                kind,
                size: info.size.toString(),
                modifiedAtNs: info.mtimeNs.toString(),
                inode: info.ino.toString(),
              }),
            );
            if (kind === "directory" && info.dev === device) children.push(child);
          }
          pending.push(...children.reverse());
        } finally {
          if (directory.owned) closeSync(directory.fd);
        }
      }
      entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      return Object.freeze({ entries: Object.freeze(entries), complete });
    });
  }

  #withRoot<T>(grant: HostDirectoryGrant, run: (rootFd: number, device: bigint) => T): T {
    if (!this.available) throw new HostReadOnlyError(CODES.PROC_UNAVAILABLE);
    const device = deviceOf(grant);
    const identity = grant.canonicalRootId;
    let rootFd: number;
    try {
      rootFd = openSync(
        grant.displayPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new HostReadOnlyError(CODES.ROOT_IDENTITY_CHANGED);
    }
    try {
      const info = fstatSync(rootFd, { bigint: true });
      if (!info.isDirectory() || `${info.dev}:${info.ino}` !== identity)
        throw new HostReadOnlyError(CODES.ROOT_IDENTITY_CHANGED);
      return run(rootFd, device);
    } finally {
      closeSync(rootFd);
    }
  }
}

const PROC_FD = "/proc/self/fd";
const PROC_SUPER_MAGIC = 0x9fa0;

function procAvailable(): boolean {
  try {
    return statfsSync(PROC_FD).type === PROC_SUPER_MAGIC;
  } catch {
    return false;
  }
}

function relativeComponents(relativePath: string): string[] {
  if (relativePath === "") return [];
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    Array.from(relativePath).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new HostReadOnlyError(CODES.PATH_UNSAFE);
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new HostReadOnlyError(CODES.PATH_UNSAFE);
  return parts;
}

function deviceOf(grant: HostDirectoryGrant): bigint {
  const [device] = grant.canonicalRootId.split(":");
  if (!device || !/^\d+$/.test(device)) throw new HostReadOnlyError(CODES.ROOT_IDENTITY_CHANGED);
  return BigInt(device);
}

function openDirectoryFrom(
  rootFd: number,
  parts: readonly string[],
  device: bigint,
): { readonly fd: number; readonly owned: boolean } {
  if (parts.length === 0) return { fd: rootFd, owned: false };
  let fd = rootFd;
  let owned = false;
  try {
    for (const part of parts) {
      const next = openSync(
        `${PROC_FD}/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (owned) closeSync(fd);
      fd = next;
      owned = true;
      const info = fstatSync(fd, { bigint: true });
      if (!info.isDirectory() || info.dev !== device)
        throw new HostReadOnlyError(CODES.LINK_ESCAPE);
    }
    return { fd, owned };
  } catch (error) {
    if (owned) closeSync(fd);
    throw mapPathError(error);
  }
}

function mapPathError(error: unknown): HostReadOnlyError {
  if (error instanceof HostReadOnlyError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new HostReadOnlyError(CODES.TARGET_MISSING);
  if (code === "ELOOP" || code === "ENOTDIR") return new HostReadOnlyError(CODES.LINK_ESCAPE);
  return new HostReadOnlyError(CODES.LINK_ESCAPE);
}

function kindOf(info: { isFile(): boolean; isDirectory(): boolean }): HostReadOnlyEntryKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  return "other";
}

function snapshotKindOf(info: BigIntStats): HostWorkspaceSnapshotEntry["kind"] {
  if (info.isSymbolicLink()) return "symlink";
  return kindOf(info);
}
