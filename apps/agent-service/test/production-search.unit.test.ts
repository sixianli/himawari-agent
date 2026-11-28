import { DEFAULT_SEARCH_ASK, type ProductMemoryRecord } from "@himawari-agent/application";
import { expect, it, vi } from "vitest";
import { ProductionSearchControl, SEARCH_TEXT } from "../src/production-search.js";

const ownerId = "owner-search" as ProductMemoryRecord["ownerId"];
const agentId = "agent-search" as ProductMemoryRecord["agentId"];
const now = "2026-11-14T03:00:00.000Z";

function record(
  id: string,
  extra: Partial<ProductMemoryRecord> = {},
  attributes: Partial<NonNullable<ProductMemoryRecord["attributes"]>> = {},
): ProductMemoryRecord {
  return {
    id,
    ownerId,
    agentId,
    status: "active",
    dataClassification: "private",
    contentRef: `text-${id}`,
    sourceRefs: [],
    sourceThreadId: null,
    providerRecordId: `provider-${id}`,
    attributes: {
      category: "preference",
      entities: [],
      validTo: null,
      supersededBy: null,
      ...attributes,
    },
    updatedAt: "2026-10-22T00:00:00.000Z",
    recordedAt: "2026-10-21T03:00:00.000Z",
    ...extra,
  } as unknown as ProductMemoryRecord;
}

const texts: Record<string, string> = {
  "text-allergy": "我对花生过敏",
  "text-phone": "我用 iPhone 14 Pro",
  "text-secret": "我对青霉素过敏",
  "text-expired": "我对花粉过敏",
  "text-guess": "我可能对虾过敏",
};

function control(options: { episodes?: boolean } = {}) {
  const records = [
    record("allergy", { sourceThreadId: "thread-1" as never }, { entities: ["花生", "过敏"] }),
    record("phone", {}, { entities: ["iPhone"], category: "identity" }),
    record(
      "secret",
      { dataClassification: "sensitive" },
      { entities: ["青霉素"], category: "health" },
    ),
    record("expired", {}, { validTo: "2026-01-01T00:00:00.000Z" }),
    record("guess", {}, { tentative: true }),
  ];
  const search = vi.fn(async (input: { query: string }) =>
    input.query.includes("手机") || input.query.includes("过敏") || input.query.includes("住")
      ? records.map((memory) => ({
          productMemoryId: memory.id,
          providerRecordId: memory.providerRecordId as string,
          score: 1,
        }))
      : [],
  );
  const episodeSearch = vi.fn(async (_input: Record<string, unknown>) => [
    {
      episode: {
        threadId: "thread-9",
        endedAt: "2026-10-30T10:00:00.000Z",
        dataClassification: "private" as const,
      },
      text: "我们聊了下周去京都，订了周三的新干线",
    },
  ]);
  const service = new ProductionSearchControl({
    ownerId,
    agentId,
    settings: { ...DEFAULT_SEARCH_ASK, askLimit: 5 },
    provider: { search } as never,
    state: {
      readMany: async () => records,
      listActive: async () => records,
    },
    ...(options.episodes ? { episodes: { search: episodeSearch } } : {}),
    readText: async (memory) => texts[memory.contentRef],
    clock: { now: () => now },
  });
  return { service, search, episodeSearch };
}

const ask = (query: string | null, locale: "zh-CN" | "en" | "ja" = "zh-CN") =>
  ({
    schemaVersion: "gateway.v2",
    kind: "query",
    type: "search.ask.read",
    messageId: "message-1",
    correlationId: "message-1",
    causationId: null,
    payload: { query, locale },
  }) as never;

async function payload(f: ReturnType<typeof control>, query: string | null, locale?: "en") {
  const snapshot = await f.service.query(ask(query, locale));
  if (snapshot.type !== "search.ask.snapshot") throw new Error(snapshot.type);
  return snapshot.payload;
}

