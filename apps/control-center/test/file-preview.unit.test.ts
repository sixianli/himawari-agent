import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { AnswerFiles } from "../src/components/answer-footer.js";
import { ContentPreview, type ContentPreviewValue } from "../src/components/content-preview.js";
import { recentGroups } from "../src/components/thread-sidebar.js";
import { parseDelimited } from "../src/delimited-text.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { messages as en } from "../src/i18n/resources/en.js";
import { messages as ja } from "../src/i18n/resources/ja.js";
import { messages as zh } from "../src/i18n/resources/zh-CN.js";
import { greetingOf } from "../src/thread-control-center.js";
import { lineDiff, previewKind, turnFiles } from "../src/turn-files.js";

let sequence = 0;
const tool = (
  itemId: string,
  name: string,
  input: unknown,
  phase: ThreadExecutionRecord["phase"] = "completed",
): ThreadExecutionRecord => ({
  id: `${itemId}:${phase}:${++sequence}`,
  itemId,
  sequence,
  kind: "tool",
  phase,
  name,
  text: "",
  input: typeof input === "string" ? input : JSON.stringify(input),
  output: "",
  occurredAt: "2026-10-26T12:00:00.000Z",
});

const preview = (value: ContentPreviewValue) =>
  renderToStaticMarkup(
    h(
      IntlProvider,
      { locale: "zh-CN", messages: zh },
      h(ContentPreview, { value, onClose: () => {} }),
    ),
  );

const ids = (id: MessageId, values?: Record<string, string | number | boolean | Date>) =>
  values ? `${id}(${Object.values(values).join(",")})` : id;

describe("files written in a turn", () => {
  it("[UI-18] follows a write and later edits to the final text, with real line counts", () => {
    const files = turnFiles("run:1", [
      tool("w1", "write", { path: "notes/trip.md", content: "# 东京\n\n第一天\n第二天\n" }),
      tool("e1", "edit", {
        path: "notes/trip.md",
        edits: [{ oldText: "第二天\n", newText: "第二天：浅草\n第三天：涩谷\n" }],
      }),
      tool("w2", "write", { path: "broken.ts", content: "x" }, "failed"),
    ]);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toMatchObject({
      key: "run:1:notes/trip.md",
      name: "trip.md",
      kind: "markdown",
      content: "# 东京\n\n第一天\n第二天：浅草\n第三天：涩谷\n",
      added: 2,
      removed: 1,
      recorded: true,
    });
    expect(file?.diff.filter((line) => line.sign !== " ")).toEqual([
      { sign: "-", text: "第二天" },
      { sign: "+", text: "第二天：浅草" },
      { sign: "+", text: "第三天：涩谷" },
    ]);
  });

  it("[UI-18] keeps a card when the record was cut short, but marks the content as missing", () => {
    const cut = `${JSON.stringify({ path: "/work/big.csv", content: "a,b\n" }).slice(0, 30)}\n[… truncated]`;
    const [file] = turnFiles("run:1", [tool("w1", "write", cut)]);
    expect(file).toMatchObject({
      name: "big.csv",
      kind: "csv",
      content: undefined,
      recorded: false,
    });
  });

  it("[UI-18] diffs by line and picks a viewer from the file name", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { sign: " ", text: "a" },
      { sign: "-", text: "b" },
      { sign: " ", text: "c" },
      { sign: "+", text: "d" },
    ]);
    expect(["a.md", "a.CSV", "a.html", "a.ts", "README", "a.log"].map(previewKind)).toEqual([
      "markdown",
      "csv",
      "html",
      "code",
      "text",
      "text",
    ]);
    expect(parseDelimited('名称,价格\n"东京, 塔",1,200\n"说""好""",3\r\n')).toEqual([
      ["名称", "价格"],
      ["东京, 塔", "1", "200"],
      ['说"好"', "3"],
    ]);
  });

  it("[UI-18] lists the files under the answer and marks the one that is open", () => {
    const files = turnFiles("run:1", [
      tool("w1", "write", { path: "poem.md", content: "一\n二\n三" }),
      tool("e1", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y\nz" }] }),
    ]);
    const html = renderToStaticMarkup(
      h(AnswerFiles, { files, openKey: "run:1:poem.md", onOpen: () => {}, message: ids }),
    );
    expect(html).toContain("poem.md");
    expect(html).toContain("files.kind.markdown · files.lines(3)");
    expect(html).toContain('<span class="is-added">+2</span> <span class="is-removed">−1</span>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("files.opened");
    expect(html.match(/files\.open</g)).toHaveLength(1);
  });
});

