// @vitest-environment jsdom

import type {
  ThreadExecutionRecord,
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
  messageWatermark: 0,
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
  return h(Fragment, null, h("h1", null, model.title), model.list, model.content, model.details);
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
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label || button.getAttribute("aria-label") === label,
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
  const node = [...container.querySelectorAll("label")].find((item) =>
    item.textContent?.includes(label),
  );
  return node ? (document.getElementById(node.htmlFor) as HTMLInputElement) : null;
}
beforeEach(() => {
  // These component tests invoke refresh explicitly. Keep the independent SSE
  // debounce clock controlled so it cannot replace a search during assertions.
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
          payload: { thread, messages: threadMessages, runs, nextSequence: null },
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("thread control center interactions", () => {
  it.each(["zh-CN", "en", "ja"] as const)(
    "does not expose or mutate the legacy %s answer locale in thread details",
    async (answerLocale) => {
      thread = { ...thread, answerLocale };
      await render();
      await refresh();
      expect(container.querySelector(".thread-details")).not.toBeNull();
      expect(field("threads.answerLocale")).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it.each(["zh-CN", "en", "ja"] as const)(
    "forks a committed turn without propagating the legacy %s answer locale",
    async (answerLocale) => {
      thread = { ...thread, answerLocale, messageWatermark: 1 };
      threadMessages = [
        {
          messageId: "message-fork",
          sequence: 1,
          role: "agent",
          contentRef: "content-fork",
          dataClassification: "private",
          status: "committed",
          turnId: "turn-fork",
          runId: null,
          committedAt: NOW,
        },
      ];
      await render();
      await refresh();
      await click("threads.fork");
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.fork",
        payload: {
          sourceThreadId: thread.threadId,
          sourceTurnId: "turn-fork",
          sourceWatermark: 1,
          policyRefs: [],
        },
      });
    },
  );
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
    expect(container.textContent).toContain(messages["loading.retry"]);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("paginates tool records, preserves their input, and resumes from the last confirmed sequence", async () => {
    runs = [{ runId: "run-ui", revision: 3, status: "completed", createdAt: NOW, updatedAt: NOW }];
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
        { runId: "run-ui", revision: 3, status: "completed", createdAt: NOW, updatedAt: NOW },
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
      if (kind === "stalled") expect(container.textContent).toContain(messages["loading.retry"]);
    },
  );
  it.each(["success", "unauthorized", "unavailable", "wrong-type"])(
    "handles protected search %s through the search form",
    async (result) => {
      options = { ...options, route: routeForSurface("threads") };
      await render();
      await refresh();
      await input(container.querySelector('input[type="search"]'), "天气记录");
      if (result === "unauthorized") query.mockRejectedValueOnce({ status: 401 });
      if (result === "unavailable")
        prepareSearch.mockRejectedValueOnce(new Error("controlled search failure"));
      if (result === "wrong-type")
        query.mockResolvedValueOnce({
          type: "thread.collection_snapshot",
          payload: { threads: [] },
        });
      await act(async () => {
        container
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
        expect(container.textContent).toContain(messages["loading.retry"]);
      }
    },
  );
  it("keeps the welcome page available when creating a conversation fails", async () => {
    options = { ...options, route: routeForSurface("threads") };
    mutate.mockRejectedValueOnce(new Error("controlled creation failure"));
    await render();
    await refresh();
    await click("chat.start");
    expect(container.textContent).toContain("controlled creation failure");
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("chat.start");
  });
  it.each(["archive", "restore", "pin"])(
    "preserves a refused %s operation without falsely reporting acceptance",
    async (operation) => {
      if (operation === "restore") thread = summary("archived");
      mutate.mockRejectedValueOnce("rejected");
      await render();
      await refresh();
      await click(`threads.${operation}`);
      expect(container.textContent).toContain("CONTROL_CENTER_REQUEST_REJECTED");
      expect(navigate).not.toHaveBeenCalled();
    },
  );
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
        expect(sent.payload).toMatchObject({ modelRef: "model-ui", thinkingLevel: "off" });
      expect(JSON.stringify(sent)).not.toContain("请继续这个任务");
      expect(protect.mock.calls.some(([text]) => text === "请继续这个任务")).toBe(true);
      expect(options.storage.readDraft(thread.threadId)).toBe("");
      expect(container.querySelector("textarea")?.value).toBe("");
    },
  );
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
    expect(options.storage.readDraft(thread.threadId)).toBe("未发送的内容");
    expect(container.textContent).toContain("controlled request failure");
    options = { ...options, connection: "offline" };
    await render();
    await send();
    expect(mutate).toHaveBeenCalledOnce();
  });
  it.each(["pin", "archive", "restore", "trash"] as const)(
    "sends an explicit %s with expected revision",
    async (action) => {
      if (action === "restore") thread = summary("archived");
      await render();
      await refresh();
      if (action === "trash") {
        query.mockResolvedValueOnce({
          type: "thread.deletion_impact_snapshot",
          payload: { deletionAllowed: true, associatedTasks: [] },
        });
        await click("threads.inspectDeletion");
      }
      await click(`threads.${action}`);
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: `thread.${action}`,
        payload: { threadId: "thread-ui", expectedRevision: 2 },
      });
    },
  );
  it("preserves a conflict and reapplies an owner rename only against the displayed latest revision", async () => {
    await render();
    await refresh();
    await input(field("threads.rename"), "自定义标题");
    mutate.mockResolvedValueOnce({
      kind: "conflict",
      payload: { latest: { ...thread, revision: 4 }, reasonCode: "STALE_REVISION" },
    });
    await click("threads.rename");
    expect(container.textContent).toContain("threads.conflictTitle");
    expect(mutate.mock.calls[0]?.[0].payload.expectedRevision).toBe(2);
    await click("threads.reapply");
    expect(mutate.mock.calls[1]?.[0].payload.expectedRevision).toBe(4);
    expect(protect.mock.calls.filter(([text]) => text === "自定义标题")).toHaveLength(2);
    expect(container.textContent).not.toContain("threads.conflictTitle");
  });
  it("creates a conversation from the empty welcome page and navigates to the accepted ID", async () => {
    options = { ...options, route: routeForSurface("threads") };
    await render();
    await refresh();
    await click("chat.start");
    expect(mutate.mock.calls[0]?.[0].type).toBe("thread.create");
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: mutate.mock.calls[0]?.[0].payload.threadId,
        view: "content",
      }),
    );
  });
  it.each(["running", "cancelled", "failed"] as const)(
    "requests cancellation or cleanup for %s using the current run revision",
    async (status) => {
      runs = [{ runId: "run-ui", revision: 7, status, createdAt: NOW, updatedAt: NOW }];
      await render();
      await refresh();
      await click(status === "running" ? "chat.stop" : "chat.retryCleanup");
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.run.cancel",
        payload: { runId: "run-ui", expectedRunRevision: 7 },
      });
    },
  );
  it.each(["pause", "cancel", "rebind"] as const)(
    "inspects deletion dependencies before explicitly choosing %s",
    async (action) => {
      await render();
      await refresh();
      await click("threads.checkpoint");
      expect(container.textContent).toContain("checkpoint-summary");
      await click("threads.inspectDeletion");
      expect(container.textContent).toContain("task-ui");
      expect(mutate).not.toHaveBeenCalled();
      await click(`deletion.${action}Task`);
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.task.resolve",
        payload: {
          threadId: "thread-ui",
          taskId: "task-ui",
          expectedTaskRevision: 3,
          action,
          targetThreadId: action === "rebind" ? "thread-other" : null,
        },
      });
    },
  );
  it("shows a retry after a list failure and reports expired authorization", async () => {
    options = { ...options, route: routeForSurface("threads") };
    query.mockRejectedValueOnce({ status: 401 });
    await render();
    await refresh();
    expect(unauthorized).toHaveBeenCalledOnce();
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(messages["loading.retry"]),
    );
    if (!retry) throw new Error("Missing retry for failed initial list");
    await act(async () => retry.click());
    expect(container.textContent).toContain("组件交互测试");
  });
});

it("keeps an explicit search from being superseded by an already scheduled list refresh", async () => {
  vi.useFakeTimers();
  options = { ...options, route: routeForSurface("threads") };
  await render();
  await refresh();
  const before = query.mock.calls.filter(([request]) => request.type === "thread.list").length;
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
  await input(container.querySelector('input[type="search"]'), "天气记录");
  await act(async () => {
    container
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
  expect(query.mock.calls.filter(([request]) => request.type === "thread.list")).toHaveLength(
    before,
  );
});
