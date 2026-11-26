// @vitest-environment jsdom

import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { act, Fragment, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeForSurface } from "../src/app/router.js";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.js";
import { messages } from "../src/i18n/resources/zh-CN.js";
import { ControlCenterIntlProvider } from "../src/i18n/runtime.js";
import {
  type ThreadControlCenterModel,
  type ThreadControlCenterOptions,
  useThreadControlCenter,
} from "../src/thread-control-center.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
class FakeEventSource {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
  close() {
    this.closed = true;
  }
}
function stubEventSource(sources: FakeEventSource[]) {
  vi.stubGlobal(
    "EventSource",
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        sources.push(this);
      }
    },
  );
}
function executionChanged(runId: string, runRevision: number, traceSequence: number) {
  return {
    schemaVersion: "gateway.thread.v3",
    kind: "event",
    type: "thread.execution_changed",
    messageId: `execution:${runId}:${traceSequence}`,
    correlationId: "subscription-ui",
    causationId: null,
    scope: { ownerId: "owner-ui", agentId: "agent-ui" },
    authority: { deploymentId: "deployment-ui", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "thread-gateway" },
    payload: {
      threadId: "thread-ui",
      runId,
      runRevision,
      traceSequence,
      resourceRevision: null,
      observedAt: "2026-09-14T00:00:00.000Z",
    },
  };
}
const NOW = "2026-09-14T00:00:00Z";
const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner-ui",
  agentId: "agent-ui",
  deploymentId: "deployment-ui",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner-ui",
  csrfToken: "csrf-ui",
  sessionId: "session-ui",
  canCancelRun: true,
};
const summary = (
  status: Detail["payload"]["thread"]["status"] = "active",
): Detail["payload"]["thread"] => ({
  threadId: "thread-ui",
  revision: 2,
  status,
  titleRef: "title-ui",
  titleSource: "automatic",
  titleRevision: 1,
  pinOrder: null,
  answerLocale: "zh-CN",
  messageWatermark: 1,
  sourceThreadId: null,
  sourceWatermark: null,
  createdAt: NOW,
  updatedAt: NOW,
});
let root: Root,
  container: HTMLDivElement,
  options: ThreadControlCenterOptions,
  model: ThreadControlCenterModel;
let thread = summary();
let runs: Detail["payload"]["runs"] = [];
let threadMessages: Detail["payload"]["messages"] = [];
const query = vi.fn(),
  mutate = vi.fn(),
  protect = vi.fn(),
  readText = vi.fn(),
  prepareSearch = vi.fn();
const navigate = vi.fn(),
  unauthorized = vi.fn();
function View() {
  model = useThreadControlCenter(options);
  return h(
    Fragment,
    null,
    h("h1", null, model.title),
    model.list,
    model.content,
    model.actions,
    model.details,
    model.settingsData,
  );
}
async function render() {
  const provider = { locale: "zh-CN" as const, loadingLabel: "加载中", children: h(View) };
  await act(async () => {
    root.render(h(ControlCenterIntlProvider, provider));
  });
}