describe("the preview panel", () => {
  it("[UI-18] reads Markdown like a reader app, with a table of contents for the sections", () => {
    const html = preview({
      key: "k",
      title: "trip.md",
      path: "notes/trip.md",
      kind: "markdown",
      text: "# 东京三日\n\n## 第一天\n\n浅草\n\n## 第二天\n\n- [x] 订票",
    });
    expect(html).toContain('class="preview-toc"');
    expect(html.match(/<button type="button">第[一二]天<\/button>/g)).toHaveLength(2);
    expect(html).toContain('class="file-reader"');
    expect(html).toContain("<h1>东京三日</h1>");
    expect(html).toContain('aria-pressed="true">预览</button>');
    expect(html).toContain("原文</button>");
    expect(html).toContain("notes/trip.md");
    expect(html).toContain('aria-label="放宽预览"');
  });

  it("[UI-18] shows CSV as a table with row numbers, right-aligned numbers and a total", () => {
    const html = preview({
      title: "budget.csv",
      kind: "csv",
      text: '项目,金额,占比\n酒店,"1,200",60%\n交通,800,40%\n',
    });
    expect(html).toContain('<td class="row-number">2</td>');
    expect(html).toContain('<td class="is-number">1,200</td>');
    expect(html).toContain(
      '<td class="row-number">合计</td><td></td><td class="is-number">2,000</td><td class="is-number"></td>',
    );
  });

  it("[UI-18] shows code with line numbers, changes as an added and removed list, and says when content is missing", () => {
    const code = preview({
      title: "a.ts",
      path: "src/a.ts",
      kind: "code",
      text: "const a = 1;\nconst b = 2;\n",
    });
    expect(code.match(/class="preview-line"/g)).toHaveLength(2);
    expect(code).not.toContain("preview-tabs");
    const edit = preview({
      title: "a.ts",
      path: "src/a.ts",
      kind: "code",
      text: "",
      missing: true,
      diff: [
        { sign: "-", text: "x" },
        { sign: "+", text: "y" },
      ],
    });
    expect(edit).toContain("这一轮只改了文件的一部分");
    expect(edit).toContain('class="preview-line is-removed" data-sign="-">x</span>');
    expect(edit).toContain('class="preview-line is-added" data-sign="+">y</span>');
    const page = preview({ title: "a.html", path: "a.html", kind: "html", text: "<p>hi</p>" });
    expect(page).toContain("网页文件先显示源码");
    expect(preview({ title: "big.csv", kind: "csv", text: "", missing: true })).toContain(
      "这个文件超过 64K 字",
    );
  });
});

describe("sidebar and new conversation", () => {
  it("[UI-19] groups conversations into today, yesterday and earlier, by local date", () => {
    const now = new Date(2026, 9, 26, 9, 30);
    const at = (day: number, hour: number) => ({
      id: `${day}-${hour}`,
      updatedAt: new Date(2026, 9, day, hour).toISOString(),
    });
    const groups = recentGroups([at(26, 1), at(25, 23), at(25, 0), at(20, 12)], now);
    expect(groups.map(([id, items]) => [id, items.map((item) => item.id)])).toEqual([
      ["threads.today", ["26-1"]],
      ["threads.yesterday", ["25-23", "25-0"]],
      ["threads.earlier", ["20-12"]],
    ]);
    expect(recentGroups([at(26, 1)], now).map(([id]) => id)).toEqual(["threads.today"]);
  });

  it("[UI-20] greets by the time of day", () => {
    expect(
      [4, 5, 11, 12, 17, 18, 23].map((hour) => greetingOf(new Date(2026, 9, 26, hour))),
    ).toEqual([
      "chat.greetEvening",
      "chat.greetMorning",
      "chat.greetMorning",
      "chat.greetAfternoon",
      "chat.greetAfternoon",
      "chat.greetEvening",
      "chat.greetEvening",
    ]);
  });

  it.each([
    ["zh-CN", zh],
    ["en", en],
    ["ja", ja],
  ])("[UI-21] has every phase three text in %s", (_locale, catalog) => {
    const keys = Object.keys(zh).filter((key) =>
      /^(files\.|preview\.|threads\.(today|yesterday|earlier)$|nav\.memory$|chat\.greet)/.test(key),
    );
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const key of keys) expect((catalog as Record<string, string>)[key]).toBeTruthy();
  });
});
