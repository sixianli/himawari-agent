import type { RuntimeProjection } from "@himawari-agent/application/runtime-port";
import {
  CHAT_MEMORY_CHANGE_ADDED,
  CHAT_MEMORY_CHANGE_CHANGED,
  CHAT_MEMORY_CHANGE_REMOVED,
  CHAT_MEMORY_CHANGES_MARKER,
  CHAT_MEMORY_SNAPSHOT_MARKER,
  MEMORY_SNAPSHOT_HEADER,
  MEMORY_SNAPSHOT_OMITTED,
  MEMORY_SNAPSHOT_REACHABLE_HEADER,
  type PromptEntry,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { CONTEXT_MARKER_PREFIXES } from "./runtime-environment-block.js";

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
  const marker = `\n${CHAT_MEMORY_SNAPSHOT_MARKER.text}\n`;
  const source = `\n${text}`;
  const start = source.lastIndexOf(marker);
  if (start < 0) return undefined;
  const content = source.slice(start + marker.length);
  const endHeader = `\n${MEMORY_SNAPSHOT_REACHABLE_HEADER.text}\n`;
  const reachable = content.indexOf(endHeader);
  if (reachable < 0) return undefined;
  const after = content.slice(reachable + endHeader.length);
  const stop = after.search(/\n(?!- )/u);
  return content.slice(0, reachable + endHeader.length + (stop < 0 ? after.length : stop));
}

function changesIn(context: string): string | undefined {
  const marker = `\n${CHAT_MEMORY_CHANGES_MARKER.text}\n`;
  const start = context.lastIndexOf(marker);
  if (start < 0) return undefined;
  const content = context.slice(start + marker.length);
  const next = Math.min(
    ...CONTEXT_MARKER_PREFIXES.map((prefix) => content.indexOf(prefix)).filter(
      (index) => index >= 0,
    ),
  );
  return Number.isFinite(next) ? content.slice(0, next) : content;
}

function summaryEnd(messages: readonly unknown[]): number {
  let start = 0;
  messages.forEach((message, index) => {
    if (
      record(message) &&
      (message["role"] === "compactionSummary" || message["role"] === "branchSummary")
    )
      start = index + 1;
  });
  return start;
}

function contextOf(text: string): string | undefined {
  if (!text.startsWith(CONTEXT_OPEN)) return undefined;
  const end = text.indexOf(CONTEXT_CLOSE);
  return end < 0 ? text : text.slice(0, end + 1);
}

function snapshotMessage(message: Record<string, unknown>): string | undefined {
  return message["role"] === "custom" &&
    message["customType"] === MEMORY_SNAPSHOT_MESSAGE_TYPE &&
    typeof message["content"] === "string"
    ? snapshotIn(message["content"])
    : undefined;
}

export function previousMemorySnapshot(messages: readonly unknown[]): string | undefined {
  const start = summaryEnd(messages);
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (!record(message)) continue;
    if (message["role"] === "custom") {
      const found = snapshotMessage(message);
      if (found !== undefined) return found;
      continue;
    }
    if (message["role"] !== "user") continue;
    for (const text of userTexts(message).reverse()) {
      const context = contextOf(text);
      const found = context === undefined ? undefined : snapshotIn(context);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function textSegments(entry: Pick<PromptEntry, "id" | "segments">): string[] {
  return entry.segments.flatMap((segment) => (segment.kind === "text" ? [segment.text] : []));
}

const [ADDED_PREFIX = "", SECTION_CLOSE = ""] = textSegments(CHAT_MEMORY_CHANGE_ADDED);
const [CHANGED_PREFIX = ""] = textSegments(CHAT_MEMORY_CHANGE_CHANGED);
const [REMOVED_PREFIX = "", REMOVED_SUFFIX = ""] = textSegments(CHAT_MEMORY_CHANGE_REMOVED);

function numbered(line: string): number | undefined {
  const match = /^(\d+)/u.exec(line);
  return match?.[1] ? Number(match[1]) : undefined;
}

function sectionedChange(rest: string): (SnapshotEntry & { number: number }) | undefined {
  for (
    let close = rest.indexOf(SECTION_CLOSE);
    close >= 0;
    close = rest.indexOf(SECTION_CLOSE, close + 1)
  ) {
    const line = rest.slice(close + SECTION_CLOSE.length);
    const number = numbered(line);
    if (number !== undefined) return { number, section: rest.slice(0, close), line };
  }
  return undefined;
}

function applyChanges(known: Map<number, SnapshotEntry>, changes: string): void {
  for (const line of changes.split("\n")) {
    const prefix = [ADDED_PREFIX, CHANGED_PREFIX].find((candidate) => line.startsWith(candidate));
    if (prefix) {
      const change = sectionedChange(line.slice(prefix.length));
      if (change) known.set(change.number, { section: change.section, line: change.line });
      continue;
    }
    if (line.startsWith(REMOVED_PREFIX) && line.endsWith(REMOVED_SUFFIX)) {
      const number = numbered(line.slice(REMOVED_PREFIX.length));
      if (number !== undefined) known.delete(number);
    }
  }
}

function knownMemories(
  messages: readonly unknown[],
): ReadonlyMap<number, SnapshotEntry> | undefined {
  let known: Map<number, SnapshotEntry> | undefined;
  for (const message of messages.slice(summaryEnd(messages))) {
    if (!record(message)) continue;
    if (message["role"] === "custom") {
      const found = snapshotMessage(message);
      if (found !== undefined) known = entries(found);
      continue;
    }
    if (message["role"] !== "user") continue;
    for (const text of userTexts(message)) {
      const context = contextOf(text);
      if (context === undefined) continue;
      const found = snapshotIn(context);
      if (found !== undefined) {
        known = entries(found);
        continue;
      }
      const changes = known ? changesIn(context) : undefined;
      if (known && changes !== undefined) applyChanges(known, changes);
    }
  }
  return known;
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

const [OMITTED_PREFIX = "", OMITTED_COUNT = "", OMITTED_TAIL = ""] =
  textSegments(MEMORY_SNAPSHOT_OMITTED);

function omittedSections(snapshot: string): ReadonlySet<string> {
  const lines = snapshot.split("\n");
  const reachable = lines.indexOf(MEMORY_SNAPSHOT_REACHABLE_HEADER.text);
  const sections = new Set<string>();
  if (reachable < 0) return sections;
  for (const line of lines.slice(reachable + 1)) {
    if (!line.startsWith(OMITTED_PREFIX) || !line.endsWith(OMITTED_TAIL)) continue;
    const count = line.indexOf(OMITTED_COUNT, OMITTED_PREFIX.length);
    if (count >= 0) sections.add(line.slice(OMITTED_PREFIX.length, count));
  }
  return sections;
}

function changesSince(
  before: ReadonlyMap<number, SnapshotEntry>,
  current: string,
): string | undefined {
  const after = entries(current);
  const omitted = omittedSections(current);
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
    else if (old && !now && !omitted.has(old.section))
      lines.push(renderPrompt(CHAT_MEMORY_CHANGE_REMOVED, { line: old.line }));
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function memoryChanges(previous: string, current: string): string | undefined {
  return changesSince(entries(previous), current);
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
  const known = knownMemories(projection.nativeHistory?.messages ?? []);
  if (known === undefined) return { blocks, snapshot: current, changes: undefined };
  const changed = changesSince(known, current.content);
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
