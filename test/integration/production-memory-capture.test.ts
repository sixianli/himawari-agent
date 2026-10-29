import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryExtractionAuditRecord,
  type MemoryProviderProjectionPort,
  OwnerProfileService,
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
import {
  memoryCapturePrompt,
  ProductionMemoryCapture,
  parseMemoryCandidates,
} from "../../apps/agent-service/src/production-memory-capture.ts";
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
      reminders: repository.memoryReminders(),
      book: repository.memoryBook(),
      timeZone: "Asia/Shanghai",
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
    const clock = { value: T0 };
    const control = new ProductionMemoryControl({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      approvals: repository.sensitiveMemoryApprovals(),
      memory,
      reminders: repository.memoryReminders(),
      book: repository.memoryBook(),
      profile: new OwnerProfileService({
        state: repository.productMemoryState(),
        pins: repository.memoryBook(),
        readText: async (record) => {
          const payload = await payloads.get(record.contentRef);
          return payload
            ? new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }))
            : undefined;
        },
        storeText: async () => {},
        digest: (text) => String(text.length),
      }),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
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
      clock,
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
    action: "correct" | "delete" | "recover",
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
    expect((await overview(context.control)).memories.map(({ status }) => status)).toEqual([
      "trashed",
    ]);
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

  it("schedules a reminder for a commitment and lets the Owner snooze and dismiss it", async () => {
    const context = await setup(
      "我答应老板周五下午三点前交季度报告。",
      '{"memories":[{"kind":"commitment","decision":"create","existingMemoryId":null,"text":"主人答应老板周五下午三点前交季度报告","classification":"private","confidence":950,"inference":false,"explicit":false,"category":"event","importance":800,"entities":[],"validFrom":null,"dueAt":"2026-10-30T15:00","repeat":"none","quote":"我答应老板周五下午三点前交季度报告"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    expect(context.prompts.at(-1)).toContain('"ownerTimeZone":"Asia/Shanghai"');
    const [saved] = await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    const reminders = context.repository.memoryReminders();
    const reminderId = `reminder:${saved?.id}`;
    expect(await reminders.read(reminderId)).toMatchObject({
      dueAt: "2026-10-30T07:00:00.000Z",
      remindAt: "2026-10-30T06:00:00.000Z",
      repeat: "none",
      status: "scheduled",
    });
    expect((await overview(context.control)).reminders).toEqual([]);
    const revision = await context.control.revision();
    context.clock.value = "2026-10-30T06:05:00.000Z";
    expect(await context.control.revision()).not.toBe(revision);
    expect((await overview(context.control)).reminders).toEqual([
      {
        reminderId,
        text: "主人答应老板周五下午三点前交季度报告",
        dueAt: "2026-10-30T07:00:00.000Z",
        remindAt: "2026-10-30T06:00:00.000Z",
        sourceThreadId: THREAD_ID,
      },
    ]);
    const answer = (action: "dismiss" | "snooze") =>
      context.control.execute({
        ...envelope,
        kind: "command",
        type: "memory.reminder.respond",
        payload: { reminderId, action },
      } as never);
    await answer("snooze");
    expect((await reminders.read(reminderId))?.remindAt).toBe("2026-10-30T07:05:00.000Z");
    expect((await overview(context.control)).reminders).toEqual([]);
    context.clock.value = "2026-10-30T07:06:00.000Z";
    expect((await overview(context.control)).reminders).toHaveLength(1);
    await answer("dismiss");
    expect(await reminders.read(reminderId)).toMatchObject({
      status: "dismissed",
      dismissedAt: "2026-10-30T07:06:00.000Z",
    });
    expect((await overview(context.control)).reminders).toEqual([]);
    await expect(
      context.control.execute({
        ...envelope,
        kind: "command",
        type: "memory.reminder.respond",
        payload: { reminderId: "reminder:missing", action: "dismiss" },
      } as never),
    ).rejects.toThrow("MEMORY_REMINDER_NOT_FOUND");
  });

  it("[MP-1] rolls a yearly reminder forward when it is dismissed and stops it when cancelled", async () => {
    const context = await setup(
      "我妈妈的生日是 5 月 12 日，到时候提醒我。",
      '{"memories":[{"kind":"durable_fact","decision":"create","existingMemoryId":null,"text":"主人妈妈的生日是 5 月 12 日","classification":"private","confidence":950,"inference":false,"explicit":true,"category":"relationship","importance":850,"entities":[],"validFrom":null,"dueAt":"2026-05-12","repeat":"yearly","quote":"我妈妈的生日是 5 月 12 日"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [saved] = await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    const reminderId = `reminder:${saved?.id}`;
    const reminders = context.repository.memoryReminders();
    expect(await reminders.read(reminderId)).toMatchObject({
      dueAt: "2027-05-12T01:00:00.000Z",
      remindAt: "2027-05-12T01:00:00.000Z",
      repeat: "yearly",
    });
    context.clock.value = "2027-05-12T01:30:00.000Z";
    await context.control.execute({
      ...envelope,
      kind: "command",
      type: "memory.reminder.respond",
      payload: { reminderId, action: "dismiss" },
    } as never);
    expect(await reminders.read(reminderId)).toMatchObject({
      status: "scheduled",
      dueAt: "2028-05-12T01:00:00.000Z",
      dismissedAt: null,
    });
    expect((await overview(context.control)).upcoming).toEqual([]);
    context.clock.value = "2028-04-01T00:00:00.000Z";
    expect((await overview(context.control)).upcoming).toEqual([
      {
        reminderId,
        memoryId: saved?.id,
        text: "主人妈妈的生日是 5 月 12 日",
        dueAt: "2028-05-12T01:00:00.000Z",
        repeat: "yearly",
        sourceThreadId: THREAD_ID,
      },
    ]);
    await context.control.execute({
      ...envelope,
      kind: "command",
      type: "memory.reminder.respond",
      payload: { reminderId, action: "cancel" },
    } as never);
    expect(await reminders.read(reminderId)).toMatchObject({
      status: "dismissed",
      dueAt: "2028-05-12T01:00:00.000Z",
    });
    expect((await overview(context.control)).upcoming).toEqual([]);
  });

  const command = (control: ProductionMemoryControl, type: string, payload: unknown, key = type) =>
    control.execute({
      ...envelope,
      idempotencyKey: key,
      kind: "command",
      type,
      payload,
    } as never);
  const secondRun = async (
    context: Awaited<ReturnType<typeof setup>>,
    message: string,
    output: unknown,
    runId: string,
  ) => {
    await context.turn("owner", message, runId);
    context.outputs.push(JSON.stringify(output));
    const next = new ProductionMemoryCapture(
      (
        context.capture as unknown as {
          options: ConstructorParameters<typeof ProductionMemoryCapture>[0];
        }
      ).options,
    );
    await next.start(context.requestFor(runId));
    await next.stop();
  };

  it("[MP-1] lists category, sub-category, state, upcoming reminders and the pause switch", async () => {
    const context = await setup(
      "我最喜欢的颜色是蓝色，11 月 3 日下午 3 点和房东视频看房。",
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "create",
            text: "主人最喜欢的颜色是蓝色",
            classification: "private",
            confidence: 950,
            category: "preference",
            subCategory: "颜色",
            quote: "我最喜欢的颜色是蓝色",
          },
          {
            kind: "commitment",
            decision: "create",
            text: "主人 11 月 3 日下午 3 点和房东视频看房",
            classification: "private",
            confidence: 950,
            category: "event",
            subCategory: "看房",
            dueAt: "2026-11-03T15:00",
            repeat: "none",
            quote: "11 月 3 日下午 3 点和房东视频看房",
          },
        ],
      }),
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const view = await overview(context.control);
    const color = view.memories.find(({ text }) => text.includes("蓝色"));
    expect(color).toMatchObject({
      category: "preference",
      subCategory: "颜色",
      status: "active",
      recordedAt: T0,
      lastUsedAt: null,
      importBatchId: null,
    });
    expect(view.memories.find(({ text }) => text.includes("看房"))?.subCategory).toBeNull();
    expect(view.upcoming).toEqual([
      expect.objectContaining({
        text: "主人 11 月 3 日下午 3 点和房东视频看房",
        dueAt: "2026-11-03T07:00:00.000Z",
        repeat: "none",
      }),
    ]);
    expect(view.capturePaused).toBe(false);
    expect(view).toMatchObject({ people: [], personSuggestions: [], imports: [] });
  });

  it("[MP-2] keeps a deleted Memory in recent deletions for seven days and can bring it back", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [memory] = (await overview(context.control)).memories;
    if (!memory) throw new Error("memory");
    await mutate(context.control, memory.memoryId, memory.revision, "delete", null);
    const [trashed] = (await overview(context.control)).memories;
    expect(trashed).toMatchObject({ memoryId: memory.memoryId, status: "trashed" });
    if (!trashed) throw new Error("trashed");
    await context.memory.runProjectionBatch(5);
    await mutate(context.control, memory.memoryId, trashed.revision, "recover", null);
    const [recovered] = (await overview(context.control)).memories;
    expect(recovered).toMatchObject({ memoryId: memory.memoryId, status: "active" });
    if (!recovered) throw new Error("recovered");
    await mutate(context.control, memory.memoryId, recovered.revision, "delete", null);
    context.clock.value = "2026-11-01T11:59:00.000Z";
    expect((await overview(context.control)).memories).toHaveLength(1);
    context.clock.value = "2026-11-01T12:00:01.000Z";
    expect((await overview(context.control)).memories).toEqual([]);
    expect(
      (await context.repository.productMemoryState().read(memory.memoryId as never))?.status,
    ).toBe("deletion_pending");
  });

  it("[MP-3] adds a Memory the Owner types in once one was learned and refuses card numbers", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.protect("payload-manual", "主人喜欢早上跑步");
    expect((await overview(context.control)).manualAddReady).toBe(false);
    await context.capture.start(context.request);
    await context.capture.stop();
    expect((await overview(context.control)).manualAddReady).toBe(true);
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-manual", category: "preference", subCategory: "运动", pinned: false },
      "manual-1",
    );
    const added = (await overview(context.control)).memories.find(({ text }) =>
      text.includes("跑步"),
    );
    expect(added).toMatchObject({
      memoryId: "memory:owner:manual-1",
      category: "preference",
      subCategory: "运动",
      status: "active",
      sourceThreadId: null,
    });
    await context.memory.runProjectionBatch(5);
    expect(context.provider.upserts.map(({ content }) => content)).toContain("主人喜欢早上跑步");
    await context.protect("payload-card", "我的卡号是 6222020200112233445");
    await expect(
      command(
        context.control,
        "memory.create",
        { contentRef: "payload-card", category: "finance", subCategory: null, pinned: false },
        "manual-2",
      ),
    ).rejects.toThrow("MEMORY_TEXT_REFUSED");
  });

  it("[MEM-PIN] lets the Owner decide which memories every conversation brings", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"category":"preference","importance":650,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-coffee", "我每天必须喝咖啡");
    await context.protect("payload-run", "主人喜欢早上跑步");
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-coffee", category: "preference", subCategory: null, pinned: true },
      "manual-pinned",
    );
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-run", category: "preference", subCategory: null, pinned: false },
      "manual-plain",
    );
    let view = await overview(context.control);
    const byText = (needle: string) => {
      const found = view.memories.find(({ text }) => text.includes(needle));
      if (!found) throw new Error(`missing ${needle}`);
      return found;
    };
    const profiled = () => view.profile.flatMap(({ lines }) => lines.map(({ text }) => text));
    expect(byText("跑步")).toMatchObject({ importance: 500, profilePin: null });
    expect(byText("咖啡")).toMatchObject({ importance: 500, profilePin: "on" });
    expect(byText("蓝色")).toMatchObject({ importance: 650, profilePin: null });
    expect(profiled()).toEqual(["我每天必须喝咖啡", "主人最喜欢的颜色是蓝色"]);
    expect(view.profileUsage).toEqual({
      used: "我每天必须喝咖啡".length + 3 + "主人最喜欢的颜色是蓝色".length + 3,
      limit: 2000,
      queued: [],
    });
    const blue = byText("蓝色");
    await command(
      context.control,
      "memory.mutate",
      {
        memoryId: blue.memoryId,
        action: "unpin",
        expectedRevision: blue.revision,
        contentRef: null,
      },
      "unpin-blue",
    );
    view = await overview(context.control);
    expect(byText("蓝色").profilePin).toBe("off");
    expect(profiled()).toEqual(["我每天必须喝咖啡"]);
    expect(view.lastViewedAt).toBeNull();
    await command(context.control, "memory.page.viewed", {}, "viewed-1");
    expect((await overview(context.control)).lastViewedAt).toBe(context.clock.value);
  });

  it("[MEM-PIN] refuses to bring a sensitive memory into every conversation", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-mood", "主人最近有点抑郁", "sensitive");
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-mood", category: "health", subCategory: null, pinned: false },
      "manual-mood",
    );
    const mood = (await overview(context.control)).memories.find(({ text }) =>
      text.includes("抑郁"),
    );
    if (!mood) throw new Error("missing mood");
    await expect(
      command(
        context.control,
        "memory.mutate",
        {
          memoryId: mood.memoryId,
          action: "pin",
          expectedRevision: mood.revision,
          contentRef: null,
        },
        "pin-mood",
      ),
    ).rejects.toThrow("MEMORY_NOT_PINNABLE");
  });

  it("[MP-4] stops learning from conversations while memory is paused", async () => {
    const context = await setup(
      "我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await command(context.control, "memory.settings.set", { capturePaused: true });
    expect((await overview(context.control)).capturePaused).toBe(true);
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.prompts).toEqual([]);
    expect(
      await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID),
    ).toHaveLength(0);
    await command(context.control, "memory.settings.set", { capturePaused: false }, "resume");
    expect((await overview(context.control)).capturePaused).toBe(false);
  });

  it("[MP-5] reuses sub-categories and caps each category at eight", async () => {
    const existing = ["饮食", "运动", "颜色", "音乐", "电影", "旅行", "穿着", "作息"];
    const parsed = parseMemoryCandidates({
      output: JSON.stringify({
        memories: ["饮食", "宠物", "  运动 ", "这个小类名字实在是太长了不能用"].map(
          (subCategory, index) => ({
            kind: "durable_fact",
            decision: "create",
            text: `偏好 ${index}`,
            classification: "private",
            confidence: 900,
            category: "preference",
            subCategory,
          }),
        ),
      }),
      sourceRef: "payload",
      sourceClassification: "private",
      existingIds: new Set(),
      subCategories: { preference: existing },
    });
    expect(parsed.candidates.map(({ attributes }) => attributes?.subCategory ?? null)).toEqual([
      "饮食",
      null,
      "运动",
      null,
    ]);
    const prompt = memoryCapturePrompt("我喜欢猫", [], null, null, null, {
      subCategories: { preference: existing },
    });
    expect(prompt).toContain('"existingSubCategories":{"preference":["饮食","运动"');
    expect(prompt).toContain("每个 category 最多 8 个小类");
  });

  it("[MP-6] remembers people and their relations and merges a person the Owner confirms", async () => {
    const context = await setup(
      "张伟是我研究生时的导师，王磊是他以前带过的学生。",
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "create",
            text: "张伟是主人研究生时的导师，王磊是张伟以前带过的学生",
            classification: "private",
            confidence: 950,
            category: "relationship",
            people: [
              { name: "张伟", aliases: [], relation: "导师", reverseRelation: "学生" },
              { name: "王磊", aliases: [], relation: null, reverseRelation: null },
            ],
            personLinks: [{ from: "张伟", to: "王磊", relation: "学生", reverseRelation: "导师" }],
            quote: "张伟是我研究生时的导师，王磊是他以前带过的学生",
          },
        ],
      }),
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const first = await overview(context.control);
    const zhang = first.people.find(({ name }) => name === "张伟");
    const wang = first.people.find(({ name }) => name === "王磊");
    if (!zhang || !wang) throw new Error("people");
    expect(zhang).toMatchObject({ relation: "导师", reverseRelation: "学生" });
    expect(zhang.links).toEqual([{ personId: wang.personId, relation: "学生" }]);
    expect(wang.links).toEqual([{ personId: zhang.personId, relation: "导师" }]);
    await secondRun(
      context,
      "张老师说我简历里项目写得太散。",
      {
        memories: [
          {
            kind: "experience",
            decision: "create",
            text: "张老师认为主人简历里的项目写得太散",
            classification: "private",
            confidence: 900,
            category: "event",
            people: [{ name: "张老师", maybeSameAs: zhang.personId }],
            quote: "张老师说我简历里项目写得太散",
          },
        ],
      },
      "run-people-2",
    );
    expect(context.prompts[1]).toContain(`"knownPeople":[`);
    expect(context.prompts[1]).toContain(zhang.personId);
    const second = await overview(context.control);
    expect(second.people).toHaveLength(3);
    const [suggestion] = second.personSuggestions;
    expect(suggestion?.candidateId).toBe(zhang.personId);
    if (!suggestion) throw new Error("suggestion");
    await command(context.control, "memory.person.respond", {
      suggestionId: suggestion.suggestionId,
      merge: true,
    });
    const merged = await overview(context.control);
    expect(merged.personSuggestions).toEqual([]);
    expect(merged.people).toHaveLength(2);
    const kept = merged.people.find(({ personId }) => personId === zhang.personId);
    expect(kept?.aliases).toEqual(["张老师"]);
    expect(kept?.memoryIds).toHaveLength(2);
    await expect(
      command(
        context.control,
        "memory.person.respond",
        {
          suggestionId: suggestion.suggestionId,
          merge: true,
        },
        "again",
      ),
    ).rejects.toThrow("MEMORY_PERSON_NOT_FOUND");
  });

  it("[MP-7] imports chosen memories as one batch the Owner can undo", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-import-1", "回答一律用简体中文");
    await context.protect("payload-import-2", "Andy 在准备 AI 应用工程师岗位的面试");
    const commit = () =>
      command(
        context.control,
        "memory.import.commit",
        {
          batchId: "memory-import-codex-1",
          source: "codex",
          items: [
            { contentRef: "payload-import-1", category: "rule", subCategory: "回答方式" },
            { contentRef: "payload-import-2", category: "goal", subCategory: null },
          ],
        },
        "import-1",
      );
    expect(await commit()).toEqual({ resultRef: "memory-import-codex-1", replayed: false });
    expect(await commit()).toEqual({ resultRef: "memory-import-codex-1", replayed: true });
    const imported = await overview(context.control);
    expect(
      imported.memories.filter(({ importBatchId }) => importBatchId === "memory-import-codex-1"),
    ).toHaveLength(2);
    expect(imported.imports).toEqual([
      {
        batchId: "memory-import-codex-1",
        source: "codex",
        itemCount: 2,
        createdAt: T0,
        undone: false,
      },
    ]);
    await command(context.control, "memory.import.undo", { batchId: "memory-import-codex-1" });
    const undone = await overview(context.control);
    expect(
      undone.memories
        .filter(({ importBatchId }) => importBatchId === "memory-import-codex-1")
        .map(({ status }) => status),
    ).toEqual(["trashed", "trashed"]);
    expect(undone.imports[0]?.undone).toBe(true);
    await expect(
      command(context.control, "memory.import.undo", { batchId: "memory-import-codex-1" }, "u2"),
    ).rejects.toThrow("MEMORY_IMPORT_NOT_FOUND");
  });
});
