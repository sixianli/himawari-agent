import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryExtractionAuditRecord,
  modelVisibleCeiling,
  modelVisibleClassifications,
  OwnerProfileService,
  type RunExecutionSourcePort,
  type RuntimeRequest,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMessageId,
  createOwnerId,
  createRunId,
  createThreadId,
  type MemoryId,
} from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import {
  type MemoryCaptureCall,
  ProductionMemoryCapture,
} from "../../../apps/agent-service/src/production-memory-capture.ts";
import type { BenchmarkStore } from "./datasets.ts";

export const PRODUCTION_RELATED_MEMORY_LIMIT = 20;
export const BENCHMARK_TIME_ZONE = "UTC";

type ThreadMessage = Awaited<ReturnType<ThreadRepositoryPort["listMessages"]>>[number];

export type CaptureModel = (prompt: string, call: MemoryCaptureCall) => Promise<string>;

export interface RelatedMemory {
  readonly id: string;
  readonly text: string;
  readonly recordedAt: string;
  readonly sessionIds: readonly string[];
}

export interface StoreStatistics {
  readonly turns: number;
  readonly ownerTurns: number;
  readonly captureFailures: number;
  readonly audits: Readonly<Record<string, number>>;
  readonly activeMemories: number;
  readonly ingestMs: number;
  readonly phaseMs: Readonly<Record<"search" | "capture" | "model" | "projection", number>>;
}

export interface IngestedStore {
  readonly store: BenchmarkStore;
  readonly statistics: StoreStatistics;
  readonly failures: readonly string[];
  profileText(now: string): Promise<string>;
  related(query: string, now: string): Promise<readonly RelatedMemory[]>;
  storedSessionIds(): Promise<ReadonlySet<string>>;
  close(): Promise<void>;
}

const captureTag = (kind: string, value: string) =>
  [...createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 8)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 160);
}

