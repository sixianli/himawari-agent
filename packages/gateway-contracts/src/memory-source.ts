export const REMINDER_SOURCE_PREFIX = "memory-content:reminder:";

export type MemorySourceState =
  | "jump"
  | "reminder"
  | "owner"
  | "import"
  | "deleted"
  | "tidy"
  | "unavailable";

export interface MemorySourceFacts {
  readonly memoryId: string;
  readonly importBatchId: string | null;
  readonly sourceThreadId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceRefs: readonly string[];
  readonly history: readonly { readonly sourceDeleted: boolean }[];
}

export function memorySourceState(item: MemorySourceFacts): MemorySourceState {
  if (item.importBatchId) return "import";
  if (item.memoryId.startsWith("memory:owner:")) return "owner";
  if (item.sourceThreadId) {
    if (item.sourceMessageId) return "jump";
    return item.sourceRefs.length > 0 &&
      item.sourceRefs.every((ref) => ref.startsWith(REMINDER_SOURCE_PREFIX))
      ? "reminder"
      : "unavailable";
  }
  return item.history[0]?.sourceDeleted ? "deleted" : "tidy";
}
