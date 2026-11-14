import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId, createThreadId } from "@himawari-agent/domain";
import {
  type Embedder,
  indexTerms,
  MemoryEpisodeService,
  requestedTimeScope,
} from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-episodes");
const AGENT_ID = createAgentId("agent-memory-episodes");
const THREAD_ID = createThreadId("thread-memory-episodes");
const SENSITIVE_THREAD_ID = createThreadId("thread-memory-episodes-sensitive");
const DIMENSIONS = 16;
const MESSAGES = [
  [
    THREAD_ID,
    1,
    "owner",
    "private",
    "2026-10-23T03:00:00.000Z",
    "今晚和老周在新宿吃烤肉，聊了他换工作的事",
  ],
  [THREAD_ID, 2, "agent", "private", "2026-10-23T03:00:05.000Z", "好的，祝你们吃得开心。"],
  [THREAD_ID, 3, "owner", "private", "2026-10-25T02:00:00.000Z", "帮我查一下明天的天气"],
  [SENSITIVE_THREAD_ID, 1, "owner", "sensitive", "2026-10-22T03:00:00.000Z", "我的血压最近有点高"],
] as const;

class TermEmbedder implements Embedder {
  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  readonly model = "fixture-term-embedding";
  readonly dimensions = DIMENSIONS;
  fail = false;

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

describe.each(["worker", "direct"] as const)("memory episodes through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(now: { value: string }) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-episodes-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const thread of [THREAD_ID, SENSITIVE_THREAD_ID])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, "2026-10-22T00:00:00.000Z", "2026-10-22T00:00:00.000Z");
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', '2026-10-22T00:00:00.000Z', 'text/plain')`,
    );
    const texts = new Map<string, string>();
    for (const [thread, sequence, role, classification, committedAt, text] of MESSAGES) {
      const ref = `payload-${thread}-${sequence}`;
      texts.set(ref, text);
      insertPayload.run(ref, OWNER_ID, AGENT_ID, classification, `sha256:${ref}`);
      database
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
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => now.value,
    });
    const embedder = new TermEmbedder();
    const prompts: string[] = [];
    const labels: string[] = [];
    const service = new MemoryEpisodeService({
      store: repository.memoryEpisodes(),
      threads: repository.threadRepository(),
      readText: async ({ ref }) => texts.get(ref),
      storeText: async (input) => {
        const directory = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
        try {
          directory
            .prepare(
              `INSERT OR IGNORE INTO payloads (
                ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
                encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
              ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
                'active', ?, 'text/plain')`,
            )
            .run(
              input.ref,
              input.ownerId,
              input.agentId,
              input.dataClassification,
              `sha256:${input.ref}`,
              input.createdAt,
            );
        } finally {
          directory.close();
        }
        texts.set(input.ref, input.text);
      },
      embedder,
      timeZone: "Asia/Tokyo",
      now: () => now.value,
    });
    const summarize = (prompt: string, dataClassification: string) => {
      prompts.push(prompt);
      labels.push(dataClassification);
      return Promise.resolve("主人晚上和老周在新宿吃烤肉，聊到老周换工作的事。");
    };
    return { repository, service, embedder, prompts, labels, summarize };
  }

  it("[RULE-memory-visible] summarizes closed days once, skips the live day and labels a summary of sensitive talk sensitive", async () => {
    const now = { value: "2026-10-25T02:30:00.000Z" };
    const resource = await fixture(now);
    try {
      const due = await resource.service.dueSegments({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        limit: 5,
      });
      expect(
        due.map(({ threadId, day, firstSequence, lastSequence }) => [
          threadId,
          day,
          firstSequence,
          lastSequence,
        ]),
      ).toEqual([
        [SENSITIVE_THREAD_ID, "2026-10-22", 1, 1],
        [THREAD_ID, "2026-10-23", 1, 2],
      ]);
      expect(due.map(({ dataClassification }) => dataClassification)).toEqual([
        "sensitive",
        "private",
      ]);
      const summaries = [];
      for (const segment of due)
        summaries.push(await resource.service.summarize(segment, resource.summarize));
      expect(resource.prompts).toHaveLength(2);
      expect(resource.prompts[0]).toContain("血压");
      expect(resource.labels).toEqual(["sensitive", "private"]);
      expect(summaries.map(({ dataClassification }) => dataClassification)).toEqual([
        "sensitive",
        "private",
      ]);
      expect(resource.prompts[1]).toContain("新宿吃烤肉");
      expect(resource.prompts[1]).not.toContain("血压");
      expect(
        await resource.service.dueSegments({ ownerId: OWNER_ID, agentId: AGENT_ID, limit: 5 }),
      ).toEqual([]);
      now.value = "2026-10-25T05:00:00.000Z";
      expect(
        (
          await resource.service.dueSegments({ ownerId: OWNER_ID, agentId: AGENT_ID, limit: 5 })
        ).map(({ firstSequence, day }) => [day, firstSequence]),
      ).toEqual([["2026-10-25", 3]]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[P3-6] lists the recent day summaries by local day, newest first, and rejects bad input", async () => {
    const now = { value: "2026-10-25T02:30:00.000Z" };
    const resource = await fixture(now);
    try {
      for (const segment of await resource.service.dueSegments({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        limit: 5,
      }))
        await resource.service.summarize(segment, resource.summarize);
      now.value = "2026-10-23T16:00:00.000Z";
      const recent = await resource.service.recent({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        days: 2,
        allowedClassifications: ["public", "private", "sensitive", "restricted"],
        limit: 10,
      });
      expect(recent.partial).toBe(false);
      expect(recent.summaries.map(({ episode }) => episode.day)).toEqual(["2026-10-23"]);
      expect(recent.summaries[0]?.text).toContain("新宿吃烤肉");
      const privateOnly = await resource.service.recent({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        days: 3,
        allowedClassifications: ["private"],
        limit: 10,
      });
      expect(privateOnly.summaries.map(({ episode }) => episode.day)).toEqual(["2026-10-23"]);
      const withSensitive = await resource.service.recent({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        days: 3,
        allowedClassifications: ["private", "sensitive"],
        limit: 10,
      });
      expect(withSensitive.summaries.map(({ episode }) => episode.day)).toEqual([
        "2026-10-23",
        "2026-10-22",
      ]);
      const store = resource.repository.memoryEpisodes();
      for (const bad of [
        {
          fromDay: "2026-10-24",
          toDay: "2026-10-23",
          allowedClassifications: ["private"],
          limit: 5,
        },
        {
          fromDay: "2026/10/23",
          toDay: "2026-10-23",
          allowedClassifications: ["private"],
          limit: 5,
        },
        {
          fromDay: "2026-10-22",
          toDay: "2026-10-23",
          allowedClassifications: ["secret"],
          limit: 5,
        },
        {
          fromDay: "2026-10-22",
          toDay: "2026-10-23",
          allowedClassifications: ["private"],
          limit: 0,
        },
      ])
        await expect(
          store.listDaySummaries({ ownerId: OWNER_ID, agentId: AGENT_ID, ...bad } as never),
        ).rejects.toThrow(/invalid/u);
      for (const activeSince of ["2026-10-23", "yesterday", 5])
        await expect(
          store.listUnsummarized({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            activeSince,
            limit: 5,
          } as never),
        ).rejects.toThrow(/activeSince is invalid/u);
    } finally {
      await resource.repository.close();
    }
  });

  it("finds an episode by meaning and words inside the asked window only", async () => {
    const now = { value: "2026-10-25T02:30:00.000Z" };
    const resource = await fixture(now);
    try {
      for (const segment of await resource.service.dueSegments({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        limit: 5,
      }))
        await resource.service.summarize(segment, resource.summarize);
      const ask = (query: string, dates: { from?: string; to?: string } = {}) =>
        resource.service.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          query,
          scope: requestedTimeScope({ ...dates, includeHistory: false }, "Asia/Tokyo"),
          allowedClassifications: ["public", "private"],
          limit: 3,
        });
      const found = await ask("前天晚上我和谁吃烤肉了？", { from: "2026-10-23", to: "2026-10-23" });
      expect(found.map(({ episode }) => episode.day)).toEqual(["2026-10-23"]);
      expect(found[0]?.text).toContain("老周");
      expect(await ask("上个月我和谁吃烤肉了？", { from: "2026-09-01", to: "2026-09-30" })).toEqual(
        [],
      );
      expect((await ask("我血压怎么样")).map(({ text }) => text).join("")).not.toContain("血压");
    } finally {
      await resource.repository.close();
    }
  });

  it("[RULE-memory-visible] indexes the words of a sensitive day's summary and backfills its vector", async () => {
    const now = { value: "2026-10-25T02:30:00.000Z" };
    const resource = await fixture(now);
    try {
      resource.embedder.fail = true;
      const [segment] = await resource.service.dueSegments({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        limit: 5,
      });
      if (segment?.dataClassification !== "sensitive") throw new Error("sensitive segment");
      await resource.service.summarize(segment, resource.summarize);
      const ask = (allowedClassifications: ("public" | "private" | "sensitive")[]) =>
        resource.service.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          query: "烤肉",
          scope: null,
          allowedClassifications,
          limit: 3,
        });
      expect((await ask(["sensitive"])).map(({ episode }) => episode.threadId)).toEqual([
        SENSITIVE_THREAD_ID,
      ]);
      expect(await ask(["public", "private"])).toEqual([]);
      resource.embedder.fail = false;
      expect(
        await resource.service.backfillEmbeddings({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          limit: 5,
        }),
      ).toBe(1);
    } finally {
      await resource.repository.close();
    }
  });

  it("[P3-1] lists summaries without a vector strictly after a position, ordered by creation time and then id", async () => {
    const now = { value: "2026-10-25T02:30:00.000Z" };
    const resource = await fixture(now);
    try {
      resource.embedder.fail = true;
      const segments = await resource.service.dueSegments({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        limit: 5,
      });
      for (const [index, segment] of segments.entries()) {
        now.value = new Date(Date.parse("2026-10-25T02:30:00.000Z") + index * 60_000).toISOString();
        await resource.service.summarize(segment, resource.summarize);
      }
      const episodes = resource.repository.memoryEpisodes();
      const unembedded = {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        model: resource.embedder.model,
        dimensions: resource.embedder.dimensions,
        limit: 5,
      };
      const all = await episodes.listUnembedded(unembedded);
      const [first, second] = all;
      if (!first || !second) throw new Error("two pending summaries");
      expect(first.createdAt < second.createdAt).toBe(true);
      const ids = async (after: { createdAt: string; id: string }) =>
        (await episodes.listUnembedded({ ...unembedded, after })).map(({ id }) => id);
      const rest = all.slice(1).map(({ id }) => id);
      expect(await ids({ createdAt: first.createdAt, id: first.id })).toEqual(rest);
      expect(await ids({ createdAt: first.createdAt, id: "\uffff" })).toEqual(rest);
      expect(await ids({ createdAt: first.createdAt, id: "" })).toEqual(all.map(({ id }) => id));
      expect(await ids({ createdAt: second.createdAt, id: second.id })).toEqual(rest.slice(1));
      await expect(
        episodes.listUnembedded({ ...unembedded, after: { createdAt: 1, id: first.id } as never }),
      ).rejects.toThrow("position");
    } finally {
      await resource.repository.close();
    }
  });

  it("stores a summary without a vector when embedding fails and backfills it later", async () => {
    const now = { value: "2026-10-25T02:30:00.000Z" };
    const resource = await fixture(now);
    try {
      resource.embedder.fail = true;
      const [, segment] = await resource.service.dueSegments({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        limit: 5,
      });
      if (!segment) throw new Error("segment");
      await resource.service.summarize(segment, resource.summarize);
      const unembedded = {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        model: resource.embedder.model,
        dimensions: resource.embedder.dimensions,
        limit: 5,
      };
      const [pending] = await resource.repository.memoryEpisodes().listUnembedded(unembedded);
      if (!pending) throw new Error("pending");
      expect(
        await resource.repository.memoryEpisodes().listUnembedded({
          ...unembedded,
          after: { createdAt: pending.createdAt, id: pending.id },
        }),
      ).toEqual([]);
      expect(
        (
          await resource.repository.memoryEpisodes().listUnembedded({
            ...unembedded,
            after: { createdAt: pending.createdAt, id: "" },
          })
        ).map(({ id }) => id),
      ).toEqual([pending.id]);
      resource.embedder.fail = false;
      expect(
        await resource.service.backfillEmbeddings({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          limit: 5,
        }),
      ).toBe(1);
      expect(
        await resource.service.backfillEmbeddings({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          limit: 5,
        }),
      ).toBe(0);
      const found = await resource.service.search({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        query: "天气",
        scope: null,
        allowedClassifications: ["private"],
        limit: 3,
      });
      expect(found.map(({ episode }) => episode.source)).not.toContain("compaction");
    } finally {
      await resource.repository.close();
    }
  });
});
