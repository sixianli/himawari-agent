import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryContentPort,
  type ProductMemoryAttributes,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type Embedder,
  HybridMemoryProvider,
  indexTerms,
  MemoryConsolidationService,
} from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-consolidation");
const AGENT_ID = createAgentId("agent-memory-consolidation");
const THREAD_ID = createThreadId("thread-memory-consolidation");
const GENERATION_ID = createMemoryGenerationId("generation-memory-consolidation");
const DIMENSIONS = 32;

class TermEmbedder implements Embedder {
  readonly model = "fixture-term-embedding";
  readonly dimensions = DIMENSIONS;

  async embed(text: string): Promise<Float32Array> {
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

class MapMemoryContent implements MemoryContentPort {
  readonly values = new Map<string, string>();

  async readText(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error(`Missing content ${ref}`);
    return value;
  }
}

const MEMORIES: ReadonlyArray<{
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly classification: "private" | "sensitive";
  readonly attributes: Partial<ProductMemoryAttributes>;
}> = [
  {
    id: "coffee-old",
    text: "主人早上喝美式咖啡",
    at: "2026-05-01T00:00:00.000Z",
    classification: "private",
    attributes: { category: "preference", importancePermille: 600 },
  },
  {
    id: "daughter-old",
    text: "主人的女儿叫小葵",
    at: "2026-05-02T00:00:00.000Z",
    classification: "private",
    attributes: { category: "relationship", importancePermille: 900, entities: ["小葵"] },
  },
  {
    id: "onigiri",
    text: "主人有一次在便利店买了饭团",
    at: "2026-01-10T00:00:00.000Z",
    classification: "private",
    attributes: { category: "event", importancePermille: 300 },
  },
  {
    id: "allergy",
    text: "主人对青霉素过敏",
    at: "2026-10-20T00:00:00.000Z",
    classification: "sensitive",
    attributes: { category: "health", importancePermille: 950 },
  },
  {
    id: "coffee-new",
    text: "主人早上改喝燕麦拿铁咖啡",
    at: "2026-10-20T00:00:00.000Z",
    classification: "private",
    attributes: { category: "preference", importancePermille: 600 },
  },
  {
    id: "daughter-new",
    text: "主人的女儿名叫小葵",
    at: "2026-10-21T00:00:00.000Z",
    classification: "private",
    attributes: { category: "relationship", importancePermille: 900, entities: ["小葵"] },
  },
  {
    id: "fish-old",
    text: "主人不太喜欢吃鱼",
    at: "2026-05-03T00:00:00.000Z",
    classification: "private",
    attributes: { category: "preference", subCategory: "饮食", importancePermille: 600 },
  },
  {
    id: "fish-new",
    text: "主人最近迷上了刺身拼盘",
    at: "2026-10-24T00:00:00.000Z",
    classification: "private",
    attributes: { category: "preference", subCategory: "饮食", importancePermille: 600 },
  },
  {
    id: "run-a",
    text: "主人周六早上在公园跑步",
    at: "2026-10-22T00:00:00.000Z",
    classification: "private",
    attributes: { category: "preference", importancePermille: 500 },
  },
  {
    id: "run-b",
    text: "主人报名了年底的半程马拉松",
    at: "2026-10-23T00:00:00.000Z",
    classification: "private",
    attributes: { category: "goal", importancePermille: 600 },
  },
];

const QUOTES: Readonly<Record<string, string>> = {
  "fish-new": "我今天不吃鱼，昨天吃撑了",
};

function labelsOf(prompt: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const match of prompt.matchAll(/^(M\d+)（[0-9-]+）(.+)$/gmu))
    labels.set(match[2] ?? "", match[1] ?? "");
  return labels;
}

function groupOf(prompt: string, label: string): string | undefined {
  let group: string | undefined;
  for (const line of prompt.split("\n")) {
    const header = /^组 (g\d+)$/u.exec(line);
    if (header) group = header[1];
    else if (line === "新记忆：") return undefined;
    else if (line.startsWith(`${label}（`) && group) return group;
  }
  return undefined;
}

describe.each(["worker", "direct"] as const)("memory consolidation through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-consolidation-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    const T0 = "2026-05-01T00:00:00.000Z";
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'open', ?, ?)`,
      )
      .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const memory of MEMORIES)
      insertPayload.run(
        `payload-${memory.id}`,
        OWNER_ID,
        AGENT_ID,
        memory.classification,
        `sha256:${memory.id}`,
        T0,
      );
    insertPayload.run("payload-rule", OWNER_ID, AGENT_ID, "private", "sha256:rule", T0);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-memory-consolidation', ?, ?, ?, ?, 1, 1,
          'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-memory-consolidation', ?, ?, ?, 'completed',
          'model-memory-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const clock = { value: T0 };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    const content = new MapMemoryContent();
    for (const memory of MEMORIES) content.values.set(`payload-${memory.id}`, memory.text);
    content.values.set("payload-rule", "回答主人时先给结论再解释");
    const provider = new HybridMemoryProvider({
      index: repository.memoryIndex(),
      embedder: new TermEmbedder(),
      embeddableClassifications: ["public", "private"],
      now: () => clock.value,
    });
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content,
      workerId: "memory-consolidation-worker",
      now: () => clock.value,
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    for (const item of MEMORIES) {
      clock.value = item.at;
      await memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(item.id),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: `payload-${item.id}`,
            dataClassification: item.classification,
            sourceThreadId: THREAD_ID,
            sourceRefs: [`message-${item.id}`],
            inference: false,
            confidencePermille: 1000,
            policyVersion: "memory-policy-v1",
            attributes: {
              category: "other",
              importancePermille: 500,
              entities: [],
              validFrom: null,
              validTo: null,
              supersededBy: null,
              evidenceVerified: true,
              ...item.attributes,
            },
          },
        },
        GENERATION_ID,
      );
    }
    clock.value = "2026-10-25T03:00:00.000Z";
    await memory.runProjectionBatch(50);
    const jobs = repository.memoryProjectionJobs();
    const consolidation = new MemoryConsolidationService({
      store: repository.memoryConsolidation(),
      state: repository.productMemoryState(),
      memory,
      generationFor: async (memoryId) => (await jobs.listByMemory(memoryId)).at(-1)?.generationId,
      readText: async (record) => content.values.get(record.contentRef),
      readQuote: async (record) => QUOTES[record.id],
      storeText: async (input) => {
        const ref = `memory-content:${input.key}`;
        const connection = openQualifiedDatabase(databasePath);
        try {
          connection
            .prepare(
              `INSERT OR IGNORE INTO payloads (
                ref, owner_id, agent_id, classification, storage_kind, ciphertext,
                content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at,
                content_type
              ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
                'active', ?, 'text/plain')`,
            )
            .run(
              ref,
              input.ownerId,
              input.agentId,
              input.dataClassification,
              `sha256:${ref}`,
              input.createdAt,
            );
        } finally {
          connection.close();
        }
        content.values.set(ref, input.text);
        return ref;
      },
      now: () => clock.value,
      timeZone: "Asia/Tokyo",
    });
    const prompts: string[] = [];
    const run = (
      decide: (prompt: string) => Promise<string> | string = (prompt) => {
        const labels = labelsOf(prompt);
        const label = (id: string) =>
          labels.get(MEMORIES.find((item) => item.id === id)?.text ?? "") ?? "";
        return JSON.stringify({
          groups: [
            {
              group: groupOf(prompt, label("coffee-new")),
              action: "conflict",
              keep: label("coffee-new"),
              drop: label("coffee-old"),
            },
            {
              group: groupOf(prompt, label("daughter-new")),
              action: "duplicate",
              keep: label("daughter-new"),
              drop: label("daughter-old"),
            },
          ],
          insights: [
            {
              text: "主人在为年底的半程马拉松坚持晨跑",
              category: "goal",
              basis: [label("run-a"), label("run-b")],
            },
            {
              text: "主人可能血压偏高",
              category: "health",
              basis: [label("run-a"), label("run-b")],
            },
          ],
        });
      },
    ) =>
      consolidation.run({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        triggerRunId: "run-consolidation",
        search: (query, limit) =>
          provider.search({ ownerId: OWNER_ID, agentId: AGENT_ID, query, limit }),
        generate: async (prompt) => {
          prompts.push(prompt);
          return decide(prompt);
        },
      });
    const read = (id: string) => repository.productMemoryState().read(createMemoryId(id));
    const searchable = async (query: string, includeTentative: boolean | "only" = false) =>
      (
        await provider.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          query,
          limit: 10,
          ...(includeTentative === "only"
            ? { includeTentative: true, tentativeOnly: true }
            : includeTentative
              ? { includeTentative: true }
              : {}),
        })
      ).map(({ productMemoryId }) => productMemoryId as string);
    return { repository, memory, consolidation, clock, prompts, run, read, searchable };
  }

  it("merges duplicates, supersedes old facts, archives idle trivia and keeps insights tentative", async () => {
    const resource = await fixture();
    try {
      const result = await resource.run();
      expect(result?.modelCalled).toBe(true);
      expect(result?.changes.map(({ action, memoryId }) => [action, memoryId]).sort()).toEqual(
        [
          ["archive", "onigiri"],
          ["merge", "daughter-old"],
          ["reflect", `${result?.id}:insight:0`],
          ["supersede", "coffee-old"],
        ].sort(),
      );
      const ledger = await resource.repository.decisionLedger().list({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        kind: "consolidation",
        since: "1970-01-01T00:00:00.000Z",
        limit: 50,
      });
      expect(ledger.map(({ outcome, subjectRef }) => [outcome, subjectRef]).sort()).toEqual(
        [
          ["archive", "onigiri"],
          ["merge", "daughter-old"],
          ["reflect", `${result?.id}:insight:0`],
          ["supersede", "coffee-old"],
        ].sort(),
      );
      expect(ledger.every((entry) => entry.ownerRating === null && entry.costMicros === 0)).toBe(
        true,
      );
      const byOutcome = new Map(ledger.map((entry) => [entry.outcome, entry]));
      const batchId = resource.consolidation.consolidationId(AGENT_ID);
      expect(ledger.every((entry) => entry.inputs.batchId === batchId)).toBe(true);
      expect(byOutcome.get("merge")?.inputs).toMatchObject({
        memoryIds: ["daughter-old", "daughter-new"],
        resultMemoryIds: ["daughter-new"],
      });
      expect(byOutcome.get("supersede")?.inputs).toMatchObject({
        memoryIds: ["coffee-old", "coffee-new"],
        resultMemoryIds: ["coffee-new"],
      });
      expect(byOutcome.get("archive")?.inputs).toMatchObject({
        memoryIds: ["onigiri"],
        resultMemoryIds: [],
      });
      expect([...(byOutcome.get("reflect")?.inputs.memoryIds ?? [])].sort()).toEqual([
        "run-a",
        "run-b",
      ]);
      expect(byOutcome.get("reflect")?.inputs.resultMemoryIds).toEqual([`${result?.id}:insight:0`]);
      const store = resource.repository.memoryConsolidation();
      const stored = await store.listChanges({ ownerId: OWNER_ID, agentId: AGENT_ID, limit: 10 });
      const basisOf = async (action: string) => {
        const change = stored.find((entry) => entry.action === action);
        if (!change) throw new Error(`${action} change missing`);
        return [...(await store.readBasis(change.id))];
      };
      expect(await basisOf("merge")).toEqual(["daughter-old", "daughter-new"]);
      expect(await basisOf("supersede")).toEqual(["coffee-old", "coffee-new"]);
      expect(await basisOf("archive")).toEqual(["onigiri"]);
      expect((await basisOf("reflect")).sort()).toEqual(["run-a", "run-b"]);
      const reflectChain = await store.readBasisChain({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        memoryId: createMemoryId(`${result?.id}:insight:0`),
      });
      expect(reflectChain.basis.map(({ memoryId }) => memoryId).sort()).toEqual(["run-a", "run-b"]);
      expect(reflectChain.ledgerId).toBe(byOutcome.get("reflect")?.id);
      expect(resource.prompts[0]).not.toContain("青霉素");
      expect((await resource.read("onigiri"))?.status).toBe("archived");
      expect((await resource.read("daughter-old"))?.status).toBe("archived");
      expect((await resource.read("coffee-old"))?.attributes).toMatchObject({
        supersededBy: "coffee-new",
        validTo: "2026-10-20T00:00:00.000Z",
      });
      const insight = await resource.read(`${result?.id}:insight:0`);
      expect(insight).toMatchObject({ inference: true, status: "active" });
      expect(insight?.attributes?.tentative).toBe(true);
      await resource.memory.runProjectionBatch(50);
      expect(await resource.searchable("半程马拉松晨跑")).not.toContain(insight?.id);
      expect(await resource.searchable("半程马拉松晨跑", true)).toContain(insight?.id);
      const only = await resource.searchable("半程马拉松晨跑", "only");
      expect(only).toContain(insight?.id);
      expect(only).toHaveLength(
        (await resource.searchable("半程马拉松晨跑", true)).filter((id) => id === insight?.id)
          .length,
      );
      expect(await resource.run()).toBeNull();
      resource.clock.value = "2026-10-26T03:00:00.000Z";
      const quiet = await resource.run(() => {
        throw new Error("no model call expected");
      });
      expect(quiet).toMatchObject({ modelCalled: false, changes: [] });
      expect(
        await resource.repository.decisionLedger().list({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          kind: "consolidation",
          since: "1970-01-01T00:00:00.000Z",
          limit: 50,
        }),
      ).toHaveLength(4);
    } finally {
      await resource.repository.close();
    }
  });

  it("puts memories of the same category and sub-category in one group even when they share no words", async () => {
    const resource = await fixture();
    try {
      await resource.run((prompt) => {
        const labels = labelsOf(prompt);
        const label = (id: string) =>
          labels.get(MEMORIES.find((item) => item.id === id)?.text ?? "") ?? "";
        expect(groupOf(prompt, label("fish-new"))).toBeDefined();
        expect(groupOf(prompt, label("fish-old"))).toBe(groupOf(prompt, label("fish-new")));
        return JSON.stringify({ groups: [], insights: [] });
      });
    } finally {
      await resource.repository.close();
    }
  });

  it("does not group memories of different sub-categories that share no words", async () => {
    const resource = await fixture();
    try {
      await resource.run((prompt) => {
        const labels = labelsOf(prompt);
        const label = (id: string) =>
          labels.get(MEMORIES.find((item) => item.id === id)?.text ?? "") ?? "";
        expect(groupOf(prompt, label("fish-new"))).toBeDefined();
        expect(groupOf(prompt, label("run-a"))).not.toBe(groupOf(prompt, label("fish-new")));
        return JSON.stringify({ groups: [], insights: [] });
      });
    } finally {
      await resource.repository.close();
    }
  });

  it("[MEM-QUOTE] shows the Owner's own words under a memory that has them, and only there", async () => {
    const resource = await fixture();
    try {
      await resource.run(() => JSON.stringify({ groups: [], insights: [] }));
      const prompt = resource.prompts[0] ?? "";
      expect(prompt).toContain("主人当时的原话：“我今天不吃鱼，昨天吃撑了”");
      const lines = prompt.split("\n");
      const quoted = lines.flatMap((line, index) =>
        line.startsWith("    主人当时的原话") ? [lines[index - 1] ?? ""] : [],
      );
      expect(quoted.length).toBeGreaterThan(0);
      expect(quoted.every((line) => line.includes("主人最近迷上了刺身拼盘"))).toBe(true);
    } finally {
      await resource.repository.close();
    }
  });

  it("undoes each change and refuses once the Owner has changed the memory", async () => {
    const resource = await fixture();
    try {
      const result = await resource.run();
      const changes = await resource.repository
        .memoryConsolidation()
        .listChanges({ ownerId: OWNER_ID, agentId: AGENT_ID, limit: 10 });
      expect(changes).toHaveLength(4);
      for (const change of changes.filter(({ action }) => action !== "reflect"))
        await resource.consolidation.undo(change.id);
      expect((await resource.read("onigiri"))?.status).toBe("active");
      expect((await resource.read("daughter-old"))?.status).toBe("active");
      expect((await resource.read("coffee-old"))?.attributes).toMatchObject({
        supersededBy: null,
        validTo: null,
      });
      const reflect = changes.find(({ action }) => action === "reflect");
      if (!reflect || !result) throw new Error("reflect change missing");
      const insight = await resource.read(reflect.memoryId);
      if (!insight) throw new Error("insight missing");
      await resource.memory.confirm(insight.id, GENERATION_ID);
      await expect(resource.consolidation.undo(reflect.id)).rejects.toThrow(
        "MEMORY_CHANGED_AFTER_CONSOLIDATION",
      );
      const undone = changes.find(({ action }) => action === "archive");
      await expect(resource.consolidation.undo(undone?.id ?? "")).rejects.toThrow("undone");
      const ledger = await resource.repository.decisionLedger().list({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        kind: "consolidation",
        since: "1970-01-01T00:00:00.000Z",
        limit: 50,
      });
      expect(ledger).toHaveLength(4);
      expect(ledger.map(({ outcome, ownerRating }) => [outcome, ownerRating]).sort()).toEqual(
        [
          ["archive", "unneeded"],
          ["merge", "unneeded"],
          ["reflect", null],
          ["supersede", "unneeded"],
        ].sort(),
      );
      expect(
        ledger.filter(({ ownerRating }) => ownerRating !== null).every(({ ratedAt }) => ratedAt),
      ).toBe(true);
    } finally {
      await resource.repository.close();
    }
  });

  it("skips a memory the Owner edited while the model was thinking", async () => {
    const resource = await fixture();
    try {
      const result = await resource.run(async (prompt) => {
        const old = await resource.read("coffee-old");
        if (!old) throw new Error("coffee-old missing");
        await resource.memory.revise({
          memoryId: old.id,
          expectedRevision: old.revision,
          attributes: { importancePermille: 700 },
          generationId: GENERATION_ID,
        });
        const labels = labelsOf(prompt);
        const label = (id: string) =>
          labels.get(MEMORIES.find((item) => item.id === id)?.text ?? "") ?? "";
        return JSON.stringify({
          groups: [
            {
              group: groupOf(prompt, label("coffee-new")),
              action: "conflict",
              keep: label("coffee-new"),
              drop: label("coffee-old"),
            },
          ],
          insights: [],
        });
      });
      expect(result?.changes.map(({ action }) => action)).toEqual(["archive"]);
      expect((await resource.read("coffee-old"))?.attributes?.supersededBy).toBeNull();
    } finally {
      await resource.repository.close();
    }
  });

  it("keeps a tentative rule out of recall until it is seen again", async () => {
    const resource = await fixture();
    try {
      const rule = await resource.memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId("rule-conclusion-first"),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: "payload-rule",
            dataClassification: "private",
            sourceThreadId: THREAD_ID,
            sourceRefs: ["message-rule"],
            inference: false,
            confidencePermille: 900,
            policyVersion: "memory-capture:v3",
            attributes: {
              category: "rule",
              importancePermille: 800,
              entities: [],
              validFrom: null,
              validTo: null,
              supersededBy: null,
              evidenceVerified: true,
              tentative: true,
            },
          },
        },
        GENERATION_ID,
      );
      await resource.memory.runProjectionBatch(10);
      expect(await resource.searchable("先给结论再解释")).not.toContain(rule.id);
      expect(await resource.searchable("先给结论再解释", true)).toContain(rule.id);
      const confirmed = await resource.memory.applyProposal(
        { decision: "unchanged", memoryId: rule.id },
        GENERATION_ID,
      );
      expect(confirmed.attributes?.tentative).toBeUndefined();
      await resource.memory.runProjectionBatch(10);
      expect(await resource.searchable("先给结论再解释")).toContain(rule.id);
    } finally {
      await resource.repository.close();
    }
  });
});
