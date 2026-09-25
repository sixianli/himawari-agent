import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnvelope } from "@himawari-agent/execution-contracts";
import { ContainerBackendError } from "./container-backend-error.ts";

export const WORKSPACE_MOUNT_ROOT = "/workspaces";
const PROTECTED_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".ssh",
  ".aws",
  ".himawari-trash",
  ".himawari-recovery",
]);
const PROTECTED_PREFIXES = [".env.", "id_rsa", "id_ed25519"];
const PROTECTED_SUFFIXES = [".pem", ".key"];
const PROTECTED_PATH = ".docker/config.json";
const UNSAFE_MOUNT_CHARACTERS = /[,"\n\r\0]/;
const GIT_FILE_BYTES = 4096;

export type HostDirectoryCapability = ExecutionEnvelope["directories"][number];

export interface HostDirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface HostDirectoryLimits {
  readonly maxScannedEntries: number;
  readonly maxProtectedEntries: number;
}

export interface ContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface PreparedHostDirectories {
  readonly roots: readonly (HostDirectoryIdentity & { readonly access: "read" | "write" })[];
  readonly mounts: readonly ContainerMount[];
  readonly owner: { readonly uid: number; readonly gid: number } | null;
}

interface ScanBudget {
  scanned: number;
  readonly limits: HostDirectoryLimits;
}

export async function prepareHostDirectories(input: {
  readonly hostId: string;
  readonly directories: readonly HostDirectoryCapability[];
  readonly resolve: (directory: HostDirectoryCapability) => Promise<HostDirectoryIdentity | null>;
  readonly limits: HostDirectoryLimits;
  readonly masks: { readonly file: string; readonly directory: string };
}): Promise<PreparedHostDirectories> {
  const roots: (HostDirectoryIdentity & {
    readonly access: "read" | "write";
    readonly target: string;
    readonly info: Stats;
  })[] = [];
  for (const directory of [...input.directories].sort((a, b) =>
    compare(a.canonicalRootId, b.canonicalRootId),
  )) {
    const resolved = directory.hostId === input.hostId ? await input.resolve(directory) : null;
    if (!resolved) throw new ContainerBackendError("CONTAINER_DIRECTORY_UNRESOLVED");
    if (UNSAFE_MOUNT_CHARACTERS.test(resolved.canonicalPath))
      throw new ContainerBackendError("CONTAINER_POLICY_UNSUPPORTED");
    const info = await verifyHostDirectory(resolved);
    roots.push({
      canonicalPath: resolved.canonicalPath,
      device: resolved.device,
      inode: resolved.inode,
      access: directory.access,
      target: `${WORKSPACE_MOUNT_ROOT}/${directory.canonicalRootId}`,
      info,
    });
  }
  if (
    roots.some((root, index) =>
      roots.some(
        (other, otherIndex) =>
          index !== otherIndex && contains(root.canonicalPath, other.canonicalPath),
      ),
    )
  )
    throw new ContainerBackendError("CONTAINER_POLICY_UNSUPPORTED");
  const budget: ScanBudget = { scanned: 0, limits: input.limits };
  const mounts: ContainerMount[] = [];
  let masked = 0;
  for (const root of roots) {
    mounts.push({
      source: root.canonicalPath,
      target: root.target,
      readOnly: root.access === "read",
    });
    for (const entry of await scanDirectory(root.canonicalPath, budget)) {
      masked += 1;
      if (masked > input.limits.maxProtectedEntries || UNSAFE_MOUNT_CHARACTERS.test(entry.relative))
        throw new ContainerBackendError("CONTAINER_PROTECTED_FILE_UNMASKABLE");
      await requireNoAlias(root.canonicalPath, entry.relative);
      mounts.push({
        source: entry.kind === "directory" ? input.masks.directory : input.masks.file,
        target: `${root.target}/${entry.relative}`,
        readOnly: true,
      });
    }
  }
  const [first] = roots;
  if (first && roots.some((root) => root.info.uid !== first.info.uid))
    throw new ContainerBackendError("CONTAINER_DIRECTORY_OWNER_UNSUPPORTED");
  return {
    roots: roots.map(({ canonicalPath, device, inode, access }) => ({
      canonicalPath,
      device,
      inode,
      access,
    })),
    mounts: mounts.sort((a, b) => compare(a.target, b.target)),
    owner: first ? { uid: first.info.uid, gid: first.info.gid } : null,
  };
}

export async function verifyHostDirectory(root: HostDirectoryIdentity): Promise<Stats> {
  let info: Stats;
  try {
    if (
      !path.isAbsolute(root.canonicalPath) ||
      path.normalize(root.canonicalPath) !== root.canonicalPath ||
      (await realpath(root.canonicalPath)) !== root.canonicalPath
    )
      throw new ContainerBackendError("CONTAINER_DIRECTORY_CHANGED");
    info = await lstat(root.canonicalPath);
  } catch (cause) {
    throw new ContainerBackendError("CONTAINER_DIRECTORY_CHANGED", { cause });
  }
  if (!info.isDirectory() || String(info.dev) !== root.device || String(info.ino) !== root.inode)
    throw new ContainerBackendError("CONTAINER_DIRECTORY_CHANGED");
  return info;
}

export async function hostFreeBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
}

