import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
  const model = (ref: string, role: "primary" | "fallback" | "embedding") =>
    role === "embedding"
      ? {
          ref,
          role,
          provider: "provider-local",
          model: ref,
          version: "snapshot-1",
          capabilities: ["embedding"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 1536,
          allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
          disclosure: "local_only",
          secretRef: null,
        }
      : {
          ref,
          role,
          provider: "provider-local",
          model: ref,
          version: "snapshot-1",
          priority: role === "primary" ? 1 : 2,
          name: role === "primary" ? "Primary fixture" : "Fallback fixture",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
          allowedDataClassifications: role === "fallback" ? ["private"] : ["public", "private"],
          disclosure: "local_only",
          secretRef: null,
        };
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: "deployment-deletion-cli",
    ownerId: "owner-deletion-cli",
    agentId: "agent-deletion-cli",
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [
      model("model-primary", "primary"),
      model("model-fallback", "fallback"),
      model("model-embedding", "embedding"),
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

describe("governed-deletion admin CLI", () => {
  it("requires exact confirmations for Trash, restore and permanent purge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-deletion-cli-"));
    roots.push(root);
    const layout = await initializeStateRoot(root);
    const database = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-deletion-cli', 0)").run();
    database
      .prepare(
        `INSERT INTO agents (id, owner_id, revision)
        VALUES ('agent-deletion-cli', 'owner-deletion-cli', 0)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at
        ) VALUES ('payload-task-cli', 'owner-deletion-cli', 'agent-deletion-cli',
          'private', 'sqlite_blob', X'00', 'sha256:fixture', 'fixture', 'fixture-key',
          'active', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO deployments (
          id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
        ) VALUES ('deployment-deletion-cli', 'owner-deletion-cli', 'agent-deletion-cli',
          0, 'active', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO threads (
          id, owner_id, agent_id, revision, status, created_at, updated_at
        ) VALUES ('thread-cli', 'owner-deletion-cli', 'agent-deletion-cli',
          0, 'open', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO scheduled_jobs (
          id, owner_id, agent_id, thread_id, revision, status,
          authorization_ref, definition_ref
        ) VALUES ('task-cli', 'owner-deletion-cli', 'agent-deletion-cli', 'thread-cli',
          0, 'active', 'fixture-auth', 'payload-task-cli')`,
      )
      .run();
    database.close();
    const configurationPath = path.join(root, "configuration.json");
    await writeFile(configurationPath, `${JSON.stringify(configuration(root))}\n`, { mode: 0o600 });

    const unconfirmed = sink();
    const unconfirmedError = sink();
    expect(
      await runAdminCli(
        [
          "delete",
          "trash",
          "--config",
          configurationPath,
          "--type",
          "thread",
          "--id",
          "thread-cli",
        ],
        unconfirmed.stream,
        unconfirmedError.stream,
      ),
    ).toBe(1);
    expect(unconfirmed.value()).toContain('"confirmation":"TRASH_thread_thread-cli"');
    expect(unconfirmed.value()).toContain('"activeTaskIds":["task-cli"]');
    expect(unconfirmedError.value()).toContain("ADMIN_CONFIRMATION_REQUIRED");

    const taskDatabase = openQualifiedDatabase(path.join(root, "data", "product.sqlite"));
    taskDatabase
      .prepare("UPDATE scheduled_jobs SET status = 'paused', revision = revision + 1 WHERE id = ?")
      .run("task-cli");
    taskDatabase.close();

    const trashed = sink();
    expect(
      await runAdminCli(
        [
          "delete",
          "trash",
          "--config",
          configurationPath,
          "--type",
          "thread",
          "--id",
          "thread-cli",
          "--confirm",
          "TRASH_thread_thread-cli",
        ],
        trashed.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(trashed.value()).toContain('"lifecycle":"trashed"');

    const restored = sink();
    expect(
      await runAdminCli(
        [
          "delete",
          "restore",
          "--config",
          configurationPath,
          "--type",
          "thread",
          "--id",
          "thread-cli",
          "--confirm",
          "RESTORE_thread_thread-cli",
        ],
        restored.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(restored.value()).toContain('"lifecycle":"active"');

    const purged = sink();
    expect(
      await runAdminCli(
        [
          "delete",
          "purge",
          "--config",
          configurationPath,
          "--type",
          "thread",
          "--id",
          "thread-cli",
          "--confirm",
          "DELETE_thread_thread-cli",
        ],
        purged.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(purged.value()).toContain('"lifecycle":"deleted_verified"');
  });
});
