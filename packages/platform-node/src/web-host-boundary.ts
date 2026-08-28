import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { HostSecretMaterialSource } from "./host-secret-source.js";

export interface IsolatedWebDownloadRecord {
  readonly id: string;
  readonly sourceUrl: string;
  readonly relativePath: string;
  readonly digest: string;
  readonly declaredMimeType: string;
  readonly sniffedMimeType: string;
  readonly sizeBytes: number;
  readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
  readonly executable: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class IsolatedWebDownloadStore {
  readonly #root: string;
  readonly #maximumBytes: number;

  constructor(input: { readonly root: string; readonly maximumBytes: number }) {
    if (!path.isAbsolute(input.root) || input.maximumBytes < 1)
      throw new Error("WEB_DOWNLOAD_ROOT_UNSAFE");
    this.#root = path.resolve(input.root);
    this.#maximumBytes = input.maximumBytes;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    await assertRestrictedDirectory(this.#root);
  }

  async put(input: {
    readonly sourceUrl: string;
    readonly declaredMimeType: string;
    readonly bytes: Uint8Array;
    readonly dataClassification: IsolatedWebDownloadRecord["dataClassification"];
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<IsolatedWebDownloadRecord> {
    if (input.bytes.byteLength > this.#maximumBytes || input.expiresAt <= input.createdAt) {
      throw new Error("WEB_DOWNLOAD_REJECTED");
    }
    const id = `web-download-${randomUUID()}`;
    const relativePath = `${id}.bin`;
    const target = this.#resolve(relativePath);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sniffedMimeType = sniffMime(input.bytes);
    return Object.freeze({
      id,
      sourceUrl: input.sourceUrl,
      relativePath,
      digest: `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`,
      declaredMimeType: input.declaredMimeType,
      sniffedMimeType,
      sizeBytes: input.bytes.byteLength,
      dataClassification: input.dataClassification,
      executable: isExecutableMime(sniffedMimeType),
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
  }

  async read(record: IsolatedWebDownloadRecord): Promise<Uint8Array> {
    const target = this.#resolve(record.relativePath);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error("WEB_DOWNLOAD_FILE_UNSAFE");
    }
    const bytes = new Uint8Array(await readFile(target));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== record.digest) throw new Error("WEB_DOWNLOAD_DIGEST_MISMATCH");
    return bytes;
  }

  async delete(record: IsolatedWebDownloadRecord): Promise<void> {
    await rm(this.#resolve(record.relativePath), { force: true });
  }

  async deleteExpired(records: readonly IsolatedWebDownloadRecord[], now: string): Promise<number> {
    let deleted = 0;
    for (const record of records) {
      if (record.expiresAt <= now) {
        await this.delete(record);
        deleted += 1;
      }
    }
    return deleted;
  }

  async listUnexpected(expected: readonly IsolatedWebDownloadRecord[]): Promise<readonly string[]> {
    const expectedPaths = new Set(expected.map(({ relativePath }) => relativePath));
    return (await readdir(this.#root)).filter((entry) => !expectedPaths.has(entry)).sort();
  }

  #resolve(relativePath: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(relativePath))
      throw new Error("WEB_DOWNLOAD_PATH_UNSAFE");
    const target = path.resolve(this.#root, relativePath);
    if (!target.startsWith(`${this.#root}${path.sep}`)) throw new Error("WEB_DOWNLOAD_PATH_UNSAFE");
    return target;
  }
}

interface StoredSessionEnvelope {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly authenticationTag: string;
  readonly ciphertext: string;
}

export interface BrowserSessionHandle {
  readonly ref: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly expiresAt: string;
}

export class HostBoundBrowserSessionStore {
  readonly #root: string;
  readonly #hostId: string;
  readonly #keys: HostSecretMaterialSource;
  readonly #keyRef: string;
  readonly #keyVersion: string;
  readonly #handles = new Map<string, BrowserSessionHandle>();

  constructor(input: {
    readonly root: string;
    readonly hostId: string;
    readonly keys: HostSecretMaterialSource;
    readonly keyRef: string;
    readonly keyVersion: string;
  }) {
    if (!path.isAbsolute(input.root) || input.hostId.length === 0)
      throw new Error("WEB_SESSION_ROOT_UNSAFE");
    this.#root = path.resolve(input.root);
    this.#hostId = input.hostId;
    this.#keys = input.keys;
    this.#keyRef = input.keyRef;
    this.#keyVersion = input.keyVersion;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    await assertRestrictedDirectory(this.#root);
  }

  async seal(sessionId: string, plaintext: Uint8Array): Promise<string> {
    const key = await this.#key();
    const nonce = randomBytes(12);
    const aad = Buffer.from(`${this.#hostId}\0${sessionId}`);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: StoredSessionEnvelope = {
      schemaVersion: 1,
      hostId: this.#hostId,
      sessionId,
      nonce: nonce.toString("base64url"),
      authenticationTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    const target = this.#sessionPath(sessionId);
    const handle = await open(target, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(envelope));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, 0o600);
    return `web-session-secret:${sessionId}`;
  }

  issueHandle(input: {
    readonly sessionId: string;
    readonly expiresAt: string;
    readonly now: string;
  }): BrowserSessionHandle {
    if (input.expiresAt <= input.now) throw new Error("WEB_SESSION_HANDLE_EXPIRED");
    const handle = Object.freeze({
      ref: `web-session-handle:${randomUUID()}`,
      sessionId: input.sessionId,
      hostId: this.#hostId,
      expiresAt: input.expiresAt,
    });
    this.#handles.set(handle.ref, handle);
    return handle;
  }

  async consumeHandle(handleRef: string, now: string): Promise<Uint8Array> {
    const handle = this.#handles.get(handleRef);
    this.#handles.delete(handleRef);
    if (!handle || handle.hostId !== this.#hostId || handle.expiresAt <= now) {
      throw new Error("WEB_SESSION_HANDLE_UNAVAILABLE");
    }
    const raw = JSON.parse(
      await readFile(this.#sessionPath(handle.sessionId), "utf8"),
    ) as StoredSessionEnvelope;
    if (
      raw.schemaVersion !== 1 ||
      raw.hostId !== this.#hostId ||
      raw.sessionId !== handle.sessionId
    ) {
      throw new Error("WEB_SESSION_ENVELOPE_SCOPE_INVALID");
    }
    const key = await this.#key();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(raw.nonce, "base64url"));
    decipher.setAAD(Buffer.from(`${this.#hostId}\0${handle.sessionId}`));
    decipher.setAuthTag(Buffer.from(raw.authenticationTag, "base64url"));
    return new Uint8Array(
      Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, "base64url")), decipher.final()]),
    );
  }

  async revoke(sessionId: string): Promise<void> {
    await rm(this.#sessionPath(sessionId), { force: true });
    for (const [handleRef, handle] of this.#handles) {
      if (handle.sessionId === sessionId) this.#handles.delete(handleRef);
    }
  }

  invalidateHandles(): void {
    this.#handles.clear();
  }

  async #key(): Promise<Uint8Array> {
    const key = await this.#keys.resolve(this.#keyRef, this.#keyVersion);
    if (key.byteLength !== 32) throw new Error("WEB_SESSION_KEY_INVALID");
    return key;
  }

  #sessionPath(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId))
      throw new Error("WEB_SESSION_ID_UNSAFE");
    return path.join(this.#root, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  }
}

async function assertRestrictedDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error("WEB_HOST_DIRECTORY_UNSAFE");
}

function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
    return "application/x-elf";
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return "application/x-msdownload";
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe)
    return "application/x-mach-binary";
  if (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe)
    return "application/x-mach-binary";
  const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html")) return "text/html";
  if (prefix.startsWith("{") || prefix.startsWith("[")) return "application/json";
  return "application/octet-stream";
}

function isExecutableMime(mimeType: string): boolean {
  return ["application/x-elf", "application/x-msdownload", "application/x-mach-binary"].includes(
    mimeType,
  );
}
