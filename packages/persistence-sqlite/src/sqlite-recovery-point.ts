import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  PayloadProtectorPort,
  PayloadRecord,
  RecoveryPointManifest,
  RecoveryPointPort,
} from "@himawari-agent/application";
import type {
  AgentId,
  BackupId,
  DeploymentId,
  OwnerId,
  RecoveryPointState,
} from "@himawari-agent/domain";
import { createBackupId } from "@himawari-agent/domain";
import BetterSqlite3 from "better-sqlite3";
import { acquireStateRootLock } from "./state-root-lock.js";

const MANIFEST_SCHEMA = "himawari.recovery-point.v1" as const;
const ENCRYPTION_ALGORITHM = "aes-256-gcm-envelope-files-v1" as const;
const MANIFEST_AUTHENTICATION = "hmac-sha256-v1" as const;
const RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export const RECOVERY_POINT_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "RECOVERY_POINT_INVALID_INPUT",
  ALREADY_EXISTS: "RECOVERY_POINT_ALREADY_EXISTS",
  NOT_FOUND: "RECOVERY_POINT_NOT_FOUND",
  MANIFEST_INVALID: "RECOVERY_POINT_MANIFEST_INVALID",
  AUTHENTICATION_FAILED: "RECOVERY_POINT_AUTHENTICATION_FAILED",
  DIGEST_MISMATCH: "RECOVERY_POINT_DIGEST_MISMATCH",
  SCHEMA_MISMATCH: "RECOVERY_POINT_SCHEMA_MISMATCH",
  SQLITE_CORRUPT: "RECOVERY_POINT_SQLITE_CORRUPT",
  PAYLOAD_INVALID: "RECOVERY_POINT_PAYLOAD_INVALID",
  OUTBOX_DISCONTINUITY: "RECOVERY_POINT_OUTBOX_DISCONTINUITY",
  TARGET_NOT_STOPPED: "RECOVERY_POINT_TARGET_NOT_STOPPED",
  TARGET_MISMATCH: "RECOVERY_POINT_TARGET_MISMATCH",
  ATOMIC_SWITCH_FAILED: "RECOVERY_POINT_ATOMIC_SWITCH_FAILED",
  CREATE_FAILED: "RECOVERY_POINT_CREATE_FAILED",
} as const);

export type RecoveryPointErrorCode =
  (typeof RECOVERY_POINT_ERROR_CODES)[keyof typeof RECOVERY_POINT_ERROR_CODES];

export class RecoveryPointError extends Error {
  readonly code: RecoveryPointErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: RecoveryPointErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "RecoveryPointError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface RecoveryPointKeySource {
  resolve(secretRef: string, secretVersion: string): Promise<Uint8Array>;
}

export interface RecoveryPointKeyDescriptor {
  readonly ref: string;
  readonly version: string;
}

export type RecoveryPointFaultStage =
  | "create.after-source-marker"
  | "create.after-sqlite-snapshot"
  | "create.after-encryption"
  | "create.before-commit"
  | "verify.after-manifest-authentication"
  | "verify.after-decryption"
  | "verify.after-integrity"
  | "verify.after-payload-authentication"
  | "restore.before-switch"
  | "restore.after-current-data-moved"
  | "restore.after-switch";

interface ManifestFile {
  readonly logicalPath: string;
  readonly objectName: string;
  readonly sizeBytes: number;
  readonly plaintextDigest: string;
  readonly ciphertextDigest: string;
  readonly nonce: string;
  readonly authenticationTag: string;
}

interface OutboxContinuity {
  readonly rowCount: number;
  readonly digest: string;
}

interface RecoveryPointBundleManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly backupId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly schemaSequence: number;
  readonly createdAt: string;
  readonly verifiedAt: string;
  readonly retainUntil: string;
  readonly encryption: {
    readonly algorithm: typeof ENCRYPTION_ALGORITHM;
    readonly keyRef: string;
    readonly keyVersion: string;
    readonly wrappedDek: string;
    readonly wrapNonce: string;
    readonly wrapAuthenticationTag: string;
  };
  readonly files: readonly ManifestFile[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly outbox: OutboxContinuity;
  readonly exclusions: readonly ["runtime", "cache", "locks", "sockets", "logs", "secrets"];
  readonly authentication: {
    readonly algorithm: typeof MANIFEST_AUTHENTICATION;
    readonly value: string;
  };
}

export interface SqliteRecoveryPointAdapterOptions {
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly deploymentId: DeploymentId;
  readonly authorityEpoch: number;
  readonly keys: RecoveryPointKeySource;
  readonly backupKey: RecoveryPointKeyDescriptor;
  readonly payloadProtector: PayloadProtectorPort;
  readonly expectedSchemaSequence?: number;
  readonly now?: () => string;
  readonly random?: (length: number) => Uint8Array;
  readonly fault?: (
    stage: RecoveryPointFaultStage,
    context: Readonly<{ temporaryRoot: string | null }>,
  ) => void | Promise<void>;
}

