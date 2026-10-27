import type {
  ThreadExecutionRecord,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache } from "react-intl";
import { expect, it } from "vitest";
import { ChatHistory } from "../src/components/chat-history.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { loadMessageCatalog } from "../src/i18n/runtime.js";
import { at, completedRun, newsRun } from "./news-run-fixture.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

const extra = (id: string, overrides: Partial<ThreadExecutionRecord>): ThreadExecutionRecord => ({
  id,
  itemId: id,
  sequence: 900,
  kind: "status",
  phase: "updated",
  name: "",
  text: "",
  input: "",
  output: "",
  occurredAt: at(26000),
  ...overrides,
});
const turnRecords = (withUsage = true) => [
  ...newsRun(),
  extra("search:done", {
    kind: "tool",
    phase: "completed",
    name: "web_search",
    output: JSON.stringify({
      results: [
        { url: "https://apnews.com/a", title: "AP headline" },
        { url: "https://www.reuters.com/b", title: "Reuters story" },
      ],
    }),
  }),
  ...(withUsage
    ? [
        extra("usage:1", {
          name: "runtime.usage",
          text: JSON.stringify({
            input: 3000,
            output: 480,
            cacheRead: 18000,
            cacheWrite: 0,
            reasoning: 0,
            costUsd: 0.0042,
          }),
        }),
      ]
    : []),
];
const detail = (): Detail => ({
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
      threadId: "thread:test",
      revision: 1,
      status: "active",
      titleRef: null,
      titleSource: null,
      titleRevision: 0,
      pinOrder: null,
      answerLocale: "zh-CN",
      messageWatermark: 2,
      createdAt: at(0),
      updatedAt: at(27082),
    },
    snapshotRef: "snapshot:one",
    generatedAt: at(27082),
    nextSequence: null,
    messages: [
      {
        messageId: "message:owner",
        sequence: 1,
        role: "owner",
        contentRef: "content:owner",
        dataClassification: "private",
        status: "committed",
        turnId: "turn:news",
        runId: completedRun.runId,
        committedAt: at(0),
      },
      {
        messageId: "message:agent",
        sequence: 2,
        role: "agent",
        contentRef: "content:agent",
        dataClassification: "private",
        status: "committed",
        turnId: "turn:news",
        runId: completedRun.runId,
        committedAt: at(27082),
      },
    ],
    runs: [completedRun],
  },
});
const ids: Message = (id, values) =>
  values
    ? `${id}(${Object.entries(values)
        .map(
          ([key, value]) => `${key}=${value instanceof Date ? value.toISOString() : String(value)}`,
        )
        .join(",")})`
    : id;
const render = (records = turnRecords(), message: Message = ids, run = completedRun) =>
  renderToStaticMarkup(
    createElement(ChatHistory, {
      detail: { ...detail(), payload: { ...detail().payload, runs: [run] } },
      contentByRef: { "content:owner": "美国新闻最新10条", "content:agent": "## 今日要闻\n\n正文" },
      execution: { [completedRun.runId]: records },
      connection: "connected",
      message,
      onFork: () => {},
      renderApproval: () => null,
    }),
  );

it("[UI-9] puts copy and the turn facts in one line right under the answer, before the sources", () => {
  const html = render();
  const answer = html.indexOf("今日要闻");
  const actions = html.indexOf('class="answer-actions"');
  const sources = html.indexOf('class="answer-sources"');
  expect(answer).toBeGreaterThan(0);
  expect(actions).toBeGreaterThan(answer);
  expect(sources).toBeGreaterThan(actions);
  expect(html).toContain('aria-label="answer.copyHint"');
  expect(html).toContain("deepseek-v4-flash · 27.1s · answer.at(at=2026-10-26T12:24:24.777Z)");
  expect(html).toContain("answer.tokens(count=21.5k)");
  expect(html).toContain(
    'title="answer.tokenDetail(input=21,000,cached=18,000,output=480,cost=$0.0042)"',
  );
  expect(html).not.toContain("turn-model");
  expect(html).toContain('aria-label="answer.more"');
});

