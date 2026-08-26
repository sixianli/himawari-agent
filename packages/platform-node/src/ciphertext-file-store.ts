import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PayloadRecord, PayloadStorePort } from "@himawari-agent/application";

export const CIPHERTEXT_STORE_ERROR_CODES = Object.freeze({
  ROOT_UNSAFE: "CIPHERTEXT_STORE_ROOT_UNSAFE",
  FILE_MISSING: "CIPHERTEXT_STORE_FILE_MISSING",
  FILE_UNSAFE: "CIPHERTEXT_STORE_FILE_UNSAFE",
  DIGEST_MISMATCH: "CIPHERTEXT_STORE_DIGEST_MISMATCH",
  ORPHAN_DETECTED: "CIPHERTEXT_STORE_ORPHAN_DETECTED",
} as const);

export type CiphertextStoreErrorCode =
  (typeof CIPHERTEXT_STORE_ERROR_CODES)[keyof typeof CIPHERTEXT_STORE_ERROR_CODES];

export class CiphertextStoreIntegrityError extends Error {
  readonly code: CiphertextStoreErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: CiphertextStoreErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "CiphertextStoreIntegrityError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface CiphertextFileReference {
  readonly relativePath: string;
  readonly ciphertextDigest: string;
  readonly created: boolean;
}

export interface CiphertextIntegrityReport {
  readonly checked: number;
  readonly missing: readonly string[];
  readonly corrupt: readonly string[];
  readonly orphans: readonly string[];
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function relativePathForDigest(ciphertextDigest: string): string {
  const hex = ciphertextDigest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new CiphertextStoreIntegrityError(
      CIPHERTEXT_STORE_ERROR_CODES.DIGEST_MISMATCH,
      "Ciphertext digest is not a canonical SHA-256 digest",
    );
  }
  return path.posix.join("sha256", hex.slice(0, 2), `${hex}.bin`);
}

async function filesRecursively(directory: string): Promise<readonly string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesRecursively(entryPath)));
    if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

export class ContentAddressedCiphertextStore {
  readonly #root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.ROOT_UNSAFE,
        "Ciphertext root must be an absolute path",
      );
    }
    this.#root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const info = await stat(this.#root);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.ROOT_UNSAFE,
        "Ciphertext root permissions are not restricted",
      );
    }
  }

  async put(ciphertext: Uint8Array): Promise<CiphertextFileReference> {
    const ciphertextDigest = digest(ciphertext);
    const relativePath = relativePathForDigest(ciphertextDigest);
    const absolutePath = this.#absolute(relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      const handle = await open(
        absolutePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
        created = true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.read({ relativePath, ciphertextDigest });
    return Object.freeze({ relativePath, ciphertextDigest, created });
  }

  async read(reference: Omit<CiphertextFileReference, "created">): Promise<Uint8Array> {
    const expectedPath = relativePathForDigest(reference.ciphertextDigest);
    if (reference.relativePath !== expectedPath) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.DIGEST_MISMATCH,
        "Ciphertext path does not match its digest",
      );
    }
    const absolutePath = this.#absolute(reference.relativePath);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (!info) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.FILE_MISSING,
        "Ciphertext file is missing",
        { relativePath: reference.relativePath },
      );
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.FILE_UNSAFE,
        "Ciphertext file type or permissions are unsafe",
        { relativePath: reference.relativePath },
      );
    }
    await access(absolutePath, constants.R_OK);
    const value = new Uint8Array(await readFile(absolutePath));
    if (digest(value) !== reference.ciphertextDigest) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.DIGEST_MISMATCH,
        "Ciphertext file digest does not match",
        { relativePath: reference.relativePath },
      );
    }
    return value;
  }

  async delete(reference: Omit<CiphertextFileReference, "created">): Promise<boolean> {
    const absolutePath = this.#absolute(reference.relativePath);
    const existed = await access(absolutePath, constants.F_OK).then(
      () => true,
      () => false,
    );
    if (existed) await rm(absolutePath);
    return existed;
  }

  async inspect(
    expected: readonly Omit<CiphertextFileReference, "created">[],
  ): Promise<CiphertextIntegrityReport> {
    const expectedPaths = new Set(expected.map(({ relativePath }) => relativePath));
    const missing: string[] = [];
    const corrupt: string[] = [];
    for (const reference of expected) {
      try {
        await this.read(reference);
      } catch (error) {
        if (
          error instanceof CiphertextStoreIntegrityError &&
          error.code === CIPHERTEXT_STORE_ERROR_CODES.FILE_MISSING
        ) {
          missing.push(reference.relativePath);
        } else {
          corrupt.push(reference.relativePath);
        }
      }
    }
    const orphans = (await filesRecursively(this.#root))
      .map((filePath) => path.relative(this.#root, filePath).split(path.sep).join("/"))
      .filter((relativePath) => !expectedPaths.has(relativePath))
      .sort();
    return Object.freeze({
      checked: expected.length,
      missing: Object.freeze(missing.sort()),
      corrupt: Object.freeze(corrupt.sort()),
      orphans: Object.freeze(orphans),
    });
  }

  #absolute(relativePath: string): string {
    const absolutePath = path.resolve(this.#root, relativePath);
    if (!absolutePath.startsWith(`${this.#root}${path.sep}`)) {
      throw new CiphertextStoreIntegrityError(
        CIPHERTEXT_STORE_ERROR_CODES.ROOT_UNSAFE,
        "Ciphertext path escapes the configured root",
      );
    }
    return absolutePath;
  }
}

export class HybridPayloadStore implements PayloadStorePort {
  readonly #metadata: PayloadStorePort;
  readonly #files: ContentAddressedCiphertextStore;
  readonly #fileThresholdBytes: number;

  constructor(options: {
    readonly metadata: PayloadStorePort;
    readonly files: ContentAddressedCiphertextStore;
    readonly fileThresholdBytes: number;
  }) {
    this.#metadata = options.metadata;
    this.#files = options.files;
    this.#fileThresholdBytes = options.fileThresholdBytes;
  }

  async put(payload: PayloadRecord): Promise<void> {
    if (payload.ciphertext.byteLength < this.#fileThresholdBytes) {
      await this.#metadata.put({ ...payload, storage: { kind: "inline" } });
      return;
    }
    const reference = await this.#files.put(payload.ciphertext);
    try {
      await this.#metadata.put({
        ...payload,
        ciphertext: new Uint8Array(),
        storage: {
          kind: "ciphertext_file",
          relativePath: reference.relativePath,
          ciphertextDigest: reference.ciphertextDigest,
        },
      });
    } catch (error) {
      if (reference.created) await this.#files.delete(reference);
      throw error;
    }
  }

  async get(ref: string): Promise<PayloadRecord | undefined> {
    const payload = await this.#metadata.get(ref);
    if (!payload || payload.storage?.kind !== "ciphertext_file") return payload;
    const ciphertext = await this.#files.read(payload.storage);
    return Object.freeze({ ...payload, ciphertext });
  }

  async delete(ref: string): Promise<boolean> {
    const payload = await this.#metadata.get(ref);
    const deleted = await this.#metadata.delete(ref);
    if (deleted && payload?.storage?.kind === "ciphertext_file") {
      await this.#files.delete(payload.storage);
    }
    return deleted;
  }
}
