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
  const model = (ref: string, role: "primary" | "embedding") =>
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
          disclosure: "local_only",
          secretRef: null,
        }
      : {
          ref,
          role,
          provider: "provider-local",
          model: ref,
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
          disclosure: "local_only",
          secretRef: null,
        };
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: "deployment-thread-cli",
    ownerId: "owner-thread-cli",
    agentId: "agent-thread-cli",
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [model("model-primary", "primary"), model("model-embedding", "embedding")],
    memory: {
      adapter: "himawari-sqlite",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

const NOW = "2026-11-04T00:00:00.000Z";

async function prepare(withBundle: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-thread-cli-"));
  roots.push(root);
  const layout = await initializeStateRoot(root);
  const databasePath = path.join(layout.data, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-thread-cli', 0)").run();
  database
    .prepare(
      "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-thread-cli', 'owner-thread-cli', 0)",
    )
    .run();
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES ('thread-cli', 'owner-thread-cli', 'agent-thread-cli', 0, 'open', ?, ?)`,
    )
    .run(NOW, NOW);
  if (withBundle) {
    for (const ref of ["bundle-system-cli", "bundle-tools-cli"])
      database
        .prepare(
          `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
             content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at)
           VALUES (?, 'owner-thread-cli', 'agent-thread-cli', 'private', 'sqlite_blob', X'00',
             'sha256:fixture', 'fixture', 'fixture-key', 'active', ?)`,
        )
        .run(ref, NOW);
    database
      .prepare(
        `INSERT INTO thread_prompt_bundles (owner_id, agent_id, thread_id, generation, origin,
           identity_json, system_prompt_ref, tools_ref, system_prompt_sha256, tools_sha256,
           classification, created_by_run_id, created_at)
         VALUES ('owner-thread-cli', 'agent-thread-cli', 'thread-cli', 1, 'new_thread', ?,
           'bundle-system-cli', 'bundle-tools-cli', ?, ?, 'private', 'run-cli', ?)`,
      )
      .run(
        JSON.stringify({
          toolNames: [],
          modelRef: "model-primary",
          thinkingLevel: "off",
          answerLocale: null,
        }),
        "a".repeat(64),
        "b".repeat(64),
        NOW,
      );
  }
  database.close();
  const configurationPath = path.join(root, "configuration.json");
  await writeFile(configurationPath, `${JSON.stringify(configuration(root))}\n`, { mode: 0o600 });
  const row = () => {
    const reader = openQualifiedDatabase(databasePath);
    try {
      return reader
        .prepare(
          `SELECT generation, superseded_at AS supersededAt, rebuild_reason AS reason,
             rebuild_operator AS operator FROM thread_prompt_bundles`,
        )
        .all();
    } finally {
      reader.close();
    }
  };
  return { configurationPath, row };
}

const rebuild = (configurationPath: string, confirm?: string) => [
  "thread",
  "prompt",
  "rebuild",
  "--config",
  configurationPath,
  "--thread",
  "thread-cli",
  "--reason",
  "安全修复：更新身份说明",
  "--operator",
  "andy",
  ...(confirm ? ["--confirm", confirm] : []),
];

describe("thread.prompt.rebuild admin CLI", () => {
  it("marks the conversation's current bundle for renewal with the reason and operator after an exact confirmation", async () => {
    const { configurationPath, row } = await prepare(true);
    const plan = sink();
    const refused = sink();
    expect(await runAdminCli(rebuild(configurationPath), plan.stream, refused.stream)).toBe(1);
    expect(plan.value()).toContain('"confirmation":"REBUILD_PROMPT_thread-cli"');
    expect(refused.value()).toContain("ADMIN_CONFIRMATION_REQUIRED");
    expect(row()).toEqual([{ generation: 1, supersededAt: null, reason: null, operator: null }]);

    const output = sink();
    expect(
      await runAdminCli(
        rebuild(configurationPath, "REBUILD_PROMPT_thread-cli"),
        output.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(output.value()).toContain('"command":"thread.prompt.rebuild"');
    expect(row()).toEqual([
      {
        generation: 1,
        supersededAt: expect.any(String),
        reason: "安全修复：更新身份说明",
        operator: "andy",
      },
    ]);
  });

  it("refuses a conversation that has no bundle yet and malformed arguments", async () => {
    const { configurationPath } = await prepare(false);
    const missing = sink();
    expect(
      await runAdminCli(
        rebuild(configurationPath, "REBUILD_PROMPT_thread-cli"),
        sink().stream,
        missing.stream,
      ),
    ).toBe(1);
    expect(missing.value()).toContain("THREAD_PROMPT_BUNDLE_NOT_FOUND");
    const malformed = sink();
    expect(
      await runAdminCli(
        ["thread", "prompt", "rebuild", "--config", configurationPath, "--thread", "thread-cli"],
        sink().stream,
        malformed.stream,
      ),
    ).toBe(1);
    expect(malformed.value()).toContain("ADMIN_THREAD_ARGUMENT_INVALID");
  });
});
