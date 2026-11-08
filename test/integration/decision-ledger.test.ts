import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type DecisionKind,
  type DecisionLedgerWrite,
  DurableMemoryService,
  type MemoryContentPort,
  type MemoryProviderProjectionPort,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { retrievalDegradeRecorder } from "../../apps/agent-service/src/production-decision-ledger.js";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-ledger");
const AGENT_ID = createAgentId("agent-ledger");
const THREAD_ID = createThreadId("thread-ledger");
const GENERATION_ID = createMemoryGenerationId("generation-ledger");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-10-31T00:00:00.000Z";
const SINCE = "1970-01-01T00:00:00.000Z";

class FixtureContent implements MemoryContentPort {
  async readText(): Promise<string> {
    return "fixture";
  }
}

class NoopProvider implements MemoryProviderProjectionPort {
  async upsert(input: { readonly memory: ProductMemoryRecord }) {
    return input.memory.providerRecordId ?? `provider-${input.memory.id}`;
  }
  async delete() {}
  async search() {
    return [];
  }
  async clearScope() {}
}

function ledgerWrite(
  id: string,
  overrides: Partial<DecisionLedgerWrite> = {},
): DecisionLedgerWrite {
  return {
    id,
    ...scope,
    kind: "memory_candidate",
    decidedAt: T0,
    outcome: "kept",
    reasonCode: "auto_committed",
    subjectRef: "memory-1",
    inputs: { memoryIds: ["memory-1"], ruleIds: [] },
    reasonRef: null,
    contentRef: "payload-1",
    costMicros: 0,
    durationMs: 0,
    ...overrides,
  };
}

