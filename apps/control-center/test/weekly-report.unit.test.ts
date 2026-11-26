// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl, IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemindersPage } from "../src/components/memory-page.tsx";
import { ProactiveAppsSettings } from "../src/components/proactive-settings.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages as en } from "../src/i18n/resources/en.ts";
import { messages as ja } from "../src/i18n/resources/ja.ts";
import { messages as zh } from "../src/i18n/resources/zh-CN.ts";
import { type MemoryOverview, useMemory } from "../src/memory.ts";
import {
  type CalibrationGroupSummary,
  type ObservationCheckItem,
  type ObservationDay,
  type ProactiveOverview,
  type ProactiveWeekly,
  useProactive,
} from "../src/proactive.ts";

const NOW = new Date("2026-11-04T03:00:00.000Z");
const baseOperations = [
  "memory.overview.read",
  "proactive.overview.read",
  "proactive.review.read",
  "proactive.source.manage",
];
const configurationWith = (operations: readonly string[]): ControlCenterRuntimeConfiguration => ({
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf-fixture",
  installedGatewayV2Operations: operations,
});
const withWeekly = configurationWith([...baseOperations, "proactive.weekly.read"]);
const withoutWeekly = configurationWith(baseOperations);
const catalogs = { "zh-CN": zh, en, ja } as const;
let locale: keyof typeof catalogs = "zh-CN";
const message = (id: MessageId, values?: Record<string, string | number>) =>
  createIntl({ locale, messages: catalogs[locale] }).formatMessage({ id }, values);
const query = vi.fn(),
  mutate = vi.fn(),
  fetcher = vi.fn();
const client = { query, mutate } as unknown as GatewayClient;
let container: HTMLDivElement, root: Root, weekly: ProactiveWeekly, recentRef: string | null;
let identity: "built-in" | "cloudflare-access" | "unavailable";

const memory = {
  memories: [],
  profile: [],
  pending: [],
  tidyUps: [],
  conversationReviews: [],
  reminders: [],
  upcoming: [],
  cancelled: [],
  people: [],
  imports: [],
  externalProposals: { total: 0, items: [], batches: [] },
  mcpSync: { entriesTotal: 0, entries: [], projects: [], attention: [] },
  capturePaused: false,
  generatedAt: NOW.toISOString(),
} as unknown as MemoryOverview;

const overview = {
  source: "gmail",
  connection: { status: "connected", account: "andy@example.com", connectedAt: null },
  enabled: true,
  quietHours: [],
  importantSenders: [],
  dailyLimitReached: false,
  insights: [],
  audit: { active: false, since: NOW.toISOString(), items: [], pending: 0 },
  decisions: [],
  metrics: { spoke: 5, hits: 3, misfires: 1, missed: 1, reviewed: 23 },
  generatedAt: NOW.toISOString(),
} as unknown as ProactiveOverview;

const pass = (code: string, reason: string, facts: Record<string, number | string> = {}) => ({
  code,
  status: "pass" as const,
  reason,
  facts,
});
const passingChecks: ObservationCheckItem[] = [
  pass("service_running", "all_hours", { missingHours: 0, longestGapHours: 0 }),
  pass("proactive_writing", "on_time", { rows: 96, longestGapMinutes: 16, limitMinutes: 40 }),
  pass("memory_capture", "running"),
  pass("consolidation_recorded", "rows_match", { changes: 3, rows: 3 }),
  pass("rows_kept", "nothing_missing", { checkedDays: 1 }),
  pass("time_format", "well_formed"),
];
const day = (
  date: string,
  status: ObservationDay["status"],
  checks: ObservationCheckItem[] = passingChecks,
) => ({
  day: date,
  status,
  checkedAt: status === "upcoming" || status === "no_check" ? null : `${date}T16:00:00.000Z`,
  serviceRevision: status === "upcoming" || status === "no_check" ? null : "41a6ce3",
  checks: status === "upcoming" || status === "no_check" ? [] : checks,
});
const rate = (successes: number, samples: number) =>
  samples < 5
    ? { successes, samples, enough: false, value: null, low: null, high: null }
    : { successes, samples, enough: true, value: successes / samples, low: 0.4, high: 0.9 };
