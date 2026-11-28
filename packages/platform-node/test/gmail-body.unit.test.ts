import { describe, expect, it } from "vitest";
import {
  decodeMailBytes,
  extractGmailBody,
  GMAIL_BODY_HARD_LIMIT,
  type GmailPart,
} from "../src/gmail-body.ts";

const encode = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

const text = (mimeType: string, content: string | Uint8Array, charset = "UTF-8"): GmailPart => ({
  mimeType,
  headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }],
  body: { size: content.length, data: encode(content) },
});

const multipart = (mimeType: string, parts: GmailPart[]): GmailPart => ({ mimeType, parts });

describe("[OM-11] Gmail body extraction", () => {
  it("reads a plain text mail", () => {
    expect(extractGmailBody(text("text/plain", "金曜日までにお送りします。"))).toMatchObject({
      text: "金曜日までにお送りします。",
      truncated: false,
      unavailable: false,
      attachments: [],
    });
  });

  it("uses the html alternative when the plain one is only a stub, and does not repeat a real plain text", () => {
    const stub = extractGmailBody(
      multipart("multipart/alternative", [
        text("text/plain", "HTMLで表示してください"),
        text(
          "text/html",
          "<html><body><p>本物の本文です。金曜日までに報告します。</p></body></html>",
        ),
      ]),
    );
    expect(stub.text).toBe("本物の本文です。金曜日までに報告します。");
    const real = extractGmailBody(
      multipart("multipart/alternative", [
        text("text/plain", "これは十分に長い通常のテキスト本文です。確認をお願いします。"),
        text("text/html", "<p>これは十分に長い通常のテキスト本文です。確認をお願いします。</p>"),
      ]),
    );
    expect(real.text).toBe("これは十分に長い通常のテキスト本文です。確認をお願いします。");
  });

  it("lists attachments by name and never treats a text attachment as the body", () => {
    const result = extractGmailBody(
      multipart("multipart/mixed", [
        text("text/plain", "添付をご確認ください。"),
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { size: 5000, attachmentId: "att-1" },
        },
        {
          ...text("text/plain", "ATTACHED-TEXT-SECRET"),
          filename: "notes.txt",
        },
      ]),
    );
    expect(result.text).toBe("添付をご確認ください。");
    expect(result.attachments).toEqual([
      { filename: "invoice.pdf", mimeType: "application/pdf", size: 5000 },
      { filename: "notes.txt", mimeType: "text/plain", size: 20 },
    ]);
    expect(JSON.stringify(result)).not.toContain("ATTACHED-TEXT-SECRET");
  });

  it("marks the body unavailable when Gmail keeps it as a separate attachment instead of leaving it empty", () => {
    const result = extractGmailBody({
      mimeType: "text/plain",
      body: { size: 9_000_000, attachmentId: "body-att" },
    });
    expect(result).toMatchObject({ text: null, unavailable: true });
  });

  it("marks a mail without any text part as unavailable and a mail with only attachments as readable-by-name", () => {
    expect(extractGmailBody(undefined)).toMatchObject({ text: null, unavailable: true });
    expect(
      extractGmailBody(
        multipart("multipart/mixed", [
          { mimeType: "image/png", filename: "a.png", body: { size: 10, attachmentId: "x" } },
        ]),
      ),
    ).toMatchObject({ text: null, unavailable: false, attachments: [{ filename: "a.png" }] });
  });

  it("decodes ISO-2022-JP and Shift_JIS bodies by their declared character set", () => {
    const iso = Uint8Array.from([
      0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41, 0x24, 0x4f, 0x1b, 0x28,
      0x42,
    ]);
    expect(extractGmailBody(text("text/plain", iso, "iso-2022-jp")).text).toBe("こんにちは");
    const sjis = Uint8Array.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    expect(extractGmailBody(text("text/plain", sjis, "shift_jis")).text).toBe("こんにちは");
    expect(decodeMailBytes(new TextEncoder().encode("こんにちは"), "iso-2022-jp")).toBe(
      "こんにちは",
    );
  });

  it("drops scripts, styles, comments, hidden blocks, link targets, images and invisible characters from html", () => {
    const html = [
      "<html><head><title>TITLE-HIDDEN</title><style>.x{color:red}STYLE-HIDDEN</style></head><body>",
      "<!-- COMMENT-HIDDEN -->",
      "<script>SCRIPT-HIDDEN()</script>",
      '<p>見積もりは<a href="https://evil.example/track">こちら</a>です。</p>',
      '<div style="display:none">DISPLAY-NONE-HIDDEN</div>',
      '<div style="visibility: hidden">VISIBILITY-HIDDEN</div>',
      "<span hidden>ATTR-HIDDEN</span>",
      '<img src="https://evil.example/pixel.gif" alt="PIXEL-ALT">',
      "<p>金​曜‮日までに。</p>",
      "</body></html>",
    ].join("");
    const body = extractGmailBody(text("text/html", html)).text ?? "";
    expect(body).toContain("見積もりはこちらです。");
    expect(body).toContain("金曜日までに。");
    for (const hidden of [
      "TITLE-HIDDEN",
      "STYLE-HIDDEN",
      "COMMENT-HIDDEN",
      "SCRIPT-HIDDEN",
      "DISPLAY-NONE-HIDDEN",
      "VISIBILITY-HIDDEN",
      "ATTR-HIDDEN",
      "PIXEL-ALT",
      "evil.example",
    ])
      expect(body).not.toContain(hidden);
  });

  it("walks nested related and mixed parts in order", () => {
    const result = extractGmailBody(
      multipart("multipart/mixed", [
        multipart("multipart/related", [
          multipart("multipart/alternative", [
            text("text/plain", "最初のパートは十分に長い本文として書かれています。"),
          ]),
        ]),
        text("text/plain", "2 番目のパート"),
      ]),
    );
    expect(result.text).toBe(
      "最初のパートは十分に長い本文として書かれています。\n\n2 番目のパート",
    );
  });

  it("keeps head and tail of an enormous body and says it was cut", () => {
    const huge = `START-${"あ".repeat(GMAIL_BODY_HARD_LIMIT + 5_000)}-END`;
    const result = extractGmailBody(text("text/plain", huge));
    expect(result.truncated).toBe(true);
    expect(Array.from(result.text ?? "").length).toBeLessThanOrEqual(GMAIL_BODY_HARD_LIMIT);
    expect(result.text).toContain("START-");
    expect(result.text).toContain("-END");
  });

  it("[OM-17] masks a password that straddles the hard-limit cut before cutting", () => {
    const head = Math.floor(GMAIL_BODY_HARD_LIMIT * 0.7);
    const huge = `${"あ".repeat(head - 15)}密码：Qz7mWx42LpRs8Tv ${"あ".repeat(GMAIL_BODY_HARD_LIMIT)}`;
    const result = extractGmailBody(text("text/plain", huge));
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("Qz7m");
    expect(result.text).not.toContain("Rs8Tv");
  });
});