export interface RecoveryPointVerificationReport extends RecoveryPointManifest {
  readonly createdAt: string;
  readonly retainUntil: string;
  readonly fileCount: number;
  readonly payloadCount: number;
  readonly outboxRowCount: number;
  readonly fullIntegrityCheck: "ok";
  readonly quickIntegrityCheck: "ok";
}

interface VerificationResult {
  readonly manifest: RecoveryPointBundleManifest;
  readonly report: RecoveryPointVerificationReport;
  readonly temporaryRoot: string;
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

function withoutAuthentication(manifest: RecoveryPointBundleManifest): unknown {
  const { authentication: _authentication, ...unsigned } = manifest;
  return unsigned;
}

function manifestAuthentication(
  manifest: RecoveryPointBundleManifest,
  key: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", key)
      .update(stableJson(withoutAuthentication(manifest)))
      .digest(),
  );
}

function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): { readonly ciphertext: Uint8Array; readonly authenticationTag: Uint8Array } {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    ciphertext: new Uint8Array(ciphertext),
    authenticationTag: new Uint8Array(cipher.getAuthTag()),
  });
}

function decrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  authenticationTag: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authenticationTag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.AUTHENTICATION_FAILED,
      "Recovery-point ciphertext authentication failed",
    );
  }
}

function safeBackupId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.INVALID_INPUT,
      "Recovery-point identity is invalid",
    );
  }
  return value;
}

function safeLogicalPath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  const allowed =
    normalized === "data/product.sqlite" || normalized.startsWith("data/payload-ciphertext/");
  if (
    !allowed ||
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized.includes("\\")
  ) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point manifest contains a path outside its allowlist",
      { logicalPath: value },
    );
  }
  return normalized;
}

function fileAad(backupId: string, logicalPath: string): Uint8Array {
  return new TextEncoder().encode(
    stableJson({ schema: ENCRYPTION_ALGORITHM, backupId, logicalPath }),
  );
}

function wrapAad(backupId: string, descriptor: RecoveryPointKeyDescriptor): Uint8Array {
  return new TextEncoder().encode(
    stableJson({ schema: `${ENCRYPTION_ALGORITHM}.dek-wrap`, backupId, ...descriptor }),
  );
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

function tableNames(database: InstanceType<typeof BetterSqlite3>): readonly string[] {
  return Object.freeze(
    (
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .pluck()
        .all() as string[]
    ).filter((name) => /^[a-z][a-z0-9_]*$/.test(name)),
  );
}

function databaseRowCounts(
  database: InstanceType<typeof BetterSqlite3>,
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      tableNames(database).map((table) => [
        table,
        database.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get() as number,
      ]),
    ),
  );
}

function outboxContinuity(database: InstanceType<typeof BetterSqlite3>): OutboxContinuity {
  const rows = database
    .prepare(
      `SELECT id, owner_id, agent_id, idempotency_key, topic, payload_ref,
        publication_state, claim_id, claim_expires_at, occurred_at, published_at,
        acknowledgement_ref FROM reliable_events ORDER BY id`,
    )
    .all();
  return Object.freeze({ rowCount: rows.length, digest: digest(stableJson(rows)) });
}