async function refresh() {
  await act(async () => {
    await model.refresh();
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (button) =>
      button.textContent?.trim() === label ||
      button.textContent?.trim() === messages[label as keyof typeof messages] ||
      button.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error("Missing form field");
  const prototype =
    element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function field(label: string) {
  const node = [...document.querySelectorAll("label")].find((item) =>
    item.textContent?.includes(label),
  );
  return node ? (document.getElementById(node.htmlFor) as HTMLInputElement) : null;
}
async function chooseAction(action: string) {
  if (action === "restore") {
    const archives = [...document.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === messages["review.archives"],
    );
    if (!archives) throw new Error("Missing archive settings");
    await act(async () => archives.click());
  } else {
    const menu = container.querySelector<HTMLButtonElement>(".thread-row .action-menu > button");
    if (!menu) throw new Error("Missing conversation menu");
    await act(async () => menu.click());
  }
  await click(`threads.${action}`);
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  thread = summary();
  runs = [];
  threadMessages = [];
  navigate.mockReset();
  unauthorized.mockReset();
  readText.mockReset().mockImplementation(async (ref: string) => ({
    content: ref === "title-ui" ? "组件交互测试" : "已保存的回答",
  }));
  protect
    .mockReset()
    .mockImplementation(async (_text: string, _classification: string, ref: string) => ref);
  prepareSearch.mockReset().mockResolvedValue({
    queryRef: "query-protected",
    tokenRefs: ["opaque-search-token"],
    projectionVersion: "search-v1",
  });
  query.mockReset().mockImplementation(async (request) => {
    const shared = { ...request, kind: "snapshot", payload: undefined };
    switch (request.type) {
      case "thread.list":
        return {
          ...shared,
          type: "thread.collection_snapshot",
          payload: {
            threads: [thread, { ...thread, threadId: "thread-other" }],
            nextCursor: null,
            total: 2,
          },
        };
      case "thread.main":
        return {
          ...shared,
          type: "thread.main_snapshot",
          payload: { thread: { ...thread, threadId: "thread-main" } },
        };
      case "thread.search":
        return {
          ...shared,
          type: "thread.search_snapshot",
          payload: { threads: [thread], nextCursor: null, total: 1 },
        };
      case "thread.detail":
        return {
          ...shared,
          type: "thread.detail_snapshot",
          payload: {
            thread: { ...thread, threadId: request.payload.threadId },
            messages: threadMessages,
            runs,
            nextSequence: null,
          },
        };
      case "thread.checkpoint":
        return {
          ...shared,
          type: "thread.checkpoint_snapshot",
          payload: { threadId: thread.threadId, status: "ready", summaryRef: "checkpoint-summary" },
        };
      case "thread.deletion_impact":
        return {
          ...shared,
          type: "thread.deletion_impact_snapshot",
          payload: {
            deletionAllowed: false,
            associatedTasks: [{ taskId: "task-ui", revision: 3, status: "active" }],
          },
        };
      default:
        throw new Error(`Unexpected UI query: ${request.type}`);
    }
  });
  mutate.mockReset().mockImplementation(async (request) => ({
    kind: "result",
    payload: {
      replayed: false,
      threadId: request.payload.targetThreadId ?? request.payload.threadId ?? thread.threadId,
    },
  }));
  const storage = new ControlCenterBrowserStorage(window.localStorage);
  window.localStorage.clear();
  options = {
    active: true,
    client: {
      queryThread: query,
      mutateThread: mutate,
      protectText: protect,
      readText,
      prepareThreadSearch: prepareSearch,
    } as unknown as GatewayClient,
    configuration,
    connection: "connected",
    message: (id) => id,
    navigate,
    refreshSignal: 0,
    route: { ...routeForSurface("threads"), objectId: "thread-ui" },
    storage,
    onUnauthorized: unauthorized,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(File.prototype, "arrayBuffer");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("thread control center interactions", () => {
  it("opens the main conversation when no conversation is chosen and offers no way to start another", async () => {
    options = { ...options, route: { ...options.route, objectId: null } };
    await render();
    await refresh();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "thread-main", view: "content" }),
    );
    expect(container.textContent).not.toContain(messages["chat.untitled"]);
    expect(
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("新建对话"),
      ),
    ).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("stays on the chosen conversation instead of jumping to the main one", async () => {
    await render();
    await refresh();
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ objectId: "thread-main" }));
  });
  it.each(["zh-CN", "en", "ja"] as const)(
    "does not expose or mutate the legacy %s answer locale in thread details",
    async (answerLocale) => {
      thread = { ...thread, answerLocale };
      await render();
      await refresh();
      expect(container.querySelector(".thread-details")).toBeNull();
      expect(field("threads.answerLocale")).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it("offers no way to branch an answer into a separate conversation", async () => {
    thread = { ...thread, messageWatermark: 1 };
    threadMessages = [
      {
        messageId: "message-answer",
        sequence: 1,
        role: "agent",
        contentRef: "content-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-answer",
        runId: null,
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    await render();
    await refresh();
    expect(container.querySelector(".answer-actions")).not.toBeNull();
    expect(container.querySelectorAll(".answer-actions button")).toHaveLength(1);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("[I-17] shows a branched chat's inherited turns, where it came from, and a way back", async () => {
    const original = query.getMockImplementation();
    const row = (
      sequence: number,
      role: "owner" | "agent",
    ): Detail["payload"]["messages"][number] => ({
      messageId: `source-${sequence}`,
      sequence,
      role,
      contentRef: `source-content-${sequence}`,
      dataClassification: "private",
      status: "committed",
      turnId: `source-turn-${Math.ceil(sequence / 2)}`,
      runId: null,
      committedAt: NOW,
      options: null,
      chosenFrom: null,
    });
    readText.mockImplementation(async (ref: string) => ({
      content: ref === "title-source" ? "原来的对话" : ref,
    }));
    query.mockImplementation(async (request) => {
      if (request.type === "thread.detail" && request.payload.threadId === "thread-source")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.detail_snapshot",
          payload: {
            thread: { ...summary(), threadId: "thread-source", titleRef: "title-source" },
            messages: [row(1, "owner"), row(2, "agent"), row(3, "owner"), row(4, "agent")],
            runs: [],
            nextSequence: null,
          },
        };
      return original?.(request);
    });
    thread = { ...thread, sourceThreadId: "thread-source", sourceWatermark: 2 };
    options = {
      ...options,
      message: (id, values) =>
        values
          ? `${id}(${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ")})`
          : id,
    };
    await render();
    await refresh();
    await act(async () => {
      await Promise.resolve();
    });
    const text = container.querySelector(".chat-scroll")?.textContent ?? "";
    expect(text).toContain("source-content-1");
    expect(text).toContain("source-content-2");
    expect(text).not.toContain("source-content-3");
    expect(container.querySelector(".fork-origin")?.textContent).toContain(
      "fork.banner(title=原来的对话, turn=1)",
    );
    expect(container.querySelector(".fork-divider")?.textContent).toBe("fork.divider");
    expect(container.querySelector(".thread-row .thread-fork-mark")).not.toBeNull();
    await click("fork.openSource");
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ objectId: "thread-source", view: "content" }),
    );
  });
  it("loads every message page, removes overlap, and renders chronological content", async () => {
    const original = query.getMockImplementation();
    const row = (sequence: number): Detail["payload"]["messages"][number] => ({
      messageId: `message-${sequence}`,
      sequence,
      role: "owner",
      contentRef: `content-${sequence}`,
      dataClassification: "private",
      status: "committed",
      turnId: `turn-${sequence}`,
      runId: null,
      committedAt: NOW,
      options: null,
      chosenFrom: null,
    });
    readText.mockImplementation(async (ref: string) => ({ content: ref }));
    query.mockImplementation(async (request, signal) =>
      request.type === "thread.detail"
        ? {
            ...request,
            kind: "snapshot",
            type: "thread.detail_snapshot",
            payload: {
              thread,
              runs: [],
              messages: request.payload.afterSequence === 0 ? [row(2), row(1)] : [row(2), row(3)],
              nextSequence: request.payload.afterSequence === 0 ? 2 : null,
            },
          }
        : original?.(request, signal),
    );
    await render();
    await refresh();
    expect(
      query.mock.calls
        .filter(([r]) => r.type === "thread.detail")
        .map(([r]) => r.payload.afterSequence),
    ).toEqual([0, 2]);
    expect(
      [...container.querySelectorAll(".thread-message-owner pre")].map((node) => node.textContent),
    ).toEqual(["content-1", "content-2", "content-3"]);
  });
  it("stops a non-advancing message cursor and offers recovery instead of looping", async () => {
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) =>
      request.type === "thread.detail"
        ? {
            type: "thread.detail_snapshot",
            payload: { thread, runs: [], messages: [], nextSequence: 2 },
          }
        : original?.(request, signal),
    );
    await render();
    await refresh();
    expect(query.mock.calls.filter(([r]) => r.type === "thread.detail")).toHaveLength(2);
    expect(document.body.textContent).toContain(messages["loading.retry"]);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("uses backend phases and actions, keeps connection loss separate, and refreshes state without new trace", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
      },
    };
    let state: ThreadExecutionState = {
      runRevision: 3,
      revision: "state-1",
      lastObservedAt: NOW,
      displayPhase: "unresolved",
      reasonCode: "EXECUTION_RESULT_UNCONFIRMED",
      availableActions: [],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [
        {
          itemId: "call",
          displayPhase: "unresolved",
          reasonCode: "TOOL_RESULT_UNCONFIRMED",
          lastObservedAt: NOW,
          executionMilliseconds: null,
        },
      ],
      effectSummary: [{ itemId: "call", outcome: "unknown" }],
    };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      if (request.type === "thread.execution")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: "run-ui",
            nextSequence: null,
            generatedAt: NOW,
            records:
              request.payload.afterSequence === 0
                ? [
                    {
                      id: "record",
                      sequence: 1,
                      itemId: "call",
                      kind: "tool",
                      phase: "failed",
                      name: "write",
                      text: "",
                      input: "",
                      output: "Retained output",
                      activity: "",
                      activityIcon: "",
                      occurredAt: NOW,
                    },
                  ]
                : [],
          },
        };
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector(".process-result, .process-live-step")?.textContent).toContain(
      messages["chat.phase.unresolved"],
    );
    expect(container.querySelector(".tool-record .step-status")?.textContent).toContain(
      messages["chat.phase.unresolved"],
    );
    expect(container.querySelector(".execution-next-action")?.textContent).toContain(
      messages["chat.nextAction.unresolved"],
    );
    expect(container.querySelector(".turn-activity .run-indicator")).toBeNull();
    expect(container.querySelector('button[aria-label="停止"]')).toBeNull();
    await input(container.querySelector("textarea"), "Do not submit another Run yet");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.disabled).toBe(
      true,
    );
    options = { ...options, connection: "offline" };
    await render();
    expect(container.querySelector(".process-live-step")?.textContent).toContain(
      messages["chat.phase.unresolved"],
    );
    expect(container.querySelector(".turn-activity")?.textContent).toContain(
      messages["chat.disconnected"],
    );
    options = { ...options, connection: "connected" };
    state = {
      ...state,
      revision: "state-2",
      displayPhase: "preparing",
      availableActions: ["stop"],
    };
    await render();
    await refresh();
    expect(container.querySelector(".process-result, .process-live-step")?.textContent).toContain(
      messages["chat.phase.preparing"],
    );
    expect(
      query.mock.calls.filter(([request]) => request.type === "thread.execution_state").length,
    ).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('button[aria-label="停止"]')).not.toBeNull();
    expect(container.textContent).toContain("Retained output");
    state = {
      ...state,
      revision: "state-reason",
      displayPhase: "not_dispatched",
      reasonCode: "WORKER_DEADLINE_EXCEEDED",
      availableActions: [],
      operations: [
        {
          itemId: "call",
          displayPhase: "not_dispatched",
          reasonCode: "WORKER_DEADLINE_EXCEEDED",
          lastObservedAt: NOW,
          executionMilliseconds: null,
        },
      ],
      effectSummary: [{ itemId: "call", outcome: "not_dispatched" }],
    };
    await render();
    await refresh();
    expect(container.querySelector(".tool-record .step-status")?.textContent).toContain(
      messages["chat.reason.deadlineExceeded"],
    );
    expect(container.querySelector(".execution-next-action")?.textContent).toContain(
      messages["chat.nextAction.notDispatched"],
    );
    const sources: FakeEventSource[] = [];
    stubEventSource(sources);
    options = {
      ...options,
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
        executionEventsAvailable: true,
      },
    };
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const source = sources.at(-1);
    if (!source) throw new Error("Missing execution stream");
    expect(source.url).toContain("/api/gateway/thread/v3/execution-events?subscription=");
    await act(async () => {
      source.open();
      await vi.advanceTimersByTimeAsync(100);
    });
    const idle = query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(query).toHaveBeenCalledTimes(idle);
    state = { ...state, revision: "state-3", reasonCode: "RESOURCE_EXECUTION_OBSERVED" };
    await act(async () => {
      source.emit("thread.execution_changed", executionChanged("run-ui", 3, 1));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector(".process-result, .process-live-step")?.textContent).toContain(
      messages["chat.resource.executing"],
    );
    expect(query.mock.calls.slice(idle).map(([request]) => request.type)).toEqual([
      "thread.execution",
      "thread.execution_state",
    ]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows pushed answer text while the model writes and keeps records read during a detail refresh", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    const sources: FakeEventSource[] = [];
    stubEventSource(sources);
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionEventsAvailable: true,
      },
    };
    const answerRecord = (sequence: number, text: string) => ({
      id: `message-${sequence}`,
      sequence,
      itemId: "message:live",
      kind: "message",
      phase: "updated",
      name: "model",
      text,
      input: "",
      output: "",
      activity: "",
      activityIcon: "",
      occurredAt: NOW,
    });
    let records: ReturnType<typeof answerRecord>[] = [];
    let slowRecords = false;
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution") {
        if (slowRecords) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: "run-ui",
            nextSequence: null,
            generatedAt: NOW,
            records: records.filter((record) => record.sequence > request.payload.afterSequence),
          },
        };
      }
      return original?.(request, signal);
    });
    await render();
    await refresh();
    const source = sources.at(-1);
    if (!source) throw new Error("Missing execution stream");
    await act(async () => {
      source.open();
      await vi.advanceTimersByTimeAsync(100);
    });
    const pushed = (offset: number, text: string) => ({
      ...executionChanged("run-ui", 3, 1),
      type: "thread.execution_text",
      messageId: `execution-text:${offset}`,
      payload: {
        threadId: "thread-ui",
        runId: "run-ui",
        itemId: "message:live",
        offset,
        text,
        emittedAt: null,
        observedAt: "2026-09-14T00:00:00.000Z",
      },
    });
    await act(async () => {
      source.emit("thread.execution_text", pushed(0, "向日葵"));
      source.emit("thread.execution_text", pushed(3, "的一生"));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector(".thread-message-agent")?.textContent).toContain("向日葵的一生");

    records = [answerRecord(1, "向日葵的一生，从种子开始")];
    slowRecords = true;
    for (let revision = 4; revision < 14; revision++) {
      await act(async () => {
        source.emit("thread.execution_changed", executionChanged("run-ui", revision, revision));
        await vi.advanceTimersByTimeAsync(400);
      });
    }
    expect(container.querySelector(".thread-message-agent")?.textContent).toContain(
      "向日葵的一生，从种子开始",
    );
  });

  it("[R2-D3] shows a deadline-ended Run with an unknown tool and no active or cleanup action", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 5,
        status: "failed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
      },
    };
    const state: ThreadExecutionState = {
      runRevision: 5,
      revision: "d3-terminal",
      lastObservedAt: NOW,
      displayPhase: "failed",
      reasonCode: "RUN_EXECUTION_DEADLINE_EXCEEDED",
      availableActions: [],
      needsAttention: true,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [
        {
          itemId: "d3-call",
          displayPhase: "unresolved",
          reasonCode: "TOOL_RESULT_UNCONFIRMED",
          lastObservedAt: NOW,
          executionMilliseconds: null,
        },
      ],
      effectSummary: [{ itemId: "d3-call", outcome: "unknown" }],
    };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      if (request.type === "thread.execution")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: "run-ui",
            nextSequence: null,
            generatedAt: NOW,
            records:
              request.payload.afterSequence === 0
                ? [
                    {
                      id: "d3-record",
                      sequence: 1,
                      itemId: "d3-call",
                      kind: "tool",
                      phase: "failed",
                      name: "uncertain_tool",
                      text: "",
                      input: "",
                      output: "",
                      activity: "",
                      activityIcon: "",
                      occurredAt: NOW,
                    },
                  ]
                : [],
          },
        };
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector(".process-result, .process-live-step")?.textContent).toContain(
      messages["chat.reason.runDeadlineExceeded"],
    );
    expect(container.querySelector(".tool-record .step-status")?.textContent).toContain(
      "结果未确认",
    );
    expect(container.querySelector(".turn-activity")).toBeNull();
    expect(container.querySelectorAll(".execution-next-action button")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/操作已撤销|操作没有发生/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    {
      displayPhase: "failed",
      reasonCode: "RUN_EXECUTION_DEADLINE_EXCEEDED",
      label: "chat.reason.runDeadlineExceeded",
    },
    {
      displayPhase: "stopped",
      reasonCode: "RUN_CANCELLED_RESOURCES_RELEASED",
      label: "chat.phase.stopped",
    },
    {
      displayPhase: "stopped",
      reasonCode: "RUN_STOPPED_NOT_STRICTLY_CONFIRMED",
      label: "chat.resource.stopNotStrictlyConfirmed",
    },
    {
      displayPhase: "not_dispatched",
      reasonCode: "RUN_CANCELLED_BEFORE_DISPATCH",
      label: "chat.phase.notDispatched",
    },
  ] as const)(
    "[R2-S3] shows a $displayPhase Run ($reasonCode) once when its execution state is newer than the turn detail",
    async ({ displayPhase, reasonCode, label }) => {
      runs = [
        {
          runId: "run-ui",
          revision: 4,
          status: "running",
          createdAt: NOW,
          updatedAt: NOW,
          background: null,
          backgroundCommands: [],
        },
      ];
      options = {
        ...options,
        message: (id) => messages[id],
        configuration: {
          ...configuration,
          executionPresentationAvailable: true,
          executionStateAvailable: true,
        },
      };
      const state: ThreadExecutionState = {
        runRevision: 5,
        revision: "s3-terminal",
        lastObservedAt: NOW,
        displayPhase,
        reasonCode,
        availableActions: [],
        needsAttention: true,
        timing: { executionMilliseconds: null, reviewMilliseconds: null },
        operations: [],
        effectSummary: [],
      };
      const original = query.getMockImplementation();
      query.mockImplementation(async (request, signal) => {
        if (request.type === "thread.execution_state")
          return {
            ...request,
            kind: "snapshot",
            type: "thread.execution_state_snapshot",
            payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
          };
        if (request.type === "thread.execution")
          return {
            ...request,
            kind: "snapshot",
            type: "thread.execution_snapshot",
            payload: {
              threadId: "thread-ui",
              runId: "run-ui",
              nextSequence: null,
              generatedAt: NOW,
              records: [],
            },
          };
        return original?.(request, signal);
      });
      await render();
      await refresh();
      expect(container.querySelector(".process-result, .process-live-step")?.textContent).toBe(
        messages[label],
      );
      expect(container.querySelector(".turn-activity")).toBeNull();
      expect(
        [...container.querySelectorAll("*")].filter(
          (element) => element.children.length === 0 && element.textContent === messages[label],
        ),
      ).toHaveLength(1);
    },
  );

  it("[R2-U2] explains which tool a stuck turn waits for, whether the turn continues, and that no background program runs", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 7,
        status: "reconciling_external_result",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    options = {
      ...options,
      message: (id, values) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          messages[id],
        ),
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
        executionEnvironmentAvailable: true,
      },
    };
    let state: ThreadExecutionState = {
      runRevision: 7,
      revision: "u2-waiting",
      lastObservedAt: NOW,
      displayPhase: "unresolved",
      reasonCode: "RESOURCE_STATE_UNCONFIRMED",
      availableActions: ["stop"],
      needsAttention: true,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [
        {
          itemId: "u2-read",
          displayPhase: "unresolved",
          reasonCode: "RESOURCE_STATE_UNCONFIRMED",
          lastObservedAt: NOW,
          executionMilliseconds: null,
        },
      ],
      effectSummary: [{ itemId: "u2-read", outcome: "unknown" }],
    };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_environment")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_environment_snapshot",
          payload: {
            environment: { mode: "srt", programs: [], unavailableTools: [] },
            generatedAt: NOW,
          },
        };
      if (request.type === "thread.execution_state")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      if (request.type === "thread.execution")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: "run-ui",
            nextSequence: null,
            generatedAt: NOW,
            records:
              request.payload.afterSequence === 0
                ? [
                    {
                      id: "u2-record",
                      sequence: 1,
                      itemId: "u2-read",
                      kind: "tool",
                      phase: "updated",
                      name: "read",
                      text: "",
                      input: '{"path":"notes.md"}',
                      output: "",
                      activity: "",
                      activityIcon: "",
                      occurredAt: NOW,
                    },
                  ]
                : [],
          },
        };
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector(".turn-activity .turn-wait-reason")?.textContent).toBe(
      "这一轮还在进行：工具 read 已经交给执行环境，但还没收到它的结果，也没法确认它已经停下。可以继续等，或点停止结束这一轮。",
    );
    expect(container.querySelector('button[aria-label="停止"]')).not.toBeNull();
    expect(
      [...container.querySelectorAll(".environment-line > button")].map(
        (button) => button.textContent,
      ),
    ).toEqual([]);
    expect(container.textContent).not.toContain("没有程序在运行");

    runs = [
      {
        runId: "run-ui",
        revision: 8,
        status: "failed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    state = {
      ...state,
      runRevision: 8,
      revision: "u2-ended",
      availableActions: ["retry_cleanup"],
    };
    await render();
    await refresh();
    expect(container.querySelector(".turn-activity .turn-wait-reason")?.textContent).toBe(
      "这一轮已经结束，但工具 read 的执行环境还没确认已经停下。",
    );
    expect(container.querySelector(".execution-next-action")?.textContent).toBe(
      messages["chat.nextAction.retryCleanup"],
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("adopts an advancing Run without hiding displayed text or reporting a failed conversation", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 5,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
      },
    };
    let state: ThreadExecutionState = {
      runRevision: 5,
      revision: "state-5",
      lastObservedAt: NOW,
      displayPhase: "preparing",
      reasonCode: "EXECUTION_PREPARING",
      availableActions: ["stop"],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [],
      effectSummary: [],
    };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      if (request.type === "thread.execution")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: "run-ui",
            nextSequence: null,
            generatedAt: NOW,
            records:
              request.payload.afterSequence === 0
                ? [
                    {
                      id: "partial-record",
                      sequence: 1,
                      itemId: "assistant-output",
                      kind: "message",
                      phase: "completed",
                      name: "",
                      text: "已经显示的工具回复",
                      input: "",
                      output: "",
                      activity: "",
                      activityIcon: "",
                      occurredAt: NOW,
                    },
                  ]
                : [],
          },
        };
      return original?.(request, signal);
    });
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已经显示的工具回复");
    const initialReads = query.mock.calls.filter(([request]) => request.type === "thread.detail");
    expect(initialReads).toHaveLength(1);
    let releaseBody!: (value: { content: string }) => void;
    const body = new Promise<{ content: string }>((resolve) => {
      releaseBody = resolve;
    });
    readText.mockImplementation(async (ref: string) =>
      ref === "formal-answer" ? body : { content: "组件交互测试" },
    );
    threadMessages = [
      {
        messageId: "assistant-ui",
        sequence: 1,
        role: "agent",
        contentRef: "formal-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-ui",
        runId: "run-ui",
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    state = {
      ...state,
      runRevision: 6,
      revision: "state-6",
      displayPhase: "completed",
      reasonCode: "EXECUTION_COMPLETED",
      availableActions: [],
    };
    await refresh();
    expect.soft(container.textContent).not.toContain(messages["loading.failedConversation"]);
    expect
      .soft(container.querySelector(".assistant-markdown")?.textContent)
      .toBe("已经显示的工具回复");
    expect.soft(readText).toHaveBeenCalledWith("formal-answer");
    expect
      .soft(container.querySelector(".process-result, .process-live-step")?.textContent)
      .toContain(messages["chat.phase.completed"]);
    runs = runs.map((run) => ({ ...run, revision: 6, status: "completed" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect
      .soft(query.mock.calls.filter(([request]) => request.type === "thread.detail"))
      .toHaveLength(2);
    expect.soft(container.textContent).not.toContain(messages["loading.failedConversation"]);
    expect
      .soft(container.querySelector(".process-result, .process-live-step")?.textContent)
      .toContain(messages["chat.phase.completed"]);
    expect
      .soft(container.querySelector(".assistant-markdown")?.textContent)
      .toBe("已经显示的工具回复");
    await act(async () => releaseBody({ content: "正式保存的工具回复" }));
    expect(container.querySelectorAll(".assistant-markdown")).toHaveLength(1);
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("正式保存的工具回复");
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(["thread", "run", "older revision", "read error"])(
    "rejects an invalid backend state but still loads message text (%s)",
    async (mismatch) => {
      runs = [
        {
          runId: "run-ui",
          revision: 3,
          status: "running",
          createdAt: NOW,
          updatedAt: NOW,
          background: null,
          backgroundCommands: [],
        },
      ];
      threadMessages = [
        {
          messageId: "assistant-ui",
          sequence: 1,
          role: "agent",
          contentRef: "formal-answer",
          dataClassification: "private",
          status: "committed",
          turnId: "turn-ui",
          runId: "run-ui",
          committedAt: NOW,
          options: null,
          chosenFrom: null,
        },
      ];
      options = { ...options, configuration: { ...configuration, executionStateAvailable: true } };
      const original = query.getMockImplementation();
      query.mockImplementation(async (request, signal) => {
        if (request.type === "thread.execution_state") {
          if (mismatch === "read error") throw new Error("STATE_READ_FAILED");
          return {
            type: "thread.execution_state_snapshot",
            payload: {
              threadId: mismatch === "thread" ? "other-thread" : "thread-ui",
              runId: mismatch === "run" ? "other-run" : "run-ui",
              state: { runRevision: mismatch === "older revision" ? 2 : 4 },
            },
          };
        }
        return original?.(request, signal);
      });
      await render();
      await refresh();
      expect(readText).toHaveBeenCalledWith("formal-answer");
      expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
      expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(document.body.textContent).toContain(messages["loading.retry"]);
      expect(document.body.textContent).toContain(messages["loading.failedConversation"]);
      expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
      expect(container.querySelector('button[aria-label="停止"]')).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it("[R2-U1] keeps a displayed conversation quiet while a brief state read failure retries", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    threadMessages = [
      {
        messageId: "assistant-ui",
        sequence: 1,
        role: "agent",
        contentRef: "formal-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-ui",
        runId: "run-ui",
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: { ...configuration, executionStateAvailable: true },
    };
    const state: ThreadExecutionState = {
      runRevision: 3,
      revision: "state-3",
      lastObservedAt: NOW,
      displayPhase: "preparing",
      reasonCode: "EXECUTION_PREPARING",
      availableActions: ["stop"],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [],
      effectSummary: [],
    };
    let failuresLeft = 0;
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state") {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error("STATE_READ_FAILED");
        }
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      }
      return original?.(request, signal);
    });
    const stateReads = () =>
      query.mock.calls.filter(([request]) => request.type === "thread.execution_state").length;
    await render();
    await refresh();
    expect(container.querySelector('button[aria-label="停止"]')).not.toBeNull();
    failuresLeft = 2;
    const before = stateReads();
    await refresh();
    expect(stateReads()).toBe(before + 1);
    expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
    expect(document.body.textContent).not.toContain(messages["loading.retry"]);
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    expect(container.querySelector('button[aria-label="停止"]')).not.toBeNull();
    for (let step = 0; step < 20; step++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
      expect(document.body.textContent).not.toContain(messages["loading.slowConversation"]);
    }
    expect(failuresLeft).toBe(0);
    expect(stateReads()).toBeGreaterThanOrEqual(before + 3);
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    expect(container.querySelector('button[aria-label="停止"]')).not.toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("[R2-U1] reports only a persistent conversation refresh failure and keeps the notice steady until recovery", async () => {
    threadMessages = [
      {
        messageId: "assistant-ui",
        sequence: 1,
        role: "agent",
        contentRef: "formal-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-ui",
        runId: "run-ui",
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    await render();
    await refresh();
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    let mode: "fail" | "hold" | "pass" = "fail";
    let release: (() => void) | undefined;
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.detail" && mode === "fail")
        throw new Error("DETAIL_READ_FAILED");
      if (request.type === "thread.detail" && mode === "hold")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return original?.(request, signal);
    });
    const detailReads = () =>
      query.mock.calls.filter(([request]) => request.type === "thread.detail").length;
    const failedShown = () =>
      document.body.textContent?.includes(messages["loading.failedConversation"]) === true;
    const advanceUntilDetailReads = async (count: number) => {
      for (let step = 0; step < 200 && detailReads() < count; step++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      expect(detailReads()).toBe(count);
    };
    const first = detailReads() + 1;
    await refresh();
    expect(detailReads()).toBe(first);
    expect(failedShown()).toBe(false);
    await advanceUntilDetailReads(first + 1);
    expect(failedShown()).toBe(false);
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    await advanceUntilDetailReads(first + 2);
    expect(failedShown()).toBe(true);
    expect(document.body.textContent).toContain(messages["loading.retry"]);
    expect(document.body.textContent).not.toContain(messages["loading.failedList"]);
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    mode = "hold";
    await advanceUntilDetailReads(first + 3);
    expect(failedShown()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(failedShown()).toBe(true);
    expect(document.body.textContent).not.toContain(messages["loading.slowConversation"]);
    expect(document.body.textContent).not.toContain(messages["loading.slowList"]);
    mode = "pass";
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failedShown()).toBe(false);
    expect(document.body.textContent).not.toContain(messages["loading.retry"]);
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows no slow-load notice once the first read has displayed the conversation", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    threadMessages = [
      {
        messageId: "assistant-ui",
        sequence: 1,
        role: "agent",
        contentRef: "formal-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-ui",
        runId: "run-ui",
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: { ...configuration, executionStateAvailable: true },
    };
    const state: ThreadExecutionState = {
      runRevision: 3,
      revision: "state-3",
      lastObservedAt: NOW,
      displayPhase: "preparing",
      reasonCode: "EXECUTION_PREPARING",
      availableActions: ["stop"],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [],
      effectSummary: [],
    };
    const held: (() => void)[] = [];
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state") {
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      }
      return original?.(request, signal);
    });
    await render();
    let firstRead: Promise<void> | undefined;
    await act(async () => {
      firstRead = model.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    expect(held.length).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(document.body.textContent).not.toContain(messages["loading.slowConversation"]);
    expect(document.body.textContent).not.toContain(messages["loading.slowList"]);
    expect(container.querySelector(".thread-load-feedback")).toBeNull();
    expect(container.querySelector(".assistant-markdown")?.textContent).toBe("已保存的回答");
    await act(async () => {
      for (const resolve of held.splice(0)) resolve();
      await firstRead;
    });
  });

  it("[R2-U3] shows a finished tool's result and duration while the Run keeps advancing past the summary", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 5,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
      },
    };
    const state: ThreadExecutionState = {
      runRevision: 6,
      revision: "state-completed",
      lastObservedAt: NOW,
      displayPhase: "completed",
      reasonCode: "EXECUTION_COMPLETED",
      availableActions: [],
      needsAttention: false,
      timing: { executionMilliseconds: 9400, reviewMilliseconds: 9400 },
      operations: [
        {
          itemId: "call",
          displayPhase: "completed",
          reasonCode: "TOOL_SUCCEEDED",
          lastObservedAt: NOW,
          executionMilliseconds: 9400,
        },
      ],
      effectSummary: [{ itemId: "call", outcome: "succeeded" }],
    };
    const records: ThreadExecutionRecord[] = [
      {
        id: "call-result",
        sequence: 2,
        itemId: "call",
        kind: "tool",
        phase: "completed",
        name: "read",
        text: "",
        input: '{"path":"notes.md"}',
        output: "文件内容",
        activity: "",
        activityIcon: "",
        occurredAt: "2026-09-14T00:00:09.400Z",
      },
      {
        id: "call-execution-started",
        sequence: 3,
        itemId: "call",
        kind: "status",
        phase: "updated",
        name: "runtime.tool_execution.started",
        text: "",
        input: "",
        output: "",
        activity: "",
        activityIcon: "",
        occurredAt: NOW,
      },
      {
        id: "call-execution-ended",
        sequence: 4,
        itemId: "call",
        kind: "status",
        phase: "updated",
        name: "runtime.tool_execution.ended",
        text: "",
        input: "",
        output: "",
        activity: "",
        activityIcon: "",
        occurredAt: "2026-09-14T00:00:09.400Z",
      },
    ];
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      if (request.type === "thread.execution")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: "run-ui",
            nextSequence: null,
            generatedAt: NOW,
            records: records.filter((record) => record.sequence > request.payload.afterSequence),
          },
        };
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector(".tool-record .step-status")?.textContent).toContain(
      messages["chat.phase.completed"],
    );
    expect(container.querySelector(".tool-record .step-status")?.textContent).toContain("9.4s");
    expect(container.querySelector(".tool-record")?.textContent).toContain("文件内容");
    expect(container.textContent).not.toContain(messages["loading.failedConversation"]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("[R2-U3] recovers a briefly failing state read without a load notice", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    threadMessages = [
      {
        messageId: "assistant-ui",
        sequence: 1,
        role: "agent",
        contentRef: "formal-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-ui",
        runId: "run-ui",
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: { ...configuration, executionStateAvailable: true },
    };
    const running: ThreadExecutionState = {
      runRevision: 3,
      revision: "state-running",
      lastObservedAt: NOW,
      displayPhase: "preparing",
      reasonCode: "EXECUTION_PREPARING",
      availableActions: ["stop"],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [],
      effectSummary: [],
    };
    const finished: ThreadExecutionState = {
      ...running,
      revision: "state-completed",
      displayPhase: "completed",
      reasonCode: "EXECUTION_COMPLETED",
      availableActions: [],
    };
    let current = running;
    let failuresLeft = 0;
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state") {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw Object.assign(new Error("PORT_NOT_AUTHORITATIVE"), { status: 403 });
        }
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state: current, generatedAt: NOW },
        };
      }
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector(".process-result, .process-live-step")?.textContent).toContain(
      messages["chat.phase.preparing"],
    );
    current = finished;
    failuresLeft = 2;
    await refresh();
    await refresh();
    expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
    await refresh();
    expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
    expect(container.querySelector(".process-result, .process-live-step")?.textContent).toContain(
      messages["chat.phase.completed"],
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("[R2-U3] reports a persistent scope rejection of the state read after repeated failures", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    threadMessages = [
      {
        messageId: "assistant-ui",
        sequence: 1,
        role: "agent",
        contentRef: "formal-answer",
        dataClassification: "private",
        status: "committed",
        turnId: "turn-ui",
        runId: "run-ui",
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    options = {
      ...options,
      message: (id) => messages[id],
      configuration: { ...configuration, executionStateAvailable: true },
    };
    const state: ThreadExecutionState = {
      runRevision: 3,
      revision: "state-running",
      lastObservedAt: NOW,
      displayPhase: "preparing",
      reasonCode: "EXECUTION_PREPARING",
      availableActions: ["stop"],
      needsAttention: false,
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
      operations: [],
      effectSummary: [],
    };
    let failing = false;
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.execution_state") {
        if (failing) throw Object.assign(new Error("HTTP_GATEWAY_SCOPE_REJECTED"), { status: 403 });
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: { threadId: "thread-ui", runId: "run-ui", state, generatedAt: NOW },
        };
      }
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
    failing = true;
    await refresh();
    await refresh();
    expect(document.body.textContent).not.toContain(messages["loading.failedConversation"]);
    await refresh();
    expect(document.body.textContent).toContain(messages["loading.failedConversation"]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("paginates tool records, preserves their input, and resumes from the last confirmed sequence", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 3,
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    options = {
      ...options,
      configuration: { ...configuration, executionPresentationAvailable: true },
    };
    const record = (
      sequence: number,
      phase: ThreadExecutionRecord["phase"],
    ): ThreadExecutionRecord => ({
      id: `execution-${sequence}`,
      sequence,
      itemId: "read-call",
      kind: "tool",
      phase,
      name: "read",
      text: "Read an authorized document",
      input: '{"path":"README.md"}',
      output: phase === "completed" ? "Read complete" : "",
      activity: "",
      activityIcon: "",
      occurredAt: NOW,
    });
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) =>
      request.type === "thread.execution"
        ? {
            ...request,
            kind: "snapshot",
            type: "thread.execution_snapshot",
            payload: {
              threadId: "thread-ui",
              runId: "run-ui",
              records:
                request.payload.afterSequence === 0
                  ? [record(1, "started")]
                  : request.payload.afterSequence === 1
                    ? [record(1, "started"), record(2, "completed")]
                    : [],
              nextSequence: request.payload.afterSequence === 0 ? 1 : null,
              generatedAt: NOW,
            },
          }
        : original?.(request, signal),
    );
    await render();
    await refresh();
    expect(
      query.mock.calls
        .filter(([r]) => r.type === "thread.execution")
        .map(([r]) => r.payload.afterSequence),
    ).toEqual([0, 1]);
    expect(container.querySelectorAll(".tool-record")).toHaveLength(1);
    expect(container.querySelector(".tool-record")?.textContent).toContain("README.md");
    expect(container.querySelector(".tool-record")?.textContent).toContain("Read complete");
    await refresh();
    expect(
      query.mock.calls.filter(([r]) => r.type === "thread.execution").at(-1)?.[0].payload
        .afterSequence,
    ).toBe(2);
    expect(container.querySelectorAll(".tool-record")).toHaveLength(1);
  });
  it.each(["stalled", "wrong-type"])(
    "handles an invalid execution page (%s) without displaying invented progress",
    async (kind) => {
      runs = [
        {
          runId: "run-ui",
          revision: 3,
          status: "completed",
          createdAt: NOW,
          updatedAt: NOW,
          background: null,
          backgroundCommands: [],
        },
      ];
      options = {
        ...options,
        configuration: { ...configuration, executionPresentationAvailable: true },
      };
      const original = query.getMockImplementation();
      query.mockImplementation(async (request, signal) =>
        request.type === "thread.execution"
          ? {
              type:
                kind === "wrong-type" ? "thread.collection_snapshot" : "thread.execution_snapshot",
              payload: { records: [], nextSequence: 0 },
            }
          : original?.(request, signal),
      );
      await render();
      await refresh();
      expect(query.mock.calls.filter(([r]) => r.type === "thread.execution")).toHaveLength(1);
      expect(container.querySelectorAll(".tool-record")).toHaveLength(0);
      expect(document.body.textContent).not.toContain(messages["loading.retry"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(container.querySelectorAll(".tool-record")).toHaveLength(0);
      if (kind === "stalled")
        expect(document.body.textContent).toContain(messages["loading.retry"]);
    },
  );
  it.each(["success", "unauthorized", "unavailable", "wrong-type"])(
    "handles protected search %s through the search form",
    async (result) => {
      options = { ...options, route: routeForSurface("threads") };
      await render();
      await refresh();
      await input(document.querySelector('input[type="search"]'), "天气记录");
      if (result === "unauthorized") query.mockRejectedValueOnce({ status: 401 });
      if (result === "unavailable")
        prepareSearch.mockRejectedValueOnce(new Error("controlled search failure"));
      if (result === "wrong-type")
        query.mockResolvedValueOnce({
          type: "thread.collection_snapshot",
          payload: { threads: [] },
        });
      await act(async () => {
        document
          .querySelector("form.thread-search")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(prepareSearch).toHaveBeenCalledWith("天气记录");
      expect(unauthorized).toHaveBeenCalledTimes(result === "unauthorized" ? 1 : 0);
      if (result === "success") {
        expect(query.mock.calls.at(-1)?.[0]).toMatchObject({
          type: "thread.search",
          payload: {
            queryRef: "query-protected",
            tokenRefs: ["opaque-search-token"],
            statuses: ["active", "archived"],
          },
        });
        expect(JSON.stringify(query.mock.calls.at(-1)?.[0])).not.toContain("天气记录");
      } else {
        expect(document.body.textContent).toContain(messages["loading.retry"]);
      }
    },
  );
  it("[PR631-3] keeps the draft and creates no other conversation when the main conversation cannot be found", async () => {
    options = { ...options, route: routeForSurface("threads") };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.main") throw new Error("controlled main failure");
      return original?.(request, signal);
    });
    await render();
    await refresh();
    await input(container.querySelector("textarea"), "开始新对话");
    await click("threads.send");
    expect(container.textContent).toContain("controlled main failure");
    expect(mutate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("开始新对话");
    expect(options.storage.readDraft("new")).toBe("开始新对话");
  });
  it("[PR634-R3-1] brings the composer back when the main conversation lookup never answers", async () => {
    options = { ...options, route: routeForSurface("threads") };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal: AbortSignal | undefined) => {
      if (request.type === "thread.main")
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("[PR634-R3-3] waits for the settings dialog to close before opening the main conversation", async () => {
    options = { ...options, route: { ...routeForSurface("threads"), page: "settings" } };
    await render();
    await refresh();
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ objectId: "thread-main" }));
    options = { ...options, route: routeForSurface("threads") };
    await render();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "thread-main", view: "content" }),
    );
  });
  it("[PR634-R4-1] gives up a send whose main conversation lookup never answers and keeps the draft", async () => {
    options = { ...options, route: routeForSurface("threads") };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal: AbortSignal | undefined) => {
      if (request.type === "thread.main")
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      return original?.(request, signal);
    });
    await render();
    await refresh();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await input(container.querySelector("textarea"), "超时后再发");
    await click("threads.send");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(container.textContent).toContain("THREAD_READ_DEADLINE_EXCEEDED");
    expect(mutate).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("超时后再发");
    expect(options.storage.readDraft("new")).toBe("超时后再发");
    query.mockImplementation(async (request, signal) => original?.(request, signal));
    await click("threads.send");
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("[PR634-R4-2] hides the composer again while a repeated main conversation lookup is pending", async () => {
    options = { ...options, route: routeForSurface("threads") };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.main") throw new Error("controlled main failure");
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(container.querySelector("textarea")).not.toBeNull();
    let answer: (() => void) | undefined;
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.main") {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
      }
      return original?.(request, signal);
    });
    options = { ...options, configuration: { ...configuration } };
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => answer?.());
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "thread-main", view: "content" }),
    );
  });
  it.each(["archive", "restore", "pin"])(
    "preserves a refused %s operation without falsely reporting acceptance",
    async (operation) => {
      if (operation === "restore") thread = summary("archived");
      mutate.mockRejectedValueOnce("rejected");
      await render();
      await refresh();
      await chooseAction(operation);
      expect(container.textContent).toContain("CONTROL_CENTER_REQUEST_REJECTED");
      expect(navigate).not.toHaveBeenCalled();
    },
  );
  it("loads another history page and retains it through a background refresh", async () => {
    const original = query.getMockImplementation();
    query.mockImplementation(async (request) => {
      if (request.type !== "thread.list") return original?.(request);
      return {
        kind: "snapshot",
        type: "thread.collection_snapshot",
        payload: {
          threads: request.payload.afterCursor
            ? [{ ...thread, threadId: "older-thread" }]
            : [thread],
          nextCursor: request.payload.afterCursor ? null : "page-two",
          total: 2,
        },
      };
    });
    await render();
    await refresh();
    expect(container.querySelector('a[href="/threads/older-thread"]')).toBeNull();
    await click("review.loadMore");
    expect(container.querySelector('a[href="/threads/older-thread"]')).not.toBeNull();
    await refresh();
    expect(container.querySelector('a[href="/threads/older-thread"]')).not.toBeNull();
    expect(query.mock.calls.some(([request]) => request.payload.afterCursor === "page-two")).toBe(
      true,
    );
  });
  it("loads protected titles and persists a draft without sending it", async () => {
    await render();
    await refresh();
    expect(container.querySelector("h1")?.textContent).toBe("组件交互测试");
    await input(container.querySelector("textarea"), "保留草稿");
    expect(options.storage.readDraft(thread.threadId)).toBe("保留草稿");
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "submits a protected message with configured model=%s and clears only an accepted draft",
    async (configured) => {
      if (configured)
        options = {
          ...options,
          configuration: {
            ...configuration,
            primaryModelRef: "model-ui",
            availableModels: [
              {
                ref: "model-ui",
                provider: "fixture",
                model: "fixture-model",
                name: "模型",
                thinkingLevels: ["off", "minimal"],
              },
            ],
          },
        };
      await render();
      await refresh();
      await input(container.querySelector("textarea"), "请继续这个任务");
      const form = container.querySelector("form.composer");
      if (!form) throw new Error("Missing composer");
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(mutate).toHaveBeenCalledOnce();
      const sent = mutate.mock.calls[0]?.[0];
      expect(sent.type).toBe(
        configured ? "thread.message.submit_configured" : "thread.message.submit",
      );
      expect(sent.payload).toMatchObject({
        threadId: "thread-ui",
        expectedRevision: 2,
        sessionId: "session-ui",
        dataClassification: "private",
      });
      if (configured)
        expect(sent.payload).toMatchObject({ modelRef: "model-ui", thinkingLevel: "minimal" });
      expect(JSON.stringify(sent)).not.toContain("请继续这个任务");
      expect(protect.mock.calls.some(([text]) => text === "请继续这个任务")).toBe(true);
      expect(options.storage.readDraft(thread.threadId)).toBe("");
      expect(container.querySelector("textarea")?.value).toBe("");
    },
  );
  it("shows a sent message at once, uploads its parts together and keeps one copy after the server confirms it", async () => {
    await render();
    await refresh();
    await input(container.querySelector("textarea"), "马上显示");
    const releases: Array<() => void> = [];
    protect.mockImplementation(
      (_text: string, _classification: string, ref: string) =>
        new Promise((resolve) => releases.push(() => resolve(ref))),
    );
    await act(async () => {
      container
        .querySelector("form.composer")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("textarea")?.value).toBe("");
    const outgoing = container.querySelector(".chat-turn-outgoing");
    expect(outgoing?.textContent).toContain("马上显示");
    expect(outgoing?.textContent).toContain("message.status.sending");
    expect(protect).toHaveBeenCalledTimes(2);
    expect(mutate).not.toHaveBeenCalled();
    await act(async () => {
      for (const release of releases) release();
    });
    expect(mutate).toHaveBeenCalledOnce();
    const sent = mutate.mock.calls[0]?.[0];
    threadMessages = [
      {
        messageId: sent.payload.messageId,
        sequence: 1,
        role: "owner",
        contentRef: sent.payload.contentRef,
        dataClassification: "private",
        status: "committed",
        turnId: sent.payload.turnId,
        runId: sent.payload.runId,
        committedAt: NOW,
        options: null,
        chosenFrom: null,
      },
    ];
    readText.mockClear();
    await refresh();
    expect(container.querySelector(".chat-turn-outgoing")).toBeNull();
    expect(
      [...container.querySelectorAll(".owner-turn")].filter((item) =>
        item.textContent?.includes("马上显示"),
      ),
    ).toHaveLength(1);
    expect(readText.mock.calls.some(([ref]) => ref === sent.payload.contentRef)).toBe(false);
  });
  it("[UI-16] uploads pasted and dropped files, sends only their references and drops a removed one", async () => {
    const uploaded: string[] = [];
    options = {
      ...options,
      client: {
        ...options.client,
        protectAttachment: vi.fn(async (text: string) => {
          uploaded.push(text);
          return `payload:http:file-${uploaded.length}`;
        }),
      } as unknown as GatewayClient,
    };
    await render();
    await refresh();
    const textarea = container.querySelector("textarea");
    const form = container.querySelector("form.composer");
    if (!textarea || !form) throw new Error("Missing composer");
    await input(textarea, "帮我看看");
    Object.defineProperty(File.prototype, "arrayBuffer", {
      configurable: true,
      value(this: File) {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsArrayBuffer(this);
        });
      },
    });
    const transfer = (name: string, files: File[]) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, name === "paste" ? "clipboardData" : "dataTransfer", {
        value: { files, types: ["Files"] },
      });
      return event;
    };
    await act(async () => {
      textarea.dispatchEvent(transfer("paste", [new File(["a,b\n1,2"], "data.csv")]));
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      form.dispatchEvent(
        transfer("drop", [new File(["笔记"], "notes.md"), new File(["x"], "extra.txt")]),
      );
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(container.querySelector(".attachment-error")).toBeNull();
    expect(
      [...container.querySelectorAll(".attachment-name")].map((item) => item.textContent),
    ).toEqual(["data.csv", "notes.md", "extra.txt"]);
    expect(textarea.value).toBe("帮我看看");
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".attachment-chips button")[2]?.click();
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(uploaded).toEqual(["a,b\n1,2", "笔记", "x"]);
    expect(protect.mock.calls.map(([text]) => text)).toContain(
      '帮我看看\n\n<file name="data.csv" ref="payload:http:file-1" bytes="7" kind="text"/>\n\n<file name="notes.md" ref="payload:http:file-2" bytes="6" kind="text"/>',
    );
    expect(protect.mock.calls.some(([text]) => String(text).includes("笔记"))).toBe(false);
    await act(async () => {
      textarea.dispatchEvent(
        transfer("paste", [new File(["x"], "photo.png", { type: "image/png" })]),
      );
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(container.querySelector(".attachment-error")?.textContent).toBe(
      "chat.attachmentUnsupported",
    );
  });
  it("retries an uncertain send with its original identity and preserves a newer draft after revision changes", async () => {
    await render();
    await refresh();
    await input(container.querySelector("textarea"), "原消息");
    mutate.mockRejectedValueOnce(new Error("response lost"));
    const send = async () =>
      act(async () => {
        container
          .querySelector("form.composer")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    await send();
    const original = mutate.mock.calls[0]?.[0];
    await input(container.querySelector("textarea"), "随后编辑的新草稿");
    thread = { ...thread, revision: 8 };
    await refresh();
    expect(container.textContent).toContain("review.pendingSend");
    await send();
    const retry = mutate.mock.calls[1]?.[0];
    expect(retry.idempotencyKey).toBe(original.idempotencyKey);
    expect(retry.payload).toMatchObject({
      expectedRevision: 2,
      contentRef: original.payload.contentRef,
      messageId: original.payload.messageId,
      runId: original.payload.runId,
    });
    expect(protect.mock.calls.filter(([text]) => text === "原消息")).toHaveLength(2);
    expect(options.storage.readDraft("thread-ui")).toBe("随后编辑的新草稿");
    expect(container.querySelector("textarea")?.value).toBe("随后编辑的新草稿");
    expect(options.storage.readPendingThreadSubmission("thread-ui")).toBeNull();
  });
  it("submits only once for two synchronous gestures and does not overwrite another conversation", async () => {
    await render();
    await refresh();
    await input(container.querySelector("textarea"), "原会话发送");
    let resolve: (value: unknown) => void = () => {};
    mutate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      for (let i = 0; i < 2; i++)
        container
          .querySelector("form.composer")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mutate).toHaveBeenCalledOnce();
    options.storage.saveDraft("thread-other", "另一个会话草稿");
    options = { ...options, route: { ...options.route, objectId: "thread-other" } };
    await render();
    await refresh();
    await act(async () => {
      resolve({ kind: "result", payload: { replayed: false, threadId: "thread-ui" } });
    });
    expect(container.querySelector("textarea")?.value).toBe("另一个会话草稿");
    expect(options.storage.readDraft("thread-other")).toBe("另一个会话草稿");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps unsent content on failed submission and prevents offline sends", async () => {
    await render();
    await refresh();
    await input(container.querySelector("textarea"), "未发送的内容");
    mutate.mockRejectedValue(new Error("controlled request failure"));
    const send = async () => {
      await act(async () => {
        container
          .querySelector("form.composer")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    };
    await send();
    expect(options.storage.readPendingThreadSubmission(thread.threadId)?.content).toBe(
      "未发送的内容",
    );
    expect(container.querySelector(".chat-turn-outgoing")?.textContent).toContain("未发送的内容");
    expect(container.querySelector(".owner-meta-failed")?.textContent).toContain(
      "message.status.failed",
    );
    expect(container.textContent).toContain("controlled request failure");
    mutate.mockClear();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".owner-retry")?.click();
    });
    expect(mutate).toHaveBeenCalledOnce();
    expect(protect.mock.calls.filter(([text]) => text === "未发送的内容")).toHaveLength(2);
    mutate.mockClear();
    options = { ...options, connection: "offline" };
    await render();
    await send();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("[R2-U4] keeps a conversation's send closed until its content has loaded, then sends once", async () => {
    const send = async () => {
      await act(async () => {
        container
          .querySelector("form.composer")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    };
    const sendButton = () => container.querySelector<HTMLButtonElement>("button.send-button");
    await render();
    await input(container.querySelector("textarea"), "刷新后立即发送");
    expect(container.querySelector(".thread-loading-skeleton")).not.toBeNull();
    expect(sendButton()?.disabled).toBe(true);
    await send();
    expect(mutate).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("mutation.pending");
    expect(options.storage.readDraft("thread-ui")).toBe("刷新后立即发送");
    await refresh();
    expect(sendButton()?.disabled).toBe(false);
    await send();
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.message.submit",
      payload: { threadId: "thread-ui", expectedRevision: 2 },
    });
    expect(options.storage.readDraft("thread-ui")).toBe("");
    expect(container.textContent).toContain("mutation.accepted");
  });
  it("[R2-U4] retries an unresolved send only after the conversation's content has loaded", async () => {
    options.storage.savePendingThreadSubmission({
      threadId: "thread-ui",
      revision: 2,
      content: "上次未确认的消息",
    });
    const send = async () => {
      await act(async () => {
        container
          .querySelector("form.composer")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    };
    const sendButton = () => container.querySelector<HTMLButtonElement>("button.send-button");
    await render();
    expect(sendButton()?.getAttribute("aria-label")).toBe("review.retrySend");
    expect(sendButton()?.disabled).toBe(true);
    await send();
    expect(mutate).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("mutation.pending");
    await refresh();
    expect(sendButton()?.disabled).toBe(false);
    await send();
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.message.submit",
      payload: { threadId: "thread-ui", expectedRevision: 2 },
    });
    expect(protect.mock.calls.some(([text]) => text === "上次未确认的消息")).toBe(true);
    expect(options.storage.readPendingThreadSubmission("thread-ui")).toBeNull();
  });
  it.each(["pin", "archive", "restore"] as const)(
    "sends an explicit %s with expected revision",
    async (action) => {
      if (action === "restore") thread = summary("archived");
      await render();
      await refresh();
      await chooseAction(action);
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: `thread.${action}`,
        payload: { threadId: "thread-ui", expectedRevision: 2 },
      });
    },
  );
  it("[UI-9] asks before deleting and sends nothing when the owner cancels", async () => {
    await render();
    await refresh();
    await chooseAction("delete");
    const confirm = container.querySelector(".thread-row-confirming");
    expect(confirm?.textContent).toContain(messages["threads.deleteTitle"]);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(document.activeElement?.className).toContain("action-button-secondary");
    await act(async () =>
      confirm?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(container.querySelector(".thread-row-confirming")).toBeNull();
    await chooseAction("delete");
    expect(mutate).not.toHaveBeenCalled();
    await click("governed.cancel");
    expect(container.querySelector(".thread-row-confirming")).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("[UI-9] moves the conversation to the trash only after the owner confirms", async () => {
    await render();
    await refresh();
    await chooseAction("delete");
    const confirm = container.querySelector<HTMLButtonElement>(
      ".thread-row-confirming .action-button-danger",
    );
    await act(async () => confirm?.click());
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.trash",
      payload: { threadId: "thread-ui", expectedRevision: 2, reasonCode: "owner_requested" },
    });
  });
  it("preserves a conflict and reapplies an owner rename only against the displayed latest revision", async () => {
    await render();
    await refresh();
    await chooseAction("rename");
    const editor = container.querySelector<HTMLInputElement>(".thread-rename-input");
    await input(editor, "自定义标题");
    mutate.mockResolvedValueOnce({
      kind: "conflict",
      payload: { latest: { ...thread, revision: 4 }, reasonCode: "STALE_REVISION" },
    });
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(container.textContent).toContain("threads.conflictTitle");
    expect(mutate.mock.calls[0]?.[0].payload.expectedRevision).toBe(2);
    await click("threads.reapply");
    expect(mutate.mock.calls[1]?.[0].payload.expectedRevision).toBe(4);
    expect(protect.mock.calls.filter(([text]) => text === "自定义标题")).toHaveLength(2);
    expect(container.textContent).not.toContain("threads.conflictTitle");
  });
  it("[UI-B1] renames a conversation in place in the sidebar without opening a dialog", async () => {
    await render();
    await refresh();
    await chooseAction("rename");
    const editor = () => container.querySelector<HTMLInputElement>(".thread-rename-input");
    expect(editor()?.closest(".thread-row")).not.toBeNull();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(editor()?.value).toBe("组件交互测试");
    await input(editor(), "新标题");
    await act(async () =>
      editor()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ type: "thread.rename" });
    expect(protect.mock.calls.some(([text]) => text === "新标题")).toBe(true);
    await act(async () => editor()?.blur());
    expect(mutate.mock.calls.filter(([command]) => command.type === "thread.rename")).toHaveLength(
      1,
    );
  });
  it("[UI-B1] reverse: an unchanged title or Escape sends nothing and closes the editor", async () => {
    await render();
    await refresh();
    await chooseAction("rename");
    const editor = () => container.querySelector<HTMLInputElement>(".thread-rename-input");
    await act(async () =>
      editor()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(editor()).toBeNull();
    await chooseAction("rename");
    await input(editor(), "改了但不要");
    await act(async () =>
      editor()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(editor()).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("[UI-B6] keeps no conversation menu in the top bar, and no more button when there is nothing in it", async () => {
    await render();
    await refresh();
    const menus = [...container.querySelectorAll(".action-menu")];
    expect(menus.length).toBeGreaterThan(0);
    expect(menus.every((menu) => menu.closest(".thread-row"))).toBe(true);
    expect(container.querySelector(".more-button")).toBeNull();
  });
  it("greets the owner in a conversation that has no messages yet instead of a system notice", async () => {
    await render();
    await refresh();
    expect(container.querySelector(".thread-welcome")).not.toBeNull();
    expect(container.textContent).not.toContain("threads.messagesEmpty");
  });
  it("[PR631-3] sends from the welcome page into the main conversation instead of creating another", async () => {
    options = { ...options, route: routeForSurface("threads") };
    const original = query.getMockImplementation();
    let mainQueries = 0;
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.main" && mainQueries++ === 0)
        throw new Error("main not ready yet");
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(navigate).not.toHaveBeenCalled();
    await input(container.querySelector("textarea"), "开始新对话");
    await click("threads.send");
    expect(mutate.mock.calls.map(([request]) => request.type)).not.toContain("thread.create");
    expect(mutate.mock.calls[0]?.[0].payload.threadId).toBe("thread-main");
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "thread-main", view: "content" }),
    );
  });
  it.each(["running", "cancelled", "failed"] as const)(
    "requests cancellation or cleanup for %s using the current run revision",
    async (status) => {
      runs = [
        {
          runId: "run-ui",
          revision: 7,
          status,
          createdAt: NOW,
          updatedAt: NOW,
          background: null,
          backgroundCommands: [],
        },
      ];
      await render();
      await refresh();
      await click(status === "running" ? "chat.stop" : "chat.retryCleanup");
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.run.cancel",
        payload: { runId: "run-ui", expectedRunRevision: 7 },
      });
    },
  );
  it("shows that the cleanup recheck ran and that resources are still unconfirmed", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 7,
        status: "failed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    await render();
    await refresh();
    expect(container.textContent).not.toContain("chat.retryCleanupStillUnconfirmed");
    await click("chat.retryCleanup");
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.run.cancel",
      payload: { runId: "run-ui", expectedRunRevision: 7 },
    });
    expect(container.textContent).toContain("chat.retryCleanupStillUnconfirmed");
  });
  it("REVERSE: does not claim a recheck happened when the stop request itself was rejected", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 7,
        status: "failed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    await render();
    await refresh();
    mutate.mockRejectedValueOnce(new Error("controlled stop failure"));
    await click("chat.retryCleanup");
    expect(mutate).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("chat.retryCleanupStillUnconfirmed");
    expect(container.textContent).not.toContain("chat.retryCleanupChecking");
    expect(container.textContent).toContain("chat.retryCleanup");
  });
  it("offers delete after archive and never queries deletion impact or checkpoint controls", async () => {
    await render();
    await refresh();
    const menu = container.querySelector<HTMLButtonElement>(".thread-row .action-menu > button");
    await act(async () => menu?.click());
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    );
    expect(labels).toEqual([
      messages["threads.rename"],
      messages["threads.pin"],
      messages["threads.archive"],
      messages["threads.delete"],
    ]);
    expect(labels).toHaveLength(4);
    expect(
      query.mock.calls.some(([request]) =>
        ["thread.checkpoint", "thread.deletion_impact"].includes(request.type),
      ),
    ).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("shows a retry after a list failure and reports expired authorization", async () => {
    options = { ...options, route: routeForSurface("threads") };
    const original = query.getMockImplementation();
    let failed = false;
    query.mockImplementation(async (request, signal) => {
      if (request.type === "thread.list" && !failed) {
        failed = true;
        throw { status: 401 };
      }
      return original?.(request, signal);
    });
    await render();
    await refresh();
    expect(unauthorized).toHaveBeenCalledOnce();
    const retry = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(messages["loading.retry"]),
    );
    if (!retry) throw new Error("Missing retry for failed initial list");
    await act(async () => retry.click());
    expect(container.textContent).toContain("组件交互测试");
  });
});

