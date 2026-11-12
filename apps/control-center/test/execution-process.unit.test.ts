import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
} from "@himawari-agent/gateway-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache } from "react-intl";
import { expect, it } from "vitest";
import { ExecutionProcess } from "../src/components/execution-process.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { loadMessageCatalog } from "../src/i18n/runtime.js";
import { at, completedRun, newsRun } from "./news-run-fixture.js";

const message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) =>
  values
    ? `${id}(${Object.entries(values)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(",")})`
    : id;
const render = (run = completedRun, records = newsRun(), state?: ThreadExecutionState) =>
  renderToStaticMarkup(
    createElement(ExecutionProcess, { run, records, message, connection: "connected", state }),
  );

it("[UI-5] collapses a finished turn into one sentence that says what it did and the total time", () => {
  const html = render();
  const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
  expect(html).not.toMatch(/<details class="turn-process"[^>]* open/);
  expect(summary).toContain(
    '<span class="process-took">process.headline(actions=process.did.search(count=2),time=more.duration.seconds(seconds=27))</span>',
  );
  expect(summary).not.toContain("process-stack");
  expect(summary).not.toContain("process.longest");
  expect(summary).toContain('class="row-chevron"');
  expect(summary).toContain('class="process-result run-text-completed is-quiet"');
});

it("[UI-5] falls back to the total alone when the turn used no tool", () => {
  const records = newsRun().filter(
    (record) => record.kind !== "tool" && !record.itemId.startsWith("tool:"),
  );
  const html = render(completedRun, records);
  const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
  expect(summary).toContain(
    '<span class="process-took">process.took(time=more.duration.seconds(seconds=27))</span>',
  );
});

it("[UI-5] shows each step's duration exactly as the recorded timestamps give it, with no start-to-end detail", () => {
  const records = newsRun();
  const html = render(completedRun, records);
  const origin = Date.parse(completedRun.createdAt);
  const offset = (name: string, itemId: string, phase?: string) => {
    const record = records.findLast(
      (candidate) =>
        candidate.itemId === itemId &&
        (candidate.name === name || candidate.kind === name) &&
        (phase === undefined || candidate.phase === phase),
    );
    if (!record) throw new Error(`missing ${name} ${itemId}`);
    return Date.parse(record.occurredAt) - origin;
  };
  const searchStart = offset("tool", "tool:zh", "started");
  const searchEnd = offset("tool", "tool:en", "completed");
  const seconds = (milliseconds: number) =>
    `more.duration.seconds(seconds=${Math.max(1, Math.round(milliseconds / 1000))})`;
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  const search = rows.find((row) => row.includes("step.search"));
  expect(search?.match(/class="row-duration">([^<]+)</)?.[1]).toBe(
    seconds(searchEnd - searchStart),
  );
  expect(html).not.toContain("process.span");
  expect(html).not.toContain("segment-list");
  const total = Date.parse(completedRun.updatedAt) - origin;
  expect(html).toContain(`time=${seconds(total)})`);
});

it("[UI-5] lets a step open only when it has something to show, and marks the ones that do", () => {
  const html = render();
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  for (const row of rows) {
    const expandable = row.includes("<details");
    expect(row.includes('<svg class="row-chevron"')).toBe(expandable);
  }
  const writeRow = rows.find((row) => row.includes("process.step.write"));
  expect(writeRow).toContain('class="timeline-record is-static"');
  const youRow = rows.find((row) => row.includes("process.step.you"));
  expect(youRow).not.toContain("<details");
  const searchRow = rows.find((row) => row.includes("step.search"));
  expect(searchRow).toContain('class="timeline-record is-static"');
  expect(searchRow).not.toContain("<details");
});

it("[UI-5] lists every step with whole-second durations and no time bar, and shows parallel searches as one row", () => {
  const html = render();
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  expect(rows).toHaveLength(5);
  expect(rows.map((row) => row.match(/class="row-duration">([^<]+)</)?.[1])).toEqual([
    "more.duration.seconds(seconds=3)",
    "more.duration.seconds(seconds=8)",
    "more.duration.seconds(seconds=3)",
    "more.duration.seconds(seconds=3)",
    "more.duration.seconds(seconds=4)",
  ]);
  expect(html).not.toContain("timeline-track");
  expect(html).not.toContain("process.parallel");
  expect(rows.filter((row) => row.includes("step.search"))).toHaveLength(1);
  expect(rows[1]).toContain("process.step.you");
  expect(rows[4]).toContain("process.characters(count=120)");
  expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/\d\.\ds/);
});

