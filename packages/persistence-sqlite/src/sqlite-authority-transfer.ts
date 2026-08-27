import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AuthorityTransferPort,
  PayloadProtectorPort,
  PayloadRecord,
  TransferManifest,
} from "@himawari-agent/application";
import type {
  AgentId,
  DeploymentId,
  OwnerId,
  TransferId,
  TransferState,
} from "@himawari-agent/domain";
import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  createTransferId,
} from "@himawari-agent/domain";
import BetterSqlite3 from "better-sqlite3";
import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
} from "./migration-engine.js";
import { acquireStateRootLock } from "./state-root-lock.js";

const TRANSFER_SCHEMA = "himawari.authority-transfer.v1" as const;
const TRANSFER_ENCRYPTION = "aes-256-gcm-stream-files-v1" as const;
const TRANSFER_AUTHENTICATION = "hmac-sha256-v1" as const;
const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export const AUTHORITY_TRANSFER_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "AUTHORITY_TRANSFER_INVALID_INPUT",
  TARGET_NOT_STOPPED: "AUTHORITY_TRANSFER_TARGET_NOT_STOPPED",
  TARGET_NOT_EMPTY: "AUTHORITY_TRANSFER_TARGET_NOT_EMPTY",
  AUTHORITY_MISMATCH: "AUTHORITY_TRANSFER_AUTHORITY_MISMATCH",
  EPOCH_STALE: "AUTHORITY_TRANSFER_EPOCH_STALE",
  PACKAGE_EXISTS: "AUTHORITY_TRANSFER_PACKAGE_EXISTS",
  PACKAGE_NOT_FOUND: "AUTHORITY_TRANSFER_PACKAGE_NOT_FOUND",
  PACKAGE_INVALID: "AUTHORITY_TRANSFER_PACKAGE_INVALID",
  AUTHENTICATION_FAILED: "AUTHORITY_TRANSFER_AUTHENTICATION_FAILED",
  DIGEST_MISMATCH: "AUTHORITY_TRANSFER_DIGEST_MISMATCH",
  SCHEMA_INCOMPATIBLE: "AUTHORITY_TRANSFER_SCHEMA_INCOMPATIBLE",
  PAYLOAD_INVALID: "AUTHORITY_TRANSFER_PAYLOAD_INVALID",
  MEMORY_INCOMPATIBLE: "AUTHORITY_TRANSFER_MEMORY_INCOMPATIBLE",
  PREFLIGHT_REQUIRED: "AUTHORITY_TRANSFER_PREFLIGHT_REQUIRED",
  ALREADY_CONSUMED: "AUTHORITY_TRANSFER_ALREADY_CONSUMED",
  ATOMIC_COMMIT_FAILED: "AUTHORITY_TRANSFER_ATOMIC_COMMIT_FAILED",
} as const);

export type AuthorityTransferErrorCode =
  (typeof AUTHORITY_TRANSFER_ERROR_CODES)[keyof typeof AUTHORITY_TRANSFER_ERROR_CODES];

export class AuthorityTransferError extends Error {
  readonly code: AuthorityTransferErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: AuthorityTransferErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "AuthorityTransferError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface TransferKeySource {
  resolve(secretRef: string, secretVersion: string): Promise<Uint8Array>;
}

export interface TransferKeyDescriptor {
  readonly ref: string;
  readonly version: string;
}

export interface AuthorityFileCoordinator {
  markSourcePending(input: {
    readonly deploymentId: string;
    readonly transferId: string;
  }): Promise<void>;
  establishTargetInactive(input: {
    readonly deploymentId: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly sourceAuthorityEpoch: number;
    readonly transferId: string;
  }): Promise<void>;
  activateTarget(input: {
    readonly deploymentId: string;
    readonly transferId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
  }): Promise<void>;
}

export interface TransferActivationPreflight {
  check(input: {
    readonly transferId: string;
    readonly deploymentId: string;
    readonly authorityEpoch: number;
  }): Promise<{
    readonly secretReferencesReady: boolean;
    readonly doctorReady: boolean;
    readonly publicIngressReady: boolean;
    readonly evidenceRef: string;
  }>;
}

export type AuthorityTransferFaultStage =
  | "export.after-intent"
  | "export.after-authority-pending"
  | "export.after-checkpoint"
  | "export.after-snapshot"
  | "export.after-payload-rewrap"
  | "export.after-encryption"
  | "export.after-verification"
  | "import.after-authentication"
  | "import.after-decryption"
  | "import.after-payload-rewrap"
  | "import.after-diagnostics"
  | "import.after-data-commit"
  | "import.after-authority-file"
  | "activate.after-preflight"
  | "activate.after-database"
  | "activate.after-authority-file";

interface TransferFile {
  readonly logicalPath: string;
  readonly objectName: string;
  readonly sizeBytes: number;
  readonly plaintextDigest: string;
  readonly ciphertextDigest: string;
  readonly nonce: string;
  readonly authenticationTag: string;
}

interface TransferBundleManifest {
  readonly schema: typeof TRANSFER_SCHEMA;
  readonly transferId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly sourceDeploymentId: string;
  readonly targetDeploymentId: string;
  readonly sourceAuthorityEpoch: number;
  readonly targetAuthorityEpoch: number;
  readonly sourceFencingToken: number;
  readonly targetFencingToken: number;
  readonly productVersion: string;
  readonly schemaSequence: number;
  readonly adapterVersions: readonly string[];
  readonly memoryVersion: string;
  readonly createdAt: string;
  readonly retainUntil: string;
  readonly excludedSecretRefs: readonly string[];
  readonly exclusions: readonly ["cache", "logs", "runtime", "locks", "sockets", "secrets"];
  readonly encryption: {
    readonly algorithm: typeof TRANSFER_ENCRYPTION;
    readonly keyRef: string;
    readonly keyVersion: string;
    readonly wrappedDek: string;
    readonly wrapNonce: string;
    readonly wrapAuthenticationTag: string;
  };
  readonly files: readonly TransferFile[];
  readonly authentication: {
    readonly algorithm: typeof TRANSFER_AUTHENTICATION;
    readonly value: string;
  };
}

interface PayloadRow {
  readonly ref: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly dataClassification: PayloadRecord["dataClassification"];
  readonly contentType: string | null;
  readonly storageKind: "sqlite_blob" | "ciphertext_file";
  readonly ciphertext: Uint8Array | null;
  readonly ciphertextPath: string | null;
  readonly contentDigest: string;
  readonly encryptionMetadataJson: string | null;
  readonly createdAt: string;
}

