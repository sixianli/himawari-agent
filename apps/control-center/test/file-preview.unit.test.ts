import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import type { BackgroundCommandView } from "../src/background-commands.js";
import {
  ContentPreview,
  type ContentPreviewValue,
  previewOfDelivered,
} from "../src/components/content-preview.js";
import { DeliveredFileCards } from "../src/components/delivered-file.js";
import { latestFiles, libraryFile, libraryTime } from "../src/components/files-library.js";
import { recentGroups } from "../src/components/thread-sidebar.js";
import { parseDelimited } from "../src/delimited-text.js";
import { deliveredFileGroups } from "../src/delivered-files.js";
import type { RunSummary } from "../src/execution-view.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { messages as en } from "../src/i18n/resources/en.js";
import { messages as ja } from "../src/i18n/resources/ja.js";
import { messages as zh } from "../src/i18n/resources/zh-CN.js";
import { parseRegisteredFilePage, type RegisteredFile } from "../src/registered-files.js";
import { greetingOf, welcomeLinesOf } from "../src/thread-control-center.js";
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
  activity: "",
  activityIcon: "",
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
    const groups = deliveredFileGroups({
      runs: [{ runId: "run:1" } as RunSummary],
      execution: {
        "run:1": [
          tool("w1", "write", { path: "poem.md", content: "一\n二\n三" }),
          tool("e1", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y\nz" }] }),
        ],
      },
      registered: undefined,
      commands: [],
      titles: {},
    });
    const html = renderToStaticMarkup(
      h(DeliveredFileCards, {
        files: groups[0]?.files ?? [],
        openKey: "run:1:poem.md",
        onOpen: () => {},
        onMore: () => {},
        message: ids,
      }),
    );
    expect(html).toContain("poem.md");
    expect(html).toContain("files.kind.document · files.lines(3)");
    expect(html).toContain("files.kind.code · +2 −1");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("files.opened");
  });
});

const registered = (overrides: Partial<RegisteredFile>): RegisteredFile => ({
  id: "file:1",
  threadId: "thread:1",
  runId: "run:1",
  toolCallId: "call:1",
  toolItemId: "item:1",
  source: "write",
  path: "report.md",
  name: "report.md",
  kind: "document",
  mediaType: "text/markdown",
  sizeBytes: 2048,
  version: 1,
  turn: 1,
  commandKey: null,
  stored: true,
  overlapped: false,
  createdAt: "2026-10-28T06:12:00.000Z",
  deleted: false,
  ...overrides,
});

describe("file preview header", () => {
  it.each([
    ["zh-CN", zh, "新标签打开", "下载", "放宽预览", "文件信息", "关闭"],
    ["en", en, "Open in new tab", "Download", "Widen preview", "File info", "Close"],
    ["ja", ja, "新しいタブで開く", "ダウンロード", "プレビューを広げる", "ファイル情報", "閉じる"],
  ] as const)(
    "shows icon-only actions named by aria-label and hover tip in %s",
    (locale, messages, ...labels) => {
      const file = libraryFile(
        registered({ name: "snake.html", path: "snake.html", kind: "web", mediaType: "text/html" }),
      );
      const html = renderToStaticMarkup(
        h(
          IntlProvider,
          { locale, messages },
          h(ContentPreview, {
            value: previewOfDelivered(file),
            access: {
              text: async () => "",
              bytes: async () => new ArrayBuffer(0),
              versions: async () => [],
              previewUrl: async () => "https://preview.example/snake.html",
            },
            onClose: () => {},
          }),
        ),
      );
      const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
      for (const label of labels) {
        expect(header).toContain(`aria-label="${label}" data-tip="${label}"`);
        expect(header).not.toContain(`>${label}<`);
      }
      expect(html).not.toContain('class="preview-meta"');
    },
  );
});

