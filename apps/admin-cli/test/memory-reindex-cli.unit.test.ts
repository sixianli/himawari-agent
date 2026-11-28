import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
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
          provider: "local-onnx",
          model: "jina-embeddings-v5-text-small-retrieval-int8",
          version: "snapshot-1",
          capabilities: ["embedding"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 1024,
          disclosure: "local_only",
          secretRef: null,
          artifactSha256: "a".repeat(64),
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
    deploymentId: "deployment-memory-cli",
    ownerId: "owner-memory-cli",
    agentId: "agent-memory-cli",
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
      dimensions: 1024,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

type UnindexedQuery = Parameters<
  ReturnType<SqliteProductStateRepository["memoryIndex"]>["listUnindexed"]
>[0];

const NOW = "2026-11-09T00:00:00.000Z";
const OWNER = "owner-memory-cli";
const AGENT = "agent-memory-cli";

async function prepare() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-memory-cli-"));
  roots.push(root);
  const layout = await initializeStateRoot(root);
  const databasePath = path.join(layout.data, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  const memories = [
    ["memory-idle", "archived", 3],
    ["memory-merged", "archived", 2],
    ["memory-edited-after", "archived", 4],
    ["memory-undone", "active", 5],
    ["memory-undone-archived-again", "archived", 6],
    ["memory-kept", "active", 1],
  ] as const;
  for (const [id, status, revision] of memories) {
    database
      .prepare(
        `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
           content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at)
         VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:fixture', 'fixture',
           'fixture-key', 'active', ?)`,
      )
      .run(`payload-${id}`, OWNER, AGENT, NOW);
    database
      .prepare(
        `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref,
           classification, inference, confidence_permille, policy_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'private', 0, 900, 'memory-capture:v2', ?)`,
      )
      .run(id, OWNER, AGENT, revision, status, `payload-${id}`, "2026-05-01T00:00:00.000Z");
  }
  database
    .prepare(
      `INSERT INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id, status,
         model_called, started_at) VALUES ('run-1', ?, ?, '2026-11-01', 'trigger-1', 'completed', 1, ?)`,
    )
    .run(OWNER, AGENT, NOW);
  const change = database.prepare(
    `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id, memory_id,
       action, after_revision, created_at, undone_at) VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?, ?)`,
  );
  change.run("change-idle", OWNER, AGENT, "memory-idle", "archive", 3, NOW, null);
  change.run("change-merged", OWNER, AGENT, "memory-merged", "merge", 2, NOW, null);
  change.run("change-edited", OWNER, AGENT, "memory-edited-after", "archive", 3, NOW, null);
  change.run("change-undone", OWNER, AGENT, "memory-undone", "archive", 4, NOW, NOW);
  change.run(
    "change-undone-archived-again",
    OWNER,
    AGENT,
    "memory-undone-archived-again",
    "archive",
    6,
    NOW,
    NOW,
  );
  database
    .prepare(
      `INSERT INTO memory_search_index (memory_id, owner_id, agent_id, memory_revision, indexed_at)
       VALUES ('memory-kept', ?, ?, 1, ?)`,
    )
    .run(OWNER, AGENT, NOW);
  database
    .prepare(
      "INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at) VALUES ('thread-1', ?, ?, 0, 'open', ?, ?)",
    )
    .run(OWNER, AGENT, NOW, NOW);
  const episode = database.prepare(
    `INSERT INTO memory_episodes (id, owner_id, agent_id, thread_id, day, source, content_ref,
       classification, first_sequence, last_sequence, started_at, ended_at, created_at,
       embedding_model, embedding_dimensions, embedding)
     VALUES (?, ?, ?, 'thread-1', '2026-11-01', 'day_summary', 'payload-memory-kept', 'private',
       ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  episode.run(
    "episode-embedded",
    OWNER,
    AGENT,
    1,
    2,
    NOW,
    NOW,
    NOW,
    "old-model#1",
    2,
    Buffer.alloc(8),
  );
  episode.run("episode-plain", OWNER, AGENT, 3, 4, NOW, NOW, NOW, null, null, null);
  database.close();
  const configurationPath = path.join(root, "configuration.json");
  await writeFile(configurationPath, `${JSON.stringify(configuration(root))}\n`, { mode: 0o600 });
  const rows = () => {
    const reader = openQualifiedDatabase(databasePath);
    try {
      return {
        memories: reader
          .prepare("SELECT id, status, revision FROM memory_records ORDER BY id")
          .all(),
        undone: reader
          .prepare(
            "SELECT id FROM memory_consolidation_changes WHERE undone_at IS NOT NULL ORDER BY id",
          )
          .pluck()
          .all(),
        indexed: reader.prepare("SELECT COUNT(*) FROM memory_search_index").pluck().get(),
        episodeVectors: reader
          .prepare("SELECT COUNT(*) FROM memory_episodes WHERE embedding IS NOT NULL")
          .pluck()
          .get(),
      };
    } finally {
      reader.close();
    }
  };
  return { configurationPath, rows, data: layout.data };
}

const reindex = (configurationPath: string, confirm?: string) => [
  "memory",
  "reindex",
  "--config",
  configurationPath,
  "--operator",
  "andy",
  ...(confirm ? ["--confirm", confirm] : []),
];

describe("memory.reindex admin CLI", () => {
  it("[RULE-memory-visible] reports the counts, then restores only untouched idle archives and empties the search index for a rebuild", async () => {
    const { configurationPath, rows, data } = await prepare();
    const before = rows();
    const plan = sink();
    const refused = sink();
    expect(await runAdminCli(reindex(configurationPath), plan.stream, refused.stream)).toBe(1);
    expect(plan.value()).toContain('"idleArchivesToRestore":1');
    expect(plan.value()).toContain('"indexedMemories":1');
    expect(plan.value()).toContain('"embeddedEpisodes":1');
    expect(plan.value()).toContain('"confirmation":"REINDEX_MEMORY_agent-memory-cli"');
    expect(refused.value()).toContain("ADMIN_CONFIRMATION_REQUIRED");
    expect(rows()).toEqual(before);

    const output = sink();
    expect(
      await runAdminCli(
        reindex(configurationPath, "REINDEX_MEMORY_agent-memory-cli"),
        output.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(output.value()).toContain('"restored":1');
    expect(output.value()).toContain('"clearedIndexRows":1');
    expect(output.value()).toContain('"clearedEpisodeVectors":1');
    expect(rows()).toEqual({
      memories: [
        { id: "memory-edited-after", status: "archived", revision: 4 },
        { id: "memory-idle", status: "active", revision: 4 },
        { id: "memory-kept", status: "active", revision: 1 },
        { id: "memory-merged", status: "archived", revision: 2 },
        { id: "memory-undone", status: "active", revision: 5 },
        { id: "memory-undone-archived-again", status: "archived", revision: 6 },
      ],
      undone: ["change-idle", "change-undone", "change-undone-archived-again"],
      indexed: 0,
      episodeVectors: 0,
    });

    const repository = await SqliteProductStateRepository.open({
      stateRoot: data,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    try {
      expect(
        await repository.memoryIndex().listUnindexed({
          ownerId: OWNER as UnindexedQuery["ownerId"],
          agentId: AGENT as UnindexedQuery["agentId"],
          model: "",
          dimensions: 0,
          embeddableClassifications: [],
          afterMemoryId: null,
          limit: 10,
        }),
      ).toEqual(["memory-idle", "memory-kept", "memory-undone"]);
    } finally {
      await repository.close();
    }

    const again = sink();
    expect(
      await runAdminCli(
        reindex(configurationPath, "REINDEX_MEMORY_agent-memory-cli"),
        again.stream,
        sink().stream,
      ),
    ).toBe(0);
    expect(again.value()).toContain('"restored":0');
    expect(again.value()).toContain('"clearedEpisodeVectors":0');
  });

  it("refuses unknown options", async () => {
    const { configurationPath } = await prepare();
    const errors = sink();
    expect(
      await runAdminCli(
        [...reindex(configurationPath), "--force", "yes"],
        sink().stream,
        errors.stream,
      ),
    ).toBe(1);
    expect(errors.value()).toContain("ADMIN_MEMORY_ARGUMENT_INVALID");
  });
});