export interface SqliteAuthorityTransferAdapterOptions {
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly packageRoot: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly deploymentId: DeploymentId;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly productVersion: string;
  readonly adapterVersions: readonly string[];
  readonly memoryVersion: string;
  readonly memoryStoragePath: string;
  readonly excludedSecretRefs: readonly string[];
  readonly keys: TransferKeySource;
  readonly packageKey: TransferKeyDescriptor;
  readonly packagePayloadKey: TransferKeyDescriptor;
  readonly activePayloadKey: TransferKeyDescriptor;
  readonly payloadProtector: PayloadProtectorPort;
  readonly authority: AuthorityFileCoordinator;
  readonly activationPreflight: TransferActivationPreflight;
  readonly now?: () => string;
  readonly random?: (length: number) => Uint8Array;
  readonly fault?: (
    stage: AuthorityTransferFaultStage,
    context: Readonly<{ temporaryRoot: string | null }>,
  ) => void | Promise<void>;
}

class HashingTransform extends Transform {
  readonly #hash = createHash("sha256");

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.#hash.update(chunk);
    callback(null, chunk);
  }

  digest(): string {
    return `sha256:${this.#hash.digest("hex")}`;
  }
}

function digest(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function safeIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
      `Authority-transfer ${label} is invalid`,
    );
  }
  return value;
}

function safeLogicalPath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized.includes("\\") ||
    !(
      normalized === "data/product.sqlite" ||
      normalized.startsWith("data/payload-ciphertext/") ||
      normalized.startsWith("data/memory/")
    )
  ) {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
      "Authority-transfer manifest path escapes its allowlist",
      { logicalPath: value },
    );
  }
  return normalized;
}

function fileAad(transferId: string, logicalPath: string): Uint8Array {
  return new TextEncoder().encode(
    stableJson({ schema: TRANSFER_ENCRYPTION, transferId, logicalPath }),
  );
}

function wrapAad(transferId: string, key: TransferKeyDescriptor): Uint8Array {
  return new TextEncoder().encode(
    stableJson({ schema: `${TRANSFER_ENCRYPTION}.dek-wrap`, transferId, ...key }),
  );
}

function derive(master: Uint8Array, purpose: "encryption" | "authentication"): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      master,
      new TextEncoder().encode(TRANSFER_SCHEMA),
      new TextEncoder().encode(purpose),
      32,
    ),
  );
}

function encryptBytes(plaintext: Uint8Array, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  return Object.freeze({
    ciphertext: new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()])),
    authenticationTag: new Uint8Array(cipher.getAuthTag()),
  });
}

function decryptBytes(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.AUTHENTICATION_FAILED,
      "Authority-transfer authentication failed",
    );
  }
}

async function restrictedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function payloadRows(database: InstanceType<typeof BetterSqlite3>): readonly PayloadRow[] {
  return database
    .prepare(
      `SELECT ref, owner_id AS ownerId, agent_id AS agentId,
        classification AS dataClassification, content_type AS contentType,
        storage_kind AS storageKind, ciphertext, ciphertext_path AS ciphertextPath,
        content_digest AS contentDigest,
        encryption_metadata_json AS encryptionMetadataJson, created_at AS createdAt
      FROM payloads WHERE lifecycle_state != 'deleted_verified' ORDER BY ref`,
    )
    .all() as PayloadRow[];
}

function schemaSequence(database: InstanceType<typeof BetterSqlite3>): number {
  return (
    (database.prepare("SELECT MAX(sequence) FROM schema_migration_ledger").pluck().get() as
      | number
      | null) ?? 0
  );
}

function assertIntegrity(database: InstanceType<typeof BetterSqlite3>): void {
  try {
    const quick = database.pragma("quick_check", { simple: true });
    const full = database.pragma("integrity_check", { simple: true });
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (quick !== "ok" || full !== "ok" || foreignKeys.length > 0) throw new Error("invalid");
  } catch {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
      "Authority-transfer SQLite integrity checks failed",
    );
  }
}

function payloadFromRow(row: PayloadRow, dataRoot: string): Promise<PayloadRecord> {
  return Promise.resolve().then(async () => {
    let encryption: PayloadRecord["encryption"];
    try {
      encryption = JSON.parse(row.encryptionMetadataJson ?? "null") as PayloadRecord["encryption"];
    } catch {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PAYLOAD_INVALID,
        "Authority-transfer Payload metadata is invalid",
        { payloadRef: row.ref },
      );
    }
    if (!encryption || typeof encryption !== "object") {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PAYLOAD_INVALID,
        "Authority-transfer Payload metadata is missing",
        { payloadRef: row.ref },
      );
    }
    const ciphertext =
      row.storageKind === "sqlite_blob"
        ? new Uint8Array(row.ciphertext ?? new Uint8Array())
        : new Uint8Array(
            await readFile(
              path.join(
                dataRoot,
                "payload-ciphertext",
                safeLogicalPath(`data/payload-ciphertext/${row.ciphertextPath ?? ""}`).replace(
                  "data/payload-ciphertext/",
                  "",
                ),
              ),
            ),
          );
    return Object.freeze({
      ref: row.ref,
      dataClassification: row.dataClassification,
      contentType: row.contentType ?? "application/octet-stream",
      ciphertext,
      encryption,
      storage:
        row.storageKind === "sqlite_blob"
          ? Object.freeze({ kind: "inline" as const })
          : Object.freeze({
              kind: "ciphertext_file" as const,
              relativePath: row.ciphertextPath as string,
              ciphertextDigest: encryption.ciphertextDigest ?? "unknown",
            }),
      contentDigest: row.contentDigest,
      createdAt: row.createdAt,
    });
  });
}

async function filesRecursively(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
        "Authority-transfer allowlist refuses symlinks",
      );
    }
    if (entry.isDirectory()) result.push(...(await filesRecursively(entryPath)));
    if (entry.isFile()) result.push(entryPath);
  }
  return Object.freeze(result);
}

function manifestWithoutAuthentication(manifest: TransferBundleManifest): unknown {
  const { authentication: _authentication, ...unsigned } = manifest;
  return unsigned;
}

function manifestAuthentication(manifest: TransferBundleManifest, key: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", key)
      .update(stableJson(manifestWithoutAuthentication(manifest)))
      .digest(),
  );
}

