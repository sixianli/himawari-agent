import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PayloadRecord } from "@himawari-agent/application";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import {
  AUTHORITY_TRANSFER_ERROR_CODES,
  AuthorityTransferError,
  SqliteAuthorityTransferAdapter,
  applyMigrations,
  inspectDeploymentAuthorityReadOnly,
  loadBundledMigrations,
  openQualifiedDatabase,
  type AuthorityTransferFaultStage,
} from "@himawari-agent/persistence-sqlite";
import {
  ContentAddressedCiphertextStore,
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
  activateImportedAuthority,
  establishImportedAuthority,
  initializeStateRoot,
  markAuthorityTransferPending,
  readAuthorityFile,
  writeAuthorityFile,
  type StateRootLayout,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-transfer");
const AGENT_ID = createAgentId("agent-transfer");
const SOURCE_DEPLOYMENT_ID = createDeploymentId("deployment-mac");
const TARGET_DEPLOYMENT_ID = createDeploymentId("deployment-hermes");
const TRANSFER_ID = "transfer-mac-hermes-001";
const CREATED_AT = "2026-08-27T00:00:00.000Z";
const PLAINTEXT = new TextEncoder().encode("跨主机正文不能出现在迁移包密文之外");
const SOURCE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const RECIPIENT_KEY = Uint8Array.from({ length: 32 }, (_, index) => 65 + index);
const TARGET_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly sourceLayout: StateRootLayout;
  readonly packageRoot: string;
  readonly keys: InMemoryDevelopmentSecretSource;
  readonly protector: EnvelopePayloadProtector;
  readonly source: SqliteAuthorityTransferAdapter;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stateLayout(stateRoot: string): StateRootLayout {
  return Object.freeze({
    root: stateRoot,
    data: path.join(stateRoot, "data"),
    runtime: path.join(stateRoot, "runtime"),
    cache: path.join(stateRoot, "cache"),
    payloadCiphertext: path.join(stateRoot, "data", "payload-ciphertext"),
    authorityFile: path.join(stateRoot, "authority.json"),
  });
}

async function expectTransferCode(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
    throw new Error("expected AuthorityTransferError");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorityTransferError);
    expect((error as AuthorityTransferError).code).toBe(code);
  }
}