it("[UI-50] shows each message as soon as its own text arrives, newest first, without waiting for the slowest payload", async () => {
  vi.useFakeTimers();
  const row = (sequence: number, role: "owner" | "agent") => ({
    messageId: `message-${sequence}`,
    sequence,
    role,
    contentRef: `content-${sequence}`,
    dataClassification: "private" as const,
    status: "committed" as const,
    turnId: `turn-${Math.ceil(sequence / 2)}`,
    runId: null,
    committedAt: NOW,
    options: null,
    chosenFrom: null,
  });
  threadMessages = [row(1, "owner"), row(2, "agent"), row(3, "owner"), row(4, "agent")];
  const asked: string[] = [];
  readText.mockImplementation(async (ref: string) => {
    asked.push(ref);
    if (ref === "content-2") return new Promise<{ content: string }>(() => undefined);
    return { content: ref === "title-ui" ? "组件交互测试" : `正文 ${ref}` };
  });
  await render();
  await refresh();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120);
  });
  expect(asked.indexOf("content-4")).toBeLessThan(asked.indexOf("content-1"));
  expect(container.textContent).toContain("正文 content-4");
  expect(container.textContent).toContain("正文 content-1");
});

it("keeps an explicit search from being superseded by an already scheduled list refresh", async () => {
  vi.useFakeTimers();
  options = { ...options, route: routeForSurface("threads") };
  await render();
  await refresh();

  let resolveSearch!: (value: {
    queryRef: string;
    tokenRefs: string[];
    projectionVersion: string;
  }) => void;
  prepareSearch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
  );
  await input(document.querySelector('input[type="search"]'), "天气记录");
  await act(async () => {
    document
      .querySelector("form.thread-search")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  await act(async () => {
    resolveSearch({
      queryRef: "query-protected",
      tokenRefs: ["opaque-search-token"],
      projectionVersion: "search-v1",
    });
  });
  expect(query.mock.calls.filter(([request]) => request.type === "thread.search")).toHaveLength(1);
  expect(document.querySelectorAll(".thread-search-results li")).toHaveLength(1);
  expect(container.querySelectorAll(".thread-row")).toHaveLength(0);
  await input(document.querySelector('input[type="search"]'), "");
  expect(document.querySelectorAll(".thread-search-results li")).toHaveLength(0);
  expect(container.querySelectorAll(".thread-row")).toHaveLength(2);
});

describe("pushed conversation updates", () => {
  const message = (sequence: number) => ({
    messageId: `message-${sequence}`,
    sequence,
    role: "agent" as const,
    contentRef: `content-${sequence}`,
    dataClassification: "private" as const,
    status: "committed" as const,
    turnId: `turn-${sequence}`,
    runId: null,
    committedAt: NOW,
    options: null,
    chosenFrom: null,
  });
  const executionState = (runRevision: number, revision: string): ThreadExecutionState => ({
    runRevision,
    revision,
    lastObservedAt: NOW,
    displayPhase: statePhase,
    reasonCode: "RUN_COMPLETED",
    availableActions: [],
    needsAttention: false,
    timing: { executionMilliseconds: null, reviewMilliseconds: null },
    operations: [],
    effectSummary: [],
  });
  let sources: FakeEventSource[];
  let queue: (string | null)[];
  let signal: number;
  let statePhase: ThreadExecutionState["displayPhase"];

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    statePhase = "completed";
    sources = [];
    queue = [];
    signal = 0;
    stubEventSource(sources);
    runs = [
      {
        runId: "run-1",
        revision: 4,
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    threadMessages = [message(1), message(2)];
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, abort) => {
      if (request.type === "thread.detail")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.detail_snapshot",
          payload: {
            thread: { ...thread, threadId: request.payload.threadId },
            messages: threadMessages.filter(
              (item) => item.sequence > request.payload.afterSequence,
            ),
            runs,
            nextSequence: null,
          },
        };
      if (request.type === "thread.execution")
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: request.payload.runId,
            records: [],
            nextSequence: null,
            generatedAt: NOW,
          },
        };
      if (request.type === "thread.execution_state") {
        const run = runs.find((item) => item.runId === request.payload.runId);
        return {
          ...request,
          kind: "snapshot",
          type: "thread.execution_state_snapshot",
          payload: {
            threadId: "thread-ui",
            runId: request.payload.runId,
            state: executionState(run?.revision ?? 1, `state-${run?.revision ?? 1}`),
            generatedAt: NOW,
          },
        };
      }
      return original?.(request, abort);
    });
    options = {
      ...options,
      configuration: {
        ...configuration,
        executionPresentationAvailable: true,
        executionStateAvailable: true,
        executionEventsAvailable: true,
      },
      threadEvents: { current: queue },
    };
  });

  async function settle(milliseconds = 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  }
  async function threadEvent(threadId: string | null) {
    queue.push(threadId);
    options = { ...options, threadEventSignal: ++signal };
    await render();
    await settle();
  }
  const requested = (from: number) =>
    query.mock.calls.slice(from).map(([request]) => ({
      type: request.type,
      payload: request.payload,
    }));

  it("reads nothing while an opened conversation is idle", async () => {
    await render();
    await settle();
    sources.at(-1)?.open();
    await settle();
    const idle = query.mock.calls.length;
    await settle(30_000);
    expect(query).toHaveBeenCalledTimes(idle);
  });

  it("reads only new messages of the opened conversation and only the list for another one", async () => {
    await render();
    await settle();
    let from = query.mock.calls.length;
    await threadEvent("thread-other");
    expect(requested(from).map(({ type }) => type)).toEqual(["thread.list"]);
    threadMessages = [message(1), message(2), message(3)];
    runs = [
      ...runs,
      {
        runId: "run-2",
        revision: 1,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    from = query.mock.calls.length;
    await threadEvent("thread-ui");
    const reads = requested(from);
    expect(reads.map(({ type }) => type)).toEqual([
      "thread.list",
      "thread.detail",
      "thread.execution",
      "thread.execution_state",
    ]);
    expect(reads[1]?.payload).toMatchObject({ threadId: "thread-ui", afterSequence: 2 });
    expect(reads[2]?.payload).toMatchObject({ runId: "run-2" });
  });

  it("opens the execution stream only while a Run of the conversation is live", async () => {
    await render();
    await settle();
    expect(sources.filter((source) => source.url.includes("execution-events"))).toHaveLength(0);
    runs = [{ ...runs[0], revision: 5, status: "running" } as Detail["payload"]["runs"][number]];
    await threadEvent("thread-ui");
    const live = sources.filter((source) => source.url.includes("execution-events"));
    expect(live).toHaveLength(1);
    runs = [{ ...runs[0], revision: 6, status: "completed" } as Detail["payload"]["runs"][number]];
    await threadEvent("thread-ui");
    expect(live[0]?.closed).toBe(true);
  });

  it("keeps the execution stream open while a finished Run still has an unresolved result", async () => {
    statePhase = "unresolved";
    await render();
    await settle();
    expect(sources.filter((source) => source.url.includes("execution-events"))).toHaveLength(1);
  });

  it("re-reads the conversation when an execution event carries a newer Run revision", async () => {
    runs = [{ ...runs[0], status: "running" } as Detail["payload"]["runs"][number]];
    await render();
    await settle();
    const source = sources.at(-1);
    if (!source) throw new Error("Missing execution stream");
    source.open();
    await settle();
    runs = [{ ...runs[0], revision: 5 } as Detail["payload"]["runs"][number]];
    const from = query.mock.calls.length;
    await act(async () => {
      source.emit("thread.execution_changed", executionChanged("run-1", 5, 9));
    });
    await settle();
    const types = requested(from).map(({ type }) => type);
    expect(types).toContain("thread.detail");
    expect(types.filter((type) => type === "thread.execution_state").length).toBeGreaterThan(0);
  });

  it("catches up every Run after the execution stream reconnects", async () => {
    runs = [{ ...runs[0], status: "running" } as Detail["payload"]["runs"][number]];
    await render();
    await settle();
    const first = sources.at(-1);
    if (!first) throw new Error("Missing execution stream");
    first.open();
    await settle();
    first.fail();
    expect(first.closed).toBe(true);
    await settle(300);
    const second = sources.at(-1);
    expect(second).not.toBe(first);
    const from = query.mock.calls.length;
    second?.open();
    await settle();
    expect(requested(from).map(({ type }) => type)).toEqual([
      "thread.execution",
      "thread.execution_state",
    ]);
  });

  it("approves both parallel search approvals of one step with one click and then shows the finished answer", async () => {
    const approvalFixture = (id: string, status: "pending" | "approved") => ({
      schemaVersion: "gateway.v2",
      kind: "snapshot",
      messageId: `snapshot-${id}`,
      correlationId: "correlation",
      causationId: null,
      dataClassification: "private",
      risk: "medium",
      authorizationRef: null,
      scope: { ownerId: "owner-ui", agentId: "agent-ui" },
      authority: { deploymentId: "deployment-ui", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "system", actorId: "system" },
      type: "approval.snapshot",
      payload: {
        approvalRequestId: id,
        revision: status === "pending" ? 1 : 2,
        status,
        deliveryState: "deliverable",
        semanticSnapshotHash: `hash-${id}`,
        finalRisk: "medium",
        recentAuthenticationRequired: false,
        recentAuthenticationRef: null,
        requestedAt: NOW,
        expiresAt: "2099-01-01T00:00:00.000Z",
        decidedAt: null,
        grantId: null,
        display: null,
        trueResultRef: null,
        generatedAt: NOW,
        intent: {
          intentId: id,
          threadId: "thread-ui",
          runId: "run-1",
          actionKind: "COMMUNICATE",
          capabilityRef: "search.web_search",
          capabilityVersion: "1",
          operation: "web_search",
          targetRefs: ["target"],
          resourceRefs: ["target"],
          dataClassification: "private",
          disclosure: "named_recipients",
          recipientRefs: ["https://search.example"],
          sideEffect: "none",
          estimatedCostMicros: 0,
          frequency: { count: 1, intervalMs: null },
          credentialOrAccessChange: false,
          reversible: false,
          idempotencyKey: id,
          deterministicFactCodes: [],
          modelReasonCode: "controlled",
          requestedAt: NOW,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    });
    const approvals = new Map<string, "pending" | "approved">([
      ["approval-a", "pending"],
      ["approval-b", "pending"],
    ]);
    runs = [
      { ...runs[0], revision: 3, status: "awaiting_approval" } as Detail["payload"]["runs"][number],
    ];
    const gatewayQuery = vi.fn(
      async (request: { type: string; payload: Record<string, unknown> }) => {
        if (request.type === "approval.list")
          return {
            type: "collection.snapshot",
            payload: {
              category: "approvals",
              itemRefs: [...approvals].filter(([, s]) => s === "pending").map(([id]) => id),
              nextCursor: null,
            },
          };
        if (request.type === "approval.detail") {
          const id = String(request.payload["approvalRequestId"]);
          return approvalFixture(id, approvals.get(id) ?? "approved");
        }
        if (request.type === "search.authorization.read")
          return {
            type: "search.authorization.snapshot",
            payload: { enabled: true, recipients: ["https://search.example"], revision: 2 },
          };
        throw new Error(`Unexpected gateway query ${request.type}`);
      },
    );
    const gatewayMutate = vi.fn(
      async (request: { type: string; payload: Record<string, unknown> }) => {
        approvals.set(String(request.payload["approvalRequestId"]), "approved");
        return { status: "accepted" };
      },
    );
    options = {
      ...options,
      message: (id, values) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replace(`{${key}}`, String(value)),
          messages[id] as string,
        ),
      client: {
        ...options.client,
        query: gatewayQuery,
        mutate: gatewayMutate,
      } as unknown as GatewayClient,
      configuration: {
        ...options.configuration,
        authorizationRef: "authorization-ui",
      } as ControlCenterRuntimeConfiguration,
    };
    let gatewaySignal = 0;
    const gatewayChanged = async () => {
      options = { ...options, refreshSignal: ++gatewaySignal };
      await render();
      await settle();
    };
    await render();
    await settle();
    const stream = sources.filter((source) => source.url.includes("execution-events")).at(-1);
    if (!stream) throw new Error("Missing execution stream");
    stream.open();
    await settle();
    expect(container.querySelector(".approval-inline")?.textContent).toContain(
      messages["chat.approval.searchBatch"].replace("{count}", "2"),
    );
    await click("chat.search.enable");
    await settle();
    expect(
      gatewayMutate.mock.calls.map(([request]) => request.payload["approvalRequestId"]),
    ).toEqual(["approval-a", "approval-b"]);
    await gatewayChanged();
    expect(container.querySelector(".approval-inline button")).toBeNull();
    expect(container.querySelector(".approval-inline")?.textContent).toContain(
      messages["chat.approval.continuing"],
    );
    runs = [{ ...runs[0], revision: 4, status: "running" } as Detail["payload"]["runs"][number]];
    await act(async () =>
      stream.emit("thread.execution_changed", executionChanged("run-1", 4, 53)),
    );
    await settle();
    runs = [{ ...runs[0], revision: 6, status: "completed" } as Detail["payload"]["runs"][number]];
    await act(async () =>
      stream.emit("thread.execution_changed", executionChanged("run-1", 6, 100)),
    );
    await settle(1000);
    expect(container.querySelector(".approval-inline")).toBeNull();
  });

  it("recovers on its own when one conversation read never answers", async () => {
    runs = [
      { ...runs[0], revision: 5, status: "awaiting_approval" } as Detail["payload"]["runs"][number],
    ];
    await render();
    await settle();
    const stream = sources.filter((source) => source.url.includes("execution-events")).at(-1);
    if (!stream) throw new Error("Missing execution stream");
    stream.open();
    await settle();
    const answering = query.getMockImplementation();
    let hung = 0;
    query.mockImplementation(async (request, abort?: AbortSignal) => {
      if (request.type === "thread.detail" && hung === 0) {
        hung += 1;
        return new Promise((_resolve, reject) =>
          abort?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
      }
      return answering?.(request, abort);
    });
    runs = [{ ...runs[0], revision: 6, status: "running" } as Detail["payload"]["runs"][number]];
    await act(async () =>
      stream.emit("thread.execution_changed", executionChanged("run-1", 6, 61)),
    );
    await settle();
    expect(hung).toBe(1);
    runs = [{ ...runs[0], revision: 8, status: "completed" } as Detail["payload"]["runs"][number]];
    await act(async () =>
      stream.emit("thread.execution_changed", executionChanged("run-1", 8, 100)),
    );
    await settle(20_000);
    const shown = query.mock.calls.filter(([request]) => request.type === "thread.detail").length;
    expect(shown).toBeGreaterThan(2);
    expect(container.querySelector(".approval-inline")).toBeNull();
  });

  it("closes the execution stream when the conversation changes", async () => {
    runs = [{ ...runs[0], status: "running" } as Detail["payload"]["runs"][number]];
    await render();
    await settle();
    const first = sources.at(-1);
    options = { ...options, route: { ...options.route, objectId: "thread-other" } };
    await render();
    await settle();
    expect(first?.closed).toBe(true);
    expect(sources.at(-1)?.url).not.toBe(first?.url);
  });

  it("[I-38] reads new execution records while an earlier state read is still waiting", async () => {
    runs = [{ ...runs[0], status: "running" } as Detail["payload"]["runs"][number]];
    await render();
    await settle();
    const source = sources.at(-1);
    if (!source) throw new Error("Missing execution stream");
    source.open();
    await settle();
    const answering = query.getMockImplementation();
    let releaseState: () => void = () => {};
    const stateGate = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    query.mockImplementation(async (request, abort) => {
      if (request.type === "thread.execution_state") await stateGate;
      return answering?.(request, abort);
    });
    const from = query.mock.calls.length;
    await act(async () => {
      source.emit("thread.execution_changed", executionChanged("run-1", 4, 20));
    });
    await settle();
    await act(async () => {
      source.emit("thread.execution_changed", executionChanged("run-1", 4, 21));
    });
    await settle();
    const types = requested(from).map(({ type }) => type);
    expect(types.filter((type) => type === "thread.execution").length).toBe(2);
    expect(types.filter((type) => type === "thread.execution_state").length).toBe(1);
    releaseState();
    await settle();
  });
});

describe("more panel", () => {
  const command = {
    taskRef: "background-command:aaaaaaaaaaaaaaaaaaaaaaaa",
    commandRef: "command-ref",
    outputRef: null,
    startedAt: NOW,
    deadlineAt: "2026-09-14T00:30:00Z",
    endedAt: null,
    outcome: null,
    noticeRunId: null,
  };
  const agentMessage = (runId: string, sequence: number, role: "owner" | "agent" | "system") => ({
    messageId: `message-${runId}-${role}`,
    sequence,
    role,
    contentRef: `content-${runId}-${role}`,
    dataClassification: "private" as const,
    status: "committed" as const,
    turnId: `turn-${runId}`,
    runId,
    committedAt: NOW,
    options: null,
    chosenFrom: null,
  });
  const panelText = () => container.querySelector(".more-panel")?.textContent ?? "";

  it("[BG-9] counts running commands on the More button, opens the command from the answer line and stops it without asking", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 7,
        status: "running",
        createdAt: NOW,
        updatedAt: NOW,
        background: { count: 1, startedAt: NOW, deadlineAt: command.deadlineAt },
        backgroundCommands: [command],
      },
    ];
    threadMessages = [agentMessage("run-ui", 1, "owner"), agentMessage("run-ui", 2, "agent")];
    readText.mockImplementation(async (ref: string) => ({
      content: ref === "command-ref" ? "npm test" : "已保存的回答",
    }));
    await render();
    await refresh();
    expect(container.querySelector(".more-count")?.textContent).toBe("1");
    expect(container.querySelector(".more-panel")).toBeNull();
    const line = container.querySelector<HTMLButtonElement>(".background-line");
    expect(line?.textContent).toContain("more.line.running");
    await act(async () => line?.click());
    expect(container.querySelector(".more-title")?.textContent).toBe("npm test");
    expect(panelText()).toContain("more.detail.outputLater");
    const stop = container.querySelector<HTMLButtonElement>(".more-panel .more-stop");
    await act(async () => stop?.click());
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "thread.run.cancel",
      payload: { runId: "run-ui", expectedRunRevision: 7 },
    });
    expect(container.querySelector(".more-panel .more-stop")).toBeNull();
    expect(line?.textContent).toContain("more.line.stopping");
    await click("common.back");
    expect(panelText()).toContain("more.section.running");
    expect(panelText()).toContain("more.stopping");
    await click("common.close");
    expect(container.querySelector(".more-panel")).toBeNull();
  });

  it("[BG-9] shows the finished command's last output lines and jumps to the report turn", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 8,
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [
          {
            ...command,
            outputRef: "output-ref",
            endedAt: "2026-09-14T00:08:12Z",
            outcome: "completed",
            noticeRunId: "run-notice",
          },
        ],
      },
      {
        runId: "run-notice",
        revision: 2,
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    threadMessages = [
      agentMessage("run-ui", 1, "owner"),
      agentMessage("run-ui", 2, "agent"),
      agentMessage("run-notice", 3, "system"),
      agentMessage("run-notice", 4, "agent"),
    ];
    readText.mockImplementation(async (ref: string) => ({
      content:
        ref === "command-ref" ? "npm test" : ref === "output-ref" ? "Tests 42 passed" : "回答",
    }));
    await render();
    await refresh();
    expect(container.querySelector(".more-count")).toBeNull();
    expect(container.querySelector(".background-report")?.textContent).toContain(
      "more.report.completed",
    );
    await click("more.label");
    expect(panelText()).toContain("more.section.finished");
    expect(panelText()).not.toContain("more.section.running");
    const row = container.querySelector<HTMLButtonElement>(".more-panel .more-row");
    await act(async () => row?.click());
    expect(container.querySelector(".more-output")?.textContent).toBe("Tests 42 passed");
    await click("more.report");
    const report = container.querySelector<HTMLElement>('.chat-turn[data-run-id="run-notice"]');
    expect(report?.scrollIntoView).toHaveBeenCalled();
    expect(report?.classList.contains("is-flash")).toBe(true);
  });

  it("[BG-9] hides the More button while the conversation has no files and no background commands", async () => {
    runs = [
      {
        runId: "run-ui",
        revision: 7,
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW,
        background: null,
        backgroundCommands: [],
      },
    ];
    await render();
    await refresh();
    expect(container.querySelector(".more-button")).toBeNull();
  });
});
