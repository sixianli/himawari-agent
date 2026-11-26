import path from "node:path";
import {
  DurableMemoryService,
  memorySources,
  PERCEPTION_CONFIGURATION_DEFAULTS,
  PERCEPTION_REASON_CODES,
  PERCEPTION_RECORD_ID_PATTERN,
  type PerceptionExtractionModel,
  type ProductMemoryRecord,
  type VerifiedPerceptionProposal,
} from "@himawari-agent/application";
import { createMemoryGenerationId, createThreadId } from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionInbox } from "../../apps/agent-service/src/production-inbox.ts";
import { createPerceptionExtractionService } from "../../apps/agent-service/src/production-perception-extraction.ts";
import {
  PERCEPTION_EPISODE_EVENT_KIND,
  ProductionPerceptionInbox,
} from "../../apps/agent-service/src/production-perception-inbox.ts";
import { ProductionReminderWriter } from "../../apps/agent-service/src/production-reminder-writer.ts";
import { PERCEPTION_MEMORY_SOURCE_ID } from "../../packages/persistence-sqlite/src/memory-source-types.ts";
import {
  agentId,
  type Harness,
  harness,
  ownerId,
  ownerSpokenAt,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { ingest, perceptionScope, utterance } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

const THREAD_ID = createThreadId("thread-perception-extract");
const GENERATION_ID = createMemoryGenerationId("generation-perception-extract");
const SINCE = "1970-01-01T00:00:00.000Z";

const embedder: Embedder = {
  model: "fixture-embedding",
  dimensions: 2,
  async embedQuery() {
    return new Float32Array([1, 0]);
  },
  async embedDocument() {
    return new Float32Array([1, 0]);
  },
};

interface Scripted {
  readonly prompts: string[];
  readonly replies: (string | Error)[];
  costMicros: number;
  estimateMicros: number;
}

async function setup(options: { readonly withGeneration?: boolean } = {}) {
  const h = await harness();
  const client = await pairAndConfirm(h);
  h.voiceGates.current = ownerSpokenAt(800);
  if (options.withGeneration !== false) {
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      const now = h.clock.now();
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(THREAD_ID, ownerId, agentId, now, now);
      database
        .prepare(
          `INSERT INTO thread_checkpoint_jobs (
            id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
            policy_version, status, attempt_count, requested_at
          ) VALUES ('checkpoint-perception', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
        )
        .run(GENERATION_ID, ownerId, agentId, THREAD_ID, now);
      database
        .prepare(
          `INSERT INTO memory_generations (
            id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
            model_descriptor_ref, policy_version, output_ref
          ) VALUES (?, 'checkpoint-perception', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
        )
        .run(GENERATION_ID, ownerId, agentId, THREAD_ID);
    } finally {
      database.close();
    }
  }
  const payloads = h.repository.payloadStore(ownerId, agentId);
  const readText = async (ref: string) => {
    const text = await h.readText(ref);
    if (text === undefined) throw new Error("MEMORY_PAYLOAD_MISSING");
    return text;
  };
  const memory = new DurableMemoryService({
    state: h.repository.productMemoryState(),
    jobs: h.repository.memoryProjectionJobs(),
    provider: new HybridMemoryProvider({
      index: h.repository.memoryIndex(),
      embedder,
      embeddableClassifications: ["public", "private", "sensitive"],
      minimumSimilarity: 0.45,
      now: () => h.clock.now(),
    }),
    content: { readText },
    workerId: "perception-extract-worker",
    now: () => h.clock.now(),
  });
  const reminders = new ProductionReminderWriter({
    configuration: perceptionScope,
    memory,
    state: h.repository.productMemoryState(),
    book: h.repository.memoryBook(),
    reminders: h.repository.memoryReminders(),
    payloads,
    protector: h.protector,
    clock: h.clock,
    timeZone: "Asia/Tokyo",
  });
  const scripted: Scripted = { prompts: [], replies: [], costMicros: 120, estimateMicros: 200 };
  const model: PerceptionExtractionModel = {
    estimateMicros: () => scripted.estimateMicros,
    generate: async ({ prompt }) => {
      scripted.prompts.push(prompt);
      const reply = scripted.replies.shift();
      if (reply === undefined) throw new Error("MODEL_NOT_SCRIPTED");
      if (reply instanceof Error) throw reply;
      return { output: reply, costMicros: scripted.costMicros };
    },
  };
  const received: VerifiedPerceptionProposal[] = [];
  const configuration = { current: PERCEPTION_CONFIGURATION_DEFAULTS };
  const inbox = new ProductionInbox({
    scope: perceptionScope,
    store: h.repository.inbox(),
    payloads,
    protector: h.protector,
    clock: h.clock,
  });
  const episodes = new ProductionPerceptionInbox({
    scope: perceptionScope,
    store: h.repository.perception(),
    timeZone: "Asia/Tokyo",
    clock: h.clock,
  });
  episodes.registerSource(inbox.sources);
  episodes.attach(inbox);
  const service = createPerceptionExtractionService({
    onEpisode: (input) => episodes.episode(input),
    scope: perceptionScope,
    store: h.repository.perception(),
    model,
    memory,
    memories: h.repository.productMemoryState(),
    book: h.repository.memoryBook(),
    reminders,
    proposals: {
      receive: async (proposals) => {
        received.push(...proposals);
      },
    },
    payloads,
    protector: h.protector,
    tag: async () => sequentialPlaceholderTag(),
    configuration: () => configuration.current,
    deviceConfiguration: () => h.configuration.current,
    timeZone: "Asia/Tokyo",
    clock: h.clock,
  });
  const closeEpisode = () =>
    h.clock.advance((PERCEPTION_CONFIGURATION_DEFAULTS.episodeSilenceSeconds + 60) * 1000);
  const memories = () => h.repository.productMemoryState().listActive(ownerId, agentId);
  const ledger = () =>
    h.repository.decisionLedger().list({
      ...perceptionScope,
      kind: "memory_candidate",
      since: SINCE,
      limit: 100,
    });
  const extraction = async () => {
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      return database
        .prepare(
          `SELECT status, attempts, record_count AS recordCount, error_code AS errorCode,
                  cost_micros AS costMicros FROM perception_extractions`,
        )
        .all() as {
        status: string;
        attempts: number;
        recordCount: number;
        errorCode: string | null;
        costMicros: number;
      }[];
    } finally {
      database.close();
    }
  };
  const inboxRows = () => {
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      return database
        .prepare(
          `SELECT source_ref AS sourceRef, source_version AS sourceVersion,
                  external_content AS externalContent, priority, summary_ref AS summaryRef
           FROM inbox_events WHERE source_kind = ?`,
        )
        .all(PERCEPTION_EPISODE_EVENT_KIND) as {
        sourceRef: string;
        sourceVersion: string;
        externalContent: number;
        priority: number;
        summaryRef: string;
      }[];
    } finally {
      database.close();
    }
  };
  return {
    h,
    client,
    service,
    inboxRows,
    scripted,
    received,
    configuration,
    closeEpisode,
    memories,
    ledger,
    extraction,
    reminders,
  };
}

