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
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import { type MemoryItem, type MemoryOverview, useMemory } from "../src/memory.ts";
import { parseMemoryExport, parseMemoryText } from "../src/memory-import.ts";

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
    sourceRefs: ["payload-1"],
    updatedAt: "2026-10-25T12:00:00.000Z",
    supersededBy: null,
    validTo: null,
    tentative: false,
    category: "preference",
    subCategory: null,
    status: "active",
    recordedAt: "2026-10-25T12:00:00.000Z",
    lastUsedAt: null,
    importBatchId: null,
    stance: null,
    history: [],
    ...change,
  };
}

function node(
  kind: MemoryItem["history"][number]["kind"],
  text: string,
  stance: string,
  at: string,
  change: Partial<MemoryItem["history"][number]> = {},
): MemoryItem["history"][number] {
  return {
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
    h(
      "div",
      { id: "settings" },
      h(MemoryPage, { memory, message, onBack: () => undefined, onOpenThread: opened }),
    ),
    h("div", { id: "reminders" }, h(MemoryReminders, { memory, message })),
    h(
      "div",
      { id: "reminders-page" },
      h(RemindersPage, { memory, message, onBack: () => undefined, onOpenThread: opened }),
    ),
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
      onBack: () => undefined,
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
        sourceRefs: ["payload-9"],
        category: "identity",
        updatedAt: "2026-10-24T12:00:00.000Z",
        recordedAt: "2026-10-24T12:00:00.000Z",
      }),
    ],
    profile: [],
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
    reminders: [],
    upcoming: [],
    people: [],
    personSuggestions: [],
    imports: [],
    capturePaused: false,
    manualAddReady: true,
    generatedAt: "2026-10-25T12:00:00.000Z",
  };
  query.mockImplementation(async (request) => ({
    ...request,
    kind: "snapshot",
    type: "memory.overview.snapshot",
    payload: overview,
  }));
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

  it("[MP-8] filters, opens the source, corrects, deletes and recovers memories in the all tab", async () => {
    await render();
    expect(text("#settings [role=tablist]")).toContain("待确认1");
    await tab("全部记忆");
    expect(text("#settings")).toContain("记住了 2 条关于你的事");
    await type("#settings input[type=search]", "上海");
    expect(text("#settings .memory-list")).toContain("主人住在上海");
    expect(text("#settings .memory-list")).not.toContain("蓝色");
    await type("#settings input[type=search]", "");
    await click("#settings .memory-chips", "身份");
    expect(text("#settings .memory-list")).not.toContain("蓝色");
    await click("#settings .memory-list", "主人住在上海");
    expect(text("#settings .memory-detail")).toContain("还没用到");
    await click("#settings .memory-detail", "来源对话");
    expect(opened).toHaveBeenCalledWith("thread-2");
    await click("#settings .memory-detail", "编辑");
    await type("#settings .memory-list textarea", "主人住在杭州");
    await click("#settings .memory-list", "保存");
    expect(protectText).toHaveBeenCalledWith("主人住在杭州", "private");
    expect(lastCommand()).toMatchObject({
      type: "memory.mutate",
      payload: { memoryId: "memory-city", action: "correct", expectedRevision: 1 },
    });
    await click("#settings .memory-detail", "删除");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-city", action: "delete", contentRef: null },
    });
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
    await tab("全部记忆");
    expect(text("#settings")).toContain("已归档 1 条");
    await click("#settings .memory-chips", "已归档");
    await click("#settings .memory-list", "在找二手 4K 显示器");
    await click("#settings .memory-detail", "恢复使用");
    expect(lastCommand()).toMatchObject({ payload: { memoryId: "memory-old", action: "recover" } });
    await click("#settings .memory-chips", "最近删除");
    expect(text("#settings .memory-list")).toContain("喜欢绿色");
    await click("#settings .memory-list", "喜欢绿色");
    expect(text("#settings .memory-detail")).toContain("7 天后自动彻底清除");
    await click("#settings .memory-detail", "恢复");
    expect(lastCommand()).toMatchObject({
      payload: { memoryId: "memory-gone", action: "recover", expectedRevision: 3 },
    });
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
    expect(text("#settings [role=tab][aria-selected=true]")).toContain("全部记忆");
    const rows = [...document.querySelectorAll("#settings .memory-row")];
    expect(rows[0]?.getAttribute("data-just-saved")).toBe("true");
    expect(rows[0]?.textContent).toContain("刚记住");
    expect(rows[0]?.textContent).toContain("主人最喜欢的颜色是蓝色");
    expect(rows[1]?.textContent).not.toContain("刚记住");
    expect(document.querySelector("#settings .memory-detail")).toBeNull();
    await click("#settings .memory-list", "主人最喜欢的颜色是蓝色");
    await click("#settings .memory-detail", "删除");
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

  it("keeps a long profile section to a few lines and hands the rest to the full list", async () => {
    const likes = Array.from({ length: 12 }, (_, index) =>
      memoryItem(`memory-like-${index}`, `喜欢第 ${index + 1} 样东西`, { category: "preference" }),
    );
    overview = {
      ...overview,
      pending: [],
      memories: [...overview.memories, ...likes],
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
    const card = () => text("#settings .memory-profile-columns");
    expect(card()).toContain("喜欢第 3 样东西");
    expect(card()).not.toContain("喜欢第 4 样东西");
    await click("#settings .memory-card-more", "展开其余 5 条");
    expect(card()).toContain("喜欢第 8 样东西");
    expect(card()).not.toContain("喜欢第 9 样东西");
    await click("#settings .memory-card-more", "查看全部 12 条偏好");
    expect(text("#settings [role=tab][aria-selected=true]")).toContain("全部记忆");
    expect(text("#settings .memory-chips button[aria-pressed=true]")).toContain("偏好");
    expect(text("#settings .memory-list")).toContain("喜欢第 12 样东西");
    expect(text("#settings .memory-list")).not.toContain("主人住在上海");
  });

  it("[MH-2] draws every change of a back-and-forth memory as two lanes and a folded list", async () => {
    overview = { ...overview, pending: [], memories: [...overview.memories, ...outingChain()] };
    await render();
    await tab("全部记忆");
    expect(text("#settings .memory-page")).toContain("改过 4 次");
    await click("#settings .memory-page", "主人最近一个月都不想出去玩");
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
    await tab("全部记忆");
    await click("#settings .memory-page", "主人住在上海");
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
    await tab("时间线");
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
    ).toContain("全部记忆");
    expect(text("#settings .memory-detail")).toContain("怎么变过来的");
    expect(text("#settings .memory-history-summary")).toBe("变过 4 次，另外有 1 次说了同样的意思");
  });

  it("[MH-4] says the source conversation was deleted instead of calling it a daily tidy-up", async () => {
    overview = {
      ...overview,
      pending: [],
      memories: [
        memoryItem("memory-orphan", "主人喜欢爬山", {
          sourceThreadId: null,
          history: [
            {
              kind: "created",
              text: "主人喜欢爬山",
              stance: null,
              quote: null,
              sourceThreadId: null,
              sourceDeleted: true,
              at: "2026-10-25T12:00:00.000Z",
            },
          ],
        }),
      ],
    };
    await render();
    await tab("全部记忆");
    await click("#settings .memory-page", "主人喜欢爬山");
    expect(text("#settings .memory-detail")).toContain("来源对话已删除");
    expect(text("#settings .memory-detail")).not.toContain("每日整理");
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
    const profile = text("#settings .memory-profile-columns");
    expect(profile).toContain("偏好");
    expect(profile).toContain("颜色");
    expect(profile).toContain("饮食");
    expect(text("#settings .memory-people")).toContain("你的妈妈");
    await click("#settings .memory-people .memory-list", "李秀英");
    const person = text("#settings .memory-people");
    expect(person).toContain("也叫：妈妈");
    expect(person).toContain("李秀英的妹妹");
    expect(person).toContain("李秀英是主人的妈妈");
    await click("#settings .memory-profile-columns", "喝咖啡不加糖");
    expect(document.querySelector("#settings .memory-profile-columns textarea")).not.toBeNull();
    await tab("全部记忆");
    await click("#settings .memory-list", "主人住在上海");
    expect(text("#settings .memory-detail")).toContain("主人住在北京");
    await click("#settings .memory-detail", "换回这个说法");
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
          action: "merge",
          text: "主人的女儿叫小葵",
          relatedText: "主人的女儿名叫小葵",
          createdAt: "2026-10-25T12:00:00.000Z",
          undone: false,
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
    expect(text("#settings [role=tablist]")).toContain("待确认3");
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
    await tab("时间线");
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

  it("[MP-8] answers due reminders and cancels an upcoming one", async () => {
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
    await tab("全部记忆");
    await click("#settings .memory-list", "主人最喜欢的颜色是蓝色");
    expect(text("#settings .memory-detail")).toContain("每年");
  });

  it("[MP-8] pauses learning, adds a memory by hand, imports pasted memories and exports", async () => {
    await render();
    const toggle = document.querySelector<HTMLInputElement>("#settings [role=switch]");
    await act(async () => toggle?.click());
    expect(lastCommand()).toMatchObject({
      type: "memory.settings.set",
      payload: { capturePaused: true },
    });
    await click("#settings .memory-header", "手动添加一条");
    await type("#settings .memory-card textarea", "每天早上吃一片降压药");
    await click("#settings .memory-card", "保存");
    expect(protectText).toHaveBeenLastCalledWith("每天早上吃一片降压药", "sensitive");
    expect(lastCommand()).toMatchObject({
      type: "memory.create",
      payload: { contentRef: "payload-edit", category: "health", subCategory: null },
    });
    expect(text("#settings .memory-notice")).toContain("归到“健康”");
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
    await click("#settings .memory-import", "整理成一条条");
    const preview = text("#settings .memory-import");
    expect(preview).toContain("找到 3 条，已勾 1 条");
    expect(preview).toContain("已经记着，跳过");
    expect(preview).toContain("敏感，默认不导入");
    expect(preview).toContain("另有 1 条像是密码");
    protectText.mockClear();
    await click("#settings .memory-import", "导入勾选的 1 条");
    expect(protectText).toHaveBeenCalledWith("回答不要用表情符号", "private");
    expect(lastCommand()).toMatchObject({
      type: "memory.import.commit",
      payload: {
        source: "assistant",
        items: [{ contentRef: "payload-edit", category: "rule", subCategory: null }],
      },
    });
    expect(lastCommand().payload.batchId).toMatch(/^memory-import-\d+$/);
    const created = vi.fn(() => "blob:memories");
    vi.stubGlobal("URL", { createObjectURL: created, revokeObjectURL: vi.fn() });
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    await click("#settings .memory-footer", "导出全部记忆");
    expect(text("#settings")).toContain("导出 2 条");
    await click("#settings", "下载 JSON 文件");
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    clicked.mockRestore();
  });

  it("[MP-8] keeps adding and importing closed until the first memory is learned and says why", async () => {
    overview = { ...overview, manualAddReady: false };
    await render();
    const header = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-header button"),
    ];
    const footer = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-footer button"),
    ];
    expect(header.find((item) => item.textContent === "手动添加一条")?.disabled).toBe(true);
    expect(footer.find((item) => item.textContent === "导入记忆")?.disabled).toBe(true);
    expect(footer.find((item) => item.textContent === "导出全部记忆")?.disabled).toBe(false);
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
          action: "merge",
          text: "主人住在上海",
          relatedText: "主人在上海住",
          createdAt: "2026-10-25T12:00:00.000Z",
          undone: false,
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
    const rows = () => [...document.querySelectorAll<HTMLElement>("#settings .memory-chips")];
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
    await tab("全部记忆");
    const memoryRows = () => document.querySelectorAll("#settings .memory-row").length;
    await sweep(memoryRows);
    await sweep(memoryRows);
    await type("#settings input[type=search]", "喜欢");
    await sweep(memoryRows);
    await tab("时间线");
    const events = () => document.querySelectorAll("#settings .memory-day p").length;
    await sweep(events);
    await sweep(events);
  });
});