const group = (
  name: CalibrationGroupSummary["group"],
  total: number,
  first: number,
  second: number,
  applicable: CalibrationGroupSummary["applicable"],
  withheld = false,
): CalibrationGroupSummary => {
  const rated = first + second;
  const counts = { useful: 0, unneeded: 0, missed: 0 };
  counts[applicable[0] as keyof typeof counts] = first;
  counts[applicable[1] as keyof typeof counts] = second;
  const of = (rating: keyof typeof counts) =>
    withheld || !applicable.includes(rating) ? null : rate(counts[rating], rated);
  return {
    group: name,
    total,
    rated,
    ...counts,
    applicable,
    rates: { useful: of("useful"), unneeded: of("unneeded"), missed: of("missed") },
  };
};
const signalRow = (
  signal: "opened" | "undone" | "replied",
  decisions: number,
  medianDelayMs: number | null,
  pushed: number,
) => ({
  signal,
  decisions,
  events: decisions,
  medianDelayMs,
  rate: pushed >= 5 ? rate(decisions, pushed) : null,
});
const implicit = {
  pushedDecisions: 0,
  otherDecisionEvents: 0,
  signals: [
    signalRow("opened", 0, null, 0),
    signalRow("undone", 0, null, 0),
    signalRow("replied", 0, null, 0),
  ],
};

function unsetFixture(): ProactiveWeekly {
  return {
    serviceRevision: "41a6ce3",
    observation: {
      startDay: null,
      earliestStartDay: "2026-11-05",
      setAt: null,
      startRevision: null,
      firstReportDay: null,
      passStreak: 0,
      streakSince: null,
      accepted: false,
      days: [],
    },
    report: {
      start: "2026-10-27T15:00:00.000Z",
      end: "2026-11-03T15:00:00.000Z",
      startDay: "2026-10-28",
      endDay: "2026-11-04",
      complete: true,
      ratesWithheld: false,
      minimumSamples: 5,
      groups: [],
      implicit,
      mcpConnections: null,
      prereview: {
        agreementPermille: 900,
        confidencePermille: 800,
        reductionEnabled: false,
        auditPermille: 200,
        minimumPairs: 35,
        otherVersions: 0,
        groups: [],
      },
      correction: null,
    },
    generatedAt: NOW.toISOString(),
  };
}

function observingFixture(): ProactiveWeekly {
  return {
    ...unsetFixture(),
    observation: {
      startDay: "2026-11-01",
      earliestStartDay: "2026-10-30",
      setAt: "2026-10-31T00:00:00.000Z",
      startRevision: "41a6ce3",
      firstReportDay: "2026-11-08",
      passStreak: 0,
      streakSince: null,
      accepted: false,
      days: [
        day("2026-11-01", "pass"),
        day("2026-11-02", "fail", [
          {
            code: "service_running",
            status: "fail",
            reason: "hours_missing",
            facts: { missingHours: 3, longestGapHours: 3 },
          },
          {
            code: "proactive_writing",
            status: "fail",
            reason: "gap_too_long",
            facts: { rows: 84, longestGapMinutes: 195, limitMinutes: 40 },
          },
          {
            code: "consolidation_recorded",
            status: "not_applicable",
            reason: "no_run",
            facts: {},
          },
          pass("rows_kept", "nothing_missing"),
        ]),
        day("2026-11-03", "no_check"),
        day("2026-11-04", "upcoming"),
        day("2026-11-05", "upcoming"),
        day("2026-11-06", "upcoming"),
        day("2026-11-07", "upcoming"),
      ],
    },
    report: {
      ...unsetFixture().report,
      start: "2026-10-31T15:00:00.000Z",
      end: "2026-11-07T15:00:00.000Z",
      startDay: "2026-11-01",
      endDay: "2026-11-08",
      complete: false,
      ratesWithheld: true,
      groups: [
        group("proactive_pushed", 5, 2, 1, ["useful", "unneeded"], true),
        group("memory_skipped", 38, 10, 2, ["useful", "missed"], true),
      ],
    },
  };
}

function reportedFixture(): ProactiveWeekly {
  const days = Array.from({ length: 7 }, (_, index) =>
    day(`2026-10-${String(20 + index).padStart(2, "0")}`, "pass"),
  );
  return {
    ...unsetFixture(),
    observation: {
      startDay: "2026-10-20",
      earliestStartDay: "2026-10-19",
      setAt: "2026-10-19T00:00:00.000Z",
      startRevision: "41a6ce3",
      firstReportDay: "2026-10-27",
      passStreak: 9,
      streakSince: "2026-10-20",
      accepted: true,
      days,
    },
    report: {
      ...unsetFixture().report,
      start: "2026-10-19T15:00:00.000Z",
      end: "2026-10-26T15:00:00.000Z",
      startDay: "2026-10-20",
      endDay: "2026-10-27",
      groups: [
        group("proactive_pushed", 12, 6, 2, ["useful", "unneeded"]),
        group("proactive_silent", 672, 5, 1, ["useful", "missed"]),
        group("memory_kept", 23, 4, 0, ["useful", "unneeded"]),
        group("consolidation", 9, 6, 1, ["useful", "unneeded"]),
        group("context_truncation", 17, 0, 0, ["useful", "unneeded"]),
      ],
    },
  };
}

