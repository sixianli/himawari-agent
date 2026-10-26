export interface DraftAttachment {
  readonly name: string;
  readonly text: string;
}

export const ATTACHMENT_LIMIT_BYTES = 64 * 1024;

const SEPARATOR = "\n\n";
const OPEN = '<file name="';
const CLOSE = "\n</file>";
const BLOCK = /^<file name="([^"\n]*)">\n([\s\S]*)\n<\/file>$/;

export const draftBytes = (draft: string) => new TextEncoder().encode(draft).length;

export function joinDraft(text: string, files: readonly DraftAttachment[]): string {
  return [
    ...(text ? [text] : []),
    ...files.map((file) => `${OPEN}${file.name}">\n${file.text}${CLOSE}`),
  ].join(SEPARATOR);
}

export function splitDraft(draft: string): { text: string; files: DraftAttachment[] } {
  const files: DraftAttachment[] = [];
  let rest = draft;
  while (rest.endsWith(CLOSE)) {
    const start = rest.lastIndexOf(OPEN);
    const block = start < 0 ? null : BLOCK.exec(rest.slice(start));
    const before = start < 0 ? "" : rest.slice(0, start);
    if (!block || (start > 0 && !before.endsWith(SEPARATOR))) break;
    files.unshift({ name: block[1] ?? "", text: block[2] ?? "" });
    rest = start > 0 ? before.slice(0, -SEPARATOR.length) : "";
  }
  return { text: rest, files };
}

export async function readAttachment(file: File): Promise<DraftAttachment> {
  if (file.size > ATTACHMENT_LIMIT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error("ATTACHMENT_UNSUPPORTED");
  }
  const control = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 9 || (code > 13 && code < 32);
  });
  if (control || text.includes(OPEN) || text.includes("</file>"))
    throw new Error("ATTACHMENT_UNSUPPORTED");
  return { name: file.name.replace(/["<>\r\n]/g, "") || "file", text };
}

export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
