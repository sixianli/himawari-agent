import { createHash } from "node:crypto";
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
  gatewayV2MessageSchema,
  MEMORY_SOURCE_REF_MAX_LENGTH,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { TRUSTED_PROMPT_TEXTS } from "@himawari-agent/prompt-catalog";
import { redactForEgress } from "@himawari-agent/sensitive-capture";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  memoryCapturePrompt,
  ProductionMemoryCapture,
  parseMemoryCandidates,
} from "../../apps/agent-service/src/production-memory-capture.ts";
import { ProductionMemoryControl } from "../../apps/agent-service/src/production-memory-control.ts";
import {
  ProductionReminderTools,
  ProductionReminderWriter,
} from "../../apps/agent-service/src/production-reminder-writer.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-capture");
const AGENT_ID = createAgentId("agent-memory-capture");
const THREAD_ID = createThreadId("thread-memory-capture");
const T0 = "2026-10-25T12:00:00.000Z";
const captureTag = (kind: string, value: string) =>
  [...createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 8)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");

function placeholderOf(message: string): string {
  const prompt = memoryCapturePrompt(message, [], null, T0, "Asia/Shanghai", {
    subCategories: {},
    people: [],
  });
  const masked = redactForEgress(prompt, {
    known: new Map(),
    tag: captureTag,
    trusted: TRUSTED_PROMPT_TEXTS,
  }).text;
  const placeholder = masked.match(/\[密码#[^\]]+\]/u)?.[0];
  if (placeholder === undefined) throw new Error("Expected a masked password");
  return placeholder;
}
const FAKE_OPENAI_KEY = `sk-${"proj"}-abcdefghijklmnopqrstuvwxyz0123456789`;

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
      const rows = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      rows
        .prepare(
          `INSERT INTO thread_messages (
            id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
            classification, committed_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'private', ?)`,
        )
        .run(`message-${sequence}`, OWNER_ID, AGENT_ID, THREAD_ID, sequence, role, contentRef, T0);
      rows.close();
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
      ledger: repository.decisionLedger(),
      timeZone: "Asia/Shanghai",
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => T0 },
      assertActive: async () => {},
      externalTag: async () => captureTag,
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
      timeZone: "Asia/Shanghai",
      onAudit: (record) => audits.push(record),
    });
    const reminderTools = new ProductionReminderTools({
      writer: new ProductionReminderWriter({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        memory,
        state: repository.productMemoryState(),
        book: repository.memoryBook(),
        reminders: repository.memoryReminders(),
        payloads,
        protector: adapters.payloadProtector,
        clock: { now: () => clock.value },
        timeZone: "Asia/Shanghai",
      }),
      timeZone: "Asia/Shanghai",
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
    const ledgerEntries = () =>
      repository.decisionLedger().list({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        kind: "memory_candidate",
        since: "1970-01-01T00:00:00.000Z",
        limit: 100,
      });
    const plaintext = async (ref: string | null) => {
      const payload = ref === null ? undefined : await payloads.get(ref);
      return payload
        ? new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }))
        : undefined;
    };
    const sql = (run: (database: ReturnType<typeof openQualifiedDatabase>) => void) => {
      const rows = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      try {
        run(rows);
      } finally {
        rows.close();
      }
    };
    return {
      sql,
      clock,
      repository,
      memory,
      provider,
      ledgerEntries,
      plaintext,
      capture,
      control,
      reminderTools,
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
    action: "correct" | "delete" | "recover" | "restore",
    contentRef: string | null,
  ) =>
    control.execute({
      ...envelope,
      kind: "command",
      type: "memory.mutate",
      payload: { memoryId, action, expectedRevision, contentRef },
    } as never);

  it("[MH-1] keeps every round of a back-and-forth fact, its stance and the Owner's words", async () => {
    const memoryOutput = (memory: Record<string, unknown>) =>
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            classification: "private",
            confidence: 900,
            category: "preference",
            subCategory: "社交",
            ...memory,
          },
        ],
      });
    const context = await setup(
      "我超想出去玩，周末去哪儿都行",
      memoryOutput({
        decision: "create",
        text: "主人很喜欢出去玩",
        stance: "想出去玩",
        quote: "我超想出去玩，周末去哪儿都行",
      }),
    );
    const options = (
      context.capture as unknown as {
        options: ConstructorParameters<typeof ProductionMemoryCapture>[0];
      }
    ).options;
    await context.capture.start(context.request);
    await context.capture.stop();
    const round = async (runId: string, ownerText: string, output: string) => {
      await context.turn("owner", ownerText, runId);
      context.outputs.push(output);
      const capture = new ProductionMemoryCapture(options);
      await capture.start(context.requestFor(runId));
      await capture.stop();
    };
    const head = async () => {
      const [current] = (
        await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)
      ).filter(({ attributes }) => !attributes?.supersededBy);
      if (!current) throw new Error("no current memory");
      return current.id;
    };
    const first = await head();
    await round(
      "run-out-2",
      "其实我不爱出门，有点社恐",
      memoryOutput({
        decision: "supersede",
        existingMemoryId: first,
        text: "主人不爱出去玩，有社恐",
        stance: "不想出去玩",
        quote: "其实我不爱出门，有点社恐",
      }),
    );
    const second = await head();
    await round(
      "run-out-3",
      "真的不想出去，别劝我",
      memoryOutput({
        decision: "unchanged",
        existingMemoryId: second,
        text: "主人不爱出去玩，有社恐",
        stance: "不想出去玩",
        quote: "真的不想出去，别劝我",
      }),
    );
    expect(context.prompts.at(-1)).toContain('"stance":"不想出去玩"');
    await round(
      "run-out-4",
      "我不想出门，最近都宅在家打游戏",
      memoryOutput({
        decision: "update",
        existingMemoryId: second,
        text: "主人不想出门，最近都宅在家打游戏",
        stance: "不想出去玩",
        quote: "最近都宅在家打游戏",
      }),
    );
    await round(
      "run-out-5",
      "现在又想出去玩了，想有人带我",
      memoryOutput({
        decision: "supersede",
        existingMemoryId: second,
        text: "主人想有人带他出去玩",
        stance: "想出去玩",
        quote: "现在又想出去玩了",
      }),
    );
    const third = await head();
    expect(context.failures).toEqual([]);
    const byId = async () =>
      new Map((await overview(context.control)).memories.map((item) => [item.memoryId, item]));
    const nodes = (memory: { history: readonly Record<string, unknown>[] } | undefined) =>
      memory?.history.map(({ kind, text, stance, quote, sourceThreadId, sourceDeleted }) => ({
        kind,
        text,
        stance,
        quote,
        sourceThreadId,
        sourceDeleted,
      }));
    const view = await byId();
    expect(view.get(first)).toMatchObject({ supersededBy: second, stance: "想出去玩" });
    expect(view.get(second)).toMatchObject({
      supersededBy: third,
      text: "主人不想出门，最近都宅在家打游戏",
      stance: "不想出去玩",
    });
    expect(view.get(third)).toMatchObject({ supersededBy: null, stance: "想出去玩" });
    const from = { sourceThreadId: THREAD_ID, sourceDeleted: false };
    expect(nodes(view.get(first))).toEqual([
      {
        kind: "created",
        text: "主人很喜欢出去玩",
        stance: "想出去玩",
        quote: "我超想出去玩，周末去哪儿都行",
        ...from,
      },
    ]);
    expect(nodes(view.get(second))).toEqual([
      {
        kind: "created",
        text: "主人不爱出去玩，有社恐",
        stance: "不想出去玩",
        quote: "其实我不爱出门，有点社恐",
        ...from,
      },
      {
        kind: "reaffirmed",
        text: "主人不爱出去玩，有社恐",
        stance: "不想出去玩",
        quote: "真的不想出去，别劝我",
        ...from,
      },
      {
        kind: "updated",
        text: "主人不想出门，最近都宅在家打游戏",
        stance: "不想出去玩",
        quote: "最近都宅在家打游戏",
        ...from,
      },
    ]);
    expect(nodes(view.get(third))).toEqual([
      {
        kind: "created",
        text: "主人想有人带他出去玩",
        stance: "想出去玩",
        quote: "现在又想出去玩了",
        ...from,
      },
    ]);
    const current = view.get(third);
    if (!current) throw new Error("current");
    await context.protect("payload-out-edit", "主人想有人带他去海边玩");
    await mutate(context.control, third, current.revision, "correct", "payload-out-edit");
    const restoredFrom = (await byId()).get(second);
    if (!restoredFrom) throw new Error("second");
    await mutate(context.control, second, restoredFrom.revision, "restore", null);
    const after = await byId();
    expect(nodes(after.get(third))?.map(({ kind, text }) => [kind, text])).toEqual([
      ["created", "主人想有人带他出去玩"],
      ["edited", "主人想有人带他去海边玩"],
    ]);
    expect(nodes(after.get(third))?.[1]).toMatchObject({ quote: null, sourceThreadId: null });
    expect(nodes(after.get(second))?.map(({ kind }) => kind)).toEqual([
      "created",
      "reaffirmed",
      "updated",
      "restored",
    ]);
  });

  const viaGateway = async (
    control: ProductionMemoryControl,
    type: string,
    payload: Record<string, unknown>,
    key: string,
  ) =>
    control.execute(
      gatewayV2MessageSchema.parse({
        ...envelope,
        idempotencyKey: key,
        kind: "command",
        type,
        payload,
      }) as never,
    );
  const gatewayOverview = async (control: ProductionMemoryControl) => {
    const { idempotencyKey: _, ...snapshotEnvelope } = envelope;
    const payload = await overview(control);
    return (
      gatewayV2MessageSchema.parse({
        ...snapshotEnvelope,
        kind: "snapshot",
        type: "memory.overview.snapshot",
        payload,
      }) as { payload: typeof payload }
    ).payload;
  };
  const restoreVersion = (
    control: ProductionMemoryControl,
    memoryId: string,
    expectedRevision: number,
    historyId: number,
    key: string,
  ) =>
    viaGateway(
      control,
      "memory.mutate",
      { memoryId, action: "restore_version", expectedRevision, contentRef: null, historyId },
      key,
    );

  it("[P3-7] rolls a memory edited three times back to its first version and keeps every earlier step", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const edits = ["主人最喜欢的颜色是深蓝色", "主人最喜欢的颜色是绿色", "主人最喜欢的颜色是红色"];
    for (const [index, text] of edits.entries()) {
      const [current] = (await gatewayOverview(context.control)).memories;
      if (!current) throw new Error("memory");
      await context.protect(`payload-edit-${index}`, text);
      await viaGateway(
        context.control,
        "memory.mutate",
        {
          memoryId: current.memoryId,
          action: "correct",
          expectedRevision: current.revision,
          contentRef: `payload-edit-${index}`,
          historyId: null,
        },
        `edit-${index}`,
      );
    }
    const [edited] = (await gatewayOverview(context.control)).memories;
    if (!edited) throw new Error("edited");
    expect(edited.text).toBe("主人最喜欢的颜色是红色");
    const before = edited.history;
    expect(before.map(({ kind, text }) => [kind, text])).toEqual([
      ["created", "主人最喜欢的颜色是蓝色"],
      ["edited", "主人最喜欢的颜色是深蓝色"],
      ["edited", "主人最喜欢的颜色是绿色"],
      ["edited", "主人最喜欢的颜色是红色"],
    ]);
    const first = before[0];
    if (!first) throw new Error("first version");
    await restoreVersion(
      context.control,
      edited.memoryId,
      edited.revision,
      first.historyId,
      "restore-first",
    );
    await context.memory.runProjectionBatch(5);
    const [restored] = (await gatewayOverview(context.control)).memories;
    if (!restored) throw new Error("restored");
    expect(restored.text).toBe(first.text);
    expect(restored.revision).toBe(edited.revision + 1);
    expect(restored.history.slice(0, 4)).toEqual(before);
    expect(restored.history.slice(4)).toEqual([
      expect.objectContaining({
        kind: "restored",
        text: first.text,
        sourceThreadId: null,
      }),
    ]);
    const state = context.repository.productMemoryState();
    const record = await state.read(edited.memoryId as never);
    const [created] = await state.listHistory({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memoryIds: [edited.memoryId as never],
    });
    expect(record?.contentRef).toBe(created?.contentRef);
    expect(context.provider.upserts.at(-1)?.content).toBe(first.text);

    await expect(
      restoreVersion(
        context.control,
        restored.memoryId,
        restored.revision,
        first.historyId,
        "restore-again",
      ),
    ).rejects.toThrow("MEMORY_VERSION_ALREADY_CURRENT");
    await expect(
      restoreVersion(
        context.control,
        restored.memoryId,
        edited.revision,
        before[2]?.historyId ?? 0,
        "restore-stale",
      ),
    ).rejects.toThrow("MEMORY_REVISION_CHANGED");
    await context.protect("payload-coffee", "我每天必须喝咖啡");
    await viaGateway(
      context.control,
      "memory.create",
      { contentRef: "payload-coffee", category: "preference", subCategory: null, pinned: false },
      "manual-coffee",
    );
    const coffee = (await gatewayOverview(context.control)).memories.find(({ text }) =>
      text.includes("咖啡"),
    );
    if (!coffee) throw new Error("coffee");
    await expect(
      restoreVersion(
        context.control,
        coffee.memoryId,
        coffee.revision,
        before[2]?.historyId ?? 0,
        "restore-foreign",
      ),
    ).rejects.toThrow("MEMORY_VERSION_NOT_FOUND");
    expect(() =>
      gatewayV2MessageSchema.parse({
        ...envelope,
        kind: "command",
        type: "memory.mutate",
        payload: {
          memoryId: restored.memoryId,
          action: "restore_version",
          expectedRevision: restored.revision,
          contentRef: null,
          historyId: null,
        },
      }),
    ).toThrow("historyId");
    expect(() =>
      gatewayV2MessageSchema.parse({
        ...envelope,
        kind: "command",
        type: "memory.mutate",
        payload: {
          memoryId: restored.memoryId,
          action: "delete",
          expectedRevision: restored.revision,
          contentRef: null,
          historyId: first.historyId,
        },
      }),
    ).toThrow("historyId");
    const [after] = (await gatewayOverview(context.control)).memories.filter(
      ({ memoryId }) => memoryId === restored.memoryId,
    );
    expect(after?.history).toEqual(restored.history);
  });

  it("[P3-7] restores an earlier wording of a replaced memory into the current one", async () => {
    const memoryOutput = (memory: Record<string, unknown>) =>
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            classification: "private",
            confidence: 900,
            category: "identity",
            ...memory,
          },
        ],
      });
    const context = await setup(
      "我住在杭州",
      memoryOutput({ decision: "create", text: "主人住在杭州", quote: "我住在杭州" }),
    );
    const options = (
      context.capture as unknown as {
        options: ConstructorParameters<typeof ProductionMemoryCapture>[0];
      }
    ).options;
    await context.capture.start(context.request);
    await context.capture.stop();
    const round = async (runId: string, ownerText: string, output: string) => {
      await context.turn("owner", ownerText, runId);
      context.outputs.push(output);
      const capture = new ProductionMemoryCapture(options);
      await capture.start(context.requestFor(runId));
      await capture.stop();
    };
    const [old] = (await gatewayOverview(context.control)).memories;
    if (!old) throw new Error("old");
    await round(
      "run-home-2",
      "其实我住在杭州西湖边",
      memoryOutput({
        decision: "update",
        existingMemoryId: old.memoryId,
        text: "主人住在杭州西湖边",
        quote: "其实我住在杭州西湖边",
      }),
    );
    await round(
      "run-home-3",
      "我搬到南京了",
      memoryOutput({
        decision: "supersede",
        existingMemoryId: old.memoryId,
        text: "主人住在南京",
        quote: "我搬到南京了",
      }),
    );
    expect(context.failures).toEqual([]);
    const view = await gatewayOverview(context.control);
    const replaced = view.memories.find(({ memoryId }) => memoryId === old.memoryId);
    const head = view.memories.find(({ supersededBy }) => supersededBy === null);
    if (!replaced || !head) throw new Error("chain");
    expect(replaced.supersededBy).toBe(head.memoryId);
    const earliest = replaced.history[0];
    expect(earliest).toMatchObject({ kind: "created", text: "主人住在杭州" });
    if (!earliest) throw new Error("earliest");
    await restoreVersion(
      context.control,
      head.memoryId,
      head.revision,
      earliest.historyId,
      "restore-replaced",
    );
    const after = await gatewayOverview(context.control);
    const current = after.memories.find(({ memoryId }) => memoryId === head.memoryId);
    expect(current?.text).toBe("主人住在杭州");
    expect(current?.history.map(({ kind, text }) => [kind, text])).toEqual([
      ["created", "主人住在南京"],
      ["restored", "主人住在杭州"],
    ]);
    expect(after.memories.find(({ memoryId }) => memoryId === old.memoryId)).toEqual(replaced);
    const state = context.repository.productMemoryState();
    const record = await state.read(head.memoryId as never);
    const [own] = await state.listHistory({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memoryIds: [old.memoryId as never],
    });
    expect(record?.contentRef).toBe(own?.contentRef);
  });

  it("[P3-7] copies a less sensitive earlier wording at the current memory's level", async () => {
    const context = await setup(
      "我住在杭州",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人住在杭州","classification":"private","confidence":950,"explicit":true,"quote":"我住在杭州"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [memory] = (await gatewayOverview(context.control)).memories;
    if (!memory) throw new Error("memory");
    await context.protect("payload-public", "主人住在浙江", "public" as never);
    context.sql((database) => {
      database
        .prepare(
          `INSERT INTO memory_history_events (memory_id, kind, content_ref, occurred_at)
          VALUES (?, 'edited', 'payload-public', ?)`,
        )
        .run(memory.memoryId, T0);
    });
    const older = (await gatewayOverview(context.control)).memories[0]?.history.at(-1);
    expect(older).toMatchObject({ text: "主人住在浙江" });
    await restoreVersion(
      context.control,
      memory.memoryId,
      memory.revision,
      older?.historyId ?? 0,
      "restore-public",
    );
    const record = await context.repository.productMemoryState().read(memory.memoryId as never);
    expect(record?.contentRef).not.toBe("payload-public");
    expect(record?.dataClassification).toBe("private");
    expect(await context.plaintext(record?.contentRef ?? null)).toBe("主人住在浙江");
    expect((await gatewayOverview(context.control)).memories[0]?.text).toBe("主人住在浙江");
  });

  it("[P3-7] refuses to copy a more sensitive earlier wording into a less sensitive memory", async () => {
    const context = await setup(
      "我住在杭州",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人住在杭州","classification":"private","confidence":950,"explicit":true,"quote":"我住在杭州"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [memory] = (await gatewayOverview(context.control)).memories;
    if (!memory) throw new Error("memory");
    await context.protect("payload-secret", "主人在杭州看心理医生", "sensitive");
    context.sql((database) => {
      database
        .prepare(
          `INSERT INTO memory_history_events (memory_id, kind, content_ref, occurred_at)
          VALUES (?, 'edited', 'payload-secret', ?)`,
        )
        .run(memory.memoryId, T0);
    });
    const secret = (await gatewayOverview(context.control)).memories[0]?.history.at(-1);
    expect(secret).toMatchObject({ text: "主人在杭州看心理医生" });
    await expect(
      restoreVersion(
        context.control,
        memory.memoryId,
        memory.revision,
        secret?.historyId ?? 0,
        "restore-secret",
      ),
    ).rejects.toThrow("MEMORY_VERSION_CLASSIFICATION_HIGHER");
    expect((await gatewayOverview(context.control)).memories[0]?.text).toBe("主人住在杭州");
  });

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

  it("[mask-not-block] tells the model to mark passwords, keys, identity and card numbers sensitive and to skip one-time codes", () => {
    const prompt = memoryCapturePrompt("记住我的密码是 abc12345", [], null, null, null);
    expect(prompt).toContain("证件号码、银行卡或账户号码、密码、密钥用 sensitive");
    expect(prompt).toContain("一次性验证码");
    expect(prompt).not.toContain("密码和验证码用 restricted");
    expect(prompt).not.toContain("密码密钥等凭据");
  });

  it("[mask-not-block] stores a password the Owner asked to remember as written, marked sensitive", async () => {
    const context = await setup(
      "记住我家 Wi-Fi 的密码是 abc12345。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人家的 Wi-Fi 密码是 abc12345","classification":"sensitive","topic":"other","confidence":990,"explicit":true,"quote":"我家 Wi-Fi 的密码是 abc12345"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const [memory] = (await overview(context.control)).memories;
    expect(memory?.text).toBe("主人家的 Wi-Fi 密码是 abc12345");
    expect(memory?.dataClassification).toBe("sensitive");
  });

  it("[mask-not-block] asks the Owner first when the model calls a password private and he did not ask to remember it", async () => {
    const context = await setup(
      "我家 Wi-Fi 的密码是 abc12345，你帮我看看信号。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人家的 Wi-Fi 密码是 abc12345","classification":"private","confidence":900,"explicit":false,"quote":"我家 Wi-Fi 的密码是 abc12345"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const snapshot = await overview(context.control);
    expect(snapshot.memories).toEqual([]);
    expect(snapshot.pending.map(({ text }) => text)).toEqual(["主人家的 Wi-Fi 密码是 abc12345"]);
  });

  it("asks the model to keep who the Owner's family are and the Owner's rules private, and only their private matters sensitive", () => {
    const prompt = memoryCapturePrompt("我老婆叫陈静，在医院当药剂师", [], null, null, null);
    expect(prompt).toContain("主人身边的人是谁（名字、和主人的关系、职业、住在哪个城市）");
    expect(prompt).toContain("主人给 Himawari 定的做事要求（即使提到钱");
    expect(prompt).toContain("他人的私事（别人的健康、钱、感情、行踪等）");
    expect(prompt).not.toContain("他人隐私");
  });

  it("[mask-not-block] stores an identity number the Owner asked to remember as written, marked sensitive", async () => {
    const context = await setup(
      "记住我的身份证号 110101199003071234。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人的身份证号是 110101199003071234","classification":"private","confidence":990,"explicit":true,"quote":"我的身份证号 110101199003071234"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    expect(context.audits.map(({ outcome }) => outcome)).not.toContain("restricted_excluded");
    const [memory] = (await overview(context.control)).memories;
    expect(memory?.text).toBe("主人的身份证号是 110101199003071234");
    expect(memory?.dataClassification).toBe("sensitive");
  });

  it("[mask-not-block] asks the Owner first when the model calls a card number private and he did not ask to remember it", async () => {
    const context = await setup(
      "我的银行卡号 6222020200112233445 绑定了工资。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人的银行卡号是 6222020200112233445","classification":"private","confidence":900,"explicit":false,"quote":"我的银行卡号 6222020200112233445"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const snapshot = await overview(context.control);
    expect(snapshot.memories).toEqual([]);
    expect(snapshot.pending.map(({ text }) => text)).toEqual([
      "主人的银行卡号是 6222020200112233445",
    ]);
  });

  it("[mask-not-block] marks a memory sensitive when only its quote holds the card number", async () => {
    const context = await setup(
      "记住我绑定了工资的银行卡号 6222020200112233445。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人有一张绑定工资的银行卡","classification":"private","confidence":990,"explicit":true,"quote":"银行卡号 6222020200112233445"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const [memory] = (await overview(context.control)).memories;
    expect(memory?.text).toBe("主人有一张绑定工资的银行卡");
    expect(memory?.dataClassification).toBe("sensitive");
  });

  it("[mask-not-block] still stores an ordinary long number the model calls private without asking", async () => {
    const context = await setup(
      "我的订单号是 12345，记得帮我查。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人有一个订单号 12345","classification":"private","confidence":900,"explicit":false,"quote":"我的订单号是 12345"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const snapshot = await overview(context.control);
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.memories.map(({ dataClassification }) => dataClassification)).toEqual([
      "private",
    ]);
  });

  it("[mask-not-block] restores a placeholder the model copied into the candidate text and quote", async () => {
    const message = "记住我的密码: hunter2abc 这件事。";
    const placeholder = placeholderOf(message);
    const context = await setup(
      message,
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "create",
            text: `主人的密码是 ${placeholder}`,
            classification: "private",
            confidence: 990,
            explicit: true,
            quote: `我的密码: ${placeholder} 这件事`,
          },
        ],
      }),
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const [memory] = (await overview(context.control)).memories;
    expect(memory?.text).toContain("hunter2abc");
    expect(memory?.text).not.toContain("#");
  });

  it.each([
    ["inside the message", '记住我的密码: ab"c\\d 这件事。', "我的密码: ", " 这件事", 'ab"c\\d'],
    ["at the end of the message", '记住我的密码是 ab"c\\d', "我的密码是 ", "", 'ab"c\\d'],
    [
      "plain at the end of the message",
      "记住我的密码是 hunter2abc",
      "我的密码是 ",
      "",
      "hunter2abc",
    ],
  ])(
    "[mask-not-block] stores a secret %s byte for byte",
    async (_name, message, before, after, secret) => {
      const placeholder = placeholderOf(message);
      const context = await setup(
        message,
        JSON.stringify({
          memories: [
            {
              kind: "durable_fact",
              decision: "create",
              text: `主人的密码是 ${placeholder}`,
              classification: "private",
              confidence: 990,
              explicit: true,
              quote: `${before}${placeholder}${after}`,
            },
          ],
        }),
      );
      await context.capture.start(context.request);
      await context.capture.stop();
      expect(context.failures).toEqual([]);
      const [memory] = (await overview(context.control)).memories;
      expect(memory?.text).toBe(`主人的密码是 ${secret}`);
    },
  );

  it("[mask-not-block] keeps a placeholder it cannot restore as written, without inventing a value", async () => {
    const context = await setup(
      "记住我的密码: hunter2abc 这件事。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人的密码是 [密码#zzzzzzzz]","classification":"private","confidence":990,"explicit":true,"quote":"我的密码: hunter2abc"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [memory] = (await overview(context.control)).memories;
    expect(memory?.text).toBe("主人的密码是 [密码#zzzzzzzz]");
  });

  it("[mask-not-block] still drops a candidate the model itself classifies as restricted", async () => {
    const context = await setup(
      "记住我的护照号 E12345678。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人的护照号是 E12345678","classification":"restricted","confidence":990,"explicit":true,"quote":"我的护照号 E12345678"}]}',
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
    const formal = active.filter(({ attributes }) => attributes?.tentative !== true);
    const tentative = active.filter(({ attributes }) => attributes?.tentative === true);
    expect(active).toHaveLength(2);
    expect(formal).toHaveLength(1);
    expect(formal[0]).toMatchObject({
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
      "tentative_kept",
    ]);
    await context.memory.runProjectionBatch(5);
    expect(context.provider.upserts.map(({ content }) => content).sort()).toEqual([
      "主人好像喜欢海",
      "主人最喜欢的颜色是蓝色",
    ]);
    expect(tentative).toHaveLength(1);
    expect(tentative[0]).toMatchObject({
      inference: true,
      confidencePermille: 700,
      sourceThreadId: THREAD_ID,
      attributes: { tentative: true, evidenceVerified: true },
    });
    expect(await context.plaintext(tentative[0]?.contentRef ?? null)).toBe("主人好像喜欢海");
    const ledger = await context.ledgerEntries();
    expect(ledger).toHaveLength(2);
    const kept = ledger.find(({ outcome }) => outcome === "kept");
    const suppressed = ledger.find(({ reasonCode }) => reasonCode === "kept_tentative");
    expect(kept).toMatchObject({
      reasonCode: "explicitly_approved",
      category: "preference",
      confidencePermille: 950,
      inferred: false,
    });
    expect(suppressed).toMatchObject({
      outcome: "kept",
      reasonCode: "kept_tentative",
      category: "other",
      confidencePermille: 700,
      inferred: true,
    });
    expect(suppressed?.subjectRef).toBe(tentative[0]?.id);
    expect(await context.plaintext(suppressed?.contentRef ?? null)).toBe("主人好像喜欢海");
  });

  it("[PA-2] a tentative memory is confirmed by `unchanged` only with a verified owner quote", async () => {
    const context = await setup(
      "好家里只喝明治的牛奶",
      '{"memories":[{"kind":"durable_fact","decision":"create","existingMemoryId":null,"text":"主人偏好明治乳制品","classification":"private","confidence":700,"inference":true,"quote":"好家里只喝明治的牛奶"}]}',
    );
    const options = (
      context.capture as unknown as {
        options: ConstructorParameters<typeof ProductionMemoryCapture>[0];
      }
    ).options;
    await context.capture.start(context.request);
    await context.capture.stop();
    const tentativeState = async () => {
      const [record] = (
        await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)
      ).filter(({ attributes }) => attributes?.evidenceVerified === true);
      if (!record) throw new Error("no memory");
      return record;
    };
    const created = await tentativeState();
    expect(created.attributes?.tentative).toBe(true);
    const unchanged = (quote: string) =>
      JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "unchanged",
            existingMemoryId: created.id,
            text: "主人偏好明治乳制品",
            classification: "private",
            confidence: 900,
            inference: false,
            quote,
          },
        ],
      });
    const round = async (runId: string, ownerText: string, output: string) => {
      await context.turn("owner", ownerText, runId);
      context.outputs.push(output);
      const capture = new ProductionMemoryCapture(options);
      await capture.start(context.requestFor(runId));
      await capture.stop();
    };
    await round("run-pa2-2", "今天天气不错", unchanged("明治"));
    expect((await tentativeState()).attributes?.tentative).toBe(true);
    expect(context.audits.map(({ outcome }) => outcome)).toContain("evidence_unverified");
    await round("run-pa2-unrelated", "明天下午三点开会", unchanged("明天下午三点开会"));
    expect((await tentativeState()).attributes?.tentative).toBe(true);
    await round("run-pa2-3", "我又买了明治的牛奶", unchanged("我又买了明治的牛奶"));
    expect((await tentativeState()).attributes?.tentative).not.toBe(true);
    expect(context.failures).toEqual([]);
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
    const ledger = await context.ledgerEntries();
    expect(ledger).toHaveLength(2);
    expect(ledger.map(({ outcome, reasonCode }) => [outcome, reasonCode])).toEqual([
      ["discarded", "evidence_unverified"],
      ["discarded", "evidence_unverified"],
    ]);
    expect(
      ledger.map(({ category, confidencePermille, inferred }) => [
        category,
        confidencePermille,
        inferred,
      ]),
    ).toEqual([
      ["other", 950, false],
      ["other", 950, false],
    ]);
    expect(
      (await Promise.all(ledger.map(({ contentRef }) => context.plaintext(contentRef)))).sort(),
    ).toEqual(["主人住在杭州", "主人有一只猫"].sort());
  });

  it("[mask-not-block] keeps the text of a candidate whose quote fails, even when it holds a machine secret", async () => {
    const context = await setup(
      "我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人的密钥是 ' +
        FAKE_OPENAI_KEY +
        '","classification":"private","confidence":950,"quote":"我的密钥是这个"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toEqual([]);
    const ledger = await context.ledgerEntries();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      outcome: "discarded",
      reasonCode: "evidence_unverified",
    });
    expect(ledger[0]?.contentRef).not.toBeNull();
  });

  it("writes no ledger row for a candidate whose quote is in the message and is simply dropped as invalid", async () => {
    const context = await setup(
      "我今天又不想出去玩了，真的。",
      '{"memories":[{"kind":"durable_fact","decision":"unchanged","existingMemoryId":"memory-not-shown","text":"主人最近不想出去玩","classification":"private","confidence":900,"quote":"我今天又不想出去玩了"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(await context.ledgerEntries()).toEqual([]);
  });

  it("[MH-1] logs a round where the model kept nothing or named a memory it was not shown", async () => {
    const empty = await setup("我今天又不想出去玩了。", '{"memories":[]}');
    await empty.capture.start(empty.request);
    await empty.capture.stop();
    expect(empty.failures).toEqual([]);
    expect(empty.audits.map(({ outcome }) => outcome)).toEqual(["nothing_to_remember"]);
    const unknown = await setup(
      "我今天又不想出去玩了，真的。",
      '{"memories":[{"kind":"durable_fact","decision":"unchanged","existingMemoryId":"memory-not-shown","text":"主人最近不想出去玩","classification":"private","confidence":900,"quote":"我今天又不想出去玩了"}]}',
    );
    await unknown.capture.start(unknown.request);
    await unknown.capture.stop();
    expect(unknown.failures).toEqual([]);
    expect(unknown.audits.map(({ outcome }) => outcome)).toEqual(["candidate_invalid"]);
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
    await context.control.execute({
      ...envelope,
      kind: "command",
      type: "memory.reminder.respond",
      payload: { reminderId, action: "cancel" },
    } as never);
    expect(await reminders.read(reminderId)).toMatchObject({
      status: "cancelled",
      dismissedAt: "2026-10-30T07:06:00.000Z",
    });
    for (const action of ["dismiss", "snooze"] as const)
      await expect(answer(action)).rejects.toThrow("MEMORY_REMINDER_CANCELLED");
    expect(await reminders.read(reminderId)).toMatchObject({ status: "cancelled" });
    await expect(
      context.control.execute({
        ...envelope,
        kind: "command",
        type: "memory.reminder.respond",
        payload: { reminderId: "reminder:missing", action: "dismiss" },
      } as never),
    ).rejects.toThrow("MEMORY_REMINDER_NOT_FOUND");
  });

  it("sets, lists and cancels reminders from the conversation tool and the reminders page through one writer", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    const tool = (name: string, args: Record<string, unknown>, id: string) =>
      context.reminderTools.run({
        runId: createRunId("run-reminder-tool"),
        toolCallId: id,
        capabilityRef: `reminder.${name}`,
        capabilityHandleRef: null,
        arguments: args,
        dataClassification: "private",
        context: { threadId: THREAD_ID },
      } as never) as Promise<Record<string, unknown>>;
    await context.protect("payload-page", "给妈妈打电话");
    await expect(
      command(
        context.control,
        "memory.reminder.create",
        { contentRef: "payload-page", due: "2026-10-26", repeat: "none" },
        "page-early",
      ),
    ).rejects.toThrow("REMINDER_MEMORY_NOT_READY");
    await context.capture.start(context.request);
    await context.capture.stop();
    const reminders = context.repository.memoryReminders();
    const upcoming = async () =>
      (await overview(context.control)).upcoming.map(({ text, dueAt }) => ({ text, dueAt }));
    expect(await upcoming()).toEqual([]);

    const created = await tool(
      "set",
      { text: "周五下午三点交周报", due: "2026-10-30T15:00", repeat: "none" },
      "call-1",
    );
    expect(created).toMatchObject({ created: true, due: "2026-10-30 15:00（Asia/Shanghai）" });
    expect(await upcoming()).toEqual([
      { text: "周五下午三点交周报", dueAt: "2026-10-30T07:00:00.000Z" },
    ]);
    expect(await reminders.read(created["reminderId"] as string)).toMatchObject({
      remindAt: "2026-10-30T06:00:00.000Z",
      status: "scheduled",
    });

    await expect(
      tool("set", { text: "昨天的会", due: "2026-10-20T09:00" }, "call-past"),
    ).rejects.toMatchObject({ code: "REMINDER_TIME_INVALID" });
    await expect(
      tool("set", { text: "太远的事", due: "2031-01-01T09:00" }, "call-far"),
    ).rejects.toMatchObject({ code: "REMINDER_TIME_INVALID" });
    await expect(
      tool("set", { text: "字".repeat(501), due: "2026-10-30T09:00" }, "call-long"),
    ).rejects.toMatchObject({ code: "REMINDER_TEXT_REFUSED" });
    await expect(
      tool("set", { text: "多余字段", due: "2026-10-30T09:00", extra: 1 }, "call-extra"),
    ).rejects.toMatchObject({ code: "REMINDER_INPUT_INVALID" });
    expect(await upcoming()).toHaveLength(1);

    await command(
      context.control,
      "memory.reminder.create",
      { contentRef: "payload-page", due: "2026-10-26", repeat: "none" },
      "page-1",
    );
    const replay = await command(
      context.control,
      "memory.reminder.create",
      { contentRef: "payload-page", due: "2026-10-26", repeat: "none" },
      "page-1",
    );
    expect(replay).toMatchObject({ replayed: true });
    expect(await upcoming()).toEqual([
      { text: "给妈妈打电话", dueAt: "2026-10-26T01:00:00.000Z" },
      { text: "周五下午三点交周报", dueAt: "2026-10-30T07:00:00.000Z" },
    ]);
    await expect(
      command(
        context.control,
        "memory.reminder.create",
        { contentRef: "payload-page", due: "2026-10-01", repeat: "none" },
        "page-past",
      ),
    ).rejects.toThrow("REMINDER_TIME_INVALID");

    const listed = (await tool("list", {}, "call-list")) as {
      reminders: { reminderId: string; text: string }[];
    };
    expect(listed).not.toHaveProperty("more");
    expect(listed.reminders.map(({ text }) => text)).toEqual([
      "给妈妈打电话",
      "周五下午三点交周报",
    ]);
    const target = listed.reminders[0]?.reminderId ?? "";
    expect(await tool("cancel", { reminderId: target }, "call-cancel")).toMatchObject({
      cancelled: true,
    });
    expect(await context.repository.memoryReminders().read(target)).toMatchObject({
      status: "cancelled",
    });
    expect(await upcoming()).toEqual([
      { text: "周五下午三点交周报", dueAt: "2026-10-30T07:00:00.000Z" },
    ]);
    expect(await tool("cancel", { reminderId: target }, "call-again")).toMatchObject({
      cancelled: true,
    });
    await expect(
      tool("cancel", { reminderId: "reminder:missing" }, "call-missing"),
    ).rejects.toMatchObject({ code: "REMINDER_NOT_FOUND" });
    expect(
      await tool(
        "set",
        { text: "我的卡号是 6222020200112233445", due: "2026-10-30T09:00" },
        "call-card",
      ),
    ).toMatchObject({ created: true });
    expect(await upcoming()).toEqual([
      { text: "我的卡号是 6222020200112233445", dueAt: "2026-10-30T01:00:00.000Z" },
      { text: "周五下午三点交周报", dueAt: "2026-10-30T07:00:00.000Z" },
    ]);
    const other = listed.reminders[1]?.reminderId ?? "";
    const store = context.repository.memoryReminders();
    const scheduled = await store.read(other);
    const dismissedNow = await store.update({
      id: other,
      expectedUpdatedAt: scheduled?.updatedAt ?? "",
      status: "dismissed",
      dueAt: scheduled?.dueAt ?? "",
      remindAt: scheduled?.remindAt ?? "",
      dismissedAt: "2026-10-30T06:30:00.000Z",
      updatedAt: "2026-10-30T06:30:00.000Z",
    });
    expect(dismissedNow).toBeTruthy();
    expect(await store.read(other)).toMatchObject({ status: "dismissed" });
    await tool("cancel", { reminderId: other }, "call-after-dismiss");
    expect(await store.read(other)).toMatchObject({ status: "cancelled" });
    const stored = await context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    const cardMemory = stored.find(({ id }) => id.includes("call-card"));
    expect(cardMemory?.dataClassification).toBe("sensitive");
    expect(
      stored
        .filter(({ id }) => !id.includes("call-card"))
        .every(({ dataClassification }) => dataClassification === "private"),
    ).toBe(true);
    expect(
      await tool(
        "set",
        { text: "到点把 Wi-Fi 密码是 abc12345 告诉访客", due: "2026-10-30T10:00" },
        "call-password",
      ),
    ).toMatchObject({ created: true });
    const withPassword = await context.repository
      .productMemoryState()
      .listActive(OWNER_ID, AGENT_ID);
    expect(withPassword.find(({ id }) => id.includes("call-password"))?.dataClassification).toBe(
      "sensitive",
    );
  });

  it("tells the model when the reminder list is cut off and why a brand-new account cannot set one", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    const call = (name: string, args: Record<string, unknown>, id: string) =>
      context.reminderTools.run({
        runId: createRunId("run-reminder-more"),
        toolCallId: id,
        capabilityRef: `reminder.${name}`,
        capabilityHandleRef: null,
        arguments: args,
        dataClassification: "private",
        context: { threadId: THREAD_ID },
      } as never) as Promise<{ reminders?: unknown[]; more?: boolean }>;
    await expect(
      call("set", { text: "还没有记忆", due: "2026-10-30T09:00" }, "early"),
    ).rejects.toMatchObject({ code: "REMINDER_MEMORY_NOT_READY" });
    await context.capture.start(context.request);
    await context.capture.stop();
    for (let index = 0; index < 21; index += 1)
      await call(
        "set",
        { text: `事项${index}`, due: `2026-11-${10 + (index % 9)}T09:${10 + index}` },
        `many-${index}`,
      );
    const listed = await call("list", {}, "list-many");
    expect(listed.reminders).toHaveLength(20);
    expect(listed.more).toBe(true);
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
      status: "cancelled",
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

  it("[MP-3] adds a Memory the Owner types in once one was learned and stores a card number as typed", async () => {
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
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-card", category: "finance", subCategory: null, pinned: false },
      "manual-2",
    );
    expect(
      (await overview(context.control)).memories.some(({ text }) =>
        text.includes("6222020200112233445"),
      ),
    ).toBe(true);
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
    const dated = (text: string) =>
      expect.stringMatching(new RegExp(`^${text}（记于 2026-10-25）$`, "u"));
    expect(profiled()).toEqual([dated("我每天必须喝咖啡"), dated("主人最喜欢的颜色是蓝色")]);
    expect(view.profileUsage).toEqual({
      used: profiled().reduce((sum, text) => sum + text.length + 3, 0),
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
    expect(profiled()).toEqual([dated("我每天必须喝咖啡")]);
    expect(view.profileUsage.used).toBe(profiled().reduce((sum, text) => sum + text.length + 3, 0));
    expect(view.lastViewedAt).toBeNull();
    await command(context.control, "memory.page.viewed", {}, "viewed-1");
    expect((await overview(context.control)).lastViewedAt).toBe(context.clock.value);
  });

  it("[MEM-PIN][RULE-memory-visible] pins by category, so a sensitive relationship memory can be pinned but health cannot", async () => {
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
    await context.protect("payload-sister", "主人的妹妹在大阪做护士", "sensitive");
    await command(
      context.control,
      "memory.create",
      {
        contentRef: "payload-sister",
        category: "relationship",
        subCategory: null,
        pinned: false,
      },
      "manual-sister",
    );
    const sister = (await overview(context.control)).memories.find(({ text }) =>
      text.includes("妹妹"),
    );
    if (!sister) throw new Error("missing sister");
    await command(
      context.control,
      "memory.mutate",
      {
        memoryId: sister.memoryId,
        action: "pin",
        expectedRevision: sister.revision,
        contentRef: null,
      },
      "pin-sister",
    );
    expect(
      (await overview(context.control)).memories.find(({ text }) => text.includes("妹妹"))
        ?.profilePin,
    ).toBe("on");
  });

  it("[MEM-CAT] moves a memory to another topic and keeps everything else", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-coffee", "我每天必须喝咖啡");
    await context.protect("payload-mood", "主人最近有点抑郁", "sensitive");
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-coffee", category: "identity", subCategory: "饮食", pinned: true },
      "manual-coffee",
    );
    await command(
      context.control,
      "memory.create",
      { contentRef: "payload-mood", category: "health", subCategory: null, pinned: false },
      "manual-mood",
    );
    const find = async (needle: string) => {
      const found = (await overview(context.control)).memories.find(({ text }) =>
        text.includes(needle),
      );
      if (!found) throw new Error(`missing ${needle}`);
      return found;
    };
    const before = await find("咖啡");
    expect(before.category).toBe("identity");
    await command(
      context.control,
      "memory.category.set",
      { memoryId: before.memoryId, expectedRevision: before.revision, category: "preference" },
      "recategorize-coffee",
    );
    const after = await find("咖啡");
    expect(after).toMatchObject({
      category: "preference",
      subCategory: "饮食",
      text: before.text,
      sourceThreadId: before.sourceThreadId,
      sourceRefs: before.sourceRefs,
      inference: before.inference,
      importance: before.importance,
      dataClassification: before.dataClassification,
      profilePin: "on",
      status: "active",
      recordedAt: before.recordedAt,
      revision: before.revision + 1,
    });
    await expect(
      command(
        context.control,
        "memory.category.set",
        { memoryId: before.memoryId, expectedRevision: before.revision, category: "goal" },
        "recategorize-stale",
      ),
    ).rejects.toThrow("MEMORY_REVISION_CHANGED");
    await expect(
      command(
        context.control,
        "memory.category.set",
        { memoryId: after.memoryId, expectedRevision: after.revision, category: "finance" },
        "recategorize-finance",
      ),
    ).rejects.toThrow("MEMORY_CATEGORY_LOCKED");
    const mood = await find("抑郁");
    await expect(
      command(
        context.control,
        "memory.category.set",
        { memoryId: mood.memoryId, expectedRevision: mood.revision, category: "other" },
        "recategorize-mood",
      ),
    ).rejects.toThrow("MEMORY_CATEGORY_LOCKED");
    expect((await find("抑郁")).category).toBe("health");
    await context.memory.runProjectionBatch(10);
    expect(
      context.provider.upserts.filter(({ memory }) => memory.id === after.memoryId).at(-1),
    ).toMatchObject({
      content: "我每天必须喝咖啡",
      memory: { attributes: { category: "preference" } },
    });
    const profiled = async () =>
      (await overview(context.control)).profile.flatMap(({ lines }) =>
        lines.map(({ text }) => text),
      );
    const coffee = (lines: readonly string[]) =>
      lines.some((text) => text.startsWith("我每天必须喝咖啡（记于 "));
    expect(coffee(await profiled())).toBe(true);
    const preference = await find("咖啡");
    await command(
      context.control,
      "memory.category.set",
      { memoryId: preference.memoryId, expectedRevision: preference.revision, category: "event" },
      "recategorize-event",
    );
    expect(coffee(await profiled())).toBe(false);
    const eventMemory = await find("咖啡");
    expect(eventMemory).toMatchObject({ category: "event", profilePin: "on" });
    await command(
      context.control,
      "memory.category.set",
      { memoryId: eventMemory.memoryId, expectedRevision: eventMemory.revision, category: "rule" },
      "recategorize-rule",
    );
    const sections = (await overview(context.control)).profile
      .filter(({ lines }) => lines.some(({ text }) => text === "我每天必须喝咖啡"))
      .map(({ kind }) => kind);
    expect(sections).toEqual(["rules"]);
    const ruleMemory = await find("咖啡");
    expect(ruleMemory.category).toBe("rule");
    await command(
      context.control,
      "memory.category.set",
      { memoryId: ruleMemory.memoryId, expectedRevision: ruleMemory.revision, category: "event" },
      "recategorize-event-again",
    );
    const eventAgain = await find("咖啡");
    await command(
      context.control,
      "memory.mutate",
      {
        memoryId: eventAgain.memoryId,
        action: "delete",
        expectedRevision: eventAgain.revision,
        contentRef: null,
      },
      "trash-coffee",
    );
    const trashed = await find("咖啡");
    expect(trashed.status).toBe("trashed");
    await expect(
      command(
        context.control,
        "memory.category.set",
        { memoryId: trashed.memoryId, expectedRevision: trashed.revision, category: "goal" },
        "recategorize-trashed",
      ),
    ).rejects.toThrow("cannot be revised from trashed");
    expect((await find("咖啡")).category).toBe("event");
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

  it("[P1-1] points a captured memory at the Owner's message and says nothing for imported, hand-written or orphaned ones", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-import-1", "回答一律用简体中文");
    await command(
      context.control,
      "memory.import.commit",
      {
        batchId: "memory-import-codex-2",
        source: "codex",
        items: [{ contentRef: "payload-import-1", category: "rule", subCategory: null }],
      },
      "import-p11",
    );
    const sourceOf = async () =>
      Object.fromEntries(
        (await overview(context.control)).memories.map((item) => [
          item.importBatchId ? "imported" : "captured",
          item.sourceMessageId,
        ]),
      );
    expect(await sourceOf()).toEqual({ captured: "message-1", imported: null });
    context.sql((database) =>
      database.prepare("DELETE FROM thread_messages WHERE thread_id = ?").run(THREAD_ID),
    );
    expect(await sourceOf()).toEqual({ captured: null, imported: null });
  });

  it("[P1-1] only an Owner's committed message in a live conversation counts, the earliest wins, and many references are searched in batches", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const memoryId = (await overview(context.control)).memories[0]?.memoryId as string;
    const sourceOf = async () =>
      (await overview(context.control)).memories.find((item) => item.memoryId === memoryId)
        ?.sourceMessageId;
    const setReferences = (...refs: string[]) =>
      context.sql((database) => {
        database.prepare("DELETE FROM memory_provenance WHERE memory_id = ?").run(memoryId);
        for (const ref of refs)
          database
            .prepare(
              `INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted)
              VALUES (?, 'reference', ?, 0)`,
            )
            .run(memoryId, ref);
      });
    expect(await sourceOf()).toBe("message-1");
    const agentRef = await context.turn("agent", "好的，记下了", null);
    const laterOwnerRef = await context.turn("owner", "我再说一遍，我最喜欢蓝色", null);
    setReferences(agentRef);
    expect(await sourceOf()).toBeNull();
    await context.protect("payload-shared", "共用的一句话");
    context.sql((database) => {
      database
        .prepare(
          `INSERT INTO thread_messages (
            id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
            classification, committed_at
          ) VALUES ('message-agent-shared', ?, ?, ?, 0, 90, 'agent', ?, 'private', ?)`,
        )
        .run(OWNER_ID, AGENT_ID, THREAD_ID, "payload-shared", T0);
      database
        .prepare(
          `INSERT INTO thread_messages (
            id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
            classification, committed_at
          ) VALUES ('message-owner-shared', ?, ?, ?, 0, 91, 'owner', ?, 'private', ?)`,
        )
        .run(OWNER_ID, AGENT_ID, THREAD_ID, "payload-shared", T0);
    });
    setReferences("payload-shared");
    expect(await sourceOf()).toBe("message-owner-shared");
    context.sql((database) =>
      database.prepare("DELETE FROM thread_messages WHERE id = 'message-owner-shared'").run(),
    );
    expect(await sourceOf()).toBeNull();
    setReferences(laterOwnerRef, "payload-owner-1");
    expect(await sourceOf()).toBe("message-1");
    setReferences(laterOwnerRef);
    expect(await sourceOf()).toBe("message-3");
    setReferences(
      ...Array.from({ length: 450 }, (_, index) => `unmatched-${String(index).padStart(3, "0")}`),
      "payload-owner-1",
    );
    expect(await sourceOf()).toBe("message-1");
    context.sql((database) =>
      database.prepare("UPDATE thread_messages SET message_status = 'partial'").run(),
    );
    expect(await sourceOf()).toBeNull();
    context.sql((database) =>
      database.prepare("UPDATE thread_messages SET message_status = 'committed'").run(),
    );
    expect(await sourceOf()).toBe("message-1");
    for (const status of ["trashed", "deletion_pending", "deleted_verified"]) {
      context.sql((database) =>
        database.prepare("UPDATE threads SET status = ? WHERE id = ?").run(status, THREAD_ID),
      );
      expect(await sourceOf(), status).toBeNull();
    }
  });

  it("[P1-1] a reference longer than the limit is neither listed nor used to find the message", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const memoryId = (await overview(context.control)).memories[0]?.memoryId as string;
    const longRef = `payload-${"x".repeat(MEMORY_SOURCE_REF_MAX_LENGTH)}`;
    const exactRef = `payload-${"y".repeat(MEMORY_SOURCE_REF_MAX_LENGTH - "payload-".length)}`;
    await context.protect(longRef, "超长引用的句子");
    await context.protect(exactRef, "刚好满限制的句子");
    context.sql((database) => {
      for (const [id, sequence, ref] of [
        ["message-long", 70, longRef],
        ["message-exact", 71, exactRef],
      ] as const)
        database
          .prepare(
            `INSERT INTO thread_messages (
              id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
              classification, committed_at
            ) VALUES (?, ?, ?, ?, 0, ?, 'owner', ?, 'private', ?)`,
          )
          .run(id, OWNER_ID, AGENT_ID, THREAD_ID, sequence, ref, T0);
      database.prepare("DELETE FROM memory_provenance WHERE memory_id = ?").run(memoryId);
      for (const ref of [longRef, exactRef])
        database
          .prepare(
            `INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted)
            VALUES (?, 'reference', ?, 0)`,
          )
          .run(memoryId, ref);
    });
    const [memory] = (await overview(context.control)).memories;
    expect(memory?.sourceRefs).toEqual([exactRef]);
    expect(memory?.sourceMessageId).toBe("message-exact");
    context.sql((database) =>
      database.prepare("DELETE FROM thread_messages WHERE id = 'message-exact'").run(),
    );
    expect((await overview(context.control)).memories[0]?.sourceMessageId).toBeNull();
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

  it("[MP-7] keeps an imported password line as sensitive and keeps its original text", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-import-pwd", "pwd: hunter2abc", "sensitive");
    await command(
      context.control,
      "memory.import.commit",
      {
        batchId: "memory-import-sensitive-1",
        source: "assistant",
        items: [{ contentRef: "payload-import-pwd", category: "other", subCategory: null }],
      },
      "import-sensitive-1",
    );
    const imported = await overview(context.control);
    expect(
      imported.memories
        .filter(({ importBatchId }) => importBatchId === "memory-import-sensitive-1")
        .map(({ dataClassification }) => dataClassification),
    ).toEqual(["sensitive"]);
  });
});