function schemaSequence(database: InstanceType<typeof BetterSqlite3>): number {
  return (
    (database.prepare("SELECT MAX(sequence) FROM schema_migration_ledger").pluck().get() as
      | number
      | null) ?? 0
  );
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

function parseManifest(input: unknown): RecoveryPointBundleManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point manifest is not an object",
    );
  }
  const candidate = input as Partial<RecoveryPointBundleManifest>;
  const fields = Object.keys(input as object).sort();
  const expectedFields = [
    "agentId",
    "authentication",
    "authorityEpoch",
    "backupId",
    "createdAt",
    "deploymentId",
    "encryption",
    "exclusions",
    "files",
    "outbox",
    "ownerId",
    "retainUntil",
    "rowCounts",
    "schema",
    "schemaSequence",
    "verifiedAt",
  ].sort();
  if (stableJson(fields) !== stableJson(expectedFields)) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point manifest fields are invalid",
    );
  }
  if (
    candidate.schema !== MANIFEST_SCHEMA ||
    typeof candidate.backupId !== "string" ||
    typeof candidate.ownerId !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.deploymentId !== "string" ||
    !Number.isSafeInteger(candidate.authorityEpoch) ||
    (candidate.authorityEpoch as number) < 1 ||
    !Number.isSafeInteger(candidate.schemaSequence) ||
    (candidate.schemaSequence as number) < 1 ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.verifiedAt !== "string" ||
    typeof candidate.retainUntil !== "string" ||
    !Array.isArray(candidate.files) ||
    !candidate.rowCounts ||
    typeof candidate.rowCounts !== "object" ||
    Array.isArray(candidate.rowCounts) ||
    !candidate.outbox ||
    typeof candidate.outbox !== "object" ||
    !candidate.encryption ||
    typeof candidate.encryption !== "object" ||
    !candidate.authentication ||
    typeof candidate.authentication !== "object"
  ) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point manifest values are invalid",
    );
  }
  safeBackupId(candidate.backupId);
  if (
    candidate.encryption.algorithm !== ENCRYPTION_ALGORITHM ||
    typeof candidate.encryption.keyRef !== "string" ||
    typeof candidate.encryption.keyVersion !== "string" ||
    typeof candidate.encryption.wrappedDek !== "string" ||
    typeof candidate.encryption.wrapNonce !== "string" ||
    typeof candidate.encryption.wrapAuthenticationTag !== "string" ||
    candidate.authentication.algorithm !== MANIFEST_AUTHENTICATION ||
    typeof candidate.authentication.value !== "string" ||
    candidate.outbox === null ||
    !Number.isSafeInteger(candidate.outbox.rowCount) ||
    typeof candidate.outbox.digest !== "string"
  ) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point cryptographic metadata is invalid",
    );
  }
  const filesSeen = new Set<string>();
  for (const file of candidate.files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.logicalPath !== "string" ||
      typeof file.objectName !== "string" ||
      !/^file-[0-9]{6}\.bin$/.test(file.objectName) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      typeof file.plaintextDigest !== "string" ||
      typeof file.ciphertextDigest !== "string" ||
      typeof file.nonce !== "string" ||
      typeof file.authenticationTag !== "string"
    ) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
        "Recovery-point file metadata is invalid",
      );
    }
    safeLogicalPath(file.logicalPath);
    if (filesSeen.has(file.logicalPath)) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
        "Recovery-point manifest contains a duplicate file",
      );
    }
    filesSeen.add(file.logicalPath);
  }
  if (!filesSeen.has("data/product.sqlite")) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point manifest does not contain product.sqlite",
    );
  }
  if (
    !Array.isArray(candidate.exclusions) ||
    stableJson(candidate.exclusions) !==
      stableJson(["runtime", "cache", "locks", "sockets", "logs", "secrets"])
  ) {
    throw new RecoveryPointError(
      RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
      "Recovery-point exclusions are incomplete",
    );
  }
  for (const [table, count] of Object.entries(candidate.rowCounts)) {
    if (!/^[a-z][a-z0-9_]*$/.test(table) || !Number.isSafeInteger(count) || count < 0) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
        "Recovery-point row counts are invalid",
      );
    }
  }
  return candidate as RecoveryPointBundleManifest;
}

export class SqliteRecoveryPointAdapter implements RecoveryPointPort {
  readonly #options: SqliteRecoveryPointAdapterOptions;
  readonly #recoveryRoot: string;
  readonly #now: () => string;
  readonly #random: (length: number) => Uint8Array;

