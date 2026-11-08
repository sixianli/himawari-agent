import type { MemoryItem } from "./memory.js";

export type MemorySourceState = "jump" | "owner" | "import" | "deleted" | "tidy" | "unavailable";

export function memorySourceState(
  item: Pick<
    MemoryItem,
    "memoryId" | "importBatchId" | "sourceThreadId" | "sourceMessageId" | "history"
  >,
): MemorySourceState {
  if (item.importBatchId) return "import";
  if (item.memoryId.startsWith("memory:owner:")) return "owner";
  if (item.sourceThreadId) return item.sourceMessageId ? "jump" : "unavailable";
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
