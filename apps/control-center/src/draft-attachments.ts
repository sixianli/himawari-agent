export type AttachmentKind = "text" | "pdf" | "word" | "excel" | "powerpoint" | "image";

export interface DraftAttachment {
  readonly name: string;
  readonly ref: string;
  readonly bytes: number;
  readonly kind: AttachmentKind;
  readonly truncated: boolean;
}

export const MESSAGE_LIMIT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 10;

const SEPARATOR = "\n\n";
const OPEN = '<file name="';
const CLOSE = "/>";
const KINDS: readonly AttachmentKind[] = ["text", "pdf", "word", "excel", "powerpoint", "image"];
const TAG =
  /^<file name="([^"<>\n]*)" ref="([^"<>\s]+)" bytes="(\d+)" kind="([a-z]+)"( truncated="1")?\/>$/;

export const draftBytes = (draft: string) => new TextEncoder().encode(draft).length;

export const attachmentName = (name: string) => name.replace(/["<>\r\n]/g, "").trim() || "file";

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function joinDraft(text: string, files: readonly DraftAttachment[]): string {
  return [
    ...(text ? [text] : []),
    ...files.map(
      (file) =>
        `${OPEN}${file.name}" ref="${file.ref}" bytes="${file.bytes}" kind="${file.kind}"${file.truncated ? ' truncated="1"' : ""}${CLOSE}`,
    ),
  ].join(SEPARATOR);
}

export function splitDraft(draft: string): { text: string; files: DraftAttachment[] } {
  const files: DraftAttachment[] = [];
  let rest = draft;
  while (rest.endsWith(CLOSE)) {
    const start = rest.lastIndexOf(OPEN);
    const tag = start < 0 ? null : TAG.exec(rest.slice(start));
    const before = start < 0 ? "" : rest.slice(0, start);
    const kind = tag?.[4] as AttachmentKind | undefined;
    if (!tag || !kind || !KINDS.includes(kind) || (start > 0 && !before.endsWith(SEPARATOR))) break;
    files.unshift({
      name: tag[1] ?? "",
      ref: tag[2] ?? "",
      bytes: Number(tag[3]),
      kind,
      truncated: Boolean(tag[5]),
    });
    rest = start > 0 ? before.slice(0, -SEPARATOR.length) : "";
  }
  return { text: rest, files };
}
