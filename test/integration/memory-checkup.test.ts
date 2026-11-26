import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApplicationPortError,
  createProactiveSeal,
  DEFAULT_REVIEW_PREREVIEW,
  DurableMemoryService,
  type MemoryCheckupPair,
  MemoryCheckupService,
  type MemoryContentPort,
  type ProactiveConfiguration,
  type ProductMemoryAttributes,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
  type MemoryId,
} from "@himawari-agent/domain";
import { type GatewayV2Command, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { type Embedder, HybridMemoryProvider, indexTerms } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionProactive } from "../../apps/agent-service/src/production-proactive.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-checkup");
const AGENT_ID = createAgentId("agent-memory-checkup");
const THREAD_ID = createThreadId("thread-memory-checkup");
const GENERATION_ID = createMemoryGenerationId("generation-memory-checkup");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const DIMENSIONS = 16;
const T0 = "2026-05-01T00:00:00.000Z";
const WEDNESDAY_NOON_JST = "2026-11-11T03:00:00.000Z";
const MONDAY_JST = "2026-11-08T15:00:00.000Z";

class TermEmbedder implements Embedder {
  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

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

interface Seed {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly usedAt?: string;
  readonly confidence?: number;
  readonly refs?: readonly string[];
  readonly found?: boolean;
  readonly attributes?: Partial<ProductMemoryAttributes>;
}

const RECENT = "2026-11-09T00:00:00.000Z";
const SEEDS: readonly Seed[] = [
  {
    id: "milk-old",
    text: "平时喝明治的牛奶",
    at: "2026-10-01T00:00:00.000Z",
    usedAt: RECENT,
  },
  {
    id: "milk-new",
    text: "出差时喝便利店的牛奶",
    at: "2026-11-05T00:00:00.000Z",
    confidence: 700,
    attributes: { tentative: true },
  },
  { id: "stale", text: "主人以前住在足立区", at: T0 },
  {
    id: "unsure",
    text: "主人好像喜欢爵士乐",
    at: "2026-11-01T00:00:00.000Z",
    usedAt: RECENT,
    confidence: 600,
    attributes: { tentative: true },
  },
  {
    id: "lost",
    text: "主人的车是白色的",
    at: "2026-10-20T00:00:00.000Z",
    usedAt: RECENT,
    found: false,
  },
  {
    id: "found",
    text: "主人周六跑步",
    at: "2026-10-20T00:00:00.000Z",
    usedAt: RECENT,
  },
  {
    id: "reminder",
    text: "十二月一日交房租",
    at: "2026-10-20T00:00:00.000Z",
    usedAt: RECENT,
    refs: ["memory-content:reminder:rent"],
    found: false,
  },
  {
    id: "sure",
    text: "主人的女儿叫小葵",
    at: "2026-10-20T00:00:00.000Z",
    usedAt: RECENT,
    confidence: 900,
  },
];

const PAIRS: readonly MemoryCheckupPair[] = [
  {
    memoryId: createMemoryId("milk-new"),
    relatedMemoryId: createMemoryId("milk-old"),
  },
];

const proactiveConfiguration = (budgetSeconds: number): ProactiveConfiguration => ({
  modelRef: "model-unused",
  gmail: { clientId: "client-1", clientSecretRef: "google-oauth" },
  intervalMs: 900_000,
  perCheckMs: 180_000,
  dailyCostMicros: 1_000_000,
  bodyCharactersPerMail: 16_000,
  bodyCharactersPerBatch: 64_000,
  relatedMailsPerMail: 6,
  relatedCharactersPerMail: 12_000,
  relatedCharactersPerRelatedMail: 2_000,
  relatedRequestsPerCheck: 300,
  memoryMinimumSimilarity: 0.45,
  reviewBudgetSeconds: budgetSeconds,
  reviewSecondsPerItem: 5,
  reviewSilentSharePermille: 500,
  reviewMemoryUnusedDays: 90,
  reviewPrereview: DEFAULT_REVIEW_PREREVIEW,
  wholeThreadMailsPerMail: 50,
  wholeThreadCharactersPerMail: 60_000,
  ruleReplayDays: 30,
  ruleReplayMailsPerOutcome: 300,
});

function command(payload: unknown): GatewayV2Command {
  return gatewayV2MessageSchema.parse({
    schemaVersion: "gateway.v2",
    kind: "command",
    type: "proactive.review.checkup",
    messageId: "message-checkup",
    correlationId: "correlation-checkup",
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: "authorization-01",
    scope,
    authority: {
      deploymentId: "deployment-01",
      authorityEpoch: 1,
      fencingToken: 1,
    },
    actor: { actorType: "owner", actorId: "owner-subject" },
    idempotencyKey: `idempotency-${Math.random()}`,
    payload,
  }) as GatewayV2Command;
}

describe.each(["worker", "direct"] as const)("[P4-6] memory checkup through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(
    options: {
      readonly weekly?: number;
      readonly budget?: number;
      readonly failTrash?: boolean;
      readonly failWeek?: boolean;
      readonly failReviseOnce?: MemoryId;
      readonly failMergeAndRestore?: boolean;
      readonly pairs?: readonly MemoryCheckupPair[];
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-checkup-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
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
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const seed of SEEDS)
      insertPayload.run(`payload-${seed.id}`, OWNER_ID, AGENT_ID, `sha256:${seed.id}`, T0);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-memory-checkup', ?, ?, ?, ?, 1, 1,
          'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-memory-checkup', ?, ?, ?, 'completed',
          'model-memory-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const clock = new ManualClock(T0);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    const content = new MapMemoryContent();
    for (const seed of SEEDS) content.values.set(`payload-${seed.id}`, seed.text);
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new HybridMemoryProvider({
        index: repository.memoryIndex(),
        embedder: new TermEmbedder(),
        embeddableClassifications: ["public", "private"],
        now: () => clock.now(),
      }),
      content,
      workerId: "memory-checkup-worker",
      now: () => clock.now(),
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    const state = repository.productMemoryState();
    for (const seed of SEEDS) {
      clock.set(seed.at);
      await memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(seed.id),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: `payload-${seed.id}`,
            dataClassification: "private",
            sourceThreadId: THREAD_ID,
            sourceRefs: seed.refs ?? [`message-${seed.id}`],
            inference: false,
            confidencePermille: seed.confidence ?? 1000,
            policyVersion: "memory-policy-v1",
            attributes: {
              category: "preference",
              importancePermille: 500,
              entities: [],
              validFrom: null,
              validTo: null,
              supersededBy: null,
              evidenceVerified: true,
              ...seed.attributes,
            },
          },
        },
        GENERATION_ID,
      );
    }
    for (const seed of SEEDS)
      if (seed.usedAt) await state.markUsed([createMemoryId(seed.id)], seed.usedAt);
    clock.set(WEDNESDAY_NOON_JST);
    let failRevise = options.failReviseOnce;
    let revisions = 0;
    const ids = new DeterministicIdGenerator();
    const weekly = options.weekly ?? 24;
    const checkup = new MemoryCheckupService({
      scope,
      store: repository.memoryCheckup(),
      state,
      memory: options.failMergeAndRestore
        ? {
            confirm: async () => {
              throw new Error("confirm failed");
            },
            recover: memory.recover.bind(memory),
            trash: memory.trash.bind(memory),
            revise: async (input: Parameters<typeof memory.revise>[0]) => {
              revisions += 1;
              if (revisions > 1) throw new Error("revise failed");
              return memory.revise(input);
            },
          }
        : options.failReviseOnce
          ? {
              confirm: memory.confirm.bind(memory),
              recover: memory.recover.bind(memory),
              trash: memory.trash.bind(memory),
              revise: async (input: Parameters<typeof memory.revise>[0]) => {
                if (input.memoryId === failRevise) {
                  failRevise = undefined;
                  throw new Error("revise failed");
                }
                return memory.revise(input);
              },
            }
          : options.failTrash
            ? {
                confirm: memory.confirm.bind(memory),
                recover: memory.recover.bind(memory),
                revise: memory.revise.bind(memory),
                trash: async () => {
                  throw new Error("trash failed");
                },
              }
            : memory,
      generationFor: async () => GENERATION_ID,
      sourceMessageIds: async (records) =>
        new Map(
          records.map((record) => {
            const seed = SEEDS.find(({ id }) => id === record.id);
            return [record.id as string, seed?.found === false ? null : `message:${record.id}`];
          }),
        ),
      pairs: async () => options.pairs ?? PAIRS,
      unusedDays: 90,
      lowConfidenceThreshold: () => 850,
      capacity: () => weekly,
      timeZone: "Asia/Tokyo",
      now: () => clock.now(),
      id: () => ids.next("memory-checkup"),
    });
    const protector = new DeterministicPayloadProtector();
    const failures: unknown[] = [];
    const proactive = new ProductionProactive({
      scope,
      configuration: proactiveConfiguration(options.budget ?? 120),
      timeZone: "Asia/Tokyo",
      store: repository.proactive(),
      seal: createProactiveSeal({
        payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
        protector,
        ids,
      }),
      oauth: {} as never,
      reader: {} as never,
      readAccount: async () => "owner@example.com",
      model: {} as never,
      ledger: repository.decisionLedger(),
      readMemoryText: async () => undefined,
      readMemory: async (memoryId) => {
        const record = await state.read(memoryId as MemoryId);
        if (!record) return undefined;
        return {
          text: content.values.get(record.contentRef) ?? "",
          hidden: false,
        };
      },
      checkup: options.failWeek
        ? {
            week: async () => {
              throw new Error("week failed");
            },
            act: checkup.act.bind(checkup),
            undo: checkup.undo.bind(checkup),
          }
        : checkup,
      estimateCostMicros: () => 0,
      feedback: async () => [],
      clock,
      ids,
      onFailure: (error) => failures.push(error),
    });
    return { clock, state, memory, checkup, proactive, failures };
  }

  const picked = (
    items: readonly {
      memoryId: string;
      reason: string;
      relatedMemoryId: string | null;
    }[],
  ) => items.map(({ memoryId, reason, relatedMemoryId }) => [memoryId, reason, relatedMemoryId]);

  it("builds one list per week from the four reasons and leaves fine memories out", async () => {
    const { clock, checkup } = await fixture();
    const week = await checkup.week();
    expect(week.every(({ weekStart }) => weekStart === MONDAY_JST)).toBe(true);
    expect(picked(week)).toEqual([
      ["milk-new", "conflict", "milk-old"],
      ["stale", "unused", null],
      ["unsure", "low_confidence", null],
      ["lost", "source_unavailable", null],
    ]);
    for (const fine of ["found", "reminder", "sure"])
      expect(week.map(({ memoryId }) => memoryId)).not.toContain(fine);
    clock.set("2026-11-15T14:59:00.000Z");
    expect((await checkup.week()).map(({ id }) => id)).toEqual(week.map(({ id }) => id));
    clock.set("2026-11-15T15:00:00.000Z");
    const next = await checkup.week();
    expect(next.every(({ weekStart }) => weekStart === "2026-11-15T15:00:00.000Z")).toBe(true);
    expect(next.map(({ id }) => id)).not.toEqual(week.map(({ id }) => id));
    expect(picked(next)).toEqual(picked(week));
  });

  it("stores confirm, delete and merge and undoes each back to the state before", async () => {
    const { checkup, state } = await fixture();
    const week = await checkup.week();
    const item = (memoryId: string) => {
      const found = week.find((entry) => entry.memoryId === memoryId);
      if (!found) throw new Error(`missing ${memoryId}`);
      return found;
    };
    const read = async (id: string) => {
      const record = await state.read(createMemoryId(id));
      return {
        status: record?.status,
        tentative: record?.attributes?.tentative === true,
        supersededBy: record?.attributes?.supersededBy ?? null,
        validTo: record?.attributes?.validTo ?? null,
      };
    };

    const confirmed = await checkup.act({
      id: item("unsure").id,
      action: "confirm",
      keep: null,
    });
    expect(confirmed).toMatchObject({ action: "confirm", undoneAt: null });
    expect(await read("unsure")).toMatchObject({
      status: "active",
      tentative: false,
    });
    await expect(
      checkup.act({ id: item("unsure").id, action: "delete", keep: null }),
    ).rejects.toThrow(ApplicationPortError);
    const unconfirmed = await checkup.undo(item("unsure").id);
    expect(unconfirmed).toMatchObject({ action: null, handledAt: null });
    expect(unconfirmed.undoneAt).not.toBeNull();
    expect(await read("unsure")).toMatchObject({
      status: "active",
      tentative: true,
    });

    await checkup.act({ id: item("stale").id, action: "delete", keep: null });
    expect(await read("stale")).toMatchObject({ status: "trashed" });
    await checkup.undo(item("stale").id);
    expect(await read("stale")).toMatchObject({
      status: "active",
      tentative: false,
    });

    const before = {
      old: await read("milk-old"),
      fresh: await read("milk-new"),
    };
    await expect(
      checkup.act({
        id: item("milk-new").id,
        action: "merge",
        keep: createMemoryId("sure"),
      }),
    ).rejects.toThrow("MEMORY_CHECKUP_MERGE_REFUSED");
    const merged = await checkup.act({
      id: item("milk-new").id,
      action: "merge",
      keep: createMemoryId("milk-new"),
    });
    expect(merged.keptMemoryId).toBe("milk-new");
    expect(await read("milk-old")).toMatchObject({
      status: "archived",
      supersededBy: "milk-new",
    });
    expect(await read("milk-new")).toMatchObject({
      status: "active",
      tentative: false,
    });
    await checkup.undo(item("milk-new").id);
    expect(await read("milk-old")).toEqual(before.old);
    expect(await read("milk-new")).toEqual(before.fresh);

    await expect(
      checkup.act({
        id: item("stale").id,
        action: "merge",
        keep: createMemoryId("stale"),
      }),
    ).rejects.toThrow("MEMORY_CHECKUP_MERGE_REFUSED");
    await expect(checkup.undo(item("lost").id)).rejects.toThrow("MEMORY_CHECKUP_NOT_HANDLED");
  });

  it("keeps a memory confirmed as fine out of the next weeks, but not one that was undone", async () => {
    const { clock, checkup, state } = await fixture();
    const week = await checkup.week();
    const lost = week.find(({ memoryId }) => memoryId === "lost");
    const stale = week.find(({ memoryId }) => memoryId === "stale");
    if (!lost || !stale) throw new Error("missing items");
    const revision = (await state.read(createMemoryId("lost")))?.revision;
    await checkup.act({ id: lost.id, action: "confirm", keep: null });
    expect((await state.read(createMemoryId("lost")))?.revision).toBe(revision);
    await checkup.act({ id: stale.id, action: "confirm", keep: null });
    await checkup.undo(stale.id);
    clock.set("2026-11-18T03:00:00.000Z");
    const next = (await checkup.week()).map(({ memoryId }) => memoryId);
    expect(next).not.toContain("lost");
    expect(next).toContain("stale");
  });

  it("lets one day handle only as many checkup items as the daily rating budget, undo gives none back", async () => {
    const { clock, checkup, proactive, failures } = await fixture({
      weekly: 4,
      budget: 15,
    });
    const week = await checkup.week();
    expect(week).toHaveLength(4);
    const review = await proactive.review();
    expect(review.capacity).toBe(3);
    const shown = review.items.filter(({ source }) => source === "checkup");
    expect(shown).toHaveLength(3);
    const hidden = week.find(({ id }) => !shown.some(({ key }) => key === `checkup:${id}`));
    if (!hidden) throw new Error("expected one item over today's budget");
    const act = (key: string, action: string, keep: string | null = null) =>
      proactive.execute(command({ key, action, keep }));
    await expect(act(`checkup:${hidden.id}`, "confirm")).rejects.toThrow(
      "PROACTIVE_REVIEW_BUDGET_USED",
    );
    for (const item of shown) await act(item.key, "confirm");
    await act(shown[0]?.key ?? "", "undo");
    await expect(act(`checkup:${hidden.id}`, "confirm")).rejects.toThrow(
      "PROACTIVE_REVIEW_BUDGET_USED",
    );
    await expect(
      proactive.execute(
        gatewayV2MessageSchema.parse({
          ...command({ key: "x", action: "confirm", keep: null }),
          type: "proactive.review.rate",
          payload: { ratings: [{ key: shown[1]?.key, rating: "useful" }] },
        }) as GatewayV2Command,
      ),
    ).rejects.toThrow("PROACTIVE_REVIEW_KEY_INVALID");
    clock.set("2026-11-12T03:00:00.000Z");
    const tomorrow = (await proactive.review()).items.map(({ key }) => key);
    expect(tomorrow).toContain(`checkup:${hidden.id}`);
    expect(tomorrow).toContain(shown[0]?.key);
    expect(tomorrow).toContain(shown[1]?.key);
    const next = await proactive.review();
    expect(next.sampled).toBe(2);
    expect(next.items.find(({ key }) => key === shown[1]?.key)?.checkup?.action).toBe("confirm");
    await act(shown[1]?.key ?? "", "undo");
    await act(`checkup:${hidden.id}`, "confirm");
    expect(failures).toEqual([]);
  });

  it("handles an item once when it is clicked twice at the same time", async () => {
    const { checkup, state } = await fixture();
    const pair = (await checkup.week()).find(({ reason }) => reason === "conflict");
    if (!pair?.relatedMemoryId) throw new Error("missing pair");
    const results = await Promise.allSettled([
      checkup.act({ id: pair.id, action: "merge", keep: pair.memoryId }),
      checkup.act({
        id: pair.id,
        action: "merge",
        keep: pair.relatedMemoryId,
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const statuses = await Promise.all(
      [pair.memoryId, pair.relatedMemoryId].map(async (id) => (await state.read(id))?.status),
    );
    expect(statuses.filter((status) => status === "archived")).toHaveLength(1);
  });

  it("[negative] leaves the item unhandled and the memory unchanged when the change fails", async () => {
    const { checkup, state } = await fixture({ failTrash: true });
    const stale = (await checkup.week()).find(({ memoryId }) => memoryId === "stale");
    if (!stale) throw new Error("missing stale");
    await expect(checkup.act({ id: stale.id, action: "delete", keep: null })).rejects.toThrow(
      "trash failed",
    );
    expect((await state.read(createMemoryId("stale")))?.status).toBe("active");
    expect((await checkup.week()).find(({ id }) => id === stale.id)?.action).toBeNull();
  });

  it("undoes an item whose memory was already changed elsewhere without touching that change", async () => {
    const { checkup, state, memory } = await fixture();
    const stale = (await checkup.week()).find(({ memoryId }) => memoryId === "stale");
    if (!stale) throw new Error("missing stale");
    await checkup.act({ id: stale.id, action: "delete", keep: null });
    await memory.recover(createMemoryId("stale"), GENERATION_ID);
    const revision = (await state.read(createMemoryId("stale")))?.revision;
    expect(await checkup.undo(stale.id)).toMatchObject({
      action: null,
      handledAt: null,
    });
    expect(await state.read(createMemoryId("stale"))).toMatchObject({
      status: "active",
      revision,
    });
  });

  it("[negative] reports a failed weekly list on the action instead of a used-up budget", async () => {
    const { proactive, failures } = await fixture({ failWeek: true });
    const review = await proactive.review();
    expect(review.items.filter(({ source }) => source === "checkup")).toEqual([]);
    expect(failures).toHaveLength(1);
    await expect(
      proactive.execute(
        command({
          key: "checkup:memory-checkup-0001",
          action: "confirm",
          keep: null,
        }),
      ),
    ).rejects.toThrow("week failed");
  });

  it("finishes undoing a merge on the second try after the first try stopped half way", async () => {
    const { checkup, state } = await fixture({
      failReviseOnce: createMemoryId("milk-new"),
    });
    const pair = (await checkup.week()).find(({ reason }) => reason === "conflict");
    if (!pair) throw new Error("missing pair");
    await checkup.act({
      id: pair.id,
      action: "merge",
      keep: createMemoryId("milk-new"),
    });
    expect((await state.read(createMemoryId("milk-new")))?.attributes?.tentative).not.toBe(true);
    await expect(checkup.undo(pair.id)).rejects.toThrow("revise failed");
    expect((await state.read(createMemoryId("milk-old")))?.status).toBe("active");
    expect(await checkup.undo(pair.id)).toMatchObject({ action: null });
    expect((await state.read(createMemoryId("milk-new")))?.attributes?.tentative).toBe(true);
  });

  it("[negative] reports both errors and keeps the item undoable when taking a failed merge back also fails", async () => {
    const { checkup, state } = await fixture({ failMergeAndRestore: true });
    const pair = (await checkup.week()).find(({ reason }) => reason === "conflict");
    if (!pair) throw new Error("missing pair");
    await expect(
      checkup.act({
        id: pair.id,
        action: "merge",
        keep: createMemoryId("milk-new"),
      }),
    ).rejects.toThrow("MEMORY_CHECKUP_RESTORE_FAILED");
    expect((await state.read(createMemoryId("milk-old")))?.status).toBe("archived");
    expect((await checkup.week()).find(({ id }) => id === pair.id)?.action).toBe("merge");
  });

  it("[negative] leaves out a held pair once the newer memory is no longer pending", async () => {
    const { checkup, memory } = await fixture();
    await memory.confirm(createMemoryId("milk-new"), GENERATION_ID);
    const week = await checkup.week();
    expect(week.map(({ reason }) => reason)).not.toContain("conflict");
  });

  it("lists every held pair as a conflict even when its newer memory is also unsure", async () => {
    const { checkup } = await fixture({
      pairs: [
        ...PAIRS,
        {
          memoryId: createMemoryId("unsure"),
          relatedMemoryId: createMemoryId("found"),
        },
      ],
    });
    const week = picked(await checkup.week());
    expect(week).toContainEqual(["unsure", "conflict", "found"]);
    expect(week).toContainEqual(["milk-new", "conflict", "milk-old"]);
    expect(week).not.toContainEqual(["unsure", "low_confidence", null]);
  });

  it("[negative] refuses to act on a conflict whose newer memory was confirmed after the list was made", async () => {
    const { checkup, memory, state } = await fixture();
    const pair = (await checkup.week()).find(({ reason }) => reason === "conflict");
    if (!pair) throw new Error("missing pair");
    await memory.confirm(createMemoryId("milk-new"), GENERATION_ID);
    await expect(checkup.act({ id: pair.id, action: "delete", keep: null })).rejects.toThrow(
      "MEMORY_CHECKUP_STALE",
    );
    expect((await state.read(createMemoryId("milk-new")))?.status).toBe("active");
  });
});
