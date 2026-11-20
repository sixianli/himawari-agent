// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionReviewSection } from "../src/components/correction-review.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import { type MemoryReview, useMemory } from "../src/memory.ts";

const intl = createIntl({ locale: "zh-CN", messages });
const message = (id: MessageId, values?: Record<string, string | number>) =>
  intl.formatMessage({ id }, values);
let container: HTMLDivElement, root: Root;

const empty: MemoryReview = {
  memories: [],
  rules: [],
  agreement: { handled: 0, agreed: 0, missed: 0, openMemories: 0, openRules: 0 },
  generatedAt: "2026-11-12T00:00:00.000Z",
};
const flagged: MemoryReview = {
  ...empty,
  memories: [
    {
      memoryId: "memory-c",
      text: "Andy 每周一早上要看入管局的邮件",
      upstreamMemoryId: "memory-a",
      upstreamText: "Andy 在办日本签证续签",
      reason: "memory_edited",
      depth: 2,
      truncated: true,
      flaggedAt: "2026-11-12T00:00:00.000Z",
    },
    {
      memoryId: "memory-c",
      text: "Andy 每周一早上要看入管局的邮件",
      upstreamMemoryId: "memory-x",
      upstreamText: null,
      reason: "owner_reported",
      depth: 1,
      truncated: false,
      flaggedAt: "2026-11-12T00:00:00.000Z",
    },
  ],
  rules: [
    {
      ruleId: "owner:suspended",
      revision: 4,
      status: "suspended",
      summary: "日本入管局相关的邮件一律提醒",
      suggestion: "日本和韩国入管局相关的邮件一律提醒",
      suggestionConditions: [
        { field: "senderDomains", values: ["moj.go.jp", "moj.go.kr"] },
        { field: "excludePhrases", values: ["广告"] },
      ],
      suspendReason: "parameters_changed",
      rechecking: false,
      sourceMemoryId: "memory-rule",
      updatedAt: "2026-11-12T00:00:00.000Z",
    },
    {
      ruleId: "owner:waiting",
      revision: 2,
      status: "needs_review",
      summary: "涉及退款的邮件先读完整个邮件串",
      suggestion: null,
      suggestionConditions: [],
      suspendReason: null,
      rechecking: true,
      sourceMemoryId: "memory-rule-2",
      updatedAt: "2026-11-12T00:00:00.000Z",
    },
  ],
};

async function show(node: ReturnType<typeof h>) {
  await act(async () => root.render(node));
  await act(async () => {});
}