it("answers with the matching memory text and the conversation it came from", async () => {
  const result = await payload(control(), "我对什么过敏");
  expect(result).toMatchObject({
    state: "answered",
    answer: "我对花生过敏",
    notFoundText: null,
    basis: [
      {
        kind: "conversation",
        label: "10 月 21 日你在对话里说的",
        memoryId: "allergy",
        threadId: "thread-1",
        at: "2026-10-21T03:00:00.000Z",
      },
    ],
  });
});

it("writes the basis sentence on the server in the requested language", async () => {
  const f = control();
  const en = await payload(f, "我对什么过敏", "en");
  expect(en.basis[0]?.label).toBe("You said this in a conversation on Oct 21");
  const dated = new ProductionSearchControl({
    ownerId,
    agentId,
    settings: DEFAULT_SEARCH_ASK,
    timeZone: "Asia/Tokyo",
    provider: {
      search: async () =>
        [{ productMemoryId: "m", providerRecordId: "provider-m", score: 1 }] as never,
    },
    state: {
      readMany: async () => [
        record("m", {
          updatedAt: "2025-11-03T20:00:00.000Z",
          recordedAt: "2025-11-03T20:00:00.000Z",
        }),
      ],
      listActive: async () => [],
    },
    readText: async () => "我对花生过敏",
    clock: { now: () => now },
  });
  const snapshot = await dated.query(ask("我对什么过敏"));
  if (snapshot.type !== "search.ask.snapshot") throw new Error(snapshot.type);
  const memory = snapshot.payload;
  expect(memory.basis[0]?.label).toBe("记忆 · 2025 年 11 月 4 日记下");
});

it("never answers from a hidden, expired or tentative memory", async () => {
  const result = await payload(control(), "我对什么过敏");
  const shown = JSON.stringify(result);
  expect(shown).not.toContain("青霉素");
  expect(shown).not.toContain("花粉");
  expect(shown).not.toContain("虾");
});

function single(records: ProductMemoryRecord[], text: string, askLimit = 5) {
  return new ProductionSearchControl({
    ownerId,
    agentId,
    settings: { ...DEFAULT_SEARCH_ASK, askLimit },
    provider: {
      search: async () =>
        records.map((memory) => ({
          productMemoryId: memory.id,
          providerRecordId: memory.providerRecordId as string,
          score: 1,
        })) as never,
    },
    state: { readMany: async () => records, listActive: async () => records },
    readText: async () => text,
    clock: { now: () => now },
  });
}

async function only(service: ProductionSearchControl, query: string | null) {
  const snapshot = await service.query(ask(query));
  if (snapshot.type !== "search.ask.snapshot") throw new Error(snapshot.type);
  return snapshot.payload;
}

it("answers from a health memory once marked sensitive, like any other memory", async () => {
  const health = record(
    "health",
    { dataClassification: "sensitive" },
    { entities: ["青霉素"], category: "identity" },
  );
  const service = single([health], "我对青霉素过敏");
  expect((await only(service, "青霉素过敏")).state).not.toBe("not_found");
});

it("answers not found when the only match is a password or key, and never suggests it", async () => {
  const secret = record(
    "secret",
    { dataClassification: "restricted" },
    { entities: ["青霉素"], category: "identity" },
  );
  const service = single([secret], "我对青霉素过敏");
  expect((await only(service, "青霉素过敏")).state).toBe("not_found");
  expect((await only(service, null)).asks).toEqual([]);
});

it("hides a superseded memory from answers and an expired one from suggestions", async () => {
  const replaced = record("replaced", {}, { supersededBy: "newer" as never, entities: ["旧住址"] });
  const expired = record(
    "old",
    {},
    { validTo: "2026-01-01T00:00:00.000Z", entities: ["旧工作"], category: "identity" },
  );
  expect((await only(single([replaced], "我住在旧住址"), "旧住址")).state).toBe("not_found");
  expect((await only(single([expired], "我做旧工作"), null)).asks).toEqual([]);
});

