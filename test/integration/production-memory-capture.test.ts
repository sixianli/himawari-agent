import { ProductionProposalControl } from "../../apps/agent-service/src/production-proposal-control.ts";
import { ProductionProposalBox } from "../../apps/agent-service/src/production-proposals.ts";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  IMPORT_DUPLICATE_DEFAULTS,
  type ImportDuplicateAnswer,
  type MemoryExtractionAuditRecord,
  type MemoryProviderProjectionPort,
  OwnerProfileService,
  type ProactiveModelInvoker,
  type ProductMemoryRecord,
  RuleReviewService,
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
} from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  MEMORY_SOURCE_REF_MAX_LENGTH,
  memorySourceState,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextExternalContent,
  externalContentKey,
  runExternalOrigins,
} from "../../apps/agent-service/src/context-external-content.ts";
import {
  type MemoryCaptureCall,
  memoryCapturePrompt,
  ProductionMemoryCapture,
  parseMemoryCandidates,
} from "../../apps/agent-service/src/production-memory-capture.ts";
import { ProductionMemoryClassifier } from "../../apps/agent-service/src/production-memory-classification.ts";
import { ProductionImportDuplicateChecker } from "../../apps/agent-service/src/production-memory-import-duplicates.ts";
import { ProductionMemoryControl } from "../../apps/agent-service/src/production-memory-control.ts";
import {
  isStandingQuote,
  ProductionOwnerRuleTools,
  ProductionOwnerRuleWriter,
} from "../../apps/agent-service/src/production-owner-rules.ts";
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
    const calls: MemoryCaptureCall[] = [];
    const outputs: (string | Error)[] = [output];
    const relevant: string[] = [];
    const externalMarks = new Map<string, readonly string[]>();
    const externalContent = new ContextExternalContent({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      state: {
        readScopedState: async (_owner, _agent, key) => {
          const origins = externalMarks.get(key);
          return origins
            ? ({
                revision: 1,
                value: {
                  sources: origins.map((origin) => ({
                    origin,
                    firstRunId: "run-earlier",
                    firstSeenAt: T0,
                  })),
                },
              } as never)
            : undefined;
        },
        commitStateAndEvents: async () => {
          throw new Error("marks are seeded directly in this test");
        },
      },
      source: { read: (runId) => runSources.read(runId) },
      authority: () => {
        throw new Error("marks are seeded directly in this test");
      },
      clock: { now: () => T0 },
    });
    const runSources: RunExecutionSourcePort = {
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
    };
    const capture = new ProductionMemoryCapture({
      sources: runSources,
      threads: {
        listMessages: async (_owner, _agent, _thread, afterSequence, limit) =>
          messages.filter(({ sequence }) => sequence > afterSequence).slice(0, limit),
        readCommittedMessagesByIds: async ({ messageIds }) =>
          messages.filter(({ id }) => messageIds.includes(id)),
      },
      generations: repository.threadDistillationState(),
      state: repository.productMemoryState(),
      relevantMemoryIds: () => relevant as never,
      externalOrigins: runExternalOrigins(externalContent),
      product: memory,
      approvals: repository.sensitiveMemoryApprovals(),
      reminders: repository.memoryReminders(),
      book: repository.memoryBook(),
      ledger: repository.decisionLedger(),
      backlog: repository.memoryCaptureBacklog(),
      unitOfWork: repository.unitOfWork(),
      timeZone: "Asia/Shanghai",
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => T0 },
      assertActive: async () => {},
      externalTag: async () => captureTag,
      generate: async (_request, prompt, onAdmitted, call) => {
        prompts.push(prompt);
        calls.push(call);
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
    const boxWith = (extra: Partial<ConstructorParameters<typeof ProductionProposalBox>[0]> = {}) =>
      new ProductionProposalBox({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        store: repository.ownerProposals(),
        payloads,
        protector: adapters.payloadProtector,
        clock: { now: () => clock.value },
        ...extra,
      });
    const ruleWriterWith = (
      extra: Partial<ConstructorParameters<typeof ProductionOwnerRuleWriter>[0]> & {
        readonly proposals?: ConstructorParameters<typeof ProductionProposalBox>[0]["store"];
        readonly proposalLimit?: number;
        readonly proposalTtlDays?: number;
        readonly box?: ProductionProposalBox;
      } = {},
    ) => {
      const { proposals, proposalLimit, proposalTtlDays, box: given, ...rest } = extra;
      return new ProductionOwnerRuleWriter({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        rules: repository.ownerRules(),
        box:
          given ??
          boxWith({
            ...(proposals ? { store: proposals } : {}),
            ...(rest.protector ? { protector: rest.protector } : {}),
            configuration: {
              ...(rest.configuration ?? { ownerId: OWNER_ID, agentId: AGENT_ID }),
              runPolicy: {
                ownerProposals: {
                  ...(proposalLimit === undefined ? {} : { pendingLimit: proposalLimit }),
                  ...(proposalTtlDays === undefined ? {} : { expiresAfterDays: proposalTtlDays }),
                },
              },
            },
          }),
        reviews: repository.ruleReviews(),
        memory,
        memories: repository.productMemoryState(),
        book: repository.memoryBook(),
        threads: repository.threadRepository(),
        payloads,
        protector: adapters.payloadProtector,
        clock: { now: () => clock.value },
        ...rest,
      });
    };
    const box = boxWith();
    const ruleWriter = new ProductionOwnerRuleWriter({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      rules: repository.ownerRules(),
      box,
      reviews: repository.ruleReviews(),
      memory,
      memories: repository.productMemoryState(),
      book: repository.memoryBook(),
      threads: repository.threadRepository(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
    });
    const actionRules = {
      list: vi.fn(async () => [
        {
          ruleId: "action_preauthorize_owner_data",
          revision: 1,
          outcome: "allow_preauthorized" as const,
          examplesHit: 2,
          examplesMiss: 6,
          askFirst: false,
        },
      ]),
      setAskFirst: vi.fn(async () => undefined),
    };
    const classifyOutputs: string[] = [];
    const classifyPrompts: string[] = [];
    const classifyFailures: unknown[] = [];
    const classifier = new ProductionMemoryClassifier({
      model: {
        estimateMicros: () => 10,
        generate: async ({ prompt }) => {
          classifyPrompts.push(prompt);
          const output = classifyOutputs.shift();
          if (output === undefined) throw new Error("MODEL_NOT_COMPLETED");
          return { output, costMicros: 10 };
        },
      },
      dailyLimitMicros: 1_000,
      batchCharacters: 6000,
      outputTokensPerItem: 60,
      timeZone: "Asia/Shanghai",
      now: () => clock.value,
      newId: () => "classify",
      onFailure: (error) => classifyFailures.push(error),
    });
    const duplicateAnswers: (ImportDuplicateAnswer | undefined)[] = [];
    const duplicateRequests: {
      existing: readonly { key: string; text: string }[];
      candidates: readonly { text: string }[];
    }[] = [];
    const duplicateSettings = { ...IMPORT_DUPLICATE_DEFAULTS };
    const importDuplicates = new ProductionImportDuplicateChecker({
      decision: {
        decide: async ({ existing, candidates }) => {
          duplicateRequests.push({ existing, candidates });
          return candidates.map(() => duplicateAnswers.shift());
        },
      },
      settings: duplicateSettings,
      onFailure: () => {},
    });
    const proposalControl = new ProductionProposalControl({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      box,
      clock: { now: () => clock.value },
    });
    const control = new ProductionMemoryControl({
      classifier,
      importDuplicates,
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      approvals: repository.sensitiveMemoryApprovals(),
      actionRules,
      unitOfWork: repository.unitOfWork(),
      memory,
      reminders: repository.memoryReminders(),
      ownerRules: ruleWriter,
      reviews: { memories: repository.memoryReviews(), rules: repository.ruleReviews() },
      ledger: repository.decisionLedger(),
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
      agentId: string = AGENT_ID,
    ) =>
      (agentId === AGENT_ID ? payloads : repository.payloadStore(OWNER_ID, agentId as never)).put(
        await adapters.payloadProtector.protect({
          ownerId: OWNER_ID,
          agentId: agentId as never,
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
      actionRules,
      markThread: (threadId: string, origins: readonly string[]) => {
        externalMarks.set(externalContentKey({ threadId, runId: "" }), origins);
      },
      reminderTools,
      ruleTools: new ProductionOwnerRuleTools(ruleWriter),
      ruleWriter,
      ruleWriterWith,
      box,
      boxWith,
      proposalControl,
      protector: adapters.payloadProtector,
      protect,
      request: requestFor("run-memory-capture"),
      requestFor,
      turn,
      outputs,
      relevant,
      audits,
      failures,
      prompts,
      calls,
      classifyOutputs,
      classifyPrompts,
      classifyFailures,
      duplicateAnswers,
      duplicateRequests,
      duplicateSettings,
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
      {
        contentRef: "payload-coffee",
        category: "preference",
        subCategory: null,
        topic: null,
        pinned: false,
      },
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
    const middle = (await gatewayOverview(context.control)).memories.find(
      ({ supersededBy }) => supersededBy === null,
    );
    if (!middle) throw new Error("middle");
    await round(
      "run-home-4",
      "我又搬到上海了",
      memoryOutput({
        decision: "supersede",
        existingMemoryId: middle.memoryId,
        text: "主人住在上海",
        quote: "我又搬到上海了",
      }),
    );
    expect(context.failures).toEqual([]);
    const view = await gatewayOverview(context.control);
    const replaced = view.memories.find(({ memoryId }) => memoryId === old.memoryId);
    const head = view.memories.find(({ supersededBy }) => supersededBy === null);
    if (!replaced || !head) throw new Error("chain");
    expect(replaced.supersededBy).toBe(middle.memoryId);
    expect(view.memories.find(({ memoryId }) => memoryId === middle.memoryId)?.supersededBy).toBe(
      head.memoryId,
    );
    const earliest = replaced.history[0];
    expect(earliest).toMatchObject({ kind: "created", text: "主人住在杭州" });
    if (!earliest) throw new Error("earliest");
    await expect(
      restoreVersion(
        context.control,
        middle.memoryId,
        view.memories.find(({ memoryId }) => memoryId === middle.memoryId)?.revision ?? 0,
        earliest.historyId,
        "restore-into-replaced",
      ),
    ).rejects.toThrow("MEMORY_VERSION_TARGET_NOT_CURRENT");
    const state = context.repository.productMemoryState();
    expect((await state.read(head.memoryId as never))?.confidencePermille).toBe(900);
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
      ["created", "主人住在上海"],
      ["restored", "主人住在杭州"],
    ]);
    expect(after.memories.find(({ memoryId }) => memoryId === old.memoryId)).toEqual(replaced);
    const record = await state.read(head.memoryId as never);
    const [own] = await state.listHistory({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memoryIds: [old.memoryId as never],
    });
    expect(record?.contentRef).toBe(own?.contentRef);
    expect(record).toMatchObject({ inference: false, confidencePermille: 1000 });
    await viaGateway(
      context.control,
      "memory.mutate",
      {
        ...{ memoryId: old.memoryId, action: "delete", contentRef: null, historyId: null },
        expectedRevision: replaced.revision,
      },
      "trash-old",
    );
    const restoredHead = await state.read(head.memoryId as never);
    await expect(
      restoreVersion(
        context.control,
        head.memoryId,
        restoredHead?.revision ?? 0,
        replaced.history[1]?.historyId ?? 0,
        "restore-trashed",
      ),
    ).rejects.toThrow("MEMORY_VERSION_NOT_FOUND");
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
    const options = (context.control as unknown as { options: { memory: DurableMemoryService } })
      .options;
    const real = options.memory;
    options.memory = Object.assign(Object.create(real), {
      restoreVersion: async () => {
        throw new Error("MEMORY_REVISION_CHANGED_DURING_SAVE");
      },
    });
    await expect(
      restoreVersion(
        context.control,
        memory.memoryId,
        memory.revision,
        older?.historyId ?? 0,
        "restore-public-lost",
      ),
    ).rejects.toThrow("MEMORY_REVISION_CHANGED_DURING_SAVE");
    options.memory = real;
    expect(
      await context.plaintext(
        `memory-version:${memory.memoryId}:${memory.revision}:${older?.historyId}`,
      ),
    ).toBeUndefined();
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
    await context.protect("payload-spaced", "主人住在杭州 ");
    context.sql((database) => {
      database
        .prepare(
          `INSERT INTO memory_history_events (memory_id, kind, content_ref, stance, occurred_at)
          VALUES (?, 'edited', 'payload-spaced', NULL, ?)`,
        )
        .run(memory.memoryId, T0);
    });
    const spaced = (await gatewayOverview(context.control)).memories[0]?.history.at(-1);
    await expect(
      restoreVersion(
        context.control,
        memory.memoryId,
        memory.revision,
        spaced?.historyId ?? 0,
        "restore-spaced",
      ),
    ).rejects.toThrow("MEMORY_VERSION_ALREADY_CURRENT");
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

  it("[P3-5] rolls a sensitive approval back completely when its last write fails, and lets the Owner approve it again", async () => {
    const context = await setup(
      "我月薪三万。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人月薪三万","classification":"sensitive","topic":"finance","confidence":950,"quote":"我月薪三万"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [pending] = (await overview(context.control)).pending;
    if (!pending) throw new Error("pending");
    const options = (
      context.control as unknown as {
        options: ConstructorParameters<typeof ProductionMemoryControl>[0];
      }
    ).options;
    const failing = new ProductionMemoryControl({
      ...options,
      approvals: {
        ...options.approvals,
        markCommitted: async () => {
          throw new Error("PORT_UNAVAILABLE");
        },
      },
    });
    await expect(respond(failing, pending.requestId, "approved")).rejects.toThrow(
      "PORT_UNAVAILABLE",
    );
    expect(await activeMemories(context)).toEqual([]);
    expect((await overview(context.control)).pending.map(({ requestId }) => requestId)).toEqual([
      pending.requestId,
    ]);
    await respond(context.control, pending.requestId, "approved");
    expect(await activeMemories(context)).toHaveLength(1);
    expect((await overview(context.control)).pending).toEqual([]);
  });

  it("[P3-5] sends no approval audit record when the approval's transaction is rolled back", async () => {
    const context = await setup(
      "我月薪三万。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人月薪三万","classification":"sensitive","topic":"finance","confidence":950,"quote":"我月薪三万"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const [pending] = (await overview(context.control)).pending;
    if (!pending) throw new Error("pending");
    const options = (
      context.control as unknown as {
        options: ConstructorParameters<typeof ProductionMemoryControl>[0];
      }
    ).options;
    const sent: MemoryExtractionAuditRecord[] = [];
    const rolledBack = new ProductionMemoryControl({
      ...options,
      onAudit: (record) => sent.push(record),
      unitOfWork: {
        run: (work) =>
          options.unitOfWork.run(async () => {
            await work();
            throw new Error("COMMIT_LOST");
          }),
      },
    });
    await expect(respond(rolledBack, pending.requestId, "approved")).rejects.toThrow("COMMIT_LOST");
    expect(sent).toEqual([]);
    expect(await activeMemories(context)).toEqual([]);
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
    const round = async (
      runId: string,
      ownerText: string,
      output: string,
      ...judge: readonly string[]
    ) => {
      await context.turn("owner", ownerText, runId);
      context.outputs.push(output, ...judge);
      const capture = new ProductionMemoryCapture(options);
      await capture.start(context.requestFor(runId));
      await capture.stop();
    };
    await round("run-pa2-2", "今天天气不错", unchanged("明治"));
    expect((await tentativeState()).attributes?.tentative).toBe(true);
    expect(context.audits.map(({ outcome }) => outcome)).toContain("evidence_unverified");
    const callsBefore = context.calls.length;
    await round(
      "run-pa2-unrelated",
      "明天下午三点开会",
      unchanged("明天下午三点开会"),
      '{"supports":false}',
    );
    expect(context.calls.length - callsBefore).toBe(2);
    expect((await tentativeState()).attributes?.tentative).toBe(true);
    await round(
      "run-pa2-judge-down",
      "我又买了明治的牛奶",
      unchanged("我又买了明治的牛奶"),
      "not json",
      "still not json",
    );
    expect((await tentativeState()).attributes?.tentative).toBe(true);
    expect(context.failures).toHaveLength(1);
    context.failures.length = 0;
    await round(
      "run-pa2-3",
      "我又买了明治的牛奶",
      unchanged("我又买了明治的牛奶"),
      '{"supports":true}',
    );
    expect((await tentativeState()).attributes?.tentative).not.toBe(true);
    expect(context.prompts.at(-1)).toContain("ownerQuote");
    const confirmed = (await context.ledgerEntries()).filter(
      ({ reasonCode }) => reasonCode === "tentative_confirmed",
    );
    expect(confirmed.map(({ outcome, category }) => [outcome, category])).toEqual([
      ["kept", created.attributes?.category],
    ]);
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
    context.outputs.push("好的，我记住了。");
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.failures).toHaveLength(2);
    expect(context.audits.map(({ outcome }) => outcome)).toEqual([
      "extraction_failed",
      "extraction_failed",
    ]);
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

  it("keeps reminder and memory ids within the gateway limit when the command key or tool call id is as long as allowed", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-long", "给妈妈打电话");
    const longKey = `page-${"k".repeat(123)}`;
    const page = { contentRef: "payload-long", due: "2026-10-26", repeat: "none" };
    const created = await command(context.control, "memory.reminder.create", page, longKey);
    const replay = await command(context.control, "memory.reminder.create", page, longKey);
    expect(replay).toEqual({ resultRef: created.resultRef, replayed: true });
    const other = await command(
      context.control,
      "memory.reminder.create",
      page,
      `page-${"k".repeat(122)}x`,
    );
    expect(other.resultRef).not.toBe(created.resultRef);
    const shortened = String(created.resultRef).slice("reminder:memory:reminder:owner:".length);
    expect(shortened).toMatch(/\.[0-9a-f]{64}$/u);
    const lookalike = await command(context.control, "memory.reminder.create", page, shortened);
    expect(lookalike.resultRef).not.toBe(created.resultRef);
    expect(String(lookalike.resultRef).length).toBeLessThanOrEqual(128);
    const tool = (await context.reminderTools.run({
      runId: createRunId(`run-${"r".repeat(120)}`),
      toolCallId: `call-${"c".repeat(120)}`,
      capabilityRef: "reminder.set",
      capabilityHandleRef: null,
      arguments: { text: "周五交周报", due: "2026-10-30T15:00", repeat: "none" },
      dataClassification: "private",
      context: { threadId: THREAD_ID },
    } as never)) as { reminderId: string };
    const snapshot = await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.overview.read",
      payload: {},
    } as never);
    const { idempotencyKey: _queryKey, ...message } = snapshot as unknown as Record<
      string,
      unknown
    >;
    const parsed = gatewayV2MessageSchema.parse(message);
    if (parsed.type !== "memory.overview.snapshot") throw new Error("snapshot");
    expect(parsed.payload.upcoming.map(({ reminderId }) => reminderId).sort()).toEqual(
      [created.resultRef, other.resultRef, lookalike.resultRef, tool.reminderId].sort(),
    );
    await context.control.execute({
      ...envelope,
      kind: "command",
      type: "memory.reminder.respond",
      payload: { reminderId: tool.reminderId, action: "cancel" },
    } as never);
    expect(await context.repository.memoryReminders().read(tool.reminderId)).toMatchObject({
      status: "cancelled",
    });
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

  it("[P2-3] keeps a standing sentence that carries a card number or a password as an enforced rule, its quote marked sensitive", async () => {
    const sentence = "尾号 6222 0212 3456 7890 的扣款邮件以后必须通知我";
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.turn("owner", sentence, null);
    const created = (await context.ruleTools.run({
      runId: createRunId("run-rule-card"),
      toolCallId: "call-card",
      capabilityRef: "rule.set",
      capabilityHandleRef: null,
      arguments: {
        quote: sentence,
        inferred: false,
        type: "mail_must_notify",
        summary: "银行扣款邮件一律提醒",
        params: { phrases: ["扣款"] },
      },
      dataClassification: "private",
      context: { threadId: THREAD_ID },
    } as never)) as Record<string, unknown>;
    expect(created).toMatchObject({ status: "active", type: "mail_must_notify" });
    const ruleMemory = await context.repository
      .productMemoryState()
      .read(created["memoryId"] as never);
    expect(ruleMemory).toMatchObject({ status: "active", dataClassification: "sensitive" });
    expect(await context.plaintext(ruleMemory?.contentRef ?? null)).toContain(sentence);
    const password = "网银密码是 Abc12345 的那个账户的邮件以后必须通知我";
    await context.turn("owner", password, null);
    const withPassword = (await context.ruleTools.run({
      runId: createRunId("run-rule-password"),
      toolCallId: "call-password",
      capabilityRef: "rule.set",
      capabilityHandleRef: null,
      arguments: {
        quote: password,
        inferred: false,
        type: "mail_must_notify",
        summary: "网银账户的邮件一律提醒",
        params: { phrases: ["网银"] },
      },
      dataClassification: "private",
      context: { threadId: THREAD_ID },
    } as never)) as Record<string, unknown>;
    expect(withPassword).toMatchObject({ status: "active", type: "mail_must_notify" });
    expect(
      await context.repository.productMemoryState().read(withPassword["memoryId"] as never),
    ).toMatchObject({ status: "active", dataClassification: "sensitive" });
  });

  it('[HR-4] turns "夜里别提醒我" into an enforced push_quiet_hours rule through the rule tool, and refuses periods that are not times', async () => {
    const sentence = "夜里别提醒我";
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.turn("owner", sentence, null);
    const set = (args: Record<string, unknown>, id: string) =>
      context.ruleTools.run({
        runId: createRunId("run-rule-tool"),
        toolCallId: id,
        capabilityRef: "rule.set",
        capabilityHandleRef: null,
        arguments: {
          inferred: false,
          type: "push_quiet_hours",
          summary: "夜里 23 点到早上 7 点，任务完成和邮件提醒等到早上再推",
          quote: sentence,
          ...args,
        },
        dataClassification: "private",
        context: { threadId: THREAD_ID },
      } as never) as Promise<Record<string, unknown>>;
    const night = { periods: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }] };
    const created = await set({ params: night }, "call-night");
    expect(created).toMatchObject({ status: "active", type: "push_quiet_hours", replayed: false });
    expect((created["trials"] as { hit: boolean }[]).some(({ hit }) => hit)).toBe(true);
    expect((created["trials"] as { hit: boolean }[]).some(({ hit }) => !hit)).toBe(true);
    const stored = await context.repository.ownerRules().read({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ruleId: created["ruleId"] as string,
    } as never);
    expect(stored).toMatchObject({ status: "active" });
    await expect(
      set({ params: { periods: [{ days: [0], start: "25:00", end: "07:00" }] } }, "call-bad-time"),
    ).rejects.toMatchObject({ code: "RULE_PARAMETERS_INVALID" });
    await expect(set({ params: { periods: [] } }, "call-no-period")).rejects.toMatchObject({
      code: "RULE_PARAMETERS_INVALID",
    });
  });

  it("[ADR-0257] marks a memory captured from a conversation that read outside content, and leaves it unmarked when only another conversation did", async () => {
    const output =
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}';
    const marked = await setup("请记住，我最喜欢的颜色是蓝色。", output);
    marked.markThread(THREAD_ID, ["web_fetch"]);
    await marked.capture.start(marked.request);
    await marked.capture.stop();
    const [captured] = await marked.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    expect(captured?.sourceRefs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^external-content:.*\|web_fetch$/u)]),
    );
    const plain = await setup("请记住，我最喜欢的颜色是蓝色。", output);
    plain.markThread("thread-elsewhere", ["web_fetch"]);
    await plain.capture.start(plain.request);
    await plain.capture.stop();
    const [unmarked] = await plain.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    expect(unmarked?.sourceRefs.some((ref) => ref.startsWith("external-content:"))).toBe(false);
  });

  it("[ADR-0257] marks a reminder and a rule written with external content in context, and keeps the reminder's source readable", async () => {
    const sentence = "以后扣款邮件必须通知我";
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.turn("owner", sentence, null);
    const invocation = (capabilityRef: string, toolCallId: string, args: unknown) =>
      ({
        runId: createRunId("run-external-marks"),
        toolCallId,
        capabilityRef,
        capabilityHandleRef: null,
        arguments: args,
        dataClassification: "private",
        context: { threadId: THREAD_ID },
      }) as never;
    const provenance = { externalOrigins: ["web_fetch", "execution_task_output"] };
    const reminder = (await context.reminderTools.run(
      invocation("reminder.set", "call-external", { text: "改会议", due: "2026-10-30T15:00" }),
      provenance,
    )) as Record<string, unknown>;
    const reminderMemory = await context.repository
      .productMemoryState()
      .read((reminder["reminderId"] as string).replace(/^reminder:/u, "") as never);
    expect(reminderMemory?.sourceRefs).toEqual([
      `external-content:${reminderMemory?.id}|execution_task_output`,
      `external-content:${reminderMemory?.id}|web_fetch`,
      expect.stringMatching(/^memory-content:reminder:/u),
    ]);
    expect(
      memorySourceState({
        memoryId: reminderMemory?.id ?? "",
        importBatchId: null,
        sourceThreadId: THREAD_ID,
        sourceMessageId: null,
        sourceRefs: reminderMemory?.sourceRefs ?? [],
        history: [],
      }),
    ).toBe("reminder");

    const rule = (await context.ruleTools.run(
      invocation("rule.set", "call-external-rule", {
        quote: sentence,
        inferred: false,
        type: "mail_must_notify",
        summary: "扣款邮件一律提醒",
        params: { phrases: ["扣款"] },
      }),
      provenance,
    )) as Record<string, unknown>;
    expect(rule).toMatchObject({ status: "active" });
    const stored = await context.repository.ownerRules().read({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ruleId: rule["ruleId"] as string,
    } as never);
    expect(stored?.source).toBe(
      `external-content:execution_task_output,web_fetch|chat:${THREAD_ID}`,
    );
    const ruleMemory = await context.repository
      .productMemoryState()
      .read(rule["memoryId"] as never);
    expect(ruleMemory?.sourceRefs).toContain(
      `external-content:${ruleMemory?.id}|execution_task_output`,
    );

    const plain = (await context.reminderTools.run(
      invocation("reminder.set", "call-plain", { text: "交周报", due: "2026-10-30T16:00" }),
    )) as Record<string, unknown>;
    const plainMemory = await context.repository
      .productMemoryState()
      .read((plain["reminderId"] as string).replace(/^reminder:/u, "") as never);
    expect(plainMemory?.sourceRefs).toEqual([expect.stringMatching(/^memory-content:reminder:/u)]);
  });

  it("[ADR-0257] shows the built-in action rules on the rule list and switches one through the rule command", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    const snapshot = await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.rules.read",
      payload: {},
    } as never);
    if (snapshot.type !== "memory.rules.snapshot") throw new Error("snapshot");
    const { idempotencyKey: _, ...parsable } = snapshot as Record<string, unknown>;
    gatewayV2MessageSchema.parse(parsable);
    expect(snapshot.payload.builtIn).toEqual([
      expect.objectContaining({ ruleId: "action_preauthorize_owner_data", askFirst: false }),
    ]);
    await command(
      context.control,
      "memory.rule.respond",
      { target: "action_preauthorize_owner_data", action: "ask_first" },
      "ask-first",
    );
    await command(
      context.control,
      "memory.rule.respond",
      { target: "action_preauthorize_owner_data", action: "allow_directly" },
      "allow-directly",
    );
    expect(context.actionRules.setAskFirst.mock.calls).toEqual([
      ["action_preauthorize_owner_data", true],
      ["action_preauthorize_owner_data", false],
    ]);
    await expect(
      command(
        context.control,
        "memory.rule.respond",
        { target: "action_preauthorize_owner_data", action: "future_action" },
        "unknown-action",
      ),
    ).rejects.toThrow("MEMORY_RULE_ACTION_UNSUPPORTED");
    expect(context.actionRules.setAskFirst).toHaveBeenCalledTimes(2);
  });

  it("[P2-3] turns the owner's standing sentence into an enforced rule, keeps inferred ones as proposals, and undoes one from the page", async () => {
    const sentence = "日本入管局相关的邮件以后必须通知我";
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.turn("owner", sentence, null);
    await context.turn("owner", "日本入管局相关的邮件\n以后必须通知我", null);
    const immigration = { senderDomains: ["isa.go.jp"], phrases: ["在留資格"] };
    const tool = (capabilityRef: string, args: Record<string, unknown>, id: string) =>
      context.ruleTools.run({
        runId: createRunId("run-rule-tool"),
        toolCallId: id,
        capabilityRef,
        capabilityHandleRef: null,
        arguments: args,
        dataClassification: "private",
        context: { threadId: THREAD_ID },
      } as never) as Promise<Record<string, unknown>>;
    const set = (args: Record<string, unknown>, id: string) =>
      tool(
        "rule.set",
        { inferred: false, type: "mail_must_notify", summary: "入管局的邮件一律提醒", ...args },
        id,
      );
    const listed = async () => {
      const snapshot = await context.control.query({
        ...envelope,
        kind: "query",
        type: "memory.rules.read",
        payload: {},
      } as never);
      if (snapshot.type !== "memory.rules.snapshot") throw new Error("snapshot");
      const { idempotencyKey: _, ...parsable } = snapshot as Record<string, unknown>;
      gatewayV2MessageSchema.parse(parsable);
      return snapshot.payload.rules;
    };

    const created = await set({ quote: sentence, params: immigration }, "call-1");
    expect(created).toMatchObject({ status: "active", type: "mail_must_notify", replayed: false });
    expect(created["ruleId"]).toMatch(/^owner:[0-9a-f]{24}$/u);
    expect((created["trials"] as unknown[]).length).toBeGreaterThanOrEqual(3);
    const detail = (await listed()).find(({ ruleId }) => ruleId === created["ruleId"]);
    expect(detail).toMatchObject({ quote: sentence, changes: 0, lastUsed: null });
    await context.repository.decisionLedger().append({
      id: "rule-review-1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      kind: "rule_review",
      decidedAt: "2026-11-11T09:00:00.000Z",
      outcome: "needs_review",
      reasonCode: "source_memory_changed",
      subjectRef: null,
      inputs: { memoryIds: [], ruleIds: [created["ruleId"]] },
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: 0,
    } as never);
    expect(
      (await listed()).find(({ ruleId }) => ruleId === created["ruleId"])?.lastUsed,
    ).toBeNull();
    const recordUse = (id: string, checkedAt: string) =>
      context.repository.proactive().record({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        decision: {
          id,
          scenario: "gmail",
          checkedAt,
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
          ruleIds: [`${created["ruleId"]}@1`],
          sourceIds: [],
          floorHits: {},
          memoryInjected: false,
          memoryIds: [],
          usedMemoryIds: [],
          tentativeMemoryIds: [],
          memoryByMail: {},
          memoryRecall: "off",
        },
        modelPayloads: [],
        processed: [],
        insights: [],
        repliedThreads: [],
        push: null,
        cursor: null,
      } as never);
    await recordUse("rule-used-1", "2026-11-11T08:00:00.000Z");
    expect((await listed()).find(({ ruleId }) => ruleId === created["ruleId"])?.lastUsed).toEqual({
      at: "2026-11-11T08:00:00.000Z",
      kind: "proactive",
      decisionId: "rule-used-1",
    });
    await recordUse("-1", "2026-11-11T10:00:00.000Z");
    expect(
      (await listed()).find(({ ruleId }) => ruleId === created["ruleId"])?.lastUsed,
    ).toBeNull();
    const ruleMemory = await context.repository
      .productMemoryState()
      .read(created["memoryId"] as never);
    expect(ruleMemory).toMatchObject({ status: "active", attributes: { category: "rule" } });
    expect(await context.plaintext(ruleMemory?.contentRef ?? null)).toContain(sentence);
    expect(await set({ quote: sentence, params: immigration }, "call-1")).toMatchObject({
      ruleId: created["ruleId"],
      replayed: true,
    });
    expect(await set({ quote: sentence, params: immigration }, "call-again")).toMatchObject({
      ruleId: created["ruleId"],
      replayed: true,
    });

    await context.turn("owner", "这封必须提醒我，别的不用", null);
    const proposals = new Set<unknown>();
    for (const [name, args] of [
      ["not said", { quote: "订阅相关的以后必须提醒我" }],
      ["fragment of a one-off sentence", { quote: "必须提醒我" }],
      ["whole one-off clause", { quote: "这封必须提醒我" }],
      ["no standing words", { quote: "入管局相关的邮件" }],
      ["inferred", { quote: sentence, inferred: true }],
    ] as const) {
      const proposed = await set(
        { ...args, params: { senderDomains: ["moj.go.jp"] } },
        `call-${name}`,
      );
      expect(proposed, name).toMatchObject({ status: "proposed", ruleId: null });
      expect(proposed["proposalId"], name).toMatch(/^rule-proposal:[0-9a-f]{32}$/u);
      proposals.add(proposed["proposalId"]);
    }
    expect(proposals.size).toBe(5);
    const again = await set(
      { quote: "必须提醒我", params: { senderDomains: ["moj.go.jp"] } },
      "call-fragment-again",
    );
    expect(proposals.has(again["proposalId"])).toBe(true);
    await expect(
      set({ quote: sentence, summary: "入管局\n一律提醒", params: immigration }, "call-newline"),
    ).rejects.toMatchObject({ code: "RULE_PARAMETERS_INVALID" });
    expect((await listed()).map(({ ruleId }) => ruleId)).toEqual([created["ruleId"]]);
    const proposal = await set(
      { quote: sentence, inferred: true, params: { phrases: ["在留カード"] } },
      "call-proposal",
    );
    await command(
      context.control,
      "memory.rule.respond",
      { target: proposal["proposalId"], action: "confirm" },
      "confirm-1",
    );
    expect(await listed()).toHaveLength(2);
    const confirmed = (await listed()).find(({ ruleId }) => ruleId !== created["ruleId"]);
    await command(
      context.control,
      "memory.rule.respond",
      { target: confirmed?.ruleId, action: "undo" },
      "undo-confirmed",
    );
    expect(await listed()).toHaveLength(1);
    await command(
      context.control,
      "memory.rule.respond",
      { target: proposal["proposalId"], action: "confirm" },
      "confirm-again",
    );
    expect((await listed()).find(({ ruleId }) => ruleId === confirmed?.ruleId)?.status).toBe(
      "active",
    );
    const revived = await context.repository.ownerRules().read({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ruleId: confirmed?.ruleId ?? "",
    } as never);
    expect(
      await context.repository.productMemoryState().read(revived?.sourceMemoryId as never),
    ).toMatchObject({ status: "active" });
    await context.memory.archive(
      revived?.sourceMemoryId as never,
      (await context.repository.memoryBook().latestGeneration({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
      } as never)) as never,
    );
    expect((await listed()).find(({ ruleId }) => ruleId === confirmed?.ruleId)?.status).toBe(
      "needs_review",
    );
    await command(
      context.control,
      "memory.rule.respond",
      { target: proposal["proposalId"], action: "confirm" },
      "confirm-needs-review",
    );
    expect((await listed()).find(({ ruleId }) => ruleId === confirmed?.ruleId)?.status).toBe(
      "active",
    );
    expect(
      await context.repository.productMemoryState().read(revived?.sourceMemoryId as never),
    ).toMatchObject({ status: "active" });

    const soft = await tool(
      "rule.set",
      { quote: sentence, inferred: false, type: "soft", summary: "提醒时语气简短" },
      "call-soft",
    );
    expect(soft).toMatchObject({ status: "soft", ruleId: null });
    await expect(
      tool(
        "rule.set",
        { quote: sentence, inferred: true, type: "soft", summary: "主人喜欢长篇回答" },
        "call-soft-inferred",
      ),
    ).rejects.toMatchObject({ code: "RULE_NOT_EXPLICIT" });
    expect(
      await context.repository.productMemoryState().read(soft["memoryId"] as never),
    ).toMatchObject({ attributes: { category: "preference" } });
    expect(await listed()).toHaveLength(2);

    await expect(
      set({ quote: sentence, type: "mail_unknown", params: immigration }, "call-unknown"),
    ).rejects.toMatchObject({ code: "RULE_TYPE_UNKNOWN" });
    await expect(
      set({ quote: sentence, params: { regex: [".*"] } }, "call-regex"),
    ).rejects.toMatchObject({ code: "RULE_PARAMETERS_INVALID" });

    const generation = await context.repository.memoryBook().latestGeneration({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
    } as never);
    await context.memory.archive(created["memoryId"] as never, generation as never);
    expect((await listed()).find(({ ruleId }) => ruleId === created["ruleId"])).toMatchObject({
      status: "needs_review",
      enforced: true,
    });
    await command(
      context.control,
      "memory.rule.respond",
      { target: created["ruleId"], action: "reconfirm" },
      "reconfirm-1",
    );
    expect((await listed()).find(({ ruleId }) => ruleId === created["ruleId"])?.status).toBe(
      "active",
    );
    expect(
      await context.repository.productMemoryState().read(created["memoryId"] as never),
    ).toMatchObject({ status: "active" });
    expect(isStandingQuote("从今天开始，以后每次收到入管局的邮件都必须提醒我")).toBe(true);
    expect(isStandingQuote("刚才那封必须提醒我")).toBe(false);
    expect(isStandingQuote("这封必须提醒我")).toBe(false);
    expect(isStandingQuote("这封先不用管，以后再说")).toBe(false);
    expect(isStandingQuote("夜里别提醒我")).toBe(true);
    expect(isStandingQuote("今晚别提醒我")).toBe(false);
    expect(isStandingQuote("这次别提醒我")).toBe(false);
    expect(isStandingQuote("提醒我")).toBe(false);
    expect(isStandingQuote("现在别提醒我")).toBe(false);
    expect(isStandingQuote("我在开会，一会别打扰我")).toBe(false);
    expect(isStandingQuote("今夜は通知しないで")).toBe(false);
    expect(isStandingQuote("do not disturb me right now")).toBe(false);
    expect(isStandingQuote("从现在起夜里别提醒我")).toBe(true);
    expect(isStandingQuote("晚上别提醒我")).toBe(true);
    expect(isStandingQuote("周末别打扰我")).toBe(true);
    expect(isStandingQuote("don't remind me at night")).toBe(true);
    expect(isStandingQuote("别提醒我")).toBe(false);
    expect(isStandingQuote("明天别提醒我")).toBe(false);
    expect(isStandingQuote("暂时别提醒我")).toBe(false);
    expect(isStandingQuote("先别提醒我")).toBe(false);
    expect(isStandingQuote("明天晚上别提醒我")).toBe(false);
    expect(isStandingQuote("don't remind me tomorrow")).toBe(false);
    expect(isStandingQuote("这个周末别提醒我")).toBe(false);
    expect(isStandingQuote("下周三晚上别提醒我")).toBe(false);
    expect(isStandingQuote("后天晚上别提醒我")).toBe(false);
    expect(isStandingQuote("昨晚别提醒我")).toBe(false);
    expect(isStandingQuote("这个月晚上别提醒我")).toBe(false);
    expect(isStandingQuote("明年夜里别提醒我")).toBe(false);
    expect(isStandingQuote("这个月，晚上别提醒我")).toBe(false);
    expect(isStandingQuote("下个月起，晚上别提醒我")).toBe(false);
    expect(isStandingQuote("今年先这样，以后夜里别提醒我")).toBe(false);
    expect(isStandingQuote("从今天开始，以后夜里别提醒我")).toBe(true);
    expect(isStandingQuote("本季度夜里别提醒我")).toBe(false);
    expect(isStandingQuote("don't remind me at night this month")).toBe(false);
    expect(isStandingQuote("don't remind me this weekend")).toBe(false);
    expect(isStandingQuote("don't remind me next week at night")).toBe(false);
    expect(isStandingQuote("今天先这样，以后再看")).toBe(false);
    expect(isStandingQuote("今天起每次都提醒我")).toBe(true);
    expect(isStandingQuote("From now on, always tell me about refunds")).toBe(true);
    expect(isStandingQuote("please pass the mustard")).toBe(false);
    expect(isStandingQuote("nevertheless send it")).toBe(false);
    expect(isStandingQuote("use must2fa for the login")).toBe(false);
    expect(isStandingQuote("check never_x logs")).toBe(false);

    await context.memory.archive(
      created["memoryId"] as never,
      (await context.repository.memoryBook().latestGeneration({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
      } as never)) as never,
    );
    expect((await listed()).find(({ ruleId }) => ruleId === created["ruleId"])?.status).toBe(
      "needs_review",
    );
    expect(
      await set(
        { quote: sentence, summary: "入管局来信要提醒", params: immigration },
        "call-same-params",
      ),
    ).toMatchObject({ status: "active", ruleId: created["ruleId"], replayed: true });
    expect((await listed()).find(({ ruleId }) => ruleId === created["ruleId"])?.status).toBe(
      "active",
    );
    expect(
      await context.repository.productMemoryState().read(created["memoryId"] as never),
    ).toMatchObject({ status: "active" });

    await command(
      context.control,
      "memory.rule.respond",
      { target: created["ruleId"], action: "undo" },
      "undo-1",
    );
    expect((await listed()).map(({ ruleId }) => ruleId)).not.toContain(created["ruleId"]);
    expect(
      await context.repository.productMemoryState().read(created["memoryId"] as never),
    ).toMatchObject({ status: "archived" });
    expect(
      (await tool("rule.list", {}, "call-list"))["rules"] as { ruleId: string }[],
    ).toHaveLength(1);
    const listedRules = (await tool("rule.list", {}, "call-list-shape"))["rules"] as Record<
      string,
      unknown
    >[];
    expect(Object.keys(listedRules[0] ?? {})).not.toEqual(expect.arrayContaining(["revision"]));
    expect(Object.keys(listedRules[0] ?? {})).not.toContain("sourceMemoryId");
    const multiline = await set(
      { quote: "日本入管局相关的邮件\n以后必须通知我", params: immigration },
      "call-multiline",
    );
    const multilineDetail = (await listed()).find(({ ruleId }) => ruleId === multiline["ruleId"]);
    expect(multilineDetail?.quote).toBe("日本入管局相关的邮件 以后必须通知我");
    await context.memory.delete(
      multiline["memoryId"] as never,
      (await context.repository.memoryBook().latestGeneration({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
      } as never)) as never,
    );
    const afterDelete = (await listed()).find(({ ruleId }) => ruleId === multiline["ruleId"]);
    expect(afterDelete).toMatchObject({ status: "needs_review", quote: null });
    const undone = (
      await tool("rule.undo", { ruleId: multiline["ruleId"] }, "call-undo-multiline")
    )["undone"] as Record<string, unknown>;
    expect(undone).toMatchObject({ ruleId: multiline["ruleId"], status: "retired" });
    expect(Object.keys(undone)).not.toContain("revision");
    expect(Object.keys(undone)).not.toContain("sourceMemoryId");
    await expect(
      command(
        context.control,
        "memory.rule.respond",
        { target: "owner:missing", action: "undo" },
        "undo-missing",
      ),
    ).rejects.toThrow("RULE_NOT_FOUND");

    await command(
      context.control,
      "memory.rule.respond",
      { target: confirmed?.ruleId, action: "undo" },
      "undo-confirmed-again",
    );
    await context.memory.delete(
      revived?.sourceMemoryId as never,
      (await context.repository.memoryBook().latestGeneration({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
      } as never)) as never,
    );
    await expect(
      command(
        context.control,
        "memory.rule.respond",
        { target: proposal["proposalId"], action: "confirm" },
        "confirm-after-delete",
      ),
    ).rejects.toThrow("RULE_UNAVAILABLE");
    expect(
      (await context.repository.productMemoryState().read(revived?.sourceMemoryId as never))
        ?.status,
    ).toBe("deletion_pending");
    expect(await listed()).toEqual([]);
  });

  describe("[A-1] rule proposals waiting for the owner", () => {
    const sentence = "日本入管局相关的邮件以后必须通知我";
    const proposalsQuery = async (context: Awaited<ReturnType<typeof setup>>) => {
      const snapshot = await context.proposalControl.query({
        ...envelope,
        kind: "query",
        type: "proposals.read",
        payload: {},
      } as never);
      if (snapshot.type !== "proposals.snapshot") throw new Error("snapshot");
      const { idempotencyKey: _key, ...wire } = snapshot as typeof snapshot & {
        idempotencyKey?: string;
      };
      gatewayV2MessageSchema.parse(wire);
      return {
        ...snapshot,
        payload: {
          ...snapshot.payload,
          proposals: snapshot.payload.proposals.map((item) => {
            const replay = item.evidence.find((entry) => entry.kind === "mail_replay");
            const figure = (name: string) =>
              replay?.figures.find((entry) => entry.name === name)?.value ?? 0;
            return {
              ...item,
              quote: item.evidence.find((entry) => entry.kind === "owner_words")?.text ?? null,
              trials: item.evidence.filter((entry) => entry.kind === "mail_trial"),
              replay: replay
                ? {
                    days: figure("days"),
                    mailsChecked: figure("mailsChecked"),
                    mailsHit: figure("mailsHit"),
                    changed: figure("changed"),
                    truncated: figure("truncated") === 1,
                  }
                : null,
            };
          }),
        },
      };
    };
    const shownVersion = (context: Awaited<ReturnType<typeof setup>>, proposalId: unknown) => {
      let row: { version: number; fingerprint: string } | undefined;
      context.sql((database) => {
        row = database
          .prepare("SELECT version, fingerprint FROM owner_proposals WHERE id = ?")
          .get(String(proposalId)) as typeof row;
      });
      return row ?? { version: 1, fingerprint: "0".repeat(64) };
    };
    const respond = async (
      context: Awaited<ReturnType<typeof setup>>,
      proposalId: unknown,
      action: string,
      key: string,
      seen = shownVersion(context, proposalId),
    ) =>
      context.proposalControl.execute(
        {} as never,
        {
          ...envelope,
          idempotencyKey: key,
          kind: "command",
          type: "proposal.respond",
          payload: {
            proposalId,
            action,
            expectedVersion: seen.version,
            fingerprint: seen.fingerprint,
            recentAuthenticationRef: null,
            fullReadToken: null,
          },
        } as never,
      );
    const counts = (context: Awaited<ReturnType<typeof setup>>) => {
      const found = { rules: 0, memories: 0 };
      context.sql((database) => {
        found.rules = (
          database.prepare("SELECT COUNT(*) AS n FROM rule_book_rules").get() as { n: number }
        ).n;
        found.memories = (
          database.prepare("SELECT COUNT(*) AS n FROM memory_records").get() as { n: number }
        ).n;
      });
      return found;
    };
    const prepared = async () => {
      const context = await setup(
        "请记住，我最喜欢的颜色是蓝色。",
        '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
      );
      await context.capture.start(context.request);
      await context.capture.stop();
      await context.turn("owner", sentence, null);
      await context.turn("owner", "入管局相关的邮件", null);
      const set = (args: Record<string, unknown>, id: string, writer = context.ruleTools) =>
        writer.run({
          runId: createRunId("run-proposal-tool"),
          toolCallId: id,
          capabilityRef: "rule.set",
          capabilityHandleRef: null,
          arguments: {
            inferred: false,
            type: "mail_must_notify",
            summary: "入管局的邮件一律提醒",
            ...args,
          },
          dataClassification: "private",
          context: { threadId: THREAD_ID },
        } as never) as Promise<Record<string, unknown>>;
      const inferred = (domain: string, id = `call-${domain}`) =>
        set({ quote: sentence, inferred: true, params: { senderDomains: [domain] } }, id);
      return { context, set, inferred };
    };

    it("lists a proposal with who it came from, its evidence and the limit, and adopts it into a rule that can be undone", async () => {
      const { context, set, inferred } = await prepared();
      const replay = {
        days: 30,
        mailsChecked: 12,
        mailsHit: 2,
        changed: 1,
        usefulChanged: [],
        headersOnly: 0,
        truncated: false,
      };
      const withReplay = new ProductionOwnerRuleTools(
        context.ruleWriterWith({ replay: async () => replay }),
      );
      expect((await proposalsQuery(context)).payload).toMatchObject({
        proposals: [],
        pendingCount: 0,
        limit: 20,
        expiresAfterDays: 30,
      });
      const guessed = await inferred("isa.go.jp");
      const said = await set(
        { quote: "入管局相关的邮件", params: { senderDomains: ["moj.go.jp"] } },
        "call-said",
        withReplay,
      );
      expect(guessed).toMatchObject({ status: "proposed" });
      expect(said).toMatchObject({ status: "proposed" });
      const first = await proposalsQuery(context);
      expect(first.payload.proposals.map((item) => item.proposalId).sort()).toEqual(
        [guessed["proposalId"], said["proposalId"]].sort(),
      );
      expect(first.payload).toMatchObject({ pendingCount: 2, limit: 20, expiresAfterDays: 30 });
      const byId = new Map(first.payload.proposals.map((item) => [item.proposalId, item]));
      expect(byId.get(guessed["proposalId"] as string)).toMatchObject({
        origin: "inferred",
        quote: sentence,
        replay: null,
        proposedAt: T0,
        expiresAt: "2026-11-24T12:00:00.000Z",
        refusedBefore: 0,
      });
      expect(byId.get(guessed["proposalId"] as string)?.trials.length).toBeGreaterThan(0);
      expect(byId.get(said["proposalId"] as string)).toMatchObject({
        origin: "owner_said",
        quote: "入管局相关的邮件",
        replay: { days: 30, mailsChecked: 12, mailsHit: 2, changed: 1, truncated: false },
      });
      const { generatedAt: _first, ...firstPayload } = first.payload;
      const { generatedAt: _second, ...secondPayload } = (await proposalsQuery(context)).payload;
      expect(JSON.stringify(secondPayload)).toBe(JSON.stringify(firstPayload));

      const before = counts(context);
      await respond(context, guessed["proposalId"], "adopt", "adopt-1");
      expect(counts(context)).toEqual({ rules: before.rules + 1, memories: before.memories + 1 });
      await respond(context, guessed["proposalId"], "adopt", "adopt-2");
      expect(counts(context)).toEqual({ rules: before.rules + 1, memories: before.memories + 1 });
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);
      const rule = (await context.ruleWriter.list())[0];
      expect(rule).toMatchObject({ status: "active", enforced: true });
      await command(
        context.control,
        "memory.rule.respond",
        { target: rule?.ruleId, action: "undo" },
        "undo-adopted",
      );
      expect(await context.ruleWriter.list()).toEqual([]);
    });

    it("refuses a proposal without writing a rule or a memory, and says so when it is adopted or refused again", async () => {
      const { context, inferred } = await prepared();
      const proposal = await inferred("isa.go.jp");
      const before = counts(context);
      await respond(context, proposal["proposalId"], "reject", "reject-1");
      expect(counts(context)).toEqual(before);
      expect(await context.ruleWriter.list()).toEqual([]);
      expect((await proposalsQuery(context)).payload.proposals).toEqual([]);
      await expect(
        respond(context, proposal["proposalId"], "adopt", "adopt-refused"),
      ).rejects.toThrow("PROPOSAL_REJECTED");
      expect(counts(context)).toEqual(before);
      await respond(context, proposal["proposalId"], "reject", "reject-2");
      await expect(
        respond(
          context,
          "rule-proposal:00000000000000000000000000000000",
          "reject",
          "reject-missing",
        ),
      ).rejects.toThrow("PROPOSAL_NOT_FOUND");
      await expect(
        command(
          context.control,
          "memory.rule.respond",
          { target: proposal["proposalId"], action: "forget" },
          "unknown-action",
        ),
      ).rejects.toThrow();
      expect(await context.ruleWriter.list()).toEqual([]);

      const again = await inferred("isa.go.jp", "call-again");
      expect(again["proposalId"]).toBe(proposal["proposalId"]);
      const listed = (await proposalsQuery(context)).payload;
      expect(listed.proposals).toMatchObject([
        { proposalId: proposal["proposalId"], refusedBefore: 1 },
      ]);
      await respond(context, proposal["proposalId"], "adopt", "adopt-after-again");
      await expect(
        respond(context, proposal["proposalId"], "reject", "reject-adopted"),
      ).rejects.toThrow("PROPOSAL_ACCEPTED");
    });

    it("lets only one of a simultaneous adopt and refuse win", async () => {
      const { context, inferred } = await prepared();
      for (const [index, domain] of [
        "a.example",
        "b.example",
        "c.example",
        "d.example",
      ].entries()) {
        const proposal = await inferred(domain);
        const outcomes = await Promise.allSettled([
          command(
            context.control,
            "memory.rule.respond",
            { target: proposal["proposalId"], action: "confirm" },
            `race-adopt-${index}`,
          ),
          respond(context, proposal["proposalId"], "reject", `race-reject-${index}`),
        ]);
        expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        const lost = outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult;
        expect(String(lost.reason)).toMatch(/PROPOSAL_ACCEPTED|RULE_PROPOSAL_REJECTED/u);
        const adopted = outcomes[0]?.status === "fulfilled";
        const active = (await context.ruleWriter.list()).length;
        expect(active).toBe(adopted ? 1 : 0);
        await context.ruleWriter
          .list()
          .then((rules) => Promise.all(rules.map((rule) => context.ruleWriter.undo(rule.ruleId))));
      }
    });

    it("keeps a proposal an outside agent made out of the list, and still lets it be adopted at once", async () => {
      const { context } = await prepared();
      const receipt = await context.ruleWriter.create({
        key: "mcp:outside-1",
        quote: "外部 agent「x」提议：入管局的邮件要提醒",
        inferred: true,
        type: "mail_must_notify",
        params: { senderDomains: ["isa.go.jp"] },
        summary: "入管局的邮件一律提醒",
        threadId: null,
        source: "mcp:x",
        listed: false,
      });
      expect(receipt).toMatchObject({ status: "proposed" });
      expect((await proposalsQuery(context)).payload.proposals).toEqual([]);
      expect(await context.ruleWriter.confirm(receipt.proposalId ?? "")).toMatchObject({
        status: "active",
      });
      await expect(context.box.reject(receipt.proposalId ?? "")).rejects.toMatchObject({
        code: "PROPOSAL_NOT_FOUND",
      });
    });

    it("shows the limit, refuses a proposal over it and expires a proposal after its days", async () => {
      const { context, set } = await prepared();
      const tight = context.boxWith({
        configuration: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runPolicy: { ownerProposals: { pendingLimit: 2, expiresAfterDays: 3 } },
        },
      });
      const small = new ProductionOwnerRuleTools(context.ruleWriterWith({ box: tight }));
      const shownByTight = await new ProductionProposalControl({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        box: tight,
        clock: { now: () => context.clock.value },
      }).query({ ...envelope, kind: "query", type: "proposals.read", payload: {} } as never);
      expect(shownByTight.payload).toMatchObject({ limit: 2, expiresAfterDays: 3 });
      const make = (domain: string) =>
        set(
          { quote: sentence, inferred: true, params: { senderDomains: [domain] } },
          `call-${domain}`,
          small,
        );
      const one = await make("one.example");
      await make("two.example");
      await expect(make("three.example")).rejects.toMatchObject({ code: "RULE_PROPOSALS_FULL" });
      await make("one.example");
      const full = (await proposalsQuery(context)).payload;
      expect(full.pendingCount).toBe(2);
      expect(full.limit).toBe(20);
      context.clock.value = new Date(Date.parse(T0) + 3 * 86_400_000).toISOString();
      expect((await proposalsQuery(context)).payload).toMatchObject({
        proposals: [],
        pendingCount: 0,
      });
      await expect(respond(context, one["proposalId"], "adopt", "adopt-expired")).rejects.toThrow(
        "PROPOSAL_EXPIRED",
      );
      await make("one.example");
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);
      for (const digit of ["a", "b"])
        await context.repository.ownerProposals().propose({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          proposalId: `next-step:${digit.repeat(32)}`,
          type: "other",
          summary: "上限调低之前就在的提议",
          effect: "上限调低之前就在的提议",
          origin: "inferred",
          threadId: null,
          sourceRef: null,
          sourceVersion: null,
          fingerprint: digit.repeat(64),
          evidenceRef: null,
          now: context.clock.value,
          expiresAt: new Date(Date.parse(context.clock.value) + 86_400_000).toISOString(),
          pendingLimit: 20,
        });
      const over = await tight.list();
      expect([over.proposals.length, over.pendingCount]).toEqual([3, 3]);
    });

    it("gives the same proposal id however the parameters are ordered, and shows no evidence for one stored without it", async () => {
      const { context, set } = await prepared();
      const one = await set(
        {
          quote: sentence,
          inferred: true,
          params: { senderDomains: ["isa.go.jp"], phrases: ["在留"] },
        },
        "call-order-1",
      );
      const two = await set(
        {
          quote: sentence,
          inferred: true,
          params: { phrases: ["在留"], senderDomains: ["isa.go.jp"] },
        },
        "call-order-2",
      );
      expect(two["proposalId"]).toBe(one["proposalId"]);
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);

      const oldRef = "rule-proposal:ffffffffffffffffffffffffffffffff";
      await context.protect(oldRef, JSON.stringify({ key: "k", type: "mail_must_notify" }));
      await context.repository.ownerProposals().propose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        proposalId: oldRef,
        type: "owner_rule",
        summary: "旧提议",
        effect: "旧提议",
        origin: "inferred",
        threadId: null,
        sourceRef: null,
        sourceVersion: null,
        fingerprint: "e".repeat(64),
        evidenceRef: oldRef,
        now: T0,
        expiresAt: "2026-11-24T12:00:00.000Z",
        pendingLimit: 20,
      } as never);
      const listed = (await proposalsQuery(context)).payload.proposals;
      expect(listed.find((item) => item.proposalId === oldRef)).toMatchObject({
        quote: null,
        trials: [],
        replay: null,
      });
    });

    it("rewrites the basis when a proposal comes back, and drops what it wrote when the list is full", async () => {
      const { context, set, inferred } = await prepared();
      const first = await inferred("a.example");
      await respond(context, first["proposalId"], "reject", "reject-a");
      const withReplay = new ProductionOwnerRuleTools(
        context.ruleWriterWith({
          replay: async () => ({
            days: 30,
            mailsChecked: 9,
            mailsHit: 1,
            changed: 0,
            usefulChanged: [],
            headersOnly: 0,
            truncated: false,
          }),
        }),
      );
      await set(
        { quote: sentence, inferred: true, params: { senderDomains: ["a.example"] } },
        "call-a-again",
        withReplay,
      );
      const back = (await proposalsQuery(context)).payload.proposals[0];
      expect(back).toMatchObject({ refusedBefore: 1, replay: { mailsChecked: 9 } });
      await set(
        { quote: sentence, inferred: true, params: { senderDomains: ["a.example"] } },
        "call-a-third",
      );
      expect((await proposalsQuery(context)).payload.proposals[0]?.replay).toBeNull();

      const small = new ProductionOwnerRuleTools(context.ruleWriterWith({ proposalLimit: 1 }));
      const refs = () => {
        const found: string[] = [];
        context.sql((database) => {
          for (const row of database
            .prepare("SELECT ref FROM payloads WHERE ref LIKE 'rule-proposal:%'")
            .all() as { ref: string }[])
            found.push(row.ref);
        });
        return found;
      };
      const before = refs();
      await expect(
        set(
          { quote: sentence, inferred: true, params: { senderDomains: ["z.example"] } },
          "call-z",
          small,
        ),
      ).rejects.toMatchObject({ code: "RULE_PROPOSALS_FULL" });
      expect(refs()).toEqual(before);
    });

    it("does not stack a waiting proposal on a rule that is already enforced, and puts the source back as the latest one", async () => {
      const { context, set, inferred } = await prepared();
      const proposal = await inferred("moj.go.jp");
      await respond(context, proposal["proposalId"], "adopt", "adopt-moj");
      const again = await inferred("moj.go.jp", "call-moj-again");
      expect(again).toMatchObject({ status: "active", replayed: true });
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      const rule = (await context.ruleWriter.list())[0];
      await context.ruleWriter.undo(rule?.ruleId ?? "");
      await inferred("moj.go.jp", "call-moj-after-undo");
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);

      const other = "入管局相关的邮件";
      const known = (await proposalsQuery(context)).payload.proposals.map(
        (item) => item.proposalId,
      );
      await set(
        { quote: other, inferred: true, params: { senderDomains: ["pending.example"] } },
        "call-pending-inferred",
      );
      const before = (await proposalsQuery(context)).payload.proposals.find(
        (item) => !known.includes(item.proposalId),
      );
      expect(before?.origin).toBe("inferred");
      expect(before).not.toBeUndefined();
      await set(
        { quote: other, inferred: false, params: { senderDomains: ["pending.example"] } },
        "call-pending-said",
      );
      const after = (await proposalsQuery(context)).payload.proposals.filter(
        (item) => item.proposalId === before?.proposalId,
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.origin).toBe("owner_said");
    });

    it("does not queue a proposal for a rule that is already enforced even when it is worded differently", async () => {
      const { context, set, inferred } = await prepared();
      const proposal = await inferred("same.example");
      await respond(context, proposal["proposalId"], "adopt", "adopt-same");
      const again = await set(
        {
          quote: "入管局相关的邮件",
          inferred: true,
          summary: "另一种说法",
          params: { senderDomains: ["same.example"] },
        },
        "call-same-reworded",
      );
      expect(again).toMatchObject({ status: "active" });
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
    });

    it("takes waiting proposals for the same rule off the list once that rule is enforced", async () => {
      const { context, set, inferred } = await prepared();
      const first = await inferred("twin.example");
      await set(
        {
          quote: "入管局相关的邮件",
          inferred: true,
          summary: "另一种说法",
          params: { senderDomains: ["twin.example"] },
        },
        "call-twin-reworded",
      );
      await inferred("apart.example");
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(3);
      await respond(context, first["proposalId"], "adopt", "adopt-twin");
      const left = (await proposalsQuery(context)).payload;
      expect(left.pendingCount).toBe(1);
      expect(await context.ruleWriter.list()).toHaveLength(1);
    });

    it("still adopts the proposal when tidying the other waiting proposals fails", async () => {
      const { context, inferred } = await prepared();
      const proposal = await inferred("tidy.example");
      const store = context.repository.ownerProposals();
      const writer = context.ruleWriterWith({
        proposals: {
          ...store,
          listPending: async () => {
            throw new Error("list failed");
          },
        },
      });
      const receipt = await writer.confirm(proposal["proposalId"] as string);
      expect(receipt.status).toBe("active");
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      const twin = await inferred("tidy-two.example");
      await context.ruleWriter.create({
        key: "tidy-two-reworded",
        quote: "入管局相关的邮件",
        inferred: true,
        type: "mail_must_notify",
        params: { senderDomains: ["tidy-two.example"] },
        summary: "另一种说法",
        threadId: THREAD_ID,
      });
      let decisions = 0;
      const second = context.ruleWriterWith({
        proposals: {
          ...store,
          decide: async (input) => {
            if (decisions++ > 0) throw new Error("decide failed");
            return store.decide(input);
          },
        },
      });
      expect((await second.confirm(twin["proposalId"] as string)).status).toBe("active");
      expect(decisions).toBe(2);
      await expect(context.box.reject(proposal["proposalId"] as string)).rejects.toMatchObject({
        code: "PROPOSAL_ACCEPTED",
      });
    });

    it("removes the basis of a refused or expired proposal, tidies a leftover card when the list is read, and shows only clean text", async () => {
      const { context, set, inferred } = await prepared();
      const stored = () => {
        const found: { ref: string | null; kept: number }[] = [];
        context.sql((database) => {
          for (const row of database
            .prepare(
              `SELECT evidence_ref AS ref,
                 (SELECT COUNT(*) FROM payloads WHERE payloads.ref = evidence_ref) AS kept
               FROM owner_proposals ORDER BY proposed_at, id`,
            )
            .all() as { ref: string | null; kept: number }[])
            found.push(row);
        });
        return found;
      };
      const payloadCount = () => {
        let count = 0;
        context.sql((database) => {
          count = (
            database
              .prepare("SELECT COUNT(*) AS n FROM payloads WHERE ref LIKE 'rule-proposal:%'")
              .get() as { n: number }
          ).n;
        });
        return count;
      };
      const refused = await inferred("refused.example");
      expect(stored()).toMatchObject([{ kept: 1 }]);
      await context.box.reject(refused["proposalId"] as string);
      expect(stored()).toEqual([{ ref: null, kept: 0 }]);
      expect(payloadCount()).toBe(0);

      await set(
        {
          quote: "入管局\u202e相关的邮件",
          inferred: true,
          params: { senderDomains: ["bidi.example"] },
        },
        "call-bidi",
      );
      const shown = (await proposalsQuery(context)).payload.proposals;
      expect(shown.map((item) => item.quote)).toEqual(["入管局相关的邮件"]);

      const broken = "rule-proposal:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      await context.protect(
        broken,
        JSON.stringify({
          evidence: [
            { kind: "owner_words", text: "原话", sources: "x", figures: [{ name: "n" }] },
            "junk",
            { text: "没有种类" },
          ],
          data: "not-a-rule",
        }),
      );
      await context.repository.ownerProposals().propose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        proposalId: broken,
        type: "owner_rule",
        summary: "坏依据",
        effect: "坏依据",
        origin: "inferred",
        threadId: null,
        sourceRef: null,
        sourceVersion: null,
        fingerprint: "e".repeat(64),
        evidenceRef: broken,
        now: T0,
        expiresAt: "2026-11-24T12:00:00.000Z",
        pendingLimit: 20,
      });
      expect(
        (await proposalsQuery(context)).payload.proposals.find(
          (item) => item.proposalId === broken,
        ),
      ).toMatchObject({
        quote: "原话",
        evidence: [{ kind: "owner_words", text: "原话", sources: [], figures: [] }],
      });

      const store = context.repository.ownerProposals();
      const first = await inferred("left.example");
      await set(
        {
          quote: "入管局相关的邮件",
          inferred: true,
          summary: "另一种说法",
          params: { senderDomains: ["left.example"] },
        },
        "call-left-reworded",
      );
      const untidy = context.ruleWriterWith({
        proposals: {
          ...store,
          listPending: async () => {
            throw new Error("list failed");
          },
        },
      });
      await untidy.confirm(first["proposalId"] as string);
      let waiting = 0;
      context.sql((database) => {
        waiting = (
          database
            .prepare("SELECT COUNT(*) AS n FROM owner_proposals WHERE status = 'pending'")
            .get() as { n: number }
        ).n;
      });
      expect(waiting).toBe(3);
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(2);

      expect(() => context.ruleWriterWith({ proposalLimit: 201 })).toThrow(RangeError);
      expect(() => context.ruleWriterWith({ proposalTtlDays: 0 })).toThrow(RangeError);
      expect(() => context.ruleWriterWith({ proposalTtlDays: 3651 })).toThrow(RangeError);
      await expect(
        store.propose({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          proposalId: broken,
          type: "owner_rule",
          summary: "坏依据",
          effect: "坏依据",
          origin: "inferred",
          threadId: null,
          sourceRef: null,
          sourceVersion: null,
          fingerprint: "e".repeat(64),
          evidenceRef: broken,
          now: T0,
          expiresAt: "2026-11-24T12:00:00.000Z",
          pendingLimit: 201,
        }),
      ).rejects.toThrow("limit is invalid");
      context.sql((database) => {
        database
          .prepare(
            "DELETE FROM payloads WHERE ref IN (SELECT evidence_ref FROM owner_proposals WHERE status = 'pending' AND summary = '入管局的邮件一律提醒')",
          )
          .run();
      });
      expect(payloadCount()).toBe(3);
      await set(
        {
          quote: "入管局\u202e相关的邮件",
          inferred: true,
          params: { senderDomains: ["bidi.example"] },
        },
        "call-bidi-repaired",
      );
      expect(stored().filter((row) => row.ref !== null && row.kept === 0)).toEqual([]);
      expect(payloadCount()).toBe(4);

      context.clock.value = new Date(Date.parse(T0) + 31 * 86_400_000).toISOString();
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      expect(stored().filter((row) => row.kept > 0)).toHaveLength(2);
      expect(stored().filter((row) => row.ref === null)).toHaveLength(3);
      expect(payloadCount()).toBe(2);
      await inferred("repeat.example");
      await inferred("repeat.example", "call-repeat-again");
      expect(payloadCount()).toBe(3);
    });

    it("holds a proposal that has nothing to do with mail or rules: listed with its basis, refusable, and not adoptable until something registers for its type", async () => {
      const { context } = await prepared();
      const proposalId = `next-step:${"7".repeat(32)}`;
      const propose = (
        data: unknown = { query: "新款手机" },
        source?: { ref: string; version: string | null },
      ) =>
        context.box.propose({
          ...(source ? { source } : {}),
          proposalId,
          type: "price_search",
          summary: "要不要我去查哪个平台的新款手机最便宜",
          effect: "采纳后我会去几个购物平台比价，把结果发给你",
          origin: "inferred",
          threadId: THREAD_ID,
          evidence: [
            {
              kind: "watched_video",
              text: "你看了一个讲新款手机的视频",
              sources: [
                { kind: "web_page", ref: "https://video.example/watch?v=1" },
                { kind: "thread", ref: THREAD_ID },
              ],
              figures: [{ name: "minutes", value: 14, definition: "这个视频你看了多少分钟" }],
            },
          ],
          data,
        });
      await propose();
      const listed = (await proposalsQuery(context)).payload;
      expect(listed.pendingCount).toBe(1);
      expect(listed.proposals[0]).toMatchObject({
        proposalId,
        type: "price_search",
        summary: "要不要我去查哪个平台的新款手机最便宜",
        effect: "采纳后我会去几个购物平台比价，把结果发给你",
        origin: "inferred",
        adoptable: false,
        evidence: [
          {
            kind: "watched_video",
            text: "你看了一个讲新款手机的视频",
            sources: [
              { kind: "web_page", ref: "https://video.example/watch?v=1" },
              { kind: "thread", ref: THREAD_ID },
            ],
            figures: [{ name: "minutes", value: 14, definition: "这个视频你看了多少分钟" }],
          },
        ],
      });
      const first = {
        version: listed.proposals[0]?.version,
        fingerprint: listed.proposals[0]?.fingerprint,
      };
      expect(first).toEqual({ version: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      await propose();
      expect((await proposalsQuery(context)).payload.proposals[0]).toMatchObject(first);
      await propose({ query: "新款手机 256GB" }, { ref: "video:1", version: "2026-11-12" });
      const changed = (await proposalsQuery(context)).payload.proposals[0];
      expect(changed?.version).toBe(2);
      expect(changed?.fingerprint).not.toBe(first.fingerprint);
      expect(await context.box.read(proposalId)).toMatchObject({
        sourceRef: "video:1",
        sourceVersion: "2026-11-12",
      });
      const before = counts(context);
      for (const action of ["adopt", "reject"])
        await expect(
          respond(context, proposalId, action, `stale-${action}`, first as never),
        ).rejects.toThrow("PROPOSAL_CHANGED");
      await expect(
        respond(context, proposalId, "reject", "wrong-fingerprint", {
          version: 2,
          fingerprint: first.fingerprint as string,
        }),
      ).rejects.toThrow("PROPOSAL_CHANGED");
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);
      await expect(respond(context, proposalId, "adopt", "adopt-other")).rejects.toThrow(
        "PROPOSAL_TYPE_NOT_ADOPTABLE",
      );
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);
      expect(counts(context)).toEqual(before);
      await expect(
        command(
          context.control,
          "memory.rule.respond",
          { target: proposalId, action: "confirm" },
          "confirm-other",
        ),
      ).rejects.toThrow("RULE_NOT_FOUND");
      await expect(
        command(
          context.control,
          "memory.rule.respond",
          { target: proposalId, action: "reject" },
          "reject-through-rules",
        ),
      ).rejects.toThrow("MEMORY_RULE_ACTION_UNSUPPORTED");
      await expect(respond(context, proposalId, "postpone", "unknown-action")).rejects.toThrow(
        "PROPOSAL_ACTION_UNKNOWN",
      );
      expect(await respond(context, proposalId, "reject", "reject-other")).toMatchObject({
        replayed: false,
      });
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      expect(counts(context)).toEqual(before);

      await propose();
      const adopted: unknown[] = [];
      context.box.register("price_search", {
        adopt: async ({ data }) => {
          adopted.push(data);
          return { resultRef: "price-search:1" };
        },
      });
      expect((await proposalsQuery(context)).payload.proposals[0]).toMatchObject({
        adoptable: true,
        refusedBefore: 1,
      });
      expect(await respond(context, proposalId, "adopt", "adopt-registered")).toMatchObject({
        resultRef: "price-search:1",
      });
      expect(adopted).toEqual([{ query: "新款手机" }]);
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      await expect(respond(context, proposalId, "adopt", "adopt-again")).rejects.toThrow(
        "PROPOSAL_ACCEPTED",
      );
      expect(adopted).toHaveLength(1);

      const wideId = `next-step:${"8".repeat(32)}`;
      const wide = (over: Record<string, unknown> = {}) =>
        context.box.propose({
          proposalId: wideId,
          type: "price_search",
          summary: "😀".repeat(100),
          effect: "\u202e  采纳后去比价",
          origin: "external_agent",
          threadId: null,
          evidence: [
            { kind: "\u202e", text: "只有控制符的种类", sources: [], figures: [] },
            { kind: "note", text: "\u202e", sources: [], figures: [] },
          ],
          data: { query: "宽字符" },
          ...over,
        } as never);
      for (const invalid of [
        { summary: "\u202e \u0007" },
        { effect: "" },
        { type: "t".repeat(65) },
        { summary: "长".repeat(201) },
        { summary: "😀".repeat(101) },
        { effect: "长".repeat(201) },
        { type: "price\u202esearch" },
        { proposalId: "not-an-id" },
      ])
        await expect(wide(invalid)).rejects.toMatchObject({ code: "PROPOSAL_INVALID" });
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      await wide();
      const shown = (await proposalsQuery(context)).payload.proposals[0];
      expect(shown).toMatchObject({
        summary: "😀".repeat(100),
        effect: "采纳后去比价",
        evidence: [{ kind: "note", text: null }],
      });
      await wide();
      expect(
        await respond(context, wideId, "adopt", "adopt-after-same-content", {
          version: shown?.version as number,
          fingerprint: shown?.fingerprint as string,
        }),
      ).toMatchObject({ resultRef: "price-search:1" });
      expect(adopted).toEqual([{ query: "新款手机" }, { query: "宽字符" }]);
    });

    it("keeps the old basis and the old state when writing the new basis fails", async () => {
      const { context, inferred } = await prepared();
      const first = await inferred("fail.example");
      const id = first["proposalId"] as string;
      await context.box.reject(id);
      const real = context.ruleWriterWith();
      let failures = 1;
      const failing = context.ruleWriterWith({
        protector: {
          protect: async (input: Parameters<typeof context.protector.protect>[0]) => {
            if (failures-- > 0) throw new Error("protect failed");
            return context.protector.protect(input);
          },
          unprotect: (input: Parameters<typeof context.protector.unprotect>[0]) =>
            context.protector.unprotect(input),
        } as never,
      });
      await expect(
        failing.create({
          key: "fail-key",
          quote: sentence,
          inferred: true,
          type: "mail_must_notify",
          params: { senderDomains: ["fail.example"] },
          summary: "入管局的邮件一律提醒",
          threadId: THREAD_ID,
        }),
      ).rejects.toThrow("protect failed");
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(0);
      await expect(real.confirm(id)).rejects.toMatchObject({ code: "RULE_PROPOSAL_REJECTED" });
      await inferred("fail.example", "call-fail-again");
      const back = (await proposalsQuery(context)).payload.proposals;
      expect(back).toHaveLength(1);
      expect(back[0]?.quote).toBe(sentence);
    });

    it("lets an adopted card be adopted again after its rule was undone, even when the list is full", async () => {
      const { context, set } = await prepared();
      const small = new ProductionOwnerRuleTools(context.ruleWriterWith({ proposalLimit: 1 }));
      const first = await set(
        { quote: sentence, inferred: true, params: { senderDomains: ["card.example"] } },
        "call-card",
        small,
      );
      const writer = context.ruleWriterWith({ proposalLimit: 1 });
      await writer.confirm(first["proposalId"] as string);
      await context.ruleWriter.undo((await context.ruleWriter.list())[0]?.ruleId ?? "");
      await set(
        { quote: sentence, inferred: true, params: { senderDomains: ["filler.example"] } },
        "call-filler",
        small,
      );
      const receipt = await writer.confirm(first["proposalId"] as string);
      expect(receipt.status).toBe("active");
    });

    it("adopts a proposal whose source conversation is gone, without pointing the memory at it", async () => {
      const { context, inferred } = await prepared();
      const proposal = await inferred("gone.example");
      context.sql((database) => {
        database.prepare("UPDATE owner_proposals SET thread_id = NULL").run();
      });
      const receipt = await context.ruleWriter.confirm(proposal["proposalId"] as string);
      expect(
        await context.repository.productMemoryState().read(receipt.memoryId as never),
      ).toMatchObject({ sourceThreadId: null });
    });

    it("tells proposals from two agents of one owner apart", async () => {
      const { context, inferred } = await prepared();
      context.sql((database) => {
        database
          .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
          .run("agent-second", OWNER_ID);
      });
      const second = context.ruleWriterWith({
        configuration: { ownerId: OWNER_ID, agentId: createAgentId("agent-second") },
      });
      const mine = await inferred("shared.example");
      const theirs = await second.create({
        key: "second-key",
        quote: sentence,
        inferred: true,
        type: "mail_must_notify",
        params: { senderDomains: ["shared.example"] },
        summary: "入管局的邮件一律提醒",
        threadId: null,
      });
      expect(theirs.proposalId).not.toBe(mine["proposalId"]);
      expect((await proposalsQuery(context)).payload.pendingCount).toBe(1);
    });
  });

  it("[P4-1] flags a three-level chain after an edit, leaves an unrelated memory alone, suspends the rule whose source changed and counts what the Owner agreed with", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    const texts = {
      a: "Andy 在办日本签证续签",
      b: "Andy 最近常和入管局通信",
      c: "Andy 每周一早上要看入管局的邮件",
      d: "Andy 喜欢早上跑步",
    } as const;
    for (const [key, text] of Object.entries(texts)) {
      await context.protect(`payload-chain-${key}`, text);
      await command(
        context.control,
        "memory.create",
        { contentRef: `payload-chain-${key}`, category: "other", subCategory: null, pinned: false },
        `chain-${key}`,
      );
    }
    const id = (key: keyof typeof texts) => `memory:owner:chain-${key}`;
    context.sql((database) => {
      database
        .prepare(
          `INSERT INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id,
            status, model_called, started_at) VALUES ('run-p41', ?, ?, '2026-05-01', 'r', 'completed', 1, ?)`,
        )
        .run(OWNER_ID, AGENT_ID, T0);
      for (const [change, memoryId, basis] of [
        ["change-b", id("b"), id("a")],
        ["change-c", id("c"), id("b")],
      ] as const) {
        database
          .prepare(
            `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id,
              memory_id, action, after_revision, created_at)
             VALUES (?, 'run-p41', ?, ?, ?, 'reflect', 1, ?)`,
          )
          .run(change, OWNER_ID, AGENT_ID, memoryId, T0);
        database
          .prepare(
            "INSERT INTO memory_consolidation_change_basis (change_id, position, memory_id) VALUES (?, 0, ?)",
          )
          .run(change, basis);
      }
    });
    const review = async () => {
      const snapshot = await context.control.query({
        ...envelope,
        kind: "query",
        type: "memory.review.read",
        payload: {},
      } as never);
      if (snapshot.type !== "memory.review.snapshot") throw new Error("snapshot");
      return snapshot.payload;
    };
    const current = async (key: keyof typeof texts) => {
      const found = (await overview(context.control)).memories.find(
        ({ memoryId }) => memoryId === id(key),
      );
      if (!found) throw new Error(key);
      return found;
    };
    expect((await review()).memories).toEqual([]);

    context.clock.value = "2026-10-26T00:00:00.000Z";
    await context.protect("payload-chain-a2", "Andy 的日本签证已经续好了");
    await mutate(
      context.control,
      id("a"),
      (await current("a")).revision,
      "correct",
      "payload-chain-a2",
    );
    const flagged = await review();
    expect(
      flagged.memories.map(({ memoryId, upstreamMemoryId, depth, reason, upstreamText }) => ({
        memoryId,
        upstreamMemoryId,
        depth,
        reason,
        upstreamText,
      })),
    ).toEqual([
      {
        memoryId: id("b"),
        upstreamMemoryId: id("a"),
        depth: 1,
        reason: "memory_edited",
        upstreamText: "Andy 的日本签证已经续好了",
      },
      {
        memoryId: id("c"),
        upstreamMemoryId: id("a"),
        depth: 2,
        reason: "memory_edited",
        upstreamText: "Andy 的日本签证已经续好了",
      },
    ]);
    expect(flagged.memories.some(({ memoryId }) => memoryId === id("d"))).toBe(false);
    expect((await current("b")).text).toBe(texts.b);
    expect((await current("c")).text).toBe(texts.c);

    context.clock.value = "2026-10-27T00:00:00.000Z";
    await command(
      context.control,
      "memory.review.respond",
      { target: id("c"), action: "dismiss", expectedRevision: null },
      "dismiss-c",
    );
    await expect(
      command(
        context.control,
        "memory.review.respond",
        { target: id("d"), action: "dismiss", expectedRevision: null },
        "dismiss-d",
      ),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    await context.protect("payload-chain-b2", "Andy 最近不再和入管局通信");
    await mutate(
      context.control,
      id("b"),
      (await current("b")).revision,
      "correct",
      "payload-chain-b2",
    );
    expect(
      await command(
        context.control,
        "memory.review.reportMissed",
        { memoryId: id("d"), upstreamMemoryId: id("a") },
        "missed-d",
      ),
    ).toMatchObject({ replayed: false });
    expect(
      await command(
        context.control,
        "memory.review.reportMissed",
        { memoryId: id("d"), upstreamMemoryId: id("a") },
        "missed-d-again",
      ),
    ).toMatchObject({ replayed: true });
    const after = await review();
    expect(
      after.memories.map(({ memoryId, upstreamMemoryId, reason }) => [
        memoryId,
        upstreamMemoryId,
        reason,
      ]),
    ).toEqual([
      [id("d"), id("a"), "owner_reported"],
      [id("c"), id("b"), "memory_edited"],
    ]);
    expect(after.agreement).toEqual({
      handled: 2,
      agreed: 1,
      missed: 1,
      openMemories: 2,
      openRules: 0,
    });

    const sentence = "日本入管局相关的邮件以后必须通知我";
    await context.turn("owner", sentence, null);
    const created = (await context.ruleTools.run({
      runId: createRunId("run-rule-p41"),
      toolCallId: "call-p41",
      capabilityRef: "rule.set",
      capabilityHandleRef: null,
      arguments: {
        inferred: false,
        type: "mail_must_notify",
        summary: "入管局的邮件一律提醒",
        quote: sentence,
        params: { senderDomains: ["isa.go.jp"] },
      },
      dataClassification: "private",
      context: { threadId: THREAD_ID },
    } as never)) as Record<string, unknown>;
    const ruleId = created["ruleId"] as string;
    const rules = async () => {
      const snapshot = await context.control.query({
        ...envelope,
        kind: "query",
        type: "memory.rules.read",
        payload: {},
      } as never);
      if (snapshot.type !== "memory.rules.snapshot") throw new Error("snapshot");
      return snapshot.payload.rules;
    };
    const ruleMemory = await context.repository
      .productMemoryState()
      .read(created["memoryId"] as never);
    if (!ruleMemory) throw new Error("rule memory");
    context.clock.value = "2026-10-28T00:00:00.000Z";
    await context.protect("payload-rule-p41", "日本和韩国入管局相关的邮件以后必须通知我");
    await mutate(
      context.control,
      ruleMemory.id,
      ruleMemory.revision,
      "correct",
      "payload-rule-p41",
    );
    expect(await rules()).toMatchObject([{ ruleId, status: "needs_review", enforced: true }]);

    const prompts: string[] = [];
    const answer = JSON.stringify({
      standing: true,
      type: "mail_must_notify",
      summary: "日本和韩国入管局的邮件一律提醒",
      params: { senderDomains: ["isa.go.jp", "moj.go.kr"] },
    });
    const model: ProactiveModelInvoker = {
      modelRef: "stub-flash",
      allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
      model: {
        listAvailable: async () => [],
        async *invoke(request) {
          yield {
            type: "model.output",
            invocationId: request.invocationId,
            sequence: 0,
            payloadRef: "out-p41" as never,
            occurredAt: context.clock.value,
          };
          yield {
            type: "model.completed",
            invocationId: request.invocationId,
            inputTokens: 1,
            outputTokens: 1,
            costMicros: 1,
            latencyMs: 1,
            occurredAt: context.clock.value,
          };
        },
      },
      async prepare({ prompt }) {
        prompts.push(prompt);
        return {
          runId: "run-p41-review" as never,
          inputRef: "in-p41",
          allowedDisclosureRef: "in-p41",
          secretHandleRefs: [],
          release: async () => undefined,
        };
      },
      readOutput: async () => answer,
      release: async () => undefined,
    };
    const reviewer = new RuleReviewService({
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      clock: { now: () => context.clock.value },
      store: context.repository.ruleReviews(),
      memories: context.repository.productMemoryState(),
      readMemoryText: async (record) => (await context.plaintext(record.contentRef)) ?? "",
      model,
      nextInvocationId: () => `rule-review-${prompts.length}`,
    });
    expect(await reviewer.run()).toEqual([{ ruleId, outcome: "suspended" }]);
    expect(prompts[0]).toContain("日本和韩国入管局相关的邮件以后必须通知我");
    expect(await rules()).toMatchObject([{ ruleId, status: "suspended", enforced: false }]);
    const [suspended] = (await review()).rules;
    expect(suspended).toMatchObject({
      ruleId,
      status: "suspended",
      suspendReason: "parameters_changed",
      suggestion: "日本和韩国入管局的邮件一律提醒",
      suggestionConditions: [{ field: "senderDomains", values: ["isa.go.jp", "moj.go.kr"] }],
    });
    if (!suspended) throw new Error("suspended");
    await expect(
      command(
        context.control,
        "memory.review.respond",
        { target: ruleId, action: "adopt", expectedRevision: suspended.revision - 1 },
        "adopt-stale",
      ),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    expect(await rules()).toMatchObject([{ ruleId, status: "suspended" }]);
    await command(
      context.control,
      "memory.review.respond",
      { target: ruleId, action: "adopt", expectedRevision: suspended.revision },
      "adopt",
    );
    expect(await rules()).toMatchObject([{ ruleId, status: "active", enforced: true }]);
    const stored = await context.repository
      .ownerRules()
      .read({ ownerId: OWNER_ID, agentId: AGENT_ID, ruleId } as never);
    expect(stored?.parameters).toMatchObject({
      params: { senderDomains: ["isa.go.jp", "moj.go.kr"] },
    });
    expect(await reviewer.run()).toEqual([]);
    expect((await review()).agreement).toEqual({
      handled: 3,
      agreed: 2,
      missed: 1,
      openMemories: 2,
      openRules: 0,
    });
  });

  it("[iOS] 规则引用的记忆后来被新记忆取代时，照样给出引用并标明，给出最新那条记忆；归档的不标", async () => {
    const sentence = "日本入管局相关的邮件以后必须通知我";
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.turn("owner", sentence, null);
    const created = (await context.ruleTools.run({
      runId: createRunId("run-rule-superseded"),
      toolCallId: "call-superseded",
      capabilityRef: "rule.set",
      capabilityHandleRef: null,
      arguments: {
        quote: sentence,
        inferred: false,
        type: "mail_must_notify",
        summary: "入管局的邮件一律提醒",
        params: { senderDomains: ["isa.go.jp"] },
      },
      dataClassification: "private",
      context: { threadId: THREAD_ID },
    } as never)) as Record<string, unknown>;
    const state = context.repository.productMemoryState();
    const sourceId = created["memoryId"] as never;
    const newer = (await state.listActive(OWNER_ID, AGENT_ID)).find(({ id }) => id !== sourceId);
    if (!newer) throw new Error("newer memory");
    const listed = async () => {
      const snapshot = await context.control.query({
        ...envelope,
        kind: "query",
        type: "memory.rules.read",
        payload: {},
      } as never);
      if (snapshot.type !== "memory.rules.snapshot") throw new Error("snapshot");
      const { idempotencyKey: _, ...parsable } = snapshot as Record<string, unknown>;
      gatewayV2MessageSchema.parse(parsable);
      return snapshot.payload.rules.find(({ ruleId }) => ruleId === created["ruleId"]);
    };
    const generation = async () =>
      (await context.repository.memoryBook().latestGeneration({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
      } as never)) as never;
    const revise = async (memoryId: never, change: Record<string, unknown>) =>
      context.memory.revise({
        memoryId,
        expectedRevision: (await state.read(memoryId))?.revision ?? 0,
        generationId: await generation(),
        ...change,
      } as never);

    expect(await listed()).toMatchObject({
      quote: sentence,
      quoteSuperseded: false,
      quoteLatestMemoryId: null,
    });
    await revise(sourceId, { attributes: { supersededBy: newer.id } });
    expect(await listed()).toMatchObject({
      quote: sentence,
      quoteSuperseded: true,
      quoteLatestMemoryId: newer.id,
    });
    await revise(newer.id as never, { status: "archived" });
    expect(await listed()).toMatchObject({
      quote: sentence,
      quoteSuperseded: true,
      quoteLatestMemoryId: null,
    });
    await revise(newer.id as never, { status: "active" });
    await revise(newer.id as never, { attributes: { supersededBy: sourceId } });
    expect(await listed()).toMatchObject({ quoteSuperseded: true, quoteLatestMemoryId: null });
    await revise(newer.id as never, { attributes: { supersededBy: null } });
    await revise(sourceId, { status: "archived" });
    expect(await listed()).toMatchObject({
      quote: sentence,
      quoteSuperseded: false,
      quoteLatestMemoryId: null,
    });
    await revise(sourceId, { status: "active" });
    const chain: string[] = [];
    for (let index = 1; index <= 9; index += 1) {
      await context.protect(`payload-chain-${index}`, `主人的第 ${index} 版说法`);
      await context.control.execute({
        ...envelope,
        idempotencyKey: `chain-${index}`,
        kind: "command",
        type: "memory.create",
        payload: {
          contentRef: `payload-chain-${index}`,
          category: "preference",
          subCategory: "其他",
          pinned: false,
        },
      } as never);
      chain.push(`memory:owner:chain-${index}`);
    }
    await revise(sourceId, { attributes: { supersededBy: chain[0] } });
    for (let index = 0; index < 8; index += 1)
      await revise(chain[index] as never, { attributes: { supersededBy: chain[index + 1] } });
    expect(await listed()).toMatchObject({ quoteSuperseded: true, quoteLatestMemoryId: null });
    await revise(chain[7] as never, { attributes: { supersededBy: null } });
    expect(await listed()).toMatchObject({ quoteSuperseded: true, quoteLatestMemoryId: chain[7] });
    context.sql((database) =>
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent-other', ?, 0)")
        .run(OWNER_ID),
    );
    await context.protect("payload-other-agent", "主人的另一版说法", "private", "agent-other");
    const foreign = await state.save(
      {
        ...((await state.read(newer.id as never)) as object),
        contentRef: "payload-other-agent",
        sourceThreadId: null,
        id: "memory:other-agent-latest",
        agentId: "agent-other",
        revision: 1,
      } as never,
      null,
    );
    await revise(sourceId, { attributes: { supersededBy: foreign.id } });
    expect(await listed()).toMatchObject({ quoteSuperseded: true, quoteLatestMemoryId: null });
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
      {
        contentRef: "payload-manual",
        category: "preference",
        subCategory: "运动",
        topic: null,
        pinned: false,
      },
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
      {
        contentRef: "payload-card",
        category: "finance",
        subCategory: null,
        topic: null,
        pinned: false,
      },
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
      {
        contentRef: "payload-coffee",
        category: "preference",
        subCategory: null,
        topic: null,
        pinned: true,
      },
      "manual-pinned",
    );
    await command(
      context.control,
      "memory.create",
      {
        contentRef: "payload-run",
        category: "preference",
        subCategory: null,
        topic: null,
        pinned: false,
      },
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
      pinned: (profiled()[0] ?? "").length + 3,
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
      {
        contentRef: "payload-mood",
        category: "health",
        subCategory: null,
        topic: null,
        pinned: false,
      },
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
        topic: null,
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
    const pinnedView = await overview(context.control);
    const sisterLine = pinnedView.profile
      .flatMap(({ lines }) => lines.map(({ text }) => text))
      .find((text) => text.startsWith("主人的妹妹在大阪做护士"));
    expect(sisterLine).toBeDefined();
    expect(pinnedView.profileUsage.pinned).toBe((sisterLine ?? "").length + 3);
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
      {
        contentRef: "payload-coffee",
        category: "identity",
        subCategory: "饮食",
        topic: null,
        pinned: true,
      },
      "manual-coffee",
    );
    await command(
      context.control,
      "memory.create",
      {
        contentRef: "payload-mood",
        category: "health",
        subCategory: null,
        topic: null,
        pinned: false,
      },
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
    expect(suggestion.suggestionId).toMatch(/^person-suggestion:[0-9a-f]{32}$/);
    expect(suggestion.suggestionId).not.toContain(suggestion.personId);
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
        items: [
          { contentRef: "payload-import-1", category: "rule", subCategory: null, topic: null },
        ],
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
            {
              contentRef: "payload-import-1",
              category: "rule",
              subCategory: "回答方式",
              topic: null,
            },
            { contentRef: "payload-import-2", category: "goal", subCategory: null, topic: null },
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
        items: [
          { contentRef: "payload-import-pwd", category: "other", subCategory: null, topic: null },
        ],
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

  it("[A4] judges an imported entry against the owner's private memories with the model and never compares words", async () => {
    const context = await setup(
      "请记住，我对乳制品不耐受。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人对乳制品不耐受","classification":"private","confidence":950,"explicit":true,"quote":"我对乳制品不耐受"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-d1", "喝不了牛奶");
    await context.protect("payload-d2", "对乳制品不耐受，每次喝都难受");
    await context.protect("payload-d3", "我的身份证号是 110101199003071234");
    await context.protect("payload-d4", "我得了抑郁症", "sensitive");
    const duplicates = async (contentRefs: readonly string[]) => {
      const snapshot = await context.control.query({
        ...envelope,
        kind: "query",
        type: "memory.import.duplicates.read",
        payload: { contentRefs },
      } as never);
      if (snapshot.type !== "memory.import.duplicates.snapshot") throw new Error("snapshot");
      return snapshot.payload.items.map(({ contentRef, verdict, memoryId }) => [
        contentRef,
        verdict,
        memoryId === null ? null : memoryId.length > 0,
      ]);
    };
    context.duplicateAnswers.push(
      { matchKey: "m0", probabilityPermille: 920 },
      { matchKey: null, probabilityPermille: 0 },
    );
    expect(await duplicates(["payload-d1", "payload-d2", "payload-d3", "payload-d4"])).toEqual([
      ["payload-d1", "same", true],
      ["payload-d2", "different", null],
      ["payload-d3", "skipped", null],
      ["payload-d4", "skipped", null],
    ]);
    expect(context.duplicateRequests).toHaveLength(1);
    const request = context.duplicateRequests[0];
    expect(request?.existing.map(({ text }) => text)).toEqual(["主人对乳制品不耐受"]);
    expect(request?.candidates.map(({ text }) => text)).toEqual([
      "喝不了牛奶",
      "对乳制品不耐受，每次喝都难受",
    ]);
    expect(JSON.stringify(context.duplicateRequests)).not.toContain("抑郁症");
    await context.protect("payload-d5", "我最近总睡不好");
    context.classifyOutputs.push(
      JSON.stringify({
        items: [{ id: "0", category: "health", classification: "sensitive", topic: "health" }],
      }),
    );
    await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.classify.read",
      payload: { contentRefs: ["payload-d5"] },
    } as never);
    const before = context.duplicateRequests.length;
    expect(await duplicates(["payload-d5"])).toEqual([["payload-d5", "skipped", null]]);
    expect(context.duplicateRequests).toHaveLength(before);
  });

  it("[A4] never calls an entry different when older memories were left out of the comparison", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-t1", "每周跑三次步");
    await command(
      context.control,
      "memory.import.commit",
      {
        batchId: "memory-import-two",
        source: "assistant",
        items: [{ contentRef: "payload-t1", category: "other", subCategory: null, topic: null }],
      },
      "import-two",
    );
    context.duplicateSettings.maximumExistingMemories = 1;
    await context.protect("payload-t2", "喜欢吃辣");
    context.duplicateAnswers.push({ matchKey: null, probabilityPermille: 0 });
    const snapshot = await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.import.duplicates.read",
      payload: { contentRefs: ["payload-t2"] },
    } as never);
    if (snapshot.type !== "memory.import.duplicates.snapshot") throw new Error("snapshot");
    expect(snapshot.payload.items.map(({ verdict }) => verdict)).toEqual(["skipped"]);
    expect(context.duplicateRequests[0]?.existing).toHaveLength(1);
  });

  it("[A4] reports skipped when every existing memory is sensitive, and never counts them against the limit", async () => {
    const context = await setup(
      "我月薪三万。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人月薪三万","classification":"sensitive","topic":"finance","confidence":950,"quote":"我月薪三万"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-s1", "我每周日去教堂", "sensitive");
    await command(
      context.control,
      "memory.import.commit",
      {
        batchId: "memory-import-sensitive-only",
        source: "assistant",
        items: [
          { contentRef: "payload-s1", category: "other", subCategory: null, topic: "beliefs" },
        ],
      },
      "import-sensitive-only",
    );
    await context.protect("payload-s2", "喜欢蓝色");
    const snapshot = await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.import.duplicates.read",
      payload: { contentRefs: ["payload-s2"] },
    } as never);
    if (snapshot.type !== "memory.import.duplicates.snapshot") throw new Error("snapshot");
    expect(snapshot.payload.items.map(({ verdict }) => verdict)).toEqual(["skipped"]);
    expect(context.duplicateRequests).toHaveLength(0);
    await context.protect("payload-s3", "每周跑三次步");
    await command(
      context.control,
      "memory.import.commit",
      {
        batchId: "memory-import-a-private",
        source: "assistant",
        items: [{ contentRef: "payload-s3", category: "other", subCategory: null, topic: null }],
      },
      "import-a-private",
    );
    context.duplicateSettings.maximumExistingMemories = 1;
    context.duplicateAnswers.push({ matchKey: null, probabilityPermille: 0 });
    const limited = await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.import.duplicates.read",
      payload: { contentRefs: ["payload-s2"] },
    } as never);
    if (limited.type !== "memory.import.duplicates.snapshot") throw new Error("snapshot");
    expect(limited.payload.items.map(({ verdict }) => verdict)).toEqual(["different"]);
    expect(context.duplicateRequests[0]?.existing).toHaveLength(1);
  });

  it("[T5] sorts hand-added memories with the model, keeps identifiers away from it and treats a broken answer as sensitive", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.protect("payload-c1", "我不吃药，身体一直很好");
    await context.protect("payload-c2", "每天早上吃一片降压药");
    await context.protect("payload-c3", "我的身份证号是 110101199003071234");
    await context.protect("payload-c4", "回答不要用表情符号");
    const classify = async (contentRefs: readonly string[]) => {
      const snapshot = await context.control.query({
        ...envelope,
        kind: "query",
        type: "memory.classify.read",
        payload: { contentRefs },
      } as never);
      if (snapshot.type !== "memory.classify.snapshot") throw new Error("snapshot");
      return snapshot.payload.items;
    };
    context.classifyOutputs.push(
      JSON.stringify({
        items: [
          { id: "0", category: "preference", classification: "private", topic: null },
          { id: "1", category: "health", classification: "private", topic: null },
          { id: "3", category: "made-up", classification: "private", topic: null },
        ],
      }),
    );
    expect(await classify(["payload-c1", "payload-c2", "payload-c3", "payload-c4"])).toEqual([
      {
        contentRef: "payload-c1",
        category: "preference",
        classification: "private",
        topic: null,
        failed: false,
      },
      {
        contentRef: "payload-c2",
        category: "health",
        classification: "sensitive",
        topic: "health",
        failed: false,
      },
      {
        contentRef: "payload-c3",
        category: "other",
        classification: "sensitive",
        topic: "other",
        failed: false,
      },
      {
        contentRef: "payload-c4",
        category: "other",
        classification: "private",
        topic: null,
        failed: false,
      },
    ]);
    expect(context.classifyPrompts).toHaveLength(1);
    expect(context.classifyPrompts[0]).toContain("我不吃药，身体一直很好");
    expect(context.classifyPrompts[0]).not.toContain("110101199003071234");
    await context.protect("payload-c5", "我最近心情很低落", "sensitive");
    expect(await classify(["payload-c5"])).toEqual([
      {
        contentRef: "payload-c5",
        category: "other",
        classification: "sensitive",
        topic: "other",
        failed: false,
      },
    ]);
    expect(context.classifyPrompts).toHaveLength(1);
    context.classifyOutputs.push("not json", '{"items":"nope"}');
    expect(await classify(["payload-c1"])).toEqual([
      {
        contentRef: "payload-c1",
        category: "other",
        classification: "sensitive",
        topic: "other",
        failed: true,
      },
    ]);
    expect(context.classifyFailures).toHaveLength(1);
  });

  it("[T5] stores a hand-added memory at least as sensitive as its text and category demand, whatever the page sent", async () => {
    const context = await setup(
      "请记住，我最喜欢的颜色是蓝色。",
      '{"memories":[{"kind":"durable_fact","decision":"create","text":"主人最喜欢的颜色是蓝色","classification":"private","confidence":950,"explicit":true,"quote":"我最喜欢的颜色是蓝色"}]}',
    );
    await context.capture.start(context.request);
    await context.capture.stop();
    await context.protect("payload-id", "我的身份证号是 110101199003071234");
    await context.protect("payload-bp", "每天早上吃一片降压药");
    await context.protect("payload-bp-topic", "我在吃抗抑郁的药");
    await context.protect("payload-plain", "我喜欢早上跑步");
    const add = (contentRef: string, category: string, topic: string | null, key: string) =>
      command(
        context.control,
        "memory.create",
        { contentRef, category, subCategory: null, topic, pinned: false },
        key,
      );
    await add("payload-id", "identity", null, "t5-id");
    await add("payload-bp", "health", null, "t5-bp");
    await add("payload-bp-topic", "preference", "health", "t5-topic");
    await add("payload-plain", "preference", null, "t5-plain");
    await context.protect("payload-belief", "我每周日去教堂");
    context.classifyOutputs.push(
      JSON.stringify({
        items: [{ id: "0", category: "other", classification: "sensitive", topic: "beliefs" }],
      }),
    );
    await context.control.query({
      ...envelope,
      kind: "query",
      type: "memory.classify.read",
      payload: { contentRefs: ["payload-belief"] },
    } as never);
    await add("payload-belief", "other", null, "t5-judged");
    const stored = Object.fromEntries(
      (await overview(context.control)).memories
        .filter(({ memoryId }) => memoryId.startsWith("memory:owner:t5-"))
        .map(({ memoryId, dataClassification, topic, sourceRefs }) => [
          memoryId.slice("memory:owner:".length),
          {
            dataClassification,
            topic,
            raised: sourceRefs.some((ref) => ref.startsWith("memory-raised:")),
          },
        ]),
    );
    expect(stored).toEqual({
      "t5-id": { dataClassification: "sensitive", topic: "other", raised: true },
      "t5-bp": { dataClassification: "sensitive", topic: "health", raised: true },
      "t5-topic": { dataClassification: "sensitive", topic: "health", raised: true },
      "t5-plain": { dataClassification: "private", topic: null, raised: false },
      "t5-judged": { dataClassification: "sensitive", topic: "beliefs", raised: true },
    });
  });

  const P3_5_MESSAGE = "我超想出去玩，周末去哪儿都行";
  const P3_5_MEMORY = JSON.stringify({
    memories: [
      {
        kind: "durable_fact",
        decision: "create",
        text: "主人很喜欢出去玩",
        classification: "private",
        confidence: 900,
        category: "preference",
        subCategory: "社交",
        quote: "我超想出去玩，周末去哪儿都行",
      },
    ],
  });
  const captureFailures = async (context: Awaited<ReturnType<typeof setup>>) =>
    (await context.ledgerEntries())
      .filter(({ outcome }) => outcome.startsWith("capture_"))
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map(({ outcome, reasonCode, subjectRef, ownerRating, inputs }) => ({
        outcome,
        reasonCode,
        subjectRef,
        ownerRating,
        ruleIds: inputs.ruleIds,
      }));
  const failureOutcomes = async (context: Awaited<ReturnType<typeof setup>>) =>
    (await captureFailures(context)).map(({ outcome }) => outcome).toSorted();
  const backlogRows = (context: Awaited<ReturnType<typeof setup>>) => {
    let rows: unknown[] = [];
    context.sql((database) => {
      rows = database
        .prepare(
          "SELECT generation_id AS generationId, attempts, last_error_code AS lastErrorCode FROM memory_capture_backlog",
        )
        .all();
    });
    return rows;
  };
  const optionsOf = (context: Awaited<ReturnType<typeof setup>>) =>
    (
      context.capture as unknown as {
        options: ConstructorParameters<typeof ProductionMemoryCapture>[0];
      }
    ).options;
  const nextTurn = async (
    context: Awaited<ReturnType<typeof setup>>,
    runId: string,
    outputs: readonly (string | Error)[],
  ) => {
    await context.turn("owner", `今天第 ${runId} 轮，随便聊聊。`, runId);
    context.outputs.push(...outputs);
    const capture = new ProductionMemoryCapture(optionsOf(context));
    await capture.start(context.requestFor(runId));
    await capture.stop();
  };
  const activeMemories = (context: Awaited<ReturnType<typeof setup>>) =>
    context.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);

  it("[P3-5] retries a failed capture once in the same turn and keeps the memory", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(P3_5_MEMORY);
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.calls).toEqual([
      { invocationId: "memory-capture:run-memory-capture", retryToolCall: false },
      { invocationId: "memory-capture:run-memory-capture:retry", retryToolCall: false },
    ]);
    expect(context.prompts[1]).toBe(context.prompts[0]);
    expect((await activeMemories(context)).map(({ id }) => id)).toEqual([
      "memory:memory-capture:run-memory-capture:0",
    ]);
    expect(await captureFailures(context)).toEqual([
      {
        outcome: "capture_retrying",
        reasonCode: "AI_GATEWAY_PROVIDER_UNAVAILABLE",
        subjectRef: "memory-capture:run-memory-capture",
        ownerRating: null,
        ruleIds: [],
      },
    ]);
    expect(backlogRows(context)).toEqual([]);
  });

  it("[P3-5] still sends the audit records when the transaction committed but its answer was lost", async () => {
    const context = await setup(P3_5_MESSAGE, P3_5_MEMORY);
    const options = optionsOf(context);
    const lost = new ProductionMemoryCapture({
      ...options,
      unitOfWork: {
        run: async (work) => {
          await options.unitOfWork.run(work);
          throw new Error("COMMIT_ANSWER_LOST");
        },
      },
    });
    await lost.start(context.request);
    await lost.stop();
    expect(await activeMemories(context)).toHaveLength(1);
    expect(context.audits.length).toBeGreaterThan(0);
    expect(backlogRows(context)).toEqual([]);
  });

  it("[P3-5] keeps saving and keeps the turn queued when the queue cannot be read", async () => {
    const context = await setup(P3_5_MESSAGE, P3_5_MEMORY);
    const options = failingWrites(context);
    const backlog = options.backlog;
    if (!backlog) throw new Error("backlog");
    const blind = new ProductionMemoryCapture({
      ...options,
      backlog: {
        ...backlog,
        has: async () => {
          throw new Error("PORT_UNAVAILABLE");
        },
      },
    });
    await blind.start(context.request);
    await blind.stop();
    expect(await activeMemories(context)).toEqual([]);
    expect(backlogRows(context).map((row) => (row as { attempts: number }).attempts)).toEqual([1]);
  });

  it("[P3-5] retries an answer that is not valid JSON and records the failure", async () => {
    const context = await setup(P3_5_MESSAGE, "好的，我记住了。");
    context.outputs.push(P3_5_MEMORY);
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.calls).toHaveLength(2);
    expect(await activeMemories(context)).toHaveLength(1);
    expect(
      (await captureFailures(context)).map(({ outcome, reasonCode }) => [outcome, reasonCode]),
    ).toEqual([["capture_retrying", "MEMORY_CAPTURE_RESPONSE_INVALID"]]);
    expect(backlogRows(context)).toEqual([]);
  });

  it("[P3-5] queues a turn that fails twice and replays it on the next turn", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_REQUEST_TIMEOUT"));
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.calls).toHaveLength(2);
    expect(await activeMemories(context)).toEqual([]);
    expect(backlogRows(context)).toEqual([
      {
        generationId: "memory-capture:run-memory-capture",
        attempts: 0,
        lastErrorCode: "AI_GATEWAY_REQUEST_TIMEOUT",
      },
    ]);
    expect(
      (await captureFailures(context))
        .map(({ outcome, reasonCode }) => [outcome, reasonCode])
        .toSorted(),
    ).toEqual([
      ["capture_queued", "AI_GATEWAY_REQUEST_TIMEOUT"],
      ["capture_retrying", "AI_GATEWAY_PROVIDER_UNAVAILABLE"],
    ]);

    await nextTurn(context, "run-next", ['{"memories":[]}', P3_5_MEMORY]);
    expect(context.calls.slice(2)).toEqual([
      { invocationId: "memory-capture:run-next", retryToolCall: false },
      { invocationId: "memory-capture:run-next:backlog", retryToolCall: false },
    ]);
    expect(context.prompts[3]).toContain(P3_5_MESSAGE);
    expect((await activeMemories(context)).map(({ id }) => id)).toEqual([
      "memory:memory-capture:run-memory-capture:0",
    ]);
    expect(backlogRows(context)).toEqual([]);
    expect(
      (await context.ledgerEntries()).filter(({ outcome }) => outcome === "kept"),
    ).toHaveLength(1);
  });

  it("[P3-5] gives up on a queued turn after three failed replays", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    await context.capture.start(context.request);
    await context.capture.stop();
    for (const [index, runId] of ["run-a", "run-b", "run-c"].entries()) {
      await nextTurn(context, runId, ['{"memories":[]}', "不是 JSON"]);
      expect(backlogRows(context)).toEqual(
        index < 2
          ? [
              {
                generationId: "memory-capture:run-memory-capture",
                attempts: index + 1,
                lastErrorCode: "MEMORY_CAPTURE_RESPONSE_INVALID",
              },
            ]
          : [],
      );
    }
    expect(await failureOutcomes(context)).toEqual([
      "capture_gave_up",
      "capture_queued",
      "capture_queued",
      "capture_queued",
      "capture_retrying",
    ]);
    await nextTurn(context, "run-d", ['{"memories":[]}']);
    expect(context.calls.at(-1)?.invocationId).toBe("memory-capture:run-d");
    expect(await activeMemories(context)).toEqual([]);
  });

  it("[P3-5] does not ask the model again for a turn that was given up when its queued row could not be removed", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    await context.capture.start(context.request);
    await context.capture.stop();
    for (const runId of ["run-a", "run-b"])
      await nextTurn(context, runId, ['{"memories":[]}', "不是 JSON"]);
    const removing = removeFailingOnce(context, 1);
    await context.turn("owner", "今天 run-c 轮，随便聊聊。", "run-c");
    context.outputs.push('{"memories":[]}', "不是 JSON");
    const failing = new ProductionMemoryCapture(removing.options);
    await failing.start(context.requestFor("run-c"));
    await failing.stop();
    expect(backlogRows(context).map((row) => (row as { attempts: number }).attempts)).toEqual([3]);
    const before = context.calls.length;
    await nextTurn(context, "run-d", ['{"memories":[]}']);
    expect(context.calls.slice(before)).toEqual([
      { invocationId: "memory-capture:run-d", retryToolCall: false },
    ]);
    expect(backlogRows(context)).toEqual([]);
    expect(await activeMemories(context)).toEqual([]);
  });

  it("[P3-5] does not retry an error that would repeat, but still queues the turn", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_OUTPUT_TRUNCATED"));
    await context.capture.start(context.request);
    await context.capture.stop();
    expect(context.calls).toHaveLength(1);
    expect(
      (await captureFailures(context)).map(({ outcome, reasonCode }) => [outcome, reasonCode]),
    ).toEqual([["capture_queued", "AI_GATEWAY_OUTPUT_TRUNCATED"]]);
    expect(backlogRows(context)).toHaveLength(1);
  });

  it("[P3-5] keeps a queued turn while memory is paused and replays it after resuming", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    await context.capture.start(context.request);
    await context.capture.stop();
    await command(context.control, "memory.settings.set", { capturePaused: true });
    await nextTurn(context, "run-paused", []);
    expect(context.calls).toHaveLength(2);
    expect(backlogRows(context)).toHaveLength(1);
    await command(context.control, "memory.settings.set", { capturePaused: false }, "resume");
    await nextTurn(context, "run-resumed", ['{"memories":[]}', P3_5_MEMORY]);
    expect(await activeMemories(context)).toHaveLength(1);
    expect(backlogRows(context)).toEqual([]);
  });

  it("[P3-5] does not replay a turn from a conversation in the trash, and forgets it once the conversation is deleted", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    await context.capture.start(context.request);
    await context.capture.stop();
    context.sql((database) =>
      database.prepare("UPDATE threads SET status = 'trashed' WHERE id = ?").run(THREAD_ID),
    );
    const replay = new ProductionMemoryCapture(optionsOf(context));
    await replay.start(context.requestFor("run-memory-capture-other"));
    await replay.stop();
    expect(context.calls).toHaveLength(2);
    expect(backlogRows(context)).toHaveLength(1);
    context.sql((database) => {
      database.pragma("foreign_keys = ON");
      database.prepare("DELETE FROM threads WHERE id = ?").run(THREAD_ID);
    });
    expect(backlogRows(context)).toEqual([]);
  });

  it("[P3-5] keeps a turn queued from its first failure, before the same-turn retry ends", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    let release = () => {};
    const options = optionsOf(context);
    let seen: unknown[] = [];
    const capture = new ProductionMemoryCapture({
      ...options,
      generate: async (request, prompt, onAdmitted, call) => {
        if (call.invocationId.endsWith(":retry")) {
          seen = backlogRows(context);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE");
        }
        return options.generate(request, prompt, onAdmitted, call);
      },
    });
    await capture.start(context.request);
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([
      {
        generationId: "memory-capture:run-memory-capture",
        attempts: 0,
        lastErrorCode: "AI_GATEWAY_PROVIDER_UNAVAILABLE",
      },
    ]);
    release();
    await capture.stop();
  });

  it("[P3-5] retries a turn whose checkpoint could not be registered, since nothing was saved yet", async () => {
    const context = await setup(P3_5_MESSAGE, P3_5_MEMORY);
    context.outputs.push(P3_5_MEMORY);
    const options = optionsOf(context);
    let failures = 1;
    const capture = new ProductionMemoryCapture({
      ...options,
      generations: {
        request: async (work) => {
          failures -= 1;
          if (failures >= 0) throw new Error("PORT_CONFLICT");
          return options.generations.request(work);
        },
      },
    });
    await capture.start(context.request);
    await capture.stop();
    expect(context.calls.map(({ invocationId }) => invocationId)).toEqual([
      "memory-capture:run-memory-capture",
      "memory-capture:run-memory-capture:retry",
    ]);
    expect((await activeMemories(context)).map(({ id }) => id)).toEqual([
      "memory:memory-capture:run-memory-capture:0",
    ]);
    expect(
      (await captureFailures(context)).map(({ outcome, reasonCode }) => [outcome, reasonCode]),
    ).toEqual([["capture_retrying", "PORT_CONFLICT"]]);
    expect(backlogRows(context)).toEqual([]);
  });

  const failingWrites = (context: Awaited<ReturnType<typeof setup>>) => {
    const options = optionsOf(context);
    return {
      ...options,
      payloads: {
        ...options.payloads,
        put: async () => {
          throw new Error("PORT_CONFLICT");
        },
      },
    } as ConstructorParameters<typeof ProductionMemoryCapture>[0];
  };

  it("[P3-5] keeps a turn whose memories could not be written in the queue, after saving it twice without asking the model again", async () => {
    const context = await setup(P3_5_MESSAGE, P3_5_MEMORY);
    context.outputs.push(P3_5_MEMORY);
    const capture = new ProductionMemoryCapture(failingWrites(context));
    await capture.start(context.request);
    await capture.stop();
    expect(context.calls.map(({ invocationId }) => invocationId)).toEqual([
      "memory-capture:run-memory-capture",
    ]);
    expect(await activeMemories(context)).toEqual([]);
    expect(
      (await captureFailures(context)).map(({ outcome, reasonCode }) => [outcome, reasonCode]),
    ).toEqual([["capture_queued", "PORT_CONFLICT"]]);
    expect(backlogRows(context)).toEqual([
      {
        generationId: "memory-capture:run-memory-capture",
        attempts: 1,
        lastErrorCode: "PORT_CONFLICT",
      },
    ]);
    expect(context.failures).toHaveLength(1);
  });

  it("[P3-5] gives up a turn whose memories cannot be written after the third failed save, and drops it from the queue", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_REQUEST_TIMEOUT"));
    await context.capture.start(context.request);
    await context.capture.stop();
    for (const run of ["run-save-a", "run-save-b", "run-save-c"]) {
      await context.turn("owner", `今天 ${run} 轮，随便聊聊。`, run);
      context.outputs.push('{"memories":[]}', P3_5_MEMORY);
      const capture = new ProductionMemoryCapture(failingWrites(context));
      await capture.start(context.requestFor(run));
      await capture.stop();
      expect(await activeMemories(context)).toEqual([]);
    }
    expect(backlogRows(context)).toEqual([]);
    expect(
      (await captureFailures(context))
        .filter(({ reasonCode }) => reasonCode === "PORT_CONFLICT")
        .map(({ outcome }) => outcome)
        .sort(),
    ).toEqual(["capture_gave_up", "capture_queued", "capture_queued"]);
  });

  const removeFailingOnce = (context: Awaited<ReturnType<typeof setup>>, failures: number) => {
    const options = optionsOf(context);
    const backlog = options.backlog;
    if (!backlog) throw new Error("backlog");
    const state = { remaining: failures };
    return {
      state,
      options: {
        ...options,
        backlog: {
          ...backlog,
          remove: async (generationId: string) => {
            if (generationId === "memory-capture:run-memory-capture" && state.remaining > 0) {
              state.remaining -= 1;
              throw new Error("PORT_UNAVAILABLE");
            }
            return backlog.remove(generationId);
          },
        },
      } as ConstructorParameters<typeof ProductionMemoryCapture>[0],
    };
  };

  it("[P3-5] saves the memories and removes the queued row in one transaction: a failed removal rolls the save back, and the second save writes everything once", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_REQUEST_TIMEOUT"));
    await context.capture.start(context.request);
    await context.capture.stop();
    const { state, options } = removeFailingOnce(context, 1);
    await context.turn("owner", "今天第二轮，随便聊聊。", "run-saved");
    context.outputs.push('{"memories":[]}', P3_5_MEMORY);
    const capture = new ProductionMemoryCapture(options);
    await capture.start(context.requestFor("run-saved"));
    await capture.stop();
    expect(state.remaining).toBe(0);
    expect((await activeMemories(context)).map(({ id }) => id)).toEqual([
      "memory:memory-capture:run-memory-capture:0",
    ]);
    expect(
      await context.repository.productMemoryState().listHistory({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        memoryIds: ["memory:memory-capture:run-memory-capture:0" as never],
      }),
    ).toHaveLength(1);
    expect(backlogRows(context)).toEqual([]);
  });

  it("[P3-5] leaves nothing behind when the queued row cannot be removed twice, and keeps the turn queued", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    context.outputs.push(new Error("AI_GATEWAY_REQUEST_TIMEOUT"));
    await context.capture.start(context.request);
    await context.capture.stop();
    const { options } = removeFailingOnce(context, 2);
    await context.turn("owner", "今天第二轮，随便聊聊。", "run-rolled-back");
    context.outputs.push('{"memories":[]}', P3_5_MEMORY);
    const capture = new ProductionMemoryCapture(options);
    await capture.start(context.requestFor("run-rolled-back"));
    await capture.stop();
    expect(await activeMemories(context)).toEqual([]);
    expect(
      await context.repository
        .decisionLedger()
        .list({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          kind: "memory_candidate",
          since: "2000-01-01T00:00:00.000Z",
          limit: 100,
        } as never)
        .then((rows) => rows.filter(({ outcome }) => outcome === "kept")),
    ).toEqual([]);
    expect(backlogRows(context)).toHaveLength(1);
    expect(backlogRows(context)[0]).toMatchObject({
      attempts: 1,
      lastErrorCode: "PORT_UNAVAILABLE",
    });
  });

  it("[P3-5] does not replay a turn that another run is still retrying", async () => {
    const context = await setup(P3_5_MESSAGE, new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE"));
    let release = () => {};
    let retrying = false;
    const options = optionsOf(context);
    const capture = new ProductionMemoryCapture({
      ...options,
      generate: async (request, prompt, onAdmitted, call) => {
        if (call.invocationId.endsWith(":retry")) {
          retrying = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error("AI_GATEWAY_PROVIDER_UNAVAILABLE");
        }
        return options.generate(request, prompt, onAdmitted, call);
      },
    });
    await capture.start(context.request);
    while (!retrying) await new Promise((resolve) => setTimeout(resolve, 5));
    await context.turn("owner", "另一个对话里随便聊聊。", "run-parallel");
    context.outputs.push('{"memories":[]}', P3_5_MEMORY);
    await capture.start(context.requestFor("run-parallel"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.calls.map(({ invocationId }) => invocationId)).not.toContain(
      "memory-capture:run-parallel:backlog",
    );
    release();
    await capture.stop();
    expect(await activeMemories(context)).toEqual([]);
    expect(backlogRows(context)).toEqual([
      expect.objectContaining({ generationId: "memory-capture:run-memory-capture", attempts: 0 }),
    ]);
  });
});
