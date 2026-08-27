import { Writable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { CONFIGURATION_SCHEMA_VERSION, initializeStateRoot } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

function configuration(stateRoot: string) {
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: "deployment-backup-cli",
    ownerId: "owner-backup-cli",
    agentId: "agent-backup-cli",
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "provider-local",
        model: "model-a",
        version: "snapshot-1",
        priority: 1,
        name: "Primary fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-fallback",
        role: "fallback",
        provider: "provider-local",
        model: "model-b",
        version: "snapshot-1",
        priority: 2,
        name: "Fallback fixture",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        allowedDataClassifications: ["private"],
        disclosure: "local_only",
        secretRef: null,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "provider-local",
        model: "embed-a",
        version: "snapshot-1",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 1536,
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "backup-kek", version: "v1", purpose: "backup-encryption", scope: "agent" },
    ],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: {
        public: 0,
        private: 0,
        sensitive: 0,
        restricted: 0,
      },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

describe("backup admin CLI", () => {
  it("runs create, verify and confirmed stopped-service restore end to end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-backup-cli-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const layout = await initializeStateRoot(stateRoot);
    await mkdir(path.join(layout.data, "memory"), { mode: 0o700 });
    await writeFile(
      layout.authorityFile,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "deployment-backup-cli",
        ownerId: "owner-backup-cli",
        agentId: "agent-backup-cli",
        revision: 1,
        status: "active",
        authorityEpoch: 1,
        fencingToken: 1,
        transferId: null,
      })}\n`,
      { mode: 0o600 },
    );
    const databasePath = path.join(layout.data, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-backup-cli', 0)").run();
    database
      .prepare(
        "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-backup-cli', 'owner-backup-cli', 0)",
      )
      .run();
    database
      .prepare(
        `INSERT INTO deployments (
          id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
        ) VALUES (
          'deployment-backup-cli', 'owner-backup-cli', 'agent-backup-cli',
          0, 'active', 1, 1
        )`,
      )
      .run();
    database
      .prepare(
        "INSERT INTO gateway_read_model_metadata (key, value, updated_at) VALUES ('proof', 'before', '2026-08-27T00:00:00.000Z')",
      )
      .run();
    database.close();

    const configurationPath = path.join(root, "configuration.json");
    await writeFile(configurationPath, `${JSON.stringify(configuration(stateRoot))}\n`, {
      mode: 0o600,
    });
    const secretDirectory = path.join(root, "secrets");
    await mkdir(secretDirectory, { mode: 0o700 });
    await writeFile(path.join(secretDirectory, "payload-kek.v1"), "11".repeat(32), {
      mode: 0o600,
    });
    await writeFile(path.join(secretDirectory, "backup-kek.v1"), "22".repeat(32), {
      mode: 0o600,
    });

    const createOutput = sink();
    expect(
      await runAdminCli(
        [
          "backup",
          "create",
          "--config",
          configurationPath,
          "--secret-dir",
          secretDirectory,
          "--backup-id",
          "backup-cli-drill",
        ],
        createOutput.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(JSON.parse(createOutput.value())).toMatchObject({
      command: "backup.create",
      backupId: "backup-cli-drill",
      fullIntegrityCheck: "ok",
    });

    const verifyOutput = sink();
    expect(
      await runAdminCli(
        [
          "backup",
          "verify",
          "--config",
          configurationPath,
          "--secret-dir",
          secretDirectory,
          "--backup",
          "backup-cli-drill",
        ],
        verifyOutput.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(JSON.parse(verifyOutput.value())).toMatchObject({
      command: "backup.verify",
      backupId: "backup-cli-drill",
      payloadCount: 0,
    });

    const changed = openQualifiedDatabase(databasePath);
    changed
      .prepare("UPDATE gateway_read_model_metadata SET value = 'after' WHERE key = 'proof'")
      .run();
    changed.close();

    const unconfirmedOutput = sink();
    const unconfirmedError = sink();
    expect(
      await runAdminCli(
        [
          "backup",
          "restore",
          "--config",
          configurationPath,
          "--secret-dir",
          secretDirectory,
          "--backup",
          "backup-cli-drill",
          "--target",
          stateRoot,
        ],
        unconfirmedOutput.stream,
        unconfirmedError.stream,
      ),
    ).toBe(1);
    expect(unconfirmedOutput.value()).toContain('"confirmation":"RESTORE_backup-cli-drill"');
    expect(unconfirmedError.value()).toContain("ADMIN_CONFIRMATION_REQUIRED");

    const restoreOutput = sink();
    expect(
      await runAdminCli(
        [
          "backup",
          "restore",
          "--config",
          configurationPath,
          "--secret-dir",
          secretDirectory,
          "--backup",
          "backup-cli-drill",
          "--target",
          stateRoot,
          "--confirm",
          "RESTORE_backup-cli-drill",
        ],
        restoreOutput.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(restoreOutput.value()).toContain('"command":"backup.restore"');
    const restored = openQualifiedDatabase(databasePath);
    try {
      expect(
        restored
          .prepare("SELECT value FROM gateway_read_model_metadata WHERE key = 'proof'")
          .pluck()
          .get(),
      ).toBe("before");
    } finally {
      restored.close();
    }
  });
});