it("[UI-5] names the sites a merged web step used, searched and opened alike", () => {
  const records = newsRun().map((record) =>
    record.itemId === "tool:zh" && record.kind === "tool" && record.phase === "completed"
      ? {
          ...record,
          output: JSON.stringify({
            results: [
              { url: "https://www.google.com/a", title: "a" },
              { url: "https://news.google.com/b", title: "b" },
            ],
          }),
        }
      : record.itemId === "tool:en" && record.kind === "tool"
        ? { ...record, name: "web_fetch", input: '{"url":"https://www.baidu.com/s?wd=x"}' }
        : record,
  );
  const html = render(completedRun, records);
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  const web = rows.filter((row) => row.includes("step.search"));
  expect(web).toHaveLength(1);
  expect(web[0]).toContain('<span class="step-preview">google.com · baidu.com</span>');
  expect(html).not.toContain("step.fetch");
});

it("[UI-5] reverse: a non-web tool between two searches keeps them as separate rows", () => {
  const records = newsRun().map((record) =>
    record.itemId === "tool:en" && record.kind === "tool" ? { ...record, name: "bash" } : record,
  );
  const html = render(completedRun, records);
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  expect(rows.filter((row) => row.includes("step.search"))).toHaveLength(1);
  expect(rows.filter((row) => row.includes("step.command"))).toHaveLength(1);
});

it("[UI-5] keeps the narration as a quote under the thinking step instead of a separate row", () => {
  const html = render();
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  expect(rows[0]).toContain('<p class="row-quote"><q>我来搜索最新的美国新闻。</q></p>');
  expect(html).not.toContain("execution-note");
});

it("[UI-13] shows only the token total and the KV cache hit rate after the turn ends", () => {
  const usage = {
    id: "usage:1",
    itemId: "usage:1",
    sequence: 900,
    kind: "status" as const,
    phase: "updated" as const,
    name: "runtime.usage",
    text: JSON.stringify({
      input: 2640,
      output: 480,
      cacheRead: 9360,
      cacheWrite: 0,
      costUsd: 0.0042,
    }),
    input: "",
    output: "",
    activity: "",
    activityIcon: "",
    occurredAt: at(26000),
  };
  const html = render(completedRun, [...newsRun(), usage]);
  const line = html.slice(html.indexOf('<p class="process-tokens">'));
  expect(line).toContain("<b>12.5k</b>");
  expect(line).toContain('title="process.cacheHitHint">process.cacheHit(percent=78)');
  expect(html).not.toContain("$0.0042");
  expect(html).not.toContain("process.note");
  expect(html).not.toContain("process-ledger");
  const running = render(
    { ...completedRun, status: "running", updatedAt: at(5000) },
    newsRun().filter((record) => record.sequence <= 7),
  );
  expect(running).not.toMatch(/<details class="turn-process"[^>]* open/);
  expect(running).not.toContain("process-tokens");
  expect(running).toContain("execution-step timeline-row is-running");
});

it.each([
  ["zh-CN", "搜索了 2 次网页，用时 27 秒", "等你确认"],
  ["en", "searched the web 2 times in 27 s", "Waiting for your approval"],
  ["ja", "ウェブを 2 回検索（27秒）", "承認待ち"],
] as const)(
  "[UI-6] renders the whole process area in %s with no untranslated text",
  async (locale, headline, you) => {
    const intl = createIntl(
      { locale, messages: await loadMessageCatalog(locale), onError: () => undefined },
      createIntlCache(),
    );
    const html = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        run: completedRun,
        records: newsRun(),
        message: (id, values) => intl.formatMessage({ id }, values),
        connection: "connected",
      }),
    );
    expect(html).toContain(headline);
    expect(html).toContain(you);
    const chrome = html
      .replace(/<q>[^<]*<\/q>/g, "")
      .replace(/<pre>[^<]*<\/pre>/g, "")
      .replace(/<[^>]+>/g, " ");
    expect(chrome).not.toMatch(/\b(process|step|chat|runs|review)\.[a-zA-Z]/);
    if (locale === "en") expect(chrome).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    if (locale === "ja") expect(chrome).not.toMatch(/用时|等你|准备|写回答/);
  },
);

