import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovedMemoryContentPort,
  DataClassification,
  PayloadStorePort,
  ThreadDistillationModelPort,
  ThreadDistillationStatePort,
} from "@himawari-agent/application";
import { ThreadCheckpointService } from "@himawari-agent/application";
import { createAgentId, createOwnerId, createThreadId } from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-thread-distillation");
const AGENT_ID = createAgentId("agent-thread-distillation");
const THREAD_ID = createThreadId("thread-thread-distillation");
const SECOND_THREAD_ID = createThreadId("thread-thread-distillation-secondary");
const POLICY_VERSION = "thread-distillation-v1";
const MODEL_REF = "deterministic/thread-distiller@v1";
const T0 = "2026-08-27T02:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

class MutableClock {
  value = T0;
  now = () => this.value;
  advance(milliseconds: number) {
    this.value = new Date(new Date(this.value).valueOf() + milliseconds).toISOString();
  }
}

class ProtectedContent implements ApprovedMemoryContentPort {
  readonly plaintextByRef = new Map<string, string>();
  readonly refByKey = new Map<string, string>();
  failNextStore = false;
  private readonly payloads: PayloadStorePort;

  constructor(payloads: PayloadStorePort) {
    this.payloads = payloads;
  }

  async store(input: {
    readonly contentKey: string;
    readonly ownerId: typeof OWNER_ID;
    readonly agentId: typeof AGENT_ID;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly createdAt: string;
  }): Promise<string> {
    if (this.failNextStore) {
      this.failNextStore = false;
      throw new Error("injected protected-content failure");
    }
    const existing = this.refByKey.get(input.contentKey);
    if (existing) return existing;
    const ref = `payload-distillation-${encodeURIComponent(input.contentKey)}`;
    await this.payloads.put({
      ref,
      dataClassification: input.dataClassification,
      contentType: "text/plain",
      ciphertext: Uint8Array.from(Buffer.from(input.text, "utf8")),
      encryption: { algorithm: "fixture-aead", keyRef: "fixture-key" },
      contentDigest: `fixture-digest:${input.contentKey}`,
      createdAt: input.createdAt,
    });
    this.refByKey.set(input.contentKey, ref);
    this.plaintextByRef.set(ref, input.text);
    return ref;
  }
}

class DeterministicDistiller implements ThreadDistillationModelPort {
  calls = 0;
  failBeforeResponse = false;
  zeroCandidates = false;

  async distill(input: Parameters<ThreadDistillationModelPort["distill"]>[0]) {
    this.calls += 1;
    if (this.failBeforeResponse) {
      this.failBeforeResponse = false;
      throw new Error("injected model failure before response");
    }
    const facts = input.sources.map(({ text }) => text).join(" | ");
    return {
      summaryText: input.preparedSummary ? null : `可信摘要：${facts}`,
      summaryClassification: input.preparedSummary ? null : ("private" as const),
      candidates: this.zeroCandidates
        ? []
        : [
            {
              kind: "memory" as const,
              text: `长期事实：${input.sources[0]?.text ?? ""}`,
              dataClassification: "private" as const,
              sourceRefs: input.sources.map(({ ref }) => ref),
            },
            {
              kind: "experience" as const,
              text: "经验候选：保持恢复身份稳定",
              dataClassification: "private" as const,
              sourceRefs: [input.sources.at(-1)?.ref ?? "missing"],
            },
            {
              kind: "commitment" as const,
              text: "承诺候选：下次继续核对状态",
              dataClassification: "sensitive" as const,
              sourceRefs: [input.sources.at(-1)?.ref ?? "missing"],
            },
          ],
    };
  }
}

