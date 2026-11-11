import { describe, expect, it } from "vitest";
import { memorySourceCounts, memorySourceState } from "../src/memory-source.ts";

const base = {
  importBatchId: null,
  sourceThreadId: null,
  sourceMessageId: null,
  sourceRefs: [] as string[],
  history: [],
};

describe("[P5-2] memory source of external proposals", () => {
  it("shows a memory proposed by an external agent as external and does not count it as unavailable", () => {
    const external = {
      ...base,
      memoryId: "memory:mcp:proposal-1",
      sourceRefs: ["memory-content:mcp:proposal-1"],
      status: "active",
    };
    expect(memorySourceState(external as never)).toBe("external");
    expect(memorySourceState({ ...base, memoryId: "memory:rule:mcp:proposal-2" } as never)).toBe(
      "external",
    );
    expect(memorySourceState({ ...base, memoryId: "memory:rule:owner-chat" } as never)).toBe(
      "tidy",
    );
    expect(memorySourceCounts([external] as never)).toEqual({
      unavailable: 0,
      importedWithoutQuote: 0,
    });
  });

  it("does not treat other memories as external", () => {
    expect(memorySourceState({ ...base, memoryId: "memory:owner:x" } as never)).toBe("owner");
    expect(memorySourceState({ ...base, memoryId: "memory:mcpx:1" } as never)).toBe("tidy");
  });
});
