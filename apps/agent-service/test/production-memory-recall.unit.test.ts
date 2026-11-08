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
  expect(f.slots).toEqual(["memory-recall", "memory-recall-tentative", "memory-recall-episodes"]);
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

function recallWith(
  entries: readonly {
    id: string;
    text: string;
    score: number;
    tentative?: boolean;
    classification?: ProductMemoryRecord["dataClassification"];
  }[],
) {
  const records = entries.map(({ id, tentative, classification }) =>
    record(id, classification ?? "private", tentative ? { tentative: true } : {}),
  );
  const search = vi.fn(async (request: { includeTentative?: boolean }) =>
    entries
      .map(({ id, score, tentative }) => ({
        productMemoryId: id,
        providerRecordId: `provider-${id}`,
        score,
        tentative: tentative === true,
      }))
      .filter(({ tentative }) => request.includeTentative === true || !tentative)
      .map(({ tentative: _tentative, ...hit }) => hit),
  );
  const service = new ProductionMemoryRecall({
    ownerId,
    agentId,
    provider: { search } as never,
    state: { readMany: async () => records },
    readText: async (memory) => entries.find(({ id }) => `text-${id}` === memory.contentRef)?.text,
    embedWithin: async (_invocation, _slot, operation) => operation(),
    now: () => now,
    timeZone: "Asia/Tokyo",
  });
  return { service, search };
}

type RecallResult = {
  memories: { text: string; tentative?: boolean }[];
  tentativeNote?: string;
};

it("[PA-2] chat recall returns tentative memories marked as tentative, after confirmed ones", async () => {
  const f = recallWith([
    { id: "guess", text: "主人偏好明治乳制品", score: 2, tentative: true },
    { id: "fact", text: "主人住在杭州", score: 1 },
  ]);
  const result = (await f.service.recall(call({ query: "牛奶", limit: 4 }))) as RecallResult;
  expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ includeTentative: true }));
  expect(result.memories.map(({ text }) => text)).toEqual(["主人住在杭州", "主人偏好明治乳制品"]);
  expect(result.memories[1]).toMatchObject({ tentative: true });
  expect(result.memories[0]).not.toHaveProperty("tentative");
  expect(result.tentativeNote).toContain("tentative");
});

it("[PA-2] REVERSE: with no tentative memory the result is exactly what it was before", async () => {
  const f = recallWith([
    { id: "a", text: "主人住在杭州", score: 3 },
    { id: "b", text: "主人用 Pixel 9", score: 2 },
  ]);
  const result = (await f.service.recall(call({ query: "x", limit: 5 }))) as RecallResult;
  expect(result).toEqual({
    query: "x",
    window: null,
    memories: [
      {
        text: "主人住在杭州",
        current: true,
        recordedAt: "2026-09-01T00:00:00.000Z",
        validFrom: null,
        validTo: null,
      },
      {
        text: "主人用 Pixel 9",
        current: true,
        recordedAt: "2026-09-01T00:00:00.000Z",
        validFrom: null,
        validTo: null,
      },
    ],
    conversations: [],
    note: expect.any(String),
  });
  expect(JSON.stringify(Object.keys(result))).toBe(
    '["query","window","memories","conversations","note"]',
  );
});

it("[PA-2] REVERSE: tentative memories take at most half of the requested slots and never push out confirmed hits", async () => {
  const f = recallWith([
    { id: "g1", text: "猜测一", score: 9, tentative: true },
    { id: "g2", text: "猜测二", score: 8, tentative: true },
    { id: "g3", text: "猜测三", score: 7, tentative: true },
    { id: "f1", text: "事实一", score: 3 },
    { id: "f2", text: "事实二", score: 2 },
    { id: "f3", text: "事实三", score: 1 },
  ]);
  const result = (await f.service.recall(call({ query: "x", limit: 4 }))) as RecallResult;
  expect(result.memories.map(({ text }) => text)).toEqual(["事实一", "事实二", "猜测一", "猜测二"]);
  const single = (await f.service.recall(call({ query: "x", limit: 1 }))) as RecallResult;
  expect(single.memories.map(({ text }) => text)).toEqual(["事实一"]);
  expect(single).not.toHaveProperty("tentativeNote");
});

it("[PA-2] REVERSE: a tentative memory above the run's data classification is not returned", async () => {
  const f = recallWith([
    { id: "secret", text: "敏感猜测", score: 9, tentative: true, classification: "sensitive" },
    { id: "fact", text: "事实", score: 1 },
  ]);
  const result = (await f.service.recall(call({ query: "x", limit: 4 }))) as RecallResult;
  expect(result.memories.map(({ text }) => text)).toEqual(["事实"]);
  expect(result).not.toHaveProperty("tentativeNote");
});
