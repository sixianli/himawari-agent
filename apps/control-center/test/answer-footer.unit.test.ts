import type {
  ThreadExecutionRecord,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache } from "react-intl";
import { expect, it } from "vitest";
import { backgroundCommands } from "../src/background-commands.js";
import { ChatHistory } from "../src/components/chat-history.js";
import { MorePanel } from "../src/components/more-panel.js";
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
  activity: "",
  activityIcon: "",
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
      sourceThreadId: null,
      sourceWatermark: null,
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
      renderApproval: () => null,
    }),
  );

it("[UI-9] keeps only actions under the answer: copy and the time", () => {
  const html = render();
  const answer = html.indexOf("今日要闻");
  const actions = html.indexOf('class="answer-actions"');
  const sources = html.indexOf('class="answer-sources"');
  expect(answer).toBeGreaterThan(0);
  expect(actions).toBeGreaterThan(answer);
  expect(sources).toBeGreaterThan(actions);
  const line = html.slice(actions, sources);
  expect(line).toContain('data-tip="answer.copyHint" aria-label="answer.copy"');
  expect(line).not.toContain("fork");
  expect(line).toContain(
    '<time class="answer-time" dateTime="2026-10-26T12:24:24.777Z">answer.at(at=2026-10-26T12:24:24.777Z)</time>',
  );
  expect(line).not.toContain("27.1s");
  expect(line).not.toContain("tokens");
  expect(line).not.toContain("answer.more");
  expect(html).not.toContain("deepseek-v4-flash");
  expect(html).not.toContain("turn-model");
});

it("[UI-9] hides the action line while the turn is still running", () => {
  expect(render(turnRecords(), ids, { ...completedRun, status: "running" })).not.toContain(
    "answer-actions",
  );
});

const bgHistory = (finished: boolean) => {
  const command = {
    taskRef: "background-command:aaaaaaaaaaaaaaaaaaaaaaaa",
    commandRef: "content:command",
    outputRef: finished ? "content:output" : null,
    startedAt: at(27000),
    deadlineAt: at(1_827_000),
    endedAt: finished ? at(519_000) : null,
    outcome: finished ? ("completed" as const) : null,
    noticeRunId: finished ? "run:notice" : null,
  };
  const parked = {
    ...completedRun,
    status: finished ? ("completed" as const) : ("running" as const),
    background: finished ? null : { count: 1, startedAt: at(27000), deadlineAt: at(1_827_000) },
    backgroundCommands: [command],
  };
  const base = detail();
  const contentByRef = {
    "content:owner": "跑一下全部测试",
    "content:agent": "测试在后台跑着",
    "content:notice": "【系统通知，不是用户发的消息】",
    "content:command": "npm test",
    "content:output": "Tests 42 passed",
  };
  const runs = [parked];
  return renderToStaticMarkup(
    createElement(ChatHistory, {
      detail: {
        ...base,
        payload: {
          ...base.payload,
          runs,
          messages: [
            ...base.payload.messages,
            ...(finished
              ? [
                  {
                    messageId: "message:notice",
                    sequence: 3,
                    role: "system" as const,
                    contentRef: "content:notice",
                    dataClassification: "private" as const,
                    status: "committed" as const,
                    turnId: "turn:notice",
                    runId: "run:notice",
                    committedAt: at(520_000),
                  },
                ]
              : []),
          ],
        },
      },
      contentByRef,
      execution: { [completedRun.runId]: turnRecords() },
      connection: "connected",
      message: ids,
      backgroundCommands: backgroundCommands(runs, contentByRef),
      onOpenCommand: () => {},
      renderApproval: () => null,
    }),
  );
};

