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
const render = (run = completedRun, records = newsRun()) =>
  renderToStaticMarkup(
    createElement(ExecutionProcess, { run, records, message, connection: "connected" }),
  );

it("[UI-5] collapses a finished turn into one sentence that says what it did and the total time", () => {
  const html = render();
  const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
  expect(html).not.toMatch(/<details class="turn-process"[^>]* open/);
  expect(summary).toContain(
    '<span class="process-took">process.headline(actions=process.did.search(count=2),time=27.1s)</span>',
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
  expect(summary).toContain('<span class="process-took">process.took(time=27.1s)</span>');
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
  const searchEnd = offset("tool", "tool:zh", "completed");
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  const search = rows.find((row) => row.includes("step.search"));
  expect(search?.match(/class="row-duration">([^<]+)</)?.[1]).toBe(
    `${(Math.round((searchEnd - searchStart) / 100) / 10).toFixed(1)}s`,
  );
  expect(html).not.toContain("process.span");
  expect(html).not.toContain("segment-list");
  const total = Date.parse(completedRun.updatedAt) - origin;
  expect(html).toContain(`time=${(Math.round(total / 100) / 10).toFixed(1)}s)`);
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
  expect(searchRow).toContain("<details");
});

it("[UI-5] lists every step with a time bar and its duration, and marks the parallel search", () => {
  const html = render();
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  expect(rows).toHaveLength(6);
  expect(rows.map((row) => row.match(/class="row-duration">([^<]+)</)?.[1])).toEqual([
    "2.8s",
    "8.4s",
    "2.9s",
    "2.9s",
    "2.9s",
    "3.7s",
  ]);
  expect(rows.every((row) => row.includes('class="timeline-track"'))).toBe(true);
  expect(rows[3]).toContain("process.parallel");
  expect(rows[2]).not.toContain("process.parallel");
  expect(rows[1]).toContain("process.step.you");
  expect(rows[5]).toContain("process.characters(count=120)");
  expect(html).not.toContain("最久");
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
  ["zh-CN", "搜索了 2 次网页，用时 27.1s", "等你确认"],
  ["en", "searched the web 2 times in 27.1s", "Waiting for your approval"],
  ["ja", "ウェブを 2 回検索（27.1s）", "承認待ち"],
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
  expect(html).toContain("step.outcome.ok");
  expect(html).toContain('data-glyph="check"');
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
  expect(html).toContain("chat.activity.writing(step=step.write,lines=200)");
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