it("keeps the answer inside the contract length and free of control characters", async () => {
  const long = `我对花生过敏\u0000${"😀".repeat(1500)}`;
  const answer = (await only(single([record("m")], long), "花生过敏")).answer ?? "";
  expect(answer.length).toBeLessThanOrEqual(DEFAULT_SEARCH_ASK.answerCharacters);
  expect(answer).not.toMatch(/\p{Cc}/u);
});

it("does not read any memory when no suggestions are wanted", async () => {
  const listActive = vi.fn(async () => []);
  const service = new ProductionSearchControl({
    ownerId,
    agentId,
    settings: DEFAULT_SEARCH_ASK,
    provider: { search: async () => [] },
    state: { readMany: async () => [], listActive },
    readText: async () => "",
    clock: { now: () => now },
  });
  expect((await only(service, null)).asks).toEqual([]);
  expect(listActive).not.toHaveBeenCalled();
});

it("reports not found in the owner's language when nothing matches literally", async () => {
  const f = control();
  const result = await payload(f, "我住在哪里");
  expect(result).toMatchObject({ state: "not_found", answer: null, basis: [], asks: [] });
  expect(result.notFoundText).toBe(SEARCH_TEXT["zh-CN"].notFound);
  expect((await payload(f, "我住在哪里", "en")).notFoundText).toBe(SEARCH_TEXT.en.notFound);
});

it("rejects a candidate the index returned when the memory text does not contain the query terms", async () => {
  const result = await payload(control(), "手机型号");
  expect(result.state).toBe("not_found");
});

it("uses a conversation summary when no memory matches and keeps its thread and time", async () => {
  const f = control({ episodes: true });
  const result = await payload(f, "新干线");
  expect(result).toMatchObject({
    state: "answered",
    answer: "我们聊了下周去京都，订了周三的新干线",
    basis: [{ kind: "conversation", memoryId: null, threadId: "thread-9" }],
  });
  expect(f.episodeSearch.mock.calls[0]?.[0]).toMatchObject({ lexicalOnly: true });
});

it("searches the index by literal terms only, never by vector", async () => {
  const f = control();
  await payload(f, "我对什么过敏");
  expect(f.search.mock.calls[0]?.[0]).toMatchObject({ lexicalOnly: true });
});

it("without a question returns suggestions taken from the owner's own memories, not a fixed list", async () => {
  const result = await payload(control(), null);
  expect(result).toMatchObject({ state: "suggestions", answer: null, basis: [] });
  expect(result.asks).toEqual(["iPhone", "花生", "过敏"]);
});

it("returns no suggestions when there are no memories to take them from", async () => {
  const empty = new ProductionSearchControl({
    ownerId,
    agentId,
    settings: DEFAULT_SEARCH_ASK,
    provider: { search: async () => [] },
    state: { readMany: async () => [], listActive: async () => [] },
    readText: async () => undefined,
    clock: { now: () => now },
  });
  const snapshot = await empty.query(ask(""));
  if (snapshot.type !== "search.ask.snapshot") throw new Error(snapshot.type);
  expect(snapshot.payload).toMatchObject({ state: "suggestions", asks: [] });
});

it("limits suggestions and answer length by configuration", async () => {
  const f = new ProductionSearchControl({
    ownerId,
    agentId,
    settings: { ...DEFAULT_SEARCH_ASK, askLimit: 1, answerCharacters: 4 },
    provider: {
      search: async () => [
        { productMemoryId: "allergy", providerRecordId: "provider-allergy", score: 1 },
      ],
    } as never,
    state: {
      readMany: async () => [record("allergy", {}, { entities: ["花生", "过敏"] })],
      listActive: async () => [record("allergy", {}, { entities: ["花生", "过敏"] })],
    },
    readText: async () => "我对花生过敏",
    clock: { now: () => now },
  });
  const suggestions = await f.query(ask(null));
  if (suggestions.type !== "search.ask.snapshot") throw new Error(suggestions.type);
  expect(suggestions.payload.asks).toHaveLength(1);
  const answered = await f.query(ask("过敏"));
  if (answered.type !== "search.ask.snapshot") throw new Error(answered.type);
  expect(answered.payload.answer).toBe("我对花…");
});
