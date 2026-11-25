import type { RuntimeProjection } from "@himawari-agent/application/runtime-port";
import {
  CHAT_MEMORY_CHANGE_ADDED,
  CHAT_MEMORY_CHANGE_CHANGED,
  CHAT_MEMORY_CHANGE_REMOVED,
  CHAT_MEMORY_SNAPSHOT_MARKER,
  MEMORY_SNAPSHOT_HEADER,
  MEMORY_SNAPSHOT_OMITTED,
  MEMORY_SNAPSHOT_REACHABLE_HEADER,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";

type ContextBlock = RuntimeProjection["contextBlocks"][number];

export const MEMORY_SNAPSHOT_KIND = "memory-snapshot";
export const MEMORY_CHANGES_KIND = "memory-changes";
export const MEMORY_SNAPSHOT_MESSAGE_TYPE = "himawari.memory-snapshot";

const CONTEXT_OPEN = "<himawari-context>\n";
const CONTEXT_CLOSE = "\n</himawari-context>\n";

interface SnapshotEntry {
  readonly section: string;
  readonly line: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userTexts(message: Record<string, unknown>): string[] {
  const content = message["content"];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    record(item) && item["type"] === "text" && typeof item["text"] === "string"
      ? [item["text"]]
      : [],
  );
}

function snapshotIn(text: string): string | undefined {
  const marker = `${CHAT_MEMORY_SNAPSHOT_MARKER.text}\n`;
  const start = text.lastIndexOf(marker);
  if (start < 0) return undefined;
  const content = text.slice(start + marker.length);
  const endHeader = `\n${MEMORY_SNAPSHOT_REACHABLE_HEADER.text}\n`;
  const reachable = content.indexOf(endHeader);
  if (reachable < 0) return undefined;
  const after = content.slice(reachable + endHeader.length);
  const stop = after.search(/\n(?!- )/u);
  return content.slice(0, reachable + endHeader.length + (stop < 0 ? after.length : stop));
}

export function previousMemorySnapshot(messages: readonly unknown[]): string | undefined {
  let start = 0;
  messages.forEach((message, index) => {
    if (
      record(message) &&
      (message["role"] === "compactionSummary" || message["role"] === "branchSummary")
    )
      start = index + 1;
  });
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (!record(message)) continue;
    if (
      message["role"] === "custom" &&
      message["customType"] === MEMORY_SNAPSHOT_MESSAGE_TYPE &&
      typeof message["content"] === "string"
    ) {
      const found = snapshotIn(message["content"]);
      if (found !== undefined) return found;
      continue;
    }
    if (message["role"] !== "user") continue;
    for (const text of userTexts(message).reverse()) {
      if (!text.startsWith(CONTEXT_OPEN)) continue;
      const end = text.indexOf(CONTEXT_CLOSE);
      const found = snapshotIn(end < 0 ? text : text.slice(0, end + 1));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function entries(snapshot: string): Map<number, SnapshotEntry> {
  const found = new Map<number, SnapshotEntry>();
  let section = "";
  for (const line of snapshot.split("\n")) {
    if (line === MEMORY_SNAPSHOT_REACHABLE_HEADER.text) break;
    if (line === MEMORY_SNAPSHOT_HEADER.text) continue;
    const match = /^(\d+)/u.exec(line);
    if (!match?.[1]) {
      section = line;
      continue;
    }
    found.set(Number(match[1]), { section, line });
  }
  return found;
}

const OMITTED_TAIL = MEMORY_SNAPSHOT_OMITTED.segments
  .flatMap((segment) => (segment.kind === "text" ? [segment.text] : []))
  .at(-1);

function hasOmissions(snapshot: string): boolean {
  return OMITTED_TAIL !== undefined && snapshot.includes(OMITTED_TAIL);
}

export function memoryChanges(previous: string, current: string): string | undefined {
  const before = entries(previous);
  const after = entries(current);
  const reportRemovals = !hasOmissions(current);
  const numbers = [...new Set([...before.keys(), ...after.keys()])].sort(
    (left, right) => left - right,
  );
  const lines: string[] = [];
  for (const number of numbers) {
    const old = before.get(number);
    const now = after.get(number);
    if (now && !old)
      lines.push(renderPrompt(CHAT_MEMORY_CHANGE_ADDED, { category: now.section, line: now.line }));
    else if (now && old && (now.line !== old.line || now.section !== old.section))
      lines.push(
        renderPrompt(CHAT_MEMORY_CHANGE_CHANGED, { category: now.section, line: now.line }),
      );
    else if (old && !now && reportRemovals)
      lines.push(renderPrompt(CHAT_MEMORY_CHANGE_REMOVED, { line: old.line }));
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function splitMemorySnapshot(projection: RuntimeProjection): {
  readonly blocks: readonly ContextBlock[];
  readonly snapshot: ContextBlock | undefined;
  readonly changes: ContextBlock | undefined;
} {
  const snapshots = projection.contextBlocks.filter(({ kind }) => kind === MEMORY_SNAPSHOT_KIND);
  if (snapshots.length > 1) throw new TypeError("RUNTIME_PROJECTION_DUPLICATE_MEMORY_SNAPSHOT");
  const [current] = snapshots;
  const blocks = projection.contextBlocks.filter(({ kind }) => kind !== MEMORY_SNAPSHOT_KIND);
  if (!current) return { blocks, snapshot: undefined, changes: undefined };
  const previous = previousMemorySnapshot(projection.nativeHistory?.messages ?? []);
  if (previous === undefined) return { blocks, snapshot: current, changes: undefined };
  const changed = memoryChanges(previous, current.content);
  return {
    blocks,
    snapshot: undefined,
    changes: changed
      ? {
          authority: "non-authoritative",
          kind: MEMORY_CHANGES_KIND,
          ref: MEMORY_CHANGES_KIND,
          content: changed,
          dataClassification: current.dataClassification,
        }
      : undefined,
  };
}

export function memorySnapshotAfterCompaction(
  messages: readonly unknown[],
  projection: RuntimeProjection,
) {
  const snapshot = projection.contextBlocks.find(({ kind }) => kind === MEMORY_SNAPSHOT_KIND);
  if (!snapshot || previousMemorySnapshot(messages) !== undefined) return undefined;
  return {
    customType: MEMORY_SNAPSHOT_MESSAGE_TYPE,
    content: `${CHAT_MEMORY_SNAPSHOT_MARKER.text}\n${snapshot.content}`,
    display: false,
    details: {},
  };
}
