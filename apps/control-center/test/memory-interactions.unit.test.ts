// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPage, RemindersPage } from "../src/components/memory-page.tsx";
import {
  focusedMemoryIds,
  MemoryReminders,
  MemoryTurnNote,
  OPEN_MEMORY_PAGE,
} from "../src/components/memory-panel.tsx";
import { AutoMemorySetting } from "../src/components/personalization-settings.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import { type MemoryItem, type MemoryOverview, useMemory } from "../src/memory.ts";
import { memoryChain } from "../src/memory-history.ts";
import {
  applyImportClassifications,
  applyImportDuplicates,
  type ImportClassification,
  parseMemoryExport,
  parseMemoryText,
} from "../src/memory-import.ts";

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
    "memory.classify.read",
    "memory.import.duplicates.read",
    "memory.approval.respond",
    "memory.mutate",
  ],
};
const intl = createIntl({ locale: "zh-CN", messages });
const message = (id: MessageId, values?: Record<string, string | number>) =>
  intl.formatMessage({ id }, values);
const query = vi.fn(),
  mutate = vi.fn(),
  protectText = vi.fn();
const client = { query, mutate, protectText } as unknown as GatewayClient;
type Classified = ImportClassification;
let classifyAnswers: Classified[] = [];
let classifyFails = false;
let duplicateAnswers: ("same" | "unsure" | "different" | "skipped")[] = [];
let duplicatesFail = false;
let duplicateAsked: string[][] = [];
const classified = (
  category: ImportClassification["category"],
  classification: "private" | "sensitive" = "private",
  topic: ImportClassification["topic"] = null,
): Classified => ({ category, classification, topic, failed: false });
let container: HTMLDivElement, root: Root, overview: MemoryOverview;
const opened = vi.fn();

function memoryItem(memoryId: string, text: string, change: Partial<MemoryItem> = {}): MemoryItem {
  return {
    memoryId,
    revision: 1,
    text,
    dataClassification: "private",
    topic: null,
    inference: false,
    sourceThreadId: "thread-1",
    sourceMessageId: "message-1",
    sourceRefs: ["payload-1"],
    updatedAt: "2026-10-25T12:00:00.000Z",
    supersededBy: null,
    validTo: null,
    tentative: false,
    category: "preference",
    subCategory: null,
    status: "active",
    recordedAt: "2026-10-25T12:00:00.000Z",
    importance: 500,
    profilePin: null,
    lastUsedAt: null,
    importBatchId: null,
    stance: null,
    history: [],
    ...change,
  };
}

let nextHistoryId = 0;

function node(
  kind: MemoryItem["history"][number]["kind"],
  text: string,
  stance: string,
  at: string,
  change: Partial<MemoryItem["history"][number]> = {},
): MemoryItem["history"][number] {
  nextHistoryId += 1;
  return {
    historyId: nextHistoryId,
    kind,
    text,
    stance,
    quote: null,
    sourceThreadId: "thread-out",
    sourceDeleted: false,
    at,
    ...change,
  };
}

function outingChain(): MemoryItem[] {
  const steps = [
    ["主人很喜欢出去玩", "想出去玩", "2026-10-26T12:04:00.000Z"],
    ["主人不爱出去玩，有社恐", "不想出去玩", "2026-10-27T00:12:00.000Z"],
    ["主人最近想出去玩", "想出去玩", "2026-10-27T23:05:00.000Z"],
    ["主人最近不想出去玩", "不想出去玩", "2026-10-28T04:30:00.000Z"],
    ["主人最近一个月都不想出去玩", "不想出去玩", "2026-10-29T03:10:00.000Z"],
  ] as const;
  return steps.map(([wording, stance, at], index) =>
    memoryItem(`memory-out-${index + 1}`, wording, {
      category: "preference",
      subCategory: "社交",
      stance,
      recordedAt: at,
      updatedAt: at,
      sourceThreadId: index === 1 ? null : `thread-out-${index + 1}`,
      supersededBy: index < steps.length - 1 ? `memory-out-${index + 2}` : null,
      history: [
        node("created", wording, stance, at, {
          sourceThreadId: index === 1 ? null : `thread-out-${index + 1}`,
          sourceDeleted: index === 1,
          quote: index === 1 ? null : wording.replace("主人", ""),
        }),
        ...(index === 3
          ? [
              node("reaffirmed", wording, stance, "2026-10-28T06:00:00.000Z", {
                sourceThreadId: "thread-out-6",
                quote: "真的不想出去",
              }),
            ]
          : []),
      ],
    }),
  );
}

function Harness({ ownerRefs }: { ownerRefs: readonly string[] }) {
  const memory = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
  if (!memory) return null;
  return h(
    "div",
    null,
    h("div", { id: "turn" }, h(MemoryTurnNote, { ownerRefs, memory, message })),
    h("div", { id: "settings" }, h(MemoryPage, { memory, message, onOpenThread: opened })),
    h("div", { id: "reminders" }, h(MemoryReminders, { memory, message })),
    h("div", { id: "personalization" }, h(AutoMemorySetting, { memory, message })),
    h("div", { id: "reminders-page" }, h(RemindersPage, { memory, message, onOpenThread: opened })),
  );
}

function MemoryPageWithFocus({ focus }: { focus: readonly string[] }) {
  const memory = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
  if (!memory) return null;
  return h(
    "div",
    { id: "settings" },
    h(MemoryPage, {
      memory,
      message,
      focus,
      onOpenThread: opened,
    }),
  );
}

async function render(ownerRefs: readonly string[] = ["payload-1"]) {
  await act(async () => root.render(h(Harness, { ownerRefs })));
  await act(async () => {});
}

const text = (scope: string) => document.querySelector(scope)?.textContent ?? "";

function button(scope: string, label: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)];
  const found =
    buttons.find((item) => item.textContent?.trim() === label) ??
    buttons.find((item) => item.textContent?.startsWith(label));
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

async function click(scope: string, label: string) {
  await act(async () => button(scope, label).click());
  await act(async () => {});
}

async function tab(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("#settings [role=tab]")].find(
    (item) => item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`missing tab ${label}`);
  await act(async () => found.click());
}

