import { type Unzipped, unzipSync } from "fflate";
import { isImageFile } from "./attachment-image.js";
import type { AttachmentKind } from "./draft-attachments.js";
import { pdfDocumentFontOptions } from "./pdf-document-options.js";

export const ATTACHMENT_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_TEXT_LIMIT = 256 * 1024;
export const ATTACHMENT_ACCEPT = [
  "text/*",
  ".txt,.md,.csv,.tsv,.json,.yaml,.yml,.toml,.ini,.xml,.html,.css,.log",
  ".ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql",
  ".pdf,.docx,.xlsx,.pptx",
  "image/png,image/jpeg,image/webp,image/gif",
].join(",");

const TRUNCATED_NOTE = "\n[后面的内容太长，已截断]";

export function attachmentKind(file: File): AttachmentKind | null {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (extension === "docx") return "word";
  if (extension === "xlsx") return "excel";
  if (extension === "pptx") return "powerpoint";
  if (isImageFile(file)) return "image";
  if (
    file.type.startsWith("image/") ||
    file.type.startsWith("audio/") ||
    file.type.startsWith("video/")
  )
    return null;
  if (["doc", "xls", "ppt", "zip", "gz", "exe", "dmg", "heic"].includes(extension)) return null;
  return "text";
}

export async function extractAttachmentText(
  file: File,
): Promise<{ readonly kind: AttachmentKind; readonly text: string; readonly truncated: boolean }> {
  const kind = attachmentKind(file);
  if (!kind || kind === "image") throw new Error("ATTACHMENT_UNSUPPORTED");
  if (file.size > ATTACHMENT_FILE_LIMIT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const raw = await extract(kind, bytes);
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error("ATTACHMENT_EMPTY");
  if (text.length <= ATTACHMENT_TEXT_LIMIT) return { kind, text, truncated: false };
  return {
    kind,
    text: text.slice(0, ATTACHMENT_TEXT_LIMIT - TRUNCATED_NOTE.length) + TRUNCATED_NOTE,
    truncated: true,
  };
}

async function extract(kind: Exclude<AttachmentKind, "image">, bytes: Uint8Array): Promise<string> {
  switch (kind) {
    case "text":
      return plainText(bytes);
    case "pdf":
      return pdfText(bytes);
    case "word":
      return wordText(archive(bytes));
    case "excel":
      return excelText(archive(bytes));
    case "powerpoint":
      return slidesText(archive(bytes));
  }
}

function plainText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ATTACHMENT_UNSUPPORTED");
  }
  const control = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 9 || (code > 13 && code < 32);
  });
  if (control) throw new Error("ATTACHMENT_UNSUPPORTED");
  return text;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await import("pdfjs-dist");
  if (!pdf.GlobalWorkerOptions.workerSrc)
    pdf.GlobalWorkerOptions.workerSrc = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
  const task = pdf.getDocument({ data: bytes, ...pdfDocumentFontOptions });
  try {
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch {
      throw new Error("ATTACHMENT_UNSUPPORTED");
    }
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const content = await (await document.getPage(number)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      pages.push(`[第 ${number} 页]\n${text}`);
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

function archive(bytes: Uint8Array): Unzipped {
  try {
    return unzipSync(bytes, {
      filter: (entry) => entry.name.endsWith(".xml") || entry.name.endsWith(".rels"),
    });
  } catch {
    throw new Error("ATTACHMENT_UNSUPPORTED");
  }
}

function xml(files: Unzipped, path: string): Document | null {
  const entry = files[path];
  if (!entry) return null;
  const document = new DOMParser().parseFromString(
    new TextDecoder().decode(entry),
    "application/xml",
  );
  return document.getElementsByTagName("parsererror").length ? null : document;
}

const elements = (node: Document | Element, name: string) => [...node.getElementsByTagName(name)];

function paragraphs(node: Document | Element, paragraph: string, run: string): string {
  return elements(node, paragraph)
    .map((item) =>
      [...item.getElementsByTagName("*")]
        .map((child) =>
          child.tagName === run
            ? child.textContent
            : child.tagName === "w:tab"
              ? "\t"
              : child.tagName === "w:br"
                ? "\n"
                : "",
        )
        .join(""),
    )
    .join("\n");
}

function wordText(files: Unzipped): string {
  const document = xml(files, "word/document.xml");
  if (!document) throw new Error("ATTACHMENT_UNSUPPORTED");
  return paragraphs(document, "w:p", "w:t");
}

function slidesText(files: Unzipped): string {
  const slides = Object.keys(files)
    .map((path) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(path))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .sort((left, right) => Number(left[1]) - Number(right[1]));
  if (!slides.length) throw new Error("ATTACHMENT_UNSUPPORTED");
  return slides
    .map((match) => {
      const document = xml(files, match[0]);
      return `[第 ${match[1]} 张幻灯片]\n${document ? paragraphs(document, "a:p", "a:t") : ""}`;
    })
    .join("\n\n");
}

function excelText(files: Unzipped): string {
  const workbook = xml(files, "xl/workbook.xml");
  const relations = xml(files, "xl/_rels/workbook.xml.rels");
  if (!workbook || !relations) throw new Error("ATTACHMENT_UNSUPPORTED");
  const shared = xml(files, "xl/sharedStrings.xml");
  const strings = shared
    ? elements(shared, "si").map((item) =>
        elements(item, "t")
          .map((t) => t.textContent)
          .join(""),
      )
    : [];
  const targets = new Map(
    elements(relations, "Relationship").map((item) => [
      item.getAttribute("Id"),
      item.getAttribute("Target") ?? "",
    ]),
  );
  return elements(workbook, "sheet")
    .map((sheet) => {
      const target = targets.get(sheet.getAttribute("r:id")) ?? "";
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      const document = xml(files, path);
      const rows = document
        ? elements(document, "row").map((row) =>
            elements(row, "c")
              .map((cell) => {
                const type = cell.getAttribute("t");
                if (type === "inlineStr")
                  return elements(cell, "t")
                    .map((t) => t.textContent)
                    .join("");
                const value = elements(cell, "v")[0]?.textContent ?? "";
                return type === "s" ? (strings[Number(value)] ?? "") : value;
              })
              .join("\t"),
          )
        : [];
      return `## ${sheet.getAttribute("name") ?? ""}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}
