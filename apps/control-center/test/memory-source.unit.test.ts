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

describe("[ADR-0257] memory source of reminders written with external content", () => {
  it("keeps a reminder whose source refs also carry the external-content mark as a reminder", () => {
    const item = {
      ...base,
      memoryId: "memory:reminder:x",
      sourceThreadId: "thread-1",
      sourceRefs: ["memory-content:reminder:x", "external-content:memory:reminder:x|web_fetch"],
    };
    expect(memorySourceState(item as never)).toBe("reminder");
    expect(
      memorySourceState({
        ...item,
        sourceRefs: ["external-content:memory:reminder:x|web_fetch"],
      } as never),
    ).toBe("unavailable");
  });
});