async function type(selector: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field) throw new Error(`missing ${selector}`);
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const lastCommand = () => mutate.mock.lastCall?.[0];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  overview = {
    memories: [
      memoryItem("memory-color", "主人最喜欢的颜色是蓝色", {
        revision: 2,
        subCategory: "颜色",
      }),
      memoryItem("memory-city", "主人住在上海", {
        sourceThreadId: "thread-2",
        sourceMessageId: "message-9",
        sourceRefs: ["payload-9"],
        category: "identity",
        updatedAt: "2026-10-24T12:00:00.000Z",
        recordedAt: "2026-10-24T12:00:00.000Z",
      }),
    ],
    profile: [],
    profileUsage: { used: 0, limit: 2000, pinned: 0, queued: [] },
    lastViewedAt: null,
    externalProposals: { total: 0, items: [], batches: [] },
    mcpSync: { entriesTotal: 0, entries: [], projects: [], attention: [] },
    pending: [
      {
        requestId: "approval-health",
        threadId: "thread-1",
        sourceRef: "payload-1",
        text: "主人对青霉素过敏",
        topic: "health",
        requestedAt: "2026-10-25T12:00:00.000Z",
      },
    ],
    tidyUps: [],
    conversationReviews: [],
    reminders: [],
    upcoming: [],
    people: [],
    personSuggestions: [],
    imports: [],
    capturePaused: false,
    manualAddReady: true,
    generatedAt: "2026-10-25T12:00:00.000Z",
  };
  classifyAnswers = [];
  classifyFails = false;
  duplicateAnswers = [];
  duplicatesFail = false;
  duplicateAsked = [];
  query.mockImplementation(async (request) => {
    if (request.type === "memory.import.duplicates.read") {
      duplicateAsked.push([...request.payload.contentRefs]);
      if (duplicatesFail) throw new Error("offline");
      return {
        ...request,
        kind: "snapshot",
        type: "memory.import.duplicates.snapshot",
        payload: {
          items: request.payload.contentRefs.map((contentRef: string) => ({
            contentRef,
            verdict: duplicateAnswers.shift() ?? "different",
            memoryId: null,
          })),
        },
      };
    }
    if (request.type === "memory.classify.read") {
      if (classifyFails) throw new Error("offline");
      return {
        ...request,
        kind: "snapshot",
        type: "memory.classify.snapshot",
        payload: {
          items: request.payload.contentRefs.map((contentRef: string) => ({
            contentRef,
            ...(classifyAnswers.shift() ?? classified("other", "sensitive", "other")),
          })),
        },
      };
    }
    return {
      ...request,
      kind: "snapshot",
      type: "memory.overview.snapshot",
      payload: overview,
    };
  });
  mutate.mockResolvedValue({ resultRef: "result", replayed: false, status: "accepted" });
  protectText.mockResolvedValue("payload-edit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("memory approval and management", () => {
  it("shows the sensitive proposal and the remembered count under the reply that caused them", async () => {
    await render();
    const turn = text("#turn");
    expect(turn).toContain("主人对青霉素过敏");
    expect(turn).toContain("这条涉及「健康」");
    expect(turn).toContain("记下了 1 条新记忆查看");
    expect(turn).not.toContain("主人住在上海");
    await render(["payload-other"]);
    expect(text("#turn")).toBe("");
  });

  it("[MP-DROP] stops counting a memory under the reply once the owner dropped it", async () => {
    overview = {
      ...overview,
      memories: [
        memoryItem("m-guess", "主人让写一个就只写一个", { status: "trashed", tentative: true }),
      ],
    };
    await render();
    expect(text("#turn")).not.toContain("记下了");
  });

  it("approves, edits and rejects a sensitive proposal", async () => {
    await render();
    await click("#turn", "记住");
    expect(lastCommand()).toMatchObject({
      type: "memory.approval.respond",
      payload: { requestId: "approval-health", resolution: "approved", editedText: null },
    });
    await click("#turn", "改一下再记");
    await type("#turn textarea", "主人对青霉素和头孢过敏");
    await click("#turn", "保存");
    expect(lastCommand()).toMatchObject({
      payload: { resolution: "edited", editedText: "主人对青霉素和头孢过敏" },
    });
    await click("#settings", "不记");
    expect(lastCommand()).toMatchObject({ payload: { resolution: "rejected" } });
  });

  it("[MP-8] filters, opens the source, corrects, deletes and recovers memories", async () => {
    await render();
    expect(text("#settings .memory-confirm")).toContain("需要你确认 · 1 条");
    expect(text("#settings [role=tab][aria-selected=true]")).toContain("记忆");
    expect(text("#settings")).not.toContain("记住了 2 条关于你的事");
    expect(document.querySelector("#settings h1")).toBeNull();
    expect(document.querySelector("#settings .memory-header")).toBeNull();
    expect(text("#settings")).not.toContain("从对话中自动记忆");
    expect(text("#settings")).not.toContain("普通信息会自动记住");
    await type("#settings input[type=search]", "上海");
    expect(text("#settings .memory-results")).toContain("主人住在上海");
    expect(text("#settings .memory-results")).not.toContain("蓝色");
    await type("#settings input[type=search]", "");
    await click("#settings .memory-topics", "身份");
    expect(text("#settings .memory-results")).not.toContain("蓝色");
    expect(text("#settings .memory-crumbs")).toContain("身份");
    await click("#settings .memory-list", "主人住在上海");
    expect(text("#settings .memory-drawer")).toContain("还没用到");
    expect(text("#settings .memory-drawer")).toContain("500 / 1000");
    await click("#settings .memory-drawer", "跳到原话");
    expect(opened).toHaveBeenCalledWith("thread-2", "message-9");
    await click("#settings .memory-drawer", "编辑");
    await type("#settings .memory-drawer textarea", "主人住在杭州");
    await click("#settings .memory-drawer", "保存");
    expect(protectText).toHaveBeenCalledWith("主人住在杭州", "private");
    expect(lastCommand()).toMatchObject({
      type: "memory.mutate",
      payload: { memoryId: "memory-city", action: "correct", expectedRevision: 1 },
    });
    await click("#settings .memory-drawer", "删除");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-city", action: "delete", contentRef: null },
    });
    expect(document.querySelector("#settings .memory-drawer")).toBeNull();
    expect(text("#settings .memory-notice")).toContain("7 天内可在“最近删除”里恢复");
    await click("#settings .memory-notice", "撤销");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-city", action: "recover", expectedRevision: 2 },
    });
  });

  it("[MP-8] lists archived and recently deleted memories with their own recovery actions", async () => {
    overview = {
      ...overview,
      memories: [
        ...overview.memories,
        memoryItem("memory-old", "在找二手 4K 显示器", { status: "archived", category: "other" }),
        memoryItem("memory-gone", "喜欢绿色", { status: "trashed", revision: 3 }),
      ],
    };
    await render();
    expect(text("#settings .memory-results")).not.toContain("在找二手 4K 显示器");
    await click("#settings .memory-status-links", "已归档 1 条");
    expect(text("#settings .memory-banner[data-kind=archived]")).toContain("回答时不再用");
    await click("#settings .memory-list", "在找二手 4K 显示器");
    expect(document.querySelector("#settings .memory-drawer [role=switch]")).toBeNull();
    await click("#settings .memory-drawer", "恢复使用");
    expect(lastCommand()).toMatchObject({ payload: { memoryId: "memory-old", action: "recover" } });
    await click("#settings .memory-status-links", "最近删除 1 条");
    expect(text("#settings .memory-list")).toContain("喜欢绿色");
    await click("#settings .memory-list", "喜欢绿色");
    expect(text("#settings .memory-drawer")).toContain("7 天后自动彻底清除");
    await click("#settings .memory-drawer", "恢复");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-gone", action: "recover", expectedRevision: 3 },
    });
    await click("#settings .memory-banner", "回到在用的记忆");
    expect(text("#settings .memory-results")).toContain("主人住在上海");
  });

  it("opens the memory page with the memory the reply just saved marked in place", async () => {
    const listener = vi.fn((event: Event) => focusedMemoryIds(event));
    window.addEventListener(OPEN_MEMORY_PAGE, listener);
    await render();
    await click("#turn", "记下了 1 条新记忆");
    expect(listener).toHaveReturnedWith(["memory-color"]);
    window.removeEventListener(OPEN_MEMORY_PAGE, listener);
    await act(async () => root.render(h(MemoryPageWithFocus, { focus: ["memory-color"] })));
    await act(async () => {});
    expect(document.querySelector("#settings .memory-just-saved")).toBeNull();
    expect(text("#settings [role=tab][aria-selected=true]")).toContain("记忆");
    const rows = [...document.querySelectorAll("#settings .memory-row")];
    expect(rows[0]?.getAttribute("data-just-saved")).toBe("true");
    expect(rows[0]?.textContent).toContain("刚记住");
    expect(rows[0]?.textContent).toContain("主人最喜欢的颜色是蓝色");
    expect(rows[1]?.textContent).not.toContain("刚记住");
    expect(rows.map((row) => row.textContent).join("")).not.toContain("新");
    expect(document.querySelector("#settings .memory-drawer")).toBeNull();
    await click("#settings .memory-list", "主人最喜欢的颜色是蓝色");
    await click("#settings .memory-drawer", "删除");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-color", action: "delete" },
    });
  });

  it("stays hidden when the deployment has no memory operations", async () => {
    const Hidden = () =>
      useMemory({
        client,
        configuration: { ...configuration, installedGatewayV2Operations: [] },
        connected: true,
        refreshSignal: 0,
      })
        ? h("p", null, "visible")
        : null;
    await act(async () => root.render(h(Hidden)));
    expect(container.textContent).toBe("");
    expect(query).not.toHaveBeenCalled();
  });

  it("[MEM-PIN] shows what every conversation brings, what does not fit, and lets the owner change it", async () => {
    const likes = Array.from({ length: 12 }, (_, index) =>
      memoryItem(`memory-like-${index}`, `喜欢第 ${index + 1} 样东西`, {
        profilePin: index === 0 ? "on" : null,
      }),
    );
    overview = {
      ...overview,
      pending: [],
      memories: [
        ...overview.memories,
        ...likes,
        memoryItem("memory-tea", "喝茶只喝乌龙", { importance: 300 }),
        memoryItem("memory-noodle", "不吃香菜", { profilePin: "off" }),
        memoryItem("memory-pill", "每天吃降压药", {
          category: "health",
          dataClassification: "sensitive",
          topic: "health",
        }),
      ],
      profileUsage: { used: 1980, limit: 2000, pinned: 0, queued: ["memory-tea"] },
      profile: [
        {
          kind: "preference",
          lines: likes.map((item) => ({
            memoryId: item.memoryId,
            text: item.text,
            updatedAt: "2026-10-25T12:00:00.000Z",
          })),
        },
      ],
    };
    await render();
    const card = () => text("#settings .memory-carry");
    expect(card()).toContain("每次对话都会带上的记忆");
    expect(card()).toContain("12 条 · 已用 1980 / 2000 字 · 还有 1 条放不下");
    expect(card()).toContain("偏好 12");
    expect(card()).not.toContain("喜欢第 1 样东西");
    expect(document.querySelector<HTMLMeterElement>("#settings .memory-carry meter")?.value).toBe(
      1980,
    );
    await click("#settings .memory-carry", "查看和调整");
    expect(card()).toContain("喜欢第 12 样东西");
    expect(card()).toContain("你选的");
    expect(card()).toContain("放不下的");
    expect(card()).toContain("喝茶只喝乌龙");
    expect(card()).toContain("你关掉的");
    expect(card()).toContain("不吃香菜");
    const pin = (label: string) =>
      document.querySelector<HTMLInputElement>(
        `#settings .memory-carry [role=switch][aria-label="每次对话都带上：${label}"]`,
      );
    expect(pin("喜欢第 2 样东西")?.checked).toBe(true);
    await act(async () => pin("喜欢第 2 样东西")?.click());
    expect(lastCommand()).toMatchObject({
      type: "memory.mutate",
      payload: { memoryId: "memory-like-1", action: "unpin" },
    });
    expect(text("#settings .memory-notice")).toContain("以后这条只在相关时才调出");
    await act(async () => pin("喝茶只喝乌龙")?.click());
    expect(lastCommand()).toMatchObject({ payload: { memoryId: "memory-tea", action: "pin" } });
    await act(async () => pin("不吃香菜")?.click());
    expect(lastCommand()).toMatchObject({ payload: { memoryId: "memory-noodle", action: "pin" } });
    await click("#settings .memory-carry", "喜欢第 3 样东西");
    expect(text("#settings .memory-drawer")).toContain("喜欢第 3 样东西");
    expect(text("#settings .memory-drawer")).toContain("现在由系统按重要度决定");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("#settings .memory-drawer [aria-label=关闭]")
        ?.click(),
    );
    expect(document.querySelector("#settings .memory-drawer")).toBeNull();
    await click("#settings .memory-topics", "健康");
    await click("#settings .memory-list", "每天吃降压药");
    expect(
      document.querySelector<HTMLInputElement>("#settings .memory-drawer [role=switch]")?.disabled,
    ).toBe(true);
    expect(text("#settings .memory-drawer")).toContain(
      "事件、健康、财务和其他类的记忆只在相关时调出",
    );
  });

  it("[P2-5] warns only when the memories the owner chose to bring exceed the limit", async () => {
    const notice = () => document.querySelector("[data-testid='memory-carry-pinned-over']");
    for (const [pinned, shown] of [
      [0, false],
      [100, false],
      [2000, false],
      [2001, true],
    ] as const) {
      overview = {
        ...overview,
        profileUsage: { used: Math.max(pinned, 10), limit: 2000, pinned, queued: [] },
      };
      await render();
      expect(Boolean(notice())).toBe(shown);
      if (shown) expect(notice()?.textContent).toContain("比上限 2000 字多出 1 字");
      await act(async () => root.render(h("div")));
    }
  });

  it("[MEM-CAT] lets the owner move a memory to another topic and offers none for sensitive ones", async () => {
    overview = {
      ...overview,
      memories: [
        ...overview.memories,
        memoryItem("memory-pill", "每天吃降压药", {
          category: "health",
          dataClassification: "sensitive",
          topic: "health",
        }),
      ],
    };
    await render();
    await click("#settings .memory-list", "主人住在上海");
    const trigger = () =>
      document.querySelector<HTMLButtonElement>(
        "#settings .memory-drawer .memory-detail [aria-label=改分类]",
      );
    expect(trigger()?.textContent).toContain("身份");
    await act(async () => trigger()?.click());
    const options = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-detail [role=option]"),
    ].map((option) => option.textContent);
    expect(options).toEqual(["身份", "偏好", "人际关系", "目标", "进行中", "要求", "事件", "其他"]);
    const choose = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-detail [role=option]"),
    ].find((option) => option.textContent === "偏好");
    await act(async () => choose?.click());
    await act(async () => {});
    expect(lastCommand()).toMatchObject({
      type: "memory.category.set",
      payload: { memoryId: "memory-city", expectedRevision: 1, category: "preference" },
    });
    expect(text("#settings .memory-notice")).toContain("已改为「偏好」");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("#settings .memory-drawer [aria-label=关闭]")
        ?.click(),
    );
    await click("#settings .memory-topics", "健康");
    await click("#settings .memory-list", "每天吃降压药");
    expect(trigger()).toBeNull();
    expect(text("#settings .memory-drawer .memory-detail")).toContain("健康");
  });

  it("[MEM-PIN] keeps a topic with many memories short until the owner opens it, then pages it", async () => {
    const likes = Array.from({ length: 45 }, (_, index) =>
      memoryItem(`memory-like-${index}`, `喜欢第 ${index + 1} 样东西`, {
        recordedAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000).toISOString(),
      }),
    );
    overview = { ...overview, pending: [], memories: [...overview.memories, ...likes] };
    await render();
    const rows = () => document.querySelectorAll("#settings .memory-results .memory-row").length;
    expect(text("#settings .memory-crumbs")).toContain("47 条 · 每个主题先显示最新的 3 条");
    expect(rows()).toBe(4);
    expect(text("#settings .memory-topics")).toContain("偏好 46");
    await click("#settings .memory-results", "看全部 46 条");
    expect(text("#settings .memory-topics button[aria-pressed=true]")).toContain("偏好");
    expect(rows()).toBe(30);
    await click("#settings .memory-results", "再显示 16 条");
    expect(rows()).toBe(46);
    expect(text("#settings .memory-results")).not.toContain("主人住在上海");
  });

  it("[MEM-PIN] says how many memories are new since the last visit and records the visit once", async () => {
    overview = { ...overview, lastViewedAt: "2026-10-25T00:00:00.000Z" };
    await render();
    const viewed = mutate.mock.calls.filter(([command]) => command.type === "memory.page.viewed");
    expect(viewed).toHaveLength(1);
    expect(text("#settings .memory-banner[data-kind=fresh]")).toContain(
      "自你上次打开后新记住 1 条",
    );
    await click("#settings .memory-banner[data-kind=fresh]", "看看");
    expect(text("#settings .memory-results")).toContain("主人最喜欢的颜色是蓝色");
    expect(text("#settings .memory-results")).not.toContain("主人住在上海");
    await click("#settings .memory-crumbs", "看全部");
    expect(text("#settings .memory-results")).toContain("主人住在上海");
    await click("#settings .memory-list", "主人住在上海");
    const pin = document.querySelector<HTMLInputElement>("#settings .memory-drawer [role=switch]");
    expect(pin?.checked).toBe(false);
    await act(async () => pin?.click());
    expect(lastCommand()).toMatchObject({ payload: { memoryId: "memory-city", action: "pin" } });
    expect(
      mutate.mock.calls.filter(([command]) => command.type === "memory.page.viewed"),
    ).toHaveLength(1);
  });

  it("[MH-2] draws every change of a back-and-forth memory as two lanes and a folded list", async () => {
    overview = { ...overview, pending: [], memories: [...overview.memories, ...outingChain()] };
    await render();
    expect(text("#settings .memory-page")).toContain("改过 4 次");
    await click("#settings .memory-results", "主人最近一个月都不想出去玩");
    const lanes = [...document.querySelectorAll("#settings .memory-stance-chart g text")].map(
      (item) => item.textContent,
    );
    expect(lanes).toEqual(["想出去玩", "不想出去玩"]);
    expect(document.querySelectorAll("#settings .memory-stance-chart circle")).toHaveLength(6);
    expect(text("#settings .memory-history-summary")).toBe("变过 4 次，另外有 1 次说了同样的意思");
    const points = () =>
      [...document.querySelectorAll("#settings .memory-history-line > li")].map(
        (item) => item.textContent ?? "",
      );
    expect(points()).toHaveLength(4);
    expect(points()[0]).toContain("现在");
    expect(points()[0]).toContain("你说：“最近一个月都不想出去玩”");
    expect(points()[1]).toContain("又说了一次，意思没变");
    expect(points()[3]).toBe("展开更早的 3 条");
    expect(points().join("")).not.toContain("→");
    await click("#settings .memory-history-fold", "展开更早的 3 条");
    expect(points()).toHaveLength(7);
    expect(points()[4]).toContain("主人不爱出去玩，有社恐");
    expect(points()[4]).toContain("来源对话已删除");
    expect(points()[4]).not.toContain("你说");
    expect(points()[5]).toContain("主人很喜欢出去玩");
    expect(points()[6]).toBe("收起");
    await click("#settings .memory-history-line > li:nth-child(2)", "来源对话");
    expect(opened).toHaveBeenLastCalledWith("thread-out-6");
    await click("#settings .memory-history-line > li:nth-child(3)", "换回这个说法");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-out-4", action: "restore", contentRef: null },
    });
    await click("#settings .memory-history-fold", "收起");
    expect(points()).toHaveLength(4);
  });

  it("[P3-7] offers every earlier version of the current memory and restores the one picked", async () => {
    const at = (day: number) => `2026-10-2${day}T12:00:00.000Z`;
    const edits = [
      node("created", "主人住在杭州", "杭州", at(1), { historyId: 41 }),
      node("edited", "主人住在上海", "上海", at(2), { historyId: 42 }),
      node("reaffirmed", "主人住在上海", "上海", at(3), { historyId: 43 }),
      node("edited", "主人住在苏州", "苏州", at(4), { historyId: 44 }),
      node("edited", "主人住在南京", "南京", at(5), { historyId: 45 }),
    ];
    overview = {
      ...overview,
      pending: [],
      memories: [
        memoryItem("memory-home-old", "主人住在宁波", {
          revision: 2,
          stance: "宁波",
          supersededBy: "memory-home",
          history: [
            node("created", "主人住在温州", "温州", at(0), { historyId: 31 }),
            node("updated", "主人住在宁波", "宁波", "2026-10-20T18:00:00.000Z", {
              historyId: 32,
            }),
          ],
        }),
        memoryItem("memory-home", "主人住在南京", {
          revision: 5,
          stance: "南京",
          history: edits,
        }),
      ],
    };
    await render();
    await click("#settings .memory-results", "主人住在南京");
    await click("#settings .memory-history-fold", "展开更早");
    const line = () => [...document.querySelectorAll("#settings .memory-history-line > li")];
    const labelled = (label: string) =>
      line()
        .filter((item) =>
          [...item.querySelectorAll("button")].some((button) => button.textContent === label),
        )
        .map((item) => item.querySelector("p")?.textContent ?? "");
    expect(labelled("恢复到这一版")).toEqual([
      "主人住在苏州",
      "主人住在上海",
      "主人住在杭州",
      "主人住在温州",
    ]);
    expect(labelled("换回这个说法")).toEqual(["主人住在宁波"]);
    const first = line().find((item) => item.querySelector("p")?.textContent === "主人住在杭州");
    await act(async () =>
      [...(first?.querySelectorAll("button") ?? [])]
        .find((item) => item.textContent === "恢复到这一版")
        ?.click(),
    );
    await act(async () => {});
    expect(lastCommand()).toMatchObject({
      type: "memory.mutate",
      payload: {
        memoryId: "memory-home",
        action: "restore_version",
        expectedRevision: 5,
        contentRef: null,
        historyId: 41,
      },
    });
  });

  it("[P3-7] offers no version restore on a memory that is no longer current", () => {
    const history = [
      node("created", "主人住在杭州", "杭州", "2026-10-21T12:00:00.000Z"),
      node("edited", "主人住在南京", "南京", "2026-10-22T12:00:00.000Z"),
    ];
    const current = memoryItem("memory-gone", "主人住在南京", { stance: "南京", history });
    expect(memoryChain(current, [current]).map((item) => item.versionRestorable)).toEqual([
      true,
      false,
    ]);
    for (const gone of [
      { ...current, status: "archived" as const },
      { ...current, status: "trashed" as const },
      { ...current, supersededBy: "memory-next" },
    ])
      expect(memoryChain(gone, [gone]).some((item) => item.versionRestorable)).toBe(false);
    const trashed = memoryItem("memory-old", "主人住在杭州", {
      status: "trashed",
      supersededBy: current.memoryId,
      history: [node("created", "主人住在温州", "温州", "2026-10-20T12:00:00.000Z")],
    });
    expect(memoryChain(current, [trashed, current])[0]).toMatchObject({ versionRestorable: false });
  });

  it("[MH-2] keeps the folded list without lanes when the old changes have no stance", async () => {
    const versions = Array.from({ length: 6 }, (_, index) =>
      memoryItem(`memory-city-v${index}`, `住在第 ${index + 1} 个城市`, {
        category: "identity",
        supersededBy: index === 5 ? "memory-city" : `memory-city-v${index + 1}`,
        recordedAt: `2026-10-0${index + 1}T12:00:00.000Z`,
      }),
    );
    overview = { ...overview, pending: [], memories: [...overview.memories, ...versions] };
    await render();
    await click("#settings .memory-results", "主人住在上海");
    expect(document.querySelector("#settings .memory-stance-chart")).toBeNull();
    expect(text("#settings .memory-history-summary")).toBe("变过 6 次");
    await click("#settings .memory-history-fold", "展开更早的 4 条");
    const points = [...document.querySelectorAll("#settings .memory-history-line > li")].map(
      (item) => item.textContent ?? "",
    );
    expect(points).toHaveLength(8);
    expect(points[6]).toContain("住在第 1 个城市");
  });

  it("[MH-3] lists each change on its own line with its number and opens the whole chain", async () => {
    overview = { ...overview, pending: [], memories: [...overview.memories, ...outingChain()] };
    await render();
    await tab("变化记录");
    const timeline = text("#settings .memory-page");
    expect(timeline).not.toContain("→");
    expect(timeline).toContain("现在是：主人最近一个月都不想出去玩");
    expect(timeline).toContain("第 4 次变化");
    expect(timeline).toContain("现在是：主人最近不想出去玩");
    expect(timeline).toContain("第 2 次变化");
    expect(timeline).not.toContain("又说了一次");
    expect(text("#settings .memory-page")).toContain("新记住主人很喜欢出去玩");
    const lines = [...document.querySelectorAll("#settings .memory-day p")].filter((line) =>
      line.textContent?.includes("出去玩"),
    );
    expect(lines).toHaveLength(5);
    await click("#settings .memory-day", "看这条记忆的全部变化");
    expect(
      document.querySelector("#settings [role=tab][aria-selected=true]")?.textContent,
    ).toContain("记忆");
    expect(text("#settings .memory-detail")).toContain("怎么变过来的");
    expect(text("#settings .memory-history-summary")).toBe("变过 4 次，另外有 1 次说了同样的意思");
  });

  it("[P1-1] a captured memory jumps to the message it came from", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [memoryItem("m-jump", "主人喜欢爬山", { sourceMessageId: "message-7" })],
    };
    await render();
    await click("#settings .memory-results", "主人喜欢爬山");
    expect(text("#settings .memory-detail")).not.toContain("来源已不可查");
    await click("#settings .memory-detail", "跳到原话");
    expect(opened).toHaveBeenLastCalledWith("thread-1", "message-7");
    expect(document.querySelector("#settings [data-kind=source-unavailable]")).toBeNull();
  });

  it("[P1-1] a jump to a message deleted since the page loaded says the source is gone instead of doing nothing", async () => {
    const found = memoryItem("m-stale", "主人喜欢爬山", { sourceMessageId: "message-7" });
    overview = { ...overview, pending: [], memories: [found] };
    await render();
    await click("#settings .memory-results", "主人喜欢爬山");
    expect(text("#settings .memory-detail")).toContain("跳到原话");
    overview = {
      ...overview,
      memories: [memoryItem("m-stale", "主人喜欢爬山", { sourceMessageId: null })],
    };
    opened.mockClear();
    await click("#settings .memory-detail", "跳到原话");
    await act(async () => {
      await Promise.resolve();
    });
    expect(opened).not.toHaveBeenCalled();
    expect(text("#settings .memory-detail")).toContain("来源已不可查");
    expect(text("#settings .memory-detail")).not.toContain("跳到原话");
    expect(text("#settings [data-kind=source-unavailable]")).toBe(
      "有 1 条记忆的来源已不可查，找不回当初那句话",
    );
  });

  it("[P1-1] a jump whose check cannot be answered does not navigate and says the source cannot be found", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [memoryItem("m-fail", "主人喜欢爬山", { sourceMessageId: "message-7" })],
    };
    await render();
    await click("#settings .memory-results", "主人喜欢爬山");
    query.mockRejectedValueOnce(new Error("offline"));
    opened.mockClear();
    await click("#settings .memory-detail", "跳到原话");
    await act(async () => {
      await Promise.resolve();
    });
    expect(opened).not.toHaveBeenCalled();
    expect(text("#settings .memory-detail")).toContain("来源已不可查");
    expect(text("#settings .memory-detail")).not.toContain("跳到原话");
  });

  it("[P1-1] a jump whose fresh overview no longer holds the memory closes the detail and does not navigate", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [memoryItem("m-gone", "主人喜欢爬山", { sourceMessageId: "message-7" })],
    };
    await render();
    await click("#settings .memory-results", "主人喜欢爬山");
    overview = { ...overview, memories: [] };
    opened.mockClear();
    await click("#settings .memory-detail", "跳到原话");
    await act(async () => {
      await Promise.resolve();
    });
    expect(opened).not.toHaveBeenCalled();
    expect(document.querySelector("#settings .memory-detail")).toBeNull();
  });

  it("[P1-1] a memory whose quote cannot be found says so, is counted, and offers no jump", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [
        memoryItem("m-lost-1", "主人喜欢爬山", { sourceMessageId: null }),
        memoryItem("m-lost-2", "主人喜欢游泳", { sourceMessageId: null }),
        memoryItem("m-lost-trashed", "主人喜欢跑步", { sourceMessageId: null, status: "trashed" }),
        memoryItem("m-found", "主人喜欢蓝色"),
        memoryItem("m-owner", "主人手写的一条", {
          memoryId: "memory:owner:1",
          sourceThreadId: null,
          sourceMessageId: null,
        }),
        memoryItem("m-tidy", "整理出来的一条", { sourceThreadId: null, sourceMessageId: null }),
      ],
    };
    await render();
    expect(text("#settings [data-kind=source-unavailable]")).toBe(
      "有 2 条记忆的来源已不可查，找不回当初那句话",
    );
    await click("#settings .memory-results", "主人喜欢爬山");
    expect(text("#settings .memory-detail")).toContain("来源已不可查");
    expect(text("#settings .memory-detail")).not.toContain("跳到原话");
    await click("#settings .memory-detail", "来源对话");
    expect(opened).toHaveBeenLastCalledWith("thread-1");
  });

  it("[P1-1] a memory made by the reminder tool is not called lost, and still opens its conversation", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [
        memoryItem("m-reminder", "下周三交报告", {
          sourceMessageId: null,
          sourceRefs: ["memory-content:reminder:key-1"],
        }),
        memoryItem("m-lost", "主人喜欢爬山", {
          sourceMessageId: null,
          sourceRefs: ["memory-content:reminder:key-2", "payload-9"],
        }),
      ],
    };
    await render();
    expect(text("#settings [data-kind=source-unavailable]")).toBe(
      "有 1 条记忆的来源已不可查，找不回当初那句话",
    );
    await click("#settings .memory-results", "下周三交报告");
    expect(text("#settings .memory-detail")).toContain("提醒创建，无原话");
    expect(text("#settings .memory-detail")).not.toContain("来源已不可查");
    await click("#settings .memory-detail", "来源对话");
    expect(opened).toHaveBeenLastCalledWith("thread-1");
  });

  it("[P1-1] imported memories name their batch, are counted apart, and offer no jump", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [
        memoryItem("m-import-a", "回答一律用简体中文", {
          category: "rule",
          importBatchId: "b1",
          sourceThreadId: null,
          sourceMessageId: null,
        }),
        memoryItem("m-capture", "主人喜欢蓝色"),
      ],
      imports: [
        {
          batchId: "b1",
          source: "codex",
          itemCount: 1,
          createdAt: "2026-10-25T13:00:00.000Z",
          undone: false,
        },
      ],
    };
    await render();
    expect(text("#settings [data-kind=import-no-quote]")).toBe("有 1 条记忆是导入的，没有原话可跳");
    expect(document.querySelector("#settings [data-kind=source-unavailable]")).toBeNull();
    await click("#settings .memory-results", "回答一律用简体中文");
    expect(text("#settings .memory-detail")).toContain("导入自 Codex");
    expect(text("#settings .memory-detail")).not.toContain("跳到原话");
  });

  it("[MH-4] says the source conversation was deleted, keeps the quote and never calls it a daily tidy-up", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [
        memoryItem("memory-orphan", "主人喜欢爬山", {
          sourceThreadId: null,
          history: [
            {
              historyId: 1,
              kind: "created",
              text: "主人喜欢爬山",
              stance: null,
              quote: "我周末最喜欢去爬山了",
              sourceThreadId: null,
              sourceDeleted: true,
              at: "2026-10-25T12:00:00.000Z",
            },
            {
              historyId: 2,
              kind: "reaffirmed",
              text: "主人喜欢爬山",
              stance: null,
              quote: null,
              sourceThreadId: null,
              sourceDeleted: true,
              at: "2026-10-26T12:00:00.000Z",
            },
          ],
        }),
      ],
    };
    await render();
    await click("#settings .memory-results", "主人喜欢爬山");
    expect(text("#settings .memory-detail")).toContain("来源对话已删除");
    expect(text("#settings .memory-detail")).not.toContain("整理记忆");
    expect(text("#settings .memory-detail")).toContain("你说：“我周末最喜欢去爬山了”");
  });

  it("[MP-8] groups the profile by sub-category, draws people and restores an earlier wording", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [
        ...overview.memories,
        memoryItem("memory-coffee", "喝咖啡不加糖", { subCategory: "饮食" }),
        memoryItem("memory-mom", "李秀英是主人的妈妈", { category: "relationship" }),
        memoryItem("memory-city-old", "主人住在北京", {
          category: "identity",
          supersededBy: "memory-city",
          validTo: "2026-10-24T12:00:00.000Z",
        }),
      ],
      profile: [
        {
          kind: "preference",
          lines: [
            {
              memoryId: "memory-color",
              text: "主人最喜欢的颜色是蓝色",
              updatedAt: "2026-10-25T12:00:00.000Z",
            },
            {
              memoryId: "memory-coffee",
              text: "喝咖啡不加糖",
              updatedAt: "2026-10-25T12:00:00.000Z",
            },
          ],
        },
      ],
      people: [
        {
          personId: "person-mom",
          name: "李秀英",
          aliases: ["妈妈"],
          relation: "妈妈",
          reverseRelation: "孩子",
          links: [{ personId: "person-aunt", relation: "妹妹" }],
          memoryIds: ["memory-mom"],
        },
        {
          personId: "person-aunt",
          name: "李秀兰",
          aliases: [],
          relation: null,
          reverseRelation: null,
          links: [{ personId: "person-mom", relation: "姐姐" }],
          memoryIds: [],
        },
      ],
    };
    await render();
    await click("#settings .memory-carry", "查看和调整");
    const carry = text("#settings .memory-carry");
    expect(carry).toContain("偏好");
    expect(carry).toContain("喝咖啡不加糖");
    await click("#settings .memory-topics", "偏好");
    expect(text("#settings .memory-topics")).toContain("颜色");
    expect(text("#settings .memory-topics")).toContain("饮食");
    await click("#settings .memory-topics", "饮食");
    expect(text("#settings .memory-results")).toContain("喝咖啡不加糖");
    expect(text("#settings .memory-results")).not.toContain("蓝色");
    expect(document.querySelector("#settings .memory-people")).toBeNull();
    await click("#settings .memory-topics", "人际");
    expect(text("#settings .memory-people")).toContain("你的妈妈");
    await click("#settings .memory-people .memory-list", "李秀英");
    const person = text("#settings .memory-people");
    expect(person).toContain("也叫：妈妈");
    expect(person).toContain("李秀英的妹妹");
    expect(person).toContain("李秀英是主人的妈妈");
    await click("#settings .memory-topics", "身份");
    await click("#settings .memory-list", "主人住在上海");
    expect(text("#settings .memory-drawer")).toContain("主人住在北京");
    await click("#settings .memory-drawer", "换回这个说法");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-city-old", action: "restore", contentRef: null },
    });
  });

  it("[MP-8] confirms guesses and people, and undoes tidy-ups and imports from the timeline", async () => {
    overview = {
      ...overview,
      memories: [
        ...overview.memories,
        memoryItem("memory-guess", "主人在为半程马拉松坚持晨跑", {
          inference: true,
          tentative: true,
        }),
        memoryItem("memory:import:batch-1:0", "回答一律用简体中文", {
          category: "rule",
          importBatchId: "batch-1",
        }),
      ],
      people: [
        {
          personId: "p1",
          name: "张伟",
          aliases: [],
          relation: "导师",
          reverseRelation: "学生",
          links: [],
          memoryIds: [],
        },
        {
          personId: "p2",
          name: "张老师",
          aliases: [],
          relation: null,
          reverseRelation: null,
          links: [],
          memoryIds: [],
        },
      ],
      personSuggestions: [
        {
          suggestionId: "suggestion-1",
          personId: "p1",
          candidateId: "p2",
          createdAt: "2026-10-25T12:00:00.000Z",
        },
      ],
      tidyUps: [
        {
          changeId: "memory-consolidation:agent:2026-10-25:c1",
          memoryId: "memory-merged",
          action: "merge",
          text: "主人的女儿叫小葵",
          relatedText: "主人的女儿名叫小葵",
          createdAt: "2026-10-25T12:00:00.000Z",
          undone: false,
          undoable: true,
        },
      ],
      imports: [
        {
          batchId: "batch-1",
          source: "codex",
          itemCount: 1,
          createdAt: "2026-10-25T13:00:00.000Z",
          undone: false,
        },
      ],
    };
    await render();
    expect(text("#settings .memory-confirm")).toContain("需要你确认 · 3 条");
    expect(text("#settings")).toContain("“张老师”和“张伟”是同一个人吗？");
    await click("#settings", "是同一个人");
    expect(lastCommand()).toMatchObject({
      type: "memory.person.respond",
      payload: { suggestionId: "suggestion-1", merge: true },
    });
    const guess = [...document.querySelectorAll("#settings .memory-card")].find((card) =>
      card.textContent?.includes("半程马拉松"),
    );
    await act(async () =>
      [...(guess?.querySelectorAll("button") ?? [])]
        .find((item) => item.textContent === "记住")
        ?.click(),
    );
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-guess", action: "confirm", contentRef: null },
    });
    await tab("变化记录");
    const timeline = text("#settings");
    expect(timeline).toContain("合并重复主人的女儿叫小葵");
    expect(timeline).toContain("从 Codex 导入 1 条");
    expect(timeline).not.toContain("新记住回答一律用简体中文");
    const undo = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-day button"),
    ].filter((item) => item.textContent === "撤销");
    await act(async () => undo[0]?.click());
    expect(lastCommand()).toMatchObject({
      type: "memory.import.undo",
      payload: { batchId: "batch-1" },
    });
    await act(async () => undo[1]?.click());
    expect(lastCommand()).toMatchObject({
      type: "memory.tidy.undo",
      payload: { changeId: "memory-consolidation:agent:2026-10-25:c1" },
    });
  });

  it("[MP-DROP] logs 不记 and 删除 as their own change-log rows, keeps the earlier 新记住 row, and undoes via recover", async () => {
    overview = {
      ...overview,
      memories: [
        memoryItem("m-kept", "主人喜欢喝美式", { recordedAt: "2026-10-30T01:00:00.000Z" }),
        memoryItem("m-guess", "主人让写一个就只写一个", {
          status: "trashed",
          tentative: true,
          revision: 4,
          recordedAt: "2026-11-01T01:00:00.000Z",
          updatedAt: "2026-11-01T02:00:00.000Z",
        }),
        memoryItem("m-deleted", "主人住在北京", {
          status: "trashed",
          revision: 7,
          recordedAt: "2026-10-29T01:00:00.000Z",
          updatedAt: "2026-10-31T02:00:00.000Z",
        }),
      ],
    };
    await render();
    expect(text("#settings .memory-status-links")).toContain("最近删除 2 条");
    await click("#settings .memory-status-links", "最近删除 2 条");
    expect(text("#settings")).toContain("主人让写一个就只写一个");
    await tab("变化记录");
    const rows = () => [...document.querySelectorAll("#settings .memory-day p")];
    const row = (kind: string, content: string) =>
      rows().find(
        (line) => line.textContent?.startsWith(kind) && line.textContent.includes(content),
      );
    expect(row("新记住", "主人让写一个就只写一个")).toBeDefined();
    const dropped = row("已不记", "主人让写一个就只写一个");
    expect(dropped).toBeDefined();
    expect(row("已删除", "主人住在北京")).toBeDefined();
    expect(row("已不记", "主人住在北京")).toBeUndefined();
    expect(rows().filter((line) => line.textContent?.includes("主人喜欢喝美式"))).toHaveLength(1);
    expect(row("已不记", "主人喜欢喝美式")).toBeUndefined();
    await act(async () =>
      [...(dropped?.querySelectorAll("button") ?? [])]
        .find((item) => item.textContent === "撤销")
        ?.click(),
    );
    expect(lastCommand()).toMatchObject({
      type: "memory.mutate",
      payload: { memoryId: "m-guess", action: "recover", expectedRevision: 4 },
    });
  });

  it("[P3-8] offers to undo a held conflict only while its newer memory still waits for the Owner", async () => {
    overview = {
      ...overview,
      memories: [
        memoryItem("m-milk-old", "主人平时喝明治的牛奶"),
        memoryItem("m-milk-new", "主人出差时喝便利店的牛奶", { tentative: true, revision: 2 }),
        memoryItem("m-pet-old", "主人家里养着一只柴犬"),
        memoryItem("m-pet-new", "主人家里改养了一只橘猫", { revision: 3 }),
        memoryItem("m-pet-twin", "主人家里改养了一只橘猫", { tentative: true }),
      ],
      tidyUps: [
        {
          changeId: "memory-consolidation:agent:2026-10-25:c1",
          memoryId: "m-milk-new",
          action: "hold",
          text: "主人出差时喝便利店的牛奶",
          relatedText: "主人平时喝明治的牛奶",
          createdAt: "2026-10-25T12:00:00.000Z",
          undone: false,
          undoable: true,
        },
        {
          changeId: "memory-consolidation:agent:2026-10-25:c2",
          memoryId: "m-pet-new",
          action: "hold",
          text: "主人家里改养了一只橘猫",
          relatedText: "主人家里养着一只柴犬",
          createdAt: "2026-10-25T12:00:01.000Z",
          undone: false,
          undoable: true,
        },
      ],
    };
    await render();
    await tab("变化记录");
    const row = (content: string) =>
      [...document.querySelectorAll("#settings .memory-day p")].find(
        (line) =>
          line.textContent?.startsWith("发现说法不一") && line.textContent.includes(content),
      );
    const buttons = (content: string) =>
      [...(row(content)?.querySelectorAll("button") ?? [])].map((item) => item.textContent);
    expect(buttons("主人出差时喝便利店的牛奶")).toEqual(["撤销", "去确认"]);
    expect(buttons("主人家里改养了一只橘猫")).toEqual([]);
    expect(row("主人出差时喝便利店的牛奶")?.textContent).toContain(
      "（另一条：主人平时喝明治的牛奶）",
    );
    expect(row("主人出差时喝便利店的牛奶")?.textContent).not.toContain("保留");
    await act(async () =>
      [...(row("主人出差时喝便利店的牛奶")?.querySelectorAll("button") ?? [])]
        .find((item) => item.textContent === "撤销")
        ?.click(),
    );
    expect(lastCommand()).toMatchObject({
      type: "memory.tidy.undo",
      payload: { changeId: "memory-consolidation:agent:2026-10-25:c1" },
    });
  });

  it("[P3-8-undo] shows no undo button on a change whose memory was edited afterwards, says why, and keeps the undone label", async () => {
    overview = {
      ...overview,
      memories: [
        memoryItem("m-city", "主人住在上海", { category: "identity", revision: 3 }),
        memoryItem("m-job", "主人是工程师", { category: "identity" }),
      ],
      tidyUps: [
        {
          changeId: "tidy-edited",
          memoryId: "m-city",
          action: "merge",
          text: "主人住在上海",
          relatedText: null,
          createdAt: "2026-10-25T12:00:00.000Z",
          undone: false,
          undoable: false,
        },
        {
          changeId: "tidy-fresh",
          memoryId: "m-job",
          action: "merge",
          text: "主人是工程师",
          relatedText: null,
          createdAt: "2026-10-25T12:00:01.000Z",
          undone: false,
          undoable: true,
        },
        {
          changeId: "tidy-done",
          memoryId: "m-job",
          action: "merge",
          text: "主人是工程师",
          relatedText: null,
          createdAt: "2026-10-25T12:00:02.000Z",
          undone: true,
          undoable: false,
        },
      ],
    };
    await render();
    await tab("变化记录");
    const row = (content: string, index = 0) =>
      [...document.querySelectorAll("#settings .memory-day p")].filter(
        (line) => line.textContent?.startsWith("合并重复") && line.textContent.includes(content),
      )[index];
    const buttons = (line: Element | undefined) =>
      [...(line?.querySelectorAll("button") ?? [])].map((item) => item.textContent);
    expect(buttons(row("主人住在上海"))).toEqual([]);
    expect(row("主人住在上海")?.textContent).toContain("这条记忆之后又改过，不能撤销");
    expect(buttons(row("主人是工程师", 1))).toEqual(["撤销"]);
    expect(row("主人是工程师", 1)?.textContent).not.toContain("不能撤销");
    expect(buttons(row("主人是工程师", 0))).toEqual([]);
    expect(row("主人是工程师", 0)?.textContent).toContain("已撤销");
    expect(row("主人是工程师", 0)?.textContent).not.toContain("不能撤销");
  });

  it("[DREAM] shows each conversation review batch, sends the batch undo, and locks a batch changed later", async () => {
    overview = {
      ...overview,
      memories: [
        memoryItem("m-german", "主人在学德语", {
          history: [
            {
              historyId: 1,
              kind: "created",
              text: "主人在学德语",
              stance: null,
              quote: "我最近每天晚上学一小时德语",
              sourceThreadId: "thread-1",
              sourceDeleted: false,
              at: "2026-10-29T01:00:00.000Z",
            },
          ],
        }),
        memoryItem("m-city", "主人住在东京都北区"),
      ],
      conversationReviews: [
        {
          reviewId: "review-open",
          finishedAt: "2026-10-29T01:00:00.000Z",
          undone: false,
          undoable: true,
          changes: [
            { memoryId: "m-german", action: "created" },
            { memoryId: "m-city", action: "superseded" },
          ],
        },
        {
          reviewId: "review-locked",
          finishedAt: "2026-10-28T01:00:00.000Z",
          undone: false,
          undoable: false,
          changes: [{ memoryId: "m-city", action: "confirmed" }],
        },
      ],
    };
    await render();
    await tab("变化记录");
    const rows = [...document.querySelectorAll("#settings .memory-day p")].filter((line) =>
      line.textContent?.includes("回看了一段对话"),
    );
    expect(rows).toHaveLength(2);
    const open = rows.find((line) => line.textContent?.includes("新记住 1 条"));
    expect(open?.textContent).toContain("取代旧说法 1 条");
    expect(open?.textContent).toContain("新记住：主人在学德语（原话：我最近每天晚上学一小时德语）");
    expect(open?.textContent).toContain("不再成立：主人住在东京都北区");
    const locked = rows.find((line) => line !== open);
    expect(locked?.textContent).toContain("这条记忆之后又改过，不能撤销");
    expect(locked?.querySelectorAll("button")).toHaveLength(0);
    await act(async () =>
      [...(open?.querySelectorAll("button") ?? [])]
        .find((item) => item.textContent === "撤销")
        ?.click(),
    );
    expect(lastCommand()).toMatchObject({
      type: "memory.conversationReview.undo",
      payload: { reviewId: "review-open" },
    });
  });

  it("[MP-8] answers due reminders, cancels an upcoming one and undoes the cancel", async () => {
    overview = {
      ...overview,
      reminders: [
        {
          reminderId: "reminder:memory-report",
          text: "主人周五下午三点要交季度报告",
          dueAt: "2026-10-30T07:00:00.000Z",
          remindAt: "2026-10-30T06:00:00.000Z",
          sourceThreadId: null,
        },
      ],
      upcoming: [
        {
          reminderId: "reminder:memory-color",
          memoryId: "memory-color",
          text: "妈妈的生日是 3 月 14 日",
          dueAt: "2027-03-14T01:00:00.000Z",
          repeat: "yearly",
          sourceThreadId: "thread-main",
        },
      ],
    };
    await render();
    expect(text("#reminders")).toContain("主人周五下午三点要交季度报告");
    await click("#reminders", "一小时后再提醒");
    expect(lastCommand()).toMatchObject({
      type: "memory.reminder.respond",
      payload: { reminderId: "reminder:memory-report", action: "snooze" },
    });
    await click("#reminders", "不再提醒");
    expect(lastCommand()).toMatchObject({ payload: { action: "dismiss" } });
    expect(text("#settings [role=tablist]")).not.toContain("提醒");
    expect(text("#reminders-page")).toContain("已到期");
    expect(text("#reminders-page")).toContain("每年");
    expect(document.querySelectorAll("#reminders-page .reminder-source")).toHaveLength(1);
    await click("#reminders-page .reminder-row:not([data-kind])", "来源对话");
    expect(opened).toHaveBeenCalledWith("thread-main");
    await click("#reminders-page .reminder-row:not([data-kind])", "不再提醒");
    expect(lastCommand()).toMatchObject({
      type: "memory.reminder.respond",
      payload: { reminderId: "reminder:memory-color", action: "cancel" },
    });
    expect(text("#reminders-page .memory-notice")).toContain("记忆本身保留");
    await click("#reminders-page .memory-notice", "撤销");
    expect(lastCommand()).toMatchObject({
      type: "memory.reminder.respond",
      payload: { reminderId: "reminder:memory-color", action: "restore" },
    });
    await click("#settings .memory-list", "主人最喜欢的颜色是蓝色");
    expect(text("#settings .memory-drawer")).toContain("每年");
  });

  it("[REM-1] creates a reminder from the reminders page, refuses a past time and hides the button until a memory exists", async () => {
    await render();
    const add = "#reminders-page .memory-card[data-kind=add]";
    await click("#reminders-page", "新建提醒");
    await type(`${add} textarea`, "周五交周报");
    await type(`${add} input[type=datetime-local]`, "2020-01-01T09:00");
    expect(text(add)).toContain("提醒时间要晚于现在");
    expect(button(add, "保存").disabled).toBe(true);
    mutate.mockClear();
    await click(add, "保存");
    expect(mutate).not.toHaveBeenCalled();
    await type(`${add} input[type=datetime-local]`, "2099-01-02T09:30");
    await act(async () =>
      document.querySelector<HTMLInputElement>(`${add} [role=switch]`)?.click(),
    );
    await click(add, "保存");
    expect(protectText).toHaveBeenLastCalledWith("周五交周报", "private");
    expect(lastCommand()).toMatchObject({
      type: "memory.reminder.create",
      payload: { contentRef: "payload-edit", due: "2099-01-02T09:30", repeat: "yearly" },
    });
    expect(text("#reminders-page .memory-notice")).toContain("已设好提醒：周五交周报");
    expect(document.querySelector(add)).toBeNull();
  });

  it("[mask-not-block][RULE-memory-visible] marks a memory or reminder that holds a card number as sensitive, keeps the text as typed and still lets a goal be pinned", async () => {
    await render();
    const memoryAdd = "#settings .memory-card[data-kind=add]";
    await click("#settings .memory-search-row", "添加");
    await type(`${memoryAdd} textarea`, "今年的目标是还清卡 6222020200112233445");
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>(`${memoryAdd} select`);
      if (!select) return;
      select.value = "goal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector<HTMLInputElement>(`${memoryAdd} [role=switch]`)?.disabled).toBe(
      false,
    );
    await click(memoryAdd, "保存");
    expect(protectText).toHaveBeenLastCalledWith(
      "今年的目标是还清卡 6222020200112233445",
      "sensitive",
    );
    expect(lastCommand()).toMatchObject({
      type: "memory.create",
      payload: { category: "goal", topic: "other", pinned: false },
    });
    expect(text("#settings .memory-notice")).not.toContain("以后每次对话都会带上");
    const reminderAdd = "#reminders-page .memory-card[data-kind=add]";
    await click("#reminders-page", "新建提醒");
    await type(`${reminderAdd} textarea`, "还信用卡 6222020200112233445");
    await type(`${reminderAdd} input[type=datetime-local]`, "2099-01-02T09:30");
    await click(reminderAdd, "保存");
    expect(protectText).toHaveBeenLastCalledWith("还信用卡 6222020200112233445", "sensitive");
  });

  it("[REM-1] does not offer a new reminder before the first memory is learned", async () => {
    overview = { ...overview, manualAddReady: false };
    await render();
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("#reminders-page button")].some(
        (item) => item.textContent === "新建提醒",
      ),
    ).toBe(false);
  });

  it("[MP-8] pauses learning, adds a memory by hand, imports pasted memories and exports", async () => {
    await render();
    const toggle = document.querySelector<HTMLInputElement>("#personalization [role=switch]");
    await act(async () => toggle?.click());
    expect(lastCommand()).toMatchObject({
      type: "memory.settings.set",
      payload: { capturePaused: true },
    });
    await click("#settings .memory-search-row", "添加");
    const add = "#settings .memory-card[data-kind=add]";
    await type(`${add} textarea`, "每天早上吃一片降压药");
    expect(document.querySelector<HTMLSelectElement>(`${add} select`)?.value).toBe("");
    classifyAnswers = [classified("health", "sensitive", "health")];
    await click(add, "保存");
    expect(protectText).toHaveBeenLastCalledWith("每天早上吃一片降压药", "sensitive");
    expect(lastCommand()).toMatchObject({
      type: "memory.create",
      payload: {
        contentRef: "payload-edit",
        category: "health",
        subCategory: null,
        topic: "health",
        pinned: false,
      },
    });
    expect(text("#settings .memory-notice")).toContain("归到“健康”");
    await click("#settings .memory-search-row", "添加");
    await type(`${add} textarea`, "今年想跑完一次半马");
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>(`${add} select`);
      if (!select) return;
      select.value = "goal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      document.querySelector<HTMLInputElement>(`${add} [role=switch]`)?.click(),
    );
    classifyAnswers = [classified("event")];
    await click(add, "保存");
    expect(protectText).toHaveBeenLastCalledWith("今年想跑完一次半马", "private");
    expect(lastCommand()).toMatchObject({
      type: "memory.create",
      payload: { category: "goal", topic: null, pinned: true },
    });
    expect(text("#settings .memory-notice")).toContain("归到“目标”，以后每次对话都会带上");
    await click("#settings .memory-footer", "导入记忆");
    await click("#settings .memory-sources", "ChatGPT、Claude 等其他 AI");
    expect(text("#settings .memory-import")).toContain("请把你记住的关于我的所有信息逐条列出来");
    const answer = "- 我住在上海\n- 回答不要用表情符号\n- 我的密码是 hunter2\n- 我对青霉素过敏";
    const fields = document.querySelectorAll<HTMLTextAreaElement>(
      "#settings .memory-import textarea",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        fields[1],
        answer,
      );
      fields[1]?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    classifyAnswers = [
      classified("other"),
      classified("rule"),
      classified("other", "sensitive", "other"),
      classified("health", "sensitive", "health"),
    ];
    duplicateAnswers = ["same", "different", "skipped", "different"];
    await click("#settings .memory-import", "拆成一条条");
    const preview = text("#settings .memory-import");
    expect(duplicateAsked.map((refs) => refs.length)).toEqual([2]);
    expect(preview).toContain("找到 4 条，已勾 1 条");
    expect(preview).toContain("已经记着，跳过");
    expect(preview).toContain("敏感，默认不导入");
    expect(preview).not.toContain("分类中");
    expect(preview).not.toContain("已直接丢掉");
    const boxes = document.querySelectorAll<HTMLInputElement>(
      "#settings .memory-preview input[type=checkbox]",
    );
    await act(async () => boxes[2]?.click());
    expect(text("#settings .memory-import")).toContain("找到 4 条，已勾 2 条");
    protectText.mockClear();
    await click("#settings .memory-import", "导入勾选的 2 条");
    expect(protectText).not.toHaveBeenCalled();
    expect(lastCommand()).toMatchObject({
      type: "memory.import.commit",
      payload: {
        source: "assistant",
        items: [
          { contentRef: "payload-edit", category: "rule", subCategory: null, topic: null },
          { contentRef: "payload-edit", category: "other", topic: "other" },
        ],
      },
    });
    expect(lastCommand().payload.batchId).toMatch(/^memory-import-\d+$/);
    const created = vi.fn(() => "blob:memories");
    vi.stubGlobal("URL", { createObjectURL: created, revokeObjectURL: vi.fn() });
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const archive = vi.fn(
      async () =>
        new Response(new Uint8Array([80, 75]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="himawari-export-2026-11-02.zip"',
            "x-himawari-export-memories": "5",
            "x-himawari-export-rules": "3",
            "x-himawari-export-withheld": "2",
          },
        }),
    );
    vi.stubGlobal("fetch", archive);
    await click("#settings .memory-footer", "导出记忆和规则");
    expect(text("#settings")).toContain("导出记忆、长期规则和决策记录");
    expect(created).not.toHaveBeenCalled();
    await click("#settings", "下载导出文件");
    expect(archive).toHaveBeenCalledWith("/api/data-export/v1/archive", {
      credentials: "same-origin",
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(text("#settings")).toContain(
      "已导出 5 条记忆、3 条正在执行的长期规则；2 处敏感内容只留了占位符。",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await click("#settings", "下载导出文件");
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(text("#settings")).toContain("导出失败，请稍后再试。");
    expect(text("#settings")).not.toContain("已导出");
    clicked.mockRestore();
  });

  it("[多人7] downloads the chat export with the counts the server reports, and shows a failure", async () => {
    await render();
    const created = vi.fn(() => "blob:chats");
    vi.stubGlobal("URL", { createObjectURL: created, revokeObjectURL: vi.fn() });
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const archive = vi.fn(
      async () =>
        new Response(new Uint8Array([80, 75]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="himawari-chats-2026-11-12.zip"',
            "x-himawari-export-threads": "3",
            "x-himawari-export-messages": "17",
            "x-himawari-export-withheld": "2",
          },
        }),
    );
    vi.stubGlobal("fetch", archive);
    await click("#settings .memory-footer", "导出聊天记录");
    expect(text("#settings")).toContain("导出全部聊天记录");
    expect(created).not.toHaveBeenCalled();
    await click("#settings", "下载聊天记录");
    expect(archive).toHaveBeenCalledWith("/api/data-export/v1/chats", {
      credentials: "same-origin",
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(text("#settings")).toContain(
      "已导出 3 个对话、17 条消息；2 条含机密的消息只留了占位符。",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await click("#settings", "下载聊天记录");
    expect(created).toHaveBeenCalledTimes(1);
    expect(text("#settings")).toContain("导出失败，请稍后再试。");
    expect(text("#settings")).not.toContain("已导出");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 413 })),
    );
    await click("#settings", "下载聊天记录");
    expect(created).toHaveBeenCalledTimes(1);
    expect(text("#settings")).toContain("聊天记录太多，网页放不下一次导出");
    expect(text("#settings")).toContain("himawari-admin data export-chats");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([80]), { status: 200 })),
    );
    await click("#settings", "下载聊天记录");
    expect(created).toHaveBeenCalledTimes(1);
    expect(text("#settings")).toContain("导出失败，请稍后再试。");
    clicked.mockRestore();
  });

  it("[MP-8][T5] keeps the import closed while the server is still sorting the entries", async () => {
    await render();
    let answer: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const plain = query.getMockImplementation();
    query.mockImplementation(async (request) => {
      if (request.type === "memory.classify.read") await answered;
      return plain?.(request);
    });
    await click("#settings .memory-footer", "导入记忆");
    await click("#settings .memory-sources", "ChatGPT、Claude 等其他 AI");
    const fields = document.querySelectorAll<HTMLTextAreaElement>(
      "#settings .memory-import textarea",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        fields[1],
        "- 我喜欢早上跑步\n- 回答不要太长",
      );
      fields[1]?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("#settings .memory-import", "拆成一条条");
    expect(text("#settings .memory-import")).toContain("分类中");
    expect(button("#settings .memory-import", "导入勾选").disabled).toBe(true);
    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>(
        "#settings .memory-preview input[type=checkbox]",
      ),
    ];
    expect(boxes.length).toBe(2);
    expect(boxes.every(({ disabled }) => disabled)).toBe(true);
    classifyAnswers = [classified("preference"), classified("rule")];
    await act(async () => answer?.());
    await act(async () => {});
    expect(text("#settings .memory-import")).not.toContain("分类中");
    expect(button("#settings .memory-import", "导入勾选").disabled).toBe(false);
  });

  it("[MP-8][A4] leaves every entry off and says so when the server could not check for duplicates", async () => {
    await render();
    duplicatesFail = true;
    classifyAnswers = [classified("preference"), classified("rule")];
    await click("#settings .memory-footer", "导入记忆");
    await click("#settings .memory-sources", "ChatGPT、Claude 等其他 AI");
    const fields = document.querySelectorAll<HTMLTextAreaElement>(
      "#settings .memory-import textarea",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        fields[1],
        "- 我喜欢早上跑步\n- 回答不要太长",
      );
      fields[1]?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("#settings .memory-import", "拆成一条条");
    const preview = text("#settings .memory-import");
    expect(preview).toContain("找到 2 条，已勾 0 条");
    expect(preview).toContain("没能核对是否重复，默认不导入");
    expect(button("#settings .memory-import", "导入勾选").disabled).toBe(true);
  });

  it("[MP-8][A4] never asks about entries the server could not sort", async () => {
    await render();
    classifyFails = true;
    await click("#settings .memory-footer", "导入记忆");
    await click("#settings .memory-sources", "ChatGPT、Claude 等其他 AI");
    const fields = document.querySelectorAll<HTMLTextAreaElement>(
      "#settings .memory-import textarea",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        fields[1],
        "- 我对青霉素过敏\n- 我住在上海",
      );
      fields[1]?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("#settings .memory-import", "拆成一条条");
    expect(duplicateAsked).toEqual([]);
    expect(text("#settings .memory-import")).toContain("找到 2 条，已勾 0 条");
  });

  it("[MP-8] keeps adding and importing closed until the first memory is learned and says why", async () => {
    overview = { ...overview, manualAddReady: false };
    await render();
    const header = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-search-row button"),
    ];
    const footer = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-footer button"),
    ];
    expect(header.find((item) => item.textContent === "添加")?.disabled).toBe(true);
    expect(footer.find((item) => item.textContent === "导入记忆")?.disabled).toBe(true);
    expect(footer.find((item) => item.textContent === "导出记忆和规则")?.disabled).toBe(false);
    expect(text("#settings")).toContain("要先从对话里记下第一条记忆，才能手动添加和导入");
    expect(document.querySelector("#settings .memory-card[data-kind=add]")).toBeNull();
  });

  it("[MP-8] shows no counts before the memories arrive", async () => {
    query.mockImplementation(() => new Promise(() => undefined));
    await render();
    expect(text("#settings [role=tablist]")).not.toMatch(/\d/);
    expect(text("#settings")).not.toContain("记住了");
    expect(text("#settings")).toContain("正在加载");
  });

  it("[MP-8] every filter number is what clicking that filter shows, whatever was clicked before", async () => {
    overview = {
      ...overview,
      memories: [
        memoryItem("m-coffee", "我喜欢喝美式", { subCategory: "饮食" }),
        memoryItem("m-fish", "主人从10月28日起喜欢吃鱼", { subCategory: "饮食" }),
        memoryItem("m-fish-old", "主人不太喜欢吃鱼", { supersededBy: "m-fish" }),
        memoryItem("m-out", "主人最近一个月都不想出去玩", { subCategory: "社交" }),
        memoryItem("m-out-old", "主人不爱出去玩", { supersededBy: "m-out" }),
        memoryItem("m-blue", "主人最喜欢蓝色"),
        memoryItem("m-city", "主人住在上海", { category: "identity" }),
        memoryItem("m-mentor", "主人的导师是张伟", { category: "relationship" }),
        memoryItem("m-old-pref", "主人喜欢喝拿铁", { status: "archived", subCategory: "饮食" }),
        memoryItem("m-old-city", "主人住在北京", { category: "identity", status: "archived" }),
        memoryItem("m-gone", "主人喜欢绿色", { status: "trashed" }),
        memoryItem("m-import", "回答一律用简体中文", { category: "rule", importBatchId: "b1" }),
      ],
      tidyUps: [
        {
          changeId: "tidy-1",
          memoryId: "m-city",
          action: "merge",
          text: "主人住在上海",
          relatedText: "主人在上海住",
          createdAt: "2026-10-25T12:00:00.000Z",
          undone: false,
          undoable: true,
        },
      ],
      imports: [
        {
          batchId: "b1",
          source: "codex",
          itemCount: 1,
          createdAt: "2026-10-25T13:00:00.000Z",
          undone: false,
        },
      ],
    };
    await render();
    const rows = () => [
      ...document.querySelectorAll<HTMLElement>(
        "#settings .memory-topics, #settings .memory-chips",
      ),
    ];
    const numberOf = (chip: HTMLButtonElement) =>
      Number(chip.querySelector("small")?.textContent ?? Number.NaN);
    const sweep = async (shown: () => number) => {
      for (let row = 0; row < rows().length; row++)
        for (let at = 0; at < (rows()[row]?.querySelectorAll("button small").length ?? 0); at++) {
          const chip = [
            ...(rows()[row]?.querySelectorAll<HTMLButtonElement>("button") ?? []),
          ].filter((item) => item.querySelector("small"))[at];
          if (!chip) continue;
          const label = chip.textContent ?? "";
          const promised = numberOf(chip);
          await act(async () => chip.click());
          expect({ label, shown: shown() }).toEqual({ label, shown: promised });
        }
    };
    const memoryRows = () => document.querySelectorAll("#settings .memory-row").length;
    await sweep(memoryRows);
    await sweep(memoryRows);
    await type("#settings input[type=search]", "喜欢");
    await sweep(memoryRows);
    await tab("变化记录");
    const events = () => document.querySelectorAll("#settings .memory-day p").length;
    await sweep(events);
    await sweep(events);
  });
});

