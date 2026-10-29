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
  type GmailOutcome,
  OPEN_SETTINGS,
  type ProactiveOverview,
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
    "proactive.source.manage",
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
let container: HTMLDivElement, root: Root, proactive: ProactiveOverview, memory: MemoryOverview;

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
    ],
    metrics: { spoke: 5, hits: 3, misfires: 1, missed: 1, reviewed: 23 },
    generatedAt: NOW.toISOString(),
  } as ProactiveOverview;
}

function memoryFixture(): MemoryOverview {
  return {
    memories: [],
    profile: [],
    pending: [],
    tidyUps: [],
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
      onBack: () => undefined,
      onOpenThread: () => undefined,
    }),
  );
}

function Settings({ outcome }: { outcome: GmailOutcome | null }) {
  const model = useProactive({ client, configuration, connected: true, refreshSignal: 0, assign });
  if (!model) return null;
  return h(
    "div",
    { id: "settings" },
    h(
      "div",
      { id: "notifications" },
      h(ProactiveNotificationSettings, { proactive: model, locale, message }),
    ),
    h("div", { id: "apps" }, h(ProactiveAppsSettings, { proactive: model, message, outcome })),
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
const lastCommand = () => mutate.mock.lastCall?.[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  locale = "zh-CN";
  proactive = overviewFixture();
  memory = memoryFixture();
  query.mockImplementation(async (request: { type: string }) =>
    request.type === "proactive.overview.read"
      ? { type: "proactive.overview.snapshot", payload: proactive }
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
    expect(text("#reminder-pension")).toContain("重要来信不放过");
    expect(text("#reminder-airbnb")).toContain("没交给模型");
    expect(text("#reminder-github")).toContain("你已回复");
    const row = "#reminder-rakuten";
    expect(text(row)).toContain("11 月账单 ¥38,420");
    expect(text(row)).toContain("比上月多 ¥12,000");
    expect(text(row)).toContain("楽天カード");
    expect(document.querySelector(`${row} [data-priority="high"]`)?.textContent).toBe("高");
    expect(text(row)).toContain("推送过 · 你点开了");
    expect(text("#reminder-ward")).toContain("今天");
    expect(document.querySelector(`${row} a`)?.getAttribute("href")).toBe(
      "https://mail.google.com/mail/u/0/#all/rakuten",
    );
    await click(row, "有用");
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
    await click("#reminder-ward", "不再提醒");
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

  it("[PG-15] lists ignored mail for review and counts it only after Done reviewing", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    expect(text("#page .proactive-audit")).toContain("今天判为不用管的 2 封");
    expect(text("#page .proactive-audit")).not.toContain("Amazon.co.jp");
    await click("#page .proactive-audit", "抽查");
    expect(text("#page .proactive-audit")).toContain("Amazon.co.jp");
    expect(text("#page .proactive-audit")).toContain("ご注文の商品を発送しました");
    const before = commands().length;
    await click("#page .proactive-audit li:first-child", "该说没说");
    expect(lastCommand()).toMatchObject({
      type: "proactive.audit.respond",
      payload: { action: "rate", messageIds: ["a1"], rating: "missed" },
    });
    await click("#page .proactive-audit", "看完了");
    expect(commands().length).toBe(before + 2);
    expect(lastCommand()).toMatchObject({
      payload: { action: "review", messageIds: ["a1", "a2"], rating: null },
    });
  });

  it("[PG-15] shows one line per check in the decision log and takes ratings", async () => {
    await act(async () => root.render(h(Page, { focus: null })));
    await flush();
    await click("#page .side-page-title", "决策记录");
    expect(text("#page h1")).toBe("决策记录");
    const summary = text("#page .proactive-summary");
    for (const part of ["开口5", "命中3", "误扰1", "已审样本内漏报1", "已审 23 封", "已记录 2 天"])
      expect(summary.replace(/\s/gu, "")).toContain(part.replace(/\s/gu, ""));
    const rows = [...document.querySelectorAll<HTMLElement>("#page .proactive-log-row")];
    expect(rows.map((row) => row.dataset["tone"])).toEqual(["spoke", "quiet", "warn", "warn"]);
    expect(rows[0]?.textContent).toContain("推送了 1 件要你处理的事");
    expect(rows[0]?.textContent).toContain("你点开了");
    expect(rows[1]?.textContent).toContain("2 封新邮件，都是推广这类，按规则跳过，没交给模型");
    expect(rows[2]?.textContent).toContain("15 分钟后照常再看");
    expect(rows[3]?.textContent).toContain("每日费用上限");
    expect(text("#page")).toContain("昨天");
    await click("#page .proactive-log-row:nth-of-type(1)", "没必要");
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
          "Decision log",
        ],
      ],
      [
        "ja",
        ["重要かも、元のメールを確認", "本日", "通知済み · 開きました", "元のメール", "判断の記録"],
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
    expect(text("#apps details")).toContain("不发正文");
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
    expect(document.querySelector<HTMLDetailsElement>("#apps details")?.open).toBe(true);
    await click("#apps .proactive-app", "连接 Gmail");
    expect(assign).toHaveBeenCalledWith("/api/proactive/v1/google/start");
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