export async function ingestStore(input: {
  readonly store: BenchmarkStore;
  readonly embedder: Embedder;
  readonly minimumSimilarity: number;
  readonly generate: CaptureModel;
  readonly stopIf?: () => Error | undefined;
  readonly onTurn?: (done: number, total: number) => void;
}): Promise<IngestedStore> {
  const { store } = input;
  const started = performance.now();
  const ownerId = createOwnerId("owner-benchmark");
  const agentId = createAgentId("agent-benchmark");
  const threadId = createThreadId("thread-benchmark");
  const first = store.turns[0]?.at ?? new Date(0).toISOString();
  const clock = { value: first };
  const now = () => clock.value;
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-benchmark-"));
  const databasePath = path.join(stateRoot, "product.sqlite");
  const setup = openQualifiedDatabase(databasePath);
  applyMigrations(setup, await loadBundledMigrations());
  setup.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  setup
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  setup
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?, ?)`,
    )
    .run(threadId, ownerId, agentId, first, first);
  setup.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now,
  });
  const rows = openQualifiedDatabase(databasePath);
  const insertMessage = rows.prepare(
    `INSERT INTO thread_messages (
      id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
      classification, committed_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'private', ?)`,
  );
  const insertTrigger = rows.prepare(
    `INSERT INTO triggers (
      id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
      payload_ref, source_proof_ref, occurred_at
    ) VALUES (?, ?, ?, ?, ?, 'user_message', ?, ?, 'proof', ?)`,
  );
  const insertRun = rows.prepare(
    `INSERT INTO runs (
      id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'session', ?, 1, 'completed', ?, ?)`,
  );
  const protector = createReferenceAdapterSet().payloadProtector;
  const payloads = repository.payloadStore(ownerId, agentId);
  const textCache = new Map<string, string>();
  const readRef = async (ref: string): Promise<string | undefined> => {
    const cached = textCache.get(ref);
    if (cached !== undefined) return cached;
    const payload = await payloads.get(ref as never);
    if (!payload) return undefined;
    const text = new TextDecoder().decode(await protector.unprotect({ payload }));
    textCache.set(ref, text);
    return text;
  };
  const provider = new HybridMemoryProvider({
    index: repository.memoryIndex(),
    embedder: input.embedder,
    embeddableClassifications: ["public", "private", "sensitive"],
    minimumSimilarity: input.minimumSimilarity,
    now,
    timeZone: BENCHMARK_TIME_ZONE,
  });
  const memory = new DurableMemoryService({
    state: repository.productMemoryState(),
    jobs: repository.memoryProjectionJobs(),
    provider,
    content: {
      readText: async (ref) => {
        const text = await readRef(ref);
        if (text === undefined) throw new Error("BENCH_PAYLOAD_MISSING");
        return text;
      },
    },
    workerId: "memory-benchmark",
    now,
  });
  const messages: ThreadMessage[] = [];
  const sessionOfRef = new Map<string, string>();
  const relevant = new Map<string, readonly MemoryId[]>();
  const runSources: RunExecutionSourcePort = {
    read: async (runId) => {
      const owner = messages.find((item) => item.role === "owner" && item.runId === runId);
      if (!owner) return undefined;
      return {
        ownerId,
        agentId,
        runId,
        sessionId: "session" as never,
        threadId,
        triggerId: `trigger-${runId}` as never,
        sourceType: "user_message",
        sourceId: owner.id,
        payloadRef: owner.contentRef,
        dataClassification: "private",
        occurredAt: owner.committedAt ?? now(),
      };
    },
  };
  const threads = {
    listMessages: async (
      _owner: unknown,
      _agent: unknown,
      _thread: unknown,
      after: number,
      limit: number,
    ) => messages.filter(({ sequence }) => sequence > after).slice(0, limit),
    readCommittedMessagesByIds: async ({
      messageIds,
    }: {
      readonly messageIds: readonly string[];
    }) => messages.filter(({ id }) => messageIds.includes(id)),
  };
  const audits: Record<string, number> = {};
  const failures: string[] = [];
  const allowed = modelVisibleClassifications();
  const search = (query: string) =>
    memory.search({
      ownerId,
      agentId,
      queryRef: "benchmark-query",
      queryText: query,
      policy: { limit: PRODUCTION_RELATED_MEMORY_LIMIT, allowedClassifications: [...allowed] },
    });
  const project = async () => {
    for (let round = 0; round < 20; round += 1)
      if ((await memory.runProjectionBatch(50)).length === 0) return;
  };
  let ownerTurns = 0;
  const phaseMs = { search: 0, capture: 0, model: 0, projection: 0 };
  const timed = async <T>(phase: keyof typeof phaseMs, work: () => Promise<T>): Promise<T> => {
    const begun = performance.now();
    try {
      return await work();
    } finally {
      phaseMs[phase] += performance.now() - begun;
    }
  };
  for (const [index, turn] of store.turns.entries()) {
    const stop = input.stopIf?.();
    if (stop) {
      rows.close();
      await repository.close();
      await rm(stateRoot, { recursive: true, force: true });
      throw stop;
    }
    clock.value = turn.at;
    const sequence = index + 1;
    const role = turn.speaker === "owner" ? "owner" : "agent";
    const contentRef = `payload-${sequence}`;
    const runId = role === "owner" ? createRunId(`run-${sequence}`) : null;
    await payloads.put(
      await protector.protect({
        ownerId,
        agentId,
        ref: contentRef as never,
        dataClassification: "private",
        contentType: "text/plain",
        plaintext: new TextEncoder().encode(turn.text),
        createdAt: turn.at,
      }),
    );
    textCache.set(contentRef, turn.text);
    sessionOfRef.set(contentRef, turn.sessionId);
    insertMessage.run(
      `message-${sequence}`,
      ownerId,
      agentId,
      threadId,
      sequence,
      role,
      contentRef,
      turn.at,
    );
    messages.push({
      id: createMessageId(`message-${sequence}`),
      ownerId,
      agentId,
      threadId,
      turnId: null,
      runId,
      sequence,
      role,
      contentRef,
      dataClassification: "private",
      status: "committed",
      committedAt: turn.at,
    } as ThreadMessage);
    if (runId === null) continue;
    ownerTurns += 1;
    insertTrigger.run(
      `trigger-${runId}`,
      ownerId,
      agentId,
      threadId,
      `idempotency-${runId}`,
      `message-${sequence}`,
      contentRef,
      turn.at,
    );
    insertRun.run(runId, ownerId, agentId, threadId, `trigger-${runId}`, turn.at, turn.at);
    relevant.set(
      runId,
      (await timed("search", () => search(turn.text))).map(({ memory: found }) => found.id),
    );
    const capture = new ProductionMemoryCapture({
      sources: runSources,
      threads,
      generations: repository.threadDistillationState(),
      state: repository.productMemoryState(),
      relevantMemoryIds: (id) => relevant.get(id) ?? [],
      product: memory,
      approvals: repository.sensitiveMemoryApprovals(),
      reminders: repository.memoryReminders(),
      book: repository.memoryBook(),
      ledger: repository.decisionLedger(),
      unitOfWork: repository.unitOfWork(),
      timeZone: BENCHMARK_TIME_ZONE,
      payloads,
      protector,
      clock: { now },
      assertActive: async () => {},
      externalTag: async () => captureTag,
      generate: async (_request, prompt, onAdmitted, call) => {
        onAdmitted();
        return timed("model", () => input.generate(prompt, call));
      },
      onAudit: (record: MemoryExtractionAuditRecord) => {
        audits[record.outcome] = (audits[record.outcome] ?? 0) + 1;
      },
      onFailure: (error) => failures.push(stableErrorCode(error)),
    });
    const captureStarted = performance.now();
    await capture.start({
      ownerId,
      agentId,
      runId,
      threadId,
      modelRef: "benchmark-capture",
      dataClassification: "private",
    } as unknown as RuntimeRequest);
    await capture.stop();
    phaseMs.capture += performance.now() - captureStarted;
    relevant.delete(runId);
    await timed("projection", project);
    input.onTurn?.(index + 1, store.turns.length);
  }
  rows.close();
  const profileTexts = new Map<string, string>();
  const profile = new OwnerProfileService({
    state: repository.productMemoryState(),
    pins: repository.memoryBook(),
    reminders: repository.memoryReminders(),
    readText: (record) => readRef(record.contentRef),
    storeText: async ({ ref, text }) => {
      profileTexts.set(ref, text);
    },
    digest: (text) => createHash("sha256").update(text).digest("hex"),
    timeZone: BENCHMARK_TIME_ZONE,
    ownerName: async () => store.ownerName,
  });
  const active = await repository.productMemoryState().listActive(ownerId, agentId);
  const sessionsOf = (sourceRefs: readonly string[]) => [
    ...new Set(sourceRefs.flatMap((ref) => sessionOfRef.get(ref) ?? [])),
  ];
  return {
    store,
    failures,
    statistics: {
      turns: store.turns.length,
      ownerTurns,
      captureFailures: failures.length,
      audits,
      activeMemories: active.length,
      ingestMs: Math.round(performance.now() - started),
      phaseMs: Object.fromEntries(
        Object.entries(phaseMs).map(([phase, ms]) => [phase, Math.round(ms)]),
      ) as StoreStatistics["phaseMs"],
    },
    profileText: async (at) => {
      clock.value = at;
      profileTexts.clear();
      const composed = await profile.compose({
        ownerId,
        agentId,
        maxClassification: modelVisibleCeiling(),
        now: at,
      });
      return composed.blocks
        .map(({ payloadRef }) => profileTexts.get(payloadRef) ?? "")
        .filter((text) => text.length > 0)
        .join("\n\n");
    },
    related: async (query, at) => {
      clock.value = at;
      const found = await search(query);
      return Promise.all(
        found.map(async ({ memory: record }) => ({
          id: record.id,
          text: (await readRef(record.contentRef)) ?? "",
          recordedAt: record.updatedAt,
          sessionIds: sessionsOf(record.sourceRefs),
        })),
      );
    },
    storedSessionIds: async () =>
      new Set(
        (await repository.productMemoryState().listActive(ownerId, agentId)).flatMap((record) =>
          sessionsOf(record.sourceRefs),
        ),
      ),
    close: async () => {
      await repository.close();
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
}