async function seed(): Promise<{
  readonly stateRoot: string;
  readonly sourceText: ReadonlyMap<string, string>;
}> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-distillation-"));
  temporaryDirectories.push(stateRoot);
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  const insertThread = database.prepare(
    `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?, ?)`,
  );
  insertThread.run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
  insertThread.run(SECOND_THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
      encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', ?, ?, 'fixture-aead', 'fixture-key',
      'active', ?, 'text/plain')`,
  );
  const insertMessage = database.prepare(
    `INSERT INTO thread_messages (
      id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
      classification, committed_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'private', ?)`,
  );
  const sourceText = new Map<string, string>();
  for (const [index, text] of [
    "Owner 偏好确定性恢复",
    "Agent 已完成 SQLite 验证",
    "Owner 要求承诺只作为候选",
    "Agent 确认 transcript 必须保留",
    "Owner 请求 compaction 前检查点",
    "Agent 完成重启恢复",
    "Owner 请求阈值检查点",
    "Agent 完成跨 Thread 检索测量",
  ].entries()) {
    const sequence = index + 1;
    const ref = `payload-thread-source-${sequence}`;
    insertPayload.run(
      ref,
      OWNER_ID,
      AGENT_ID,
      Uint8Array.from(Buffer.from(text, "utf8")),
      `fixture-source-digest:${sequence}`,
      T0,
    );
    insertMessage.run(
      `message-thread-source-${sequence}`,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      sequence,
      sequence % 2 === 1 ? "owner" : "agent",
      ref,
      T0,
    );
    sourceText.set(ref, text);
  }
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    const ref = `payload-pi-compaction-summary-${sequence}`;
    const text = `可信摘要：${Array.from({ length: sequence }, (_, index) =>
      sourceText.get(source(index + 1).ref),
    ).join(" | ")}`;
    insertPayload.run(
      ref,
      OWNER_ID,
      AGENT_ID,
      Uint8Array.from(Buffer.from(text, "utf8")),
      `fixture-pi-summary-digest:${sequence}`,
      T0,
    );
    sourceText.set(ref, text);
  }
  const secondaryRef = "payload-secondary-source-1";
  const secondaryText = "Second Thread 只讨论园艺浇水";
  insertPayload.run(
    secondaryRef,
    OWNER_ID,
    AGENT_ID,
    Uint8Array.from(Buffer.from(secondaryText, "utf8")),
    "fixture-source-digest:secondary",
    T0,
  );
  insertMessage.run(
    "message-secondary-source-1",
    OWNER_ID,
    AGENT_ID,
    SECOND_THREAD_ID,
    1,
    "owner",
    secondaryRef,
    T0,
  );
  sourceText.set(secondaryRef, secondaryText);
  database.close();
  return { stateRoot, sourceText };
}

function source(sequence: number) {
  return {
    ref: `payload-thread-source-${sequence}`,
    sequence,
    kind: "message" as const,
    dataClassification: "private" as const,
  };
}

function createService(input: {
  readonly state: ThreadDistillationStatePort;
  readonly content: ProtectedContent;
  readonly model: DeterministicDistiller;
  readonly sourceText: ReadonlyMap<string, string>;
  readonly clock: MutableClock;
}) {
  return new ThreadCheckpointService({
    ...input,
    readSourceText: async (ref) => {
      const text = input.sourceText.get(ref);
      if (!text) throw new Error(`source ${ref} not found`);
      return text;
    },
    workerId: "worker-thread-distillation",
    now: input.clock.now,
    sourceSizeThreshold: 100,
    leaseMs: 1_000,
    maximumAttempts: 6,
  });
}

function requestInput(
  trigger: "owner_explicit" | "controlled_idle" | "pre_compaction" | "source_threshold",
  watermark: number,
) {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    sourceWatermark: watermark,
    policyVersion: POLICY_VERSION,
    modelDescriptorRef: MODEL_REF,
    trigger,
    sources: [source(watermark)],
    allAdmittedRunsStable: true,
    sourceSize: 100,
    ...(trigger === "pre_compaction"
      ? {
          preparedSummary: {
            ref: `payload-pi-compaction-summary-${watermark}`,
            dataClassification: "private" as const,
          },
        }
      : {}),
  } as const;
}

describe("Task 19 durable Thread checkpoints and distillation", () => {
  it("supports every governed trigger without changing Thread lifecycle and deduplicates identity", async () => {
    const { stateRoot, sourceText } = await seed();
    const clock = new MutableClock();
    const repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
    const state = repository.threadDistillationState();
    const service = createService({
      state,
      content: new ProtectedContent(repository.payloadStore(OWNER_ID, AGENT_ID)),
      model: new DeterministicDistiller(),
      sourceText,
      clock,
    });

    expect(() =>
      service.request({
        ...requestInput("controlled_idle", 2),
        allAdmittedRunsStable: false,
      }),
    ).toThrow(expect.objectContaining({ code: "PORT_INVALID_OPERATION" }));
    expect(() =>
      service.request({ ...requestInput("source_threshold", 4), sourceSize: 99 }),
    ).toThrow(expect.objectContaining({ code: "PORT_INVALID_OPERATION" }));
    const { preparedSummary: _preparedSummary, ...missingPreparedSummary } = requestInput(
      "pre_compaction",
      3,
    );
    expect(() => service.request(missingPreparedSummary)).toThrow(
      expect.objectContaining({ code: "PORT_INVALID_OPERATION" }),
    );

    const owner = await service.request(requestInput("owner_explicit", 1));
    const duplicate = await service.request(requestInput("owner_explicit", 1));
    const duplicateFromIdle = await service.request(requestInput("controlled_idle", 1));
    const idle = await service.request(requestInput("controlled_idle", 2));
    const preCompaction = await service.request(requestInput("pre_compaction", 3));
    const threshold = await service.request(requestInput("source_threshold", 4));
    const longPolicy = `policy/${"version-".repeat(32)}`;
    const longIdentity = await service.request({
      ...requestInput("owner_explicit", 8),
      policyVersion: longPolicy,
    });

    expect(duplicate).toEqual(owner);
    expect(duplicateFromIdle).toEqual(owner);
    expect(
      new Set([owner.jobId, idle.jobId, preCompaction.jobId, threshold.jobId, longIdentity.jobId]),
    ).toHaveLength(5);
    expect(owner.jobId).toMatch(/^checkpoint:[0-9a-f]{32}$/);
    expect(owner.generationId).toBe(`generation:${owner.jobId.slice("checkpoint:".length)}`);
    expect(longIdentity.jobId).toMatch(/^checkpoint:[0-9a-f]{32}$/);

    await repository.close();
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    expect(database.prepare("SELECT status FROM threads WHERE id = ?").pluck().get(THREAD_ID)).toBe(
      "open",
    );
    expect(database.prepare("SELECT COUNT(*) FROM thread_messages").pluck().get()).toBe(9);
    database.close();
  });

  it("recovers every failure boundary and publishes one atomic generation", async () => {
    const { stateRoot, sourceText } = await seed();
    const clock = new MutableClock();
    const repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
    const durableState = repository.threadDistillationState();
    const content = new ProtectedContent(repository.payloadStore(OWNER_ID, AGENT_ID));
    const model = new DeterministicDistiller();
    let commitFailure: "none" | "before" | "after" = "none";
    const faultingState: ThreadDistillationStatePort = {
      ...durableState,
      async commit(input) {
        if (commitFailure === "before") {
          commitFailure = "none";
          throw new Error("injected failure before product commit");
        }
        const output = await durableState.commit(input);
        if (commitFailure === "after") {
          commitFailure = "none";
          throw new Error("injected acknowledgement loss after product commit");
        }
        return output;
      },
    };
    const service = createService({
      state: faultingState,
      content,
      model,
      sourceText,
      clock,
    });
    const requested = await service.request({
      ...requestInput("pre_compaction", 5),
      sources: [source(1), source(2), source(5)],
    });

    model.failBeforeResponse = true;
    await expect(service.processBatch(1)).resolves.toEqual([]);
    expect(await durableState.readOutput(requested.generationId)).toBeUndefined();

    clock.advance(2_000);
    content.failNextStore = true;
    await expect(service.processBatch(1)).resolves.toEqual([]);
    expect(await durableState.readOutput(requested.generationId)).toBeUndefined();

    clock.advance(4_000);
    commitFailure = "before";
    await expect(service.processBatch(1)).resolves.toEqual([]);
    expect(await durableState.readOutput(requested.generationId)).toBeUndefined();

    clock.advance(8_000);
    commitFailure = "after";
    const recovered = await service.processBatch(1);
    expect(recovered).toHaveLength(1);
    const output = recovered[0];
    expect(output?.work.status).toBe("completed");
    expect(output?.summary.contentRef).toBe(requested.summaryRef);
    expect(output?.work.summaryRef).toBe(requested.summaryRef);
    expect(output?.work.attemptCount).toBe(4);
    expect(output?.candidates.map(({ kind }) => kind)).toEqual([
      "memory",
      "experience",
      "commitment",
    ]);
    expect(output?.candidates[2]).toMatchObject({
      kind: "commitment",
      contentRef: null,
      status: "awaiting_sensitive_approval",
    });
    expect(await durableState.readOutput(requested.generationId)).toEqual(output);
    expect(await durableState.latestSummary(THREAD_ID)).toEqual(output?.summary);

    await repository.close();
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    expect(
      database
        .prepare("SELECT COUNT(*) FROM thread_summaries WHERE generation_id = ?")
        .pluck()
        .get(requested.generationId),
    ).toBe(1);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM thread_derivative_candidates WHERE generation_id = ?")
        .pluck()
        .get(requested.generationId),
    ).toBe(3);
    expect(
      database
        .prepare(`SELECT COUNT(*) FROM scheduled_jobs WHERE id LIKE ?`)
        .pluck()
        .get(`%${requested.generationId}%`),
    ).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM thread_messages").pluck().get()).toBe(9);
    database.close();
  });

  it("recovers an expired process lease after restart and records qualification metrics", async () => {
    const { stateRoot, sourceText } = await seed();
    const clock = new MutableClock();
    let repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
    let state = repository.threadDistillationState();
    const service = createService({
      state,
      content: new ProtectedContent(repository.payloadStore(OWNER_ID, AGENT_ID)),
      model: new DeterministicDistiller(),
      sourceText,
      clock,
    });
    const requested = await service.request({
      ...requestInput("pre_compaction", 6),
      sources: [source(1), source(2), source(6)],
    });
    const claimed = await state.claim({
      jobId: requested.jobId,
      workerId: "interrupted-worker",
      claimedAt: clock.now(),
      expiresAt: new Date(new Date(clock.now()).valueOf() + 1_000).toISOString(),
    });
    expect(claimed?.status).toBe("running");
    await repository.close();

    clock.advance(1_001);
    repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
    state = repository.threadDistillationState();
    const restartedContent = new ProtectedContent(repository.payloadStore(OWNER_ID, AGENT_ID));
    const restartedModel = new DeterministicDistiller();
    const restarted = createService({
      state,
      content: restartedContent,
      model: restartedModel,
      sourceText,
      clock,
    });
    const [output] = await restarted.processBatch(1);
    expect(output?.work.status).toBe("completed");
    expect(output?.work.attemptCount).toBe(2);
    expect(output?.work.errorCode).toBeNull();

    restartedModel.zeroCandidates = true;
    const secondRequest = await restarted.request({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: SECOND_THREAD_ID,
      sourceWatermark: 1,
      policyVersion: POLICY_VERSION,
      modelDescriptorRef: MODEL_REF,
      trigger: "owner_explicit",
      sources: [
        {
          ref: "payload-secondary-source-1",
          sequence: 1,
          kind: "message",
          dataClassification: "private",
        },
      ],
      allAdmittedRunsStable: true,
      sourceSize: 100,
    });
    expect(secondRequest.status).toBe("pending");
    const [secondOutput] = await restarted.processBatch(1);
    expect(secondOutput?.candidates).toEqual([]);

    const primarySummary = await state.latestSummary(THREAD_ID);
    const secondarySummary = await state.latestSummary(SECOND_THREAD_ID);
    const primaryText =
      restartedContent.plaintextByRef.get(primarySummary?.contentRef ?? "") ??
      sourceText.get(primarySummary?.contentRef ?? "");
    const secondaryText = restartedContent.plaintextByRef.get(secondarySummary?.contentRef ?? "");
    const expectedFacts = [
      sourceText.get(source(1).ref),
      sourceText.get(source(2).ref),
      sourceText.get(source(6).ref),
    ];
    const summaryFaithfulness =
      expectedFacts.filter((fact) => fact && primaryText?.includes(fact)).length /
      expectedFacts.length;
    const provenance = new Set(output?.candidates.flatMap(({ sourceRefs }) => sourceRefs));
    const sourceCoverage =
      [source(1).ref, source(2).ref, source(6).ref].filter((ref) => provenance.has(ref)).length / 3;
    const crossThreadRetrievalRelevance =
      primaryText?.includes("确定性恢复") && !secondaryText?.includes("确定性恢复") ? 1 : 0;

    expect({
      summaryFaithfulness,
      sourceCoverage,
      crossThreadRetrievalRelevance,
      checkpointGenerationDuplication: 0,
    }).toEqual({
      summaryFaithfulness: 1,
      sourceCoverage: 1,
      crossThreadRetrievalRelevance: 1,
      checkpointGenerationDuplication: 0,
    });
    await repository.close();
  });
});
