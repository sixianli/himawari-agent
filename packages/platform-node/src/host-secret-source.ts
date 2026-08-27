import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type HostSecretSourceKind =
  | "macos-keychain"
  | "systemd-credential"
  | "restricted-secret-file"
  | "environment-development"
  | "memory-development";

export interface HostSecretMaterialSource {
  readonly kind: HostSecretSourceKind;
  readonly productionSuitable: boolean;
  resolve(secretRef: string, secretVersion: string): Promise<Uint8Array>;
}

export type HostProviderSecretSourceKind = Extract<
  HostSecretSourceKind,
  "macos-keychain" | "systemd-credential" | "restricted-secret-file"
>;

/**
 * Provider credentials are opaque text values, not fixed-size encryption keys.
 * Implementations must return the value only to the trusted adapter boundary.
 */
export interface HostProviderSecretSource {
  readonly kind: HostProviderSecretSourceKind;
  readonly productionSuitable: boolean;
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export const HOST_SECRET_ERROR_CODES = Object.freeze({
  INVALID_REFERENCE: "HOST_SECRET_INVALID_REFERENCE",
  SOURCE_UNSAFE: "HOST_SECRET_SOURCE_UNSAFE",
  NOT_FOUND: "HOST_SECRET_NOT_FOUND",
  READ_FAILED: "HOST_SECRET_READ_FAILED",
  INVALID_KEY_MATERIAL: "HOST_SECRET_INVALID_KEY_MATERIAL",
  INVALID_SECRET_MATERIAL: "HOST_SECRET_INVALID_SECRET_MATERIAL",
} as const);

export type HostSecretErrorCode =
  (typeof HOST_SECRET_ERROR_CODES)[keyof typeof HOST_SECRET_ERROR_CODES];

export class HostSecretError extends Error {
  readonly code: HostSecretErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: HostSecretErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "HostSecretError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function assertReferencePart(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.INVALID_REFERENCE,
      `Secret ${label} is not a safe reference component`,
      { label },
    );
  }
}

function decodeKeyMaterial(value: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(value).trim();
  const decoded = /^[A-Za-z0-9+/]{43}=$/.test(text)
    ? Buffer.from(text, "base64")
    : /^[a-f0-9]{64}$/i.test(text)
      ? Buffer.from(text, "hex")
      : Buffer.from(value);
  if (decoded.byteLength !== 32) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.INVALID_KEY_MATERIAL,
      "Secret key material must decode to exactly 32 bytes",
      { actualBytes: String(decoded.byteLength) },
    );
  }
  return new Uint8Array(decoded);
}

function assertRestrictedMode(mode: number, target: string): void {
  if ((mode & 0o077) !== 0) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
      "Secret material permissions permit group or other access",
      { resource: target },
    );
  }
}

export function assertProductionSecretSource(
  source: HostSecretMaterialSource | HostProviderSecretSource,
): void {
  if (!source.productionSuitable) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
      "Development secret sources are forbidden in production or public profiles",
      { sourceKind: source.kind },
    );
  }
}

async function restrictedSecretFilePath(
  directory: string,
  secretRef: string,
  secretVersion: string,
): Promise<string> {
  assertReferencePart(secretRef, "reference");
  assertReferencePart(secretVersion, "version");
  const directoryInfo = await stat(directory).catch(() => undefined);
  if (!directoryInfo?.isDirectory()) {
    throw new HostSecretError(HOST_SECRET_ERROR_CODES.NOT_FOUND, "Secret directory is missing");
  }
  assertRestrictedMode(directoryInfo.mode, "secret-directory");
  if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
      "Secret directory is not owned by the service account",
      { resource: "secret-directory" },
    );
  }

  const filePath = path.join(directory, `${secretRef}.${secretVersion}`);
  const fileInfo = await lstat(filePath).catch(() => undefined);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
    throw new HostSecretError(HOST_SECRET_ERROR_CODES.NOT_FOUND, "Secret material is missing");
  }
  assertRestrictedMode(fileInfo.mode, "secret-file");
  if (typeof process.getuid === "function" && fileInfo.uid !== process.getuid()) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
      "Secret file is not owned by the service account",
      { resource: "secret-file" },
    );
  }
  return filePath;
}

async function readRestrictedSecretFile(
  directory: string,
  secretRef: string,
  secretVersion: string,
): Promise<Uint8Array> {
  const filePath = await restrictedSecretFilePath(directory, secretRef, secretVersion);
  try {
    await access(filePath, constants.R_OK);
    return new Uint8Array(await readFile(filePath));
  } catch (error) {
    if (error instanceof HostSecretError) throw error;
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.READ_FAILED,
      "Secret material could not be read",
    );
  }
}

function decodeOpaqueSecret(value: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value).trim();
  } catch {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.INVALID_SECRET_MATERIAL,
      "Provider secret material must be valid UTF-8 text",
    );
  }
  const containsControlCharacter = [...decoded].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (decoded.length === 0 || decoded.length > 4096 || containsControlCharacter) {
    throw new HostSecretError(
      HOST_SECRET_ERROR_CODES.INVALID_SECRET_MATERIAL,
      "Provider secret material must be bounded printable text",
    );
  }
  return decoded;
}

export class RestrictedSecretFileSource implements HostSecretMaterialSource {
  readonly kind: HostSecretSourceKind = "restricted-secret-file";
  readonly productionSuitable = true;
  readonly #directory: string;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) {
      throw new HostSecretError(
        HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
        "Secret directory must be an absolute path",
      );
    }
    this.#directory = path.resolve(directory);
  }

  async resolve(secretRef: string, secretVersion: string): Promise<Uint8Array> {
    return decodeKeyMaterial(
      await readRestrictedSecretFile(this.#directory, secretRef, secretVersion),
    );
  }
}