function reply(value: {
  candidates?: unknown[];
  proposals?: unknown[];
  doneHints?: unknown[];
}): string {
  return JSON.stringify({ candidates: [], proposals: [], doneHints: [], ...value });
}

function owner(h: Harness, text: string, seconds = 0, extra: Record<string, unknown> = {}) {
  const record = utterance(h, text, { seconds, speaker: { kind: "owner", score: 900 } });
  return { ...record, evidence: { ...record.evidence, ...extra } };
}

function candidate(text: string, quote: string, recordIds: string[], overrides = {}) {
  return {
    text,
    category: "preference",
    confidence: 950,
    about: "owner",
    quote,
    recordIds,
    ...overrides,
  };
}

describe("[iOS-5] perception extraction turns a finished episode into memories and proposals", () => {
  it("waits until the episode is over, then stores what the owner said as a memory with a perception source", async () => {
    const s = await setup();
    const said = owner(s.h, "我不吃香菜，以后点菜都别放");
    await ingest(s.h, s.client, [said]);
    expect((await s.service.runOnce()).episodes).toBe(0);
    expect(s.scripted.prompts).toEqual([]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({ candidates: [candidate("主人不吃香菜", "我不吃香菜", [said.id])] }),
    );
    const report = await s.service.runOnce();
    expect(report).toMatchObject({
      episodes: 1,
      done: 1,
      memories: 1,
      tentative: 0,
      costMicros: 120,
    });
    expect(s.scripted.prompts[0]).toContain("我不吃香菜，以后点菜都别放");
    const [memory] = await s.memories();
    expect(memory?.id.startsWith("memory:perception:")).toBe(true);
    expect(memory?.sourceRefs).toEqual([said.id]);
    expect(memory?.sourceTypes).toEqual({ [said.id]: "perception" });
    expect(memory?.attributes?.tentative).toBeUndefined();
    expect(await s.h.readText(memory?.contentRef ?? "")).toBe("主人不吃香菜");
    expect((await s.ledger()).map(({ outcome, reasonCode }) => ({ outcome, reasonCode }))).toEqual([
      { outcome: "kept", reasonCode: PERCEPTION_REASON_CODES.committed },
    ]);
    expect(await s.extraction()).toEqual([
      { status: "done", attempts: 1, recordCount: 1, errorCode: null, costMicros: 120 },
    ]);
    expect((await s.service.runOnce()).episodes).toBe(0);
    expect(s.scripted.prompts).toHaveLength(1);
  });

  it("keeps things that were not said by the owner, or scored low, only as tentative memories", async () => {
    const s = await setup();
    const mine = owner(s.h, "我可能想换一份工作吧");
    const other = utterance(s.h, "他下个月要搬去大阪", {
      seconds: 5,
      speaker: { kind: "unknown" },
    });
    await ingest(s.h, s.client, [mine, other]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({
        candidates: [
          candidate("主人在考虑换工作", "我可能想换一份工作吧", [mine.id], {
            category: "goal",
            confidence: 300,
          }),
          candidate("主人下个月要搬去大阪", "他下个月要搬去大阪", [other.id], {
            category: "event",
          }),
        ],
      }),
    );
    const report = await s.service.runOnce();
    expect(report).toMatchObject({ memories: 0, tentative: 2 });
    const memories = await s.memories();
    expect(memories).toHaveLength(2);
    expect(memories.every(({ attributes }) => attributes?.tentative === true)).toBe(true);
    expect((await s.ledger()).map(({ reasonCode }) => reasonCode).sort()).toEqual([
      PERCEPTION_REASON_CODES.belowThreshold,
      PERCEPTION_REASON_CODES.keptTentative,
    ]);
  });

  it("discards a candidate whose quote is not word for word in the cited record", async () => {
    const s = await setup();
    const said = owner(s.h, "周末想去爬山");
    const second = owner(s.h, "下雨就算了", 3);
    await ingest(s.h, s.client, [said, second]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({
        candidates: [
          candidate("主人周末一定去爬山", "周末一定去爬山", [said.id]),
          candidate("主人周末想去爬山", "周末想去爬山", [second.id]),
          candidate("主人周末想爬山，下雨不去", "周末想去爬山下雨就算了", [said.id, second.id]),
        ],
      }),
    );
    const report = await s.service.runOnce();
    expect(report).toMatchObject({ memories: 0, tentative: 0, discarded: 3 });
    expect(await s.memories()).toEqual([]);
    expect((await s.ledger()).map(({ outcome, reasonCode }) => ({ outcome, reasonCode }))).toEqual(
      [1, 2, 3].map(() => ({
        outcome: "discarded",
        reasonCode: PERCEPTION_REASON_CODES.quoteUnverified,
      })),
    );
  });

  it("never sends a card number to the model and refuses a candidate built on the masked part", async () => {
    const s = await setup();
    const said = owner(s.h, "我的银行卡号是 4111 1111 1111 1111 你记一下");
    await ingest(s.h, s.client, [said]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({
        candidates: [
          candidate("主人的银行卡号是 4111 1111 1111 1111", "4111 1111 1111 1111", [said.id]),
        ],
      }),
    );
    const report = await s.service.runOnce();
    expect(s.scripted.prompts[0]).not.toContain("4111 1111 1111 1111");
    expect(report).toMatchObject({ memories: 0, tentative: 0, discarded: 1 });
    expect(await s.memories()).toEqual([]);
  });

  it("marks a proposal as the owner's own only when nothing else was heard in the same stretch", async () => {
    const s = await setup();
    const plan = owner(s.h, "周六中午和小林吃饭，得提前订位");
    await ingest(s.h, s.client, [plan]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({
        proposals: [
          { what: "周六中午和小林吃饭前替主人订位", quote: "得提前订位", recordIds: [plan.id] },
        ],
      }),
    );
    await s.service.runOnce();
    expect(s.received.map(({ trust, source }) => ({ trust, source }))).toEqual([
      {
        trust: "owner",
        source: {
          recordType: plan.type,
          origin: "owner_spoken",
          captureSource: plan.captureSource,
          occurredAtDevice: plan.occurredAt,
          speakerKind: "owner",
          speakerRef: null,
        },
      },
    ]);
  });

  it("hands next-step proposals and finished to-dos to the proposal port without acting on them", async () => {
    const s = await setup();
    const todo = await s.reminders.create({
      key: "weekly-report",
      text: "交周报",
      due: "2026-11-13T18:00",
      repeat: "none",
    });
    const plan = owner(s.h, "周六中午和小林吃饭，得提前订位");
    const done = owner(s.h, "周报我刚才已经发出去了", 4);
    const web = utterance(s.h, "限时优惠，今晚十二点前下单", {
      seconds: 8,
      speaker: { kind: "unknown" },
    });
    await ingest(s.h, s.client, [plan, done, web]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({
        proposals: [
          { what: "周六中午和小林吃饭前替主人订位", quote: "得提前订位", recordIds: [plan.id] },
          { what: "今晚十二点前替主人下单", quote: "今晚十二点前下单", recordIds: [web.id] },
          { what: "替主人给小林发消息确认", quote: "小林说周六可以", recordIds: [plan.id] },
        ],
        doneHints: [
          { id: todo.reminderId, quote: "周报我刚才已经发出去了", recordIds: [done.id] },
          { id: "reminder:not-open", quote: "周报我刚才已经发出去了", recordIds: [done.id] },
        ],
      }),
    );
    const report = await s.service.runOnce();
    expect(report).toMatchObject({ proposals: 3, discarded: 2 });
    expect(s.scripted.prompts[0]).toContain(todo.reminderId);
    expect(
      s.received.map(
        ({ kind, what, todoId, trust, sourceKind, sourceVersion, quotedRecordId }) => ({
          kind,
          what,
          todoId,
          trust,
          sourceKind,
          sourceVersion,
          quotedRecordId,
        }),
      ),
    ).toEqual([
      {
        kind: "next_step",
        what: "周六中午和小林吃饭前替主人订位",
        todoId: null,
        trust: "external",
        sourceKind: "perception_episode",
        sourceVersion: "3",
        quotedRecordId: plan.id,
      },
      {
        kind: "next_step",
        what: "今晚十二点前替主人下单",
        todoId: null,
        trust: "external",
        sourceKind: "perception_episode",
        sourceVersion: "3",
        quotedRecordId: web.id,
      },
      {
        kind: "todo_done",
        what: null,
        todoId: todo.reminderId,
        trust: "external",
        sourceKind: "perception_episode",
        sourceVersion: "3",
        quotedRecordId: done.id,
      },
    ]);
    const listed = await s.reminders.list();
    expect(listed.reminders.map(({ reminderId }) => reminderId)).toEqual([todo.reminderId]);
    const proposalRows = await s.h.repository.decisionLedger().list({
      ...perceptionScope,
      kind: "proposal",
      since: SINCE,
      limit: 100,
    });
    expect(
      proposalRows.map(({ outcome, reasonCode }) => `${outcome}:${reasonCode}`).sort(),
    ).toEqual(
      [
        `not_proposed:${PERCEPTION_REASON_CODES.quoteUnverified}`,
        `not_proposed:${PERCEPTION_REASON_CODES.quoteUnverified}`,
        `proposed:${PERCEPTION_REASON_CODES.doneProposed}`,
        `proposed:${PERCEPTION_REASON_CODES.proposed}`,
        `proposed:${PERCEPTION_REASON_CODES.proposed}`,
      ].sort(),
    );
    expect(await s.ledger()).toEqual([]);
  });

  it("leaves out what the owner said as a spoken command", async () => {
    const s = await setup();
    const command = owner(s.h, "帮我把明天的会改到下午", 0, { utteranceId: "utt-command-1" });
    const chat = owner(s.h, "我最近在学法语", 5, { utteranceId: "utt-chat-2" });
    await ingest(s.h, s.client, [command, chat]);
    await s.h.perception.recordCommandUtterance(perceptionScope, "utt-command-1");
    s.closeEpisode();
    s.scripted.replies.push(reply({}));
    await s.service.runOnce();
    expect(s.scripted.prompts[0]).toContain("我最近在学法语");
    expect(s.scripted.prompts[0]).not.toContain("帮我把明天的会改到下午");
  });

  it("stops at the daily cost limit, says so, and picks the episode up the next day", async () => {
    const s = await setup();
    const said = owner(s.h, "我对花生过敏");
    await ingest(s.h, s.client, [said]);
    s.closeEpisode();
    s.scripted.estimateMicros = 2_000_000;
    const blocked = await s.service.runOnce();
    expect(blocked).toMatchObject({ episodes: 1, waitingBudget: 1, done: 0 });
    expect(s.scripted.prompts).toEqual([]);
    expect(await s.extraction()).toEqual([
      expect.objectContaining({
        status: "waiting_budget",
        errorCode: "PERCEPTION_MODEL_BUDGET_REACHED",
      }),
    ]);
    expect((await s.service.runOnce()).episodes).toBe(0);
    s.h.clock.advance(86_400_000);
    s.scripted.estimateMicros = 200;
    s.scripted.replies.push(
      reply({
        candidates: [
          candidate("主人对花生过敏", "我对花生过敏", [said.id], { category: "health" }),
        ],
      }),
    );
    expect(await s.service.runOnce()).toMatchObject({ episodes: 1, done: 1 });
    expect(await s.memories()).toHaveLength(1);
  });

  it("does not count days spent waiting for the cost limit as failed attempts", async () => {
    const s = await setup();
    await ingest(s.h, s.client, [owner(s.h, "我对花生过敏")]);
    s.closeEpisode();
    s.configuration.current = { ...PERCEPTION_CONFIGURATION_DEFAULTS, extractMaximumAttempts: 2 };
    s.scripted.estimateMicros = 2_000_000;
    for (let day = 0; day < 3; day += 1) {
      expect(await s.service.runOnce()).toMatchObject({ waitingBudget: 1 });
      s.h.clock.advance(86_400_000);
    }
    s.scripted.estimateMicros = 200;
    s.scripted.replies.push(new Error("MODEL_DOWN"));
    expect(await s.service.runOnce()).toMatchObject({ retry: 1, failed: 0 });
    expect(await s.extraction()).toEqual([
      expect.objectContaining({ status: "retry", attempts: 1, errorCode: "MODEL_DOWN" }),
    ]);
  });

  it("hands over the same proposal id and writes no second ledger row when an episode is extracted again", async () => {
    const s = await setup();
    const plan = owner(s.h, "周六中午和小林吃饭，得提前订位");
    await ingest(s.h, s.client, [plan]);
    s.closeEpisode();
    const answer = reply({
      candidates: [candidate("主人周六中午和小林吃饭", "周六中午和小林吃饭", [plan.id])],
      proposals: [
        { what: "周六中午和小林吃饭前替主人订位", quote: "得提前订位", recordIds: [plan.id] },
      ],
    });
    s.scripted.replies.push(answer, answer);
    expect(await s.service.runOnce()).toMatchObject({ done: 1, proposals: 1 });
    const database = openQualifiedDatabase(path.join(s.h.stateRoot, "product.sqlite"));
    try {
      database.prepare("UPDATE perception_extractions SET record_count = record_count + 1").run();
    } finally {
      database.close();
    }
    expect(await s.service.runOnce()).toMatchObject({ done: 1, proposals: 1 });
    expect(s.received).toHaveLength(2);
    expect(new Set(s.received.map(({ id }) => id)).size).toBe(1);
    expect(await s.memories()).toHaveLength(1);
    const rows = await s.h.repository.decisionLedger().list({
      ...perceptionScope,
      kind: "proposal",
      since: SINCE,
      limit: 100,
    });
    expect(rows).toHaveLength(1);
    expect(await s.ledger()).toHaveLength(1);
  });

  it("retries a failed model call a limited number of times and then marks the episode failed", async () => {
    const s = await setup();
    await ingest(s.h, s.client, [owner(s.h, "今天有点累")]);
    s.closeEpisode();
    s.configuration.current = { ...PERCEPTION_CONFIGURATION_DEFAULTS, extractMaximumAttempts: 2 };
    s.scripted.replies.push("这不是 JSON");
    expect(await s.service.runOnce()).toMatchObject({ retry: 1 });
    expect(await s.extraction()).toEqual([
      expect.objectContaining({
        status: "retry",
        attempts: 1,
        errorCode: "PERCEPTION_EXTRACT_OUTPUT_INVALID",
      }),
    ]);
    expect((await s.service.runOnce()).episodes).toBe(0);
    s.h.clock.advance((PERCEPTION_CONFIGURATION_DEFAULTS.extractRetrySeconds + 1) * 1000);
    s.scripted.replies.push(new Error("MODEL_DOWN"));
    expect(await s.service.runOnce()).toMatchObject({ failed: 1 });
    expect(await s.extraction()).toEqual([
      expect.objectContaining({ status: "failed", attempts: 2, errorCode: "MODEL_DOWN" }),
    ]);
    s.h.clock.advance(86_400_000);
    expect((await s.service.runOnce()).episodes).toBe(0);
    expect(await s.memories()).toEqual([]);
  });

  it("splits a long episode by the size limit and still checks each quote against its own part", async () => {
    const s = await setup();
    const records = [0, 1, 2].map((index) =>
      owner(s.h, `第${index}件事：${"说明".repeat(300)}`, index * 3),
    );
    await ingest(s.h, s.client, records);
    s.closeEpisode();
    s.h.configuration.current = {
      ...s.h.configuration.current,
      limits: { ...s.h.configuration.current.limits, "perception.extract.max_chars": 1000 },
    };
    s.scripted.replies.push(
      reply({ candidates: [candidate("第0件事", "第0件事", [records[0]?.id ?? ""])] }),
      reply({ candidates: [candidate("错放的第0件事", "第0件事", [records[0]?.id ?? ""])] }),
      reply({}),
    );
    const report = await s.service.runOnce();
    expect(s.scripted.prompts).toHaveLength(3);
    expect(report).toMatchObject({ done: 1, memories: 1, discarded: 1, costMicros: 360 });
  });
});

