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
    return {
      repository,
      memory,
      provider,
      capture,
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

  it("stores an Owner fact as active long-term Memory and projects it", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '```json\n{"memories":[{"kind":"durable_fact","decision":"create","existingMemoryId":null,"text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"inference":false,"explicit":true},{"kind":"durable_fact","decision":"create","existingMemoryId":null,"text":"主人好像喜欢海","classification":"private","confidence":900,"inference":true,"explicit":false}]}\n```',
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
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是绿色","classification":"private","confidence":900}]}',
    );
    await context.capture.start(context.request);
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.prompts).toHaveLength(1);
    expect(
      await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID),
    ).toHaveLength(1);
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
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950}]}',
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
