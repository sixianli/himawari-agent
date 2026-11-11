import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MEMORY_ATTRIBUTES,
  DurableMemoryService,
  type MemoryContentPort,
  type MemoryProviderProjectionPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-rule-memory");
const AGENT_ID = createAgentId("agent-rule-memory");
const THREAD_ID = createThreadId("thread-rule-memory");
const GENERATION_ID = createMemoryGenerationId("generation-rule-memory");
const RULE_MEMORY = createMemoryId("memory-rule-refund");
const OTHER_MEMORY = createMemoryId("memory-rule-other");
const NOTE_MEMORY = createMemoryId("memory-note");
const NEXT_MEMORY = createMemoryId("memory-rule-refund-next");
const T0 = "2026-11-11T00:00:00.000Z";
const T1 = "2026-11-11T01:00:00.000Z";
const RULE = "floor_important_sender";

describe("hard rule review after a rule memory changes", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const repositories: SqliteProductStateRepository[] = [];
  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  const content: MemoryContentPort = { readText: async (ref) => `text of ${ref}` };
  const provider: MemoryProviderProjectionPort = {
    upsert: async ({ memory }) => `provider-${memory.id}`,
    delete: async () => undefined,
    search: async () => [],
    clearScope: async () => undefined,
  };

  async function open() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-rule-memory-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        "INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'open', ?, ?)",
      )
      .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
    const payload = database.prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
       VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
    );
    for (const ref of ["payload-v1", "payload-v2", "payload-v3"])
      payload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (id, generation_id, owner_id, agent_id, thread_id, revision,
          source_watermark, policy_version, status, attempt_count, requested_at)
         VALUES ('checkpoint-rule-memory', ?, ?, ?, ?, 1, 1, 'p', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref)
         VALUES (?, 'checkpoint-rule-memory', ?, ?, ?, 'completed', 'model', 'p', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    repositories.push(repository);
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content,
      workerId: "worker-rule-memory",
      now: () => T1,
    });
    return { stateRoot, repository, memory };
  }

  const proposal = (id: ReturnType<typeof createMemoryId>, category: "rule" | "other") => ({
    decision: "create" as const,
    memory: {
      id,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      contentRef: "payload-v1",
      dataClassification: "private" as const,
      sourceThreadId: THREAD_ID,
      sourceRefs: [`message-${id}`],
      inference: false,
      confidencePermille: 1000,
      policyVersion: "p",
      attributes: { ...DEFAULT_MEMORY_ATTRIBUTES, category },
    },
  });

  async function seeded() {
    const resource = await open();
    await resource.memory.applyProposal(proposal(RULE_MEMORY, "rule"), GENERATION_ID);
    await resource.memory.applyProposal(proposal(OTHER_MEMORY, "rule"), GENERATION_ID);
    await resource.memory.applyProposal(proposal(NOTE_MEMORY, "other"), GENERATION_ID);
    const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
    const insert = database.prepare(
      `INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source,
        source_memory_id, updated_at)
       VALUES (?, ?, ?, 1, ?, 'active', 'owner said so', ?, ?)`,
    );
    insert.run(OWNER_ID, AGENT_ID, RULE, '{"senders":["bank.example"]}', RULE_MEMORY, T0);
    insert.run(OWNER_ID, AGENT_ID, "quiet_hours", '{"periods":[]}', OTHER_MEMORY, T0);
    database
      .prepare(
        `INSERT INTO rule_book_history (owner_id, agent_id, rule_id, revision, parameters, status, source,
          source_memory_id, changed_at)
         SELECT owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id, updated_at
         FROM rule_book_rules`,
      )
      .run();
    return { ...resource, database };
  }

  function ruleState(database: ReturnType<typeof openQualifiedDatabase>, ruleId: string) {
    return database
      .prepare("SELECT status, revision FROM rule_book_rules WHERE rule_id = ?")
      .get(ruleId) as { status: string; revision: number };
  }

  function reviews(database: ReturnType<typeof openQualifiedDatabase>) {
    return database
      .prepare(
        "SELECT reason_code AS reason, subject_ref AS rule, inputs FROM decision_ledger WHERE kind = 'rule_review' ORDER BY checked_at, subject_ref",
      )
      .all() as { reason: string; rule: string; inputs: string }[];
  }

  it.each([
    ["correct", "memory_edited"],
    ["update", "memory_edited"],
    ["archive", "memory_removed"],
    ["trash", "memory_removed"],
    ["delete", "memory_removed"],
    ["supersede", "memory_superseded"],
  ] as const)(
    "[P2-2] %s on the rule memory puts exactly its rule into review",
    async (operation, reason) => {
      const { memory, database } = await seeded();
      try {
        switch (operation) {
          case "correct":
            await memory.correct({
              memoryId: RULE_MEMORY,
              contentRef: "payload-v2",
              sourceRef: "message-fix",
              generationId: GENERATION_ID,
            });
            break;
          case "update":
            await memory.applyProposal(
              {
                decision: "update",
                memoryId: RULE_MEMORY,
                contentRef: "payload-v2",
                sourceRefs: ["message-update"],
                dataClassification: "private",
                inference: false,
                confidencePermille: 1000,
                policyVersion: "p",
              },
              GENERATION_ID,
            );
            break;
          case "archive":
            await memory.archive(RULE_MEMORY, GENERATION_ID);
            break;
          case "trash":
            await memory.trash(RULE_MEMORY, GENERATION_ID);
            break;
          case "delete":
            await memory.delete(RULE_MEMORY, GENERATION_ID);
            break;
          case "supersede":
            await memory.applyProposal(
              { ...proposal(NEXT_MEMORY, "rule"), supersedes: RULE_MEMORY },
              GENERATION_ID,
            );
            break;
        }
        expect(ruleState(database, RULE)).toEqual({ status: "needs_review", revision: 2 });
        expect(ruleState(database, "quiet_hours")).toEqual({ status: "active", revision: 1 });
        expect(reviews(database)).toEqual([
          {
            reason,
            rule: RULE,
            inputs: JSON.stringify({
              memoryIds: [RULE_MEMORY],
              ruleIds: [RULE],
              batchId: null,
              resultMemoryIds: [],
            }),
          },
        ]);
        expect(
          database
            .prepare(
              "SELECT status, source_memory_id AS memoryId, change_reason AS reason FROM rule_book_history WHERE rule_id = ? AND revision = 2",
            )
            .get(RULE),
        ).toEqual({ status: "needs_review", memoryId: RULE_MEMORY, reason });
      } finally {
        database.close();
      }
    },
  );

  it("[P2-2] reaffirming the same text, or changing a memory no rule points to, leaves every rule alone", async () => {
    const { memory, database } = await seeded();
    try {
      await memory.applyProposal(
        { decision: "unchanged", memoryId: RULE_MEMORY, sourceRefs: [], policyVersion: "p" },
        GENERATION_ID,
      );
      await memory.applyProposal(
        {
          decision: "update",
          memoryId: RULE_MEMORY,
          contentRef: "payload-v1",
          sourceRefs: ["message-again"],
          dataClassification: "private",
          inference: false,
          confidencePermille: 1000,
          policyVersion: "p",
        },
        GENERATION_ID,
      );
      await memory.correct({
        memoryId: NOTE_MEMORY,
        contentRef: "payload-v2",
        sourceRef: "message-note",
        generationId: GENERATION_ID,
      });
      await memory.archive(NOTE_MEMORY, GENERATION_ID);
      expect(ruleState(database, RULE)).toEqual({ status: "active", revision: 1 });
      expect(ruleState(database, "quiet_hours")).toEqual({ status: "active", revision: 1 });
      expect(reviews(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("[P2-2] a rule waiting for review still runs, and an owner edit of the setting clears the wait and keeps the link", async () => {
    const { memory, database, repository } = await seeded();
    try {
      await memory.correct({
        memoryId: RULE_MEMORY,
        contentRef: "payload-v2",
        sourceRef: "message-fix",
        generationId: GENERATION_ID,
      });
      const store = repository.proactive();
      const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
      const waiting = await store.readSettings(scope);
      expect(waiting.importantSenders).toEqual(["bank.example"]);
      expect(waiting.importantSendersRevision).toBe(2);
      await store.writeSettings({
        ...scope,
        enabled: true,
        quietHours: waiting.quietHours,
        importantSenders: ["bank.example", "tax.example"],
        now: T1,
      });
      expect(ruleState(database, RULE)).toEqual({ status: "active", revision: 3 });
      expect(
        database
          .prepare(
            "SELECT status, source_memory_id AS memoryId FROM rule_book_history WHERE rule_id = ? AND revision = 3",
          )
          .get(RULE),
      ).toEqual({ status: "active", memoryId: RULE_MEMORY });
      expect(reviews(database)).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