function parseManifest(value: unknown): TransferBundleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
      "Authority-transfer manifest is invalid",
    );
  }
  const candidate = value as Partial<TransferBundleManifest>;
  if (
    candidate.schema !== TRANSFER_SCHEMA ||
    typeof candidate.transferId !== "string" ||
    typeof candidate.ownerId !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.sourceDeploymentId !== "string" ||
    typeof candidate.targetDeploymentId !== "string" ||
    !Number.isSafeInteger(candidate.sourceAuthorityEpoch) ||
    !Number.isSafeInteger(candidate.targetAuthorityEpoch) ||
    (candidate.targetAuthorityEpoch as number) !== (candidate.sourceAuthorityEpoch as number) + 1 ||
    !Number.isSafeInteger(candidate.sourceFencingToken) ||
    !Number.isSafeInteger(candidate.targetFencingToken) ||
    (candidate.targetFencingToken as number) !== (candidate.sourceFencingToken as number) + 1 ||
    typeof candidate.productVersion !== "string" ||
    !Number.isSafeInteger(candidate.schemaSequence) ||
    !Array.isArray(candidate.adapterVersions) ||
    typeof candidate.memoryVersion !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.retainUntil !== "string" ||
    !Array.isArray(candidate.excludedSecretRefs) ||
    !Array.isArray(candidate.files) ||
    !candidate.encryption ||
    !candidate.authentication
  ) {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
      "Authority-transfer manifest fields are invalid",
    );
  }
  safeIdentity(candidate.transferId, "transfer ID");
  if (
    candidate.encryption.algorithm !== TRANSFER_ENCRYPTION ||
    typeof candidate.encryption.keyRef !== "string" ||
    typeof candidate.encryption.keyVersion !== "string" ||
    typeof candidate.encryption.wrappedDek !== "string" ||
    typeof candidate.encryption.wrapNonce !== "string" ||
    typeof candidate.encryption.wrapAuthenticationTag !== "string" ||
    candidate.authentication.algorithm !== TRANSFER_AUTHENTICATION ||
    typeof candidate.authentication.value !== "string"
  ) {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
      "Authority-transfer cryptographic metadata is invalid",
    );
  }
  const paths = new Set<string>();
  for (const file of candidate.files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.logicalPath !== "string" ||
      typeof file.objectName !== "string" ||
      !/^file-[0-9]{6}\.bin$/.test(file.objectName) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      typeof file.plaintextDigest !== "string" ||
      typeof file.ciphertextDigest !== "string" ||
      typeof file.nonce !== "string" ||
      typeof file.authenticationTag !== "string"
    ) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
        "Authority-transfer file metadata is invalid",
      );
    }
    safeLogicalPath(file.logicalPath);
    if (paths.has(file.logicalPath)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
        "Authority-transfer manifest contains duplicate paths",
      );
    }
    paths.add(file.logicalPath);
  }
  if (!paths.has("data/product.sqlite")) {
    throw new AuthorityTransferError(
      AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
      "Authority-transfer package does not contain product.sqlite",
    );
  }
  return candidate as TransferBundleManifest;
}

export class SqliteAuthorityTransferAdapter implements AuthorityTransferPort {
  readonly #options: SqliteAuthorityTransferAdapterOptions;
  readonly #now: () => string;
  readonly #random: (length: number) => Uint8Array;

