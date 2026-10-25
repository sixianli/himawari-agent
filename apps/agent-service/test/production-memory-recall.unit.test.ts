import type {
  ProductMemoryRecord,
  RuntimeRequest,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { expect, it, vi } from "vitest";
import { ProductionMemoryRecall } from "../src/production-memory-recall.js";

const ownerId = "owner-recall" as RuntimeRequest["ownerId"];
const agentId = "agent-recall" as RuntimeRequest["agentId"];
const now = "2026-10-25T03:00:00.000Z";

function record(
  id: string,
  dataClassification: ProductMemoryRecord["dataClassification"],
  attributes: Partial<NonNullable<ProductMemoryRecord["attributes"]>> = {},
): ProductMemoryRecord {
  return {
    id,
    ownerId,
    agentId,
    status: "active",
    dataClassification,
    contentRef: `text-${id}`,
    providerRecordId: `provider-${id}`,
    attributes,
    updatedAt: "2026-10-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
  } as unknown as ProductMemoryRecord;
}

const texts: Record<string, string> = {
  "text-old": "主人用 iPhone 13",
  "text-new": "主人用 Pixel 9",
  "text-health": "主人对青霉素过敏",
};

function recall() {
  const records = [
    record("old", "private", {
      supersededBy: "new" as never,
      validTo: "2026-10-20T00:00:00.000Z",
    }),
    record("new", "private"),
    record("health", "sensitive"),
  ];
  const search = vi.fn(async () =>
    records.map((memory) => ({
      productMemoryId: memory.id,
      providerRecordId: memory.providerRecordId,
      score: 1,
    })),
  );
  const episodes = vi.fn(async () => []);
  const slots: string[] = [];
  const service = new ProductionMemoryRecall({
    ownerId,
    agentId,
    provider: { search } as never,
    state: { readMany: async () => records },
    episodes: { search: episodes },
    readText: async (memory) => texts[memory.contentRef],
    embedWithin: async (_invocation, slot, operation) => {
      slots.push(slot);
      return operation();
    },
    now: () => now,
    timeZone: "Asia/Tokyo",
  });
  return { service, search, episodes, slots };
}

const call = (args: RuntimeToolInvocation["arguments"]): RuntimeToolInvocation => ({
  runId: "run-recall" as RuntimeToolInvocation["runId"],
  toolCallId: "call-recall",
  capabilityRef: "memory.recall",
  capabilityHandleRef: null,
  arguments: args,
  dataClassification: "private",
});

it("marks corrected memories as history and hides classifications above the run", async () => {
  const f = recall();
  const result = (await f.service.recall(call({ query: "我以前用什么手机" }))) as {
    memories: { text: string; current: boolean; correctedLater?: boolean }[];
  };
  expect(result.memories).toEqual([
    expect.objectContaining({ text: "主人用 iPhone 13", current: false, correctedLater: true }),
    expect.objectContaining({ text: "主人用 Pixel 9", current: true }),
  ]);
  expect(f.search).toHaveBeenCalledWith(
    expect.objectContaining({ scope: expect.objectContaining({ includeHistory: true }) }),
  );
  expect(f.episodes).toHaveBeenCalledWith(
    expect.objectContaining({ allowedClassifications: ["public", "private"] }),
  );
  expect(f.slots).toEqual(["memory-recall", "memory-recall-episodes"]);
});

it("turns explicit dates into the owner's local day bounds", async () => {
  const f = recall();
  const result = (await f.service.recall(
    call({ query: "那天聊了什么", from: "2026-10-23", to: "2026-10-23" }),
  )) as { window: { from: string; to: string } };
  expect(result.window).toMatchObject({
    from: "2026-10-22T15:00:00.000Z",
    to: "2026-10-23T14:59:59.999Z",
  });
});

it.each([
  { query: "" },
  { query: "x", from: "10/23" },
  { query: "x", limit: 11 },
  { query: "x", other: true },
])("rejects invalid arguments %j", async (args) => {
  await expect(recall().service.recall(call(args))).rejects.toThrow("MEMORY_RECALL_INPUT_INVALID");
});
