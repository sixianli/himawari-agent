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

it("[UI-5] collapses a finished turn into one line with the total, the category bar and the longest step", () => {
  const html = render();
  const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
  expect(html).not.toMatch(/<details class="turn-process"[^>]* open/);
  expect(summary).toContain("process.took(time=27.1s)");
  expect(summary).toContain('class="process-stack" role="img"');
  expect(summary.match(/<i class="category-/g)).toHaveLength(4);
  expect(summary).toContain("process.longest(step=process.step.you,time=8.4s)");
  expect(summary).toContain('class="process-result run-text-completed is-quiet"');
});

it("[UI-5] lists every step with a time bar and its duration, and marks the parallel search", () => {
  const html = render();
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  expect(rows).toHaveLength(8);
  expect(rows.map((row) => row.match(/class="row-duration">([^<]+)</)?.[1])).toEqual([
    "1.5s",
    "0.0s",
    "2.8s",
    "8.4s",
    "2.9s",
    "2.9s",
    "2.9s",
    "3.7s",
  ]);
  expect(rows.every((row) => row.includes('class="timeline-track"'))).toBe(true);
  expect(rows[5]).toContain("process.parallel");
  expect(rows[4]).not.toContain("process.parallel");
  expect(rows[3]).toContain("process.step.you");
  expect(rows[7]).toContain("process.characters(count=120)");
  expect(html).not.toContain("最久");
});

it("[UI-5] keeps the narration as a quote under the thinking step instead of a separate row", () => {
  const html = render();
  const rows = html.split('<li class="execution-step timeline-row').slice(1);
  expect(rows[2]).toContain('<p class="row-quote"><q>我来搜索最新的美国新闻。</q></p>');
  expect(html).not.toContain("execution-note");
});

it("[UI-5] shows the per-category ledger only after the turn ends, and the parts add up to the total", () => {
  const html = render();
  expect(html).toContain("process.category.model <b>9.3s</b>");
  expect(html).toContain("process.category.tool <b>2.9s</b>");
  expect(html).toContain("process.category.you <b>8.4s</b>");
  expect(html).toContain("process.category.prep <b>6.4s</b>");
  expect(html).toContain("process.total(time=27.1s)");
  expect(html).toContain("process.note");
  const running = render(
    { ...completedRun, status: "running", updatedAt: at(5000) },
    newsRun().filter((record) => record.sequence <= 7),
  );
  expect(running).toMatch(/<details class="turn-process" open/);
  expect(running).not.toContain("process-ledger");
  expect(running).toContain("execution-step timeline-row is-running");
});

it.each([
  ["zh-CN", "用时 27.1s", "最久：等你确认 8.4s", "准备与衔接"],
  ["en", "Took 27.1s", "Longest: Waiting for your approval 8.4s", "Preparation and handoffs"],
  ["ja", "所要 27.1s", "最長：承認待ち 8.4s", "準備と引き継ぎ"],
] as const)(
  "[UI-6] renders the whole process area in %s with no untranslated text",
  async (locale, took, longest, prep) => {
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
    expect(html).toContain(took);
    expect(html).toContain(longest);
    expect(html).toContain(prep);
    const chrome = html
      .replace(/<q>[^<]*<\/q>/g, "")
      .replace(/<pre>[^<]*<\/pre>/g, "")
      .replace(/<[^>]+>/g, " ");
    expect(chrome).not.toMatch(/\b(process|step|chat|runs|review)\.[a-zA-Z]/);
    if (locale === "en") expect(chrome).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    if (locale === "ja") expect(chrome).not.toMatch(/用时|等你|准备|写回答/);
  },
);
