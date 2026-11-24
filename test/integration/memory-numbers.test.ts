import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeToolInvocation } from "@himawari-agent/application";
import { createAgentId, createMemoryId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryOpenInputError,
  ProductionMemoryOpen,
} from "../../apps/agent-service/src/production-memory-open.ts";

const OWNER_ID = createOwnerId("owner-memory-numbers");
const AGENT_ID = createAgentId("agent-memory-numbers");
const OTHER_AGENT_ID = createAgentId("agent-memory-numbers-other");
const NUMBERS_MIGRATION = "20261124205713";
const NOW = "2026-11-25T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type Database = ReturnType<typeof openQualifiedDatabase>;

function seedScope(database: Database) {
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  for (const agentId of [AGENT_ID, OTHER_AGENT_ID])
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(agentId, OWNER_ID);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES ('thread-memory-numbers', ?, ?, 1, 'open', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, NOW, NOW);
}

function insertPayload(database: Database, ref: string, agentId = AGENT_ID) {
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    )
    .run(ref, OWNER_ID, agentId, `sha256:${ref}`, NOW);
}

function insertMemory(
  database: Database,
  id: string,
  recordedAt: string,
  options: {
    readonly agentId?: string;
    readonly status?: string;
    readonly classification?: string;
    readonly supersededBy?: string;
    readonly validTo?: string;
  } = {},
) {
  const agentId = options.agentId ?? AGENT_ID;
  insertPayload(database, `payload-${id}`, agentId as typeof AGENT_ID);
  database
    .prepare(
      `INSERT INTO memory_records (
        id, owner_id, agent_id, revision, status, content_ref, classification,
        source_thread_id, inference, confidence_permille, policy_version, updated_at,
        recorded_at, category, superseded_by, valid_to
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 'thread-memory-numbers', 0, 1000, 'memory-policy-v1', ?, ?,
        'preference', ?, ?)`,
    )
    .run(
      id,
      OWNER_ID,
      agentId,
      options.status ?? "active",
      `payload-${id}`,
      options.classification ?? "private",
      recordedAt,
      recordedAt,
      options.supersededBy ?? null,
      options.validTo ?? null,
    );
}

function numbers(database: Database) {
  return database
    .prepare(
      "SELECT agent_id AS agentId, memory_id AS memoryId, number FROM memory_numbers ORDER BY agent_id, number",
    )
    .all();
}

async function migratedState(prefix: string) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(stateRoot);
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  seedScope(database);
  return { stateRoot, database };
}

