// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemindersPage } from "../src/components/memory-page.tsx";
import {
  ProactiveAppsSettings,
  ProactiveDataSettings,
  ProactiveNotificationSettings,
} from "../src/components/proactive-settings.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages as en } from "../src/i18n/resources/en.ts";
import { messages as ja } from "../src/i18n/resources/ja.ts";
import { messages as zh } from "../src/i18n/resources/zh-CN.ts";
import { type MemoryOverview, useMemory } from "../src/memory.ts";
import {
  type DecisionChain,
  type GmailOutcome,
  OPEN_SETTINGS,
  type ProactiveOverview,
  type ProactiveReview,
  readLaunchIntent,
  settingsTabOf,
  useProactive,
} from "../src/proactive.ts";

const NOW = new Date("2026-11-04T03:00:00.000Z");
const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf-fixture",
  installedGatewayV2Operations: [
    "memory.overview.read",
    "proactive.overview.read",
    "proactive.settings.set",
    "proactive.insight.respond",
    "proactive.decision.rate",
    "proactive.audit.respond",
    "proactive.review.read",
    "proactive.review.rate",
    "proactive.review.checkup",
    "proactive.source.manage",
    "proactive.backoff.restore",
  ],
};
const chainConfiguration: ControlCenterRuntimeConfiguration = {
  ...configuration,
  installedGatewayV2Operations: [
    ...(configuration.installedGatewayV2Operations ?? []),
    "decision.chain.read",
  ],
};
const catalogs = { "zh-CN": zh, en, ja } as const;
let locale: keyof typeof catalogs = "zh-CN";
const message = (id: MessageId, values?: Record<string, string | number>) =>
  createIntl({ locale, messages: catalogs[locale] }).formatMessage({ id }, values);
const query = vi.fn(),
  mutate = vi.fn(),
  assign = vi.fn();
const client = { query, mutate } as unknown as GatewayClient;
const openThread = vi.fn();
let chainResult: DecisionChain | Error = new Error("unset");
let container: HTMLDivElement,
  root: Root,
  proactive: ProactiveOverview,
  review: ProactiveReview,
  memory: MemoryOverview;

const counts = (change: Partial<ProactiveOverview["decisions"][number]["counts"]> = {}) => ({
  fetched: 0,
  skipped: 0,
  judged: 0,
  act: 0,
  know: 0,
  check: 0,
  ignore: 0,
  floorRaised: 0,
  pushed: 0,
  ...change,
});

const insight = (
  id: string,
  change: Partial<ProactiveOverview["insights"][number]>,
): ProactiveOverview["insights"][number] => ({
  id,
  result: "act",
  floorRaised: false,
  summary: `summary ${id}`,
  reason: "",
  basis: "model",
  from: "info@smbc.co.jp",
  subject: `subject ${id}`,
  link: `https://mail.google.com/mail/u/0/#all/${id}`,
  dueAt: null,
  priority: "medium",
  status: "open",
  pushed: false,
  pushReaction: null,
  rating: null,
  updatedAt: "2026-11-04T01:00:00.000Z",
  ...change,
});

function overviewFixture(): ProactiveOverview {
  return {
    source: "gmail",
    connection: {
      status: "connected",
      account: "andy@example.com",
      connectedAt: "2026-11-01T00:00:00.000Z",
    },
    enabled: true,
    quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
    importantSenders: ["@smbc.co.jp"],
    dailyLimitReached: false,
    backoff: [],
    insights: [
      insight("rakuten", {
        summary: "11 月账单 ¥38,420，确认后付款",
        reason: "比上月多 ¥12,000",
        dueAt: "2026-11-07T15:00:00.000Z",
        priority: "high",
        pushed: true,
        pushReaction: "opened",
        from: "楽天カード",
      }),
      insight("ward", {
        summary: "补交住民税申报材料",
        dueAt: new Date(NOW.valueOf() + 3_600_000).toISOString(),
        priority: "high",
      }),
      insight("pension", {
        result: "check",
        summary: "「重要なお知らせ」请看原信",
        floorRaised: true,
      }),
      insight("github", { summary: "看一下 Dependabot 提醒", priority: "low", status: "replied" }),
      insight("airbnb", {
        result: "know",
        summary: "京都入住改到 16:00 以后",
        basis: "daily_limit",
      }),
    ],
    audit: {
      active: true,
      since: "2026-11-03T15:00:00.000Z",
      items: [
        {
          messageId: "a1",
          from: "Amazon.co.jp",
          subject: "ご注文の商品を発送しました",
          link: "",
          rating: null,
        },
        { messageId: "a2", from: "note", subject: "今週の人気記事", link: "", rating: null },
      ],
      pending: 2,
    },
    decisions: [
      {
        id: "d-push",
        checkedAt: "2026-11-04T02:45:00.000Z",
        verdict: "pushed",
        reasonCode: "URGENT",
        counts: counts({ fetched: 3, judged: 3, act: 1, pushed: 1 }),
        opened: true,
        rating: null,
      },
      {
        id: "d-quiet",
        checkedAt: "2026-11-04T02:30:00.000Z",
        verdict: "silent",
        reasonCode: "NOTHING_URGENT",
        counts: counts({ fetched: 2, skipped: 2 }),
        opened: false,
        rating: null,
      },
      {
        id: "d-fail",
        checkedAt: "2026-11-04T02:15:00.000Z",
        verdict: "failed",
        reasonCode: "READ_HISTORY",
        counts: counts(),
        opened: false,
        rating: null,
      },
      {
        id: "d-daily",
        checkedAt: "2026-11-03T09:40:00.000Z",
        verdict: "capped_daily",
        reasonCode: "DAILY_LIMIT",
        counts: counts({ fetched: 4 }),
        opened: false,
        rating: null,
      },
      ...[
        ["d-cut", "09:30", "MODEL_OUTPUT_TRUNCATED"],
        ["d-nothing", "09:20", "MODEL_FAILED_ROUTE_UNAVAILABLE"],
        ["d-unfinished", "09:10", "MODEL_NOT_COMPLETED"],
      ].map(([id, at, reasonCode]) => ({
        id,
        checkedAt: `2026-11-03T${at}:00.000Z`,
        verdict: "failed" as const,
        reasonCode,
        counts: counts({ fetched: 26 }),
        opened: false,
        rating: null,
      })),
    ],
    metrics: { spoke: 5, hits: 3, misfires: 1, missed: 1, reviewed: 23 },
    generatedAt: NOW.toISOString(),
  } as ProactiveOverview;
}