function Page({ configuration }: { configuration: ControlCenterRuntimeConfiguration }) {
  const memoryModel = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
  const model = useProactive({ client, configuration, connected: true, refreshSignal: 0 });
  if (!memoryModel || !model) return null;
  return h(
    "div",
    { id: "page" },
    h(RemindersPage, {
      memory: memoryModel,
      proactive: model,
      locale,
      message,
      onOpenThread: () => undefined,
    }),
  );
}

function Settings() {
  const model = useProactive({
    client,
    configuration: withWeekly,
    connected: true,
    refreshSignal: 0,
  });
  if (!model) return null;
  return h(
    "div",
    { id: "apps" },
    h(ProactiveAppsSettings, { proactive: model, message, outcome: null }),
  );
}

async function flush() {
  await act(async () => {});
  await act(async () => {});
  await act(async () => {});
}

async function render(configuration = withWeekly) {
  await act(async () =>
    root.render(
      h(IntlProvider, { locale, messages: catalogs[locale] }, h(Page, { configuration })),
    ),
  );
  await flush();
}

const text = (scope: string) => document.querySelector(scope)?.textContent ?? "";
const weeklyReads = () =>
  query.mock.calls.filter(([request]) => request.type === "proactive.weekly.read").length;

function button(scope: string, label: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)];
  const found =
    buttons.find(
      (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
    ) ?? buttons.find((item) => item.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`missing ${label} in ${scope}`);
  return found;
}

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error("missing element");
  await act(async () => element.click());
  await flush();
}

async function openReport() {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('#page [role="tab"]')].find(
    (item) => item.textContent === message("reminders.tab.report"),
  );
  await click(tab);
}

