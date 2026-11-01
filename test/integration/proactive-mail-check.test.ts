import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProactiveSeal,
  type ModelDescriptor,
  type ModelInvocationEvent,
  type ProactiveMailCheckOptions,
  ProactiveMailCheckService,
  type ProactiveMemoryRecall,
  type ProactiveSourceItem,
  proactivePrompt,
  readProactiveOverview,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
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
  ScriptedModelPort,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-proactive");
const AGENT_ID = createAgentId("agent-proactive");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const TIME_ZONE = "Asia/Tokyo";
const NOV_4_10AM_JST = "2026-11-04T01:00:00.000Z";
const MODEL_REF = "proactive-test-model";

const descriptor: ModelDescriptor = {
  ref: MODEL_REF,
  provider: "deterministic",
  model: MODEL_REF,
  version: "1.0.0",
  routingClass: "primary",
  priority: 10,
  disclosure: "trusted_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: null,
};

interface Scripted {
  readonly id: string;
  readonly result: "act" | "know" | "check" | "ignore";
  readonly confidence?: "sure" | "unsure";
  readonly todo?: string;
  readonly priority?: "high" | "medium" | "low" | null;
  readonly dueAt?: string | null;
  readonly reason?: string;
  readonly usedMemoryIds?: readonly string[];
}

function mail(
  messageId: string,
  overrides: Partial<ProactiveSourceItem> = {},
): ProactiveSourceItem {
  return {
    source: "gmail",
    messageId,
    threadId: overrides.threadId ?? `thread-${messageId}`,
    from: "Friend <friend@gmail.com>",
    fromAddress: "friend@gmail.com",
    subject: "週末どうする？",
    snippet: "土曜日に会える？",
    link: `https://mail.google.com/mail/u/0/#all/${messageId}`,
    receivedAt: "2026-11-04T00:30:00.000Z",
    categories: [],
    sentByOwner: false,
    ...overrides,
  };
}