describe("[ADR-0285] a finished episode goes to the main conversation's inbox", () => {
  it("puts the episode in the inbox once, with its id, time and kinds but none of what was heard", async () => {
    const s = await setup();
    const said = owner(s.h, "我不吃香菜，以后点菜都别放");
    await ingest(s.h, s.client, [said]);
    await s.service.runOnce();
    expect(s.inboxRows()).toEqual([]);
    s.closeEpisode();
    s.scripted.replies.push(reply({}));
    await s.service.runOnce();
    const rows = s.inboxRows();
    expect(rows).toMatchObject([{ sourceVersion: "1", externalContent: 1, priority: 5 }]);
    const summary = (await s.h.readText(rows[0]?.summaryRef ?? "")) ?? "";
    expect(summary).toContain(rows[0]?.sourceRef ?? "missing");
    expect(summary).toContain("speech.utterance");
    expect(summary).toContain("perception_read");
    expect(summary).not.toContain("香菜");
    s.scripted.replies.push(reply({}));
    await s.service.runOnce();
    expect(s.inboxRows()).toHaveLength(1);
  });

  it("REVERSE: while perception is paused, no episode enters the inbox", async () => {
    const s = await setup();
    await ingest(s.h, s.client, [owner(s.h, "明天上午十点开会")]);
    s.closeEpisode();
    const store = s.h.repository.perception();
    const current = await store.readSettings(perceptionScope);
    const now = s.h.clock.now();
    await store.writeSettings({
      ...perceptionScope,
      expectedRevision: current.revision,
      now,
      values: {
        disabledSenses: current.disabledSenses,
        pausedFrom: now,
        pausedUntil: new Date(Date.parse(now) + 3_600_000).toISOString(),
        retentionDays: current.retentionDays,
        limitOverrides: current.limitOverrides,
      },
      decisions: [],
    });
    s.scripted.replies.push(reply({}));
    expect((await s.service.runOnce()).episodes).toBe(1);
    expect(s.inboxRows()).toEqual([]);
  });
});