async function fixture(
  fault?: (
    stage: AuthorityTransferFaultStage,
    context: Readonly<{ temporaryRoot: string | null }>,
  ) => void | Promise<void>,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-authority-transfer-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const sourceLayout = await initializeStateRoot(sourceRoot);
  const memoryPath = path.join(sourceLayout.data, "memory");
  await mkdir(memoryPath, { mode: 0o700 });
  await writeFile(path.join(memoryPath, "projection.json"), "memory projection", { mode: 0o600 });
  await writeFile(path.join(sourceLayout.runtime, "excluded.sock"), "socket secret", {
    mode: 0o600,
  });
  await writeFile(path.join(sourceLayout.cache, "excluded.cache"), "cache secret", {
    mode: 0o600,
  });
  await writeAuthorityFile(sourceLayout, {
    id: SOURCE_DEPLOYMENT_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: 1,
    status: "active",
    authorityEpoch: 7,
    fencingToken: 11,
    transferId: null,
  });

  const databasePath = path.join(sourceLayout.data, "product.sqlite");
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
      ) VALUES (?, ?, ?, 1, 'active', 7, 11)`,
    )
    .run(SOURCE_DEPLOYMENT_ID, OWNER_ID, AGENT_ID);

  const keys = new InMemoryDevelopmentSecretSource({
    "source-payload-kek@v1": SOURCE_KEY,
    "transfer-recipient@v1": RECIPIENT_KEY,
    "target-payload-kek@v1": TARGET_KEY,
  });
  const protector = new EnvelopePayloadProtector({
    keys,
    activeKey: { keyRef: "source-payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
  });
  const protectedPayload = await protector.protect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref: "payload-transfer",
    dataClassification: "restricted",
    contentType: "text/plain",
    plaintext: PLAINTEXT,
    createdAt: CREATED_AT,
  });
  const ciphertextStore = new ContentAddressedCiphertextStore(sourceLayout.payloadCiphertext);
  await ciphertextStore.initialize();
  const stored = await ciphertextStore.put(protectedPayload.ciphertext);
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
      stored.relativePath,
      protectedPayload.contentDigest,
      protectedPayload.encryption.algorithm,
      protectedPayload.encryption.keyRef,
      protectedPayload.createdAt,
      protectedPayload.contentType,
      JSON.stringify(protectedPayload.encryption),
    );
  database.close();

  const packageRoot = path.join(root, "packages");
  const source = new SqliteAuthorityTransferAdapter({
    stateRoot: sourceRoot,
    databasePath,
    packageRoot,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    deploymentId: SOURCE_DEPLOYMENT_ID,
    authorityEpoch: 7,
    fencingToken: 11,
    productVersion: "0.0.0",
    adapterVersions: ["memory-mem0@3.1.7", "persistence-sqlite@0.0.0"],
    memoryVersion: "3.1.7",
    memoryStoragePath: memoryPath,
    excludedSecretRefs: ["source-payload-kek", "model-api-key"],
    keys,
    packageKey: { ref: "transfer-recipient", version: "v1" },
    packagePayloadKey: { ref: "transfer-recipient", version: "v1" },
    activePayloadKey: { ref: "source-payload-kek", version: "v1" },
    payloadProtector: protector,
    authority: {
      markSourcePending: (input) =>
        markAuthorityTransferPending(sourceLayout, input).then(() => {}),
      establishTargetInactive: async () => {
        throw new Error("source adapter cannot import");
      },
      activateTarget: async () => {
        throw new Error("source adapter cannot activate");
      },
    },
    activationPreflight: {
      check: async () => ({
        secretReferencesReady: false,
        doctorReady: false,
        publicIngressReady: false,
        evidenceRef: "",
      }),
    },
    now: () => CREATED_AT,
    ...(fault ? { fault } : {}),
  });
  return { root, sourceRoot, sourceLayout, packageRoot, keys, protector, source };
}

async function targetAdapter(
  source: Fixture,
  options: {
    readonly stateRoot?: string;
    readonly preflight?: boolean;
    readonly fault?: (
      stage: AuthorityTransferFaultStage,
      context: Readonly<{ temporaryRoot: string | null }>,
    ) => void | Promise<void>;
  } = {},
): Promise<{
  readonly adapter: SqliteAuthorityTransferAdapter;
  readonly stateRoot: string;
  readonly layout: StateRootLayout;
  readonly protector: EnvelopePayloadProtector;
}> {
  const stateRoot = options.stateRoot ?? path.join(source.root, `target-${crypto.randomUUID()}`);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const layout = stateLayout(stateRoot);
  const protector = new EnvelopePayloadProtector({
    keys: source.keys,
    activeKey: { keyRef: "target-payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
  });
  const adapter = new SqliteAuthorityTransferAdapter({
    stateRoot,
    databasePath: path.join(layout.data, "product.sqlite"),
    packageRoot: source.packageRoot,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    deploymentId: TARGET_DEPLOYMENT_ID,
    authorityEpoch: 0,
    fencingToken: 0,
    productVersion: "0.0.0",
    adapterVersions: ["persistence-sqlite@0.0.0", "memory-mem0@3.1.7"],
    memoryVersion: "3.1.7",
    memoryStoragePath: path.join(layout.data, "memory"),
    excludedSecretRefs: ["target-payload-kek"],
    keys: source.keys,
    packageKey: { ref: "transfer-recipient", version: "v1" },
    packagePayloadKey: { ref: "transfer-recipient", version: "v1" },
    activePayloadKey: { ref: "target-payload-kek", version: "v1" },
    payloadProtector: protector,
    authority: {
      markSourcePending: async () => {
        throw new Error("target adapter cannot export");
      },
      establishTargetInactive: (input) => establishImportedAuthority(layout, input).then(() => {}),
      activateTarget: (input) => activateImportedAuthority(layout, input).then(() => {}),
    },
    activationPreflight: {
      check: async () => ({
        secretReferencesReady: options.preflight ?? true,
        doctorReady: options.preflight ?? true,
        publicIngressReady: options.preflight ?? true,
        evidenceRef: options.preflight === false ? "" : "preflight:fixture",
      }),
    },
    now: () => CREATED_AT,
    ...(options.fault ? { fault: options.fault } : {}),
  });
  return { adapter, stateRoot, layout, protector };
}

interface DeploymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly transferId: string | null;
}

function deploymentRows(databasePath: string) {
  const database = openQualifiedDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT id, status, authority_epoch AS authorityEpoch,
          fencing_token AS fencingToken, transfer_id AS transferId
        FROM deployments ORDER BY id`,
      )
      .all() as DeploymentRow[];
  } finally {
    database.close();
  }
}

