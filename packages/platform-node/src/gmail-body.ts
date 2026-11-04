import { maskSensitiveText, windowMailBody } from "@himawari-agent/application";
import { convert } from "html-to-text";

export const GMAIL_BODY_HARD_LIMIT = 200_000;
const PLAIN_TOO_SHORT = 20;

export interface GmailPartBody {
  readonly size?: number;
  readonly data?: string;
  readonly attachmentId?: string;
}

export interface GmailPart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly { readonly name?: string; readonly value?: string }[];
  readonly body?: GmailPartBody;
  readonly parts?: readonly GmailPart[];
}

export interface MailAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface ExtractedBody {
  readonly text: string | null;
  readonly truncated: boolean;
  readonly unavailable: boolean;
  readonly attachments: readonly MailAttachment[];
}

interface Collected {
  text: string;
  unavailable: boolean;
  readonly attachments: MailAttachment[];
}

const HTML_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "head", format: "skip" },
    { selector: "title", format: "skip" },
    { selector: "[hidden]", format: "skip" },
    { selector: '[aria-hidden="true"]', format: "skip" },
    { selector: '[style*="display:none"]', format: "skip" },
    { selector: '[style*="display: none"]', format: "skip" },
    { selector: '[style*="visibility:hidden"]', format: "skip" },
    { selector: '[style*="visibility: hidden"]', format: "skip" },
  ],
};

function isHiddenCodePoint(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0x7f ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

function stripHidden(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (!isHiddenCodePoint(code)) out += character;
  }
  return out;
}

function headerValue(part: GmailPart, name: string): string {
  return (
    part.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

function declaredCharset(part: GmailPart): string | undefined {
  const match = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/iu.exec(headerValue(part, "content-type"));
  return match?.[1];
}

function hasIso2022Escape(bytes: Uint8Array): boolean {
  for (let index = 0; index + 1 < bytes.length; index += 1)
    if (bytes[index] === 0x1b && (bytes[index + 1] === 0x24 || bytes[index + 1] === 0x28))
      return true;
  return false;
}

export function decodeMailBytes(bytes: Uint8Array, charset: string | undefined): string {
  if (hasIso2022Escape(bytes)) {
    try {
      return new TextDecoder("iso-2022-jp").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (charset !== undefined) {
      try {
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return new TextDecoder("utf-8").decode(bytes);
      }
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function tidy(text: string): string {
  return stripHidden(text)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function leafText(part: GmailPart, collected: Collected): string {
  const data = part.body?.data;
  if (data === undefined || data.length === 0) {
    if (part.body?.attachmentId !== undefined) collected.unavailable = true;
    return "";
  }
  const decoded = stripHidden(
    decodeMailBytes(Buffer.from(data, "base64url"), declaredCharset(part)),
  );
  if ((part.mimeType ?? "").toLowerCase() === "text/html")
    return tidy(convert(decoded, HTML_OPTIONS));
  return tidy(decoded);
}

function isAttachment(part: GmailPart): boolean {
  return (
    (part.filename ?? "").length > 0 ||
    /attachment/iu.test(headerValue(part, "content-disposition"))
  );
}

function walk(part: GmailPart, collected: Collected): string {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (isAttachment(part)) {
    collected.attachments.push(
      Object.freeze({
        filename: (part.filename ?? "").slice(0, 200),
        mimeType: mime.slice(0, 100),
        size: part.body?.size ?? 0,
      }),
    );
    return "";
  }
  if (part.parts !== undefined && part.parts.length > 0) {
    if (mime === "multipart/alternative") {
      let plain = "";
      let html = "";
      for (const child of part.parts) {
        const childMime = (child.mimeType ?? "").toLowerCase();
        const text = walk(child, collected);
        if (childMime === "text/plain" && text.length > plain.length) plain = text;
        else if (childMime !== "text/plain" && text.length > html.length) html = text;
      }
      return plain.length >= PLAIN_TOO_SHORT || html.length <= plain.length ? plain : html;
    }
    return part.parts
      .map((child) => walk(child, collected))
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
  if (mime === "text/plain" || mime === "text/html") return leafText(part, collected);
  return "";
}

export function extractGmailBody(payload: GmailPart | undefined): ExtractedBody {
  if (payload === undefined)
    return Object.freeze({ text: null, truncated: false, unavailable: true, attachments: [] });
  const collected: Collected = { text: "", unavailable: false, attachments: [] };
  const text = walk(payload, collected);
  if (text.length === 0)
    return Object.freeze({
      text: null,
      truncated: false,
      unavailable: collected.unavailable || collected.attachments.length === 0,
      attachments: Object.freeze(collected.attachments),
    });
  const windowed = windowMailBody(
    text.length > GMAIL_BODY_HARD_LIMIT ? maskSensitiveText(text) : text,
    GMAIL_BODY_HARD_LIMIT,
  );
  return Object.freeze({
    text: windowed.text,
    truncated: windowed.truncated,
    unavailable: false,
    attachments: Object.freeze(collected.attachments),
  });
}