describe("[FD-5] files delivered in a conversation", () => {
  it("joins registered copies with the turn trace and files a background command's output under its report turn", () => {
    const runs = ["run:1", "run:2", "run:3"].map((runId) => ({ runId }) as RunSummary);
    const commands = [
      {
        key: "background-command:abc",
        runId: "run:2",
        label: "npm test -- --coverage\nsecond line",
        noticeRunId: "run:3",
      } as BackgroundCommandView,
    ];
    const groups = deliveredFileGroups({
      runs,
      execution: {
        "run:1": [
          tool("w1", "write", { path: "/workspace/snake.html", content: "<p>1</p>" }),
          tool("w2", "write", { path: "/workspace/notes.md", content: "# 笔记" }),
        ],
        "run:2": [tool("b1", "bash", { command: "npm test -- --coverage" })],
      },
      registered: [
        registered({
          id: "file:snake:2",
          runId: "run:1",
          toolItemId: "w1",
          path: "snake.html",
          name: "snake.html",
          kind: "web",
          mediaType: "text/html",
          version: 2,
        }),
        registered({
          id: "file:snake:1",
          runId: "run:1",
          path: "snake.html",
          name: "snake.html",
          kind: "web",
          mediaType: "text/html",
          version: 1,
        }),
        registered({
          id: "file:coverage",
          runId: "run:2",
          source: "bash",
          path: "coverage/summary.csv",
          name: "summary.csv",
          kind: "data",
          mediaType: "text/csv",
          commandKey: "background-command:abc",
        }),
      ],
      commands,
      titles: { "run:1": "做一个贪吃蛇" },
    });
    expect(groups.map((group) => [group.runId, group.turn, group.command])).toEqual([
      ["run:3", 3, "npm test -- --coverage"],
      ["run:1", 1, undefined],
    ]);
    expect(groups[0]?.files.map((file) => [file.path, file.source, file.command])).toEqual([
      ["coverage/summary.csv", "bash", "npm test -- --coverage"],
    ]);
    const first = groups[1]?.files ?? [];
    expect(first.map((file) => [file.path, file.versions, file.registered?.id])).toEqual([
      ["snake.html", 2, "file:snake:2"],
      ["/workspace/notes.md", 1, undefined],
    ]);
    expect(first[0]?.trace?.path).toBe("/workspace/snake.html");
  });

  it("shows three cards under an answer and folds the rest into one button", () => {
    const files = [1, 2, 3, 4, 5].map((index) =>
      libraryFile(registered({ id: `file:${index}`, path: `f${index}.md`, name: `f${index}.md` })),
    );
    const html = renderToStaticMarkup(
      h(DeliveredFileCards, {
        files,
        openKey: undefined,
        onOpen: () => {},
        onMore: () => {},
        message: ids,
      }),
    );
    expect(html.match(/class="file-card"/g)).toHaveLength(3);
    expect(html).toContain('class="file-more">files.more(2)</button>');
    expect(html).not.toContain("f4.md");
  });

  it.each([
    [{ kind: "image", mediaType: "image/png", name: "route.png" }, "<img"],
    [{ kind: "pdf", mediaType: "application/pdf", name: "trip.pdf" }, "正在读取文件…"],
    [
      {
        kind: "document",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        name: "日本新闻头条.docx",
      },
      "正在读取文件…",
    ],
    [
      {
        kind: "data",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        name: "新闻来源统计.xlsx",
      },
      "正在读取文件…",
    ],
    [
      {
        kind: "document",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        name: "big.docx",
        sizeBytes: 26 * 1024 * 1024,
      },
      "文件太大",
    ],
    [
      {
        kind: "document",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        name: "deck.pptx",
      },
      "这种文件不能在这里预览",
    ],
    [{ kind: "web", mediaType: "text/html", name: "snake.html" }, "网页预览还没开通"],
    [{ kind: "other", mediaType: "application/zip", name: "a.zip" }, "这种文件不能在这里预览"],
    [{ kind: "document", stored: false }, "没有留副本"],
  ] as const)("picks the preview body for %o", (overrides, expected) => {
    const file = libraryFile(registered({ id: "file:x", ...overrides }));
    const html = preview(
      previewOfDelivered(file, { label: "来自「贪吃蛇」第 1 轮", onOpen: () => {} }),
    );
    expect(html).toContain(expected);
    expect(html).not.toContain("来自「贪吃蛇」第 1 轮 →");
    expect(html).toContain('aria-label="文件信息" data-tip="文件信息" aria-expanded="false"');
    if (overrides.kind === "image") expect(html).toContain('src="/api/files/v1/content/file%3Ax"');
    expect(html).not.toContain("<iframe");
  });

  it("keeps the download link in the header and the version picker inside file info", () => {
    const file = { ...libraryFile(registered({ id: "file:v3", version: 3 })), versions: 3 };
    const html = preview(previewOfDelivered(file));
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).toContain('href="/api/files/v1/content/file%3Av3?download=1"');
    expect(html).not.toContain('class="preview-versions"');
  });

  it("[FD-1] shows no card for a file that was deleted, and the files page drops it", () => {
    const runs = [{ runId: "run:1" } as RunSummary];
    const groups = deliveredFileGroups({
      runs,
      execution: {
        "run:1": [tool("w1", "write", { path: "/workspace/draft.md", content: "# 草稿" })],
      },
      registered: [
        registered({ id: "kept", runId: "run:1", path: "final.docx", name: "final.docx" }),
        registered({
          id: "gone",
          runId: "run:1",
          toolItemId: "w1",
          path: "draft.md",
          name: "draft.md",
          deleted: true,
        }),
        registered({
          id: "gone-bash",
          runId: "run:1",
          path: "old.docx",
          name: "old.docx",
          deleted: true,
        }),
      ],
      commands: [],
      titles: {},
    });
    expect(groups.flatMap((group) => group.files.map((file) => file.path))).toEqual(["final.docx"]);
    expect(
      latestFiles([
        registered({ id: "g2", path: "old.docx", version: 2, deleted: true }),
        registered({ id: "g1", path: "old.docx", version: 1 }),
        registered({ id: "k1", path: "final.docx" }),
      ]).map((item) => item.id),
    ).toEqual(["k1"]);
  });

  it("keeps the newest version of each file on the files page and dates older ones", () => {
    const items = parseRegisteredFilePage({
      items: [
        registered({ id: "a2", version: 2 }),
        registered({ id: "a1", version: 1 }),
        registered({ id: "b1", threadId: "thread:2" }),
      ],
      nextCursor: null,
    }).items;
    expect(latestFiles(items).map((item) => item.id)).toEqual(["a2", "b1"]);
    const now = new Date("2026-10-28T08:00:00.000Z");
    expect(libraryTime("2026-10-28T06:12:00.000Z", now, ids)).toMatch(/^more\.time/);
    expect(libraryTime("2026-10-24T06:12:00.000Z", now, ids)).toMatch(/^library\.date/);
    expect(() => parseRegisteredFilePage({ items: [{ ...items[0], kind: "exe" }] })).toThrow(
      "CONTROL_CENTER_RESPONSE_INVALID",
    );
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
    expect(html).toContain(
      'class="preview-action preview-tool preview-widen" aria-label="放宽预览" data-tip="放宽预览" aria-pressed="false"><svg',
    );
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

  it("[UI-20] picks the welcome line from the general set plus one line for mornings and late nights", () => {
    const at = (hour: number) => welcomeLinesOf(new Date(2026, 9, 26, hour));
    expect(at(8)).toContain("chat.welcome.morning");
    expect(at(8)).not.toContain("chat.welcome.late");
    expect(at(23)).toContain("chat.welcome.late");
    expect(at(2)).toContain("chat.welcome.late");
    expect(at(15)).toEqual([
      "chat.welcome.here",
      "chat.welcome.hand",
      "chat.welcome.remember",
      "chat.welcome.stuck",
    ]);
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
