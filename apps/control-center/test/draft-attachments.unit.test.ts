import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatComposer } from "../src/components/chat-composer.js";
import {
  ATTACHMENT_LIMIT_BYTES,
  joinDraft,
  readAttachment,
  splitDraft,
} from "../src/draft-attachments.js";
import { loadMessageCatalog } from "../src/i18n/runtime.js";

describe("[UI-14] files attached to a message", () => {
  it("keeps the typed text and each file apart, in the file block format Pi uses", () => {
    const draft = joinDraft("请分析\n", [
      { name: "notes.md", text: "内容\n第二行" },
      { name: "data.csv", text: "a,b\n1,2" },
    ]);
    expect(draft).toBe(
      '请分析\n\n\n<file name="notes.md">\n内容\n第二行\n</file>\n\n<file name="data.csv">\na,b\n1,2\n</file>',
    );
    expect(splitDraft(draft)).toEqual({
      text: "请分析\n",
      files: [
        { name: "notes.md", text: "内容\n第二行" },
        { name: "data.csv", text: "a,b\n1,2" },
      ],
    });
    expect(splitDraft(joinDraft("", [{ name: "a.txt", text: "x" }]))).toEqual({
      text: "",
      files: [{ name: "a.txt", text: "x" }],
    });
    expect(splitDraft('只是文字 <file name="x">')).toEqual({
      text: '只是文字 <file name="x">',
      files: [],
    });
  });

  it("reads text, code and table files and refuses the kinds it cannot read yet", async () => {
    expect(await readAttachment(new File(["print(1)\n"], 'a"b\n.py'))).toEqual({
      name: "ab.py",
      text: "print(1)\n",
    });
    await expect(readAttachment(new File([new Uint8Array([0xff, 0xd8])], "x.jpg"))).rejects.toThrow(
      "ATTACHMENT_UNSUPPORTED",
    );
    await expect(readAttachment(new File([new Uint8Array([0])], "x.bin"))).rejects.toThrow(
      "ATTACHMENT_UNSUPPORTED",
    );
    await expect(readAttachment(new File(["a\n</file>\nb"], "x.txt"))).rejects.toThrow(
      "ATTACHMENT_UNSUPPORTED",
    );
    await expect(
      readAttachment(new File(["x".repeat(ATTACHMENT_LIMIT_BYTES + 1)], "big.txt")),
    ).rejects.toThrow("ATTACHMENT_TOO_LARGE");
  });
});

describe("[UI-14] attached files on screen", () => {
  const ids = (id: string, values?: Record<string, string | number>) =>
    values ? `${id}(${Object.values(values).join(",")})` : id;
  it("shows only the typed text in the box and each file as a removable card", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, {
        draft: joinDraft("看看这个", [{ name: "notes.md", text: "第一行" }]),
        onDraft: () => {},
        onSubmit: () => {},
        connected: true,
        pending: false,
        model: "deepseek",
        models: [],
        modelRef: "",
        thinkingLevel: "",
        onModelChange: () => {},
        onThinkingChange: () => {},
        message: ids,
      }),
    );
    expect(html).toMatch(/<textarea[^>]*>看看这个<\/textarea>/);
    expect(html).toContain('class="attachment-name">notes.md</span><small>9 B</small>');
    expect(html).toContain('aria-label="chat.removeAttachment(notes.md)"');
    expect(html).toContain('title="chat.attachHint"');
    expect(html).toContain("multiple");
  });
});

it.each(["zh-CN", "en", "ja"] as const)(
  "[UI-15] has every phase two composer text in %s",
  async (locale) => {
    const catalog = await loadMessageCatalog(locale);
    const intl = createIntl(
      { locale, messages: catalog, onError: () => undefined },
      createIntlCache(),
    );
    const html = renderToStaticMarkup(
      createElement(ChatComposer, {
        draft: joinDraft("", [{ name: "a.csv", text: "1" }]),
        onDraft: () => {},
        onSubmit: () => {},
        connected: true,
        pending: false,
        model: "m",
        models: [],
        modelRef: "",
        thinkingLevel: "",
        onModelChange: () => {},
        onThinkingChange: () => {},
        message: (id, values) => intl.formatMessage({ id }, values),
        fresh: true,
      }),
    );
    expect(html).not.toMatch(/\bchat\.[a-zA-Z]/);
    for (const id of [
      "chat.attachHint",
      "chat.attachmentTooLarge",
      "chat.attachmentUnsupported",
      "chat.removeAttachment",
      "chat.placeholderNew",
      "chat.moreModels",
      "answer.tokens",
      "process.tokens",
    ] as const)
      expect(catalog[id]).toBeTruthy();
  },
);