const reviewItem = (
  key: string,
  change: Partial<ProactiveReview["items"][number]> = {},
): ProactiveReview["items"][number] => ({
  key,
  source: "ledger",
  kind: "memory_candidate",
  outcome: "discarded",
  decidedAt: "2026-11-04T00:12:00.000Z",
  acted: false,
  rating: null,
  text: `候选 ${key}`,
  textHidden: false,
  category: null,
  fetched: null,
  checkup: null,
  ...change,
});

function reviewFixture(): ProactiveReview {
  return {
    day: "2026-11-03T15:00:00.000Z",
    capacity: 24,
    sampled: 8,
    notSampled: 5,
    items: [
      reviewItem("ledger:a1", { text: "我最近想吃牛肉" }),
      reviewItem("ledger:a2", { text: "", textHidden: true, category: "health" }),
      reviewItem("ledger:a3", {
        kind: "proactive",
        outcome: "pushed",
        acted: true,
        text: "",
        fetched: 12,
      }),
      reviewItem("mail:m1", {
        source: "mail",
        kind: "mail",
        outcome: "skipped",
        text: "Shop · セール",
      }),
      reviewItem("ledger:a5", { rating: "useful" }),
      reviewItem("ledger:a6"),
      reviewItem("ledger:a7"),
      reviewItem("ledger:a8", {
        kind: "rule_review",
        outcome: "needs_review",
        acted: true,
        text: "",
      }),
    ],
    folded: {
      total: 3,
      items: [
        reviewItem("ledger:f1", {
          kind: "consolidation",
          outcome: "merge",
          acted: true,
          text: "",
        }),
      ],
    },
    memoryUnusedDays: 90,
    hiddenByModel: 0,
    generatedAt: NOW.toISOString(),
  };
}

function memoryFixture(): MemoryOverview {
  return {
    memories: [],
    profile: [],
    pending: [],
    tidyUps: [],
    conversationReviews: [],
    reminders: [],
    upcoming: [
      {
        reminderId: "reminder:call",
        memoryId: "memory-call",
        text: "给妈妈打电话",
        dueAt: new Date(NOW.valueOf() + 2 * 3_600_000).toISOString(),
        repeat: null,
        sourceThreadId: null,
      },
    ],
    people: [],
    imports: [],
    externalProposals: { total: 0, items: [], batches: [] },
    capturePaused: false,
    generatedAt: NOW.toISOString(),
  } as unknown as MemoryOverview;
}

function Page({ focus }: { focus: string | null }) {
  const memoryModel = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
  const model = useProactive({ client, configuration, connected: true, refreshSignal: 0, assign });
  if (!memoryModel || !model) return null;
  return h(
    "div",
    { id: "page" },
    h(RemindersPage, {
      memory: memoryModel,
      proactive: model,
      focus,
      message,
      onOpenThread: () => undefined,
    }),
  );
}

function Settings({ outcome, chain = false }: { outcome: GmailOutcome | null; chain?: boolean }) {
  const model = useProactive({
    client,
    configuration: chain ? chainConfiguration : configuration,
    connected: true,
    refreshSignal: 0,
    assign,
  });
  if (!model) return null;
  return h(
    "div",
    { id: "settings" },
    h(
      "div",
      { id: "notifications" },
      h(ProactiveNotificationSettings, { proactive: model, locale, message }),
    ),
    h(
      "div",
      { id: "apps" },
      h(ProactiveAppsSettings, {
        proactive: model,
        message,
        outcome,
        onOpenThread: openThread,
      }),
    ),
    h("div", { id: "data" }, h(ProactiveDataSettings, { proactive: model, message })),
  );
}

async function flush() {
  await act(async () => {});
  await act(async () => {});
}

const text = (scope: string) => document.querySelector(scope)?.textContent ?? "";

function button(scope: string, label: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)];
  const found =
    buttons.find((item) => item.textContent?.trim() === label || item.ariaLabel === label) ??
    buttons.find((item) => item.textContent?.startsWith(label));
  if (!found) throw new Error(`missing ${label} in ${scope}`);
  return found;
}

async function click(scope: string, label: string) {
  await act(async () => button(scope, label).click());
  await flush();
}

const commands = () => mutate.mock.calls.map(([command]) => command);

