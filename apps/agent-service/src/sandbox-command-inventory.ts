import { access, constants, lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

export const SANDBOX_READ_ROOTS: readonly string[] = [
  "/usr/bin",
  "/usr/lib",
  "/usr/share",
  "/lib",
  "/lib64",
  "/dev",
  "/proc",
  "/etc/ssl",
  "/etc/hosts",
  "/etc/fonts",
  "/var/cache/fontconfig",
  "/etc/alternatives",
  "/usr/sbin",
  "/etc/mime.types",
  "/etc/magic",
  "/etc/locale.alias",
  "/etc/ld.so.cache",
];

export const SANDBOX_RUNTIME_COMMANDS: readonly string[] = ["bash", "node", "rg", "fd"];

export const SANDBOX_COMMAND_CANDIDATES: readonly string[] = [
  "awk",
  "sed",
  "grep",
  "egrep",
  "find",
  "xargs",
  "sort",
  "uniq",
  "cut",
  "tr",
  "head",
  "tail",
  "wc",
  "diff",
  "patch",
  "tee",
  "base64",
  "sha256sum",
  "which",
  "file",
  "column",
  "xxd",
  "tar",
  "gzip",
  "zip",
  "unzip",
  "jq",
  "git",
  "make",
  "python",
  "python3",
  "perl",
  "pandoc",
  "convert",
  "vi",
  "nano",
];

export interface SandboxCommandInventory {
  readonly available: readonly string[];
  readonly unavailable: readonly string[];
}

const MERGED_DIRECTORIES = ["/bin", "/sbin", "/lib", "/lib64"];
const LINK_LIMIT = 40;

function merged(value: string): string {
  const prefix = MERGED_DIRECTORIES.find(
    (entry) => value === entry || value.startsWith(`${entry}/`),
  );
  return prefix ? `/usr${value}` : value;
}

export function sandboxCanRead(value: string, roots: readonly string[]): boolean {
  const target = merged(value);
  return roots.some((root) => {
    const normalized = merged(root).replace(/\/$/, "");
    return target === normalized || target.startsWith(`${normalized}/`);
  });
}

async function commandReachable(start: string, roots: readonly string[]): Promise<boolean> {
  let current = start;
  for (let hops = 0; hops <= LINK_LIMIT; hops += 1) {
    const info = await lstat(current).catch(() => undefined);
    if (!info) return false;
    if (!info.isSymbolicLink()) {
      if (!info.isFile()) return false;
      return access(current, constants.X_OK).then(
        () => true,
        () => false,
      );
    }
    const target = await readlink(current);
    current = path.isAbsolute(target)
      ? path.normalize(target)
      : path.normalize(path.join(path.dirname(current), target));
    if (!sandboxCanRead(current, roots)) return false;
  }
  return false;
}

export async function inspectSandboxCommands(
  options: {
    readonly directories?: readonly string[];
    readonly roots?: readonly string[];
    readonly candidates?: readonly string[];
    readonly runtimeCommands?: readonly string[];
  } = {},
): Promise<SandboxCommandInventory> {
  const directories = options.directories ?? ["/usr/bin"];
  const roots = options.roots ?? SANDBOX_READ_ROOTS;
  const candidates = options.candidates ?? SANDBOX_COMMAND_CANDIDATES;
  const runtimeCommands = options.runtimeCommands ?? SANDBOX_RUNTIME_COMMANDS;
  const present = new Set<string>();
  for (const directory of directories) {
    if (!sandboxCanRead(directory, roots)) continue;
    for (const name of await readdir(directory).catch(() => [] as string[]))
      if (candidates.includes(name) && !present.has(name))
        if (await commandReachable(path.join(directory, name), roots)) present.add(name);
  }
  return Object.freeze({
    available: Object.freeze([
      ...runtimeCommands,
      ...candidates.filter((name) => present.has(name)),
    ]),
    unavailable: Object.freeze(candidates.filter((name) => !present.has(name))),
  });
}