function buttonsIn(selector: string) {
  return [
    ...(container.querySelector(selector)?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
}

async function press(selector: string, label: string) {
  const found = buttonsIn(selector).find((button) => button.textContent === label);
  if (!found) throw new Error(`no button ${label} in ${selector}`);
  await act(async () => found.click());
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[P4-1] memories and rules to recheck after a memory edit", () => {
  it("lists a flagged memory once with every reason, and a paused rule with its suggestion and three choices", async () => {
    const respondReview = vi.fn(async () => true);
    const onOpenMemory = vi.fn();
    await show(
      h(CorrectionReviewSection, {
        memory: { review: flagged, respondReview, busy: false },
        message,
        onOpenMemory,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("改了记忆后待重审 · 3 条");
    expect(container.querySelectorAll("[data-review-memory]")).toHaveLength(1);
    expect(text).toContain("它依据的记忆被改了 · 依据的记忆：Andy 在办日本签证续签");
    expect(text).toContain("你指出它也该跟着改 · 依据的记忆已经删除");
    expect(text).toContain("依据它推出来的记忆太多，超过上限的没有标出");
    expect(text).toContain("已暂停：来源记忆读下来和原规则对不上");
    expect(text).toContain("系统建议改成：日本和韩国入管局相关的邮件一律提醒");
    expect(text).toContain("发件域名：moj.go.jp、moj.go.kr");
    expect(text).toContain("排除短语：广告");
    expect(
      container.querySelectorAll('[data-review-rule="owner:waiting"] [data-review-condition]'),
    ).toHaveLength(0);
    expect(text).toContain("系统会在查邮件前自动核对（核对完之前照常执行）");
    expect(text).not.toContain("来源记忆又变了");
    expect(
      buttonsIn('[data-review-rule="owner:suspended"]').map((button) => button.textContent),
    ).toEqual(["采用建议", "确认停用", "恢复原规则"]);
    expect(
      buttonsIn('[data-review-rule="owner:waiting"]').map((button) => button.textContent),
    ).toEqual(["看过没问题"]);
    await press('[data-review-rule="owner:suspended"]', "采用建议");
    expect(respondReview).toHaveBeenLastCalledWith("owner:suspended", "adopt", 4);
    await press('[data-review-rule="owner:suspended"]', "确认停用");
    expect(respondReview).toHaveBeenLastCalledWith("owner:suspended", "confirm_suspended", 4);
    await press('[data-review-rule="owner:waiting"]', "看过没问题");
    expect(respondReview).toHaveBeenLastCalledWith("owner:waiting", "restore", 2);
    await press('[data-review-memory="memory-c"]', "看过没问题");
    expect(respondReview).toHaveBeenLastCalledWith("memory-c", "dismiss", null);
    await press('[data-review-memory="memory-c"]', "打开修改");
    expect(onOpenMemory).toHaveBeenCalledWith("memory-c");
  });

  it("keeps a flagged memory whose text cannot be read on the list so it can still be dismissed", async () => {
    const respondReview = vi.fn(async () => true);
    const unreadable: MemoryReview = {
      ...empty,
      memories: [
        {
          memoryId: "memory-gone",
          text: null,
          upstreamMemoryId: "memory-a",
          upstreamText: "Andy 在办日本签证续签",
          reason: "memory_edited",
          depth: 1,
          truncated: false,
          flaggedAt: "2026-11-12T00:00:00.000Z",
        },
      ],
    };
    await show(
      h(CorrectionReviewSection, {
        memory: { review: unreadable, respondReview, busy: false },
        message,
        onOpenMemory: vi.fn(),
      }),
    );
    expect(container.textContent).toContain("这条记忆的文字读不出来");
    await press('[data-review-memory="memory-gone"]', "看过没问题");
    expect(respondReview).toHaveBeenLastCalledWith("memory-gone", "dismiss", null);
  });

  it("says a paused rule is being checked again once its source changed, and offers no stale suggestion", async () => {
    const [paused] = flagged.rules;
    if (!paused) throw new Error("fixture");
    const requeued: MemoryReview = {
      ...empty,
      rules: [{ ...paused, suggestion: null, suggestionConditions: [], rechecking: true }],
    };
    await show(
      h(CorrectionReviewSection, {
        memory: { review: requeued, respondReview: vi.fn(), busy: false },
        message,
        onOpenMemory: vi.fn(),
      }),
    );
    expect(container.textContent).toContain("来源记忆又变了，系统会在查邮件前再核对一次");
    expect(
      buttonsIn('[data-review-rule="owner:suspended"]').map((button) => button.textContent),
    ).toEqual(["确认停用", "恢复原规则"]);
  });

  it("does not promise an automatic check for a waiting rule the system can no longer check", async () => {
    const [, waiting] = flagged.rules;
    if (!waiting) throw new Error("fixture");
    const stuck: MemoryReview = { ...empty, rules: [{ ...waiting, rechecking: false }] };
    await show(
      h(CorrectionReviewSection, {
        memory: { review: stuck, respondReview: vi.fn(), busy: false },
        message,
        onOpenMemory: vi.fn(),
      }),
    );
    expect(container.textContent).toContain("系统没法自动核对");
    expect(container.textContent).toContain("找不到来源记忆，或核对连续失败");
    expect(container.textContent).not.toContain("系统会在查邮件前自动核对");
  });

  it("shows nothing when no memory or rule is waiting", async () => {
    await show(
      h(CorrectionReviewSection, {
        memory: { review: empty, respondReview: vi.fn(), busy: false },
        message,
        onOpenMemory: vi.fn(),
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("asks the service for the list and sends the choice and a missed item with their payloads", async () => {
    const query = vi.fn(async (request: { type: string }) =>
      request.type === "memory.review.read"
        ? { type: "memory.review.snapshot", payload: flagged }
        : request.type === "memory.rules.read"
          ? { type: "memory.rules.snapshot", payload: { rules: [], generatedAt: "x" } }
          : { type: "memory.overview.snapshot", payload: {} },
    );
    const mutate = vi.fn(async (_command: { type: string; payload: unknown }) => ({}));
    const client = { query, mutate, protectText: vi.fn() } as unknown as GatewayClient;
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
        "memory.review.read",
        "memory.review.respond",
        "memory.review.reportMissed",
      ],
    };
    const probe: { model: ReturnType<typeof useMemory> } = { model: null };
    function Probe() {
      probe.model = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
      return null;
    }
    await show(h(Probe));
    expect(probe.model?.review).toEqual(flagged);
    await act(async () => void (await probe.model?.respondReview("owner:suspended", "adopt", 4)));
    await act(async () => void (await probe.model?.reportMissed("memory-c", "memory-a")));
    const sent = mutate.mock.calls.map(
      ([command]) => (command as { type: string; payload: unknown }).payload,
    );
    expect(mutate.mock.calls.map(([command]) => (command as { type: string }).type)).toEqual([
      "memory.review.respond",
      "memory.review.reportMissed",
    ]);
    expect(sent).toEqual([
      { target: "owner:suspended", action: "adopt", expectedRevision: 4 },
      { memoryId: "memory-c", upstreamMemoryId: "memory-a" },
    ]);
  });

  it("does not ask for the list when the service has not installed it", async () => {
    const query = vi.fn(async (_request: { type: string }) => ({
      type: "memory.overview.snapshot",
      payload: {},
    }));
    const client = { query, mutate: vi.fn(), protectText: vi.fn() } as unknown as GatewayClient;
    const configuration: ControlCenterRuntimeConfiguration = {
      ownerId: "owner",
      agentId: "agent",
      deploymentId: "deployment",
      authorityEpoch: 1,
      fencingToken: 1,
      actorId: "owner",
      csrfToken: "csrf-fixture",
      installedGatewayV2Operations: ["memory.overview.read"],
    };
    function Probe() {
      useMemory({ client, configuration, connected: true, refreshSignal: 0 });
      return null;
    }
    await show(h(Probe));
    expect(query.mock.calls.map(([request]) => (request as { type: string }).type)).toEqual([
      "memory.overview.read",
    ]);
  });
});