describe("[ADR-0286] memory numbers", () => {
  it("numbers the memories that exist before the migration by when they were recorded, per agent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-memory-numbers-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    applyMigrations(
      database,
      migrations.filter((migration) => migration.id !== NUMBERS_MIGRATION),
    );
    seedScope(database);
    insertMemory(database, "memory-late", "2026-11-03T00:00:00.000Z");
    insertMemory(database, "memory-early", "2026-11-01T00:00:00.000Z");
    insertMemory(database, "memory-middle", "2026-11-02T00:00:00.000Z");
    insertMemory(database, "memory-other-agent", "2026-11-05T00:00:00.000Z", {
      agentId: OTHER_AGENT_ID,
    });
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_numbers'").get(),
    ).toBeUndefined();
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });
    expect(numbers(database)).toEqual([
      { agentId: AGENT_ID, memoryId: "memory-early", number: 1 },
      { agentId: AGENT_ID, memoryId: "memory-middle", number: 2 },
      { agentId: AGENT_ID, memoryId: "memory-late", number: 3 },
      { agentId: OTHER_AGENT_ID, memoryId: "memory-other-agent", number: 1 },
    ]);
    insertMemory(database, "memory-new", "2026-10-01T00:00:00.000Z");
    expect(numbers(database)).toContainEqual({
      agentId: AGENT_ID,
      memoryId: "memory-new",
      number: 4,
    });
    database.close();
  });

  it("never gives a deleted memory's number to a new memory", async () => {
    const { database } = await migratedState("himawari-memory-numbers-reuse-");
    insertMemory(database, "memory-a", "2026-11-01T00:00:00.000Z");
    insertMemory(database, "memory-b", "2026-11-02T00:00:00.000Z");
    database.prepare("DELETE FROM memory_records WHERE id = 'memory-b'").run();
    insertMemory(database, "memory-c", "2026-11-03T00:00:00.000Z");
    expect(numbers(database)).toEqual([
      { agentId: AGENT_ID, memoryId: "memory-a", number: 1 },
      { agentId: AGENT_ID, memoryId: "memory-c", number: 3 },
    ]);
    database.close();
  });

  it("opens a memory by number with its status, the number that corrected it and its versions with the owner's words", async () => {
    const { stateRoot, database } = await migratedState("himawari-memory-numbers-open-");
    insertMemory(database, "memory-coffee-new", "2026-11-20T00:00:00.000Z");
    insertMemory(database, "memory-coffee-old", "2026-11-01T00:00:00.000Z", {
      supersededBy: "memory-coffee-new",
    });
    insertMemory(database, "memory-sealed", "2026-11-02T00:00:00.000Z", {
      classification: "restricted",
    });
    insertMemory(database, "memory-trashed", "2026-11-03T00:00:00.000Z", { status: "trashed" });
    insertMemory(database, "memory-ended", "2026-11-04T00:00:00.000Z", {
      validTo: "2026-11-10T00:00:00.000Z",
    });
    for (const ref of ["version-1", "version-2", "quote-1", "quote-2"])
      insertPayload(database, ref);
    const history = database.prepare(
      `INSERT INTO memory_history_events (
        memory_id, kind, content_ref, quote_ref, source_thread_id, source_deleted, occurred_at
      ) VALUES ('memory-coffee-old', ?, ?, ?, ?, ?, ?)`,
    );
    history.run("edited", "version-2", "quote-2", null, 1, "2026-11-05T00:00:00.000Z");
    history.run(
      "created",
      "version-1",
      "quote-1",
      "thread-memory-numbers",
      0,
      "2026-11-01T00:00:00.000Z",
    );
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    const texts: Record<string, string> = {
      "payload-memory-coffee-old": "喝咖啡不加糖",
      "payload-memory-coffee-new": "喝咖啡加一点燕麦奶",
      "payload-memory-ended": "这周在大阪出差",
      "payload-memory-trashed": "旧的手机号",
      "version-1": "喝咖啡不加糖",
      "version-2": "喝咖啡不加糖，也不加奶",
      "quote-1": "我喝咖啡从来不加糖",
      "quote-2": "奶也别加",
    };
    const state = repository.productMemoryState();
    const lookups = await state.numbers({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memoryIds: [createMemoryId("memory-coffee-old"), createMemoryId("memory-coffee-new")],
    });
    const numberOf = (id: string) =>
      lookups.find(({ memoryId }) => memoryId === id)?.number as number;
    expect(numberOf("memory-coffee-new")).toBe(1);
    expect(numberOf("memory-coffee-old")).toBe(2);
    expect(
      await state.byNumber({ ownerId: OWNER_ID, agentId: OTHER_AGENT_ID, number: 1 }),
    ).toBeUndefined();
    const tool = (pageCharacters: number) =>
      new ProductionMemoryOpen({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        state,
        readText: async (ref) => texts[ref],
        pageCharacters,
        now: () => NOW,
      });
    const call = (args: RuntimeToolInvocation["arguments"]) =>
      ({
        runId: "run-memory-numbers",
        toolCallId: "call-memory-numbers",
        capabilityRef: "memory.open",
        capabilityHandleRef: null,
        dataClassification: "public",
        arguments: args,
      }) as unknown as RuntimeToolInvocation;
    const opened = await tool(2000).open(call({ number: 2 }));
    expect(opened.output).toEqual({
      number: 2,
      found: true,
      text: "喝咖啡不加糖",
      category: "preference",
      status: "corrected",
      recordedAt: "2026-11-01T00:00:00.000Z",
      validFrom: null,
      validTo: null,
      correctedBy: 1,
      page: 1,
      versions: [
        {
          kind: "created",
          time: "2026-11-01T00:00:00.000Z",
          text: "喝咖啡不加糖",
          quote: "我喝咖啡从来不加糖",
          conversationId: "thread-memory-numbers",
        },
        {
          kind: "edited",
          time: "2026-11-05T00:00:00.000Z",
          text: "喝咖啡不加糖，也不加奶",
          quote: "奶也别加",
          conversationId: null,
        },
      ],
    });
    expect(opened.contentClassification).toBe("private");
    expect((await tool(2000).open(call({ number: 1 }))).output).toMatchObject({
      status: "current",
      correctedBy: null,
      versions: [],
    });
    expect((await tool(2000).open(call({ number: 5 }))).output).toMatchObject({
      status: "ended",
      validTo: "2026-11-10T00:00:00.000Z",
    });
    expect((await tool(2000).open(call({ number: 4 }))).output).toMatchObject({
      status: "trashed",
    });
    for (const hidden of [3, 99])
      expect((await tool(2000).open(call({ number: hidden }))).output).toMatchObject({
        number: hidden,
        found: false,
      });
    const narrow = tool(330);
    const first = await narrow.open(call({ number: 2 }));
    const second = await narrow.open(call({ number: 2, page: 2 }));
    for (const page of [first, second])
      expect(JSON.stringify(page.output).length).toBeLessThanOrEqual(330);
    expect(first.output).toMatchObject({ nextPage: 2 });
    expect(second.output).not.toHaveProperty("nextPage");
    expect(
      [
        ...(first.output["versions"] as { kind: string }[]),
        ...(second.output["versions"] as { kind: string }[]),
      ].map(({ kind }) => kind),
    ).toEqual(["created", "edited"]);
    for (const invalid of [
      {},
      { number: 0 },
      { number: 1.5 },
      { number: "2" },
      { number: 2, page: 0 },
      { number: 2, extra: true },
    ])
      await expect(tool(2000).open(call(invalid))).rejects.toBeInstanceOf(MemoryOpenInputError);
    await repository.close();
  });
});