  constructor(options: SqliteRecoveryPointAdapterOptions) {
    const stateRoot = path.resolve(options.stateRoot);
    const databasePath = path.resolve(options.databasePath);
    if (
      !path.isAbsolute(options.stateRoot) ||
      !path.isAbsolute(options.databasePath) ||
      databasePath !== path.join(stateRoot, "data", "product.sqlite") ||
      options.authorityEpoch < 1
    ) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.INVALID_INPUT,
        "Recovery-point adapter paths or authority are invalid",
      );
    }
    this.#options = Object.freeze({ ...options, stateRoot, databasePath });
    this.#recoveryRoot = path.join(stateRoot, "recovery-points");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#random = options.random ?? ((length) => randomBytes(length));
  }

  async createNamed(backupId: string): Promise<RecoveryPointVerificationReport> {
    return this.create({
      id: createBackupId(backupId),
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      status: "creating",
      manifestRef: null,
    });
  }

  async verifyNamed(backupId: string): Promise<RecoveryPointVerificationReport> {
    return this.verify(createBackupId(backupId));
  }

  async restoreNamed(
    backupId: string,
    targetStateRoot: string,
  ): Promise<RecoveryPointVerificationReport> {
    return this.restore(createBackupId(backupId), targetStateRoot);
  }

  async create(state: RecoveryPointState): Promise<RecoveryPointVerificationReport> {
    this.#assertState(state);
    const backupId = safeBackupId(state.id);
    const finalDirectory = this.#backupDirectory(backupId);
    const temporaryDirectory = path.join(
      this.#recoveryRoot,
      `.${backupId}.create-${process.pid}-${randomUUID()}`,
    );
    await restrictedDirectory(this.#recoveryRoot);
    if (await lstat(finalDirectory).catch(() => undefined)) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.ALREADY_EXISTS,
        "Recovery point already exists",
        { backupId },
      );
    }
    let sourceMarked = false;
    try {
      const source = new BetterSqlite3(this.#options.databasePath);
      try {
        source.pragma("foreign_keys = ON");
        source.transaction(() => {
          source
            .prepare(
              `INSERT INTO recovery_points (
                id, owner_id, agent_id, deployment_id, status, manifest_ref,
                digest, created_at, verified_at
              ) VALUES (?, ?, ?, ?, 'creating', NULL, NULL, ?, NULL)`,
            )
            .run(
              backupId,
              this.#options.ownerId,
              this.#options.agentId,
              this.#options.deploymentId,
              this.#now(),
            );
          source
            .prepare(
              `INSERT INTO backup_restore_markers (
                id, backup_id, operation, status, result_ref, occurred_at
              ) VALUES (?, ?, 'create', 'started', NULL, ?)`,
            )
            .run(`backup-marker:${backupId}:create:started`, backupId, this.#now());
        })();
        sourceMarked = true;
        await this.#fault("create.after-source-marker");

        await restrictedDirectory(temporaryDirectory);
        await restrictedDirectory(path.join(temporaryDirectory, "objects"));
        const snapshotPath = path.join(temporaryDirectory, "product.sqlite.plaintext.tmp");
        await source.backup(snapshotPath);
        await chmod(snapshotPath, 0o600);
        await this.#fault("create.after-sqlite-snapshot");

        const createdAt = this.#now();
        const retainUntil = new Date(Date.parse(createdAt) + RETENTION_MILLISECONDS).toISOString();
        const key = await this.#resolveKey(
          this.#options.backupKey.ref,
          this.#options.backupKey.version,
        );
        const dek = this.#randomBytes(32);
        const wrapNonce = this.#randomBytes(12);
        const wrapped = encrypt(dek, key, wrapNonce, wrapAad(backupId, this.#options.backupKey));
        const snapshot = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true });
        let files: readonly ManifestFile[];
        let rows: Readonly<Record<string, number>>;
        let outbox: OutboxContinuity;
        let sequence: number;
        try {
          this.#assertSqliteIntegrity(snapshot);
          rows = databaseRowCounts(snapshot);
          outbox = outboxContinuity(snapshot);
          sequence = schemaSequence(snapshot);
          files = await this.#encryptSnapshotFiles({
            backupId,
            snapshot,
            snapshotPath,
            temporaryDirectory,
            dek,
          });
        } finally {
          snapshot.close();
          await rm(snapshotPath, { force: true });
        }
        await this.#fault("create.after-encryption");

        const unsigned = Object.freeze({
          schema: MANIFEST_SCHEMA,
          backupId,
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          deploymentId: this.#options.deploymentId,
          authorityEpoch: this.#options.authorityEpoch,
          schemaSequence: sequence,
          createdAt,
          verifiedAt: this.#now(),
          retainUntil,
          encryption: Object.freeze({
            algorithm: ENCRYPTION_ALGORITHM,
            keyRef: this.#options.backupKey.ref,
            keyVersion: this.#options.backupKey.version,
            wrappedDek: encode(wrapped.ciphertext),
            wrapNonce: encode(wrapNonce),
            wrapAuthenticationTag: encode(wrapped.authenticationTag),
          }),
          files,
          rowCounts: rows,
          outbox,
          exclusions: Object.freeze([
            "runtime",
            "cache",
            "locks",
            "sockets",
            "logs",
            "secrets",
          ] as const),
        });
        const placeholder = Object.freeze({
          ...unsigned,
          authentication: Object.freeze({ algorithm: MANIFEST_AUTHENTICATION, value: "" }),
        });
        const manifest: RecoveryPointBundleManifest = Object.freeze({
          ...unsigned,
          authentication: Object.freeze({
            algorithm: MANIFEST_AUTHENTICATION,
            value: encode(manifestAuthentication(placeholder, key)),
          }),
        });
        await writeFile(
          path.join(temporaryDirectory, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        );
        await syncDirectory(path.join(temporaryDirectory, "objects"));
        await syncDirectory(temporaryDirectory);
        await this.#fault("create.before-commit");
        await rename(temporaryDirectory, finalDirectory);
        await syncDirectory(this.#recoveryRoot);
      } finally {
        source.close();
      }

      const verification = await this.#verifyIntoTemporary(createBackupId(backupId));
      await rm(verification.temporaryRoot, { recursive: true });
      const sourceAfterVerification = new BetterSqlite3(this.#options.databasePath);
      try {
        sourceAfterVerification.transaction(() => {
          sourceAfterVerification
            .prepare(
              `UPDATE recovery_points SET status = 'verified', manifest_ref = ?, digest = ?,
                verified_at = ? WHERE id = ? AND status = 'creating'`,
            )
            .run(
              verification.report.manifestRef,
              verification.report.digest,
              verification.report.verifiedAt,
              backupId,
            );
          sourceAfterVerification
            .prepare(
              `INSERT INTO backup_restore_markers (
                id, backup_id, operation, status, result_ref, occurred_at
              ) VALUES (?, ?, 'create', 'completed', ?, ?)`,
            )
            .run(
              `backup-marker:${backupId}:create:completed`,
              backupId,
              verification.report.manifestRef,
              verification.report.verifiedAt,
            );
        })();
      } finally {
        sourceAfterVerification.close();
      }
      return verification.report;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (sourceMarked) await this.#markCreateFailed(backupId).catch(() => undefined);
      if (error instanceof RecoveryPointError) throw error;
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.CREATE_FAILED,
        "Recovery point could not be created",
        { cause: error instanceof Error ? error.message : "unknown" },
      );
    }
  }

  async verify(backupId: BackupId): Promise<RecoveryPointVerificationReport> {
    const verification = await this.#verifyIntoTemporary(backupId);
    await rm(verification.temporaryRoot, { recursive: true });
    return verification.report;
  }

  async restoreToTemporary(
    backupId: BackupId,
    targetDirectory: string,
  ): Promise<RecoveryPointVerificationReport> {
    if (!path.isAbsolute(targetDirectory)) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.INVALID_INPUT,
        "Temporary restore target must be absolute",
      );
    }
    const target = path.resolve(targetDirectory);
    if (await lstat(target).catch(() => undefined)) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.ALREADY_EXISTS,
        "Temporary restore target already exists",
      );
    }
    const verification = await this.#verifyIntoTemporary(backupId, target);
    return verification.report;
  }

  async restore(
    backupId: BackupId,
    targetStateRoot: string,
  ): Promise<RecoveryPointVerificationReport> {
    const target = path.resolve(targetStateRoot);
    if (target !== this.#options.stateRoot) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.TARGET_MISMATCH,
        "Recovery point may only restore the explicitly configured same-host state root",
      );
    }
    const lock = await acquireStateRootLock(target).catch(() => {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.TARGET_NOT_STOPPED,
        "Recovery target is owned by a running service",
      );
    });
    const backupIdentity = safeBackupId(backupId);
    const restoreStartedAt = this.#now();
    const staging = path.join(target, `.restore-${backupIdentity}-${randomUUID()}`);
    const currentData = path.join(target, "data");
    const previousData = path.join(target, `.restore-previous-${backupIdentity}-${randomUUID()}`);
    let previousMoved = false;
    let switched = false;
    try {
      await this.#markRestoreAttempt(backupIdentity, "started", null, restoreStartedAt).catch(
        () => undefined,
      );
      const verification = await this.#verifyIntoTemporary(backupId, staging);
      const manifest = verification.manifest;
      if (
        manifest.ownerId !== this.#options.ownerId ||
        manifest.agentId !== this.#options.agentId ||
        manifest.deploymentId !== this.#options.deploymentId ||
        manifest.authorityEpoch !== this.#options.authorityEpoch
      ) {
        throw new RecoveryPointError(
          RECOVERY_POINT_ERROR_CODES.TARGET_MISMATCH,
          "Recovery point identity or authority does not match the target",
        );
      }
      await this.#fault("restore.before-switch");
      await rename(currentData, previousData);
      previousMoved = true;
      await this.#fault("restore.after-current-data-moved");
      await rename(path.join(staging, "data"), currentData);
      switched = true;
      await syncDirectory(target);
      await this.#fault("restore.after-switch");

      const restored = new BetterSqlite3(path.join(currentData, "product.sqlite"));
      try {
        restored.transaction(() => {
          restored
            .prepare(
              `UPDATE recovery_points SET status = 'verified', manifest_ref = ?, digest = ?,
                verified_at = ? WHERE id = ?`,
            )
            .run(
              verification.report.manifestRef,
              verification.report.digest,
              verification.report.verifiedAt,
              backupIdentity,
            );
          restored
            .prepare(
              `INSERT OR REPLACE INTO backup_restore_markers (
                id, backup_id, operation, status, result_ref, occurred_at
              ) VALUES (?, ?, 'restore', 'started', NULL, ?)`,
            )
            .run(
              `backup-marker:${backupIdentity}:restore:started`,
              backupIdentity,
              restoreStartedAt,
            );
          restored
            .prepare(
              `INSERT OR REPLACE INTO backup_restore_markers (
                id, backup_id, operation, status, result_ref, occurred_at
              ) VALUES (?, ?, 'restore', 'completed', ?, ?)`,
            )
            .run(
              `backup-marker:${backupIdentity}:restore:completed`,
              backupIdentity,
              verification.report.manifestRef,
              this.#now(),
            );
        })();
      } finally {
        restored.close();
      }
      await rm(previousData, { recursive: true });
      previousMoved = false;
      await rm(staging, { recursive: true, force: true });
      return verification.report;
    } catch (error) {
      if (switched) {
        await rm(currentData, { recursive: true, force: true }).catch(() => undefined);
        await rename(previousData, currentData).catch(() => undefined);
        previousMoved = false;
      } else if (previousMoved) {
        await rename(previousData, currentData).catch(() => undefined);
        previousMoved = false;
      }
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await this.#markRestoreAttempt(backupIdentity, "failed", null, this.#now()).catch(
        () => undefined,
      );
      if (error instanceof RecoveryPointError) throw error;
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.ATOMIC_SWITCH_FAILED,
        "Recovery-point atomic data switch failed",
      );
    } finally {
      if (previousMoved) await rename(previousData, currentData).catch(() => undefined);
      await lock.release();
    }
  }

  async purgeExpired(asOf: string): Promise<readonly BackupId[]> {
    const cutoff = Date.parse(asOf);
    if (!Number.isFinite(cutoff)) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.INVALID_INPUT,
        "Recovery-point retention cutoff is invalid",
      );
    }
    await restrictedDirectory(this.#recoveryRoot);
    const entries = await readdir(this.#recoveryRoot, { withFileTypes: true });
    const purged: BackupId[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      let manifest: RecoveryPointBundleManifest;
      try {
        manifest = await this.#readAuthenticatedManifest(entry.name);
      } catch {
        continue;
      }
      if (Date.parse(manifest.retainUntil) > cutoff) continue;
      await rm(path.join(this.#recoveryRoot, entry.name), { recursive: true });
      const database = new BetterSqlite3(this.#options.databasePath);
      try {
        database.transaction(() => {
          database
            .prepare("DELETE FROM backup_restore_markers WHERE backup_id = ?")
            .run(entry.name);
          database.prepare("DELETE FROM recovery_points WHERE id = ?").run(entry.name);
        })();
      } finally {
        database.close();
      }
      purged.push(createBackupId(entry.name));
    }
    return Object.freeze(purged);
  }

  async #verifyIntoTemporary(
    backupIdInput: BackupId,
    requestedTarget?: string,
  ): Promise<VerificationResult> {
    const backupId = safeBackupId(backupIdInput);
    const manifest = await this.#readAuthenticatedManifest(backupId);
    const expectedSchemaSequence =
      this.#options.expectedSchemaSequence ?? this.#sourceSchemaSequence();
    if (manifest.schemaSequence !== expectedSchemaSequence) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.SCHEMA_MISMATCH,
        "Recovery-point schema sequence is not compatible with the current runtime",
        {
          expected: String(expectedSchemaSequence),
          actual: String(manifest.schemaSequence),
        },
      );
    }
    await this.#fault("verify.after-manifest-authentication");
    const target =
      requestedTarget ??
      path.join(this.#recoveryRoot, `.${backupId}.verify-${process.pid}-${randomUUID()}`);
    await restrictedDirectory(target);
    await restrictedDirectory(path.join(target, "data"));
    await restrictedDirectory(path.join(target, "data", "payload-ciphertext"));
    try {
      const key = await this.#resolveKey(
        manifest.encryption.keyRef,
        manifest.encryption.keyVersion,
      );
      const dek = decrypt(
        decode(manifest.encryption.wrappedDek),
        key,
        decode(manifest.encryption.wrapNonce),
        decode(manifest.encryption.wrapAuthenticationTag),
        wrapAad(backupId, {
          ref: manifest.encryption.keyRef,
          version: manifest.encryption.keyVersion,
        }),
      );
      for (const file of manifest.files) {
        const objectPath = path.join(this.#backupDirectory(backupId), "objects", file.objectName);
        const encrypted = new Uint8Array(await readFile(objectPath));
        if (digest(encrypted) !== file.ciphertextDigest) {
          throw new RecoveryPointError(
            RECOVERY_POINT_ERROR_CODES.DIGEST_MISMATCH,
            "Recovery-point encrypted object digest does not match",
            { logicalPath: file.logicalPath },
          );
        }
        const plaintext = decrypt(
          encrypted,
          dek,
          decode(file.nonce),
          decode(file.authenticationTag),
          fileAad(backupId, file.logicalPath),
        );
        if (plaintext.byteLength !== file.sizeBytes || digest(plaintext) !== file.plaintextDigest) {
          throw new RecoveryPointError(
            RECOVERY_POINT_ERROR_CODES.DIGEST_MISMATCH,
            "Recovery-point plaintext digest does not match",
            { logicalPath: file.logicalPath },
          );
        }
        const targetPath = path.join(target, safeLogicalPath(file.logicalPath));
        await restrictedDirectory(path.dirname(targetPath));
        await writeFile(targetPath, plaintext, { mode: 0o600 });
      }
      await this.#fault("verify.after-decryption", target);
      const databasePath = path.join(target, "data", "product.sqlite");
      let database: InstanceType<typeof BetterSqlite3>;
      try {
        database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
      } catch {
        throw new RecoveryPointError(
          RECOVERY_POINT_ERROR_CODES.SQLITE_CORRUPT,
          "Recovery-point SQLite database could not be opened",
        );
      }
      let payloadCount = 0;
      try {
        this.#assertSqliteIntegrity(database);
        if (schemaSequence(database) !== manifest.schemaSequence) {
          throw new RecoveryPointError(
            RECOVERY_POINT_ERROR_CODES.SCHEMA_MISMATCH,
            "Recovery-point schema sequence does not match its manifest",
          );
        }
        if (stableJson(databaseRowCounts(database)) !== stableJson(manifest.rowCounts)) {
          throw new RecoveryPointError(
            RECOVERY_POINT_ERROR_CODES.DIGEST_MISMATCH,
            "Recovery-point table row counts do not match its manifest",
          );
        }
        const outbox = outboxContinuity(database);
        if (stableJson(outbox) !== stableJson(manifest.outbox)) {
          throw new RecoveryPointError(
            RECOVERY_POINT_ERROR_CODES.OUTBOX_DISCONTINUITY,
            "Recovery-point Outbox continuity check failed",
          );
        }
        await this.#fault("verify.after-integrity");
        payloadCount = await this.#verifyPayloads(database, target);
        await this.#fault("verify.after-payload-authentication");
      } finally {
        database.close();
      }
      return Object.freeze({
        manifest,
        temporaryRoot: target,
        report: Object.freeze({
          backupId: createBackupId(backupId),
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          deploymentId: this.#options.deploymentId,
          schemaVersion: String(manifest.schemaSequence),
          authorityEpoch: manifest.authorityEpoch,
          manifestRef: `recovery-point:${backupId}:manifest:v1`,
          digest: digest(stableJson(manifest)),
          verifiedAt: manifest.verifiedAt,
          createdAt: manifest.createdAt,
          retainUntil: manifest.retainUntil,
          fileCount: manifest.files.length,
          payloadCount,
          outboxRowCount: manifest.outbox.rowCount,
          fullIntegrityCheck: "ok",
          quickIntegrityCheck: "ok",
        }),
      });
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #readAuthenticatedManifest(backupId: string): Promise<RecoveryPointBundleManifest> {
    const manifestPath = path.join(this.#backupDirectory(backupId), "manifest.json");
    const info = await lstat(manifestPath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new RecoveryPointError(
        info ? RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID : RECOVERY_POINT_ERROR_CODES.NOT_FOUND,
        "Recovery-point manifest is missing or unsafe",
        { backupId },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.MANIFEST_INVALID,
        "Recovery-point manifest is not valid JSON",
      );
    }
    const manifest = parseManifest(parsed);
    if (
      manifest.backupId !== backupId ||
      manifest.ownerId !== this.#options.ownerId ||
      manifest.agentId !== this.#options.agentId ||
      manifest.deploymentId !== this.#options.deploymentId
    ) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.TARGET_MISMATCH,
        "Recovery-point manifest scope does not match this deployment",
      );
    }
    const key = await this.#resolveKey(manifest.encryption.keyRef, manifest.encryption.keyVersion);
    const expected = manifestAuthentication(manifest, key);
    const actual = decode(manifest.authentication.value);
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.AUTHENTICATION_FAILED,
        "Recovery-point manifest authentication failed",
      );
    }
    return manifest;
  }

  async #encryptSnapshotFiles(input: {
    readonly backupId: string;
    readonly snapshot: InstanceType<typeof BetterSqlite3>;
    readonly snapshotPath: string;
    readonly temporaryDirectory: string;
    readonly dek: Uint8Array;
  }): Promise<readonly ManifestFile[]> {
    const sourceFiles: Array<{ readonly logicalPath: string; readonly absolutePath: string }> = [
      { logicalPath: "data/product.sqlite", absolutePath: input.snapshotPath },
    ];
    for (const row of payloadRows(input.snapshot)) {
      if (row.storageKind !== "ciphertext_file" || !row.ciphertextPath) continue;
      const relative = safeLogicalPath(`data/payload-ciphertext/${row.ciphertextPath}`);
      sourceFiles.push({
        logicalPath: relative,
        absolutePath: path.join(this.#options.stateRoot, relative),
      });
    }
    const unique = [...new Map(sourceFiles.map((file) => [file.logicalPath, file])).values()].sort(
      (left, right) => left.logicalPath.localeCompare(right.logicalPath),
    );
    const results: ManifestFile[] = [];
    for (const [index, source] of unique.entries()) {
      const info = await lstat(source.absolutePath).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new RecoveryPointError(
          RECOVERY_POINT_ERROR_CODES.PAYLOAD_INVALID,
          "Recovery-point source file is missing or unsafe",
          { logicalPath: source.logicalPath },
        );
      }
      const plaintext = new Uint8Array(await readFile(source.absolutePath));
      const nonce = this.#randomBytes(12);
      const encrypted = encrypt(
        plaintext,
        input.dek,
        nonce,
        fileAad(input.backupId, source.logicalPath),
      );
      const objectName = `file-${String(index + 1).padStart(6, "0")}.bin`;
      await writeFile(
        path.join(input.temporaryDirectory, "objects", objectName),
        encrypted.ciphertext,
        { mode: 0o600 },
      );
      results.push(
        Object.freeze({
          logicalPath: source.logicalPath,
          objectName,
          sizeBytes: plaintext.byteLength,
          plaintextDigest: digest(plaintext),
          ciphertextDigest: digest(encrypted.ciphertext),
          nonce: encode(nonce),
          authenticationTag: encode(encrypted.authenticationTag),
        }),
      );
    }
    return Object.freeze(results);
  }

  async #verifyPayloads(
    database: InstanceType<typeof BetterSqlite3>,
    restoredRoot: string,
  ): Promise<number> {
    const rows = payloadRows(database);
    for (const row of rows) {
      let encryption: PayloadRecord["encryption"];
      try {
        encryption = JSON.parse(
          row.encryptionMetadataJson ?? "null",
        ) as PayloadRecord["encryption"];
      } catch {
        throw new RecoveryPointError(
          RECOVERY_POINT_ERROR_CODES.PAYLOAD_INVALID,
          "Recovery-point Payload metadata is invalid",
          { payloadRef: row.ref },
        );
      }
      if (!encryption || typeof encryption !== "object") {
        throw new RecoveryPointError(
          RECOVERY_POINT_ERROR_CODES.PAYLOAD_INVALID,
          "Recovery-point Payload metadata is missing",
          { payloadRef: row.ref },
        );
      }
      const ciphertext =
        row.storageKind === "sqlite_blob"
          ? new Uint8Array(row.ciphertext ?? new Uint8Array())
          : new Uint8Array(
              await readFile(
                path.join(
                  restoredRoot,
                  safeLogicalPath(`data/payload-ciphertext/${row.ciphertextPath ?? ""}`),
                ),
              ),
            );
      const payload: PayloadRecord = Object.freeze({
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
      try {
        await this.#options.payloadProtector.unprotect({
          ownerId: this.#options.ownerId,
          agentId: this.#options.agentId,
          payload,
        });
      } catch {
        throw new RecoveryPointError(
          RECOVERY_POINT_ERROR_CODES.PAYLOAD_INVALID,
          "Recovery-point Payload authentication failed",
          { payloadRef: row.ref },
        );
      }
    }
    return rows.length;
  }

  #assertState(state: RecoveryPointState): void {
    if (
      state.status !== "creating" ||
      state.manifestRef !== null ||
      state.ownerId !== this.#options.ownerId ||
      state.agentId !== this.#options.agentId
    ) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.INVALID_INPUT,
        "Recovery-point product state does not match the configured scope",
      );
    }
  }

  #assertSqliteIntegrity(database: InstanceType<typeof BetterSqlite3>): void {
    let quick: unknown;
    let full: unknown;
    let foreignKeyFailures: unknown[];
    try {
      quick = database.pragma("quick_check", { simple: true });
      full = database.pragma("integrity_check", { simple: true });
      foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
    } catch {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.SQLITE_CORRUPT,
        "Recovery-point SQLite integrity checks could not complete",
      );
    }
    if (quick !== "ok" || full !== "ok" || foreignKeyFailures.length > 0) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.SQLITE_CORRUPT,
        "Recovery-point SQLite integrity checks failed",
      );
    }
  }

  async #resolveKey(ref: string, version: string): Promise<Uint8Array> {
    const key = await this.#options.keys.resolve(ref, version).catch(() => undefined);
    if (!key || key.byteLength !== 32) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.AUTHENTICATION_FAILED,
        "Recovery-point key material is unavailable",
        { keyRef: ref, keyVersion: version },
      );
    }
    return new Uint8Array(key);
  }

  #randomBytes(length: number): Uint8Array {
    const value = new Uint8Array(this.#random(length));
    if (value.byteLength !== length) {
      throw new RecoveryPointError(
        RECOVERY_POINT_ERROR_CODES.INVALID_INPUT,
        "Recovery-point random source returned an invalid length",
      );
    }
    return value;
  }

  async #fault(stage: RecoveryPointFaultStage, temporaryRoot: string | null = null): Promise<void> {
    await this.#options.fault?.(stage, Object.freeze({ temporaryRoot }));
  }

  #sourceSchemaSequence(): number {
    const database = new BetterSqlite3(this.#options.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return schemaSequence(database);
    } finally {
      database.close();
    }
  }

  async #markCreateFailed(backupId: string): Promise<void> {
    const database = new BetterSqlite3(this.#options.databasePath);
    try {
      database.transaction(() => {
        database
          .prepare(
            "UPDATE recovery_points SET status = 'failed' WHERE id = ? AND status = 'creating'",
          )
          .run(backupId);
        database
          .prepare(
            `INSERT OR REPLACE INTO backup_restore_markers (
              id, backup_id, operation, status, result_ref, occurred_at
            ) VALUES (?, ?, 'create', 'failed', NULL, ?)`,
          )
          .run(`backup-marker:${backupId}:create:failed`, backupId, this.#now());
      })();
    } finally {
      database.close();
    }
  }

  async #markRestoreAttempt(
    backupId: string,
    status: "started" | "failed",
    resultRef: string | null,
    occurredAt: string,
  ): Promise<void> {
    const database = new BetterSqlite3(this.#options.databasePath);
    try {
      database
        .prepare(
          `INSERT OR REPLACE INTO backup_restore_markers (
            id, backup_id, operation, status, result_ref, occurred_at
          ) VALUES (?, ?, 'restore', ?, ?, ?)`,
        )
        .run(
          `backup-marker:${backupId}:restore:${status}`,
          backupId,
          status,
          resultRef,
          occurredAt,
        );
    } finally {
      database.close();
    }
  }

  #backupDirectory(backupId: string): string {
    return path.join(this.#recoveryRoot, safeBackupId(backupId));
  }
}
