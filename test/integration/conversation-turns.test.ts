import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createOwnerId,
  createThreadId,
  type ThreadId,
} from "@himawari-agent/domain";
import type { RuntimeRequest } from "@himawari-agent/application";
import {
  ConversationTurnService,
  type Embedder,
  indexTerms,
  MemoryEpisodeService,
} from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { DeterministicPayloadProtector } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionMemoryEpisodes } from "../../apps/agent-service/src/production-memory-episodes.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-conversation-turns");
const AGENT_ID = createAgentId("agent-conversation-turns");
const TALK = createThreadId("thread-conversation-turns-talk");
const OTHER = createThreadId("thread-conversation-turns-other");
const THINK = createThreadId("thread-conversation-turns-think");
const DIMENSIONS = 16;
const ALL = ["public", "private", "sensitive"] as const;

type Row = readonly [ThreadId, number, "owner" | "agent" | "system", string, string, string];

const FIRST_ROWS: readonly Row[] = [
  [TALK, 1, "owner", "private", "2026-11-20T03:00:00.000Z", "下周三下午两点有一场电商公司的面试"],
  [TALK, 2, "agent", "private", "2026-11-20T03:00:05.000Z", "记下了，祝面试顺利。"],
  [TALK, 3, "owner", "private", "2026-11-21T01:00:00.000Z", "帮我查一下明天横滨的天气"],
  [TALK, 4, "agent", "private", "2026-11-21T01:00:04.000Z", "明天横滨晴，最高十五度。"],
  [TALK, 5, "system", "private", "2026-11-21T01:00:05.000Z", "运行环境说明"],
  [OTHER, 1, "owner", "private", "2026-11-22T02:00:00.000Z", "周末想去驹泽公园跑步"],
  [OTHER, 2, "agent", "restricted", "2026-11-22T02:00:03.000Z", "受限内容"],
  [THINK, 1, "owner", "private", "2026-11-22T04:00:00.000Z", "后台想一想里提到的驹泽公园"],
];

class TermEmbedder implements Embedder {
  readonly model = "fixture-term-embedding";
  readonly dimensions = DIMENSIONS;
  fail = false;

  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.fail) throw new Error("fixture embedding outage");
    const vector = new Float32Array(DIMENSIONS);
    for (const term of indexTerms(text)) {
      let hash = 0;
      for (const character of term) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
      vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}