async function choose(row: string, label: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`${row} .action-menu > button`);
  if (!trigger) throw new Error(`missing menu in ${row}`);
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!item) throw new Error(`missing ${label} in the menu of ${row}`);
  await act(async () => item.click());
  await flush();
}
const lastCommand = () => mutate.mock.lastCall?.[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  locale = "zh-CN";
  proactive = overviewFixture();
  review = reviewFixture();
  memory = memoryFixture();
  query.mockImplementation(async (request: { type: string }) =>
    request.type === "decision.chain.read"
      ? chainResult instanceof Error
        ? Promise.reject(chainResult)
        : { type: "decision.chain.snapshot", payload: chainResult }
      : request.type === "proactive.overview.read"
        ? { type: "proactive.overview.snapshot", payload: proactive }
        : request.type === "proactive.review.read"
          ? { type: "proactive.review.snapshot", payload: review }
          : { type: "memory.overview.snapshot", payload: memory },
  );
  mutate.mockResolvedValue({ status: "accepted" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("[PG-15] proactive reminders page", () => {
  it("[PG-15] puts mail into the approved groups in order and acts on one row", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const headings = [...document.querySelectorAll("#page .memory-group")].map((item) =>
      item.textContent?.trim(),
    );
    expect(headings).toEqual([
      "今天",
      "可能重要，请看原信",
      "未来 7 天",
      "没有截止日期",
      "值得知道",
    ]);
    const today = document.querySelector("#reminder-ward");
    expect(today?.getAttribute("data-tone")).toBe("urgent");
    expect(today?.parentElement?.textContent).toContain("给妈妈打电话");
    expect(document.querySelector("#reminder-pension")?.getAttribute("data-tone")).toBe("check");
    expect(text("#reminder-pension")).not.toContain("重要来信不放过");
    expect(button("#reminder-pension", "完成").className).toContain("action-button-primary");
    expect(() => button("#reminder-pension", "不再提醒")).toThrow();
    await choose("#reminder-pension", "为什么提醒我");
    expect(text("#reminder-pension")).toContain("重要来信不放过");
    await choose("#reminder-airbnb", "为什么提醒我");
    expect(text("#reminder-airbnb")).toContain("没交给模型");
    expect(text("#reminder-github")).toContain("你已回复");
    const row = "#reminder-rakuten";
    expect(text(row)).toContain("11 月账单 ¥38,420");
    expect(text(row)).not.toContain("比上月多 ¥12,000");
    await choose(row, "为什么提醒我");
    expect(text(row)).toContain("比上月多 ¥12,000");
    expect(text(row)).toContain("楽天カード");
    expect(document.querySelector(`${row} [data-priority="high"]`)?.textContent).toBe("高优先级");
    expect(text(row)).toContain("推送过 · 你点开了");
    expect(text("#reminder-ward")).toContain("今天");
    expect(document.querySelector(`${row} a`)?.getAttribute("href")).toBe(
      "https://mail.google.com/mail/u/0/#all/rakuten",
    );
    await click(row, "做对了");
    expect(lastCommand()).toMatchObject({
      type: "proactive.insight.respond",
      payload: { insightId: "rakuten", action: "rate", rating: "useful" },
    });
    await click(row, "完成");
    expect(lastCommand()).toMatchObject({
      payload: { insightId: "rakuten", action: "done", rating: null },
    });
    expect(text("#page .memory-notice")).toContain("已完成");
    await click("#page .memory-notice", "撤销");
    expect(lastCommand()).toMatchObject({ payload: { insightId: "rakuten", action: "reopen" } });
    await choose("#reminder-ward", "不再提醒");
    expect(lastCommand()).toMatchObject({ payload: { insightId: "ward", action: "mute" } });
    expect(text("#page .reminders-notify")).toContain("要紧的邮件");
  });

  it("[PG-15] highlights the row a push opened", async () => {
    await act(async () => root.render(h(Page, { focus: "pension" })));
    await flush();
    expect(document.querySelector("#reminder-pension")?.hasAttribute("data-highlight")).toBe(true);
    expect(document.querySelector("#reminder-rakuten")?.hasAttribute("data-highlight")).toBe(false);
  });

  it("[PG-15] asks to reconnect, shows the daily limit in red and offers to connect", async () => {
    proactive = {
      ...proactive,
      connection: { ...proactive.connection, status: "needs_reconnect" },
      dailyLimitReached: true,
      decisions: [
        {
          id: "d-owner",
          checkedAt: "2026-11-04T02:50:00.000Z",
          verdict: "needs_owner",
          reasonCode: "SOURCE_UNAUTHORIZED",
          counts: counts(),
          opened: false,
          rating: null,
        },
      ],
    };
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const banners = [...document.querySelectorAll('#page .proactive-banner[data-tone="need"]')];
    expect(banners.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Google 授权失效"),
      expect.stringContaining("每日费用上限"),
    ]);
    await click("#page .proactive-banner", "重新连接");
    expect(assign).toHaveBeenCalledWith("/api/proactive/v1/google/start");
    act(() => root.unmount());
    root = createRoot(container);
    proactive = {
      ...proactive,
      connection: { status: "disconnected", account: null, connectedAt: null },
      dailyLimitReached: false,
    };
    const opened = vi.fn();
    window.addEventListener(OPEN_SETTINGS, opened);
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    expect(document.querySelector("#reminder-rakuten")).toBeNull();
    expect(text("#page .reminders-log-link")).toBe("");
    await click("#page .proactive-connect", "连接 Gmail");
    expect(settingsTabOf(opened.mock.calls[0]?.[0])).toBe("tools");
    window.removeEventListener(OPEN_SETTINGS, opened);
  });

  it("[PA-6] names each backed-off class with a restore button, and shows nothing when none is", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    expect(document.querySelector('#page [data-testid^="backoff-"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    proactive = {
      ...proactive,
      backoff: [
        {
          classKey: "due:service.example.com",
          domain: "service.example.com",
          stage: 1,
          ignoredCount: 3,
          changedAt: "2026-11-03T00:00:00.000Z",
        },
        {
          classKey: "due:shop.example.jp",
          domain: "shop.example.jp",
          stage: 2,
          ignoredCount: 3,
          changedAt: "2026-11-03T00:00:00.000Z",
        },
      ],
    };
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const first = '#page [data-testid="backoff-due:service.example.com"]';
    expect(text(first)).toContain("service.example.com");
    expect(text(first)).toContain("最多每天推送 1 条");
    expect(text('#page [data-testid="backoff-due:shop.example.jp"]')).toContain("已暂停推送");
    await click(first, "恢复推送");
    expect(lastCommand()).toMatchObject({
      type: "proactive.backoff.restore",
      payload: { classKey: "due:service.example.com" },
    });
  });

  it("[P0-6] shows one page of the daily rating with the right buttons and no hidden text", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const section = "#page .proactive-review";
    expect(text(`${section} h2`)).toBe("每天打分");
    expect(text(`${section} .proactive-review-count`)).toBe("今天 8 条，另有 5 条没抽到");
    expect(text(section)).toContain("没抽到的明天可能再出现，7 天后不再出现。");
    const rows = [...document.querySelectorAll<HTMLElement>(`${section} li`)];
    expect(rows).toHaveLength(6);
    expect(text(`${section} li:nth-child(1)`)).toContain("系统没存下的记忆");
    expect(text(`${section} li:nth-child(1)`)).toContain("我最近想吃牛肉");
    expect(text(`${section} li:nth-child(2)`)).toContain("这里不显示原文");
    expect(text(`${section} li:nth-child(3)`)).toContain("检查了 12 封邮件");
    expect(text(`${section} li:nth-child(4)`)).toContain("没提醒的邮件");
    const labels = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll("button") ?? [])].map((item) => item.textContent);
    expect(labels(rows[0])).toEqual(["做对了", "该做没做"]);
    expect(labels(rows[2])).toEqual(["做对了", "不该做"]);
    expect(rows[4]?.querySelector('button[aria-pressed="true"]')?.textContent).toBe("做对了");
    expect(text(section)).toContain("其他判断 · 3 条");
    expect(text(section)).not.toContain("整理记忆");
    expect(text(section)).toContain("第 1 / 2 页");
  });

  it("[P2-2] shows a hard rule review in the daily rating with its own tag and sentence", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const section = "#page .proactive-review";
    await click(section, "下一页");
    const rows = [...document.querySelectorAll<HTMLElement>(`${section} li`)];
    const row = rows.at(-1);
    expect(row?.textContent).toContain("硬规则待重审");
    expect(row?.textContent).toContain("那条记忆变了，规则照常执行");
    expect(row?.textContent).not.toContain("外部程序读取记忆");
  });

  it("[P3-5] names each failed memory capture by what happens next instead of waiting for approval", async () => {
    review = {
      ...review,
      folded: {
        total: 3,
        items: (["capture_retrying", "capture_queued", "capture_gave_up"] as const).map((outcome) =>
          reviewItem(`ledger:${outcome}`, { outcome, text: "" }),
        ),
      },
    };
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const section = "#page .proactive-review";
    await click(section, "展开");
    const rows = [...document.querySelectorAll<HTMLElement>(`${section} li`)];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("记忆抽取失败，已重试"),
      expect.stringContaining("记忆抽取失败，下一轮补做"),
      expect.stringContaining("这轮没记下"),
    ]);
    expect(text(section)).not.toContain("待你确认的记忆");
    expect(text(section)).not.toContain("这里不显示原文");
  });

  it("[P0-6] sends one rating, clears it on a second tap and leaves a reviewed mail alone", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const section = "#page .proactive-review";
    await click(`${section} li:nth-child(1)`, "该做没做");
    expect(lastCommand()).toMatchObject({
      type: "proactive.review.rate",
      payload: { ratings: [{ key: "ledger:a1", rating: "missed" }] },
    });
    const calls = mutate.mock.calls.length;
    await click(`${section} li:nth-child(5)`, "做对了");
    expect(lastCommand()).toMatchObject({
      payload: { ratings: [{ key: "ledger:a5", rating: null }] },
    });
    review = {
      ...review,
      items: review.items.map((item) =>
        item.key === "mail:m1" ? { ...item, rating: "useful" as const } : item,
      ),
    };
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const before = mutate.mock.calls.length;
    expect(before).toBe(calls + 1);
    await click(`${section} li:nth-child(4)`, "做对了");
    expect(mutate.mock.calls.length).toBe(before);
  });

  it('[P0-6] rates only the unrated rows on the page for "this page is all fine", then moves on', async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const section = "#page .proactive-review";
    await click(section, "这一页都没问题");
    expect(lastCommand()).toMatchObject({
      type: "proactive.review.rate",
      payload: {
        ratings: [
          { key: "ledger:a1", rating: "useful" },
          { key: "ledger:a2", rating: "useful" },
          { key: "ledger:a3", rating: "useful" },
          { key: "mail:m1", rating: "useful" },
          { key: "ledger:a6", rating: "useful" },
        ],
      },
    });
    review = {
      ...review,
      items: review.items.map((item, index) =>
        index < 6 ? { ...item, rating: "useful" as const } : item,
      ),
    };
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    await click(section, "下一页");
    expect(text(`${section} .proactive-review-pager`)).toContain("第 2 / 2 页");
    expect(document.querySelectorAll(`${section} li`)).toHaveLength(2);
    await click(section, "上一页");
    expect(text(`${section} .proactive-review-pager`)).toContain("第 1 / 2 页");
  });

  it("[P0-6] keeps the other decisions folded until asked, and shows nothing when there is nothing to rate", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const section = "#page .proactive-review";
    expect(text(section)).not.toContain("整理记忆");
    await click(section, "展开");
    expect(text(section)).toContain("整理记忆");
    expect(document.querySelectorAll(`${section} li`)).toHaveLength(1);
    expect(text(`${section} .proactive-review-head`)).not.toContain("今天");
    await click(section, "返回");
    expect(text(section)).toContain("我最近想吃牛肉");
    act(() => root.unmount());
    root = createRoot(container);
    review = { ...review, sampled: 0, notSampled: 0, items: [], folded: { total: 0, items: [] } };
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    expect(document.querySelector("#page .proactive-review")).toBeNull();
    expect(text("#page")).not.toContain("每天打分");
  });

  it("[P4-6] shows the memory checkup group inside the daily rating, sends its actions and keeps it out of the rating buttons", async () => {
    const checkupItem = (
      key: string,
      checkup: NonNullable<ProactiveReview["items"][number]["checkup"]>,
      text: string,
    ) =>
      reviewItem(key, {
        source: "checkup",
        kind: "checkup",
        outcome: checkup.action ?? "pending",
        text,
        checkup,
      });
    review = {
      ...review,
      items: [
        checkupItem(
          "checkup:c1",
          {
            reason: "conflict",
            action: null,
            memoryId: "memory-new",
            relatedMemoryId: "memory-old",
            relatedText: "出差时喝便利店的牛奶",
            keptMemoryId: null,
          },
          "平时喝明治的牛奶",
        ),
        checkupItem(
          "checkup:c2",
          {
            reason: "unused",
            action: "confirm",
            memoryId: "memory-quiet",
            relatedMemoryId: null,
            relatedText: "",
            keptMemoryId: null,
          },
          "喜欢靠窗的座位",
        ),
        ...review.items,
      ],
    };
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    const group = "#page .proactive-review .proactive-review-list";
    expect(document.querySelectorAll(`${group}`)).toHaveLength(1);
    const rows = [...document.querySelectorAll<HTMLElement>(`${group} li`)];
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(text(`${group} li:nth-child(1)`)).toContain("两条说法不一样");
    expect(text(`${group} li:nth-child(1)`)).toContain("新：平时喝明治的牛奶");
    expect(text(`${group} li:nth-child(1)`)).toContain("旧：出差时喝便利店的牛奶");
    expect(text(`${group} li:nth-child(2)`)).toContain("90 天没用过");
    expect(text(`${group} li:nth-child(2)`)).toContain("已确认");
    expect(rows[1]?.textContent).not.toContain("没问题");
    await click(`${group} li:nth-child(1)`, "用新的替换旧的");
    expect(lastCommand()).toMatchObject({
      type: "proactive.review.checkup",
      payload: { key: "checkup:c1", action: "merge", keep: "memory-new" },
    });
    await click(`${group} li:nth-child(2)`, "撤销");
    expect(lastCommand()).toMatchObject({
      type: "proactive.review.checkup",
      payload: { key: "checkup:c2", action: "undo", keep: null },
    });
    await click("#page .proactive-review", "这一页都没问题");
    const ratings = (lastCommand() as { payload: { ratings: { key: string }[] } }).payload.ratings;
    expect(ratings.map(({ key }) => key)).not.toContain("checkup:c1");
    expect(ratings.map(({ key }) => key)).not.toContain("checkup:c2");
    expect(ratings[0]?.key).toBe("ledger:a1");
  });

  it("[PG-15] shows one line per check in the reminder check record and takes ratings", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    expect(text("#page")).not.toContain("提醒检查记录");
    expect(document.querySelector("#page h1")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(h(Settings, { outcome: null })));
    await flush();
    const entry = document.querySelector<HTMLDetailsElement>("#apps .proactive-log-entry");
    expect(entry?.querySelector("summary")?.textContent).toContain("提醒检查记录");
    expect(entry?.querySelector(".proactive-log")).toBeNull();
    await act(async () => {
      entry?.querySelector("summary")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    const summary = text("#apps .proactive-summary");
    expect(summary.replace(/\s/gu, "")).toContain("已记录2天");
    for (const moved of [
      "主动提醒总次数",
      "恰当的提醒",
      "多余的提醒",
      "漏提醒（你查过的邮件里）",
      "已审",
    ])
      expect(text("#apps")).not.toContain(moved);
    const rows = [...document.querySelectorAll<HTMLElement>("#apps .proactive-log-row")];
    expect(rows.map((row) => row.dataset["tone"])).toEqual([
      "spoke",
      "quiet",
      "warn",
      "warn",
      "warn",
      "warn",
      "warn",
    ]);
    expect(rows[0]?.textContent).toContain("推送了 1 件要你处理的事");
    expect(rows[0]?.textContent).toContain("你点开了");
    expect(rows[1]?.textContent).toContain("2 封新邮件，都是垃圾邮件，按规则跳过，没交给模型");
    expect(rows[2]?.textContent).toContain("15 分钟后照常再看");
    expect(rows[3]?.textContent).toContain("每日费用上限");
    expect(rows[4]?.textContent).toContain("想得太久，答案没写完就被截断了");
    expect(rows[5]?.textContent).toContain("模型这次没有回答");
    expect(rows[6]?.textContent).toContain("模型没有答完");
    expect(text("#apps")).toContain("昨天");
    await click("#apps .proactive-log-row:nth-of-type(1)", "不该做");
    expect(lastCommand()).toMatchObject({
      type: "proactive.decision.rate",
      payload: { decisionId: "d-push", rating: "unneeded" },
    });
    const quiet = rows[1]?.querySelector("button");
    await act(async () => quiet?.click());
    expect(lastCommand()).toMatchObject({ payload: { decisionId: "d-quiet", rating: "missed" } });
    expect(rows[2]?.querySelector("button")).toBeNull();
  });

  it("[PG-15] reads the same page in English and Japanese", async () => {
    for (const [next, expected] of [
      [
        "en",
        [
          "Might matter, read the email",
          "Due today",
          "Pushed · you opened it",
          "Open email",
          "Daily rating",
          "Right call",
        ],
      ],
      [
        "ja",
        [
          "重要かも、元のメールを確認",
          "本日",
          "通知済み · 開きました",
          "元のメール",
          "毎日の採点",
          "正しかった",
        ],
      ],
    ] as const) {
      locale = next;
      await act(async () => root.render(h(Page, { focus: null })));
      await flush();
      for (const value of expected) expect(text("#page")).toContain(value);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });
});

