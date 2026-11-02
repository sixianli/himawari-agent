import type { RuntimeRequest } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import {
  ProductionMemoryConsolidation,
  quoteRefOfMemory,
} from "../src/production-memory-consolidation.js";

const request = {
  ownerId: "owner",
  agentId: "agent",
  runId: "run-1",
  threadId: "thread",
  dataClassification: "sensitive",
} as unknown as RuntimeRequest;

function fixture(due = true) {
  const now = { value: "2026-10-25T03:00:00.000Z" };
  const slots: string[] = [];
  const generate = vi.fn(
    async (_request: RuntimeRequest, _prompt: string, admitted: () => void) => {
      admitted();
      return "{}";
    },
  );
  const run = vi.fn(
    async (
      input: Parameters<ProductionMemoryConsolidation["start"]>[0] & {
        search: (query: string, limit: number) => Promise<unknown>;
        generate: (prompt: string) => Promise<string>;
      },
    ) => {
      await input.search("a", 3);
      await input.search("b", 3);
      await input.generate("prompt");
      return { id: "c", modelCalled: true, changes: [] };
    },
  );
  const consolidation = new ProductionMemoryConsolidation({
    service: { due: async () => due, run: run as never },
    search: async () => [],
    assertActive: async () => {},
    generate,
    embedWithin: async (_request, slot, operation) => {
      slots.push(slot);
      return operation();
    },
    onFailure: (error) => {
      throw error;
    },
    now: () => now.value,
  });
  return { consolidation, run, generate, slots, now };
}

it("tidies once per hour at most, with a fresh embedding slot per search and a private model call", async () => {
  const f = fixture();
  await f.consolidation.start(request);
  await f.consolidation.stop();
  expect(f.slots).toEqual([
    "memory-consolidation-search-0:run-1",
    "memory-consolidation-search-1:run-1",
  ]);
  expect(f.generate).toHaveBeenCalledWith(
    expect.objectContaining({ dataClassification: "private" }),
    "prompt",
    expect.any(Function),
    "memory-consolidation",
  );
  const again = fixture();
  await again.consolidation.start(request);
  await again.consolidation.start({ ...request, runId: "run-2" } as RuntimeRequest);
  await new Promise((resolve) => setTimeout(resolve, 0));
  again.now.value = "2026-10-25T04:30:00.000Z";
  await again.consolidation.start({ ...request, runId: "run-3" } as RuntimeRequest);
  await again.consolidation.stop();
  expect(again.run).toHaveBeenCalledTimes(2);
});

it("does nothing when the day is already tidied or the run is a continuation", async () => {
  const f = fixture(false);
  await f.consolidation.start(request);
  await f.consolidation.start({
    ...request,
    runId: "run-2",
    continuationRef: "continuation",
  } as RuntimeRequest);
  await f.consolidation.stop();
  expect(f.run).not.toHaveBeenCalled();
});

describe("[MEM-QUOTE] picking the quote that produced a memory's current text", () => {
  const event = (contentRef: string, quoteRef: string | null, occurredAt: string) => ({
    contentRef,
    quoteRef,
    occurredAt,
  });

  it("takes the earliest quote stored for the current text, not a later re-mention or another revision", () => {
    const events = [
      event("text-2", "quote-3", "2026-10-05T00:00:00.000Z"),
      event("text-1", "quote-2", "2026-10-02T00:00:00.000Z"),
      event("text-1", "quote-1", "2026-10-01T00:00:00.000Z"),
      event("text-1", null, "2026-09-30T00:00:00.000Z"),
    ];
    expect(quoteRefOfMemory(events, "text-1")).toBe("quote-1");
    expect(quoteRefOfMemory(events, "text-2")).toBe("quote-3");
  });

  it("returns nothing when no event carries a quote for the current text", () => {
    expect(quoteRefOfMemory([event("text-1", null, "2026-10-01T00:00:00.000Z")], "text-1")).toBe(
      undefined,
    );
    expect(quoteRefOfMemory([], "text-1")).toBe(undefined);
  });
});
