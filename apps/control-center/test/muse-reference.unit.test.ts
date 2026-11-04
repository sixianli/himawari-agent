// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuseDataSettings, MuseReference } from "../src/components/muse-reference.tsx";
import type { MuseItem, MuseModel, MuseOverview } from "../src/muse.ts";
import { messages as enMessages } from "../src/i18n/resources/en.ts";
import { messages as jaMessages } from "../src/i18n/resources/ja.ts";
import { messages as zhMessages } from "../src/i18n/resources/zh-CN.ts";

const message = (id: string, values?: Record<string, string | number>) =>
  values ? `${id}|${Object.values(values).join(",")}` : id;

function item(changes: Partial<MuseItem> = {}): MuseItem {
  return {
    kind: "proactive_item",
    naturalKey: "k1",
    occurredAt: "2026-11-01T01:00:00.000Z",
    title: "GitHub 存储",
    text: "仓库快满了",
    withheld: false,
    timingOk: null,
    contentOk: null,
    ...changes,
  } as MuseItem;
}

function overview(changes: Partial<MuseOverview> = {}): MuseOverview {
  return {
    channel: { state: "ok", lastBatchAt: "2026-11-01T02:00:00.000Z", gapCount: 0 },
    receivedWeek: 4,
    suppressedWeek: 0,
    pending: 2,
    delay: null,
    items: [item()],
    generatedAt: "2026-11-01T02:05:00.000Z",
    ...changes,
  } as MuseOverview;
}

function model(over: MuseOverview | null, changes: Partial<MuseModel> = {}): MuseModel {
  return {
    overview: over,
    failed: false,
    busy: false,
    rate: vi.fn(async () => true),
    setPaused: vi.fn(async () => true),
    clearAll: vi.fn(async () => true),
    ...changes,
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReturnType<typeof h>) {
  act(() => root.render(node));
}
function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === label,
  );
}
function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

describe("Muse 参考区", () => {
  it("从未收到过数据时不显示任何数字", () => {
    const m = model(
      overview({
        channel: { state: "never", lastBatchAt: null, gapCount: 0 },
        receivedWeek: 0,
        pending: 0,
        items: [],
      }),
    );
    render(h(MuseReference, { muse: m, message, locale: "zh-CN" }));
    expect(container.textContent).toContain("muse.channel.never");
    expect(container.textContent).not.toContain("muse.received");
    expect(container.textContent).not.toContain("muse.pending");
  });

  it("正常时显示本周收到和待评价数量", () => {
    render(h(MuseReference, { muse: model(overview()), message, locale: "zh-CN" }));
    expect(container.textContent).toContain("muse.received|4");
    expect(container.textContent).toContain("muse.pending|2");
    expect(container.textContent).toContain("GitHub 存储");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("只选了时机时不发评价，两项都选了才发", () => {
    const m = model(overview());
    render(h(MuseReference, { muse: m, message, locale: "zh-CN" }));
    const rights = buttons("muse.right");
    click(rights[0] as Element);
    expect(m.rate).not.toHaveBeenCalled();
    click(buttons("muse.wrong")[1] as Element);
    expect(m.rate).toHaveBeenCalledTimes(1);
    expect(m.rate).toHaveBeenCalledWith(expect.objectContaining({ naturalKey: "k1" }), true, false);
  });

  it("已评价的条目可以撤销，撤销发送两个空值", () => {
    const m = model(overview({ items: [item({ timingOk: true, contentOk: false })] }));
    render(h(MuseReference, { muse: m, message, locale: "zh-CN" }));
    click(buttons("muse.undo")[0] as Element);
    expect(m.rate).toHaveBeenCalledWith(expect.objectContaining({ naturalKey: "k1" }), null, null);
  });

  it("含敏感内容的条目只显示占位，不显示原文", () => {
    const m = model(overview({ items: [item({ withheld: true, title: null, text: null })] }));
    render(h(MuseReference, { muse: m, message, locale: "zh-CN" }));
    expect(container.textContent).toContain("muse.withheld");
    expect(container.textContent).not.toContain("仓库快满了");
  });

  it("通道中断时用警示角色显示", () => {
    const m = model(
      overview({
        channel: { state: "down", lastBatchAt: "2026-11-01T00:00:00.000Z", gapCount: 0 },
      }),
    );
    render(h(MuseReference, { muse: m, message, locale: "zh-CN" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("muse.channel.down");
  });

  it("样本不足时不显示延迟，够了才显示", () => {
    render(h(MuseReference, { muse: model(overview()), message, locale: "zh-CN" }));
    expect(container.textContent).not.toContain("muse.delay");
    render(
      h(MuseReference, {
        muse: model(overview({ delay: { medianMinutes: 330, samples: 12 } })),
        message,
        locale: "zh-CN",
      }),
    );
    expect(container.textContent).toContain("muse.delay");
  });

  it("不出现命中率之类的字样", () => {
    render(h(MuseReference, { muse: model(overview()), message, locale: "zh-CN" }));
    expect(container.textContent).not.toMatch(/命中|hit/i);
  });

  it("三种语言都有完整的 Muse 文案", () => {
    const keys = Object.keys(zhMessages).filter((key) => key.startsWith("muse."));
    expect(keys.length).toBeGreaterThan(20);
    for (const resources of [enMessages, jaMessages] as Record<string, string>[])
      for (const key of keys) expect(resources[key], key).toBeTruthy();
  });
});

describe("Muse 数据设置", () => {
  it("暂停按钮按当前状态切换", () => {
    const m = model(overview());
    render(h(MuseDataSettings, { muse: m, message }));
    click(buttons("muse.settings.pause")[0] as Element);
    expect(m.setPaused).toHaveBeenCalledWith(true);
  });

  it("清除要先确认，取消不发命令，确认才发", async () => {
    const m = model(overview());
    render(h(MuseDataSettings, { muse: m, message }));
    click(buttons("muse.settings.clear")[0] as Element);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    click(buttons("governed.cancel")[0] as Element);
    expect(m.clearAll).not.toHaveBeenCalled();
    click(buttons("muse.settings.clear")[0] as Element);
    const confirm = buttons("muse.settings.clear")[0] as Element;
    await act(async () => {
      (confirm as HTMLElement).click();
    });
    expect(m.clearAll).toHaveBeenCalledTimes(1);
  });
});