describe("[PG-15] proactive settings", () => {
  it("[PG-15] turns proactive reminders off and edits quiet hours", async () => {
    await act(async () => root.render(h(Settings, { outcome: null })));
    await flush();
    const toggle = document.querySelector<HTMLInputElement>("#notifications input[role=switch]");
    await act(async () => toggle?.click());
    await flush();
    expect(lastCommand()).toMatchObject({
      type: "proactive.settings.set",
      payload: {
        enabled: false,
        quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
        importantSenders: ["@smbc.co.jp"],
      },
    });
    const days = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "#notifications .proactive-days button[aria-pressed]",
      ),
    ];
    expect(days.map((day) => day.textContent)).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    await act(async () => days[6]?.click());
    expect(lastCommand()?.payload.quietHours).toEqual([
      { days: [1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" },
    ]);
    await click("#notifications", "+ 添加时段");
    expect(lastCommand()?.payload.quietHours).toHaveLength(2);
    const end = document.querySelector<HTMLInputElement>(
      '#notifications input[aria-label="时段 1 结束时间"]',
    );
    const setEnd = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(end, value);
        end?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => end?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    };
    const before = commands().length;
    await setEnd("7:0");
    expect(text("#notifications")).toContain("24 小时格式");
    await setEnd("23:00");
    expect(text("#notifications")).toContain("开始和结束不能是同一时间");
    await click("#notifications", "删除时段 2");
    expect(commands().length).toBe(before);
    await setEnd("06:30");
    await flush();
    expect(lastCommand()?.payload.quietHours).toEqual([
      { days: [1, 2, 3, 4, 5, 6], start: "23:00", end: "06:30" },
    ]);
  });

  it("[PG-15] connects, edits important senders, disconnects after confirming and clears records", async () => {
    await act(async () => root.render(h(Settings, { outcome: "connected" })));
    await flush();
    expect(text("#apps")).toContain("已连接 Gmail");
    expect(text("#apps .proactive-app")).toContain("已连接 · andy@example.com");
    expect(text("#apps details")).toContain("邮件正文发给模型");
    expect(text("#apps details")).not.toContain("不发正文");
    await click("#apps .proactive-senders", "管理");
    const area = document.querySelector<HTMLTextAreaElement>("#apps textarea");
    const write = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          area,
          value,
        );
        area?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await write("@smbc.co.jp\nbank");
    expect(text("#apps .proactive-error")).toContain("“bank”不是邮件地址或域名");
    expect(button("#apps .proactive-senders-editor", "保存").disabled).toBe(true);
    await write("@smbc.co.jp\nInfo@City.Shinjuku.LG.JP");
    await click("#apps .proactive-senders-editor", "保存");
    expect(lastCommand()).toMatchObject({
      type: "proactive.settings.set",
      payload: { importantSenders: ["@smbc.co.jp", "info@city.shinjuku.lg.jp"] },
    });
    const before = commands().length;
    await click("#apps .proactive-app", "断开");
    expect(commands().length).toBe(before);
    expect(text("#apps .proactive-confirm")).toContain("撤销授权");
    await click("#apps .proactive-confirm", "断开");
    expect(lastCommand()).toMatchObject({
      type: "proactive.source.manage",
      payload: { source: "gmail", action: "disconnect" },
    });
    await click("#data", "全部删除");
    expect(text("#data .proactive-confirm")).toContain("Gmail 仍保持连接");
    await click("#data .proactive-confirm", "全部删除");
    expect(lastCommand()).toMatchObject({
      type: "proactive.source.manage",
      payload: { source: "gmail", action: "clear_records" },
    });
    expect(text("#data")).toContain("已全部删除");
  });

  it("[PG-15] starts the Google sign-in from a disconnected Gmail row", async () => {
    proactive = {
      ...proactive,
      connection: { status: "disconnected", account: null, connectedAt: null },
    };
    await act(async () => root.render(h(Settings, { outcome: "denied" })));
    await flush();
    expect(text("#apps")).toContain("你在 Google 页面没有同意");
    expect(document.querySelector<HTMLDetailsElement>("#apps details")?.open).toBe(false);
    await click("#apps .proactive-app", "连接 Gmail");
    expect(assign).toHaveBeenCalledWith("/api/proactive/v1/google/start");
  });

  it("[P6-demo] tells a trial user that the sample inbox is in use, in a calm tone", async () => {
    await act(async () => root.render(h(Settings, { outcome: "demo" })));
    await flush();
    expect(text("#apps")).toContain("体验版用的是示范收件箱，不能连接你自己的邮箱");
    expect(
      document.querySelector("#apps .proactive-outcome")?.getAttribute("data-tone"),
    ).toBeNull();
    await act(async () => root.render(h(Settings, { outcome: "failed" })));
    await flush();
    expect(document.querySelector("#apps .proactive-outcome")?.getAttribute("data-tone")).toBe(
      "warn",
    );
  });
});

