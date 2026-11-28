import { describe, expect, it } from "vitest";
import type { Embedder } from "../src/embedding.ts";
import {
  prefetchingEmbedder,
  QUERY_PREFETCH_LIMIT_DEFAULTS,
  QueryPrefetch,
  type QueryPrefetchLimits,
  sharedQueryEmbedders,
  spokenQueryText,
  textSimilarityPermille,
} from "../src/query-prefetch.ts";

function setup(overrides: Partial<QueryPrefetchLimits> = {}) {
  let now = 1_000_000;
  const limits = { ...QUERY_PREFETCH_LIMIT_DEFAULTS, ...overrides };
  const queue = new QueryPrefetch({ limits: () => limits, now: () => now });
  const calls: string[] = [];
  const embed = async (query: string) => {
    calls.push(query);
    return new Float32Array([[...query].length, 1]);
  };
  const inner: Embedder = {
    model: "fixture",
    dimensions: 2,
    embedQuery: embed,
    embedDocument: async () => new Float32Array([0, 0]),
  };
  return {
    queue,
    calls,
    prepare: (deviceId: string, utteranceId: string, text: string) =>
      queue.prepare({ deviceId, utteranceId, text }, embed),
    embedder: prefetchingEmbedder(inner, queue),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("spoken text", () => {
  it("scores similarity ignoring punctuation, spaces and letter case", () => {
    expect(textSimilarityPermille("帮我订明天的会议室。", "帮我订明天的会议室")).toBe(1000);
    expect(textSimilarityPermille("Book A Room", "book a room!")).toBe(1000);
    expect(textSimilarityPermille("帮我订明天的会议室", "帮我订后天的会议室")).toBe(888);
    expect(textSimilarityPermille("帮我订会议室", "今天天气怎么样")).toBeLessThan(300);
    expect(textSimilarityPermille("", "")).toBe(1000);
  });

  it("searches with one spelling that drops punctuation but keeps the words apart", () => {
    expect(spokenQueryText("帮我看天气。")).toBe("帮我看天气");
    expect(spokenQueryText("Himawari, book a room!")).toBe("Himawari book a room");
    expect(spokenQueryText("  明日の天気、教えて？ ")).toBe("明日の天気 教えて");
    expect(spokenQueryText("ＡＢＣ")).toBe("ABC");
  });
});

describe("QueryPrefetch", () => {
  it("gives a spoken request the same search vector with or without a prepared half sentence", async () => {
    const prepared = setup();
    await prepared.prepare("d1", "u1", "帮我看天气");
    expect(
      prepared.queue.settle({ deviceId: "d1", utteranceId: "u1", finalText: "帮我看天气。" }),
    ).toEqual({
      used: true,
      similarity: 1000,
    });
    const reused = await prepared.embedder.embedQuery("帮我看天气。");

    const cold = setup();
    expect(
      cold.queue.settle({ deviceId: "d1", utteranceId: "u1", finalText: "帮我看天气。" }),
    ).toMatchObject({
      used: false,
      reason: "nothing_prepared",
    });
    const fresh = await cold.embedder.embedQuery("帮我看天气。");

    expect(Array.from(reused)).toEqual(Array.from(fresh));
    expect(prepared.calls).toEqual(["帮我看天气"]);
    expect(cold.calls).toEqual(["帮我看天气"]);
  });

  it("leaves typed questions exactly as written", async () => {
    const s = setup();
    await s.embedder.embedQuery("今天天气怎么样？");
    expect(s.calls).toEqual(["今天天气怎么样？"]);
  });

  it("reuses only the latest half sentence of that device's utterance, once", async () => {
    const s = setup();
    await s.prepare("d1", "u1", "帮我订会议");
    await s.prepare("d1", "u1", "帮我订会议室");
    expect(s.queue.preparedCount("d1")).toBe(1);
    expect(
      s.queue.settle({ deviceId: "d1", utteranceId: "u1", finalText: "帮我订会议室" }),
    ).toEqual({
      used: true,
      similarity: 1000,
    });
    expect(Array.from(await s.embedder.embedQuery("帮我订会议室"))).toEqual([6, 1]);
    expect(Array.from(await s.embedder.embedQuery("帮我订会议室"))).toEqual([6, 1]);
    expect(s.calls).toEqual(["帮我订会议", "帮我订会议室", "帮我订会议室"]);
  });

  it("does not hand one device's result to another device or another utterance", async () => {
    const s = setup();
    await s.prepare("d1", "u1", "打电话给妈妈");
    expect(
      s.queue.settle({ deviceId: "d2", utteranceId: "u1", finalText: "打电话给妈妈" }),
    ).toMatchObject({
      used: false,
      reason: "nothing_prepared",
    });
    expect(
      s.queue.settle({ deviceId: "d1", utteranceId: "u2", finalText: "打电话给妈妈" }),
    ).toMatchObject({
      used: false,
      reason: "nothing_prepared",
    });
    expect(s.queue.preparedCount("d1")).toBe(1);
  });

  it("searches again when the final words differ, even when they are similar", async () => {
    const s = setup();
    await s.prepare("d1", "u1", "帮我订明天的");
    expect(
      s.queue.settle({ deviceId: "d1", utteranceId: "u1", finalText: "帮我订明天的会议室" }),
    ).toEqual({ used: false, reason: "different_words", similarity: 666 });
    await s.prepare("d1", "u2", "help me book a room");
    expect(
      s.queue.settle({ deviceId: "d1", utteranceId: "u2", finalText: "help mebook a room" }),
    ).toEqual({ used: false, reason: "different_words", similarity: 1000 });
    await s.embedder.embedQuery("帮我订明天的会议室");
    expect(s.calls.at(-1)).toBe("帮我订明天的会议室");
  });

  it("forgets what was prepared after the configured time", async () => {
    const s = setup({ ttlMs: 60_000 });
    await s.prepare("d1", "u1", "几点了");
    s.advance(60_001);
    expect(
      s.queue.settle({ deviceId: "d1", utteranceId: "u1", finalText: "几点了" }),
    ).toMatchObject({
      used: false,
      reason: "expired",
    });
    await s.prepare("d1", "u2", "几点了");
    s.queue.settle({ deviceId: "d1", utteranceId: "u2", finalText: "几点了？" });
    s.advance(60_001);
    await s.embedder.embedQuery("几点了？");
    expect(s.calls.at(-1)).toBe("几点了？");
  });

  it("prepares nothing for punctuation only and drops the oldest entries when full", async () => {
    const s = setup({ entriesPerDevice: 2 });
    expect(await s.prepare("d1", "u0", "……")).toBe(false);
    for (const id of ["u1", "u2", "u3"]) await s.prepare("d1", id, id);
    expect(s.queue.preparedCount("d1")).toBe(2);
    expect(s.queue.settle({ deviceId: "d1", utteranceId: "u1", finalText: "u1" })).toMatchObject({
      used: false,
      reason: "nothing_prepared",
    });
    const small = setup({ bytesPerDevice: 19 });
    await small.prepare("d1", "a", "aa");
    await small.prepare("d1", "b", "bb");
    expect(small.queue.preparedCount("d1")).toBe(1);
    expect(await small.prepare("d1", "c", "x".repeat(40))).toBe(false);
    expect(small.queue.preparedCount("d1")).toBe(1);
    expect(small.queue.settle({ deviceId: "d1", utteranceId: "b", finalText: "bb" })).toMatchObject(
      {
        used: true,
      },
    );
  });
});

describe("sharedQueryEmbedders", () => {
  function shared(limits = { ttlMs: 60_000, entries: 2 }) {
    let now = 1_000_000;
    const calls: string[] = [];
    let fail = false;
    const { leader: embedder, follower } = sharedQueryEmbedders(
      {
        model: "fixture",
        dimensions: 2,
        embedQuery: async (query) => {
          calls.push(query);
          if (fail) throw new Error("EMBEDDING_DOWN");
          return new Float32Array([[...query].length, 1]);
        },
        embedDocument: async () => new Float32Array([0, 0]),
      },
      { limits: () => limits, now: () => now },
    );
    return {
      embedder,
      follower,
      calls,
      later: (ms: number) => {
        now += ms;
      },
      failing: (value: boolean) => {
        fail = value;
      },
    };
  }

  it("embeds the same words once when the memory search and the old-conversation recall both ask at the same time", async () => {
    const { embedder, calls } = shared();
    const [memory, conversations] = await Promise.all([
      embedder.embedQuery("帮我把明天的会改到下午。"),
      embedder.embedQuery("帮我把明天的会改到下午。"),
    ]);
    expect(conversations).toBe(memory);
    await embedder.embedQuery("帮我把明天的会改到下午。");
    expect(calls).toEqual(["帮我把明天的会改到下午。"]);
  });

  it("lets the old-conversation recall, which asks after the memory search, take that search's vector or its failure without asking the provider again", async () => {
    const { embedder, follower, calls, failing } = shared();
    const memory = await embedder.embedQuery("明天的会");
    expect(await follower.embedQuery("明天的会")).toBe(memory);
    failing(true);
    await expect(embedder.embedQuery("报销")).rejects.toThrow("EMBEDDING_DOWN");
    await expect(follower.embedQuery("报销")).rejects.toThrow("EMBEDDING_DOWN");
    failing(false);
    await follower.embedQuery("新的一句");
    expect(calls).toEqual(["明天的会", "报销", "新的一句"]);
  });

  it("REVERSE: embeds again for different words, after the time limit, beyond the entry limit, and after a failure", async () => {
    const { embedder, calls, later, failing } = shared();
    await embedder.embedQuery("a");
    await embedder.embedQuery("b");
    later(60_001);
    await embedder.embedQuery("a");
    await embedder.embedQuery("b");
    await embedder.embedQuery("c");
    await embedder.embedQuery("a");
    failing(true);
    await expect(embedder.embedQuery("d")).rejects.toThrow("EMBEDDING_DOWN");
    failing(false);
    await embedder.embedQuery("d");
    expect(calls).toEqual(["a", "b", "a", "b", "c", "a", "d", "d"]);
  });
});
