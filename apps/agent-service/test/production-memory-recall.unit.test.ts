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
    sourceRefs: [`message-${id}`],
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
  "text-sealed": "受限内容",
};

function recall() {
  const records = [
    record("old", "private", {
      supersededBy: "new" as never,
      validTo: "2026-10-20T00:00:00.000Z",
    }),
    record("new", "private"),
    record("health", "sensitive"),
    record("sealed", "restricted"),
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

it("[RULE-memory-visible] marks corrected memories as history, shows sensitive memories in a private run and never restricted ones", async () => {
  const f = recall();
  const { output, contentClassification } = await f.service.recallWithClassification(
    call({ query: "我以前用什么手机", includeHistory: true }),
  );
  const result = output as {
    memories: { text: string; current: boolean; correctedLater?: boolean }[];
  };
  expect(result.memories).toEqual([
    expect.objectContaining({ text: "主人用 iPhone 13", current: false, correctedLater: true }),
    expect.objectContaining({ text: "主人用 Pixel 9", current: true }),
    expect.objectContaining({ text: "主人对青霉素过敏", current: true }),
  ]);
  expect(contentClassification).toBe("sensitive");
  expect(f.search).toHaveBeenCalledWith(
    expect.objectContaining({ scope: expect.objectContaining({ includeHistory: true }) }),
  );
  expect(f.episodes).toHaveBeenCalledWith(
    expect.objectContaining({ allowedClassifications: ["public", "private", "sensitive"] }),
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
    sourceRefs?: readonly string[];
  }[],
  dedupeSameSource?: boolean,
) {
  const records = entries.map(({ id, tentative, classification, sourceRefs }) => ({
    ...record(id, classification ?? "private", tentative ? { tentative: true } : {}),
    sourceRefs: sourceRefs ?? [`message-${id}`],
  }));
  const search = vi.fn(async (request: { includeTentative?: boolean; tentativeOnly?: boolean }) =>
    entries
      .map(({ id, score, tentative }) => ({
        productMemoryId: id,
        providerRecordId: `provider-${id}`,
        score,
        tentative: tentative === true,
      }))
      .filter(({ tentative }) =>
        request.tentativeOnly === true
          ? tentative
          : request.includeTentative === true || !tentative,
      )
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
    ...(dedupeSameSource === undefined ? {} : { dedupeSameSource }),
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
  expect(f.search).toHaveBeenCalledTimes(2);
  expect(f.search.mock.calls[0]?.[0]).not.toHaveProperty("includeTentative");
  expect(f.search.mock.calls[1]?.[0]).toMatchObject({
    includeTentative: true,
    tentativeOnly: true,
  });
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
  const searchCallsBefore = f.search.mock.calls.length;
  await f.service.recall(call({ query: "x", limit: 1 }));
  expect(f.search.mock.calls.length - searchCallsBefore).toBe(1);
});

it("[PA-2][RULE-memory-visible] REVERSE: a restricted tentative memory is never returned, a sensitive one is", async () => {
  const sealed = recallWith([
    { id: "secret", text: "受限猜测", score: 9, tentative: true, classification: "restricted" },
    { id: "fact", text: "事实", score: 1 },
  ]);
  const result = (await sealed.service.recall(call({ query: "x", limit: 4 }))) as RecallResult;
  expect(result.memories.map(({ text }) => text)).toEqual(["事实"]);
  expect(result).not.toHaveProperty("tentativeNote");
  const sensitive = recallWith([
    { id: "secret", text: "敏感猜测", score: 9, tentative: true, classification: "sensitive" },
    { id: "fact", text: "事实", score: 1 },
  ]);
  const shown = await sensitive.service.recallWithClassification(call({ query: "x", limit: 4 }));
  expect((shown.output as RecallResult).memories.map(({ text }) => text)).toEqual([
    "事实",
    "敏感猜测",
  ]);
  expect(shown.contentClassification).toBe("sensitive");
});

it("[RULE-memory-visible] reports the run's own classification when only private memories are shown", async () => {
  const f = recallWith([{ id: "fact", text: "事实", score: 1 }]);
  expect(
    (await f.service.recallWithClassification(call({ query: "x", limit: 4 })))
      .contentClassification,
  ).toBe("private");
});

it("[PA-2] REVERSE: a failing tentative search never takes the confirmed results down with it", async () => {
  const f = recallWith([{ id: "fact", text: "主人住在杭州", score: 1 }]);
  f.search.mockImplementation(async (request: { tentativeOnly?: boolean }) => {
    if (request.tentativeOnly === true) throw new Error("INDEX_FAILED");
    return [{ productMemoryId: "fact", providerRecordId: "provider-fact", score: 1 }];
  });
  const result = (await f.service.recall(call({ query: "x", limit: 4 }))) as RecallResult;
  expect(result.memories.map(({ text }) => text)).toEqual(["主人住在杭州"]);
  expect(result).not.toHaveProperty("tentativeNote");
});

it("asks both recall searches for the relevance cutoff", async () => {
  const f = recallWith([{ id: "fact", text: "主人住在杭州", score: 1 }]);
  await f.service.recall(call({ query: "我住在哪", limit: 4 }));
  expect(f.search.mock.calls.map(([request]) => request)).toEqual([
    expect.objectContaining({ relevanceCutoff: true }),
    expect.objectContaining({ relevanceCutoff: true, tentativeOnly: true }),
  ]);
});

it("drops a same-source near duplicate, refills the slot and lets a confirmed memory replace its tentative twin", async () => {
  const entries = [
    { id: "guess", text: "主人的妻子叫苏晴", score: 5, tentative: true, sourceRefs: ["m1"] },
    { id: "wife", text: "主人的妻子叫苏晴。", score: 4, sourceRefs: ["m1"] },
    { id: "wife-again", text: "主人的妻子叫苏晴", score: 3, sourceRefs: ["m1"] },
    { id: "daughter", text: "主人的女儿叫小禾", score: 2, sourceRefs: ["m1"] },
    { id: "home", text: "主人住在杭州", score: 1, sourceRefs: ["m2"] },
  ];
  const deduped = (await recallWith(entries, true).service.recall(
    call({ query: "我家里人", limit: 4 }),
  )) as RecallResult;
  expect(deduped.memories.map(({ text }) => text)).toEqual([
    "主人的妻子叫苏晴。",
    "主人的女儿叫小禾",
    "主人住在杭州",
  ]);
  expect(deduped.memories.some(({ tentative }) => tentative === true)).toBe(false);
  const byDefault = (await recallWith(entries).service.recall(
    call({ query: "我家里人", limit: 4 }),
  )) as RecallResult;
  expect(byDefault.memories).toEqual(deduped.memories);
  const plain = (await recallWith(entries, false).service.recall(
    call({ query: "我家里人", limit: 4 }),
  )) as RecallResult;
  expect(plain.memories.map(({ text }) => text)).toEqual([
    "主人的妻子叫苏晴。",
    "主人的妻子叫苏晴",
    "主人的女儿叫小禾",
    "主人的妻子叫苏晴",
  ]);
});

it("lets a confirmed memory replace its tentative twin even when every slot is taken, keeping the confirmed order", async () => {
  const entries = [
    { id: "guess", text: "主人的妻子叫苏晴", score: 5, tentative: true, sourceRefs: ["m1"] },
    { id: "home", text: "主人住在杭州", score: 4, sourceRefs: ["m2"] },
    { id: "wife", text: "主人的妻子叫苏晴。", score: 3, sourceRefs: ["m1"] },
  ];
  const deduped = (await recallWith(entries, true).service.recall(
    call({ query: "我家里人", limit: 2 }),
  )) as RecallResult;
  expect(deduped.memories.map(({ text }) => text)).toEqual(["主人住在杭州", "主人的妻子叫苏晴。"]);
  expect(deduped.memories.some(({ tentative }) => tentative === true)).toBe(false);
  expect(deduped.tentativeNote).toBeUndefined();
  const plain = (await recallWith(entries, false).service.recall(
    call({ query: "我家里人", limit: 2 }),
  )) as RecallResult;
  expect(plain.memories).toEqual([
    expect.objectContaining({ text: "主人住在杭州" }),
    expect.objectContaining({ text: "主人的妻子叫苏晴", tentative: true }),
  ]);
  expect(plain.tentativeNote).toBeDefined();
});

it("refills a tentative slot freed by a confirmed twin from the remaining tentative candidates", async () => {
  const entries = [
    { id: "guess-wife", text: "主人的妻子叫苏晴", score: 6, tentative: true, sourceRefs: ["m1"] },
    { id: "guess-job", text: "主人在杭州做设计师", score: 5, tentative: true, sourceRefs: ["m2"] },
    {
      id: "guess-pet",
      text: "主人家里养了一只橘猫",
      score: 4,
      tentative: true,
      sourceRefs: ["m3"],
    },
    { id: "wife", text: "主人的妻子叫苏晴。", score: 3, sourceRefs: ["m1"] },
  ];
  const deduped = (await recallWith(entries, true).service.recall(
    call({ query: "我家里人", limit: 4 }),
  )) as RecallResult;
  expect(deduped.memories.map(({ text }) => text)).toEqual([
    "主人的妻子叫苏晴。",
    "主人在杭州做设计师",
    "主人家里养了一只橘猫",
  ]);
});

it("[P5-1] reports a failed confirmed search only after the tentative search has finished", async () => {
  const finished: string[] = [];
  const service = new ProductionMemoryRecall({
    ownerId,
    agentId,
    provider: {
      search: async (request: { tentativeOnly?: boolean }) => {
        if (request.tentativeOnly !== true) throw new Error("VECTOR_INDEX_DOWN");
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished.push("tentative");
        return [];
      },
    } as never,
    state: { readMany: async () => [] },
    readText: async () => undefined,
    embedWithin: async (_invocation, _slot, operation) => operation(),
    now: () => now,
    timeZone: "Asia/Tokyo",
  });
  await expect(
    service.recallOutsideRun({ query: "x", limit: 4 }, (_slot, op) => op(), "sensitive"),
  ).rejects.toThrow("VECTOR_INDEX_DOWN");
  expect(finished).toEqual(["tentative"]);
});

it("[ADR-0257] reports a shown memory that was written with external content in context, and only then", async () => {
  const marked = recallWith([
    {
      id: "a",
      text: "群里说下周改会议",
      score: 2,
      sourceRefs: ["m1", "external-content:a|web_fetch"],
    },
    { id: "b", text: "主人住在杭州", score: 1 },
  ]);
  expect(
    (await marked.service.recallWithClassification(call({ query: "会议", limit: 4 })))
      .externalContent,
  ).toBe(true);
  const plain = recallWith([{ id: "b", text: "主人住在杭州", score: 1 }]);
  expect(
    (await plain.service.recallWithClassification(call({ query: "杭州", limit: 4 })))
      .externalContent,
  ).toBe(false);
});

it("[T6] reads the time window only from what the model filled, never from the words of the query", async () => {
  const f = recall();
  await f.service.recallWithClassification(call({ query: "我以前用什么手机，昨天说过的" }));
  expect(f.search.mock.calls.length).toBeGreaterThan(0);
  for (const [request] of f.search.mock.calls as unknown as [{ scope: unknown }][])
    expect(request.scope).toEqual({ includeHistory: false, from: null, to: null });
  f.search.mockClear();
  await f.service.recallWithClassification(call({ query: "手机", includeHistory: true }));
  expect(f.search.mock.calls.length).toBeGreaterThan(0);
  for (const [request] of f.search.mock.calls as unknown as [{ scope: unknown }][])
    expect(request.scope).toEqual({ includeHistory: true, from: null, to: null });
  f.search.mockClear();
  await f.service.recallWithClassification(
    call({ query: "手机", from: "2026-10-23", to: "2026-10-24" }),
  );
  expect(f.search.mock.calls.length).toBeGreaterThan(0);
  for (const [request] of f.search.mock.calls as unknown as [{ scope: unknown }][])
    expect(request.scope).toEqual({
      includeHistory: true,
      from: "2026-10-22T15:00:00.000Z",
      to: "2026-10-24T14:59:59.999Z",
    });
  for (const dates of [
    { from: "2026-13-40" },
    { from: "2026-02-30" },
    { from: "2026-10-24", to: "2026-10-23" },
  ])
    await expect(
      f.service.recallWithClassification(call({ query: "手机", ...dates })),
    ).rejects.toThrow("MEMORY_RECALL_INPUT_INVALID");
});