function setPhone(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  vi.resetAllMocks();
  setPhone(false);
  locale = "zh-CN";
  weekly = reportedFixture();
  recentRef = null;
  identity = "built-in";
  query.mockImplementation(async (request: { type: string }) =>
    request.type === "proactive.weekly.read"
      ? { type: "proactive.weekly.snapshot", payload: weekly }
      : request.type === "proactive.overview.read"
        ? { type: "proactive.overview.snapshot", payload: overview }
        : request.type === "proactive.review.read"
          ? { type: "proactive.review.snapshot", payload: null }
          : { type: "memory.overview.snapshot", payload: memory },
  );
  mutate.mockResolvedValue({ resultRef: "observation-start:2026-11-06", replayed: false });
  fetcher.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url === "/api/identity/v1/method"
            ? { method: identity }
            : { ...withWeekly, recentAuthenticationRef: recentRef, csrfToken: "csrf-fresh" },
        ),
        {
          status: url === "/api/identity/v1/method" && identity === "unavailable" ? 503 : 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
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

describe("[P0-8] calibration report tab", () => {
  it("[P0-8] shows no tab when the weekly operation is not installed", async () => {
    await render(withoutWeekly);
    expect(document.querySelector('#page [role="tablist"]')).toBeNull();
    expect(text("#page")).not.toContain("校准周报");
    expect(weeklyReads()).toBe(0);
  });

  it("[P0-8] reads the report only when its tab opens and switches back to reminders", async () => {
    await render();
    const tabs = [...document.querySelectorAll('#page [role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["提醒", "校准周报"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(weeklyReads()).toBe(0);
    expect(document.querySelector("#page .weekly-report")).toBeNull();
    await openReport();
    expect(weeklyReads()).toBe(1);
    expect(document.querySelector("#page .weekly-report")).not.toBeNull();
    expect(text("#page .weekly-window")).toBe("10 月 20 日 – 10 月 26 日");
    await click(button("#page .weekly-foot", "去「提醒」打分"));
    expect(document.querySelector("#page .weekly-report")).toBeNull();
    expect(document.querySelector('#page [role="tab"][aria-selected="true"]')?.textContent).toBe(
      "提醒",
    );
  });

  it("[P0-8] starts observation only after confirming and a recent identity check", async () => {
    weekly = unsetFixture();
    await render();
    await openReport();
    expect(text("#page .weekly-report")).toContain("选一天开始，连续观察 7 天。");
    expect(text("#page .weekly-stepper output")).toContain("11 月 5 日");
    expect(button("#page .weekly-stepper", "前一天").disabled).toBe(true);
    await click(button("#page .weekly-stepper", "后一天"));
    expect(text("#page .weekly-stepper output")).toContain("11 月 6 日");
    expect(text("#page .weekly-report")).toContain("还没开始观察");
    await click(button("#page .weekly-start", "从这天开始"));
    const dialog = document.querySelector("dialog[open]");
    expect(dialog?.textContent).toContain("从 11 月 6 日 开始观察？");
    expect(dialog?.textContent).toContain("设好后不能改。");
    expect(dialog?.textContent).toContain("最早可选 11 月 5 日：新版本 11 月 4 日第一次启动");
    expect(mutate).not.toHaveBeenCalled();
    await click(button("dialog[open]", "确定"));
    expect(fetcher).toHaveBeenCalledWith("/api/control-center/v1/config", expect.anything());
    expect(mutate).not.toHaveBeenCalled();
    expect(text("dialog[open]")).toContain("设定数据起点前，要再验证一次身份。");
    expect(document.querySelector("dialog[open] input[name='password']")).not.toBeNull();
    await click(button("dialog[open]", "取消"));
    recentRef = "auth-recent";
    weekly = observingFixture();
    await click(button("dialog[open]", "确定"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.lastCall?.[0]).toMatchObject({
      type: "proactive.observation.start",
      payload: { startDay: "2026-11-06", recentAuthenticationRef: "auth-recent" },
    });
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(weeklyReads()).toBe(2);
    expect(text("#page .weekly-headline")).toBe("观察期第 4 / 7 天");
  });

  it("[P0-8] sends an Access-signed-in owner to sign in again instead of showing a password form", async () => {
    weekly = unsetFixture();
    identity = "cloudflare-access";
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await render();
    await openReport();
    await click(button("#page .weekly-start", "从这天开始"));
    await click(button("dialog[open]", "确定"));
    expect(text("dialog[open]")).toContain(
      "登录已超过 5 分钟。先退出、重新登录，再回到这里设定起点。",
    );
    expect(document.querySelector("dialog[open] input[name='password']")).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    await click(button("dialog[open]", "退出并重新登录"));
    expect(assign).toHaveBeenCalledWith("/cdn-cgi/access/logout");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("[P0-8] sends the built-in identity check with the freshly read form token", async () => {
    weekly = unsetFixture();
    await render();
    await openReport();
    await click(button("#page .weekly-start", "从这天开始"));
    await click(button("dialog[open]", "确定"));
    const form = document.querySelector<HTMLFormElement>("dialog[open] form");
    if (!form) throw new Error("form missing");
    for (const [name, value] of [
      ["username", "andy"],
      ["password", "secret"],
    ] as const) {
      const input = form.querySelector<HTMLInputElement>(`input[name='${name}']`);
      if (input) input.value = value;
    }
    await act(async () => {
      form.requestSubmit();
    });
    const sent = fetcher.mock.calls.find(([url]) => url === "/api/identity/v1/reauthenticate");
    expect(sent?.[1]?.headers).toMatchObject({ "x-csrf-token": "csrf-fresh" });
  });

  it("[P0-8] sends one start command when confirm is pressed twice before the page updates", async () => {
    weekly = unsetFixture();
    recentRef = "auth-recent";
    await render();
    await openReport();
    await click(button("#page .weekly-start", "从这天开始"));
    const confirm = button("dialog[open]", "确定");
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("[P0-8] keeps the start button off after a successful start while the report is still reloading", async () => {
    weekly = unsetFixture();
    recentRef = "auth-recent";
    await render();
    await openReport();
    const reads = weeklyReads();
    query.mockImplementation(async (request: { type: string }) =>
      request.type === "proactive.weekly.read"
        ? new Promise(() => undefined)
        : request.type === "proactive.overview.read"
          ? { type: "proactive.overview.snapshot", payload: overview }
          : request.type === "proactive.review.read"
            ? { type: "proactive.review.snapshot", payload: null }
            : { type: "memory.overview.snapshot", payload: memory },
    );
    await click(button("#page .weekly-start", "从这天开始"));
    await click(button("dialog[open]", "确定"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(weeklyReads()).toBe(reads + 1);
    const start = button("#page .weekly-start", "从这天开始");
    expect(start.disabled).toBe(true);
    await act(async () => {
      start.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const again = document.querySelector("dialog[open]") ? button("dialog[open]", "确定") : null;
    if (again)
      await act(async () => {
        again.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("[P0-8] shows an error instead of a password form when the sign-in method cannot be read", async () => {
    weekly = unsetFixture();
    identity = "unavailable";
    await render();
    await openReport();
    await click(button("#page .weekly-start", "从这天开始"));
    await click(button("dialog[open]", "确定"));
    expect(text("dialog[open]")).toContain("没有设好，请再试一次。");
    expect(document.querySelector("dialog[open] input[name='password']")).toBeNull();
    expect(text("dialog[open]")).not.toContain("退出并重新登录");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("[P0-8] hides every ratio while the observation period is running and explains the bad days", async () => {
    weekly = observingFixture();
    await render();
    await openReport();
    const report = text("#page .weekly-report");
    expect(text("#page .weekly-window")).toBe("11 月 1 日至今");
    expect(report).toContain("观察期还没满 7 天");
    expect(report).not.toMatch(/%/u);
    expect(report).not.toContain("提醒得对");
    expect(
      [...document.querySelectorAll("#page .weekly-table th")].map((cell) => cell.textContent),
    ).toEqual(["决策类型", "决策条数", "你评过的条数"]);
    expect(text('#page .weekly-line[data-tone="bad"]')).toBe(
      "11 月 2 日失败、11 月 3 日没有检查记录",
    );
    expect(document.querySelectorAll("#page button.weekly-day")).toHaveLength(3);
    expect(document.querySelectorAll('#page div.weekly-day[data-status="upcoming"]')).toHaveLength(
      4,
    );
    expect(text("#page .weekly-today")).toBe("今天");
  });

  it("[P0-11] [negative] shows no signal numbers before the observation has started", async () => {
    const unset = unsetFixture();
    weekly = {
      ...unset,
      report: {
        ...unset.report,
        ratesWithheld: false,
        implicit: {
          pushedDecisions: 12,
          otherDecisionEvents: 2,
          signals: [
            signalRow("opened", 6, 60_000, 12),
            signalRow("undone", 1, 60_000, 12),
            signalRow("replied", 2, 60_000, 12),
          ],
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="观察信号 · 不是打分"]');
    expect(card).toContain("还没开始观察");
    expect(card).not.toMatch(/%/u);
    expect(card).not.toContain("另有");
    expect(document.querySelector("#page .weekly-tiles[data-count='3']")).toBeNull();
  });

  it("[P0-11] [negative] shows no signal numbers while the observation is set but has not begun", async () => {
    const unset = unsetFixture();
    weekly = {
      ...unset,
      observation: {
        ...unset.observation,
        startDay: "2026-11-05",
        setAt: NOW.toISOString(),
        startRevision: "41a6ce3",
      },
      report: {
        ...unset.report,
        implicit: {
          pushedDecisions: 12,
          otherDecisionEvents: 2,
          signals: [
            signalRow("opened", 6, 60_000, 12),
            signalRow("undone", 1, 60_000, 12),
            signalRow("replied", 2, 60_000, 12),
          ],
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="观察信号 · 不是打分"]');
    expect(card).toContain("还没开始观察");
    expect(card).not.toMatch(/%/u);
    expect(document.querySelector("#page .weekly-tiles[data-count='3']")).toBeNull();
  });

  it("[P0-11] says the week is not over instead of 'too few' while ratios are withheld", async () => {
    const observing = observingFixture();
    weekly = {
      ...observing,
      report: {
        ...observing.report,
        implicit: {
          pushedDecisions: 12,
          otherDecisionEvents: 0,
          signals: [
            signalRow("opened", 5, 60_000, 0),
            signalRow("undone", 1, 60_000, 0),
            signalRow("replied", 0, null, 0),
          ],
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="观察信号 · 不是打分"]');
    expect(card).toContain("本周尚未结束");
    expect(card).not.toContain("样本不足");
    expect(card).not.toMatch(/%/u);
  });

  it("[P0-8] opens a day's checks as plain sentences without raw codes", async () => {
    weekly = observingFixture();
    await render();
    await openReport();
    const failed = document.querySelector<HTMLButtonElement>(
      '#page button.weekly-day[data-status="fail"]',
    );
    await click(failed);
    expect(failed?.getAttribute("aria-expanded")).toBe("true");
    const detail = text("#page .weekly-detail");
    expect(detail).toContain("第 2 天 · 11 月 2 日 · 失败");
    expect(detail).toContain("服务有 3 个小时没有运行，最长一次连着停了 3 个小时");
    expect(detail).toContain(
      "Gmail 检查只写了 84 次记录，最长间隔 3 小时 15 分钟，超过了允许的 40 分钟",
    );
    expect(detail).toContain("已检查过的日子没有少记录");
    expect(detail).not.toContain("这天没有整理记忆");
    expect(detail).not.toMatch(/[a-z]+_[a-z_]+/u);
    await click(
      document.querySelector<HTMLButtonElement>('#page button.weekly-day[data-status="no_check"]'),
    );
    expect(text("#page .weekly-detail")).toContain(
      "这天没有 Himawari 自己的检查记录，不知道这天的决策记录全不全",
    );
    await click(button("#page .weekly-detail", "收起"));
    expect(document.querySelector("#page .weekly-detail")).toBeNull();
  });

  it("[P0-8] labels each finished row in its own words and never shows 0% for too few ratings", async () => {
    await render();
    await openReport();
    const row = (name: string) => text(`#page .weekly-table tr[data-group="${name}"]`);
    expect(text("#page .weekly-headline")).toBe("首份校准周报");
    expect(text('#page .weekly-line[data-tone="ok"]')).toBe("连续 7 天全部通过");
    expect(row("proactive_pushed")).toContain("提醒得对75.0%（6/8）");
    expect(row("proactive_pushed")).toContain("不该提醒25.0%（2/8）");
    expect(row("proactive_silent")).toContain("不提醒是对的83.3%（5/6）");
    expect(row("proactive_silent")).toContain("该提醒没提醒16.7%（1/6）");
    expect(row("proactive_silent")).not.toContain("不该提醒");
    expect(row("memory_kept")).toContain("样本不足（4 条）");
    expect(row("memory_kept")).not.toMatch(/%/u);
    expect(row("memory_skipped")).toContain("样本不足（0 条）");
    expect(row("memory_skipped")).not.toMatch(/%/u);
    expect(text("#page .weekly-report")).not.toMatch(/(^|[^\d.])0(\.0)?%/u);
    expect(row("context_truncation")).toBe("");
    await click(button("#page .weekly-report", "其他判断 · 1 类 · 展开"));
    expect(row("context_truncation")).toContain("样本不足（0 条）");
    const tiles = [
      ...document.querySelectorAll("#page .weekly-tiles[data-count='4'] .weekly-tile"),
    ];
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      "5主动提醒总次数",
      "3恰当的提醒",
      "1多余的提醒",
      "1漏提醒（你查过的邮件里）已审 23 封",
    ]);
  });

  it("[P3-5] asks whether a failed memory capture lost anything, in its own words", async () => {
    const reported = reportedFixture();
    weekly = {
      ...reported,
      report: {
        ...reported.report,
        groups: [
          ...reported.report.groups,
          group("memory_capture_failed", 7, 5, 1, ["useful", "missed"]),
        ],
      },
    };
    await render();
    await openReport();
    await click(button("#page .weekly-report", "其他判断 · 2 类 · 展开"));
    const row = text('#page .weekly-table tr[data-group="memory_capture_failed"]');
    expect(row).toContain("没漏掉什么83.3%（5/6）");
    expect(row).toContain("漏了该记的16.7%（1/6）");
    expect(row).not.toContain("做对了");
    expect(row).not.toContain("该做没做");
  });

  it("[P0-11] shows observed signals in their own card, apart from the rating rows", async () => {
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        implicit: {
          pushedDecisions: 8,
          otherDecisionEvents: 2,
          signals: [
            signalRow("opened", 5, 25 * 60_000, 8),
            signalRow("undone", 1, 90_000, 8),
            signalRow("replied", 0, null, 8),
          ],
        },
      },
    };
    await render();
    await openReport();
    const tiles = [
      ...document.querySelectorAll("#page .weekly-tiles[data-count='3'] .weekly-tile"),
    ].map((tile) => tile.textContent);
    expect(tiles).toEqual([
      "62.5%（5/8）点开了推送首次发生的中位间隔 25 分钟",
      "12.5%（1/8）完成或不再提醒后又撤销首次发生的中位间隔 2 分钟",
      "0.0%（0/8）邮件串里你回复了还没有发生",
    ]);
    expect(text('#page [aria-label="观察信号 · 不是打分"]')).toContain("另有 2 条信号");
    expect(text("#page .weekly-table")).not.toContain("点开了推送");
  });

  it("[P0-11] [negative] shows no ratio when no decision sent a reminder or the sample is too small", async () => {
    await render();
    await openReport();
    expect(text('#page [aria-label="观察信号 · 不是打分"]')).toBe(
      "观察信号 · 不是打分这一周没有推送过提醒的决策。",
    );
  });

  it("[P4-8] shows model pre-rating agreement per type with its bar and audit count", async () => {
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        prereview: {
          ...weekly.report.prereview,
          reductionEnabled: true,
          otherVersions: 3,
          groups: [
            {
              group: "proactive_silent",
              prereviewed: 40,
              unsure: 6,
              paired: 30,
              agreement: rate(27, 30),
              kappa: 0.6,
              balancedAccuracy: 0.8,
              ownerUseful: rate(25, 30),
              hidden: rate(20, 22),
              confusion: [{ model: "useful", owner: "useful", count: 24 }],
              gate: { open: false, reason: "insufficient", requiredAgreement: 0.97 },
            },
          ],
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="模型预评一致率"]');
    expect(card).toContain("90.0%（27/30）读完邮件没提醒");
    expect(card).toContain("预评 40 条 · 模型拿不准 6 条 · 你也评过 30 条");
    expect(card).toContain("这一周对数不够，还不能判断");
    expect(card).toContain("模型有把握评“有用”的里，你也评有用 20/22");
    expect(card).toContain("另有 3 条预评来自旧的模型或提示词版本");
    expect(card).toContain("另随机留 20.0% 抽查");
  });

  it("[P4-8] [negative] says no pre-rating from the current version when only older versions exist", async () => {
    const empty = (
      [
        "proactive_pushed",
        "proactive_silent",
        "memory_skipped",
        "memory_kept",
        "consolidation",
      ] as const
    ).map((group) => ({
      group,
      prereviewed: 0,
      unsure: 0,
      paired: 0,
      agreement: null,
      kappa: null,
      balancedAccuracy: null,
      ownerUseful: null,
      hidden: null,
      confusion: [],
      gate: null,
    }));
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        prereview: { ...weekly.report.prereview, otherVersions: 4, groups: empty },
      },
    };
    await render();
    await openReport();
    const onlyOld = text('#page [aria-label="模型预评一致率"]');
    expect(onlyOld).toContain("这一周还没有当前这一版模型和提示词做的预评。");
    expect(onlyOld).toContain("另有 4 条预评来自旧的模型或提示词版本");
    expect(onlyOld).not.toContain("这一周还没有模型预评过");
  });

  it("[P4-8] [negative] shows no agreement number when nothing was pre-rated and says reduction is off", async () => {
    const empty = (
      [
        "proactive_pushed",
        "proactive_silent",
        "memory_skipped",
        "memory_kept",
        "consolidation",
      ] as const
    ).map((group) => ({
      group,
      prereviewed: 0,
      unsure: 0,
      paired: 0,
      agreement: null,
      kappa: null,
      balancedAccuracy: null,
      ownerUseful: null,
      hidden: null,
      confusion: [],
      gate: null,
    }));
    weekly = {
      ...weekly,
      report: { ...weekly.report, prereview: { ...weekly.report.prereview, groups: empty } },
    };
    await render();
    await openReport();
    expect(text('#page [aria-label="模型预评一致率"]')).toBe(
      "模型预评一致率这一周还没有模型预评过、你也打过分的决策。自动减少没有开启：「每天打分」仍给你看全部待打分的决策。",
    );
  });

  it("[P4-1] shows how often the follow-up flags after a memory edit were right, the misses and what is still open", async () => {
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        correction: {
          handled: 8,
          agreed: 6,
          missed: 2,
          openMemories: 3,
          openRules: 1,
          agreement: { successes: 6, samples: 8, enough: true, value: 0.75, low: 0.41, high: 0.93 },
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="改记忆后跟着标的一致率"]');
    expect(card).toContain("75.0%（6/8）");
    expect(card).toContain("系统标了 8 条，你认可 6 条");
    expect(document.querySelector('[data-correction-tile="missed"] b')?.textContent).toBe("2");
    expect(document.querySelector('[data-correction-tile="open"] b')?.textContent).toBe("4");
    expect(card).toContain("没处理的不算");
  });

  it("[P4-1] [negative] says too few instead of a ratio below five handled flags, and shows no card without the numbers", async () => {
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        correction: {
          handled: 3,
          agreed: 3,
          missed: 0,
          openMemories: 0,
          openRules: 0,
          agreement: {
            successes: 3,
            samples: 3,
            enough: false,
            value: null,
            low: null,
            high: null,
          },
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="改记忆后跟着标的一致率"]');
    expect(card).toContain("样本不足（3 条）");
    expect(card).not.toContain("%");
    weekly = { ...weekly, report: { ...weekly.report, correction: null } };
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await openReport();
    expect(document.querySelector("[data-correction]")).toBeNull();
  });

  it("[P0-11] still counts signals on undelivered decisions when no decision sent a reminder", async () => {
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        implicit: {
          pushedDecisions: 0,
          otherDecisionEvents: 2,
          signals: [
            signalRow("opened", 0, null, 0),
            signalRow("undone", 0, null, 0),
            signalRow("replied", 0, null, 0),
          ],
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="观察信号 · 不是打分"]');
    expect(card).toContain("这一周没有推送过提醒的决策。");
    expect(card).toContain("另有 2 条信号");
    expect(document.querySelector("#page .weekly-tiles[data-count='3']")).toBeNull();
  });

  it("[P0-11] [negative] shows no percentage when too few decisions sent a reminder", async () => {
    weekly = {
      ...weekly,
      report: {
        ...weekly.report,
        implicit: {
          pushedDecisions: 3,
          otherDecisionEvents: 0,
          signals: [
            signalRow("opened", 2, 60_000, 3),
            signalRow("undone", 0, null, 3),
            signalRow("replied", 0, null, 3),
          ],
        },
      },
    };
    await render();
    await openReport();
    const card = text('#page [aria-label="观察信号 · 不是打分"]');
    expect(card).toContain("样本不足（3 条）");
    expect(card).not.toMatch(/%/u);
  });

  it("[P0-8] opens and closes the explanations with Esc and an outside click", async () => {
    await render();
    await openReport();
    const info = () =>
      document.querySelector<HTMLButtonElement>('#page .weekly-info[data-info="type"]');
    await click(info());
    expect(info()?.getAttribute("aria-expanded")).toBe("true");
    const popover = document.querySelector('[role="dialog"].weekly-popover');
    expect(popover?.textContent).toContain("分母是你评过的条数。");
    expect(document.activeElement).toBe(popover);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".weekly-popover")).toBeNull();
    expect(document.activeElement).toBe(info());
    await click(info());
    expect(document.querySelector(".weekly-popover")).not.toBeNull();
    await act(async () => {
      document
        .querySelector(".weekly-popover")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector(".weekly-popover")).not.toBeNull();
    await act(async () => {
      document
        .querySelector("#page .weekly-window")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector(".weekly-popover")).toBeNull();
    await click(info());
    await click(info());
    expect(document.querySelector(".weekly-popover")).toBeNull();
    await click(document.querySelector<HTMLButtonElement>('#page .weekly-info[data-info="stats"]'));
    expect(text(".weekly-popover")).toContain("最近 30 天");
  });

  it("[P0-8] uses bottom sheets on a phone for explanations and day checks", async () => {
    setPhone(true);
    weekly = observingFixture();
    await render();
    await openReport();
    await click(document.querySelector<HTMLButtonElement>('#page .weekly-info[data-info="obs"]'));
    expect(document.querySelector(".weekly-popover")).toBeNull();
    expect(text("dialog[open]")).toContain("数据起点 11 月 1 日 · 11 月 8 日出首份校准周报");
    expect(text("dialog[open]")).toContain("版本 41a6ce3");
    await click(button("dialog[open] .weekly-sheet", "关闭"));
    expect(document.querySelector("dialog[open]")).toBeNull();
    await click(
      document.querySelector<HTMLButtonElement>('#page button.weekly-day[data-status="fail"]'),
    );
    expect(document.querySelector("#page .weekly-detail")).toBeNull();
    expect(text("dialog[open]")).toContain("服务有 3 个小时没有运行");
  });

  it("[P0-8] says when the report could not be read and retries", async () => {
    query.mockImplementation(async (request: { type: string }) => {
      if (request.type === "proactive.weekly.read") throw new Error("offline");
      return request.type === "proactive.overview.read"
        ? { type: "proactive.overview.snapshot", payload: overview }
        : { type: "memory.overview.snapshot", payload: memory };
    });
    await render();
    await openReport();
    expect(text("#page [role='alert']")).toContain("校准周报没读到。");
    query.mockImplementation(async (request: { type: string }) =>
      request.type === "proactive.weekly.read"
        ? { type: "proactive.weekly.snapshot", payload: weekly }
        : { type: "memory.overview.snapshot", payload: memory },
    );
    await click(button("#page .weekly-report", "重试"));
    expect(text("#page .weekly-headline")).toBe("首份校准周报");
  });

  it("[P0-8] reads the rows in English and Japanese", async () => {
    for (const [next, expected] of [
      [
        "en",
        ["Calibration report", "Right to remind", "Right to stay silent", "Too few rated (4)"],
      ],
      ["ja", ["較正レポート", "通知は正しかった", "通知しないのが正しかった", "件数不足（4 件）"]],
    ] as const) {
      locale = next;
      await render();
      await openReport();
      for (const value of expected) expect(text("#page")).toContain(value);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("[P0-8] no longer shows the four reminder counts in settings", async () => {
    await act(async () => root.render(h(Settings)));
    await flush();
    const entry = document.querySelector<HTMLDetailsElement>("#apps .proactive-log-entry");
    await act(async () => {
      entry?.querySelector("summary")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(text("#apps")).toContain("提醒检查记录");
    for (const moved of ["主动提醒总次数", "恰当的提醒", "多余的提醒", "漏提醒（你查过的邮件里）"])
      expect(text("#apps")).not.toContain(moved);
  });
});