describe("[PG-15] opening from a push or the Google callback", () => {
  it("[PG-15] reads and strips the reminder and settings parameters but keeps the push tag", () => {
    const replaceState = vi.fn();
    expect(
      readLaunchIntent(
        { href: "https://himawari.example/?reminder=proactive-insight%3A1&push=tag-1" },
        { replaceState, state: null },
      ),
    ).toEqual({ reminder: "proactive-insight:1", settings: null, gmail: null });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?push=tag-1");
    expect(
      readLaunchIntent(
        { href: "https://himawari.example/?settings=apps&gmail=connected" },
        { replaceState, state: null },
      ),
    ).toEqual({ reminder: null, settings: "tools", gmail: "connected" });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/");
    expect(
      readLaunchIntent(
        { href: "https://himawari.example/?settings=apps&gmail=demo" },
        { replaceState, state: null },
      ),
    ).toEqual({ reminder: null, settings: "tools", gmail: "demo" });
    expect(
      readLaunchIntent(
        { href: "https://himawari.example/?reminder=%3Cscript%3E&gmail=other" },
        { replaceState, state: null },
      ),
    ).toEqual({ reminder: null, settings: null, gmail: null });
    replaceState.mockClear();
    expect(
      readLaunchIntent({ href: "https://himawari.example/threads" }, { replaceState, state: null }),
    ).toEqual({
      reminder: null,
      settings: null,
      gmail: null,
    });
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("[P1-3] the basis drawer of a decision record", () => {
  const memoryItem = (
    change: Partial<DecisionChain["memories"]["items"][number]>,
  ): DecisionChain["memories"]["items"][number] => ({
    memoryId: "memory-a",
    state: "visible",
    text: "我住在东京",
    status: "active",
    inference: false,
    tentative: false,
    usedByModel: true,
    changedSinceDecision: false,
    supersededBy: null,
    source: {
      threadId: "thread-1",
      messageId: "message-1",
      quote: "我搬到东京了",
      refs: [],
      importBatchId: null,
      firstSourceDeleted: false,
    },
    basis: { nodes: [], complete: true },
    ...change,
  });
  const chain = (change: Partial<DecisionChain> = {}): DecisionChain => ({
    decisionId: "d-push",
    decision: {
      kind: "proactive",
      decidedAt: "2026-11-04T02:45:00.000Z",
      outcome: "pushed",
      reasonCode: "URGENT",
      rating: "useful",
      ratedAt: "2026-11-04T02:50:00.000Z",
    },
    inputs: "recorded",
    rules: {
      state: "recorded",
      items: [
        {
          ruleId: "floor_money_words",
          revision: 2,
          current: true,
          kind: "money_words",
          origin: "built_in",
          source: "ADR 0106 第 4 条；ADR 0209；ADR 0248",
          status: "active",
          changedAt: null,
          memory: null,
          wording: { values: [], quietHours: [], amount: null },
          tests: { state: "passed", total: 5, failedAt: null },
          mailCount: 2,
        },
        {
          ruleId: "floor_important_sender",
          revision: 3,
          current: false,
          kind: "important_sender",
          origin: "owner_setting",
          source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
          status: "needs_review",
          changedAt: "2026-11-03T01:00:00.000Z",
          memory: { memoryId: "memory-rule", state: "visible", text: "银行的信一律提醒我" },
          wording: { values: ["bank.example"], quietHours: [], amount: null },
          tests: { state: "failed", total: 3, failedAt: 2 },
          mailCount: 1,
        },
        {
          ruleId: "floor_unknown",
          revision: null,
          current: false,
          kind: "unknown",
          origin: null,
          source: null,
          status: null,
          changedAt: null,
          memory: null,
          wording: null,
          tests: { state: "unavailable", total: 0, failedAt: null },
          mailCount: 1,
        },
      ],
    },
    mails: {
      judged: 3,
      related: 2,
      relatedRead: "partial",
      summaries: { count: 2, read: "ok" },
    },
    memories: {
      state: "recorded",
      recall: "ok",
      total: 4,
      truncated: false,
      items: [
        memoryItem({}),
        memoryItem({
          memoryId: "memory-b",
          text: "喜欢拉面",
          inference: true,
          basis: {
            nodes: [
              {
                memoryId: "memory-b",
                text: "喜欢拉面",
                action: "merge",
                changedAt: "2026-11-02T00:00:00.000Z",
                basisMemoryIds: ["memory-c"],
                repeated: false,
                truncated: false,
              },
              {
                memoryId: "memory-c",
                text: "周五吃了拉面",
                action: null,
                changedAt: null,
                basisMemoryIds: [],
                repeated: false,
                truncated: false,
              },
            ],
            complete: true,
          },
        }),
        memoryItem({
          memoryId: "memory-s",
          state: "hidden",
          text: null,
          source: { ...memoryItem({}).source, quote: null },
        }),
        memoryItem({ memoryId: "memory-gone", state: "missing", text: null, status: null }),
      ],
    },
    ...change,
  });
  const openLog = async () => {
    await act(async () => root.render(h(Settings, { outcome: null, chain: true })));
    await flush();
    await act(async () => {
      document.querySelector<HTMLElement>("#apps .proactive-log-entry summary")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
  };
  const rowButton = (row: string) =>
    document.querySelector<HTMLButtonElement>(
      `#apps .proactive-log-row:nth-of-type(${row}) .memory-link`,
    );

  it("shows the whole chain of one record, with every missing link saying no record", async () => {
    chainResult = chain();
    await openLog();
    const first = [...document.querySelectorAll<HTMLButtonElement>("#apps .memory-link")].find(
      (item) => item.textContent === "依据",
    );
    await act(async () => first?.click());
    await flush();
    expect(query.mock.calls.some(([request]) => request.type === "decision.chain.read")).toBe(true);
    const drawer = text(".decision-chain");
    expect(drawer).toContain("命中的规则");
    expect(drawer).toContain("内置规则");
    expect(drawer).toContain("出处：ADR 0106 第 4 条；ADR 0209；ADR 0248 · 第 2 版");
    expect(drawer).toContain("模型逐封判断");
    expect(drawer).not.toContain("词表：");
    expect(drawer).toContain("测试：5 条例子全部通过");
    expect(drawer).toContain("原话：银行的信一律提醒我");
    expect(drawer).toContain("重要名单：bank.example");
    expect(drawer).toContain("待重审");
    expect(drawer).toContain("测试：第 2 条例子不符（共 3 条）");
    expect(drawer).toContain("未登记的规则");
    expect(drawer).toContain("这一版的规则内容查不到");
    expect(drawer).toContain("测试：查不到");
    expect(drawer).toContain("只记了规则名，显示的是现在的版本");
    expect(drawer.split("只记了规则名，显示的是现在的版本").length).toBe(2);
    expect(drawer).toContain("判断了 3 封");
    expect(drawer).toContain("关联邮件：只读到一部分");
    expect(drawer).toContain("最近两天的对话摘要：带了 2 段");
    expect(drawer).toContain("我住在东京");
    expect(drawer).toContain("我搬到东京了");
    expect(drawer).toContain("推断依据");
    expect(drawer).toContain("周五吃了拉面");
    expect(drawer).toContain("受限记忆，模型也看不到，内容不在这里显示");
    expect(drawer).toContain("这条记忆已不存在");
    expect(drawer).toContain("做对了");
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>(".decision-chain .memory-link")]
        .find((item) => item.textContent === "看来源对话")
        ?.click();
    });
    expect(openThread).toHaveBeenCalledWith("thread-1", "message-1");
    expect(document.querySelector(".decision-chain")).toBeNull();
  });

  it("says no record for a section the record never kept, instead of leaving it blank", async () => {
    chainResult = chain({
      inputs: "not_recorded",
      rules: { state: "not_recorded", items: [] },
      mails: { judged: null, related: null, relatedRead: "not_recorded", summaries: null },
      memories: {
        state: "not_recorded",
        recall: "not_recorded",
        total: 0,
        truncated: false,
        items: [],
      },
      decision: { ...chain().decision, rating: null, ratedAt: null },
    });
    await openLog();
    await act(async () => rowButton("1")?.click());
    await flush();
    const drawer = text(".decision-chain");
    expect(drawer.match(/无记录/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(drawer).not.toContain("对话摘要");
    expect(drawer).toContain("还没评价");
  });

  it("[P2-2] titles the rules of a hard rule review as waiting for review and counts no mail", async () => {
    chainResult = chain({
      decision: { ...chain().decision, kind: "rule_review", outcome: "needs_review" },
      rules: {
        state: "recorded",
        items: [
          {
            ruleId: "quiet_hours",
            revision: 2,
            current: true,
            kind: "quiet_hours",
            origin: "owner_setting",
            source: "ADR 0106；主人的设置“静默时段”",
            status: "needs_review",
            changedAt: "2026-11-03T01:00:00.000Z",
            memory: null,
            wording: {
              values: [],
              quietHours: [{ days: [1, 2], start: "23:00", end: "07:00" }],
              amount: null,
            },
            tests: { state: "passed", total: 4, failedAt: null },
            mailCount: 0,
          },
        ],
      },
      mails: null,
    });
    await openLog();
    await act(async () => rowButton("1")?.click());
    await flush();
    const drawer = text(".decision-chain");
    expect(drawer).toContain("待重审的规则");
    expect(drawer).toContain("静默时段");
    expect(drawer).toContain("23:00–07:00");
    expect(drawer).not.toContain("命中的规则");
    expect(drawer).not.toContain("封邮件");
  });

  it("closes and says the record was cleared when it is gone, and says it failed on any other error", async () => {
    chainResult = Object.assign(new Error("PORT_NOT_FOUND"), { status: 404 });
    await openLog();
    await act(async () => rowButton("1")?.click());
    await flush();
    expect(document.querySelector(".decision-chain")).toBeNull();
    expect(text("#apps .proactive-log")).toContain("这条记录已被清除");
    chainResult = new Error("CONTROL_CENTER_REQUEST_REJECTED");
    await act(async () => rowButton("1")?.click());
    await flush();
    expect(text(".decision-chain")).toContain("读取失败");
    expect(document.querySelector(".decision-chain-memory")).toBeNull();
  });

  it("does not read the chain again, nor reset the drawer, when the page refreshes underneath it", async () => {
    chainResult = chain();
    await openLog();
    await act(async () => rowButton("1")?.click());
    await flush();
    const reads = () =>
      query.mock.calls.filter(([request]) => request.type === "decision.chain.read").length;
    expect(reads()).toBe(1);
    await click("#apps .proactive-log-row:nth-of-type(1)", "不该做");
    expect(commands().some((command) => command.type === "proactive.decision.rate")).toBe(true);
    expect(reads()).toBe(1);
    expect(text(".decision-chain")).toContain("命中的规则");
  });

  it("does not say no record for a memory whose basis was cut off", async () => {
    chainResult = chain({
      memories: {
        state: "recorded",
        recall: "ok",
        total: 1,
        truncated: false,
        items: [memoryItem({ inference: true, basis: { nodes: [], complete: false } })],
      },
    });
    await openLog();
    await act(async () => rowButton("1")?.click());
    await flush();
    const entry = text(".decision-chain-basis");
    expect(entry).toContain("依据没读全");
    expect(entry).not.toContain("无记录");
  });

  it("offers no basis button when the service does not install the read", async () => {
    await act(async () => root.render(h(Settings, { outcome: null })));
    await flush();
    await act(async () => {
      document.querySelector<HTMLElement>("#apps .proactive-log-entry summary")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(document.querySelectorAll("#apps .proactive-log-row").length).toBeGreaterThan(0);
    expect(text("#apps .proactive-log")).not.toContain("依据");
  });
});
