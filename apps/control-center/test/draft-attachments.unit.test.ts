import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatComposer } from "../src/components/chat-composer.js";
import { type DraftAttachment, joinDraft, splitDraft } from "../src/draft-attachments.js";
import { loadMessageCatalog } from "../src/i18n/runtime.js";

const report: DraftAttachment = {
  name: "报告.pdf",
  ref: "payload:http:abc",
  bytes: 2_400_000,
  kind: "pdf",
  truncated: true,
};
const notes: DraftAttachment = {
  name: "notes.md",
  ref: "payload:http:def",
  bytes: 9,
  kind: "text",
  truncated: false,
};

describe("[UI-16] files attached to a message", () => {
  it("keeps the typed text and a short reference to each uploaded file, never the file text", () => {
    const draft = joinDraft("请分析\n", [report, notes]);
    expect(draft).toBe(
      '请分析\n\n\n<file name="报告.pdf" ref="payload:http:abc" bytes="2400000" kind="pdf" truncated="1"/>\n\n<file name="notes.md" ref="payload:http:def" bytes="9" kind="text"/>',
    );
    expect(splitDraft(draft)).toEqual({ text: "请分析\n", files: [report, notes] });
    expect(splitDraft(joinDraft("", [notes]))).toEqual({ text: "", files: [notes] });
    expect(splitDraft('只是文字 <file name="x" ref="y"/>')).toEqual({
      text: '只是文字 <file name="x" ref="y"/>',
      files: [],
    });
  });
});

describe("[UI-16] attached files on screen", () => {
  const ids = (id: string, values?: Record<string, string | number>) =>
    values ? `${id}(${Object.values(values).join(",")})` : id;
  const composer = (message: typeof ids, draft = joinDraft("看看这个", [report])) =>
    renderToStaticMarkup(
      createElement(ChatComposer, {
        draft,
        onDraft: () => {},
        onSubmit: () => {},
        onUpload: async () => "payload:http:new",
        connected: true,
        pending: false,
        model: "deepseek",
        models: [],
        modelRef: "",
        thinkingLevel: "",
        onModelChange: () => {},
        onThinkingChange: () => {},
        message,
        fresh: true,
      }),
    );
  it("shows only the typed text in the box and each file as a removable card", () => {
    const html = composer(ids);
    expect(html).toMatch(/<textarea[^>]*>看看这个<\/textarea>/);
    expect(html).toContain('class="attachment-name">报告.pdf</span><small>2.3 MB</small>');
    expect(html).toContain('title="chat.attachmentTruncated"');
    expect(html).toContain('aria-label="chat.removeAttachment(报告.pdf)"');
    expect(html).toContain('title="chat.attachHint"');
    expect(html).toContain(".pdf,.docx,.xlsx,.pptx");
    expect(html).toContain("multiple");
  });

  it.each(["zh-CN", "en", "ja"] as const)(
    "[UI-15] has every phase two composer text in %s",
    async (locale) => {
      const catalog = await loadMessageCatalog(locale);
      const intl = createIntl(
        { locale, messages: catalog, onError: () => undefined },
        createIntlCache(),
      );
      const html = composer((id, values) => intl.formatMessage({ id }, values));
      expect(html).not.toMatch(/\bchat\.[a-zA-Z]/);
      for (const id of [
        "chat.attachHint",
        "chat.attachmentTooLarge",
        "chat.attachmentUnsupported",
        "chat.attachmentEmpty",
        "chat.attachmentUploadFailed",
        "chat.attachmentReading",
        "chat.attachmentTruncated",
        "chat.removeAttachment",
        "chat.placeholderNew",
        "chat.moreModels",
        "process.tokens",
        "process.cacheHit",
      ] as const)
        expect(catalog[id]).toBeTruthy();
    },
  );
});
