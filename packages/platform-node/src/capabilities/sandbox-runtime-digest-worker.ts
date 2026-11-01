import { createHash, randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { parentPort, threadId, workerData } from "node:worker_threads";

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const RACY_WINDOW_NS = 2_000_000_000n;

interface CachedFile {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mode: string;
  readonly uid: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly sha256: string;
}

type FingerprintCache = ReadonlyMap<string, CachedFile>;

function fingerprintOf(metadata: BigIntStats, sha256: string): CachedFile {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    mode: String(metadata.mode),
    uid: String(metadata.uid),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
    sha256,
  };
}

function fingerprintMatches(entry: CachedFile | undefined, metadata: BigIntStats): boolean {
  return (
    entry !== undefined &&
    entry.dev === String(metadata.dev) &&
    entry.ino === String(metadata.ino) &&
    entry.size === String(metadata.size) &&
    entry.mode === String(metadata.mode) &&
    entry.uid === String(metadata.uid) &&
    entry.mtimeNs === String(metadata.mtimeNs) &&
    entry.ctimeNs === String(metadata.ctimeNs)
  );
}

function isRacy(metadata: BigIntStats, startedAtNs: bigint): boolean {
  return (
    metadata.ctimeNs + RACY_WINDOW_NS > startedAtNs ||
    metadata.mtimeNs + RACY_WINDOW_NS > startedAtNs
  );
}

function loadFingerprintCache(
  filename: string,
  root: string,
  trustedUid: number,
): FingerprintCache {
  const empty = new Map<string, CachedFile>();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.size > MAX_CACHE_BYTES ||
      (info.mode & 0o022) !== 0 ||
      info.uid !== trustedUid
    )
      return empty;
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as {
      version?: unknown;
      root?: unknown;
      files?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.root !== root ||
      typeof parsed.files !== "object" ||
      !parsed.files
    )
      return empty;
    const result = new Map<string, CachedFile>();
    for (const [relative, value] of Object.entries(parsed.files as Record<string, unknown>)) {
      const entry = value as Partial<Record<keyof CachedFile, unknown>>;
      if (
        !entry ||
        !(["dev", "ino", "size", "mode", "uid", "mtimeNs", "ctimeNs"] as const).every(
          (key) => typeof entry[key] === "string" && /^[0-9]+$/.test(entry[key] as string),
        ) ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        return empty;
      result.set(relative, entry as CachedFile);
    }
    return result;
  } catch {
    return empty;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function saveFingerprintCache(
  filename: string,
  root: string,
  files: ReadonlyMap<string, CachedFile>,
): void {
  const temporary = `${filename}.${process.pid}.${threadId}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    const body = Buffer.from(
      JSON.stringify({ version: 1, root, files: Object.fromEntries(files) }),
    );
    if (body.length > MAX_CACHE_BYTES) return;
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    for (let offset = 0; offset < body.length; )
      offset += writeSync(descriptor, body, offset, body.length - offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filename);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

export interface SandboxRuntimeDigestRequest {
  readonly root: string;
  readonly fingerprintFile?: string;
  readonly fingerprintWriteFile?: string;
  readonly trustedUid?: number;
  readonly rebuild?: boolean;
}

function digestRuntime({
  root,
  fingerprintFile,
  fingerprintWriteFile,
  trustedUid = 0,
  rebuild = false,
}: SandboxRuntimeDigestRequest) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root)
    throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  const files: { path: string; sha256: string; bytes: number; mode: number }[] = [];
  const startedAtNs = BigInt(Date.now()) * 1_000_000n;
  const storeFile = fingerprintWriteFile ?? fingerprintFile;
  const known =
    fingerprintFile && !rebuild
      ? loadFingerprintCache(fingerprintFile, root, trustedUid)
      : undefined;
  const fresh = new Map<string, CachedFile>();
  let reused = 0;
  let hashed = 0;
  const buffer = Buffer.allocUnsafe(65536);
  const same = (a: BigIntStats, b: BigIntStats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs;
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
    const before = check(directory, true);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(filename, relative);
        continue;
      }
      const metadata = check(filename, false);
      const cached = known?.get(relative);
      const trusted =
        cached !== undefined &&
        metadata.uid === BigInt(trustedUid) &&
        fingerprintMatches(cached, metadata) &&
        !isRacy(metadata, startedAtNs);
      const sha256 = trusted ? cached.sha256 : digestFile(filename, metadata);
      if (trusted) reused += 1;
      else hashed += 1;
      if (!same(metadata, check(filename, false))) throw new Error("SANDBOX_HOST_CHANGED");
      if (storeFile && metadata.uid === BigInt(trustedUid) && !isRacy(metadata, startedAtNs))
        fresh.set(relative, fingerprintOf(metadata, sha256));
      files.push({
        path: relative,
        sha256,
        bytes: Number(metadata.size),
        mode: Number(metadata.mode) & 0o777,
      });
    }
    if (!same(before, check(directory, true))) throw new Error("SANDBOX_HOST_CHANGED");
  };
  if (realpathSync(root) !== root) throw new Error("SANDBOX_HOST_PATH_UNSAFE");
  visit(root, "");
  if (realpathSync(root) !== root) throw new Error("SANDBOX_HOST_CHANGED");
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (storeFile && hashed > 0 && fresh.size > 0) saveFingerprintCache(storeFile, root, fresh);
  return {
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    reused,
    hashed,
  };
}

if (parentPort) parentPort.postMessage(digestRuntime(workerData as SandboxRuntimeDigestRequest));
