import { lstat, realpath } from "node:fs/promises";

export const OPTIONAL_TOOLCHAIN_PATHS = Object.freeze(["/lib64"]);

export async function resolveReadOnlyToolchainPaths(
  entries,
  { optional = OPTIONAL_TOOLCHAIN_PATHS, dedupe = true, io = { lstat, realpath } } = {},
) {
  const present = [];
  for (const entry of entries) {
    if (optional.includes(entry)) {
      try {
        await io.lstat(entry);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    present.push(entry);
  }
  const resolved = await Promise.all(present.map((entry) => io.realpath(entry)));
  return dedupe ? [...new Set(resolved)] : resolved;
}