it("[UI-9] leaves the token count out when the turn has no usage record and hides the line while running", () => {
  expect(render(turnRecords(false))).not.toContain("answer.tokens");
  expect(render(turnRecords(), ids, { ...completedRun, status: "running" })).not.toContain(
    "answer-actions",
  );
});

it("[UI-10] folds the sources into one line and lists each page once when opened", () => {
  const html = render();
  expect(html).toContain('class="sources-toggle" aria-expanded="false"');
  expect(html).toContain("answer.sources(count=2)");
  expect(html).not.toContain("source-list");
  expect(html.match(/<i>/g)?.length).toBeGreaterThanOrEqual(2);
});

it("[UI-11] marks your message as received once the model started, with a copy button and the time", () => {
  const html = render();
  const owner = html.slice(
    html.indexOf("thread-message-owner"),
    html.indexOf("thread-message-agent"),
  );
  expect(owner).toContain('aria-label="message.copy"');
  expect(owner).toContain("answer.at(at=2026-10-26T12:23:57.695Z)");
  expect(owner).toContain('aria-label="message.status.received"');
  const waiting = render(
    newsRun().filter((record) => record.kind !== "status" || record.phase !== "started"),
  );
  const waitingOwner = waiting.slice(
    waiting.indexOf("thread-message-owner"),
    waiting.indexOf("thread-message-agent"),
  );
  expect(waitingOwner).toContain('aria-label="message.status.sent"');
});

it("[UI-16] shows the files sent with your message as cards with their size", () => {
  const html = renderToStaticMarkup(
    createElement(ChatHistory, {
      detail: detail(),
      contentByRef: {
        "content:owner":
          '总结一下\n\n<file name="report.pdf" ref="payload:http:abc" bytes="2400000" kind="pdf"/>',
        "content:agent": "好的",
      },
      execution: { [completedRun.runId]: turnRecords() },
      connection: "connected",
      message: ids,
      onFork: () => {},
      renderApproval: () => null,
    }),
  );
  expect(html).toContain(
    '<pre class="thread-message-content">总结一下</pre><ul class="message-files">',
  );
  expect(html).toContain('class="attachment-name">report.pdf</span><small>2.3 MB</small>');
  expect(html).not.toContain("payload:http:abc");
});

it("[UI-17] shows the images sent with your message as thumbnails above the text", () => {
  const html = renderToStaticMarkup(
    createElement(ChatHistory, {
      detail: detail(),
      contentByRef: {
        "content:owner":
          '这是哪里\n\n<file name="街景.jpg" ref="payload:http:img" bytes="2048" kind="image"/>\n\n<file name="notes.md" ref="payload:http:md" bytes="9" kind="text"/>',
        "content:agent": "好的",
      },
      execution: { [completedRun.runId]: turnRecords() },
      connection: "connected",
      message: ids,
      onFork: () => {},
      renderApproval: () => null,
      readImage: async () => "data:image/jpeg;base64,/9j/",
    }),
  );
  expect(html).toContain(
    '<ul class="message-images"><li title="街景.jpg · 2.0 KB"><span class="attachment-image is-empty">',
  );
  expect(html.indexOf("message-images")).toBeLessThan(html.indexOf("thread-message-content"));
  expect(html).toContain('class="attachment-name">notes.md</span>');
  expect(html).not.toContain('class="attachment-name">街景.jpg');
});

it.each([
  ["zh-CN", "复制", "2 个来源", "已开始处理"],
  ["en", "Copy", "2 sources", "Being handled"],
  ["ja", "コピー", "出典 2 件", "処理開始"],
] as const)(
  "[UI-9] renders the answer footer and message status in %s",
  async (locale, copy, sources, status) => {
    const intl = createIntl(
      { locale, messages: await loadMessageCatalog(locale), onError: () => undefined },
      createIntlCache(),
    );
    const html = render(turnRecords(), (id, values) => intl.formatMessage({ id }, values));
    expect(html).toContain(copy);
    expect(html).toContain(sources);
    expect(html).toContain(status);
    expect(html).not.toMatch(/\b(answer|message)\.[a-zA-Z]/);
  },
);