describe.each(["worker", "direct"] as const)("decision ledger through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-decision-ledger-"));
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
    for (const ref of ["payload-1", "payload-2", "payload-muse", "payload-note"])
      insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-ledger', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-ledger', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new NoopProvider(),
      content: new FixtureContent(),
      workerId: "ledger-worker",
      now: () => T0,
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    const list = (kind?: DecisionKind) =>
      repository.decisionLedger().list({
        ...scope,
        ...(kind ? { kind } : {}),
        since: SINCE,
        limit: 100,
      });
    return { repository, memory, list };
  }

  function proposal(id: string, contentRef: string) {
    return {
      decision: "create",
      memory: {
        id: createMemoryId(id),
        ...scope,
        contentRef,
        dataClassification: "private",
        sourceThreadId: THREAD_ID,
        sourceRefs: [`message-${id}`],
        inference: false,
        confidencePermille: 1000,
        policyVersion: "memory-policy-v1",
      },
    } as const;
  }

  it("writes and reads back every decision kind, filtered by kind", async () => {
    const { repository, list } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      const rows: ReadonlyArray<[DecisionLedgerWrite["kind"], string]> = [
        ["memory_candidate", "pending_approval"],
        ["consolidation", "archive"],
        ["context_truncation", "truncated"],
        ["retrieval_degrade", "degraded"],
        ["external_read", "read"],
      ];
      for (const [index, [kind, outcome]] of rows.entries())
        await ledger.append(
          ledgerWrite(`row-${index}`, {
            kind,
            outcome,
            reasonCode: `${kind}_reason`,
            subjectRef: `subject-${index}`,
            inputs: { memoryIds: [`m-${index}`, `n-${index}`], ruleIds: [`rule-${index}`] },
            reasonRef: "payload-2",
            contentRef: null,
            costMicros: 1500 + index,
            durationMs: 20 + index,
          }),
        );
      const all = await list();
      expect(all).toHaveLength(5);
      for (const [index, [kind, outcome]] of rows.entries()) {
        expect((await list(kind))[0]).toEqual({
          id: `row-${index}`,
          kind,
          decidedAt: T0,
          outcome,
          reasonCode: `${kind}_reason`,
          subjectRef: `subject-${index}`,
          inputs: {
            memoryIds: [`m-${index}`, `n-${index}`],
            ruleIds: [`rule-${index}`],
            batchId: null,
            resultMemoryIds: [],
            sourceIds: [],
            floorHits: {},
            memoryInjected: false,
            usedMemoryIds: [],
            memoryByMail: {},
            memoryRecall: "off",
            relatedByMail: {},
            relatedRead: "off",
            relatedStats: { requests: 0, messages: 0, characters: 0, durationMs: 0 },
            relatedFailedSteps: [],
          },
          reasonRef: "payload-2",
          contentRef: null,
          costMicros: 1500 + index,
          durationMs: 20 + index,
          ownerRating: null,
          ratedAt: null,
          category: null,
          confidencePermille: null,
          inferred: null,
        });
      }
      expect(await ledger.list({ ...scope, since: "2026-11-01T00:00:00.000Z", limit: 10 })).toEqual(
        [],
      );
    } finally {
      await repository.close();
    }
  });

  it("accepts the three ratings, lets the owner clear one, and refuses anything else", async () => {
    const { repository, list } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      await ledger.append(ledgerWrite("rated"));
      for (const rating of ["useful", "unneeded", "missed"] as const) {
        expect(
          await ledger.rate({
            ...scope,
            decisionId: "rated",
            rating,
            now: "2026-10-31T01:00:00.000Z",
          }),
        ).toBe(true);
        expect((await list())[0]).toMatchObject({
          ownerRating: rating,
          ratedAt: "2026-10-31T01:00:00.000Z",
        });
      }
      await ledger.rate({ ...scope, decisionId: "rated", rating: null, now: T0 });
      expect((await list())[0]).toMatchObject({ ownerRating: null, ratedAt: null });
      await expect(
        ledger.rate({ ...scope, decisionId: "rated", rating: "great" as never, now: T0 }),
      ).rejects.toThrow();
      expect(
        await ledger.rate({ ...scope, decisionId: "not-there", rating: "useful", now: T0 }),
      ).toBe(false);
    } finally {
      await repository.close();
    }
  });

  it("[P0-6] lists unrated rows and rows rated today, leaves out older ones, and rates a batch all-or-nothing", async () => {
    const { repository } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      const day = "2026-10-31T00:00:00.000Z";
      await ledger.append(ledgerWrite("open-1"));
      await ledger.append(ledgerWrite("open-2"));
      await ledger.append(ledgerWrite("old-rated"));
      await ledger.append(ledgerWrite("rated-today"));
      await ledger.append(ledgerWrite("too-old", { decidedAt: "2026-10-01T00:00:00.000Z" }));
      await ledger.rate({
        ...scope,
        decisionId: "old-rated",
        rating: "useful",
        now: "2026-10-30T10:00:00.000Z",
      });
      expect(
        await ledger.rateMany({
          ...scope,
          ratings: [
            { decisionId: "rated-today", rating: "missed" },
            { decisionId: "open-1", rating: "unneeded" },
          ],
          now: "2026-10-31T01:00:00.000Z",
        }),
      ).toBe(2);
      const pool = await ledger.listReviewPool({
        ...scope,
        since: "2026-10-24T00:00:00.000Z",
        ratedSince: day,
        limit: 100,
      });
      expect(pool.map(({ id }) => id).sort()).toEqual(["open-1", "open-2", "rated-today"]);
      expect(pool.find(({ id }) => id === "open-1")).toMatchObject({
        ownerRating: "unneeded",
        ratedAt: "2026-10-31T01:00:00.000Z",
      });
      await expect(
        ledger.rateMany({
          ...scope,
          ratings: [
            { decisionId: "open-2", rating: "useful" },
            { decisionId: "no-such-row", rating: "useful" },
          ],
          now: "2026-10-31T02:00:00.000Z",
        }),
      ).rejects.toThrow();
      const after = await ledger.list({ ...scope, since: SINCE, limit: 100 });
      expect(after.find(({ id }) => id === "open-2")?.ownerRating).toBeNull();
      await expect(
        ledger.rateMany({
          ...scope,
          ratings: [{ decisionId: "open-2", rating: "bogus" as never }],
          now: "2026-10-31T02:00:00.000Z",
        }),
      ).rejects.toThrow();
      await expect(
        ledger.rateMany({
          ownerId: createOwnerId("other-owner"),
          agentId: AGENT_ID,
          ratings: [{ decisionId: "open-2", rating: "useful" }],
          now: "2026-10-31T02:00:00.000Z",
        }),
      ).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it("refuses writes whose outcome does not belong to the kind", async () => {
    const { repository, list } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      await expect(
        ledger.append(ledgerWrite("bad-1", { kind: "consolidation", outcome: "kept" })),
      ).rejects.toThrow();
      await expect(
        ledger.append(ledgerWrite("bad-2", { kind: "proactive" as never, outcome: "silent" })),
      ).rejects.toThrow();
      await expect(
        ledger.append(ledgerWrite("bad-3", { inputs: { memoryIds: ["a", "a"], ruleIds: [] } })),
      ).rejects.toThrow();
      expect(await list()).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("records Muse reference entries beside the ledger and pairs them with a decision", async () => {
    const { repository } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      await ledger.append(ledgerWrite("paired", { kind: "consolidation", outcome: "merge" }));
      await ledger.recordMuse({
        id: "muse-1",
        ...scope,
        museAt: "2026-10-31T00:30:00.000Z",
        museReminded: true,
        timingOk: true,
        contentOk: false,
        contentRef: "payload-muse",
        noteRef: "payload-note",
        pairedDecisionId: "paired",
        recordedAt: T0,
      });
      await ledger.recordMuse({
        id: "muse-2",
        ...scope,
        museAt: "2026-10-30T00:30:00.000Z",
        museReminded: true,
        timingOk: false,
        contentOk: true,
        contentRef: "payload-muse",
        noteRef: null,
        pairedDecisionId: null,
        recordedAt: T0,
      });
      expect(await ledger.listMuse({ ...scope, since: SINCE, limit: 10 })).toEqual([
        {
          id: "muse-1",
          museAt: "2026-10-31T00:30:00.000Z",
          museReminded: true,
          timingOk: true,
          contentOk: false,
          contentRef: "payload-muse",
          noteRef: "payload-note",
          pairedDecisionId: "paired",
          intakeItemKey: null,
          pairedMessageId: null,
          recordedAt: T0,
        },
        {
          id: "muse-2",
          museAt: "2026-10-30T00:30:00.000Z",
          museReminded: true,
          timingOk: false,
          contentOk: true,
          contentRef: "payload-muse",
          noteRef: null,
          pairedDecisionId: null,
          intakeItemKey: null,
          pairedMessageId: null,
          recordedAt: T0,
        },
      ]);
      expect(await ledger.list({ ...scope, since: SINCE, limit: 10 })).toHaveLength(1);
      await expect(
        ledger.recordMuse({
          id: "muse-3",
          ...scope,
          museAt: "2026-10-30T00:30:00.000Z",
          museReminded: true,
          timingOk: true,
          contentOk: true,
          contentRef: "payload-missing",
          noteRef: null,
          pairedDecisionId: null,
          recordedAt: T0,
        }),
      ).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it("pairs Muse entries with one Gmail message and accepts a silent entry that names only the message", async () => {
    const { repository } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      const base = { ...scope, museAt: "2026-10-31T00:30:00.000Z", noteRef: null, recordedAt: T0 };
      await ledger.recordMuse({
        ...base,
        id: "by-mail",
        museReminded: true,
        timingOk: true,
        contentOk: true,
        contentRef: "payload-muse",
        pairedDecisionId: null,
        pairedMessageId: "gmail-message-1",
      });
      await ledger.recordMuse({
        ...base,
        id: "silent-by-mail",
        museReminded: false,
        pairedDecisionId: null,
        pairedMessageId: "gmail-message-2",
      });
      const entries = await ledger.listMuse({ ...scope, since: SINCE, limit: 10 });
      expect(entries.map((entry) => [entry.id, entry.pairedMessageId]).sort()).toEqual([
        ["by-mail", "gmail-message-1"],
        ["silent-by-mail", "gmail-message-2"],
      ]);
      await expect(
        ledger.recordMuse({
          ...base,
          id: "silent-nothing",
          museReminded: false,
          pairedDecisionId: null,
        }),
      ).rejects.toThrow();
      await expect(
        ledger.recordMuse({
          ...base,
          id: "bad-decision",
          museReminded: false,
          pairedDecisionId: "",
          pairedMessageId: "gmail-message-3",
        }),
      ).rejects.toThrow();
      await expect(
        ledger.recordMuse({
          ...base,
          id: "empty-mail",
          museReminded: false,
          pairedDecisionId: null,
          pairedMessageId: "",
        }),
      ).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it("records Muse silence, automatic intake entries and refuses wrong shapes", async () => {
    const { repository, list } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      await ledger.append(ledgerWrite("pushed-1", { kind: "consolidation", outcome: "merge" }));
      const base = {
        ...scope,
        museAt: "2026-10-31T00:30:00.000Z",
        noteRef: null,
        recordedAt: T0,
      };
      await ledger.recordMuse({
        ...base,
        id: "silent-1",
        museReminded: false,
        pairedDecisionId: "pushed-1",
      });
      await ledger.recordMuse({
        ...base,
        id: "auto-1",
        museReminded: true,
        timingOk: true,
        contentOk: true,
        contentRef: null,
        pairedDecisionId: null,
        intakeItemKey: "proactive:s1",
      });
      const entries = await ledger.listMuse({ ...scope, since: SINCE, limit: 10 });
      expect(entries.find((entry) => entry.id === "silent-1")).toEqual({
        id: "silent-1",
        museAt: base.museAt,
        museReminded: false,
        timingOk: null,
        contentOk: null,
        contentRef: null,
        noteRef: null,
        pairedDecisionId: "pushed-1",
        intakeItemKey: null,
        pairedMessageId: null,
        recordedAt: T0,
      });
      expect(entries.find((entry) => entry.id === "auto-1")?.contentRef).toBeNull();
      const refused = (write: unknown) =>
        expect(
          ledger.recordMuse(write as Parameters<typeof ledger.recordMuse>[0]),
        ).rejects.toThrow();
      await refused({ ...base, id: "x1", museReminded: false, pairedDecisionId: null });
      await refused({
        ...base,
        id: "x2",
        museReminded: false,
        pairedDecisionId: "pushed-1",
        timingOk: true,
      });
      await refused({
        ...base,
        id: "x3",
        museReminded: false,
        pairedDecisionId: "pushed-1",
        contentRef: "payload-muse",
      });
      await refused({
        ...base,
        id: "x4",
        museReminded: true,
        timingOk: true,
        contentOk: true,
        contentRef: null,
        pairedDecisionId: null,
      });
      await refused({
        ...base,
        id: "x5",
        museReminded: true,
        timingOk: true,
        contentOk: true,
        contentRef: null,
        pairedDecisionId: null,
        intakeItemKey: "proactive:s1",
      });
      await refused({
        ...base,
        id: "x6",
        museReminded: true,
        timingOk: true,
        contentOk: true,
        contentRef: "payload-muse",
        pairedDecisionId: null,
        intakeItemKey: "ab",
      });
      expect(await ledger.listMuse({ ...scope, since: SINCE, limit: 10 })).toHaveLength(2);
      expect(await list()).toHaveLength(1);
    } finally {
      await repository.close();
    }
  });

  it("stores candidate category, confidence and inferred flag only on memory candidates", async () => {
    const { repository, list } = await fixture();
    try {
      const ledger = repository.decisionLedger();
      await ledger.append(
        ledgerWrite("cand-1", {
          kind: "memory_candidate",
          outcome: "discarded",
          category: "preference",
          confidencePermille: 700,
          inferred: true,
        }),
      );
      await ledger.append(
        ledgerWrite("cand-2", { kind: "memory_candidate", outcome: "kept", inferred: false }),
      );
      await ledger.append(ledgerWrite("cons-1", { kind: "consolidation", outcome: "merge" }));
      const rows = await list();
      const byId = (id: string) => rows.find((row) => row.id === id);
      expect(byId("cand-1")).toMatchObject({
        category: "preference",
        confidencePermille: 700,
        inferred: true,
      });
      expect(byId("cand-2")).toMatchObject({
        category: null,
        confidencePermille: null,
        inferred: false,
      });
      expect(byId("cons-1")).toMatchObject({
        category: null,
        confidencePermille: null,
        inferred: null,
      });
      for (const [id, extra] of [
        ["bad-a", { kind: "consolidation", outcome: "merge", category: "other" }],
        ["bad-b", { kind: "consolidation", outcome: "merge", confidencePermille: 10 }],
        ["bad-c", { kind: "retrieval_degrade", outcome: "degraded", inferred: true }],
        ["bad-d", { kind: "memory_candidate", outcome: "kept", category: "hobby" }],
        ["bad-e", { kind: "memory_candidate", outcome: "kept", confidencePermille: 1001 }],
        ["bad-f", { kind: "memory_candidate", outcome: "kept", confidencePermille: 0.5 }],
      ] as const)
        await expect(
          ledger.append(ledgerWrite(id, extra as Parameters<typeof ledgerWrite>[1])),
        ).rejects.toThrow();
      expect(await list()).toHaveLength(3);
    } finally {
      await repository.close();
    }
  });

  it("writes the ledger row and the memory change in one transaction", async () => {
    const { repository, memory, list } = await fixture();
    try {
      const state = repository.productMemoryState();
      await memory.applyProposal(
        proposal("memory-1", "payload-1"),
        GENERATION_ID,
        ledgerWrite("kept-1"),
      );
      expect(await state.read(createMemoryId("memory-1"))).toMatchObject({ revision: 1 });
      expect(await list("memory_candidate")).toHaveLength(1);

      await expect(
        memory.applyProposal(
          proposal("memory-2", "payload-2"),
          GENERATION_ID,
          ledgerWrite("kept-2", { contentRef: "payload-missing" }),
        ),
      ).rejects.toThrow();
      expect(await state.read(createMemoryId("memory-2"))).toBeUndefined();

      await expect(
        memory.applyProposal(
          proposal("memory-3", "payload-2"),
          GENERATION_ID,
          ledgerWrite("kept-3", { outcome: "merge" }),
        ),
      ).rejects.toThrow();
      expect(await state.read(createMemoryId("memory-3"))).toBeUndefined();

      const current = await state.read(createMemoryId("memory-1"));
      if (!current) throw new Error("memory-1 missing");
      await expect(
        state.saveWithProjection({
          memory: { ...current, revision: 2, updatedAt: T0 },
          expectedRevision: 5,
          job: {
            id: "stale-job",
            memoryId: current.id,
            memoryRevision: 2,
            generationId: GENERATION_ID,
            operation: "upsert",
            status: "pending",
            attemptCount: 0,
            nextRetryAt: null,
            providerRecordId: current.providerRecordId,
            errorCode: null,
            claimedBy: null,
            claimExpiresAt: null,
          },
          ledger: ledgerWrite("kept-stale"),
        }),
      ).rejects.toThrow();
      expect((await list("memory_candidate")).map(({ id }) => id)).toEqual(["kept-1"]);
    } finally {
      await repository.close();
    }
  });

  it("writes a consolidation ledger row with each recorded change and none when the change is refused", async () => {
    const { repository, memory, list } = await fixture();
    try {
      await memory.applyProposal(proposal("memory-a", "payload-1"), GENERATION_ID);
      await memory.applyProposal(proposal("memory-b", "payload-2"), GENERATION_ID);
      const store = repository.memoryConsolidation();
      await store.begin({
        id: "consolidation-1",
        ...scope,
        day: "2026-10-31",
        triggerRunId: "run-1",
        status: "running",
        reviewedThrough: null,
        modelCalled: false,
        changeCount: 0,
        errorCode: null,
        startedAt: T0,
        finishedAt: null,
      });
      const change = {
        id: "consolidation-1:c1",
        consolidationId: "consolidation-1",
        ...scope,
        memoryId: createMemoryId("memory-a"),
        relatedMemoryId: createMemoryId("memory-b"),
        action: "merge",
        beforeRevision: 1,
        afterRevision: 2,
        beforeStatus: "active",
        beforeSupersededBy: null,
        beforeValidTo: null,
        createdAt: T0,
        undoneAt: null,
      } as const;
      await expect(
        store.recordChange({ ...change, consolidationId: "consolidation-missing" }),
      ).rejects.toThrow();
      expect(await list("consolidation")).toEqual([]);
      await store.recordChange(change);
      expect(await list("consolidation")).toMatchObject([
        {
          kind: "consolidation",
          outcome: "merge",
          subjectRef: "memory-a",
          inputs: { memoryIds: ["memory-a", "memory-b"], ruleIds: [] },
        },
      ]);
    } finally {
      await repository.close();
    }
  });

  it("writes a retrieval-degrade row when the query embedding fails and none when it works", async () => {
    const { repository, list } = await fixture();
    try {
      const failures: unknown[] = [];
      const embedders = { broken: true };
      const embedder: Embedder = {
        model: "fixture-embedding",
        dimensions: 4,
        async embed() {
          if (embedders.broken) throw new Error("embedding down");
          return new Float32Array([1, 0, 0, 0]);
        },
      };
      const provider = new HybridMemoryProvider({
        index: repository.memoryIndex(),
        embedder,
        embeddableClassifications: ["private"],
        now: () => T0,
        onVectorFailure: retrievalDegradeRecorder({
          ledger: repository.decisionLedger(),
          now: () => T0,
          onFailure: (error) => failures.push(error),
        }),
      });
      await provider.search({ ...scope, query: "restaurant dinner", limit: 3 });
      await expect.poll(async () => (await list("retrieval_degrade")).length).toBe(1);
      expect((await list("retrieval_degrade"))[0]).toMatchObject({
        outcome: "degraded",
        reasonCode: "vector_search_unavailable",
        inputs: { memoryIds: [], ruleIds: [] },
      });
      embedders.broken = false;
      await provider.search({ ...scope, query: "restaurant dinner", limit: 3 });
      expect(await list("retrieval_degrade")).toHaveLength(1);
      expect(failures).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("keeps non-Gmail decisions when the owner clears the proactive records", async () => {
    const { repository, list } = await fixture();
    try {
      const proactive = repository.proactive();
      await repository.decisionLedger().append(ledgerWrite("keep-me"));
      await proactive.record({
        ...scope,
        decision: {
          id: "gmail-check",
          scenario: "gmail",
          checkedAt: T0,
          counts: {
            fetched: 0,
            skipped: 0,
            judged: 0,
            act: 0,
            know: 0,
            check: 0,
            ignore: 0,
            floorRaised: 0,
            pushed: 0,
          },
          verdict: "silent",
          reasonCode: "nothing_new",
          pushSourceKey: null,
          costMicros: 0,
          durationMs: 1,
          ownerRating: null,
          ratedAt: null,
        },
        inputs: {
          ruleIds: [],
          sourceIds: [],
          floorHits: {},
          memoryInjected: false,
          memoryIds: [],
          usedMemoryIds: [],
          memoryByMail: {},
          memoryRecall: "off",
        },
        modelPayloads: [],
        processed: [],
        insights: [],
        repliedThreads: [],
        push: null,
        cursor: null,
      });
      expect((await list()).map(({ id }) => id).sort()).toEqual(["gmail-check", "keep-me"]);
      expect(
        (await proactive.listDecisions({ ...scope, since: SINCE, limit: 10 })).map(({ id }) => id),
      ).toEqual(["gmail-check"]);
      await proactive.clearRecords(scope);
      expect((await list()).map(({ id }) => id)).toEqual(["keep-me"]);
    } finally {
      await repository.close();
    }
  });
});
