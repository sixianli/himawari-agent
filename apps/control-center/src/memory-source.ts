import { memorySourceState } from "@himawari-agent/gateway-contracts";
import type { MemoryItem } from "./memory.js";

export { memorySourceState, type MemorySourceState } from "@himawari-agent/gateway-contracts";

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
