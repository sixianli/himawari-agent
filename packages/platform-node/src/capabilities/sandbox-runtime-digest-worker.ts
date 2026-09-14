import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

/** A single worker owns its bounded read buffer and file descriptors. Synchronous
 * reads here avoid tens of thousands of libuv round trips without blocking the
 * Agent event loop. Every invocation reads every byte; there is no result cache. */
function digestRuntime(root: string): string {
  if (!path.isAbsolute(root) || path.normalize(root) !== root)
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  const files: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const buffer = Buffer.allocUnsafe(65536);
  const same = (
    a: NonNullable<ReturnType<typeof lstatSync>>,
    b: NonNullable<ReturnType<typeof lstatSync>>,
  ) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs;
  const check = (filename: string, directory: boolean) => {
    const info = lstatSync(filename);
    if (
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0)
    )
      throw new Error("SANDBOX_HOST_PATH_UNSAFE");
    return info;
  };
  const visit = (directory: string, prefix: string) => {
    if (realpathSync(directory) !== directory) throw new Error("SANDBOX_HOST_PATH_UNSAFE");
    const before = check(directory, true);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(filename, relative);
        continue;
      }
      // Parent identity is rechecked after descendants. readdir names cannot
      // introduce path components; O_NOFOLLOW rejects a replaced symlink leaf.
      const metadata = check(filename, false);
      const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let sha256: string;
      try {
        const opened = fstatSync(descriptor);
        if (!same(metadata, opened)) throw new Error("SANDBOX_HOST_CHANGED");
        const hash = createHash("sha256");
        for (;;) {
          const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
          if (bytes === 0) break;
          hash.update(buffer.subarray(0, bytes));
        }
        if (!same(opened, fstatSync(descriptor))) throw new Error("SANDBOX_HOST_CHANGED");
        sha256 = hash.digest("hex");
      } finally {
        closeSync(descriptor);
      }
      if (!same(metadata, check(filename, false))) throw new Error("SANDBOX_HOST_CHANGED");
      files.push({ path: relative, sha256, bytes: metadata.size, mode: metadata.mode & 0o777 });
    }
    if (realpathSync(directory) !== directory || !same(before, check(directory, true)))
      throw new Error("SANDBOX_HOST_CHANGED");
  };
  visit(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

if (parentPort) parentPort.postMessage(digestRuntime(workerData as string));