describe("[iOS-5] a memory's sources carry their type", () => {
  it("stores perception sources with their type and refuses an unknown type or a malformed id", async () => {
    const s = await setup();
    const said = owner(s.h, "我不吃香菜");
    await ingest(s.h, s.client, [said]);
    s.closeEpisode();
    s.scripted.replies.push(
      reply({ candidates: [candidate("主人不吃香菜", "我不吃香菜", [said.id])] }),
    );
    await s.service.runOnce();
    const [stored] = await s.memories();
    if (!stored) throw new Error("memory missing");
    expect(memorySources(stored)).toEqual([{ type: "perception", id: said.id }]);
    const state = s.h.repository.productMemoryState();
    const copy = (suffix: string, extra: Partial<ProductMemoryRecord>) =>
      state.save(
        { ...stored, id: `${stored.id}-${suffix}` as ProductMemoryRecord["id"], ...extra },
        null,
      );
    const { sourceTypes: _types, ...untyped } = stored;
    const plain = await state.save(
      {
        ...untyped,
        id: `${stored.id}-plain` as ProductMemoryRecord["id"],
        sourceRefs: ["payload-ref-1"],
      },
      null,
    );
    expect(plain.sourceTypes).toBeUndefined();
    expect(memorySources(plain)).toEqual([{ type: "reference", id: "payload-ref-1" }]);
    const mixed = await copy("mixed", {
      sourceRefs: ["payload-ref-1", said.id],
      sourceTypes: { [said.id]: "perception" },
    });
    expect(memorySources(mixed)).toEqual([
      { type: "perception", id: said.id },
      { type: "reference", id: "payload-ref-1" },
    ]);
    await expect(
      copy("bad-id", {
        sourceRefs: ["not-a-record"],
        sourceTypes: { "not-a-record": "perception" },
      }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    expect(PERCEPTION_MEMORY_SOURCE_ID.source).toBe(PERCEPTION_RECORD_ID_PATTERN.source);
    expect(PERCEPTION_MEMORY_SOURCE_ID.flags).toBe(PERCEPTION_RECORD_ID_PATTERN.flags);
    const gone = owner(s.h, "这句话随后被删掉", 30);
    await ingest(s.h, s.client, [gone]);
    const database = openQualifiedDatabase(path.join(s.h.stateRoot, "product.sqlite"));
    try {
      expect(
        database
          .prepare("UPDATE perception_records SET status = 'deleted' WHERE id IN (?, ?)")
          .run(gone.id, said.id).changes,
      ).toBe(2);
    } finally {
      database.close();
    }
    await expect(
      copy("gone", { sourceRefs: [gone.id], sourceTypes: { [gone.id]: "perception" } }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    await expect(
      state.save(
        {
          ...stored,
          revision: stored.revision + 1,
          sourceRefs: [said.id],
          sourceTypes: { [said.id]: "perception" },
        },
        stored.revision,
      ),
    ).resolves.toBeDefined();
    const ghost = `perception:${"0".repeat(32)}`;
    await expect(
      copy("ghost", { sourceRefs: [ghost], sourceTypes: { [ghost]: "perception" } }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    await expect(
      copy("unknown-type", {
        sourceRefs: [said.id],
        sourceTypes: { [said.id]: "telepathy" as "perception" },
      }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    await expect(
      copy("stray-type", {
        sourceRefs: ["payload-ref-1"],
        sourceTypes: { [said.id]: "perception" },
      }),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    expect((await s.memories()).map(({ id }) => id).sort()).toEqual(
      [stored.id, plain.id, mixed.id].sort(),
    );
  });
});
