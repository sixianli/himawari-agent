export const REMINDER_SOURCE_PREFIX = "memory-content:reminder:";
export const EXTERNAL_PROPOSAL_MEMORY_PREFIX = "memory:mcp:";
export const EXTERNAL_RULE_MEMORY_PREFIX = "memory:rule:mcp:";
export const EXTERNAL_CONTENT_SOURCE_REF_PREFIX = "external-content:";

export type MemorySourceState =
  | "jump"
  | "reminder"
  | "owner"
  | "external"
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
  if (
    item.memoryId.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX) ||
    item.memoryId.startsWith(EXTERNAL_RULE_MEMORY_PREFIX)
  )
    return "external";
  if (item.sourceThreadId) {
    if (item.sourceMessageId) return "jump";
    const refs = item.sourceRefs.filter(
      (ref) => !ref.startsWith(EXTERNAL_CONTENT_SOURCE_REF_PREFIX),
    );
    return refs.length > 0 && refs.every((ref) => ref.startsWith(REMINDER_SOURCE_PREFIX))
      ? "reminder"
      : "unavailable";
  }
  return item.history[0]?.sourceDeleted ? "deleted" : "tidy";
}
