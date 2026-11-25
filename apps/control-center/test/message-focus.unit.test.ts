// @vitest-environment jsdom
import type { ThreadGatewaySnapshot } from "@himawari-agent/gateway-contracts";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistory } from "../src/components/chat-history.tsx";
import {
  clearMessageFocus,
  hasPendingMessageFocus,
  requestMessageFocus,
  takeMessageFocus,
} from "../src/message-focus.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;

const owner = (id: string, sequence: number): Detail["payload"]["messages"][number] => ({
  messageId: id,
  sequence,
  role: "owner",
  contentRef: `payload:${id}`,
  dataClassification: "private",
  status: "committed",
  turnId: `turn:${id}`,
  runId: null,
  committedAt: "2026-09-11T00:00:00Z",
});

function detailOf(threadId: string): Detail {
  return {
    schemaVersion: "gateway.thread.v3",
    kind: "snapshot",
    type: "thread.detail_snapshot",
    messageId: "snapshot:one",
    correlationId: "query:one",
    causationId: null,
    scope: { ownerId: "owner:test", agentId: "agent:test" },
    authority: { deploymentId: "deployment:test", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system:test" },
    payload: {
      thread: {
        threadId,
        revision: 1,
        status: "active",
        titleRef: null,
        titleSource: null,
        titleRevision: 0,
        pinOrder: null,
        answerLocale: "zh-CN",
        messageWatermark: 0,
        sourceThreadId: null,
        sourceWatermark: null,
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:12Z",
      },
      snapshotRef: "snapshot:one",
      generatedAt: "2026-09-11T00:00:12Z",
      nextSequence: null,
      messages: [owner("message-a", 1), owner("message-b", 2)],
      runs: [],
    },
  } as Detail;
}

let container: HTMLDivElement;
let root: Root;
const scrolled = vi.fn();

async function show(threadId: string) {
  await act(async () => {
    root.render(
      h(ChatHistory, {
        detail: detailOf(threadId),
        contentByRef: { "payload:message-a": "第一句", "payload:message-b": "第二句" },
        execution: {},
        connection: "connected",
        message: (id) => id,
        renderApproval: () => null,
      }),
    );
  });
}

describe("[P1-1] jumping to a message from the memory page", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: function (this: HTMLElement) {
        scrolled(this.dataset["messageId"]);
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    scrolled.mockClear();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("scrolls to the asked message in its own thread and highlights it", async () => {
    requestMessageFocus("thread-1", "message-b");
    await show("thread-1");
    expect(scrolled).toHaveBeenCalledWith("message-b");
    expect(
      container.querySelector("[data-message-id=message-b]")?.hasAttribute("data-focused"),
    ).toBe(true);
    expect(
      container.querySelector("[data-message-id=message-a]")?.hasAttribute("data-focused"),
    ).toBe(false);
    expect(hasPendingMessageFocus()).toBe(false);
  });

  it("waits as long as the conversation takes to load, and gives up only after another conversation has been showing for ten seconds", () => {
    vi.useFakeTimers();
    try {
      requestMessageFocus("thread-1", "message-b");
      vi.advanceTimersByTime(60_000);
      expect(hasPendingMessageFocus()).toBe(true);
      expect(takeMessageFocus("thread-other")).toBeNull();
      vi.advanceTimersByTime(9_000);
      expect(takeMessageFocus("thread-other")).toBeNull();
      expect(hasPendingMessageFocus()).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(takeMessageFocus("thread-other")).toBeNull();
      expect(hasPendingMessageFocus()).toBe(false);
      requestMessageFocus("thread-1", "message-b");
      vi.advanceTimersByTime(60_000);
      expect(takeMessageFocus("thread-1")).toEqual({
        threadId: "thread-1",
        messageId: "message-b",
      });
      expect(hasPendingMessageFocus()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for another thread, and for a message that is not there", async () => {
    requestMessageFocus("thread-other", "message-b");
    await show("thread-1");
    expect(scrolled).not.toHaveBeenCalled();
    clearMessageFocus();
    requestMessageFocus("thread-1", "message-gone");
    await show("thread-1");
    expect(scrolled).not.toHaveBeenCalled();
    expect(container.querySelector("[data-focused]")).toBeNull();
    expect(hasPendingMessageFocus()).toBe(false);
  });
});
