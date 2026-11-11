import type { MemoryItem } from "./memory.js";

export const REMINDER_SOURCE_PREFIX = "memory-content:reminder:";
export const EXTERNAL_PROPOSAL_MEMORY_PREFIX = "memory:mcp:";

export type MemorySourceState =
  | "jump"
  | "reminder"
  | "owner"
  | "external"
  | "import"
  | "deleted"
  | "tidy"
  | "unavailable";

export function memorySourceState(
  item: Pick<
    MemoryItem,
    "memoryId" | "importBatchId" | "sourceThreadId" | "sourceMessageId" | "sourceRefs" | "history"
  >,
): MemorySourceState {
  if (item.importBatchId) return "import";
  if (item.memoryId.startsWith("memory:owner:")) return "owner";
  if (item.memoryId.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX)) return "external";
  if (item.sourceThreadId) {
    if (item.sourceMessageId) return "jump";
    return item.sourceRefs.length > 0 &&
      item.sourceRefs.every((ref) => ref.startsWith(REMINDER_SOURCE_PREFIX))
      ? "reminder"
      : "unavailable";
  }
  return item.history[0]?.sourceDeleted ? "deleted" : "tidy";
}

export function memorySourceCounts(items: readonly MemoryItem[]): {
  readonly unavailable: number;
  readonly importedWithoutQuote: number;
} {
  let unavailable = 0;
  let importedWithoutQuote = 0;
  for (const item of items) {
    if (item.status === "trashed") continue;
    const state = memorySourceState(item);
    if (state === "unavailable") unavailable += 1;
    if (state === "import") importedWithoutQuote += 1;
  }
  return { unavailable, importedWithoutQuote };
}