it("[BG-5] ends the turn after the answer and shows a quiet clickable line instead of a stop button", () => {
  const html = bgHistory(false);
  expect(html).toContain("answer-actions");
  expect(html).toContain('class="background-line"');
  expect(html).toMatch(/more\.line\.running\(command=npm test,elapsed=more\.duration\.minutes/);
  expect(html).toContain('class="more-spin"');
  expect(html).not.toContain("chat.stop");
  expect(html).not.toContain("is-busy");
  expect(html).toContain(`data-run-id="${completedRun.runId}"`);
});

it("[BG-9] marks the report turn with a divider that names the command, its duration and time", () => {
  const html = bgHistory(true);
  expect(html).toContain("more.line.completed(command=npm test)");
  expect(html).toContain('class="background-report"');
  expect(html).toContain(
    `more.report.completed(command=npm test,duration=more.duration.minutes(minutes=8,seconds=12),at=${at(520_000)})`,
  );
  expect(html).not.toContain("【系统通知");
  expect(html.indexOf("background-report")).toBeGreaterThan(html.indexOf("background-line"));
});

it("[UI-10] names the first sites in the folded sources line and marks every source as an external link", () => {
  const html = render();
  expect(html).toContain(
    'class="sources-toggle" aria-expanded="false" aria-label="answer.sources(count=2)"',
  );
  expect(html).toContain('<span class="source-sites">apnews.com · reuters.com</span>');
  expect(html).not.toContain("source-more");
  expect(html).not.toContain("source-list");
  expect(html).not.toMatch(/<i>[A-Z]<\/i>/);
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

it("[BG-9] lists this conversation's files by turn, newest first, and points to running commands from the Files tab", () => {
  const command = backgroundCommands(
    [
      {
        ...completedRun,
        backgroundCommands: [
          {
            taskRef: "background-command:aaaaaaaaaaaaaaaaaaaaaaaa",
            commandRef: null,
            outputRef: null,
            startedAt: at(0),
            deadlineAt: at(1_800_000),
            endedAt: null,
            outcome: null,
            noticeRunId: null,
          },
        ],
      },
    ],
    {},
  );
  const file = (name: string, runId: string, turn: number, version = 1) => ({
    key: `file:${name}`,
    path: name,
    name,
    kind: "document" as const,
    runId,
    turn,
    source: "write" as const,
    command: undefined,
    versions: version,
    registered: {
      id: `file:${name}`,
      threadId: "thread:1",
      runId,
      toolCallId: `call:${name}`,
      toolItemId: `item:${name}`,
      source: "write" as const,
      path: name,
      name,
      kind: "document" as const,
      mediaType: "text/markdown",
      sizeBytes: 2048,
      version,
      turn,
      commandKey: null,
      stored: true,
      overlapped: false,
      deleted: false,
      createdAt: at(0),
    },
    trace: undefined,
  });
  const html = renderToStaticMarkup(
    createElement(MorePanel, {
      tab: "files",
      commandKey: null,
      commands: command,
      fileGroups: [
        {
          runId: "run:4",
          turn: 4,
          title: undefined,
          command: undefined,
          files: [file("test-report.md", "run:4", 4)],
        },
        {
          runId: "run:1",
          turn: 1,
          title: "做一个贪吃蛇",
          command: undefined,
          files: [file("README.md", "run:1", 1, 2)],
        },
      ],
      stoppingRunIds: [],
      openFileKey: undefined,
      onTab: () => {},
      onCommand: () => {},
      onStop: undefined,
      onReport: () => {},
      onOpenFile: () => {},
      onClose: () => {},
      message: ids,
    }),
  );
  expect(html).toContain(
    'aria-selected="true">more.tab.files<span class="more-tab-count">2</span>',
  );
  expect(html).toContain("more.tab.commands");
  expect(html).toContain("more.runningHint(count=1)");
  expect(html.indexOf("test-report.md")).toBeLessThan(html.indexOf("README.md"));
  expect(html).toContain("more.turn(turn=4)");
  expect(html).toContain("more.files.group(turn=1,title=做一个贪吃蛇)");
  expect(html).toContain('class="delivered-badge" aria-hidden="true">MD</span>');
  expect(html).toContain("files.kind.document · 2 KB · files.version(version=2)");
  expect(html).not.toContain("more-stop");
});
