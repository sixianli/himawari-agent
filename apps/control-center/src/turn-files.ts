import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { executionItems } from "./execution-view.js";

export type PreviewKind = "markdown" | "csv" | "html" | "code" | "text";

export interface DiffLine {
  readonly sign: "+" | "-" | " ";
  readonly text: string;
}

export interface TurnFile {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly kind: PreviewKind;
  readonly content: string | undefined;
  readonly diff: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly recorded: boolean;
}

const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const CSV = new Set(["csv", "tsv"]);
const HTML = new Set(["html", "htm"]);
const TEXT = new Set(["txt", "log", ""]);
const DIFF_CELL_LIMIT = 4_000_000;

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(name: string): PreviewKind {
  const extension = fileExtension(name);
  return MARKDOWN.has(extension)
    ? "markdown"
    : CSV.has(extension)
      ? "csv"
      : HTML.has(extension)
        ? "html"
        : TEXT.has(extension)
          ? "text"
          : "code";
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const splitLines = (text: string) => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 1 && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

export function lineCount(text: string): number {
  return text ? splitLines(text).length : 0;
}

export function lineDiff(before: string, after: string): readonly DiffLine[] {
  const old = before ? splitLines(before) : [];
  const next = after ? splitLines(after) : [];
  if (old.length * next.length > DIFF_CELL_LIMIT)
    return [
      ...old.map((text) => ({ sign: "-" as const, text })),
      ...next.map((text) => ({ sign: "+" as const, text })),
    ];
  const width = next.length + 1;
  const common = new Uint32Array((old.length + 1) * width);
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = next.length - 1; j >= 0; j--)
      common[i * width + j] =
        old[i] === next[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < next.length) {
    if (old[i] === next[j]) {
      lines.push({ sign: " ", text: old[i] as string });
      i++;
      j++;
    } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) {
      lines.push({ sign: "-", text: old[i++] as string });
    } else {
      lines.push({ sign: "+", text: next[j++] as string });
    }
  }
  while (i < old.length) lines.push({ sign: "-", text: old[i++] as string });
  while (j < next.length) lines.push({ sign: "+", text: next[j++] as string });
  return lines;
}

function argumentsOf(input: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const recordedPath = (input: string) => /"path"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(input)?.[1];

export function turnFiles(
  runId: string,
  records: readonly ThreadExecutionRecord[],
): readonly TurnFile[] {
  const files = new Map<string, TurnFile>();
  for (const item of executionItems(records)) {
    if (item.kind !== "tool" || item.phase !== "completed") continue;
    if (item.name !== "write" && item.name !== "edit") continue;
    const args = argumentsOf(item.input);
    const path =
      typeof args?.["path"] === "string" ? args["path"].trim() : recordedPath(item.input);
    if (!path) continue;
    const previous = files.get(path);
    const name = baseName(path);
    const base = {
      key: `${runId}:${path}`,
      path,
      name,
      kind: previewKind(name),
    };
    if (item.name === "write") {
      const content = typeof args?.["content"] === "string" ? args["content"] : undefined;
      files.set(path, {
        ...base,
        content,
        diff: [],
        added: 0,
        removed: 0,
        recorded: content !== undefined,
      });
      continue;
    }
    const edits = (Array.isArray(args?.["edits"]) ? args["edits"] : []).map((edit) => {
      const entry = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : {};
      return {
        before: typeof entry["oldText"] === "string" ? entry["oldText"] : "",
        after: typeof entry["newText"] === "string" ? entry["newText"] : "",
      };
    });
    const diff = edits.flatMap(({ before, after }, index) => {
      const lines = lineDiff(before, after);
      return index ? [{ sign: " " as const, text: "⋯" }, ...lines] : lines;
    });
    const content = edits.reduce<string | undefined>(
      (text, { before, after }) =>
        text === undefined || !before || !text.includes(before)
          ? undefined
          : text.replace(before, () => after),
      previous?.content,
    );
    const added = diff.filter((line) => line.sign === "+").length;
    const removed = diff.filter((line) => line.sign === "-").length;
    files.set(path, {
      ...base,
      content,
      diff: [...(previous?.diff ?? []), ...diff],
      added: (previous?.added ?? 0) + added,
      removed: (previous?.removed ?? 0) + removed,
      recorded: Array.isArray(args?.["edits"]) && (previous?.recorded ?? true),
    });
  }
  return [...files.values()];
}