describe.each(["worker", "direct"] as const)("conversation turns through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-conversation-turns-"));
    directories.push(stateRoot);
    const file = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(file);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const thread of [TALK, OTHER, THINK])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z");
    database.prepare("UPDATE threads SET origin = 'think' WHERE id = ?").run(THINK);
    database.close();
    const texts = new Map<string, string>();
    const sql = <T>(work: (connection: ReturnType<typeof openQualifiedDatabase>) => T): T => {
      const connection = openQualifiedDatabase(file);
      try {
        return work(connection);
      } finally {
        connection.close();
      }
    };
    const add = (rows: readonly Row[]) =>
      sql((connection) => {
        for (const [thread, sequence, role, classification, committedAt, text] of rows) {
          const ref = `payload-${thread}-${sequence}`;
          texts.set(ref, text);
          connection
            .prepare(
              `INSERT INTO payloads (
                ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
                encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
              ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
                'active', ?, 'text/plain')`,
            )
            .run(ref, OWNER_ID, AGENT_ID, classification, `sha256:${ref}`, committedAt);
          connection
            .prepare(
              `INSERT INTO thread_messages (
                id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
                classification, committed_at
              ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
            )
            .run(
              `message-${thread}-${sequence}`,
              OWNER_ID,
              AGENT_ID,
              thread,
              sequence,
              role,
              ref,
              classification,
              committedAt,
            );
        }
      });
    add(FIRST_ROWS);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => "2026-11-24T00:00:00.000Z",
    });
    const embedder = new TermEmbedder();
    const unreadable = new Set<string>();
    const failures: unknown[] = [];
    const service = new ConversationTurnService({
      store: repository.conversationTurns(),
      threads: repository.threadRepository(),
      readText: async ({ ref }) => {
        if (unreadable.has(ref)) throw new Error("fixture payload read failure");
        return texts.get(ref);
      },
      embedder,
      onIndexFailure: (error) => failures.push(error),
      embeddableClassifications: ["public", "private", "sensitive"],
      minimumSimilarity: 0.5,
      timeZone: "Asia/Tokyo",
      now: () => "2026-11-24T00:00:00.000Z",
    });
    const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
    const search = (query: string, extra: Partial<Parameters<typeof service.search>[0]> = {}) =>
      service.search({
        ...scope,
        query,
        from: null,
        to: null,
        excludeThreadId: null,
        allowedClassifications: [...ALL],
        limit: 10,
        ...extra,
      });
    const turnRows = () =>
      sql(
        (connection) =>
          connection
            .prepare(
              `SELECT thread_id AS threadId, first_sequence AS firstSequence,
                last_sequence AS lastSequence, day, classification,
                embedding_model IS NOT NULL AS embedded
              FROM conversation_turns ORDER BY thread_id, first_sequence`,
            )
            .all() as {
            threadId: string;
            firstSequence: number;
            lastSequence: number;
            day: string;
            classification: string;
            embedded: number;
          }[],
      );
    return {
      repository,
      service,
      embedder,
      add,
      sql,
      search,
      scope,
      turnRows,
      texts,
      unreadable,
      failures,
    };
  }

  it("[ADR-0286] indexes one row per turn and finds the turn's original words", async () => {
    const resource = await fixture();
    try {
      expect(await resource.service.indexDue({ ...resource.scope, limit: 50 })).toBe(3);
      expect(resource.turnRows()).toEqual([
        {
          threadId: OTHER,
          firstSequence: 1,
          lastSequence: 2,
          day: "2026-11-22",
          classification: "private",
          embedded: 1,
        },
        {
          threadId: TALK,
          firstSequence: 1,
          lastSequence: 2,
          day: "2026-11-20",
          classification: "private",
          embedded: 1,
        },
        {
          threadId: TALK,
          firstSequence: 3,
          lastSequence: 5,
          day: "2026-11-21",
          classification: "private",
          embedded: 1,
        },
      ]);
      expect(await resource.service.indexDue({ ...resource.scope, limit: 50 })).toBe(0);
      const hits = await resource.search("电商公司面试");
      expect(hits[0]?.turn.threadId).toBe(TALK);
      expect(hits[0]?.turn.firstSequence).toBe(1);
      expect(hits[0]?.lines.map(({ role, text }) => [role, text])).toEqual([
        ["owner", "下周三下午两点有一场电商公司的面试"],
        ["agent", "记下了，祝面试顺利。"],
      ]);
      const weather = await resource.search("横滨天气");
      expect(weather[0]?.lines.map(({ text }) => text)).toEqual([
        "帮我查一下明天横滨的天气",
        "明天横滨晴，最高十五度。",
      ]);
      const park = await resource.search("驹泽公园");
      expect(park.map(({ turn }) => turn.threadId)).toEqual([OTHER]);
      expect(park[0]?.lines.map(({ text }) => text)).toEqual(["周末想去驹泽公园跑步"]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] finds nothing for an unrelated question, and honours dates and the excluded thread", async () => {
    const resource = await fixture();
    try {
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      resource.embedder.fail = true;
      expect(await resource.search("护照号码")).toEqual([]);
      expect(
        await resource.search("面试", {
          from: "2026-11-21T00:00:00.000Z",
          to: "2026-11-23T00:00:00.000Z",
        }),
      ).toEqual([]);
      expect(await resource.search("面试", { excludeThreadId: TALK })).toEqual([]);
      expect((await resource.search("面试")).map(({ turn }) => turn.threadId)).toEqual([TALK]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] re-indexes the last turn when the reply grows and starts a new turn for the next owner message", async () => {
    const resource = await fixture();
    try {
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      resource.add([
        [TALK, 6, "agent", "private", "2026-11-21T01:00:09.000Z", "要不要带伞？不用。"],
        [TALK, 7, "owner", "sensitive", "2026-11-23T01:00:00.000Z", "最近血压有点高"],
      ]);
      expect(await resource.service.indexDue({ ...resource.scope, limit: 50 })).toBe(2);
      expect(
        resource
          .turnRows()
          .filter(({ threadId }) => threadId === TALK)
          .map(({ firstSequence, lastSequence, classification }) => [
            firstSequence,
            lastSequence,
            classification,
          ]),
      ).toEqual([
        [1, 2, "private"],
        [3, 6, "private"],
        [7, 7, "sensitive"],
      ]);
      expect((await resource.search("带伞"))[0]?.turn.firstSequence).toBe(3);
      expect(
        (await resource.search("血压", { allowedClassifications: ["private"] })).map(
          ({ turn }) => turn.dataClassification,
        ),
      ).not.toContain("sensitive");
      expect((await resource.search("血压"))[0]?.turn.dataClassification).toBe("sensitive");
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] embeds later when the embedding service was down", async () => {
    const resource = await fixture();
    try {
      resource.embedder.fail = true;
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      expect(resource.turnRows().every(({ embedded }) => embedded === 0)).toBe(true);
      expect((await resource.search("面试"))[0]?.turn.threadId).toBe(TALK);
      resource.embedder.fail = false;
      expect(await resource.service.backfillEmbeddings({ ...resource.scope, limit: 10 })).toBe(3);
      expect(resource.turnRows().every(({ embedded }) => embedded === 1)).toBe(true);
      expect(await resource.service.backfillEmbeddings({ ...resource.scope, limit: 10 })).toBe(0);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] hides a trashed conversation, shows it again when restored, and drops it on deletion", async () => {
    const resource = await fixture();
    try {
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      resource.embedder.fail = true;
      resource.sql((connection) =>
        connection
          .prepare("UPDATE threads SET status = 'trashed', trashed_at = ? WHERE id = ?")
          .run("2026-11-24T00:00:00.000Z", TALK),
      );
      expect(await resource.search("面试")).toEqual([]);
      expect(
        await resource.service.window({
          ...resource.scope,
          threadId: TALK,
          fromSequence: 1,
          direction: "later",
          maximumCharacters: 1000,
        }),
      ).toBeUndefined();
      resource.sql((connection) =>
        connection
          .prepare("UPDATE threads SET status = 'open', trashed_at = NULL WHERE id = ?")
          .run(TALK),
      );
      expect((await resource.search("面试")).map(({ turn }) => turn.threadId)).toEqual([TALK]);
      resource.sql((connection) => {
        connection.prepare("DELETE FROM thread_messages WHERE thread_id = ?").run(TALK);
        connection.prepare("DELETE FROM threads WHERE id = ?").run(TALK);
      });
      expect(resource.turnRows().map(({ threadId }) => threadId)).toEqual([OTHER]);
      expect(await resource.search("面试")).toEqual([]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] opens a conversation page by page in both directions and never opens a think thread", async () => {
    const resource = await fixture();
    try {
      const open = (fromSequence: number, direction: "later" | "earlier", maximumCharacters = 30) =>
        resource.service.window({
          ...resource.scope,
          threadId: TALK,
          fromSequence,
          direction,
          maximumCharacters,
        });
      const first = await open(1, "later");
      expect(first?.lines.map(({ sequence }) => sequence)).toEqual([1, 2]);
      expect(first?.earlierFrom).toBeNull();
      expect(first?.laterFrom).toBe(3);
      const second = await open(3, "later");
      expect(second?.lines.map(({ sequence }) => sequence)).toEqual([3, 4]);
      expect(second?.earlierFrom).toBe(2);
      expect(second?.laterFrom).toBeNull();
      const back = await open(4, "earlier");
      expect(back?.lines.map(({ sequence }) => sequence)).toEqual([3, 4]);
      expect(back?.earlierFrom).toBe(2);
      const all = await open(1, "later", 10_000);
      expect(all?.lines.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
      expect(all?.laterFrom).toBeNull();
      expect(
        await resource.service.window({
          ...resource.scope,
          threadId: THINK,
          fromSequence: 1,
          direction: "later",
          maximumCharacters: 1000,
        }),
      ).toBeUndefined();
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] indexes turns after each owner run inside the embedding admission, one slot per turn", async () => {
    const resource = await fixture();
    try {
      const payloads = resource.repository.payloadStore(OWNER_ID, AGENT_ID);
      const protector = new DeterministicPayloadProtector();
      const episodes = new MemoryEpisodeService({
        store: resource.repository.memoryEpisodes(),
        threads: resource.repository.threadRepository(),
        readText: async ({ ref }) => resource.texts.get(ref),
        storeText: async (input) => {
          await payloads.put(
            await protector.protect({
              ownerId: input.ownerId,
              agentId: input.agentId,
              ref: input.ref,
              contentType: "text/plain",
              dataClassification: input.dataClassification,
              plaintext: new TextEncoder().encode(input.text),
              createdAt: input.createdAt,
            }),
          );
        },
        embedder: null,
        now: () => "2026-11-24T00:00:00.000Z",
        timeZone: "Asia/Tokyo",
      });
      const admitted: { slot: string; dataClassification: string }[] = [];
      const failures: unknown[] = [];
      const production = new ProductionMemoryEpisodes({
        service: episodes,
        turns: resource.service,
        threads: resource.repository.threadRepository(),
        payloads,
        protector,
        assertActive: async () => {},
        generate: async (_request, _prompt, onAdmitted) => {
          onAdmitted();
          return "当天聊了面试和天气。";
        },
        embedWithin: (request, slot, operation) => {
          admitted.push({ slot, dataClassification: request.dataClassification });
          return operation();
        },
        onFailure: (error) => failures.push(error),
      });
      const request = {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: "run-conversation-turns",
        threadId: TALK,
        dataClassification: "private",
      } as unknown as RuntimeRequest;
      await production.start(request);
      await production.stop();
      expect(failures).toEqual([]);
      expect(
        resource.turnRows().map(({ threadId, firstSequence }) => [threadId, firstSequence]),
      ).toEqual([
        [OTHER, 1],
        [TALK, 1],
        [TALK, 3],
      ]);
      const turnSlots = admitted.filter(({ slot }) => slot.startsWith("conversation-turn-"));
      expect(turnSlots.map(({ slot }) => slot)).toEqual([
        "conversation-turn-1:run-conversation-turns",
        "conversation-turn-2:run-conversation-turns",
        "conversation-turn-3:run-conversation-turns",
      ]);
      expect(turnSlots.every(({ dataClassification }) => dataClassification === "private")).toBe(
        true,
      );
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] never sends a turn whose level the embedder may not see, and leaves it out of the backfill", async () => {
    const resource = await fixture();
    try {
      const narrow = new ConversationTurnService({
        store: resource.repository.conversationTurns(),
        threads: resource.repository.threadRepository(),
        readText: async ({ ref }) => resource.texts.get(ref),
        embedder: resource.embedder,
        embeddableClassifications: ["public"],
        minimumSimilarity: 0.5,
        timeZone: "Asia/Tokyo",
        now: () => "2026-11-24T00:00:00.000Z",
      });
      const sent: string[] = [];
      const within = <T>(dataClassification: string, operation: () => Promise<T>) => {
        sent.push(dataClassification);
        return operation();
      };
      expect(await narrow.indexDue({ ...resource.scope, limit: 50, within })).toBe(3);
      expect(sent).toEqual([]);
      expect(resource.turnRows().every(({ embedded }) => embedded === 0)).toBe(true);
      expect(await narrow.backfillEmbeddings({ ...resource.scope, limit: 50, within })).toBe(0);
      expect(sent).toEqual([]);
      expect(
        (
          await narrow.search({
            ...resource.scope,
            query: "电商公司面试",
            from: null,
            to: null,
            excludeThreadId: null,
            allowedClassifications: [...ALL],
            limit: 10,
            within,
          })
        )[0]?.turn.threadId,
      ).toBe(TALK);
      expect(sent).toEqual([]);
      expect((await resource.search("电商公司面试"))[0]?.turn.threadId).toBe(TALK);
    } finally {
      await resource.repository.close();
    }
  });
  it("[ADR-0286] indexes a turn longer than one read page to its end and does not repeat it", async () => {
    const resource = await fixture();
    try {
      const LONG = createThreadId("thread-conversation-turns-long");
      resource.sql((connection) =>
        connection
          .prepare(
            `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
            VALUES (?, ?, ?, 1, 'open', ?, ?)`,
          )
          .run(LONG, OWNER_ID, AGENT_ID, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z"),
      );
      const rows: Row[] = [[LONG, 1, "owner", "private", "2026-11-23T00:00:00.000Z", "开始长任务"]];
      for (let sequence = 2; sequence <= 251; sequence += 1)
        rows.push([
          LONG,
          sequence,
          "agent",
          "private",
          new Date(Date.parse("2026-11-23T00:00:00.000Z") + sequence * 1000).toISOString(),
          sequence === 251 ? "长任务最后一步是检查驼鸟报告" : `进度 ${sequence}`,
        ]);
      resource.add(rows);
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      expect(
        resource
          .turnRows()
          .filter(({ threadId }) => threadId === LONG)
          .map(({ firstSequence, lastSequence }) => [firstSequence, lastSequence]),
      ).toEqual([[1, 251]]);
      expect(await resource.service.indexDue({ ...resource.scope, limit: 50 })).toBe(0);
      expect((await resource.search("驼鸟报告"))[0]?.turn.threadId).toBe(LONG);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] does not record a turn whose words could not be read, reports it, and indexes it once they can be", async () => {
    const resource = await fixture();
    try {
      resource.unreadable.add(`payload-${TALK}-1`);
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      expect(resource.failures).toHaveLength(1);
      expect(resource.turnRows().map(({ threadId }) => threadId)).toEqual([OTHER]);
      resource.unreadable.clear();
      expect(await resource.service.indexDue({ ...resource.scope, limit: 50 })).toBe(2);
      expect(
        (await resource.search("电商公司面试"))[0]?.lines.map(({ sequence }) => sequence),
      ).toEqual([1, 2]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] keeps the newer turn when an older index or vector arrives late", async () => {
    const resource = await fixture();
    try {
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      const store = resource.repository.conversationTurns();
      const base = {
        id: `turn:${TALK}:3`,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: TALK,
        day: "2026-11-21",
        firstSequence: 3,
        dataClassification: "private" as const,
        startedAt: "2026-11-21T01:00:00.000Z",
        indexedAt: "2026-11-24T00:00:00.000Z",
        terms: ["横滨"],
        embedding: null,
      };
      await store.upsert({ ...base, lastSequence: 4, endedAt: "2026-11-21T01:00:04.000Z" });
      expect(
        resource
          .turnRows()
          .filter(({ threadId, firstSequence }) => threadId === TALK && firstSequence === 3)
          .map(({ lastSequence, embedded }) => [lastSequence, embedded]),
      ).toEqual([[5, 1]]);
      await store.upsert({ ...base, lastSequence: 5, endedAt: "2026-11-21T01:00:05.000Z" });
      await store.attachEmbedding({
        turnId: base.id,
        lastSequence: 4,
        embedding: {
          model: resource.embedder.model,
          dimensions: DIMENSIONS,
          vector: new Float32Array(DIMENSIONS).fill(1),
        },
      });
      expect(
        resource
          .turnRows()
          .filter(({ threadId, firstSequence }) => threadId === TALK && firstSequence === 3)
          .map(({ lastSequence, embedded }) => [lastSequence, embedded]),
      ).toEqual([[5, 0]]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0286] leaves turns of a trashed conversation out of the vector backfill so others still get vectors", async () => {
    const resource = await fixture();
    try {
      resource.embedder.fail = true;
      await resource.service.indexDue({ ...resource.scope, limit: 50 });
      resource.embedder.fail = false;
      resource.sql((connection) =>
        connection
          .prepare("UPDATE threads SET status = 'trashed', trashed_at = ? WHERE id = ?")
          .run("2026-11-24T00:00:00.000Z", OTHER),
      );
      expect(await resource.service.backfillEmbeddings({ ...resource.scope, limit: 1 })).toBe(1);
      expect(await resource.service.backfillEmbeddings({ ...resource.scope, limit: 1 })).toBe(1);
      expect(await resource.service.backfillEmbeddings({ ...resource.scope, limit: 1 })).toBe(0);
      expect(resource.turnRows().map(({ threadId, embedded }) => [threadId, embedded])).toEqual([
        [OTHER, 0],
        [TALK, 1],
        [TALK, 1],
      ]);
    } finally {
      await resource.repository.close();
    }
  });
});
