import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryExtractionAuditRecord,
  type MemoryProviderProjectionPort,
  type ProductMemoryRecord,
  type RuntimeRequest,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMessageId,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionMemoryCapture } from "../../apps/agent-service/src/production-memory-capture.ts";
import { ProductionMemoryControl } from "../../apps/agent-service/src/production-memory-control.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-capture");
const AGENT_ID = createAgentId("agent-memory-capture");
const THREAD_ID = createThreadId("thread-memory-capture");
const T0 = "2026-10-25T12:00:00.000Z";

class RecordingProvider implements MemoryProviderProjectionPort {
  readonly upserts: { memory: ProductMemoryRecord; content: string }[] = [];
  async upsert(input: { readonly memory: ProductMemoryRecord; readonly content: string }) {
    this.upserts.push(input);
    return `provider-${input.memory.id}`;
  }
  async delete() {}
  async search() {
    return [];
  }
  async clearScope() {}
}

describe("production memory capture", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(message: string, output: string | Error) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-capture-"));
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
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const messages: Awaited<ReturnType<ThreadRepositoryPort["listMessages"]>>[number][] = [];
    const turn = async (role: "owner" | "agent", text: string, runId: string | null) => {
      const sequence = messages.length + 1;
      const contentRef = `payload-${role}-${sequence}`;
      await payloads.put(
        await adapters.payloadProtector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref: contentRef,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: T0,
        }),
      );
      messages.push({
        id: createMessageId(`message-${sequence}`),
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: THREAD_ID,
        turnId: null,
        runId: runId === null ? null : createRunId(runId),
        sequence,
        role,
        contentRef,
        dataClassification: "private",
        status: "committed",
        committedAt: T0,
      });
      if (role === "owner" && runId !== null) {
        const seed = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
        seed
          .prepare(
            `INSERT INTO triggers (
            id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
            payload_ref, source_proof_ref, occurred_at
          ) VALUES (?, ?, ?, ?, ?, 'user_message', ?, ?, 'proof', ?)`,
          )
          .run(
            `trigger-${runId}`,
            OWNER_ID,
            AGENT_ID,
            THREAD_ID,
            `idempotency-${runId}`,
            `message-${sequence}`,
            contentRef,
            T0,
          );
        seed
          .prepare(
            `INSERT INTO runs (
            id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'session', ?, 1, 'completed', ?, ?)`,
          )
          .run(runId, OWNER_ID, AGENT_ID, THREAD_ID, `trigger-${runId}`, T0, T0);
        seed.close();
      }
      return contentRef;
    };
    const provider = new RecordingProvider();
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content: {
        readText: async (ref) => {
          const payload = await payloads.get(ref);
          if (!payload) throw new Error("missing");
          return new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }));
        },
      },
      workerId: "memory-capture-test",
      now: () => T0,
    });
    const audits: MemoryExtractionAuditRecord[] = [];
    const failures: unknown[] = [];
    const prompts: string[] = [];
    const outputs: (string | Error)[] = [output];
    const relevant: string[] = [];
    const capture = new ProductionMemoryCapture({
      sources: {
        read: async (runId) => {
          const owner = messages.find((item) => item.role === "owner" && item.runId === runId);
          if (!owner) return undefined;
          return {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            runId,
            sessionId: "session" as never,
            threadId: THREAD_ID,
            triggerId: "trigger" as never,
            sourceType: "user_message",
            sourceId: owner.id,
            payloadRef: owner.contentRef,
            dataClassification: "private",
            occurredAt: T0,
          };
        },
      },
      threads: {
        read: async () => ({ messageWatermark: messages.length }) as never,
        listMessages: async () => messages,
      },
      generations: repository.threadDistillationState(),
      state: repository.productMemoryState(),
      relevantMemoryIds: () => relevant as never,
      product: memory,
      approvals: repository.sensitiveMemoryApprovals(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => T0 },
      assertActive: async () => {},
      generate: async (_request, prompt, onAdmitted) => {
        prompts.push(prompt);
        onAdmitted();
        const next = outputs.shift() ?? '{"memories":[]}';
        if (next instanceof Error) throw next;
        return next;
      },
      onAudit: (record) => audits.push(record),
      onFailure: (error) => failures.push(error),
    });
    const requestFor = (runId: string) =>
      ({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: createRunId(runId),
        threadId: THREAD_ID,
        modelRef: "primary",
        dataClassification: "private",
      }) as unknown as RuntimeRequest;
    await turn("owner", message, "run-memory-capture");
    const control = new ProductionMemoryControl({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      approvals: repository.sensitiveMemoryApprovals(),
      memory,
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => T0 },
      onAudit: (record) => audits.push(record),
    });
    const protect = async (
      ref: string,
      text: string,
      dataClassification: "private" | "sensitive" = "private",
    ) =>
      payloads.put(
        await adapters.payloadProtector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification,
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: T0,
        }),
      );
    return {
      repository,
      memory,
      provider,
      capture,
      control,
      protect,
      request: requestFor("run-memory-capture"),
      requestFor,
      turn,
      outputs,
      relevant,
      audits,
      failures,
      prompts,
    };
  }

  const envelope = {
    schemaVersion: "gateway.v2",
    messageId: "message",
    correlationId: "correlation",
    causationId: null,
    dataClassification: "private",
    risk: "medium",
    authorizationRef: null,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: OWNER_ID },
    idempotencyKey: "idempotency",
  } as const;
  const overview = async (control: ProductionMemoryControl) => {
    const snapshot = await control.query({
      ...envelope,
      kind: "query",
      type: "memory.overview.read",
      payload: {},
    } as never);
    if (snapshot.type !== "memory.overview.snapshot") throw new Error("snapshot");
    return snapshot.payload;
  };
  const respond = (
    control: ProductionMemoryControl,
    requestId: string,
    resolution: "approved" | "edited" | "rejected",
    editedText: string | null = null,
  ) =>
    control.execute({
      ...envelope,
      kind: "command",
      type: "memory.approval.respond",
      payload: { requestId, resolution, editedText },
    } as never);
  const mutate = (
    control: ProductionMemoryControl,
    memoryId: string,
    expectedRevision: number,
    action: "correct" | "delete",
    contentRef: string | null,
  ) =>
    control.execute({
      ...envelope,
      kind: "command",
      type: "memory.mutate",
      payload: { memoryId, action, expectedRevision, contentRef },
    } as never);

  it("queues a sensitive Memory with its topic and commits it once the Owner approves", async () => {
    const context = await setup(
      "我对青霉素过敏，最近在吃降压药。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人对青霉素过敏","classification":"sensitive","topic":"health","confidence":950,"quote":"我对青霉素过敏，最近在吃降压药"},{"kind":"durable_fact","decision":"create","text":"主人在吃降压药","classification":"sensitive","topic":"health","confidence":950,"quote":"我对青霉素过敏，最近在吃降压药"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const before = await overview(context.control);
    expect(before.memories).toEqual([]);
    expect(before.pending.map(({ text, topic }) => [text, topic])).toEqual([
      ["主人对青霉素过敏", "health"],
      ["主人在吃降压药", "health"],
    ]);
    const [first, second] = before.pending;
    if (!first || !second) throw new Error("pending");
    await respond(context.control, first.requestId, "approved");
    await respond(context.control, second.requestId, "edited", "主人每天早上吃一次降压药");
    const after = await overview(context.control);
    expect(after.pending).toEqual([]);
    expect(after.memories.map(({ text }) => text).sort()).toEqual([
      "主人对青霉素过敏",
      "主人每天早上吃一次降压药",
    ]);
    expect(
      after.memories.map(({ dataClassification, topic }) => [dataClassification, topic]),
    ).toEqual([
      ["private", "health"],
      ["private", "health"],
    ]);
    await context.memory.runProjectionBatch(5);
    expect(context.provider.upserts.map(({ content }) => content).sort()).toEqual([
      "主人对青霉素过敏",
      "主人每天早上吃一次降压药",
    ]);
    expect(context.audits.map(({ outcome }) => outcome)).toContain("approval_committed");
  });

  it("drops a rejected sensitive Memory", async () => {
    const context = await setup(
      "我月薪三万。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人月薪三万","classification":"sensitive","topic":"finance","confidence":950,"quote":"我月薪三万"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [pending] = (await overview(context.control)).pending;
    if (!pending) throw new Error("pending");
    expect(pending.topic).toBe("finance");
    await respond(context.control, pending.requestId, "rejected");
    expect(await overview(context.control)).toMatchObject({ memories: [], pending: [] });
  });

  it("never stores identity or card numbers, even when asked to remember them", async () => {
    const context = await setup(
      "记住我的身份证号 110101199003071234。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人的身份证号是 110101199003071234","classification":"private","confidence":990,"explicit":true}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.audits.map(({ outcome }) => outcome)).toEqual(["restricted_excluded"]);
    expect(await overview(context.control)).toMatchObject({ memories: [], pending: [] });
  });

  it("lets the Owner correct and delete a Memory and keeps the memory index in step", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.memory.runProjectionBatch(5);
    const [memory] = (await overview(context.control)).memories;
    if (!memory) throw new Error("memory");
    await context.protect("payload-edit", "主人最喜欢的颜色是深蓝色");
    await mutate(context.control, memory.memoryId, memory.revision, "correct", "payload-edit");
    await context.memory.runProjectionBatch(5);
    const [corrected] = (await overview(context.control)).memories;
    expect(corrected?.text).toBe("主人最喜欢的颜色是深蓝色");
    expect(context.provider.upserts.at(-1)?.content).toBe("主人最喜欢的颜色是深蓝色");
    await expect(
      mutate(context.control, memory.memoryId, memory.revision, "delete", null),
    ).rejects.toThrow("MEMORY_REVISION_CHANGED");
    if (!corrected) throw new Error("corrected");
    await mutate(context.control, memory.memoryId, corrected.revision, "delete", null);
    expect((await overview(context.control)).memories).toEqual([]);
    const jobs = await context.repository
      .memoryProjectionJobs()
      .listByMemory(memory.memoryId as never);
    expect(jobs.map(({ operation }) => operation)).toContain("delete");
  });

  it("stores an Owner fact as active long-term Memory and projects it", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '```json\n{"memories":[{"kind":"durable_fact","decision":"create","existingMemoryId":null,"text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"inference":false,"explicit":true,"category":"preference","importance":600,"entities":[],"quote":"我最喜欢的颜色是蓝色"},{"kind":"durable_fact","decision":"create","existingMemoryId":null,"text":"主人好像喜欢海","classification":"private","confidence":900,"inference":true,"explicit":false,"quote":"我最喜欢的颜色是蓝色"}]}\n```',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    expect(context.prompts[0]).toContain("我最喜欢的颜色是蓝色");
    const active = await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      status: "active",
      dataClassification: "private",
      sourceThreadId: THREAD_ID,
      confidencePermille: 950,
      attributes: {
        category: "preference",
        importancePermille: 600,
        entities: [],
        validFrom: null,
        validTo: null,
        supersededBy: null,
        evidenceVerified: true,
      },
    });
    expect(context.audits.map(({ outcome }) => outcome)).toEqual([
      "explicitly_approved",
      "confidence_below_threshold",
    ]);
    await context.memory.runProjectionBatch(5);
    expect(context.provider.upserts.map(({ content }) => content)).toEqual([
      "主人最喜欢的颜色是蓝色",
    ]);
  });

  it("captures each Run once and offers existing memories for updates", async () => {
    const context = await setup(
      "我改主意了，现在最喜欢绿色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是绿色","classification":"private","confidence":900,"quote":"我改主意了，现在最喜欢绿色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.prompts).toHaveLength(1);
    expect(
      await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID),
    ).toHaveLength(1);
  });

  it("drops a memory whose quote is not in the Owner's message", async () => {
    const context = await setup(
      "我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人住在杭州","classification":"private","confidence":950,"quote":"我住在杭州西湖边上"},{"kind":"durable_fact","decision":"create","text":"主人有一只猫","classification":"private","confidence":950}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    expect(context.audits.map(({ outcome }) => outcome)).toEqual([
      "evidence_unverified",
      "evidence_unverified",
    ]);
    expect(
      await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID),
    ).toHaveLength(0);
  });

  it("reports an invalid model response without writing Memory", async () => {
    const context = await setup("我叫 Andy。", "好的，我记住了。");
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toHaveLength(1);
    expect(context.audits.map(({ outcome }) => outcome)).toEqual(["extraction_failed"]);
    expect(
      await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID),
    ).toHaveLength(0);
  });
  it("updates a recalled memory using the previous answer as context", async () => {
    const context = await setup(
      "我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [saved] = await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    if (!saved) throw new Error("memory missing");
    await context.turn("agent", "那你现在最喜欢什么颜色？", "run-memory-capture");
    await context.turn("owner", "绿色", "run-memory-capture-2");
    context.relevant.push(saved.id);
    context.outputs.push(
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "update",
            existingMemoryId: saved.id,
            text: "主人最喜欢的颜色是绿色",
            classification: "private",
            confidence: 950,
            quote: "绿色",
          },
        ],
      }),
    );
    const second = new ProductionMemoryCapture(
      (
        context.capture as unknown as {
          options: ConstructorParameters<typeof ProductionMemoryCapture>[0];
        }
      ).options,
    );
    await second.start(context.requestFor("run-memory-capture-2"));
    await second.stop();
    expect(context.failures).toEqual([]);
    expect(context.prompts[1]).toContain("那你现在最喜欢什么颜色？");
    expect(context.prompts[1]).toContain(saved.id);
    const active = await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: saved.id, revision: 2 });
  });
});