describe("memory import parsing", () => {
  it("[MP-8] reads Codex memory files, drops secrets, skips duplicates and keeps coding notes off", () => {
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
    const parsed = parseMemoryText("memory_summary.md", summary, ["回答一律用简体中文"]);
    expect(parsed.items.map((item) => [item.text, item.category, item.checked])).toEqual([
      ["Andy 在做个人 Agent 项目 Himawari", "project", true],
      ["在准备 AI 应用工程师岗位的面试", "goal", true],
      ["回答一律用简体中文", "rule", false],
      ["先给结论，再讲过程", "rule", true],
      ["提交前先跑文档严格校验", "project", false],
    ]);
    expect(parsed.items[2]?.duplicate).toBe(true);
    expect(parsed.items[4]).toMatchObject({ coding: true, subCategory: "Codex" });
    const agents = parseMemoryText("AGENTS.md", "# Global\n- 推送后不要强推\n- token 是 ghp_x", []);
    expect(agents.items.map((item) => item.text)).toEqual(["推送后不要强推"]);
    expect(agents.dropped).toBe(1);
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
      ],
    });
    expect(parseMemoryExport("himawari-memories.json", exported, []).items).toEqual([
      expect.objectContaining({ text: "不吃香菜", subCategory: "饮食", checked: true }),
      expect.objectContaining({ text: "对青霉素过敏", category: "health", checked: false }),
    ]);
    expect(() => parseMemoryExport("x.json", "{}", [])).toThrow("MEMORY_EXPORT_INVALID");
  });
});