describe("memory import parsing", () => {
  it("[MP-8] reads Codex memory files, waits for the server to sort them, skips duplicates and keeps coding notes off", () => {
    const summary = [
      "v1",
      "## User Profile",
      "Andy 在做个人 Agent 项目 Himawari。在准备 AI 应用工程师岗位的面试。",
      "## User preferences",
      "- 回答一律用简体中文 [Task 2]",
      "- 先给结论，再讲过程",
      "## General Tips",
      "- 提交前先跑文档严格校验",
      "## What's in Memory",
      "### himawari-agent",
      "- 自研记忆 desc: 记忆引擎",
    ].join("\n");
    const parsed = parseMemoryText("memory_summary.md", summary);
    expect(parsed.items.map((item) => [item.text, item.status, item.checked])).toEqual([
      ["Andy 在做个人 Agent 项目 Himawari", "classifying", false],
      ["在准备 AI 应用工程师岗位的面试", "classifying", false],
      ["回答一律用简体中文", "classifying", false],
      ["先给结论，再讲过程", "classifying", false],
      ["提交前先跑文档严格校验", "classifying", false],
    ]);
    expect(parsed.items.every((item) => item.duplicateCheck === "pending")).toBe(true);
    expect(parsed.items.every((item) => !item.duplicate)).toBe(true);
    expect(parsed.items[4]).toMatchObject({ coding: true, subCategory: "Codex" });
    const checked = applyImportDuplicates(parsed.items, [
      "different",
      "different",
      "same",
      "unsure",
      "skipped",
    ]);
    const sorted = applyImportClassifications(checked, [
      classified("project"),
      classified("goal"),
      classified("rule"),
      classified("rule"),
      classified("health", "sensitive", "health"),
    ]);
    expect(
      sorted.map((item) => [
        item.category,
        item.sensitive,
        item.duplicate,
        item.duplicateCheck,
        item.checked,
      ]),
    ).toEqual([
      ["project", false, false, "clear", true],
      ["goal", false, false, "clear", true],
      ["rule", false, true, "clear", false],
      ["rule", false, false, "similar", false],
      ["project", true, false, "unchecked", false],
    ]);
    expect(sorted[4]?.topic).toBe("health");
  });

  it("[MP-8][A4] never decides sameness from the words: text that merely contains an existing memory stays importable until the server says it is the same", () => {
    const parsed = parseMemoryText("answer.md", "- 回答一律用简体中文，并且先给结论");
    expect(parsed.items[0]).toMatchObject({ duplicate: false, duplicateCheck: "pending" });
    const checked = applyImportDuplicates(parsed.items, ["different"]);
    const sorted = applyImportClassifications(checked, [classified("rule")]);
    expect(sorted[0]).toMatchObject({ duplicate: false, duplicateCheck: "clear", checked: true });
    expect(applyImportDuplicates(parsed.items, [])[0]).toMatchObject({
      duplicate: false,
      duplicateCheck: "unchecked",
      checked: false,
    });
  });

  it("[MP-8][A4] keeps a coding note off even when the server says it is not a duplicate", () => {
    const parsed = parseMemoryText(
      "memory_summary.md",
      "## General Tips\n- 提交前先跑文档严格校验",
    );
    expect(parsed.items[0]).toMatchObject({ coding: true });
    const sorted = applyImportDuplicates(
      applyImportClassifications(parsed.items, [classified("project")]),
      ["different"],
    );
    expect(sorted[0]).toMatchObject({ duplicateCheck: "clear", status: "ready", checked: false });
  });

  it("[MP-8][A4] keeps an export entry off until the server has checked it, and leaves a failed check off", () => {
    const exported = JSON.stringify({
      memories: [{ text: "不吃香菜", category: "preference", status: "active" }],
    });
    const parsed = parseMemoryExport("himawari-memories.json", exported);
    expect(parsed.items[0]).toMatchObject({ checked: false, duplicateCheck: "pending" });
    expect(applyImportDuplicates(parsed.items, ["different"])[0]?.checked).toBe(true);
    expect(applyImportDuplicates(parsed.items, ["same"])[0]).toMatchObject({
      duplicate: true,
      checked: false,
    });
    expect(applyImportDuplicates(parsed.items, ["unsure"])[0]).toMatchObject({
      duplicateCheck: "similar",
      checked: false,
    });
    expect(applyImportDuplicates(parsed.items, ["skipped"])[0]).toMatchObject({
      duplicateCheck: "unchecked",
      checked: false,
    });
  });

  it("[MP-8][T5] keeps an entry the server could not sort private and unchecked, and never guesses from words", () => {
    const parsed = parseMemoryText("answer.md", "- 我对青霉素过敏\n- 我最喜欢的颜色是蓝色");
    expect(parsed.items.map((item) => [item.category, item.sensitive])).toEqual([
      ["other", false],
      ["other", false],
    ]);
    const sorted = applyImportClassifications(
      applyImportDuplicates(parsed.items, ["different", "different"]),
      [
        { category: "other", classification: "sensitive", topic: "other", failed: true },
        classified("preference"),
      ],
    );
    expect(sorted.map((item) => [item.status, item.sensitive, item.topic, item.checked])).toEqual([
      ["unclassified", true, "other", false],
      ["ready", false, null, true],
    ]);
    expect(applyImportClassifications(parsed.items, [])[1]).toMatchObject({
      status: "unclassified",
      sensitive: true,
      checked: false,
    });
  });

  it("[MP-8] reads a Himawari export and keeps only memories that were in use", () => {
    const exported = JSON.stringify({
      memories: [
        {
          text: "不吃香菜",
          category: "preference",
          subCategory: "饮食",
          sensitive: false,
          status: "active",
        },
        { text: "喜欢蓝色", category: "preference", status: "archived" },
        { text: "对青霉素过敏", category: "health", sensitive: true, status: "active" },
        { text: "旧说法", category: "unknown", status: "superseded" },
        {
          text: "每周日去教堂",
          category: "other",
          sensitive: true,
          sensitiveTopic: "beliefs",
          status: "active",
        },
        {
          text: "常去的那家店",
          category: "other",
          sensitive: true,
          sensitiveTopic: "made-up",
          status: "active",
        },
      ],
    });
    const parsedExport = parseMemoryExport("himawari-memories.json", exported);
    expect(
      applyImportDuplicates(parsedExport.items, [
        "different",
        "different",
        "different",
        "different",
      ]),
    ).toEqual([
      expect.objectContaining({
        text: "不吃香菜",
        subCategory: "饮食",
        checked: true,
        topic: null,
      }),
      expect.objectContaining({ text: "对青霉素过敏", category: "health", checked: false }),
      expect.objectContaining({ text: "每周日去教堂", topic: "beliefs", sensitive: true }),
      expect.objectContaining({ text: "常去的那家店", topic: null, sensitive: true }),
    ]);
    expect(() => parseMemoryExport("x.json", "{}")).toThrow("MEMORY_EXPORT_INVALID");
  });
});

describe("memory wording", () => {
  it("[MEM-WORD] uses one category name on the profile and on the cards", () => {
    expect(messages["memory.profile.relationship"]).toBe("人际关系");
    expect(messages["memory.cat"]).toContain("relationship {人际关系}");
  });
});
