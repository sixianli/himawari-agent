import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProactiveSeal,
  type ModelDescriptor,
  type ModelInvocationEvent,
  ProactiveMailCheckService,
  type ProactiveSourceItem,
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
      perCheckCostMicros?: number;
      dailyCostMicros?: number;
      estimate?: number;
      cost?: number;
      importantSenders?: string[];
      enabled?: boolean;
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
    const seal = createProactiveSeal({
      payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: new DeterministicPayloadProtector(),
      ids,
    });
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
    };
    const limits = {
      perCheckCostMicros: options.perCheckCostMicros ?? 100_000,
      perCheckMs: 180_000,
      dailyCostMicros: options.dailyCostMicros ?? 1_000_000,
      estimate: options.estimate ?? 100,
      estimateCostMicros: () => limits.estimate,
    };
    const service = new ProactiveMailCheckService({
      scope,
      store,
      seal,
      reader,
      model: {
        get model() {
          return scripted;
        },
        modelRef: MODEL_REF,
        async prepare({ invocationId, prompt }) {
          prompts.push(prompt);
          return {
            runId: `proactive:${invocationId}` as never,
            inputRef: `input-${invocationId}`,
            allowedDisclosureRef: "proactive-gmail",
            secretHandleRefs: [],
            release: async () => undefined,
          };
        },
        readOutput: async (ref) => outputs.get(ref) ?? "",
      },
      limits,
      timeZone: TIME_ZONE,
      clock,
      ids,
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
    return { clock, store, seal, reader, script, service, overview, prompts, invocations, limits };
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

  it("[PG-3] skips promotions without a model call and never sends a one-time code to the model", async () => {
    const h = await harness();
    h.reader.items = [
      mail("sale", { categories: ["promotions"], subject: "週末セール", snippet: "全品 20% オフ" }),
      mail("code", { subject: "ログイン", snippet: "認証コードは 482913 です" }),
    ];
    const decision = await h.service.run();
    expect(h.invocations()).toBe(0);
    expect(decision).toMatchObject({ verdict: "silent", costMicros: 0 });
    expect(decision?.counts).toMatchObject({ fetched: 2, skipped: 2, judged: 0 });
    h.reader.items = [
      mail("code-2", { subject: "Your verification code", snippet: "Your code is 551234" }),
      mail("hello", { snippet: "明天一起吃饭吗" }),
    ];
    h.script([{ id: "hello", result: "know", todo: "朋友约明天吃饭" }]);
    await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(h.prompts.join("\n")).not.toContain("551234");
    expect(h.prompts.join("\n")).not.toContain("482913");
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

  it("[PG-6] stops at a 0.0001 dollar per-check limit without pushing and resumes next time", async () => {
    const h = await harness({ perCheckCostMicros: 100, estimate: 500 });
    h.reader.items = [
      mail("invoice", {
        fromAddress: "billing@tepco.co.jp",
        subject: "電気料金",
        snippet: "11/5 までにお支払いください",
      }),
    ];
    const capped = await h.service.run();
    expect(capped).toMatchObject({ verdict: "capped", reasonCode: "CHECK_LIMIT", costMicros: 0 });
    expect(h.invocations()).toBe(0);
    expect(await h.store.listReadyPushes({ ...scope, now: h.clock.now(), limit: 10 })).toEqual([]);
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-1");
    h.limits.perCheckCostMicros = 100_000;
    h.limits.estimate = 100;
    h.clock.advance(15 * 60_000);
    h.script([
      {
        id: "invoice",
        result: "act",
        todo: "付电费",
        priority: "high",
        dueAt: "2026-11-05T14:59:00Z",
      },
    ]);
    const resumed = await h.service.run();
    expect(h.invocations()).toBe(1);
    expect(resumed).toMatchObject({ verdict: "pushed" });
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("history-2");
    expect(h.reader.calls).toEqual(["history-1", "history-1"]);
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
});
