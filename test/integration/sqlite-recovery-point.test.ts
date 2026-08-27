import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createBackupId,
  createDeploymentId,
  createOwnerId,
} from "@himawari-agent/domain";
import {
  RECOVERY_POINT_ERROR_CODES,
  RecoveryPointError,
  SqliteRecoveryPointAdapter,
  acquireStateRootLock,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  type RecoveryPointFaultStage,
} from "@himawari-agent/persistence-sqlite";
import {
  ContentAddressedCiphertextStore,
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-recovery-point");
const AGENT_ID = createAgentId("agent-recovery-point");
const DEPLOYMENT_ID = createDeploymentId("deployment-recovery-point");
const BACKUP_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PAYLOAD_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const CREATED_AT = "2026-08-01T00:00:00.000Z";
const PLAINTEXT = new TextEncoder().encode("只允许恢复到经过验证的同机 state root");
const temporaryRoots: string[] = [];

interface Fixture {
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly payloadRelativePath: string;
  readonly keys: InMemoryDevelopmentSecretSource;
  readonly protector: EnvelopePayloadProtector;
  readonly adapter: SqliteRecoveryPointAdapter;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function fixture(
  options: {
    readonly fault?: (
      stage: RecoveryPointFaultStage,
      context: Readonly<{ temporaryRoot: string | null }>,
    ) => void | Promise<void>;
    readonly expectedSchemaSequence?: number;
  } = {},
): Promise<Fixture> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-recovery-point-"));
  temporaryRoots.push(stateRoot);
  await Promise.all(
    ["data", "runtime", "cache"].map((name) =>
      mkdir(path.join(stateRoot, name), { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(path.join(stateRoot, "runtime", "must-not-copy.sock"), "runtime-secret", {
    mode: 0o600,
  });
  await writeFile(path.join(stateRoot, "cache", "must-not-copy.cache"), "cache-secret", {
    mode: 0o600,
  });
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);

  const keys = new InMemoryDevelopmentSecretSource({
    "backup-kek@v1": BACKUP_KEY,
    "payload-kek@v1": PAYLOAD_KEY,
  });
  const protector = new EnvelopePayloadProtector({
    keys,
    activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
  });
  const protectedPayload = await protector.protect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref: "payload-recovery-point",
    dataClassification: "restricted",
    contentType: "text/plain",
    plaintext: PLAINTEXT,
    createdAt: CREATED_AT,
  });
  const ciphertextFiles = new ContentAddressedCiphertextStore(
    path.join(stateRoot, "data", "payload-ciphertext"),
  );
  await ciphertextFiles.initialize();
  const fileReference = await ciphertextFiles.put(protectedPayload.ciphertext);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        ciphertext_path, content_digest, encryption_algorithm, key_ref,
        lifecycle_state, created_at, content_type, encryption_metadata_json
      ) VALUES (?, ?, ?, ?, 'ciphertext_file', NULL, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      protectedPayload.ref,
      OWNER_ID,
      AGENT_ID,
      protectedPayload.dataClassification,
      fileReference.relativePath,
      protectedPayload.contentDigest,
      protectedPayload.encryption.algorithm,
      protectedPayload.encryption.keyRef,
      protectedPayload.createdAt,
      protectedPayload.contentType,
      JSON.stringify(protectedPayload.encryption),
    );
  database
    .prepare(
      `INSERT INTO reliable_events (
        id, owner_id, agent_id, idempotency_key, topic, payload_ref,
        publication_state, occurred_at
      ) VALUES ('event-recovery-point', ?, ?, 'recovery-point', 'test', ?, 'pending', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, protectedPayload.ref, CREATED_AT);
  database
    .prepare(
      `INSERT INTO gateway_read_model_metadata (key, value, updated_at)
      VALUES ('restore-proof', 'before-backup', ?)`,
    )
    .run(CREATED_AT);
  database.close();

  const adapter = new SqliteRecoveryPointAdapter({
    stateRoot,
    databasePath,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    deploymentId: DEPLOYMENT_ID,
    authorityEpoch: 1,
    keys,
    backupKey: { ref: "backup-kek", version: "v1" },
    payloadProtector: protector,
    now: () => CREATED_AT,
    ...(options.expectedSchemaSequence === undefined
      ? {}
      : { expectedSchemaSequence: options.expectedSchemaSequence }),
    ...(options.fault ? { fault: options.fault } : {}),
  });
  return {
    stateRoot,
    databasePath,
    payloadRelativePath: fileReference.relativePath,
    keys,
    protector,
    adapter,
  };
}

function recoveryState(backupId: string) {
  return Object.freeze({
    id: createBackupId(backupId),
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    status: "creating" as const,
    manifestRef: null,
  });
}

async function expectRecoveryCode(action: Promise<unknown>, code: string) {
  try {
    await action;
    throw new Error("expected RecoveryPointError");
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryPointError);
    expect((error as RecoveryPointError).code).toBe(code);
  }
}

function readProof(databasePath: string): string {
  const database = openQualifiedDatabase(databasePath);
  try {
    return database
      .prepare("SELECT value FROM gateway_read_model_metadata WHERE key = 'restore-proof'")
      .pluck()
      .get() as string;
  } finally {
    database.close();
  }
}

function updateProof(databasePath: string, value: string): void {
  const database = openQualifiedDatabase(databasePath);
  try {
    database
      .prepare("UPDATE gateway_read_model_metadata SET value = ? WHERE key = 'restore-proof'")
      .run(value);
  } finally {
    database.close();
  }
}

function adapterWith(
  source: Fixture,
  options: {
    readonly keys?: InMemoryDevelopmentSecretSource;
    readonly expectedSchemaSequence?: number;
    readonly fault?: (
      stage: RecoveryPointFaultStage,
      context: Readonly<{ temporaryRoot: string | null }>,
    ) => void | Promise<void>;
  },
) {
  return new SqliteRecoveryPointAdapter({
    stateRoot: source.stateRoot,
    databasePath: source.databasePath,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    deploymentId: DEPLOYMENT_ID,
    authorityEpoch: 1,
    keys: options.keys ?? source.keys,
    backupKey: { ref: "backup-kek", version: "v1" },
    payloadProtector: source.protector,
    now: () => CREATED_AT,
    ...(options.expectedSchemaSequence === undefined
      ? {}
      : { expectedSchemaSequence: options.expectedSchemaSequence }),
    ...(options.fault ? { fault: options.fault } : {}),
  });
}

describe("encrypted same-host SQLite recovery points", () => {
  it("creates, authenticates, verifies and atomically restores the allowlisted state", async () => {
    const source = await fixture();
    const backupId = createBackupId("backup-real-drill");
    const created = await source.adapter.create(recoveryState(backupId));

    expect(created).toMatchObject({
      backupId,
      fileCount: 2,
      payloadCount: 1,
      outboxRowCount: 1,
      fullIntegrityCheck: "ok",
      quickIntegrityCheck: "ok",
      retainUntil: "2026-08-31T00:00:00.000Z",
    });
    await expect(source.adapter.verify(backupId)).resolves.toEqual(created);

    const backupDirectory = path.join(source.stateRoot, "recovery-points", backupId);
    const serializedBackup = Buffer.concat(
      await Promise.all(
        [
          "manifest.json",
          ...(await readdir(path.join(backupDirectory, "objects"))).map(
            (name) => `objects/${name}`,
          ),
        ].map((name) => readFile(path.join(backupDirectory, name))),
      ),
    ).toString("utf8");
    expect(serializedBackup).not.toContain(new TextDecoder().decode(PLAINTEXT));
    expect(serializedBackup).not.toContain("runtime-secret");
    expect(serializedBackup).not.toContain("cache-secret");

    updateProof(source.databasePath, "after-backup");
    await expect(source.adapter.restore(backupId, source.stateRoot)).resolves.toEqual(created);
    expect(readProof(source.databasePath)).toBe("before-backup");
    expect(
      await readdir(source.stateRoot).then((entries) =>
        entries.filter((entry) => entry.startsWith(".restore-")),
      ),
    ).toEqual([]);
  });

  it("refuses restore while the service state-root lock is held", async () => {
    const source = await fixture();
    const backupId = createBackupId("backup-running-service");
    await source.adapter.create(recoveryState(backupId));
    const lock = await acquireStateRootLock(source.stateRoot);
    try {
      await expectRecoveryCode(
        source.adapter.restore(backupId, source.stateRoot),
        RECOVERY_POINT_ERROR_CODES.TARGET_NOT_STOPPED,
      );
    } finally {
      await lock.release();
    }
  });

  it("cleans every interrupted create stage and marks the attempt failed", async () => {
    const source = await fixture();
    const stages: readonly RecoveryPointFaultStage[] = [
      "create.after-source-marker",
      "create.after-sqlite-snapshot",
      "create.after-encryption",
      "create.before-commit",
    ];
    for (const [index, stage] of stages.entries()) {
      const backupId = `backup-create-interrupt-${index}`;
      const adapter = adapterWith(source, {
        fault: (actual) => {
          if (actual === stage) throw new Error("injected interruption");
        },
      });
      await expectRecoveryCode(
        adapter.create(recoveryState(backupId)),
        RECOVERY_POINT_ERROR_CODES.CREATE_FAILED,
      );
      const database = openQualifiedDatabase(source.databasePath);
      try {
        expect(
          database.prepare("SELECT status FROM recovery_points WHERE id = ?").pluck().get(backupId),
        ).toBe("failed");
      } finally {
        database.close();
      }
      expect(
        await readdir(path.join(source.stateRoot, "recovery-points")).then((entries) =>
          entries.filter((entry) => entry.includes(backupId)),
        ),
      ).toEqual([]);
    }
  });

  it("treats disk-full as a failed create without exposing a partial recovery point", async () => {
    const source = await fixture();
    const adapter = adapterWith(source, {
      fault: (stage) => {
        if (stage !== "create.after-sqlite-snapshot") return;
        const error = new Error("fixture disk full") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      },
    });
    await expectRecoveryCode(
      adapter.create(recoveryState("backup-disk-full")),
      RECOVERY_POINT_ERROR_CODES.CREATE_FAILED,
    );
    await expect(
      readFile(path.join(source.stateRoot, "recovery-points", "backup-disk-full", "manifest.json")),
    ).rejects.toThrow();
  });

  it("cleans every interrupted verification stage", async () => {
    const source = await fixture();
    const backupId = createBackupId("backup-verify-interrupt");
    await source.adapter.create(recoveryState(backupId));
    const stages: readonly RecoveryPointFaultStage[] = [
      "verify.after-manifest-authentication",
      "verify.after-decryption",
      "verify.after-integrity",
      "verify.after-payload-authentication",
    ];
    for (const stage of stages) {
      const adapter = adapterWith(source, {
        fault: (actual) => {
          if (actual === stage)
            throw new RecoveryPointError(
              RECOVERY_POINT_ERROR_CODES.DIGEST_MISMATCH,
              "injected verification interruption",
            );
        },
      });
      await expectRecoveryCode(
        adapter.verify(backupId),
        RECOVERY_POINT_ERROR_CODES.DIGEST_MISMATCH,
      );
      expect(
        await readdir(path.join(source.stateRoot, "recovery-points")).then((entries) =>
          entries.filter((entry) => entry.includes(".verify-")),
        ),
      ).toEqual([]);
    }
  });

  it("rolls the current data directory back after every interrupted restore switch stage", async () => {
    const source = await fixture();
    const backupId = createBackupId("backup-restore-interrupt");
    await source.adapter.create(recoveryState(backupId));
    const stages: readonly RecoveryPointFaultStage[] = [
      "restore.before-switch",
      "restore.after-current-data-moved",
      "restore.after-switch",
    ];
    for (const stage of stages) {
      updateProof(source.databasePath, `current-${stage}`);
      const adapter = adapterWith(source, {
        fault: (actual) => {
          if (actual === stage)
            throw new RecoveryPointError(
              RECOVERY_POINT_ERROR_CODES.ATOMIC_SWITCH_FAILED,
              "injected restore interruption",
            );
        },
      });
      await expectRecoveryCode(
        adapter.restore(backupId, source.stateRoot),
        RECOVERY_POINT_ERROR_CODES.ATOMIC_SWITCH_FAILED,
      );
      expect(readProof(source.databasePath)).toBe(`current-${stage}`);
    }
  });

  it("rejects manifest tampering, encrypted-object tampering and a wrong key", async () => {
    const manifestSource = await fixture();
    const manifestBackup = createBackupId("backup-manifest-tamper");
    await manifestSource.adapter.create(recoveryState(manifestBackup));
    const manifestPath = path.join(
      manifestSource.stateRoot,
      "recovery-points",
      manifestBackup,
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      authentication: { value: string };
    };
    manifest.authentication.value = `${manifest.authentication.value.slice(0, -1)}A`;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await expectRecoveryCode(
      manifestSource.adapter.verify(manifestBackup),
      RECOVERY_POINT_ERROR_CODES.AUTHENTICATION_FAILED,
    );

    const objectSource = await fixture();
    const objectBackup = createBackupId("backup-object-tamper");
    await objectSource.adapter.create(recoveryState(objectBackup));
    const objectManifest = JSON.parse(
      await readFile(
        path.join(objectSource.stateRoot, "recovery-points", objectBackup, "manifest.json"),
        "utf8",
      ),
    ) as { files: Array<{ objectName: string }> };
    const objectPath = path.join(
      objectSource.stateRoot,
      "recovery-points",
      objectBackup,
      "objects",
      objectManifest.files[0]?.objectName as string,
    );
    const objectBytes = new Uint8Array(await readFile(objectPath));
    objectBytes[0] = (objectBytes[0] ?? 0) ^ 0xff;
    await writeFile(objectPath, objectBytes, { mode: 0o600 });
    await expectRecoveryCode(
      objectSource.adapter.verify(objectBackup),
      RECOVERY_POINT_ERROR_CODES.DIGEST_MISMATCH,
    );

    const keySource = await fixture();
    const keyBackup = createBackupId("backup-wrong-key");
    await keySource.adapter.create(recoveryState(keyBackup));
    const wrongKeys = new InMemoryDevelopmentSecretSource({
      "backup-kek@v1": Uint8Array.from({ length: 32 }, () => 42),
      "payload-kek@v1": PAYLOAD_KEY,
    });
    await expectRecoveryCode(
      adapterWith(keySource, { keys: wrongKeys }).verify(keyBackup),
      RECOVERY_POINT_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });

  it("rejects an incompatible schema, SQLite corruption and Payload authentication failure", async () => {
    const schemaSource = await fixture();
    const schemaBackup = createBackupId("backup-schema-mismatch");
    await schemaSource.adapter.create(recoveryState(schemaBackup));
    await expectRecoveryCode(
      adapterWith(schemaSource, { expectedSchemaSequence: 999 }).verify(schemaBackup),
      RECOVERY_POINT_ERROR_CODES.SCHEMA_MISMATCH,
    );

    const sqliteSource = await fixture();
    const sqliteBackup = createBackupId("backup-sqlite-corrupt");
    await sqliteSource.adapter.create(recoveryState(sqliteBackup));
    const sqliteAdapter = adapterWith(sqliteSource, {
      fault: async (stage, context) => {
        if (stage === "verify.after-decryption" && context.temporaryRoot) {
          await writeFile(
            path.join(context.temporaryRoot, "data", "product.sqlite"),
            Uint8Array.from({ length: 4096 }, () => 0xff),
          );
        }
      },
    });
    await expectRecoveryCode(
      sqliteAdapter.verify(sqliteBackup),
      RECOVERY_POINT_ERROR_CODES.SQLITE_CORRUPT,
    );

    const payloadSource = await fixture();
    const payloadBackup = createBackupId("backup-payload-corrupt");
    await payloadSource.adapter.create(recoveryState(payloadBackup));
    const payloadAdapter = adapterWith(payloadSource, {
      fault: async (stage, context) => {
        if (stage !== "verify.after-decryption" || !context.temporaryRoot) return;
        const payloadPath = path.join(
          context.temporaryRoot,
          "data",
          "payload-ciphertext",
          payloadSource.payloadRelativePath,
        );
        const value = new Uint8Array(await readFile(payloadPath));
        value[0] = (value[0] ?? 0) ^ 0xff;
        await writeFile(payloadPath, value, { mode: 0o600 });
      },
    });
    await expectRecoveryCode(
      payloadAdapter.verify(payloadBackup),
      RECOVERY_POINT_ERROR_CODES.PAYLOAD_INVALID,
    );
  });

  it("purges expired same-host recovery copies at the 30-day boundary", async () => {
    const source = await fixture();
    const backupId = createBackupId("backup-expired-retention");
    await source.adapter.create(recoveryState(backupId));

    await expect(source.adapter.purgeExpired("2026-08-30T23:59:59.999Z")).resolves.toEqual([]);
    await expect(source.adapter.purgeExpired("2026-08-31T00:00:00.000Z")).resolves.toEqual([
      backupId,
    ]);
    await expect(
      readFile(path.join(source.stateRoot, "recovery-points", backupId, "manifest.json")),
    ).rejects.toThrow();
    const database = openQualifiedDatabase(source.databasePath);
    try {
      expect(
        database.prepare("SELECT 1 FROM recovery_points WHERE id = ?").get(backupId),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
