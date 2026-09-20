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
  return h(
    Fragment,
    null,
    h("h1", null, model.title),
    model.list,
    model.content,
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("thread control center interactions", () => {
  it("opens a local new-chat draft before configuration or realtime is ready", async () => {
    options = { ...options, client: undefined, configuration: undefined, connection: "connecting" };
    await render();
    await click("新建对话");
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: null, view: "content" }),
    );
    expect(mutate).not.toHaveBeenCalled();
    options = { ...options, route: { ...options.route, objectId: null } };
    await render();
    expect(container.querySelector("textarea")).not.toBeNull();
    await input(container.querySelector("textarea"), "初始化期间的草稿");
    expect(options.storage.readDraft("new")).toBe("初始化期间的草稿");
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
    expect(document.body.textContent).toContain(messages["loading.retry"]);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("uses backend phases and actions, keeps connection loss separate, and refreshes state without new trace", async () => {
    runs = [{ runId: "run-ui", revision: 3, status: "running", createdAt: NOW, updatedAt: NOW }];
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
    expect(container.querySelector(".process-result")?.textContent).toContain(
      messages["chat.phase.unresolved"],
    );
    expect(container.querySelector(".tool-record .step-status")?.textContent).toContain(
      messages["chat.phase.unresolved"],
    );
    expect(container.querySelector(".turn-activity .run-indicator")).toBeNull();
    expect(container.querySelector('button[aria-label="停止"]')).toBeNull();
    await input(container.querySelector("textarea"), "Do not submit another Run yet");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.disabled).toBe(
      true,
    );
    options = { ...options, connection: "offline" };
    await render();
    expect(container.querySelector(".turn-activity strong")?.textContent).toContain(
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
    expect(container.querySelector(".process-result")?.textContent).toContain(
      messages["chat.phase.preparing"],
    );
    expect(
      query.mock.calls.filter(([request]) => request.type === "thread.execution_state").length,
    ).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('button[aria-label="停止"]')).not.toBeNull();
    expect(container.textContent).toContain("Retained output");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    state = { ...state, revision: "state-3", reasonCode: "RESOURCE_EXECUTION_OBSERVED" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(container.querySelector(".process-result")?.textContent).toContain(
      messages["chat.resource.executing"],
    );
    visibility.mockReturnValue("hidden");
    const requests = query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(query).toHaveBeenCalledTimes(requests);
    visibility.mockRestore();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(["scope", "revision"])("rejects a mismatched backend state (%s)", async (mismatch) => {
    runs = [{ runId: "run-ui", revision: 3, status: "running", createdAt: NOW, updatedAt: NOW }];
    options = { ...options, configuration: { ...configuration, executionStateAvailable: true } };
    const original = query.getMockImplementation();
    query.mockImplementation(async (request, signal) =>
      request.type === "thread.execution_state"
        ? {
            type: "thread.execution_state_snapshot",
            payload: {
              threadId: mismatch === "scope" ? "other-thread" : "thread-ui",
              runId: "run-ui",
              state: { runRevision: 2 },
            },
          }
        : original?.(request, signal),
    );
    await render();
    await refresh();
    expect(document.body.textContent).toContain(messages["loading.retry"]);
    expect(container.querySelector('button[aria-label="停止"]')).toBeNull();
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
      await click(messages["threads.search"]);
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
  it("keeps the welcome page available when creating a conversation fails", async () => {
    options = { ...options, route: routeForSurface("threads") };
    mutate.mockRejectedValueOnce(new Error("controlled creation failure"));
    await render();
    await refresh();
    await input(container.querySelector("textarea"), "开始新对话");
    await click("threads.send");
    expect(container.textContent).toContain("controlled creation failure");
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("开始新对话");
    expect(options.storage.readDraft("new")).toBe("开始新对话");
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
        expect(sent.payload).toMatchObject({ modelRef: "model-ui", thinkingLevel: "off" });
      expect(JSON.stringify(sent)).not.toContain("请继续这个任务");
      expect(protect.mock.calls.some(([text]) => text === "请继续这个任务")).toBe(true);
      expect(options.storage.readDraft(thread.threadId)).toBe("");
      expect(container.querySelector("textarea")?.value).toBe("");
    },
  );
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
    expect(options.storage.readDraft(thread.threadId)).toBe("未发送的内容");
    expect(container.textContent).toContain("controlled request failure");
    options = { ...options, connection: "offline" };
    await render();
    await send();
    expect(mutate).toHaveBeenCalledOnce();
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
  it("preserves a conflict and reapplies an owner rename only against the displayed latest revision", async () => {
    await render();
    await refresh();
    await chooseAction("rename");
    await input(field("review.conversationName"), "自定义标题");
    mutate.mockResolvedValueOnce({
      kind: "conflict",
      payload: { latest: { ...thread, revision: 4 }, reasonCode: "STALE_REVISION" },
    });
    await click("review.save");
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
    await input(container.querySelector("textarea"), "开始新对话");
    await click("threads.send");
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
  it("offers archive only and never queries deletion or checkpoint controls", async () => {
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
    ]);
    expect(document.body.textContent).not.toContain(messages["threads.trash"]);
    expect(
      query.mock.calls.some(([request]) =>
        ["thread.checkpoint", "thread.deletion_impact"].includes(request.type),
      ),
    ).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("shows a retry after a list failure and reports expired authorization", async () => {
    options = { ...options, route: routeForSurface("threads") };
    query.mockRejectedValueOnce({ status: 401 });
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
  await click(messages["threads.search"]);
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
  expect(container.querySelectorAll(".thread-row")).toHaveLength(2);
});