async function scanDirectory(root: string, budget: ScanBudget) {
  const masks: { readonly relative: string; readonly kind: "file" | "directory" }[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop() ?? "";
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      count(budget);
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const absolute = path.join(root, child);
      if (entry.name === ".git") await verifyGitMetadata(root, absolute, entry);
      if (isProtected(child, entry.name)) {
        if (entry.isSymbolicLink())
          throw new ContainerBackendError("CONTAINER_PROTECTED_FILE_UNMASKABLE");
        if (entry.isDirectory()) await requireSingleLinks(absolute, budget);
        else if ((await lstat(absolute)).nlink > 1)
          throw new ContainerBackendError("CONTAINER_PROTECTED_FILE_UNMASKABLE");
        masks.push({ relative: child, kind: entry.isDirectory() ? "directory" : "file" });
      } else if (entry.isDirectory()) pending.push(child);
      else if (!entry.isFile() && !entry.isSymbolicLink())
        masks.push({ relative: child, kind: "file" });
    }
  }
  return masks;
}

async function requireSingleLinks(directory: string, budget: ScanBudget) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() ?? directory;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      count(budget);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && (await lstat(absolute)).nlink > 1)
        throw new ContainerBackendError("CONTAINER_PROTECTED_FILE_UNMASKABLE");
    }
  }
}

async function requireNoAlias(root: string, relative: string) {
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index] ?? "";
    const parent = path.join(root, ...parts.slice(0, index));
    const original = await lstat(path.join(parent, name));
    const variants = new Set([swapCase(name), name.normalize("NFC"), name.normalize("NFD")]);
    variants.delete(name);
    for (const variant of variants) {
      const alias = await lstat(path.join(parent, variant)).catch(() => null);
      if (alias && alias.dev === original.dev && alias.ino === original.ino)
        throw new ContainerBackendError("CONTAINER_PROTECTED_FILE_UNMASKABLE");
    }
  }
}

async function verifyGitMetadata(root: string, absolute: string, entry: Dirent) {
  const refuse = () => new ContainerBackendError("CONTAINER_GIT_METADATA_OUTSIDE");
  const inside = async (target: string) => contains(root, await realpath(target).catch(() => ""));
  if (entry.isSymbolicLink()) {
    if (!(await inside(absolute))) throw refuse();
    return;
  }
  let gitdir = absolute;
  if (entry.isFile()) {
    const info = await lstat(absolute);
    if (info.size > GIT_FILE_BYTES) throw refuse();
    const match = /^gitdir: (.+?)\s*$/.exec(
      (await readFile(absolute, "utf8")).split("\n")[0] ?? "",
    );
    if (!match?.[1]) throw refuse();
    gitdir = path.resolve(path.dirname(absolute), match[1]);
    if (!(await inside(gitdir))) throw refuse();
  } else if (!entry.isDirectory()) throw refuse();
  let commondir: string;
  try {
    commondir = (await readFile(path.join(gitdir, "commondir"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw refuse();
  }
  if (!(await inside(path.resolve(gitdir, commondir)))) throw refuse();
}

function isProtected(relative: string, name: string) {
  const lower = name.toLowerCase();
  const lowerPath = relative.toLowerCase();
  return (
    PROTECTED_NAMES.has(lower) ||
    PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    PROTECTED_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
    lowerPath === PROTECTED_PATH ||
    lowerPath.endsWith(`/${PROTECTED_PATH}`)
  );
}

function count(budget: ScanBudget) {
  budget.scanned += 1;
  if (budget.scanned > budget.limits.maxScannedEntries)
    throw new ContainerBackendError("CONTAINER_DIRECTORY_SCAN_LIMIT");
}

function swapCase(name: string) {
  return [...name]
    .map((character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
    )
    .join("");
}

function contains(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}/`);
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