describe("SQLite offline authority transfer", () => {
  it("exports, authenticates, imports inactive, preflights and activates exactly one authority", async () => {
    const setup = await fixture();
    const manifest = await setup.source.exportNamed({
      transferId: TRANSFER_ID,
      targetDeploymentId: TARGET_DEPLOYMENT_ID,
    });
    expect(manifest).toMatchObject({
      transferId: TRANSFER_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sourceDeploymentId: SOURCE_DEPLOYMENT_ID,
      authorityEpoch: 8,
      excludedSecretRefs: ["model-api-key", "source-payload-kek"],
    });
    expect((await readAuthorityFile(setup.sourceLayout)).status).toBe("retired_pending_transfer");
    expect(
      inspectDeploymentAuthorityReadOnly(
        path.join(setup.sourceRoot, "data", "product.sqlite"),
        SOURCE_DEPLOYMENT_ID,
      ),
    ).toMatchObject({
      status: "retired_pending_transfer",
      authorityEpoch: 7,
      fencingToken: 11,
      transferId: TRANSFER_ID,
    });
    const packageFiles = await readdir(path.join(manifest.packageRef, "objects"));
    const packageBytes = Buffer.concat(
      await Promise.all(
        packageFiles.map((name) => readFile(path.join(manifest.packageRef, "objects", name))),
      ),
    );
    expect(packageBytes.includes(Buffer.from(PLAINTEXT))).toBe(false);
    expect(packageBytes.includes(Buffer.from("cache secret"))).toBe(false);
    expect(packageBytes.includes(Buffer.from("socket secret"))).toBe(false);
    await expect(setup.source.inspect(manifest.packageRef)).resolves.toEqual(manifest);

    const target = await targetAdapter(setup, { preflight: false });
    const imported = await target.adapter.importPackage(manifest.packageRef);
    expect(imported.status).toBe("inactive_ready");
    expect(await readAuthorityFile(target.layout)).toMatchObject({
      id: TARGET_DEPLOYMENT_ID,
      status: "inactive_ready",
      authorityEpoch: 0,
      fencingToken: 0,
      transferId: TRANSFER_ID,
    });
    expect(deploymentRows(path.join(target.layout.data, "product.sqlite"))).toEqual([
      expect.objectContaining({
        id: TARGET_DEPLOYMENT_ID,
        status: "inactive_ready",
        authorityEpoch: 0,
        fencingToken: 0,
      }),
      expect.objectContaining({ id: SOURCE_DEPLOYMENT_ID, status: "retired_pending_transfer" }),
    ]);
    const importedDatabase = openQualifiedDatabase(path.join(target.layout.data, "product.sqlite"));
    const payloadRow = importedDatabase
      .prepare(
        `SELECT ref, classification, content_type AS contentType,
          ciphertext_path AS ciphertextPath, content_digest AS contentDigest,
          encryption_metadata_json AS encryption, created_at AS createdAt
        FROM payloads WHERE ref = 'payload-transfer'`,
      )
      .get() as {
      ref: string;
      classification: PayloadRecord["dataClassification"];
      contentType: string;
      ciphertextPath: string;
      contentDigest: string;
      encryption: string;
      createdAt: string;
    };
    importedDatabase.close();
    const encryption = JSON.parse(payloadRow.encryption) as PayloadRecord["encryption"];
    expect(encryption).toMatchObject({ keyRef: "target-payload-kek", kekVersion: "v1" });
    const plaintext = await target.protector.unprotect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      payload: {
        ref: payloadRow.ref as never,
        dataClassification: payloadRow.classification,
        contentType: payloadRow.contentType,
        ciphertext: new Uint8Array(
          await readFile(path.join(target.layout.payloadCiphertext, payloadRow.ciphertextPath)),
        ),
        encryption,
        contentDigest: payloadRow.contentDigest,
        createdAt: payloadRow.createdAt,
      },
    });
    expect(plaintext).toEqual(PLAINTEXT);
    expect(await readFile(path.join(target.layout.data, "memory", "projection.json"), "utf8")).toBe(
      "memory projection",
    );
    await expectTransferCode(
      target.adapter.activateNamed(TRANSFER_ID, 8),
      AUTHORITY_TRANSFER_ERROR_CODES.PREFLIGHT_REQUIRED,
    );

    const readyTarget = await targetAdapter(setup, {
      stateRoot: target.stateRoot,
      preflight: true,
    });
    await expect(readyTarget.adapter.activateNamed(TRANSFER_ID, 8)).resolves.toMatchObject({
      status: "activated",
      authorityEpoch: 8,
    });
    expect(await readAuthorityFile(target.layout)).toMatchObject({
      status: "active",
      authorityEpoch: 8,
      fencingToken: 12,
    });
    const rows = deploymentRows(path.join(target.layout.data, "product.sqlite"));
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(rows).toEqual([
      expect.objectContaining({
        id: TARGET_DEPLOYMENT_ID,
        status: "active",
        authorityEpoch: 8,
        fencingToken: 12,
      }),
      expect.objectContaining({ id: SOURCE_DEPLOYMENT_ID, status: "retired" }),
    ]);
    await expect(readyTarget.adapter.activateNamed(TRANSFER_ID, 8)).resolves.toMatchObject({
      status: "activated",
    });
    await expectTransferCode(
      setup.source.exportNamed({
        transferId: "illegal-source-restart-transfer",
        targetDeploymentId: TARGET_DEPLOYMENT_ID,
      }),
      AUTHORITY_TRANSFER_ERROR_CODES.AUTHORITY_MISMATCH,
    );
    await expect(
      readyTarget.adapter.purgeExpiredPackages("2026-09-03T00:00:00.000Z"),
    ).resolves.toEqual([TRANSFER_ID]);
    await expect(readFile(path.join(manifest.packageRef, "manifest.json"))).rejects.toBeDefined();
  });

  it("abandons an inactive import without reactivating either deployment", async () => {
    const setup = await fixture();
    const manifest = await setup.source.exportNamed({
      transferId: TRANSFER_ID,
      targetDeploymentId: TARGET_DEPLOYMENT_ID,
    });
    const target = await targetAdapter(setup);
    await target.adapter.importPackage(manifest.packageRef);
    await expect(target.adapter.abandonNamed(TRANSFER_ID)).resolves.toMatchObject({
      status: "abandoned",
    });
    expect((await readAuthorityFile(setup.sourceLayout)).status).toBe("retired_pending_transfer");
    expect((await readAuthorityFile(target.layout)).status).toBe("inactive_ready");
    expect(
      deploymentRows(path.join(target.layout.data, "product.sqlite")).some(
        (row) => row.status === "active",
      ),
    ).toBe(false);
  });

  it("rejects a tampered manifest before decrypting product state", async () => {
    const setup = await fixture();
    const manifest = await setup.source.exportNamed({
      transferId: TRANSFER_ID,
      targetDeploymentId: TARGET_DEPLOYMENT_ID,
    });
    const manifestPath = path.join(manifest.packageRef, "manifest.json");
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
      targetDeploymentId?: unknown;
    };
    value.targetDeploymentId = "deployment-attacker";
    await writeFile(manifestPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const target = await targetAdapter(setup);
    await expectTransferCode(
      target.adapter.importPackage(manifest.packageRef),
      AUTHORITY_TRANSFER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    await expect(readAuthorityFile(target.layout)).rejects.toBeDefined();
  });

  it("keeps every injected export, import and activation failure out of dual-active state", async () => {
    const exportStages: readonly AuthorityTransferFaultStage[] = [
      "export.after-intent",
      "export.after-authority-pending",
      "export.after-checkpoint",
      "export.after-snapshot",
      "export.after-payload-rewrap",
      "export.after-encryption",
      "export.after-verification",
    ];
    for (const stage of exportStages) {
      const setup = await fixture((current) => {
        if (current === stage) throw new Error(`fault:${stage}`);
      });
      const interruptedTransferId = `${TRANSFER_ID}-${stage.replaceAll(".", "-")}`;
      await expect(
        setup.source.exportNamed({
          transferId: interruptedTransferId,
          targetDeploymentId: TARGET_DEPLOYMENT_ID,
        }),
      ).rejects.toThrow(`fault:${stage}`);
      await expect(
        lstat(path.join(setup.packageRoot, interruptedTransferId)).catch(() => undefined),
      ).resolves.toBeUndefined();
      const authority = await readAuthorityFile(setup.sourceLayout);
      expect(["active", "retired_pending_transfer"]).toContain(authority.status);
      expect(authority.status).not.toBe("retired");
    }

    const setup = await fixture();
    const manifest = await setup.source.exportNamed({
      transferId: TRANSFER_ID,
      targetDeploymentId: TARGET_DEPLOYMENT_ID,
    });
    const importStages: readonly AuthorityTransferFaultStage[] = [
      "import.after-authentication",
      "import.after-decryption",
      "import.after-payload-rewrap",
      "import.after-diagnostics",
      "import.after-data-commit",
      "import.after-authority-file",
    ];
    for (const stage of importStages) {
      const target = await targetAdapter(setup, {
        fault: (current) => {
          if (current === stage) throw new Error(`fault:${stage}`);
        },
      });
      await expect(target.adapter.importPackage(manifest.packageRef)).rejects.toThrow(
        `fault:${stage}`,
      );
      const persisted = await readFile(path.join(target.layout.data, "product.sqlite")).catch(
        () => undefined,
      );
      if (persisted) {
        expect(
          deploymentRows(path.join(target.layout.data, "product.sqlite")).some(
            (row) => row.status === "active",
          ),
        ).toBe(false);
      }
      const authority = await readAuthorityFile(target.layout).catch(() => undefined);
      expect(authority?.status).not.toBe("active");
    }

    const activationStages: readonly AuthorityTransferFaultStage[] = [
      "activate.after-preflight",
      "activate.after-database",
      "activate.after-authority-file",
    ];
    for (const stage of activationStages) {
      const target = await targetAdapter(setup);
      await target.adapter.importPackage(manifest.packageRef);
      const faulting = await targetAdapter(setup, {
        stateRoot: target.stateRoot,
        fault: (current) => {
          if (current === stage) throw new Error(`fault:${stage}`);
        },
      });
      await expect(faulting.adapter.activateNamed(TRANSFER_ID, 8)).rejects.toThrow(
        `fault:${stage}`,
      );
      const rows = deploymentRows(path.join(target.layout.data, "product.sqlite"));
      expect(rows.filter((row) => row.status === "active").length).toBeLessThanOrEqual(1);
      const authority = await readAuthorityFile(target.layout);
      expect(authority.status === "active" ? authority.id : null).not.toBe(SOURCE_DEPLOYMENT_ID);
    }
  });
});