export class SystemdCredentialSecretSource extends RestrictedSecretFileSource {
  override readonly kind = "systemd-credential" as const;
}

export class MacOsKeychainSecretSource implements HostSecretMaterialSource {
  readonly kind = "macos-keychain" as const;
  readonly productionSuitable = true;
  readonly #servicePrefix: string;
  readonly #account: string;

  constructor(options: { readonly servicePrefix: string; readonly account: string }) {
    assertReferencePart(options.servicePrefix, "service prefix");
    assertReferencePart(options.account, "account");
    this.#servicePrefix = options.servicePrefix;
    this.#account = options.account;
  }

  async resolve(secretRef: string, secretVersion: string): Promise<Uint8Array> {
    assertReferencePart(secretRef, "reference");
    assertReferencePart(secretVersion, "version");
    const service = `${this.#servicePrefix}.${secretRef}.${secretVersion}`;
    try {
      const { stdout } = await execFile(
        "/usr/bin/security",
        ["find-generic-password", "-a", this.#account, "-s", service, "-w"],
        { encoding: "buffer", maxBuffer: 4096 },
      );
      return decodeKeyMaterial(new Uint8Array(stdout));
    } catch {
      throw new HostSecretError(
        HOST_SECRET_ERROR_CODES.NOT_FOUND,
        "Keychain secret material could not be resolved",
        { secretRef, secretVersion },
      );
    }
  }
}

export class RestrictedProviderSecretSource implements HostProviderSecretSource {
  readonly kind: HostProviderSecretSourceKind = "restricted-secret-file";
  readonly productionSuitable = true;
  readonly #directory: string;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) {
      throw new HostSecretError(
        HOST_SECRET_ERROR_CODES.SOURCE_UNSAFE,
        "Secret directory must be an absolute path",
      );
    }
    this.#directory = path.resolve(directory);
  }

  async resolve(secretRef: string, secretVersion: string): Promise<string> {
    return decodeOpaqueSecret(
      await readRestrictedSecretFile(this.#directory, secretRef, secretVersion),
    );
  }
}

export class SystemdProviderSecretSource extends RestrictedProviderSecretSource {
  override readonly kind = "systemd-credential" as const;
}

export class MacOsKeychainProviderSecretSource implements HostProviderSecretSource {
  readonly kind = "macos-keychain" as const;
  readonly productionSuitable = true;
  readonly #servicePrefix: string;
  readonly #account: string;

  constructor(options: { readonly servicePrefix: string; readonly account: string }) {
    assertReferencePart(options.servicePrefix, "service prefix");
    assertReferencePart(options.account, "account");
    this.#servicePrefix = options.servicePrefix;
    this.#account = options.account;
  }

  async resolve(secretRef: string, secretVersion: string): Promise<string> {
    assertReferencePart(secretRef, "reference");
    assertReferencePart(secretVersion, "version");
    const service = `${this.#servicePrefix}.${secretRef}.${secretVersion}`;
    try {
      const { stdout } = await execFile(
        "/usr/bin/security",
        ["find-generic-password", "-a", this.#account, "-s", service, "-w"],
        { encoding: "buffer", maxBuffer: 4096 },
      );
      return decodeOpaqueSecret(new Uint8Array(stdout));
    } catch (error) {
      if (error instanceof HostSecretError) throw error;
      throw new HostSecretError(
        HOST_SECRET_ERROR_CODES.NOT_FOUND,
        "Keychain provider secret could not be resolved",
        { secretRef, secretVersion },
      );
    }
  }
}

export class InMemoryDevelopmentSecretSource implements HostSecretMaterialSource {
  readonly kind = "memory-development" as const;
  readonly productionSuitable = false;
  readonly #materials: ReadonlyMap<string, Uint8Array>;

  constructor(materials: Readonly<Record<string, Uint8Array>>) {
    this.#materials = new Map(
      Object.entries(materials).map(([key, value]) => [key, new Uint8Array(value)]),
    );
  }

  async resolve(secretRef: string, secretVersion: string): Promise<Uint8Array> {
    const value = this.#materials.get(`${secretRef}@${secretVersion}`);
    if (!value) {
      throw new HostSecretError(HOST_SECRET_ERROR_CODES.NOT_FOUND, "Secret material is missing", {
        secretRef,
        secretVersion,
      });
    }
    return new Uint8Array(value);
  }
}

export class EnvironmentDevelopmentSecretSource implements HostSecretMaterialSource {
  readonly kind = "environment-development" as const;
  readonly productionSuitable = false;
  readonly #prefix: string;

  constructor(prefix = "HIMAWARI_DEV_SECRET_") {
    this.#prefix = prefix;
  }

  async resolve(secretRef: string, secretVersion: string): Promise<Uint8Array> {
    assertReferencePart(secretRef, "reference");
    assertReferencePart(secretVersion, "version");
    const name = `${this.#prefix}${secretRef}_${secretVersion}`.replace(/[^A-Za-z0-9_]/g, "_");
    const value = process.env[name];
    if (!value) {
      throw new HostSecretError(HOST_SECRET_ERROR_CODES.NOT_FOUND, "Secret material is missing", {
        secretRef,
        secretVersion,
      });
    }
    return decodeKeyMaterial(new TextEncoder().encode(value));
  }
}
