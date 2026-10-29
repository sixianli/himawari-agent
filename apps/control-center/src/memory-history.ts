import type { MemoryItem } from "./memory.ts";

export type MemoryHistoryKind = MemoryItem["history"][number]["kind"];

export interface MemoryHistoryNode {
  readonly key: string;
  readonly record: MemoryItem;
  readonly kind: MemoryHistoryKind;
  readonly text: string;
  readonly stance: string | null;
  readonly quote: string | null;
  readonly sourceThreadId: string | null;
  readonly sourceDeleted: boolean;
  readonly at: string;
  readonly change: number;
  readonly current: boolean;
  readonly restorable: boolean;
}

export interface MemoryStanceChart {
  readonly lanes: readonly string[];
  readonly points: readonly { readonly lane: number; readonly node: MemoryHistoryNode }[];
}

export const MAXIMUM_STANCE_LANES = 4;

function recordNodes(record: MemoryItem): MemoryItem["history"] {
  return record.history.length
    ? record.history
    : [
        {
          kind: "created",
          text: record.text,
          stance: record.stance,
          quote: null,
          sourceThreadId: record.sourceThreadId,
          sourceDeleted: false,
          at: record.recordedAt,
        },
      ];
}

export function memoryChain(
  head: MemoryItem,
  memories: readonly MemoryItem[],
): readonly MemoryHistoryNode[] {
  const replacedBy = new Map<string, MemoryItem[]>();
  for (const item of memories)
    if (item.supersededBy)
      replacedBy.set(item.supersededBy, [...(replacedBy.get(item.supersededBy) ?? []), item]);
  const records: MemoryItem[] = [];
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length) {
    const record = queue.shift() as MemoryItem;
    if (seen.has(record.memoryId)) continue;
    seen.add(record.memoryId);
    records.push(record);
    queue.push(...(replacedBy.get(record.memoryId) ?? []));
  }
  const raw = records
    .flatMap((record, depth) =>
      recordNodes(record).map((node, index) => ({ record, node, index, depth })),
    )
    .sort((a, b) => a.node.at.localeCompare(b.node.at) || b.depth - a.depth || a.index - b.index);
  const lastWording = new Map<string, number>();
  raw.forEach((entry, position) => {
    if (entry.node.kind !== "reaffirmed") lastWording.set(entry.record.memoryId, position);
  });
  let change = -1;
  return raw.map((entry, position) => {
    if (entry.node.kind !== "reaffirmed" || change < 0) change += 1;
    return {
      key: `${entry.record.memoryId}:${entry.index}`,
      record: entry.record,
      kind: entry.node.kind,
      text: entry.node.text,
      stance: entry.node.stance,
      quote: entry.node.quote,
      sourceThreadId: entry.node.sourceThreadId,
      sourceDeleted: entry.node.sourceDeleted,
      at: entry.node.at,
      change,
      current: position === raw.length - 1,
      restorable:
        entry.record !== head &&
        entry.record.status === "active" &&
        lastWording.get(entry.record.memoryId) === position,
    };
  });
}

export function changeCount(chain: readonly MemoryHistoryNode[]): number {
  return chain.at(-1)?.change ?? 0;
}

export function stanceChart(chain: readonly MemoryHistoryNode[]): MemoryStanceChart | null {
  const marked = chain.filter((node) => node.stance);
  const lanes = [...new Set(marked.map((node) => node.stance as string))];
  if (lanes.length < 2 || lanes.length > MAXIMUM_STANCE_LANES) return null;
  return {
    lanes,
    points: marked.map((node) => ({ lane: lanes.indexOf(node.stance as string), node })),
  };
}

export function memoryHeads(memories: readonly MemoryItem[]): readonly MemoryItem[] {
  return memories.filter((item) => !item.supersededBy);
}
