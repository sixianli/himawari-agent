import { createHash } from "node:crypto";
import {
  type BigIntStats,
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

export interface SandboxRuntimeDigestRequest {
  readonly root: string;
  readonly mode: "digest" | "fingerprint";
}

/** A single worker owns its bounded read buffer and file descriptors. Synchronous
 * reads here avoid tens of thousands of libuv round trips without blocking the
 * Agent event loop. Digest mode reads every byte; fingerprint mode reads only the
 * inode metadata that any content, permission or replacement change must alter. */
function inspectRuntime({ root, mode }: SandboxRuntimeDigestRequest) {
  if (mode !== "digest" && mode !== "fingerprint")
    throw new Error("SANDBOX_HOST_DIGEST_MODE_INVALID");
  if (typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root)
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  const files: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const identities: string[] = [];
  const buffer = Buffer.allocUnsafe(65536);
  const same = (a: BigIntStats, b: BigIntStats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs;
  const identity = (relative: string, info: BigIntStats) =>
    [relative, info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeNs, info.ctimeNs].join(
      "\0",
    );
  const check = (filename: string, directory: boolean) => {
    const info = lstatSync(filename, { bigint: true });
    if (
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (Number(info.mode) & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        info.uid !== BigInt(process.getuid()) &&
        info.uid !== 0n)
    )
      throw new Error("SANDBOX_HOST_PATH_UNSAFE");
    return info;
  };
  const digestFile = (filename: string, metadata: BigIntStats) => {
    const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!same(metadata, opened)) throw new Error("SANDBOX_HOST_CHANGED");
      const hash = createHash("sha256");
      for (;;) {
        const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytes === 0) break;
        hash.update(buffer.subarray(0, bytes));
      }
      if (!same(opened, fstatSync(descriptor, { bigint: true })))
        throw new Error("SANDBOX_HOST_CHANGED");
      return hash.digest("hex");
    } finally {
      closeSync(descriptor);
    }
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
      if (mode === "digest") {
        const sha256 = digestFile(filename, metadata);
        if (!same(metadata, check(filename, false))) throw new Error("SANDBOX_HOST_CHANGED");
        files.push({
          path: relative,
          sha256,
          bytes: Number(metadata.size),
          mode: Number(metadata.mode) & 0o777,
        });
      }
      identities.push(identity(relative, metadata));
    }
    if (realpathSync(directory) !== directory || !same(before, check(directory, true)))
      throw new Error("SANDBOX_HOST_CHANGED");
    identities.push(identity(prefix, before));
  };
  visit(root, "");
  identities.sort();
  const fingerprint = createHash("sha256").update(identities.join("\n")).digest("hex");
  if (mode === "fingerprint") return { fingerprint };
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    fingerprint,
  };
}

if (parentPort) parentPort.postMessage(inspectRuntime(workerData as SandboxRuntimeDigestRequest));