describe("proactive Gmail check acceptance", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const repositories: SqliteProductStateRepository[] = [];
  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function harness(
    options: {
      dailyCostMicros?: number;
      estimate?: number;
      cost?: number;
      importantSenders?: string[];
      enabled?: boolean;
      batchSize?: number;
      outputTokenLimit?: number;
      memory?: ProactiveMemoryRecall;
      memoryLimits?: ProactiveMailCheckOptions["memoryLimits"];
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-proactive-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOV_4_10AM_JST);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    repositories.push(repository);
    const store = repository.proactive();
    const ids = new DeterministicIdGenerator();
    const protector = new DeterministicPayloadProtector();
    const payloadStore = repository.payloadStore(OWNER_ID, AGENT_ID);
    const seal = createProactiveSeal({ payloads: payloadStore, protector, ids });
    const written = new Set<string>();
    const writePayload = async (ref: string, content: string) => {
      await payloadStore.put(
        await protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(content),
          createdAt: clock.now(),
        }),
      );
      written.add(ref);
    };
    const readPayload = async (ref: string) => {
      const payload = await payloadStore.get(ref);
      if (!payload) return undefined;
      return new TextDecoder().decode(await protector.unprotect({ payload }));
    };
    const countPayloads = () => {
      const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      try {
        return Number(database.prepare("SELECT COUNT(*) FROM payloads").pluck().get());
      } finally {
        database.close();
      }
    };
    await store.writeSettings({
      ...scope,
      enabled: options.enabled ?? true,
      quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
      importantSenders: options.importantSenders ?? ["smbc.co.jp"],
      now: clock.now(),
    });
    await store.saveConnection({
      ...scope,
      connection: {
        source: "gmail",
        accountRef: await seal.seal({ ...scope, text: "andy@example.com", at: clock.now() }),
        tokenRef: await seal.seal({ ...scope, text: "refresh-token", at: clock.now() }),
        cursor: "history-1",
        status: "connected",
        connectedAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const reader = {
      source: "gmail" as const,
      items: [] as ProactiveSourceItem[],
      nextCursor: "history-2",
      calls: [] as (string | null)[],
      async fetch(input: { cursor: string | null }) {
        reader.calls.push(input.cursor);
        return { kind: "items" as const, items: reader.items, cursor: reader.nextCursor };
      },
    };
    const outputs = new Map<string, string>();
    const prompts: string[] = [];
    const models: ScriptedModelPort[] = [];
    let scripted = new ScriptedModelPort([descriptor], []);
    const queued: ScriptedModelPort[] = [];
    const script = (entries: readonly Scripted[], cost = options.cost ?? 300) => {
      const ref = `output-${outputs.size + 1}`;
      outputs.set(
        ref,
        JSON.stringify({
          items: entries.map((entry) => ({
            confidence: "sure",
            todo: "",
            priority: null,
            dueAt: null,
            reason: "",
            ...entry,
          })),
        }),
      );
      const events: ModelInvocationEvent[] = [
        { type: "model.started", invocationId: "scripted", occurredAt: clock.now() },
        {
          type: "model.output",
          invocationId: "scripted",
          sequence: 1,
          payloadRef: ref,
          occurredAt: clock.now(),
        },
        {
          type: "model.completed",
          invocationId: "scripted",
          inputTokens: 100,
          outputTokens: 50,
          costMicros: cost,
          latencyMs: 10,
          occurredAt: clock.now(),
        },
      ];
      scripted = new ScriptedModelPort([descriptor], events);
      models.push(scripted);
      queued.push(scripted);
    };
    const scriptRaw = (
      ending: "completed" | "unfinished" | { failedWith: string },
      text?: string,
      outputTokens = 50,
    ) => {
      const ref = `output-${outputs.size + 1}`;
      if (text !== undefined) outputs.set(ref, text);
      const events: ModelInvocationEvent[] = [
        { type: "model.started", invocationId: "scripted", occurredAt: clock.now() },
        ...(text === undefined
          ? []
          : [
              {
                type: "model.output" as const,
                invocationId: "scripted",
                sequence: 1,
                payloadRef: ref,
                occurredAt: clock.now(),
              },
            ]),
        ending === "completed"
          ? {
              type: "model.completed",
              invocationId: "scripted",
              inputTokens: 100,
              outputTokens,
              costMicros: options.cost ?? 300,
              latencyMs: 10,
              occurredAt: clock.now(),
            }
          : typeof ending === "object"
            ? {
                type: "model.failed",
                invocationId: "scripted",
                errorCode: ending.failedWith,
                retryable: true,
                latencyMs: 10,
                occurredAt: clock.now(),
              }
            : { type: "model.started", invocationId: "scripted", occurredAt: clock.now() },
      ];
      scripted = new ScriptedModelPort([descriptor], events);
      models.push(scripted);
      queued.push(scripted);
    };
    const limits = {
      perCheckMs: 180_000,
      dailyCostMicros: options.dailyCostMicros ?? 1_000_000,
      estimate: options.estimate ?? 100,
      estimateCostMicros: () => limits.estimate,
    };
    const recording = { failing: false };
    const service = new ProactiveMailCheckService({
      scope,
      store: {
        ...store,
        record: async (input: Parameters<typeof store.record>[0]) => {
          if (recording.failing) throw new Error("RECORD_FAILED");
          return store.record(input);
        },
      },
      seal,
      reader,
      model: {
        get model() {
          return queued.shift() ?? scripted;
        },
        modelRef: MODEL_REF,
        async prepare({ invocationId, prompt }) {
          prompts.push(prompt);
          const inputRef = `input-${invocationId}`;
          await writePayload(inputRef, prompt);
          for (const [ref, content] of outputs)
            if (!written.has(ref)) await writePayload(ref, content);
          return {
            runId: `proactive:${invocationId}` as never,
            inputRef,
            allowedDisclosureRef: "proactive-gmail",
            secretHandleRefs: [],
            release: async () => undefined,
          };
        },
        readOutput: async (ref) => (await readPayload(ref)) ?? "",
        release: async (refs) => {
          for (const ref of refs) await payloadStore.delete(ref);
        },
      },
      limits,
      timeZone: TIME_ZONE,
      clock,
      ids,
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.memoryLimits ? { memoryLimits: options.memoryLimits } : {}),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.outputTokenLimit === undefined
        ? {}
        : { outputTokenLimit: options.outputTokenLimit }),
    });
    const overview = () =>
      readProactiveOverview({
        scope,
        source: "gmail",
        store,
        seal,
        timeZone: TIME_ZONE,
        dailyCostMicros: options.dailyCostMicros ?? 1_000_000,
        now: clock.now(),
        feedback: async () => [],
      });
    const invocations = () =>
      models.reduce((total, model) => total + model.observedRequests().length, 0);
    return {
      clock,
      store,
      seal,
      reader,
      script,
      scriptRaw,
      service,
      overview,
      prompts,
      invocations,
      limits,
      readPayload,
      countPayloads,
      stateRoot,
      ledger: repository.decisionLedger(),
      payloadStore,
      query: (sql: string, ...parameters: unknown[]) => {
        const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
        try {
          return database.prepare(sql).all(...parameters) as Record<string, unknown>[];
        } finally {
          database.close();
        }
      },
      failRecords: () => {
        recording.failing = true;
        return () => {
          recording.failing = false;
        };
      },
    };
  }

  it("[PG-2] pushes one notification for an invoice due tomorrow with high priority", async () => {
    const h = await harness();
    h.reader.items = [
      mail("invoice", {
        from: "東京電力 <billing@tepco.co.jp>",
        fromAddress: "billing@tepco.co.jp",
        subject: "電気料金のお知らせ",
        snippet: "11/5 までにお支払いください",
      }),
    ];
    h.script([
      {
        id: "invoice",
        result: "act",
        todo: "11/5 前付电费",
        priority: "high",
        dueAt: "2026-11-05T23:59:00+09:00",
      },
    ]);
    const decision = await h.service.run();
    expect(decision).toMatchObject({ verdict: "pushed", reasonCode: "URGENT" });
    expect(decision?.counts).toMatchObject({ fetched: 1, judged: 1, act: 1, pushed: 1 });
    const ready = await h.store.listReadyPushes({ ...scope, now: h.clock.now(), limit: 10 });
    expect(ready).toHaveLength(1);
    expect(decision?.pushSourceKey).toBe(`proactive:${ready[0]?.id}`);
    const overview = await h.overview();
    expect(overview.insights).toHaveLength(1);
    expect(overview.insights[0]).toMatchObject({
      result: "act",
      summary: "11/5 前付电费",
      priority: "high",
      dueAt: "2026-11-05T14:59:00.000Z",
      pushed: true,
    });
    expect(ready[0]?.insightIds).toEqual([overview.insights[0]?.id]);
    expect(h.prompts[0]).toMatch(/当地今天是 [A-Za-z]+, 2026-11-04/u);
  });

  it("[PG-3] sends promotions and one-time code mails to the model; only spam and own mail are skipped", async () => {
    const h = await harness();
    h.reader.items = [
      mail("sale", { categories: ["promotions"], subject: "週末セール", snippet: "全品 20% オフ" }),
      mail("junk", { categories: ["spam"], subject: "当選しました" }),
      mail("mine", { sentByOwner: true }),
    ];
    h.script([{ id: "sale", result: "ignore" }]);
    const decision = await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(decision?.counts).toMatchObject({ fetched: 3, skipped: 2, judged: 1 });
    expect(h.prompts[0]).toContain('"id":"sale"');
    expect(h.prompts[0]).not.toContain('"id":"junk"');
    expect(h.prompts[0]).not.toContain('"id":"mine"');
    h.clock.advance(15 * 60_000);
    h.reader.items = [
      mail("code", { subject: "ログイン", snippet: "認証コードは 482913 です" }),
      mail("hello", { snippet: "明天一起吃饭吗" }),
    ];
    h.script([
      { id: "code", result: "ignore" },
      { id: "hello", result: "know", todo: "朋友约明天吃饭" },
    ]);
    const second = await h.service.run();
    expect(second?.counts).toMatchObject({ fetched: 2, skipped: 0, judged: 2 });
  });

  it("[PG-4] pushes an unclear ward office letter but only lists the same text from a friend", async () => {
    const h = await harness();
    const snippet = "添付ファイルをご確認ください";
    h.reader.items = [
      mail("ward", {
        from: "新宿区役所 <info@city.shinjuku.lg.jp>",
        fromAddress: "info@city.shinjuku.lg.jp",
        subject: "お知らせ",
        snippet,
      }),
    ];
    h.script([
      { id: "ward", result: "check", confidence: "unsure", reason: "区役所来信，内容在附件里" },
    ]);
    const official = await h.service.run();
    expect(official).toMatchObject({ verdict: "pushed" });
    h.clock.advance(15 * 60_000);
    h.reader.items = [mail("friend", { subject: "お知らせ", snippet })];
    h.script([{ id: "friend", result: "check", confidence: "unsure", reason: "看不出内容" }]);
    const friend = await h.service.run();
    expect(friend).toMatchObject({ verdict: "silent", pushSourceKey: null });
    const insights = (await h.overview()).insights;
    expect(insights.map(({ result, pushed, from }) => ({ result, pushed, from }))).toEqual(
      expect.arrayContaining([
        { result: "check", pushed: true, from: "新宿区役所 <info@city.shinjuku.lg.jp>" },
        { result: "check", pushed: false, from: "Friend <friend@gmail.com>" },
      ]),
    );
  });

  it("[PG-5] marks replied threads, ignores a rescan after history expiry and updates a thread on a new reply", async () => {
    const h = await harness();
    h.reader.items = [
      mail("school-1", {
        threadId: "school",
        from: "学校 <office@school.example>",
        fromAddress: "office@school.example",
        subject: "面談日程",
        snippet: "ご都合の良い日をお知らせください",
      }),
    ];
    h.script([{ id: "school-1", result: "act", todo: "回复面谈时间", priority: "medium" }]);
    await h.service.run();
    const first = (await h.overview()).insights;
    expect(first).toHaveLength(1);
    h.clock.advance(15 * 60_000);
    h.reader.items = [...h.reader.items];
    const rescan = await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(rescan).toMatchObject({ verdict: "silent", reasonCode: "NO_NEW_MAIL" });
    expect((await h.overview()).insights).toHaveLength(1);
    h.clock.advance(15 * 60_000);
    h.reader.items = [
      mail("school-2", {
        threadId: "school",
        from: "学校 <office@school.example>",
        fromAddress: "office@school.example",
        subject: "Re: 面談日程",
        snippet: "11/10 15時でいかがでしょうか",
        receivedAt: "2026-11-04T01:20:00.000Z",
      }),
    ];
    h.script([{ id: "school-2", result: "act", todo: "确认 11/10 15 点面谈", priority: "medium" }]);
    await h.service.run();
    const updated = (await h.overview()).insights;
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: first[0]?.id, summary: "确认 11/10 15 点面谈" });
    h.clock.advance(15 * 60_000);
    h.reader.items = [
      mail("andy-reply", {
        threadId: "school",
        from: "Andy <andy@example.com>",
        fromAddress: "andy@example.com",
        sentByOwner: true,
        receivedAt: "2026-11-04T01:40:00.000Z",
      }),
    ];
    await h.service.run();
    expect((await h.overview()).insights[0]).toMatchObject({
      id: first[0]?.id,
      status: "replied",
    });
    expect(h.invocations()).toBe(2);
  });

  it("[PG-6] has no per-check dollar limit: a costly estimate still runs while the day's limit allows", async () => {
    const h = await harness({ estimate: 500_000 });
    h.reader.items = [
      mail("invoice", {
        fromAddress: "billing@tepco.co.jp",
        subject: "電気料金",
        snippet: "11/5 までにお支払いください",
      }),
    ];
    h.script([
      {
        id: "invoice",
        result: "act",
        todo: "付电费",
        priority: "high",
        dueAt: "2026-11-05T14:59:00Z",
      },
    ]);
    const first = await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(first).toMatchObject({ verdict: "pushed" });
    h.limits.estimate = 1_000_000;
    h.reader.items = [mail("second", { snippet: "hello" })];
    h.clock.advance(15 * 60_000);
    const second = await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(second).toMatchObject({ verdict: "capped_daily", reasonCode: "DAILY_LIMIT" });
  });

  it("[PG-7] holds pushes during quiet hours, sends one combined notification at the end, and does nothing when switched off", async () => {
    const h = await harness();
    h.clock.set("2026-11-04T14:30:00.000Z");
    h.reader.items = [
      mail("rent", {
        fromAddress: "owner@estate.example",
        subject: "家賃",
        snippet: "明日までにお振込みください",
      }),
    ];
    h.script([
      {
        id: "rent",
        result: "act",
        todo: "明天前交房租",
        priority: "high",
        dueAt: "2026-11-05T15:00:00Z",
      },
    ]);
    const first = await h.service.run();
    expect(first).toMatchObject({ verdict: "deferred", reasonCode: "QUIET_HOURS" });
    h.clock.set("2026-11-04T15:30:00.000Z");
    h.reader.items = [
      mail("visa", {
        fromAddress: "notice@immi.example",
        subject: "在留カード",
        snippet: "明日の面談について",
      }),
    ];
    h.script([
      {
        id: "visa",
        result: "act",
        todo: "明天入管面谈",
        priority: "high",
        dueAt: "2026-11-05T01:00:00Z",
      },
    ]);
    const second = await h.service.run();
    expect(second?.pushSourceKey).toBe(first?.pushSourceKey);
    expect(
      await h.store.listReadyPushes({ ...scope, now: "2026-11-04T21:59:59.000Z", limit: 10 }),
    ).toEqual([]);
    const ready = await h.store.listReadyPushes({
      ...scope,
      now: "2026-11-04T22:00:00.000Z",
      limit: 10,
    });
    expect(ready).toHaveLength(1);
    expect(ready[0]?.readyAt).toBe("2026-11-04T22:00:00.000Z");
    expect(ready[0]?.insightIds).toHaveLength(2);

    const off = await harness({ enabled: false });
    off.reader.items = [mail("anything")];
    expect(await off.service.run()).toBeUndefined();
    expect(off.reader.calls).toEqual([]);
    expect(await off.store.listDecisions({ ...scope, since: NOV_4_10AM_JST, limit: 10 })).toEqual(
      [],
    );
    expect(await off.store.listReadyPushes({ ...scope, now: off.clock.now(), limit: 10 })).toEqual(
      [],
    );
  });

  it("[PG-8] raises a bland bank letter judged ignore to worth knowing and an unsure one to please check", async () => {
    const bank = (messageId: string) =>
      mail(messageId, {
        from: "三井住友銀行 <info@smbc.co.jp>",
        fromAddress: "info@smbc.co.jp",
        subject: "ご案内",
        snippet: "いつもご利用ありがとうございます",
      });
    const h = await harness();
    h.reader.items = [bank("bank-1")];
    h.script([{ id: "bank-1", result: "ignore", reason: "例行通知" }]);
    const raised = await h.service.run();
    expect(raised?.counts).toMatchObject({ ignore: 0, know: 1, floorRaised: 1 });
    expect(raised).toMatchObject({ verdict: "silent", reasonCode: "FLOOR_RAISED" });
    expect((await h.overview()).insights[0]).toMatchObject({ result: "know", floorRaised: true });

    const unsure = await harness();
    unsure.reader.items = [bank("bank-2")];
    unsure.script([{ id: "bank-2", result: "know", confidence: "unsure", todo: "银行通知" }]);
    const forced = await unsure.service.run();
    expect(forced?.counts).toMatchObject({ check: 1, floorRaised: 1 });
    expect((await unsure.overview()).insights[0]).toMatchObject({
      result: "check",
      floorRaised: true,
      pushed: true,
    });
  });

  it("[PG-9] stops model calls after the daily limit, keeps the floor rules, shows the notice and resumes the next day", async () => {
    const h = await harness({ dailyCostMicros: 1_000, cost: 1_000 });
    h.reader.items = [mail("first", { snippet: "随便聊聊" })];
    h.script([{ id: "first", result: "ignore" }]);
    await h.service.run();
    expect((await h.overview()).dailyLimitReached).toBe(true);
    h.clock.advance(15 * 60_000);
    h.reader.items = [
      mail("bank", {
        fromAddress: "info@smbc.co.jp",
        subject: "お引落しのお知らせ",
        snippet: "口座からお引落しします",
      }),
      mail("chat", { snippet: "今度ランチ行こう" }),
    ];
    const capped = await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(capped).toMatchObject({ verdict: "pushed", reasonCode: "DAILY_LIMIT" });
    const overview = await h.overview();
    expect(overview.dailyLimitReached).toBe(true);
    expect(overview.insights).toEqual([
      expect.objectContaining({ result: "check", basis: "daily_limit", pushed: true }),
    ]);
    expect(await h.store.unprocessed({ ...scope, source: "gmail", messageIds: ["chat"] })).toEqual([
      "chat",
    ]);
    h.clock.set("2026-11-04T15:00:00.000Z");
    h.script([{ id: "chat", result: "know", todo: "朋友约午饭" }], 100);
    const nextDay = await h.service.run();
    expect(h.invocations()).toBe(2);
    expect(nextDay?.counts).toMatchObject({ judged: 1, know: 1 });
    expect((await h.overview()).dailyLimitReached).toBe(false);
  });

  it("[PG-10] lists only sender and subject in the audit list and counts it reviewed only after done", async () => {
    const h = await harness();
    h.reader.items = [
      mail("newsletter", {
        from: "News <news@example.com>",
        fromAddress: "news@example.com",
        subject: "今週のニュース",
        snippet: "秘密の内容はここ",
      }),
    ];
    h.script([{ id: "newsletter", result: "ignore" }]);
    await h.service.run();
    const before = await h.overview();
    expect(before.audit.active).toBe(true);
    expect(before.audit.items).toEqual([
      {
        messageId: "newsletter",
        from: "News <news@example.com>",
        subject: "今週のニュース",
        link: "https://mail.google.com/mail/u/0/#all/newsletter",
        rating: null,
      },
    ]);
    expect(JSON.stringify(before.audit)).not.toContain("秘密の内容");
    expect(before.metrics.reviewed).toBe(0);
    expect(before.audit.pending).toBe(1);
    await h.store.rateProcessed({
      ...scope,
      source: "gmail",
      messageId: "newsletter",
      rating: "missed",
      now: h.clock.now(),
    });
    expect((await h.overview()).metrics).toMatchObject({ reviewed: 0, missed: 1 });
    await h.store.markReviewed({
      ...scope,
      source: "gmail",
      messageIds: ["newsletter"],
      now: h.clock.now(),
    });
    const after = await h.overview();
    expect(after.metrics.reviewed).toBe(1);
    expect(after.audit.pending).toBe(0);
  });

  it("[PG-17] keeps a low-priority todo off the reminder page, keeps it in the 7-day filtered list, and never drops money or official mail", async () => {
    const h = await harness();
    h.reader.items = [
      mail("points", {
        from: "東京ガス <mailtg@email.tokyo-gas.co.jp>",
        fromAddress: "mailtg@email.tokyo-gas.co.jp",
        subject: "500ポイントをPayPayに交換できます",
        snippet: "ポイント交換のご案内",
      }),
      mail("bill", {
        from: "電力 <info@power.example.com>",
        fromAddress: "info@power.example.com",
        subject: "11月分ご請求のお知らせ",
        snippet: "お支払い期限は 11/20 です",
      }),
      mail("ward", {
        from: "区役所 <info@city.shinjuku.lg.jp>",
        fromAddress: "info@city.shinjuku.lg.jp",
        subject: "ご案内",
        snippet: "手続きのお知らせ",
      }),
      mail("tax", {
        from: "税務署 <info@nta.example.com>",
        fromAddress: "info@nta.example.com",
        subject: "納付のご案内",
        snippet: "お支払いください",
      }),
    ];
    h.script([
      { id: "points", result: "act", todo: "兑换积分", priority: "low" },
      { id: "bill", result: "act", todo: "11/20 前付电费", priority: "low" },
      { id: "ward", result: "act", todo: "办手续", priority: "low" },
      { id: "tax", result: "act", todo: "缴税", priority: "medium" },
    ]);
    const decision = await h.service.run();
    expect(decision?.counts).toMatchObject({ judged: 4, ignore: 1, know: 2, act: 1 });
    const overview = await h.overview();
    expect(overview.insights.map(({ result, priority }) => [result, priority])).toEqual(
      expect.arrayContaining([
        ["know", null],
        ["act", "medium"],
      ]),
    );
    expect(overview.insights).toHaveLength(3);
    expect(overview.insights.some(({ summary }) => summary === "兑换积分")).toBe(false);
    expect(overview.audit.active).toBe(true);
    expect(overview.audit.items.map(({ messageId }) => messageId)).toEqual(["points"]);
    expect(overview.audit.items[0]).toMatchObject({
      from: "東京ガス <mailtg@email.tokyo-gas.co.jp>",
      subject: "500ポイントをPayPayに交換できます",
    });
    h.clock.advance(6 * 24 * 3_600_000);
    expect((await h.overview()).audit.items.map(({ messageId }) => messageId)).toEqual(["points"]);
    h.clock.advance(2 * 24 * 3_600_000);
    expect((await h.overview()).audit.items).toEqual([]);
  });

  it("[PG-17] moves an already stored low-priority todo from the reminder page to the filtered list", async () => {
    const h = await harness();
    h.reader.items = [
      mail("stored", {
        from: "GitHub <noreply@github.com>",
        fromAddress: "noreply@github.com",
        subject: "Actions 存储已用 90%",
        snippet: "storage quota",
      }),
    ];
    h.script([{ id: "stored", result: "act", todo: "清理存储", priority: "medium" }]);
    await h.service.run();
    expect((await h.overview()).insights).toHaveLength(1);
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      database.prepare("UPDATE source_insights SET priority = 'low'").run();
    } finally {
      database.close();
    }
    const overview = await h.overview();
    expect(overview.insights).toEqual([]);
    expect(overview.audit.items.map(({ messageId }) => messageId)).toEqual(["stored"]);
  });

  it("[PG-17] tells the model that promotions, points, surveys, invitations, newsletters and automatic usage notices are ignore", () => {
    const prompt = proactivePrompt([mail("a")], "2026-10-30T01:00:00.000Z", "Asia/Tokyo");
    for (const word of ["促销", "积分", "问卷", "聚会", "新闻简报", "用量或存储提醒"])
      expect(prompt).toContain(word);
    expect(prompt).toContain("宁可少报");
  });

  it("[PG-16] tells a failed model call, an unfinished answer and an unreadable answer apart and retries them next time", async () => {
    const h = await harness();
    h.reader.items = [mail("a", { subject: "ご確認ください" })];
    h.scriptRaw({ failedWith: "MODEL_ROUTE_UNAVAILABLE" });
    expect(await h.service.run()).toMatchObject({
      verdict: "failed",
      reasonCode: "MODEL_FAILED_MODEL_ROUTE_UNAVAILABLE",
      costMicros: 0,
    });
    h.clock.advance(15 * 60_000);
    h.scriptRaw("unfinished", '{"items":[');
    expect(await h.service.run()).toMatchObject({
      verdict: "failed",
      reasonCode: "MODEL_NOT_COMPLETED",
    });
    h.clock.advance(15 * 60_000);
    h.scriptRaw("completed", "すみません、判断できません");
    expect(await h.service.run()).toMatchObject({
      verdict: "failed",
      reasonCode: "MODEL_OUTPUT_INVALID",
      costMicros: 300,
    });
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-1");
    h.clock.advance(15 * 60_000);
    h.script([{ id: "a", result: "know", todo: "確認依頼" }]);
    expect(await h.service.run()).toMatchObject({ verdict: "silent" });
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-2");
  });

  it("[PG-16] keeps the judgements of a batch the model only half answered and asks again only for the missing mail", async () => {
    const h = await harness();
    h.reader.items = [
      mail("invoice", {
        fromAddress: "billing@tepco.co.jp",
        subject: "電気料金",
        snippet: "11/5 までにお支払いください",
      }),
      mail("lunch", { subject: "ランチ", snippet: "来週どう？" }),
    ];
    h.script([
      {
        id: "invoice",
        result: "act",
        todo: "付电费",
        priority: "high",
        dueAt: "2026-11-05T14:59:00Z",
      },
    ]);
    const first = await h.service.run();
    expect(first).toMatchObject({ verdict: "pushed" });
    expect(first?.counts).toMatchObject({ fetched: 2, judged: 1, pushed: 1 });
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-1");
    h.clock.advance(15 * 60_000);
    h.script([{ id: "lunch", result: "ignore" }]);
    const second = await h.service.run();
    expect(second).toMatchObject({ verdict: "silent" });
    expect(h.prompts.at(-1)).toContain("lunch");
    expect(h.prompts.at(-1)).not.toContain("invoice");
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-2");
  });

  it("[PG-16] halves the batch when the model spends its whole output budget thinking and keeps what it did finish", async () => {
    const h = await harness({ batchSize: 4, outputTokenLimit: 4096 });
    h.reader.items = ["a", "b", "c", "d"].map((id) => mail(id, { subject: `件名 ${id}` }));
    h.scriptRaw("completed", "考え中… まだ考え中…", 4096);
    h.scriptRaw(
      "completed",
      '{"items":[{"id":"a","result":"ignore","confidence":"sure"},{"id":"b","result":"ignore","confidence":"sure"}',
      4096,
    );
    h.scriptRaw("completed", '{"items":[{"id":"c","result":"ignore","confidence":"sure"}]}');
    h.scriptRaw("completed", '{"items":[{"id":"d","result":"ignore","confidence":"sure"}]}');
    const first = await h.service.run();
    expect(first).toMatchObject({ verdict: "silent" });
    expect(first?.counts).toMatchObject({ fetched: 4, judged: 3 });
    expect(h.invocations()).toBe(3);
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-1");
    h.clock.advance(15 * 60_000);
    const second = await h.service.run();
    expect(second).toMatchObject({ verdict: "silent" });
    expect(h.invocations()).toBe(4);
    expect(h.prompts.at(-1)).toContain('"id":"d"');
    expect(h.prompts.at(-1)).not.toContain('"id":"a"');
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-2");
  });

  it("[PG-16] names a truncated answer when even one mail cannot be judged", async () => {
    const h = await harness({ outputTokenLimit: 4096 });
    h.reader.items = [mail("a")];
    h.scriptRaw("completed", "考え中…", 4096);
    expect(await h.service.run()).toMatchObject({
      verdict: "failed",
      reasonCode: "MODEL_OUTPUT_TRUNCATED",
    });
  });

  it("[PG-16] keeps everything that never changes in front of the time and the mail so the model's KV cache can be reused", () => {
    const first = proactivePrompt([mail("a")], "2026-10-30T01:00:00.000Z", "Asia/Tokyo");
    const later = proactivePrompt([mail("b")], "2026-10-30T01:15:00.000Z", "Asia/Tokyo");
    const stable = first.slice(0, first.indexOf("邮件："));
    expect(stable.length).toBeGreaterThan(200);
    expect(later.startsWith(stable)).toBe(true);
    expect(first.indexOf("邮件：")).toBeGreaterThan(first.indexOf("只输出 JSON"));
    expect(first.split("\n").at(-1)).toMatch(/^现在是 /u);
    expect(later.split("\n").at(-1)).toMatch(/^现在是 /u);
  });
  describe("[P0-5] ledger records what each check really sent to the model", () => {
    const moneyMail = (id: string) =>
      mail(id, { subject: "お支払い料金のお知らせ", snippet: "11/5 までに" });
    const ledgerRows = (h: Awaited<ReturnType<typeof harness>>) =>
      h.ledger.list({ ...scope, kind: "proactive", since: "2026-11-01T00:00:00.000Z", limit: 50 });

    it("keeps the exact prompt, the answer, the mail ids and the rules that fired", async () => {
      const h = await harness();
      h.reader.items = [moneyMail("bill"), mail("friend")];
      h.script([
        { id: "bill", result: "know", todo: "电费", reason: "账单" },
        { id: "friend", result: "ignore" },
      ]);
      const decision = await h.service.run();
      const payloads = await h.store.readDecisionPayloads({
        ...scope,
        decisionId: decision?.id ?? "",
      });
      expect(payloads.map(({ role }) => role)).toEqual(["model_input", "model_output"]);
      expect(await h.readPayload(payloads[0]?.ref ?? "")).toBe(h.prompts[0]);
      expect(await h.readPayload(payloads[1]?.ref ?? "")).toContain('"id":"bill"');
      const [entry] = await ledgerRows(h);
      expect(entry?.id).toBe(decision?.id);
      expect(entry?.inputs.sourceIds).toEqual(["bill", "friend"]);
      expect(entry?.inputs.ruleIds).toEqual(["floor_money_words"]);
      expect(entry?.inputs.floorHits).toEqual({ bill: ["floor_money_words"] });
      expect(entry?.inputs.memoryIds).toEqual([]);
      expect(entry?.inputs.memoryInjected).toBe(false);
      expect(h.prompts[0]).toContain('"id":"bill"');
      expect(h.prompts[0]).toContain('"id":"friend"');
    });

    it("keeps every call of a multi-batch check and of a shrink-and-retry in order", async () => {
      const h = await harness({ batchSize: 2 });
      h.reader.items = [mail("a"), mail("b"), mail("c")];
      h.scriptRaw("completed", "すみません、判断できません");
      h.script([{ id: "a", result: "ignore" }]);
      h.script([{ id: "b", result: "ignore" }]);
      h.script([{ id: "c", result: "ignore" }]);
      const decision = await h.service.run();
      expect(decision?.counts.judged).toBe(3);
      const payloads = await h.store.readDecisionPayloads({
        ...scope,
        decisionId: decision?.id ?? "",
      });
      expect(h.prompts).toHaveLength(4);
      expect(payloads.map(({ role }) => role)).toEqual(
        Array.from({ length: 4 }, () => ["model_input", "model_output"]).flat(),
      );
      expect(payloads.filter(({ role }) => role === "model_input")).toHaveLength(h.prompts.length);
      for (const [index, prompt] of h.prompts.entries()) {
        const input = payloads.filter(({ role }) => role === "model_input")[index];
        expect(await h.readPayload(input?.ref ?? "")).toBe(prompt);
      }
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs.sourceIds).toEqual(["a", "b", "c"]);
    });

    it("keeps the prompt even when the model call fails", async () => {
      const h = await harness();
      h.reader.items = [mail("a")];
      h.scriptRaw({ failedWith: "MODEL_ROUTE_UNAVAILABLE" });
      const decision = await h.service.run();
      expect(decision?.verdict).toBe("failed");
      const payloads = await h.store.readDecisionPayloads({
        ...scope,
        decisionId: decision?.id ?? "",
      });
      expect(payloads.map(({ role }) => role)).toEqual(["model_input"]);
      expect(await h.readPayload(payloads[0]?.ref ?? "")).toBe(h.prompts[0]);
    });

    it("records 300 mails in one check without being rejected", async () => {
      const h = await harness({ batchSize: 300 });
      h.reader.items = Array.from({ length: 300 }, (_, index) => mail(`m${index}`));
      h.script(
        Array.from({ length: 300 }, (_, index) => ({ id: `m${index}`, result: "ignore" as const })),
      );
      const decision = await h.service.run();
      expect(decision?.counts.judged).toBe(300);
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs.sourceIds).toHaveLength(300);
    });

    it("leaves skipped mails out of sourceIds and records nothing when no mail reaches the model", async () => {
      const h = await harness();
      h.reader.items = [
        mail("promo", { categories: ["spam"] }),
        mail("mine", { sentByOwner: true }),
      ];
      const decision = await h.service.run();
      expect(h.invocations()).toBe(0);
      expect(
        await h.store.readDecisionPayloads({ ...scope, decisionId: decision?.id ?? "" }),
      ).toEqual([]);
      expect(h.query("SELECT COUNT(*) AS n FROM decision_ledger_payloads")[0]?.["n"]).toBe(0);
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs.sourceIds).toEqual([]);
      expect(entry?.inputs.ruleIds).toEqual([]);
      expect(entry?.inputs.memoryInjected).toBe(false);
    });

    it("keeps skipped mails out of sourceIds while the others are recorded", async () => {
      const h = await harness();
      h.reader.items = [mail("promo", { categories: ["spam"] }), mail("real")];
      h.script([{ id: "real", result: "ignore" }]);
      await h.service.run();
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs.sourceIds).toEqual(["real"]);
      expect(h.prompts[0]).not.toContain('"id":"promo"');
    });

    it("deletes the stored prompt, answer and sealed texts when the ledger write fails", async () => {
      const h = await harness();
      h.reader.items = [mail("a")];
      h.script([{ id: "a", result: "ignore" }]);
      const before = h.countPayloads();
      const restore = h.failRecords();
      await expect(h.service.run()).rejects.toThrow("RECORD_FAILED");
      restore();
      expect(h.countPayloads()).toBe(before);
    });

    it("deletes the prompt and answers together with the ledger rows when the owner clears records", async () => {
      const h = await harness();
      h.reader.items = [mail("a")];
      h.script([{ id: "a", result: "ignore" }]);
      const decision = await h.service.run();
      const [first] = await h.store.readDecisionPayloads({
        ...scope,
        decisionId: decision?.id ?? "",
      });
      const released = await h.store.clearRecords(scope);
      expect(released).toContain(first?.ref);
      await h.seal.release({ ...scope, refs: released });
      expect(await h.readPayload(first?.ref ?? "")).toBeUndefined();
      expect(h.query("SELECT COUNT(*) AS n FROM decision_ledger_payloads")[0]?.["n"]).toBe(0);
      expect(await ledgerRows(h)).toEqual([]);
    });

    it("keeps the ledger row and its inputs but not the prompt and answers when Gmail is disconnected", async () => {
      const h = await harness();
      h.reader.items = [moneyMail("bill")];
      h.script([{ id: "bill", result: "know", todo: "x", reason: "y" }]);
      const decision = await h.service.run();
      const [first] = await h.store.readDecisionPayloads({
        ...scope,
        decisionId: decision?.id ?? "",
      });
      await expect(h.payloadStore.delete(first?.ref ?? "")).rejects.toThrow();
      expect(await h.readPayload(first?.ref ?? "")).toBeDefined();
      const released = await h.store.removeSource({ ...scope, source: "gmail" });
      expect(released).toContain(first?.ref);
      await h.seal.release({ ...scope, refs: released });
      expect(await h.readPayload(first?.ref ?? "")).toBeUndefined();
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs.sourceIds).toEqual(["bill"]);
      expect(entry?.inputs.floorHits).toEqual({ bill: ["floor_money_words"] });
      expect(
        await h.store.readDecisionPayloads({ ...scope, decisionId: decision?.id ?? "" }),
      ).toEqual([]);
    });
  });

  describe("[P0-5b] related memories reach the judge without being treated as instructions", () => {
    const beefHit = { id: "mem-beef", text: "主人最近想吃牛肉。", score: 0.5 };
    const recallOf = (
      byMail: Record<string, readonly { id: string; text: string; score: number }[]>,
      extra: { costMicros?: number; failedQueries?: number; seen?: string[] } = {},
    ): ProactiveMemoryRecall => ({
      async recall({ queries }) {
        extra.seen?.push(...queries.map(({ query }) => query));
        return {
          hits: new Map(Object.entries(byMail)),
          costMicros: extra.costMicros ?? 0,
          failedQueries: extra.failedQueries ?? 0,
        };
      },
    });
    const ledgerRows = (h: Awaited<ReturnType<typeof harness>>) =>
      h.ledger.list({ ...scope, kind: "proactive", since: "2026-11-01T00:00:00.000Z", limit: 50 });
    const promo = () =>
      mail("beef-promo", {
        categories: ["promotions"],
        from: "和牛烤肉馆 <info@wagyu.example>",
        subject: "优惠券：本周凭券全场和牛八折",
        snippet: "本周限定",
      });

    it("sends a promotion with the matching memory and records exactly what was injected", async () => {
      const seen: string[] = [];
      const h = await harness({ memory: recallOf({ "beef-promo": [beefHit] }, { seen }) });
      h.reader.items = [promo()];
      h.script([
        {
          id: "beef-promo",
          result: "know",
          todo: "牛肉优惠",
          usedMemoryIds: ["mem-beef", "invented"],
        },
      ]);
      await h.service.run();
      expect(h.invocations()).toBe(1);
      const prompt = h.prompts[0] ?? "";
      expect(prompt).toContain("主人最近想吃牛肉。");
      expect(prompt.indexOf("主人的记忆")).toBeLessThan(prompt.indexOf("邮件："));
      expect(prompt.split("\n").at(-1)).toMatch(/^现在是 /u);
      expect(seen[0]).toContain("和牛烤肉馆");
      expect(seen[0]).toContain("本周凭券全场和牛八折");
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs).toMatchObject({
        memoryIds: ["mem-beef"],
        usedMemoryIds: ["mem-beef"],
        memoryByMail: { "beef-promo": ["mem-beef"] },
        memoryInjected: true,
        memoryRecall: "ok",
      });
    });

    it("carries no memory block and records an empty injection when nothing is related", async () => {
      const h = await harness({ memory: recallOf({}) });
      h.reader.items = [mail("sofa", { categories: ["promotions"], subject: "沙发大促" })];
      h.script([{ id: "sofa", result: "ignore" }]);
      await h.service.run();
      expect(h.invocations()).toBe(1);
      expect(h.prompts[0]).not.toContain("主人的记忆（");
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs).toMatchObject({
        memoryIds: [],
        usedMemoryIds: [],
        memoryByMail: {},
        memoryInjected: false,
        memoryRecall: "ok",
      });
    });

    it("still judges the mail without memory when the search fails, and says so", async () => {
      const h = await harness({
        memory: {
          async recall() {
            throw new Error("EMBEDDING_DOWN");
          },
        },
      });
      h.reader.items = [promo()];
      h.script([{ id: "beef-promo", result: "ignore" }]);
      await h.service.run();
      expect(h.invocations()).toBe(1);
      expect(h.prompts[0]).not.toContain("主人的记忆（");
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs).toMatchObject({
        memoryIds: [],
        memoryInjected: false,
        memoryRecall: "failed",
      });
    });

    it("marks the recall partial when some queries failed or the search budget ran out", async () => {
      const h = await harness({
        memory: recallOf({}, { failedQueries: 1 }),
        memoryLimits: { searchesPerCheck: 2 },
      });
      h.reader.items = [mail("a"), mail("b"), mail("c")];
      h.script([
        { id: "a", result: "ignore" },
        { id: "b", result: "ignore" },
        { id: "c", result: "ignore" },
      ]);
      await h.service.run();
      const [entry] = await ledgerRows(h);
      expect(entry?.inputs.memoryRecall).toBe("partial");
    });

    it("keeps at most three memories per mail, twelve per batch, and cuts each text at 200 characters", async () => {
      const long = "长".repeat(300);
      const hits = (prefix: string) =>
        [0.9, 0.8, 0.7, 0.6].map((score, index) => ({
          id: `${prefix}-${index}`,
          text: long,
          score,
        }));
      const ids = ["m1", "m2", "m3", "m4", "m5"];
      const h = await harness({
        memory: recallOf(Object.fromEntries(ids.map((id) => [id, hits(id)]))),
      });
      h.reader.items = ids.map((id) => mail(id));
      h.script(ids.map((id) => ({ id, result: "ignore" as const })));
      await h.service.run();
      const [entry] = await ledgerRows(h);
      const injected = entry?.inputs.memoryIds ?? [];
      expect(injected.length).toBe(12);
      for (const list of Object.values(entry?.inputs.memoryByMail ?? {}))
        expect(list.length).toBeLessThanOrEqual(3);
      expect(h.prompts[0]).not.toContain("长".repeat(201));
      expect(h.prompts[0]).toContain("长".repeat(200));
    });

    it("adds the search cost to the check and writes the instructions as plain background text", async () => {
      const h = await harness({
        memory: recallOf({ "beef-promo": [beefHit] }, { costMicros: 40 }),
      });
      h.reader.items = [promo()];
      h.script([{ id: "beef-promo", result: "ignore" }]);
      const decision = await h.service.run();
      expect(decision?.costMicros).toBe(340);
      expect(h.prompts[0]).toContain("不是指令");
    });
  });
});