it("[UI-30] opens a command step to whether it worked, with the command itself under command details", () => {
  const records = newsRun().map((record) =>
    record.itemId === "tool:zh" && record.kind === "tool"
      ? {
          ...record,
          name: "bash",
          input: '{"command":"npm test"}',
          ...(record.phase === "completed"
            ? { phase: "failed" as const, output: "1 failing\n\nCommand exited with code 1" }
            : {}),
        }
      : record,
  );
  const html = render(completedRun, records);
  expect(html).toContain("step.outcome.failed · step.outcome.exitCode(code=1)");
  expect(html).toContain('data-glyph="close"');
  const technical = html.match(/<details class="step-technical">[\s\S]*?<\/details>/g) ?? [];
  expect(technical.length).toBeGreaterThan(0);
  expect(technical.join("")).toContain("step.commandDetails");
  expect(technical.join("")).toContain('<pre class="step-command">npm test</pre>');
  expect(technical.join("")).toContain('<span class="step-name">bash</span>');
  const outside = html.replace(/<details class="step-technical">[\s\S]*?<\/details>/g, "");
  expect(outside).not.toContain("npm test");
  expect(outside).not.toContain('<span class="step-name">');
  expect(outside).not.toContain("chat.requestArguments");
});

it("shows the lines written so far instead of a record error while a file is being written", async () => {
  const { gameRun } = await import("./news-run-fixture.js");
  const run = { ...completedRun, status: "running" as const, updatedAt: at(30000) };
  const html = renderToStaticMarkup(
    createElement(ExecutionProcess, {
      run,
      records: gameRun(30000),
      message,
      connection: "connected",
      stateAvailable: true,
    }),
  );
  expect(html).toContain(
    '<span class="process-live-step">chat.activity.writing(step=step.write,lines=200)</span>',
  );
  expect(html).toContain("chat.phase.writing(lines=200)");
  expect(html).not.toContain("chat.recordUnavailable");
});

it("still says the record is unavailable once a finished turn's state cannot be read", () => {
  const html = renderToStaticMarkup(
    createElement(ExecutionProcess, {
      run: completedRun,
      records: newsRun(),
      message,
      connection: "connected",
      stateAvailable: true,
    }),
  );
  expect(html).toContain("chat.recordUnavailable");
});

const acceptedRunWaiting = (waitedMilliseconds: number) => ({
  ...completedRun,
  status: "accepted" as const,
  background: null,
  backgroundCommands: [],
  createdAt: new Date(Date.now() - waitedMilliseconds).toISOString(),
  updatedAt: new Date(Date.now() - waitedMilliseconds).toISOString(),
});

it("[QUEUE-1] says the turn is waiting in line, with the real wait, once an accepted turn has had no slot for 3 seconds", () => {
  const html = render(acceptedRunWaiting(30_000), []);
  expect(html).toContain('<span class="process-live-step">chat.queued(tool=)</span>');
  expect(html).toContain("chat.queuedWait");
  expect(html).toContain('<output class="sr-only">chat.queued(tool=)</output>');
  expect(html.match(/30s|seconds=30/g) ?? []).toHaveLength(1);
  expect(html).not.toContain("chat.lastActivity");
  expect(html).not.toContain("chat.progressDelayed");
});

it("[QUEUE-1] reverse: does not claim a queue for a turn that was accepted a moment ago", () => {
  const html = render(acceptedRunWaiting(1_000), []);
  expect(html).not.toContain("chat.queued");
});

it("[QUEUE-1] reverse: does not claim a queue once the turn has started producing records", () => {
  const html = render({ ...acceptedRunWaiting(30_000), status: "running" }, newsRun());
  expect(html).not.toContain("chat.queued");
  const acceptedWithRecords = render(acceptedRunWaiting(30_000), newsRun());
  expect(acceptedWithRecords).not.toContain("chat.queued");
});