  constructor(options: SqliteAuthorityTransferAdapterOptions) {
    const stateRoot = path.resolve(options.stateRoot);
    const databasePath = path.resolve(options.databasePath);
    if (
      !path.isAbsolute(options.stateRoot) ||
      !path.isAbsolute(options.databasePath) ||
      !path.isAbsolute(options.packageRoot) ||
      databasePath !== path.join(stateRoot, "data", "product.sqlite") ||
      options.authorityEpoch < 0 ||
      options.fencingToken < 0
    ) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
        "Authority-transfer adapter paths are invalid",
      );
    }
    this.#options = Object.freeze({
      ...options,
      stateRoot,
      databasePath,
      packageRoot: path.resolve(options.packageRoot),
    });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#random = options.random ?? ((length) => randomBytes(length));
  }

  async export(transfer: TransferState): Promise<TransferManifest> {
    this.#assertExportIntent(transfer);
    const transferId = safeIdentity(transfer.id, "transfer ID");
    const packageDirectory = path.join(this.#options.packageRoot, transferId);
    const temporaryPackage = path.join(
      this.#options.packageRoot,
      `.${transferId}.export-${process.pid}-${randomUUID()}`,
    );
    await restrictedDirectory(this.#options.packageRoot);
    if (await lstat(packageDirectory).catch(() => undefined)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_EXISTS,
        "Authority-transfer package already exists",
      );
    }
    const lock = await acquireStateRootLock(this.#options.stateRoot).catch(() => {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_STOPPED,
        "Authority-transfer export requires stopped services",
      );
    });
    const staging = path.join(
      this.#options.stateRoot,
      `.transfer-${transferId}-${process.pid}-${randomUUID()}`,
    );
    try {
      await this.#fault("export.after-intent");
      const source = new BetterSqlite3(this.#options.databasePath);
      try {
        source.pragma("foreign_keys = ON");
        this.#markExportPending(source, transfer);
        await this.#options.authority.markSourcePending({
          deploymentId: this.#options.deploymentId,
          transferId,
        });
        await this.#fault("export.after-authority-pending");
        source.pragma("wal_checkpoint(TRUNCATE)");
        assertIntegrity(source);
        await this.#fault("export.after-checkpoint");
        await restrictedDirectory(staging);
        await restrictedDirectory(path.join(staging, "data"));
        const snapshotPath = path.join(staging, "data", "product.sqlite");
        await source.backup(snapshotPath);
        await chmod(snapshotPath, 0o600);
        await this.#fault("export.after-snapshot", staging);
        const snapshot = new BetterSqlite3(snapshotPath);
        try {
          await this.#rewrapPayloads(
            snapshot,
            path.join(this.#options.stateRoot, "data"),
            this.#options.packagePayloadKey,
          );
          assertIntegrity(snapshot);
        } finally {
          snapshot.close();
        }
        await this.#fault("export.after-payload-rewrap", staging);
        const manifest = await this.#createPackage({
          transfer,
          staging,
          packageDirectory: temporaryPackage,
        });
        await this.#fault("export.after-encryption", temporaryPackage);
        const verified = await this.#verifyPackage(temporaryPackage);
        await rm(verified.temporaryRoot, { recursive: true });
        await this.#fault("export.after-verification", temporaryPackage);
        await rename(temporaryPackage, packageDirectory);
        await syncDirectory(this.#options.packageRoot);
        source
          .prepare(
            `UPDATE authority_transfers SET status = 'exported_verified', package_ref = ?
            WHERE id = ? AND status = 'exporting'`,
          )
          .run(packageDirectory, transferId);
        return this.#applicationManifest(manifest, packageDirectory);
      } finally {
        source.close();
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await rm(temporaryPackage, { recursive: true, force: true }).catch(() => undefined);
      await lock.release();
    }
  }

  async exportNamed(input: {
    readonly transferId: string;
    readonly targetDeploymentId: string;
  }): Promise<TransferManifest> {
    return this.export({
      id: createTransferId(input.transferId),
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      sourceDeploymentId: this.#options.deploymentId,
      targetDeploymentId: createDeploymentId(input.targetDeploymentId),
      status: "proposed",
      authorityEpoch: this.#options.authorityEpoch + 1,
      packageRef: null,
    });
  }

  async inspect(packageRef: string): Promise<TransferManifest> {
    const packageDirectory = this.#safePackageReference(packageRef);
    const manifest = await this.#readAuthenticatedManifest(packageDirectory);
    return this.#applicationManifest(manifest, packageDirectory);
  }

  async importToTemporary(
    manifestInput: TransferManifest,
    targetDirectory: string,
  ): Promise<{ readonly state: TransferState; readonly verificationRef: string }> {
    const packageDirectory = this.#safePackageReference(manifestInput.packageRef);
    const manifest = await this.#readAuthenticatedManifest(packageDirectory);
    this.#assertImportScope(manifest, manifestInput);
    await this.#fault("import.after-authentication", packageDirectory);
    if (!path.isAbsolute(targetDirectory)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
        "Authority-transfer import target must be absolute",
      );
    }
    const target = path.resolve(targetDirectory);
    if (await lstat(target).catch(() => undefined)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_EMPTY,
        "Authority-transfer temporary import target already exists",
      );
    }
    const verified = await this.#decryptAndVerify(packageDirectory, manifest, target);
    return Object.freeze({
      state: this.#stateFromManifest(manifest, "importing", packageDirectory),
      verificationRef: verified,
    });
  }

  async importPackage(packageRef: string): Promise<TransferState> {
    const packageDirectory = this.#safePackageReference(packageRef);
    const manifest = await this.#readAuthenticatedManifest(packageDirectory);
    this.#assertTargetManifest(manifest);
    await this.#fault("import.after-authentication", packageDirectory);
    const lock = await acquireStateRootLock(this.#options.stateRoot).catch(() => {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_STOPPED,
        "Authority-transfer import requires stopped services",
      );
    });
    const staging = path.join(
      path.dirname(this.#options.stateRoot),
      `.${path.basename(this.#options.stateRoot)}.import-${manifest.transferId}-${randomUUID()}`,
    );
    try {
      await this.#assertEmptyTarget();
      await this.#decryptAndVerify(packageDirectory, manifest, staging);
      await this.#fault("import.after-decryption", staging);
      const databasePath = path.join(staging, "data", "product.sqlite");
      const database = new BetterSqlite3(databasePath);
      try {
        const migrations = await loadBundledMigrations();
        const expectedSequence = migrations.at(-1)?.sequence ?? 0;
        const currentSequence = schemaSequence(database);
        if (currentSequence > expectedSequence) {
          throw new AuthorityTransferError(
            AUTHORITY_TRANSFER_ERROR_CODES.SCHEMA_INCOMPATIBLE,
            "Authority-transfer package schema is newer than this runtime",
          );
        }
        if (currentSequence < expectedSequence) {
          const migrationSnapshotPath = path.join(staging, "pre-forward-migration.sqlite");
          const migrationSnapshot = await createVerifiedMigrationSnapshot(
            database,
            migrationSnapshotPath,
          );
          applyMigrations(database, migrations, { snapshot: migrationSnapshot });
          await rm(migrationSnapshotPath, { force: true });
        }
        await this.#rewrapPayloads(
          database,
          path.join(staging, "data"),
          this.#options.activePayloadKey,
        );
        await this.#fault("import.after-payload-rewrap", staging);
        this.#prepareImportedDatabase(database, manifest, packageDirectory);
        assertIntegrity(database);
      } finally {
        database.close();
      }
      if (manifest.memoryVersion !== this.#options.memoryVersion) {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.MEMORY_INCOMPATIBLE,
          "Authority-transfer Memory adapter version is incompatible",
        );
      }
      await this.#fault("import.after-diagnostics", staging);
      const targetData = path.join(this.#options.stateRoot, "data");
      const entries = await readdir(targetData).catch(() => []);
      if (entries.length > 0) {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_EMPTY,
          "Authority-transfer target data partition is not empty",
        );
      }
      await rm(targetData, { recursive: true, force: true });
      await rename(path.join(staging, "data"), targetData);
      await syncDirectory(this.#options.stateRoot);
      await this.#fault("import.after-data-commit", this.#options.stateRoot);
      await this.#options.authority.establishTargetInactive({
        deploymentId: this.#options.deploymentId,
        ownerId: this.#options.ownerId,
        agentId: this.#options.agentId,
        sourceAuthorityEpoch: manifest.sourceAuthorityEpoch,
        transferId: manifest.transferId,
      });
      await this.#fault("import.after-authority-file", this.#options.stateRoot);
      return this.#stateFromManifest(manifest, "inactive_ready", packageDirectory);
    } catch (error) {
      const committed = await lstat(this.#options.databasePath).catch(() => undefined);
      if (!committed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await lock.release();
    }
  }

  async activate(
    transferIdInput: TransferId,
    expectedAuthorityEpoch: number,
  ): Promise<TransferState> {
    const transferId = safeIdentity(transferIdInput, "transfer ID");
    const lock = await acquireStateRootLock(this.#options.stateRoot).catch(() => {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_STOPPED,
        "Authority-transfer activation requires stopped services",
      );
    });
    try {
      const database = new BetterSqlite3(this.#options.databasePath);
      try {
        const row = database
          .prepare(
            `SELECT authority_transfers.source_deployment_id AS sourceDeploymentId,
              target_deployment_id AS targetDeploymentId,
              authority_transfers.authority_epoch AS authorityEpoch,
              authority_transfers.status, package_ref AS packageRef,
              consumed_at AS consumedAt, deployments.fencing_token AS sourceFencingToken
            FROM authority_transfers
            JOIN deployments ON deployments.id = authority_transfers.source_deployment_id
            WHERE authority_transfers.id = ?`,
          )
          .get(transferId) as
          | {
              sourceDeploymentId: string;
              targetDeploymentId: string;
              authorityEpoch: number;
              sourceFencingToken: number;
              status: string;
              packageRef: string | null;
              consumedAt: string | null;
            }
          | undefined;
        if (!row || row.targetDeploymentId !== this.#options.deploymentId) {
          throw new AuthorityTransferError(
            AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
            "Authority-transfer target state is missing",
          );
        }
        if (row.authorityEpoch !== expectedAuthorityEpoch) {
          throw new AuthorityTransferError(
            AUTHORITY_TRANSFER_ERROR_CODES.EPOCH_STALE,
            "Authority-transfer activation epoch is stale",
          );
        }
        const preflight = await this.#options.activationPreflight.check({
          transferId,
          deploymentId: this.#options.deploymentId,
          authorityEpoch: expectedAuthorityEpoch,
        });
        if (
          !preflight.secretReferencesReady ||
          !preflight.doctorReady ||
          !preflight.publicIngressReady ||
          !preflight.evidenceRef
        ) {
          throw new AuthorityTransferError(
            AUTHORITY_TRANSFER_ERROR_CODES.PREFLIGHT_REQUIRED,
            "Authority-transfer activation preflight is incomplete",
          );
        }
        await this.#fault("activate.after-preflight");
        if (row.status !== "activated") {
          if (row.status !== "inactive_ready" || row.consumedAt !== null) {
            throw new AuthorityTransferError(
              AUTHORITY_TRANSFER_ERROR_CODES.ALREADY_CONSUMED,
              "Authority-transfer is not activatable",
            );
          }
          database.transaction(() => {
            const retired = database
              .prepare(
                `UPDATE deployments SET status = 'retired', revision = revision + 1
                WHERE id = ? AND status = 'retired_pending_transfer' AND transfer_id = ?`,
              )
              .run(row.sourceDeploymentId, transferId).changes;
            const activated = database
              .prepare(
                `UPDATE deployments SET status = 'active', revision = revision + 1,
                  authority_epoch = ?, fencing_token = ?
                WHERE id = ? AND status = 'inactive_ready' AND transfer_id = ?`,
              )
              .run(
                expectedAuthorityEpoch,
                row.sourceFencingToken + 1,
                this.#options.deploymentId,
                transferId,
              ).changes;
            const consumed = database
              .prepare(
                `UPDATE authority_transfers SET status = 'activated', consumed_at = ?
                WHERE id = ? AND status = 'inactive_ready' AND consumed_at IS NULL`,
              )
              .run(this.#now(), transferId).changes;
            if (retired !== 1 || activated !== 1 || consumed !== 1) {
              throw new AuthorityTransferError(
                AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
                "Authority-transfer activation state changed concurrently",
              );
            }
          })();
        }
        await this.#fault("activate.after-database");
        await this.#options.authority.activateTarget({
          deploymentId: this.#options.deploymentId,
          transferId,
          authorityEpoch: expectedAuthorityEpoch,
          fencingToken: row.sourceFencingToken + 1,
        });
        await this.#fault("activate.after-authority-file");
        return Object.freeze({
          id: createTransferId(transferId),
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          sourceDeploymentId: createDeploymentId(row.sourceDeploymentId),
          targetDeploymentId: this.#options.deploymentId,
          status: "activated",
          authorityEpoch: row.authorityEpoch,
          packageRef: row.packageRef,
        });
      } finally {
        database.close();
      }
    } finally {
      await lock.release();
    }
  }

  async activateNamed(transferId: string, authorityEpoch: number): Promise<TransferState> {
    return this.activate(createTransferId(transferId), authorityEpoch);
  }

  async abandonNamed(transferIdInput: string): Promise<TransferState> {
    const transferId = safeIdentity(transferIdInput, "transfer ID");
    const lock = await acquireStateRootLock(this.#options.stateRoot).catch(() => {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_STOPPED,
        "Authority-transfer abandon requires stopped services",
      );
    });
    try {
      const database = new BetterSqlite3(this.#options.databasePath);
      try {
        const row = database
          .prepare(
            `SELECT source_deployment_id AS sourceDeploymentId,
              target_deployment_id AS targetDeploymentId, authority_epoch AS authorityEpoch,
              status, package_ref AS packageRef FROM authority_transfers WHERE id = ?`,
          )
          .get(transferId) as
          | {
              sourceDeploymentId: string;
              targetDeploymentId: string;
              authorityEpoch: number;
              status: string;
              packageRef: string | null;
            }
          | undefined;
        if (!row || row.status === "activated") {
          throw new AuthorityTransferError(
            AUTHORITY_TRANSFER_ERROR_CODES.ALREADY_CONSUMED,
            "Activated authority transfer cannot be abandoned",
          );
        }
        database
          .prepare("UPDATE authority_transfers SET status = 'abandoned' WHERE id = ?")
          .run(transferId);
        return Object.freeze({
          id: createTransferId(transferId),
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          sourceDeploymentId: createDeploymentId(row.sourceDeploymentId),
          targetDeploymentId: createDeploymentId(row.targetDeploymentId),
          status: "abandoned",
          authorityEpoch: row.authorityEpoch,
          packageRef: row.packageRef,
        });
      } finally {
        database.close();
      }
    } finally {
      await lock.release();
    }
  }

  async purgeExpiredPackages(asOf: string): Promise<readonly TransferId[]> {
    const cutoff = Date.parse(asOf);
    if (!Number.isFinite(cutoff)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
        "Authority-transfer retention cutoff is invalid",
      );
    }
    await restrictedDirectory(this.#options.packageRoot);
    const purged: TransferId[] = [];
    for (const entry of await readdir(this.#options.packageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(this.#options.packageRoot, entry.name);
      const manifest = await this.#readAuthenticatedManifest(directory).catch(() => undefined);
      if (!manifest || Date.parse(manifest.retainUntil) > cutoff) continue;
      await rm(directory, { recursive: true });
      purged.push(createTransferId(manifest.transferId));
    }
    return Object.freeze(purged);
  }

  async #createPackage(input: {
    transfer: TransferState;
    staging: string;
    packageDirectory: string;
  }): Promise<TransferBundleManifest> {
    await restrictedDirectory(input.packageDirectory);
    await restrictedDirectory(path.join(input.packageDirectory, "objects"));
    const database = new BetterSqlite3(path.join(input.staging, "data", "product.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    let sourceFiles: Array<{ logicalPath: string; absolutePath: string }>;
    let sequence: number;
    try {
      sequence = schemaSequence(database);
      sourceFiles = [
        {
          logicalPath: "data/product.sqlite",
          absolutePath: path.join(input.staging, "data", "product.sqlite"),
        },
      ];
      for (const row of payloadRows(database)) {
        if (row.storageKind !== "ciphertext_file" || !row.ciphertextPath) continue;
        sourceFiles.push({
          logicalPath: safeLogicalPath(`data/payload-ciphertext/${row.ciphertextPath}`),
          absolutePath: path.join(
            this.#options.stateRoot,
            "data",
            "payload-ciphertext",
            row.ciphertextPath,
          ),
        });
      }
    } finally {
      database.close();
    }
    for (const memoryFile of await filesRecursively(this.#options.memoryStoragePath)) {
      sourceFiles.push({
        logicalPath: safeLogicalPath(
          `data/memory/${path.relative(this.#options.memoryStoragePath, memoryFile).split(path.sep).join("/")}`,
        ),
        absolutePath: memoryFile,
      });
    }
    sourceFiles = [...new Map(sourceFiles.map((file) => [file.logicalPath, file])).values()].sort(
      (left, right) => left.logicalPath.localeCompare(right.logicalPath),
    );
    const master = await this.#resolveKey(this.#options.packageKey);
    const encryptionKey = derive(master, "encryption");
    const authenticationKey = derive(master, "authentication");
    const dek = this.#randomBytes(32);
    const wrapNonce = this.#randomBytes(12);
    const wrapped = encryptBytes(
      dek,
      encryptionKey,
      wrapNonce,
      wrapAad(input.transfer.id, this.#options.packageKey),
    );
    const files: TransferFile[] = [];
    for (const [index, source] of sourceFiles.entries()) {
      const objectName = `file-${String(index + 1).padStart(6, "0")}.bin`;
      files.push(
        await this.#encryptFile({
          transferId: input.transfer.id,
          logicalPath: source.logicalPath,
          sourcePath: source.absolutePath,
          targetPath: path.join(input.packageDirectory, "objects", objectName),
          objectName,
          key: dek,
        }),
      );
    }
    const createdAt = this.#now();
    const unsigned = Object.freeze({
      schema: TRANSFER_SCHEMA,
      transferId: input.transfer.id,
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      sourceDeploymentId: this.#options.deploymentId,
      targetDeploymentId: input.transfer.targetDeploymentId,
      sourceAuthorityEpoch: this.#options.authorityEpoch,
      targetAuthorityEpoch: input.transfer.authorityEpoch,
      sourceFencingToken: this.#options.fencingToken,
      targetFencingToken: this.#options.fencingToken + 1,
      productVersion: this.#options.productVersion,
      schemaSequence: sequence,
      adapterVersions: Object.freeze([...this.#options.adapterVersions].sort()),
      memoryVersion: this.#options.memoryVersion,
      createdAt,
      retainUntil: new Date(Date.parse(createdAt) + RETENTION_MILLISECONDS).toISOString(),
      excludedSecretRefs: Object.freeze([...this.#options.excludedSecretRefs].sort()),
      exclusions: Object.freeze([
        "cache",
        "logs",
        "runtime",
        "locks",
        "sockets",
        "secrets",
      ] as const),
      encryption: Object.freeze({
        algorithm: TRANSFER_ENCRYPTION,
        keyRef: this.#options.packageKey.ref,
        keyVersion: this.#options.packageKey.version,
        wrappedDek: encode(wrapped.ciphertext),
        wrapNonce: encode(wrapNonce),
        wrapAuthenticationTag: encode(wrapped.authenticationTag),
      }),
      files: Object.freeze(files),
    });
    const placeholder: TransferBundleManifest = Object.freeze({
      ...unsigned,
      authentication: Object.freeze({ algorithm: TRANSFER_AUTHENTICATION, value: "" }),
    });
    const manifest: TransferBundleManifest = Object.freeze({
      ...unsigned,
      authentication: Object.freeze({
        algorithm: TRANSFER_AUTHENTICATION,
        value: encode(manifestAuthentication(placeholder, authenticationKey)),
      }),
    });
    await writeFile(
      path.join(input.packageDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await syncDirectory(path.join(input.packageDirectory, "objects"));
    await syncDirectory(input.packageDirectory);
    return manifest;
  }

  async #encryptFile(input: {
    transferId: string;
    logicalPath: string;
    sourcePath: string;
    targetPath: string;
    objectName: string;
    key: Uint8Array;
  }): Promise<TransferFile> {
    const info = await lstat(input.sourcePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
        "Authority-transfer source file is missing or unsafe",
      );
    }
    const nonce = this.#randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce, { authTagLength: 16 });
    cipher.setAAD(fileAad(input.transferId, input.logicalPath));
    const plaintextHash = new HashingTransform();
    const ciphertextHash = new HashingTransform();
    await pipeline(
      createReadStream(input.sourcePath),
      plaintextHash,
      cipher,
      ciphertextHash,
      createWriteStream(input.targetPath, { flags: "wx", mode: 0o600 }),
    );
    return Object.freeze({
      logicalPath: input.logicalPath,
      objectName: input.objectName,
      sizeBytes: (await stat(input.sourcePath)).size,
      plaintextDigest: plaintextHash.digest(),
      ciphertextDigest: ciphertextHash.digest(),
      nonce: encode(nonce),
      authenticationTag: encode(cipher.getAuthTag()),
    });
  }

  async #verifyPackage(packageDirectory: string) {
    const manifest = await this.#readAuthenticatedManifest(packageDirectory);
    const temporaryRoot = path.join(
      path.dirname(packageDirectory),
      `.${manifest.transferId}.verify-${process.pid}-${randomUUID()}`,
    );
    const verificationRef = await this.#decryptAndVerify(packageDirectory, manifest, temporaryRoot);
    return Object.freeze({ manifest, temporaryRoot, verificationRef });
  }

  async #decryptAndVerify(
    packageDirectory: string,
    manifest: TransferBundleManifest,
    target: string,
  ): Promise<string> {
    await restrictedDirectory(target);
    await restrictedDirectory(path.join(target, "data"));
    await restrictedDirectory(path.join(target, "data", "payload-ciphertext"));
    await restrictedDirectory(path.join(target, "data", "memory"));
    try {
      const master = await this.#resolveKey({
        ref: manifest.encryption.keyRef,
        version: manifest.encryption.keyVersion,
      });
      const dek = decryptBytes(
        decode(manifest.encryption.wrappedDek),
        derive(master, "encryption"),
        decode(manifest.encryption.wrapNonce),
        decode(manifest.encryption.wrapAuthenticationTag),
        wrapAad(manifest.transferId, {
          ref: manifest.encryption.keyRef,
          version: manifest.encryption.keyVersion,
        }),
      );
      for (const file of manifest.files) {
        const sourcePath = path.join(packageDirectory, "objects", file.objectName);
        const targetPath = path.join(target, safeLogicalPath(file.logicalPath));
        await restrictedDirectory(path.dirname(targetPath));
        await this.#decryptFile({
          transferId: manifest.transferId,
          file,
          sourcePath,
          targetPath,
          key: dek,
        });
      }
      const database = new BetterSqlite3(path.join(target, "data", "product.sqlite"));
      try {
        assertIntegrity(database);
        if (schemaSequence(database) !== manifest.schemaSequence) {
          throw new AuthorityTransferError(
            AUTHORITY_TRANSFER_ERROR_CODES.SCHEMA_INCOMPATIBLE,
            "Authority-transfer schema sequence does not match its manifest",
          );
        }
        await this.#verifyPayloads(database, path.join(target, "data"));
      } finally {
        database.close();
      }
      return `transfer-verification:${manifest.transferId}:${digest(stableJson(manifest))}`;
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #decryptFile(input: {
    transferId: string;
    file: TransferFile;
    sourcePath: string;
    targetPath: string;
    key: Uint8Array;
  }): Promise<void> {
    const decipher = createDecipheriv("aes-256-gcm", input.key, decode(input.file.nonce), {
      authTagLength: 16,
    });
    decipher.setAAD(fileAad(input.transferId, input.file.logicalPath));
    decipher.setAuthTag(decode(input.file.authenticationTag));
    const ciphertextHash = new HashingTransform();
    const plaintextHash = new HashingTransform();
    try {
      await pipeline(
        createReadStream(input.sourcePath),
        ciphertextHash,
        decipher,
        plaintextHash,
        createWriteStream(input.targetPath, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.AUTHENTICATION_FAILED,
        "Authority-transfer file authentication failed",
      );
    }
    if (
      ciphertextHash.digest() !== input.file.ciphertextDigest ||
      plaintextHash.digest() !== input.file.plaintextDigest ||
      (await stat(input.targetPath)).size !== input.file.sizeBytes
    ) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.DIGEST_MISMATCH,
        "Authority-transfer file digest does not match",
      );
    }
  }

  async #readAuthenticatedManifest(packageDirectory: string): Promise<TransferBundleManifest> {
    const manifestPath = path.join(packageDirectory, "manifest.json");
    const info = await lstat(manifestPath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new AuthorityTransferError(
        info
          ? AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID
          : AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_NOT_FOUND,
        "Authority-transfer manifest is missing or unsafe",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.PACKAGE_INVALID,
        "Authority-transfer manifest is not valid JSON",
      );
    }
    const manifest = parseManifest(parsed);
    const master = await this.#resolveKey({
      ref: manifest.encryption.keyRef,
      version: manifest.encryption.keyVersion,
    });
    const expected = manifestAuthentication(manifest, derive(master, "authentication"));
    const actual = decode(manifest.authentication.value);
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.AUTHENTICATION_FAILED,
        "Authority-transfer manifest authentication failed",
      );
    }
    return manifest;
  }

  async #rewrapPayloads(
    database: InstanceType<typeof BetterSqlite3>,
    dataRoot: string,
    targetKey: TransferKeyDescriptor,
  ): Promise<void> {
    for (const row of payloadRows(database)) {
      const payload = await payloadFromRow(row, dataRoot);
      try {
        await this.#options.payloadProtector.unprotect({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          payload,
        });
        const rewrapped = await this.#options.payloadProtector.rewrap({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          payload,
          targetKeyRef: targetKey.ref,
          targetKekVersion: targetKey.version,
        });
        database
          .prepare("UPDATE payloads SET key_ref = ?, encryption_metadata_json = ? WHERE ref = ?")
          .run(targetKey.ref, JSON.stringify(rewrapped.encryption), row.ref);
      } catch {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.PAYLOAD_INVALID,
          "Authority-transfer Payload could not be authenticated and rewrapped",
          { payloadRef: row.ref },
        );
      }
    }
  }

  async #verifyPayloads(
    database: InstanceType<typeof BetterSqlite3>,
    dataRoot: string,
  ): Promise<void> {
    for (const row of payloadRows(database)) {
      const payload = await payloadFromRow(row, dataRoot);
      try {
        await this.#options.payloadProtector.unprotect({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          payload,
        });
      } catch {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.PAYLOAD_INVALID,
          "Authority-transfer Payload authentication failed",
          { payloadRef: row.ref },
        );
      }
    }
  }

  #markExportPending(database: InstanceType<typeof BetterSqlite3>, transfer: TransferState): void {
    database.transaction(() => {
      const deployment = database
        .prepare(
          `SELECT owner_id AS ownerId, agent_id AS agentId, status,
            authority_epoch AS authorityEpoch, fencing_token AS fencingToken
          FROM deployments WHERE id = ?`,
        )
        .get(this.#options.deploymentId) as
        | {
            ownerId: string;
            agentId: string;
            status: string;
            authorityEpoch: number;
            fencingToken: number;
          }
        | undefined;
      if (
        !deployment ||
        deployment.ownerId !== this.#options.ownerId ||
        deployment.agentId !== this.#options.agentId ||
        deployment.status !== "active" ||
        deployment.authorityEpoch !== this.#options.authorityEpoch ||
        deployment.fencingToken !== this.#options.fencingToken
      ) {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
          "Authority-transfer source deployment is not current and active",
        );
      }
      database
        .prepare(
          `INSERT INTO authority_transfers (
            id, owner_id, agent_id, source_deployment_id, target_deployment_id,
            authority_epoch, status, package_ref, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'exporting', NULL, NULL)`,
        )
        .run(
          transfer.id,
          this.#options.ownerId,
          this.#options.agentId,
          this.#options.deploymentId,
          transfer.targetDeploymentId,
          transfer.authorityEpoch,
        );
      database
        .prepare(
          `UPDATE deployments SET status = 'retired_pending_transfer',
            revision = revision + 1, transfer_id = ? WHERE id = ? AND status = 'active'`,
        )
        .run(transfer.id, this.#options.deploymentId);
    })();
  }

  #prepareImportedDatabase(
    database: InstanceType<typeof BetterSqlite3>,
    manifest: TransferBundleManifest,
    packageDirectory: string,
  ): void {
    database.transaction(() => {
      const transfer = database
        .prepare("SELECT status, consumed_at AS consumedAt FROM authority_transfers WHERE id = ?")
        .get(manifest.transferId) as { status: string; consumedAt: string | null } | undefined;
      if (!transfer || transfer.consumedAt !== null) {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.ALREADY_CONSUMED,
          "Authority-transfer identity is missing or consumed",
        );
      }
      const source = database
        .prepare(
          `SELECT owner_id AS ownerId, agent_id AS agentId, status,
            authority_epoch AS authorityEpoch, fencing_token AS fencingToken,
            transfer_id AS transferId FROM deployments WHERE id = ?`,
        )
        .get(manifest.sourceDeploymentId) as
        | {
            ownerId: string;
            agentId: string;
            status: string;
            authorityEpoch: number;
            fencingToken: number;
            transferId: string | null;
          }
        | undefined;
      if (
        !source ||
        source.ownerId !== manifest.ownerId ||
        source.agentId !== manifest.agentId ||
        source.status !== "retired_pending_transfer" ||
        source.authorityEpoch !== manifest.sourceAuthorityEpoch ||
        source.fencingToken !== manifest.sourceFencingToken ||
        source.transferId !== manifest.transferId
      ) {
        throw new AuthorityTransferError(
          AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
          "Authority-transfer source fence does not match the authenticated package",
        );
      }
      database
        .prepare(
          `UPDATE deployments SET status = 'retired_pending_transfer', transfer_id = ?
          WHERE id = ?`,
        )
        .run(manifest.transferId, manifest.sourceDeploymentId);
      database
        .prepare(
          `INSERT INTO deployments (
            id, owner_id, agent_id, revision, status, authority_epoch,
            fencing_token, transfer_id
          ) VALUES (?, ?, ?, 0, 'inactive_ready', 0, 0, ?)`,
        )
        .run(
          this.#options.deploymentId,
          this.#options.ownerId,
          this.#options.agentId,
          manifest.transferId,
        );
      database
        .prepare(
          `UPDATE authority_transfers SET status = 'inactive_ready', package_ref = ?
          WHERE id = ?`,
        )
        .run(packageDirectory, manifest.transferId);
    })();
  }

  async #assertEmptyTarget(): Promise<void> {
    if (await lstat(this.#options.databasePath).catch(() => undefined)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_EMPTY,
        "Authority-transfer target already contains product state",
      );
    }
    const data = path.join(this.#options.stateRoot, "data");
    await restrictedDirectory(data);
    if ((await readdir(data)).length > 0) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.TARGET_NOT_EMPTY,
        "Authority-transfer target data partition is not empty",
      );
    }
  }

  #assertExportIntent(transfer: TransferState): void {
    if (
      transfer.status !== "proposed" ||
      transfer.packageRef !== null ||
      transfer.ownerId !== this.#options.ownerId ||
      transfer.agentId !== this.#options.agentId ||
      transfer.sourceDeploymentId !== this.#options.deploymentId ||
      transfer.targetDeploymentId === this.#options.deploymentId ||
      transfer.authorityEpoch !== this.#options.authorityEpoch + 1
    ) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
        "Authority-transfer intent does not match source authority and target epoch",
      );
    }
  }

  #assertTargetManifest(manifest: TransferBundleManifest): void {
    if (
      manifest.ownerId !== this.#options.ownerId ||
      manifest.agentId !== this.#options.agentId ||
      manifest.targetDeploymentId !== this.#options.deploymentId ||
      manifest.targetAuthorityEpoch <= manifest.sourceAuthorityEpoch ||
      manifest.productVersion !== this.#options.productVersion ||
      stableJson(manifest.adapterVersions) !==
        stableJson([...this.#options.adapterVersions].sort()) ||
      manifest.encryption.keyRef !== this.#options.packageKey.ref ||
      manifest.encryption.keyVersion !== this.#options.packageKey.version
    ) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
        "Authority-transfer package does not match the target deployment contract",
      );
    }
  }

  #assertImportScope(manifest: TransferBundleManifest, input: TransferManifest): void {
    this.#assertTargetManifest(manifest);
    if (
      input.transferId !== manifest.transferId ||
      input.ownerId !== manifest.ownerId ||
      input.agentId !== manifest.agentId ||
      input.sourceDeploymentId !== manifest.sourceDeploymentId ||
      input.authorityEpoch !== manifest.targetAuthorityEpoch
    ) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
        "Authority-transfer manifest reference does not match authenticated content",
      );
    }
  }

  #applicationManifest(
    manifest: TransferBundleManifest,
    packageDirectory: string,
  ): TransferManifest {
    return Object.freeze({
      transferId: createTransferId(manifest.transferId),
      ownerId: createOwnerId(manifest.ownerId),
      agentId: createAgentId(manifest.agentId),
      sourceDeploymentId: createDeploymentId(manifest.sourceDeploymentId),
      authorityEpoch: manifest.targetAuthorityEpoch,
      schemaVersion: String(manifest.schemaSequence),
      adapterVersions: manifest.adapterVersions,
      fileDigests: Object.freeze(manifest.files.map((file) => file.plaintextDigest)),
      excludedSecretRefs: manifest.excludedSecretRefs,
      packageRef: packageDirectory,
    });
  }

  #stateFromManifest(
    manifest: TransferBundleManifest,
    status: TransferState["status"],
    packageDirectory: string,
  ): TransferState {
    return Object.freeze({
      id: createTransferId(manifest.transferId),
      ownerId: createOwnerId(manifest.ownerId),
      agentId: createAgentId(manifest.agentId),
      sourceDeploymentId: createDeploymentId(manifest.sourceDeploymentId),
      targetDeploymentId: createDeploymentId(manifest.targetDeploymentId),
      status,
      authorityEpoch: manifest.targetAuthorityEpoch,
      packageRef: packageDirectory,
    });
  }

  #safePackageReference(packageRef: string): string {
    if (!path.isAbsolute(packageRef)) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
        "Authority-transfer package reference must be absolute",
      );
    }
    return path.resolve(packageRef);
  }

  async #resolveKey(descriptor: TransferKeyDescriptor): Promise<Uint8Array> {
    const key = await this.#options.keys
      .resolve(descriptor.ref, descriptor.version)
      .catch(() => undefined);
    if (!key || key.byteLength !== 32) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.AUTHENTICATION_FAILED,
        "Authority-transfer key material is unavailable",
      );
    }
    return new Uint8Array(key);
  }

  #randomBytes(length: number): Uint8Array {
    const value = new Uint8Array(this.#random(length));
    if (value.byteLength !== length) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.INVALID_INPUT,
        "Authority-transfer random source returned an invalid length",
      );
    }
    return value;
  }

  async #fault(
    stage: AuthorityTransferFaultStage,
    temporaryRoot: string | null = null,
  ): Promise<void> {
    await this.#options.fault?.(stage, Object.freeze({ temporaryRoot }));
  }
}

export function inspectDeploymentAuthorityReadOnly(
  databasePath: string,
  deploymentId: string,
): {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly status: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly transferId: string | null;
} {
  const database = new BetterSqlite3(path.resolve(databasePath), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT id, owner_id AS ownerId, agent_id AS agentId, status,
          authority_epoch AS authorityEpoch, fencing_token AS fencingToken,
          transfer_id AS transferId FROM deployments WHERE id = ?`,
      )
      .get(deploymentId) as
      | {
          id: string;
          ownerId: string;
          agentId: string;
          status: string;
          authorityEpoch: number;
          fencingToken: number;
          transferId: string | null;
        }
      | undefined;
    if (!row) {
      throw new AuthorityTransferError(
        AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
        "Deployment authority is missing from SQLite",
      );
    }
    return Object.freeze(row);
  } finally {
    database.close();
  }
}
