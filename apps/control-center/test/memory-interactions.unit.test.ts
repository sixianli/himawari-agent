// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemorySettings,
  MemoryTurnNote,
  OPEN_MEMORY_SETTINGS,
} from "../src/components/memory-panel.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import { type MemoryOverview, useMemory } from "../src/memory.ts";

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
const message = (id: MessageId, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    messages[id] as string,
  );
const query = vi.fn(),
  mutate = vi.fn(),
  protectText = vi.fn();
const client = { query, mutate, protectText } as unknown as GatewayClient;
let container: HTMLDivElement, root: Root, overview: MemoryOverview;
const opened = vi.fn();

function Harness({ ownerRefs }: { ownerRefs: readonly string[] }) {
  const memory = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
  if (!memory) return null;
  return h(
    "div",
    null,
    h("div", { id: "turn" }, h(MemoryTurnNote, { ownerRefs, memory, message })),
    h("div", { id: "settings" }, h(MemorySettings, { memory, message, onOpenThread: opened })),
  );
}

async function render(ownerRefs: readonly string[] = ["payload-1"]) {
  await act(async () => root.render(h(Harness, { ownerRefs })));
  await act(async () => {});
}

function button(scope: string, label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  overview = {
    memories: [
      {
        memoryId: "memory-color",
        revision: 2,
        text: "主人最喜欢的颜色是蓝色",
        dataClassification: "private",
        topic: null,
        inference: false,
        sourceThreadId: "thread-1",
        sourceRefs: ["payload-1"],
        updatedAt: "2026-10-25T12:00:00.000Z",
      },
      {
        memoryId: "memory-city",
        revision: 1,
        text: "主人住在上海",
        dataClassification: "private",
        topic: null,
        inference: false,
        sourceThreadId: "thread-2",
        sourceRefs: ["payload-9"],
        updatedAt: "2026-10-24T12:00:00.000Z",
      },
    ],
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
    const turn = document.querySelector("#turn")?.textContent ?? "";
    expect(turn).toContain("主人对青霉素过敏");
    expect(turn).toContain("这条涉及「健康」");
    expect(turn).toContain("已记住 1 条");
    expect(turn).not.toContain("主人住在上海");
    await render(["payload-other"]);
    expect(document.querySelector("#turn")?.textContent).toBe("");
  });

  it("approves, edits and rejects a sensitive proposal", async () => {
    await render();
    await act(async () => button("#turn", "记住").click());
    expect(mutate.mock.lastCall?.[0]).toMatchObject({
      type: "memory.approval.respond",
      payload: { requestId: "approval-health", resolution: "approved", editedText: null },
    });
    await act(async () => button("#turn", "改一下再记").click());
    const editor = document.querySelector<HTMLTextAreaElement>("#turn textarea");
    if (!editor) throw new Error("editor");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, "主人对青霉素和头孢过敏");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("#turn", "保存").click());
    expect(mutate.mock.lastCall?.[0]).toMatchObject({
      payload: { resolution: "edited", editedText: "主人对青霉素和头孢过敏" },
    });
    await act(async () => button("#settings", "不记").click());
    expect(mutate.mock.lastCall?.[0]).toMatchObject({ payload: { resolution: "rejected" } });
  });

  it("searches, opens the source, corrects and deletes memories in settings", async () => {
    await render();
    const settings = () => document.querySelector("#settings")?.textContent ?? "";
    expect(settings()).toContain("待你确认（1）");
    expect(settings()).toContain("共 2 条");
    const search = document.querySelector<HTMLInputElement>("#settings input[type=search]");
    if (!search) throw new Error("search");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "上海");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(settings()).toContain("主人住在上海");
    expect(settings()).not.toContain("主人最喜欢的颜色是蓝色");
    await act(async () => button("#settings .memory-list", "来源对话").click());
    expect(opened).toHaveBeenCalledWith("thread-2");
    await act(async () => button("#settings .memory-list", "编辑").click());
    const editor = document.querySelector<HTMLTextAreaElement>("#settings .memory-list textarea");
    if (!editor) throw new Error("editor");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, "主人住在杭州");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("#settings .memory-list", "保存").click());
    expect(protectText).toHaveBeenCalledWith("主人住在杭州", "private");
    expect(mutate.mock.lastCall?.[0]).toMatchObject({
      type: "memory.mutate",
      payload: {
        memoryId: "memory-city",
        action: "correct",
        expectedRevision: 1,
        contentRef: "payload-edit",
      },
    });
    await act(async () => button("#settings .memory-list", "删除").click());
    expect(settings()).toContain("删除后，以后的对话不会再用到这条记忆。");
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("#settings .memory-list [role=alert] button"),
    ].find((item) => item.textContent === "删除");
    await act(async () => confirm?.click());
    expect(mutate.mock.lastCall?.[0]).toMatchObject({
      type: "memory.mutate",
      payload: { memoryId: "memory-city", action: "delete", contentRef: null },
    });
  });

  it("opens memory settings from the remembered line", async () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_MEMORY_SETTINGS, listener);
    await render();
    await act(async () => button("#turn", "管理记忆").click());
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_MEMORY_SETTINGS, listener);
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
});