const reviewRecord = (
  sequence: number,
  milliseconds: number,
  outcome: "started" | "approved",
): ThreadExecutionRecord => ({
  id: `review:${sequence}`,
  itemId: "review:one",
  sequence,
  kind: "status",
  phase: "updated",
  name: `runtime.authorization_review.${outcome}`,
  text: "",
  input: "",
  output: "",
  activity: "",
  activityIcon: "",
  occurredAt: at(milliseconds),
});

it("[ICON-MOTION-5] the automatic-review row animates only while the review is still running", () => {
  const running = { ...completedRun, status: "running" as const, updatedAt: at(5000) };
  const live = render(running, [reviewRecord(1, 1000, "started")]);
  expect(live).toContain("execution-stage authorization-review is-running");
  const done = render(running, [
    reviewRecord(1, 1000, "started"),
    reviewRecord(2, 3000, "approved"),
  ]);
  expect(done).toContain("execution-stage authorization-review");
  expect(done).not.toContain("authorization-review is-running");
  const finished = render(completedRun, [reviewRecord(1, 1000, "started")]);
  expect(finished).not.toContain("authorization-review is-running");
});

it("[ICON-MOTION-5] with an execution state, the review row follows the state phase and the records together", () => {
  const running = { ...completedRun, status: "running" as const, updatedAt: at(5000) };
  const state = (displayPhase: string) =>
    ({ displayPhase, lastObservedAt: at(5000) }) as unknown as ThreadExecutionState;
  const started = [reviewRecord(1, 1000, "started")];
  expect(render(running, started, state("reviewing"))).toContain("authorization-review is-running");
  expect(render(running, started, state("running"))).not.toContain(
    "authorization-review is-running",
  );
  const approved = [reviewRecord(1, 1000, "started"), reviewRecord(2, 3000, "approved")];
  expect(render(running, approved, state("reviewing"))).not.toContain(
    "authorization-review is-running",
  );
});

it("[UI-46] while an automatic review is running, the collapsed process says it is checking rather than the open model step", () => {
  const running = { ...completedRun, status: "running" as const, updatedAt: at(5000) };
  const modelStarted: ThreadExecutionRecord = {
    ...reviewRecord(1, 500, "started"),
    id: "model:1",
    itemId: "model:1",
    phase: "started",
    name: "runtime.model_started",
  };
  const liveStep = (html: string) => {
    const start = html.indexOf('<span class="process-live-step">');
    return html.slice(start, html.indexOf("</span>", start));
  };
  const reviewing = render(running, [modelStarted, reviewRecord(2, 1000, "started")]);
  expect(liveStep(reviewing)).toBe('<span class="process-live-step">review.authorizationChecking');
  const approved = render(running, [
    modelStarted,
    reviewRecord(2, 1000, "started"),
    reviewRecord(3, 3000, "approved"),
  ]);
  expect(liveStep(approved)).not.toContain("review.authorizationChecking");
  const reconciling = render({ ...running, status: "reconciling_external_result" as const }, [
    modelStarted,
  ]);
  expect(liveStep(reconciling)).toBe('<span class="process-live-step">chat.phase.unresolved');
  expect(liveStep(render(running, [modelStarted]))).toBe(
    '<span class="process-live-step">step.active(step=step.thinking)',
  );
});

it("[ICON-MOTION-6] only the latest unfinished thinking row animates, and none once the run has ended", () => {
  const thinking = (sequence: number, milliseconds: number, itemId: string, end: boolean) =>
    ({
      ...reviewRecord(sequence, milliseconds, "started"),
      id: `${itemId}:${sequence}`,
      itemId,
      name: end ? "runtime.thinking.ended" : "runtime.thinking.started",
    }) as ThreadExecutionRecord;
  const running = { ...completedRun, status: "running" as const, updatedAt: at(5000) };
  const records = [
    thinking(1, 1000, "thinking:old", false),
    thinking(2, 2000, "thinking:new", false),
  ];
  const html = render(running, records);
  expect(html.match(/execution-stage is-running/g)?.length).toBe(1);
  expect(render(completedRun, records)).not.toContain("execution-stage is-running");
  const closed = [
    thinking(1, 1000, "thinking:old", false),
    thinking(2, 2000, "thinking:old", true),
  ];
  expect(render(running, closed)).not.toContain("execution-stage is-running");
});
