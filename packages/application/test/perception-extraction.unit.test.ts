import { sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";
import { describe, expect, it } from "vitest";
import {
  buildPerceptionExtractionChunks,
  COMMAND_UTTERANCE_BATCH,
  commandUtteranceBatches,
  buildPerceptionSourceCheckPrompt,
  type PerceptionExtractionSource,
  type PerceptionRecord,
  parsePerceptionExtraction,
  parsePerceptionImage,
  parsePerceptionSourceCheck,
  perceptionCalendarTable,
  quotedSource,
} from "../src/index.js";

const NOW = "2026-11-12T03:00:00.000Z";

function source(
  id: string,
  text: string | null,
  overrides: Partial<PerceptionRecord> = {},
): PerceptionExtractionSource {
  return {
    record: {
      id,
      deviceId: "device:a",
      type: "speech.utterance",
      origin: "owner_spoken",
      captureSource: "device_microphone",
      occurredAtMs: Date.parse(NOW) - 600_000,
      receivedAtMs: Date.parse(NOW) - 590_000,
      occurredAtDevice: "2026-11-12T11:50:00+09:00",
      localDay: "2026-11-12",
      confidence: 900,
      speakerKind: "owner",
      speakerRef: null,
      episodeId: "episode:a",
      contentRef: text === null ? null : `content:${id}`,
      dataClassification: "private",
      evidence: { durationMs: 2000, utteranceId: "u1" },
      status: "active",
      ...overrides,
    },
    text,
  };
}

function chunks(sources: readonly PerceptionExtractionSource[], maximumCharacters = 60_000) {
  const placeholders = new Map<string, string>();
  return {
    placeholders,
    chunks: buildPerceptionExtractionChunks({
      sources,
      maximumCharacters,
      timeZone: "Asia/Tokyo",
      now: NOW,
      calendarDays: 3,
      openTodos: [
        { id: "reminder:b", text: "寄快递", due: "2026-11-13 09:00" },
        { id: "reminder:a", text: "交周报", due: "2026-11-12 18:00" },
      ],
      tag: sequentialPlaceholderTag(),
      placeholders,
    }),
  };
}

describe("perception extraction prompt", () => {
  it("puts fixed text first, records in time order, and the current time last", () => {
    const late = source("perception:b", "周六和小林吃饭", {
      occurredAtMs: Date.parse(NOW) - 60_000,
    });
    const early = source("perception:a", "我不吃香菜");
    const built = chunks([late, early]).chunks;
    expect(built).toHaveLength(1);
    const prompt = built[0]?.prompt ?? "";
    expect(prompt.indexOf("perception:a")).toBeLessThan(prompt.indexOf("perception:b"));
    expect(prompt.indexOf("reminder:a")).toBeLessThan(prompt.indexOf("reminder:b"));
    expect(prompt.indexOf("perception:b")).toBeLessThan(prompt.indexOf("reminder:a"));
    expect(prompt.endsWith("2026-11-12T12:00")).toBe(true);
    expect(prompt).toContain("2026-11-12 周四");
    const again = chunks([early, late]).chunks[0]?.prompt;
    expect(again).toBe(prompt);
    const later = buildPerceptionExtractionChunks({
      sources: [early, late],
      maximumCharacters: 60_000,
      timeZone: "Asia/Tokyo",
      now: "2026-11-12T03:05:00.000Z",
      calendarDays: 3,
      openTodos: [],
      tag: sequentialPlaceholderTag(),
      placeholders: new Map(),
    })[0]?.prompt;
    const shared = prompt.slice(0, prompt.indexOf("reminder:a") - 40);
    expect(later?.startsWith(shared.slice(0, shared.lastIndexOf("\n")))).toBe(true);
  });

  it("splits by the size limit without dropping a record and marks later parts as continued", () => {
    const sources = [0, 1, 2, 3].map((index) =>
      source(`perception:${index}`, `第 ${index} 句`.padEnd(120, "啊"), {
        occurredAtMs: Date.parse(NOW) - 600_000 + index * 1000,
      }),
    );
    const built = chunks(sources, 500).chunks;
    expect(built.length).toBeGreaterThan(1);
    expect(built.flatMap((chunk) => chunk.sources.map(({ record }) => record.id))).toEqual(
      sources.map(({ record }) => record.id),
    );
    expect(built[0]?.prompt).not.toContain("接着上一次");
    expect(built[1]?.prompt).toContain("接着上一次");
  });

  it("masks secrets in the text and raises the classification to the highest record", () => {
    const secret = source("perception:a", "我的银行卡号是 4111 1111 1111 1111");
    const sensitive = source("perception:b", "体检报告出来了", {
      dataClassification: "sensitive",
      occurredAtMs: Date.parse(NOW) - 1000,
    });
    const { chunks: built, placeholders } = chunks([secret, sensitive]);
    expect(built[0]?.prompt).not.toContain("4111 1111 1111 1111");
    expect(placeholders.size).toBeGreaterThan(0);
    expect(built[0]?.dataClassification).toBe("sensitive");
    const [chunk] = built;
    if (!chunk) throw new Error("chunk missing");
    expect(quotedSource(chunk, "4111 1111 1111 1111", ["perception:a"])).toBeNull();
    expect(quotedSource(chunk, "体检报告出来了", ["perception:b"])?.record.id).toBe("perception:b");
    expect(quotedSource(chunk, "体检报告出来了", ["perception:a"])).toBeNull();
    expect(quotedSource(chunk, "体检报告已经出来了", ["perception:b"])).toBeNull();
  });

  it("builds a calendar table that starts on the owner's local day", () => {
    expect(
      perceptionCalendarTable({
        fromMs: Date.parse("2026-11-12T15:30:00.000Z"),
        days: 3,
        timeZone: "Asia/Tokyo",
      }),
    ).toEqual(["2026-11-13 周五", "2026-11-14 周六", "2026-11-15 周日"]);
  });
});

describe("perception extraction output", () => {
  const candidate = {
    text: "主人不吃香菜",
    category: "preference",
    confidence: 900,
    about: "owner",
    quote: "我不吃香菜",
    recordIds: ["perception:a"],
  };

  it("reads candidates, proposals and done hints and tolerates text around the JSON", () => {
    const parsed = parsePerceptionExtraction(
      `好的。\n${JSON.stringify({
        candidates: [candidate],
        proposals: [
          {
            what: "周六中午和小林吃饭前提醒主人订位",
            quote: "周六和小林吃饭",
            recordIds: ["perception:b", "perception:b"],
          },
        ],
        doneHints: [{ id: "reminder:a", quote: "周报交了", recordIds: ["perception:c"] }],
      })}\n以上。`,
      12,
    );
    expect(parsed).toEqual({
      candidates: [candidate],
      proposals: [
        {
          what: "周六中午和小林吃饭前提醒主人订位",
          quote: "周六和小林吃饭",
          recordIds: ["perception:b"],
        },
      ],
      doneHints: [{ id: "reminder:a", quote: "周报交了", recordIds: ["perception:c"] }],
      dropped: 0,
    });
  });

  it("drops malformed items one by one and counts them", () => {
    const parsed = parsePerceptionExtraction(
      JSON.stringify({
        candidates: [
          candidate,
          { ...candidate, confidence: 1001 },
          { ...candidate, category: "gossip" },
          { ...candidate, about: "everyone" },
          { ...candidate, quote: "" },
          { ...candidate, recordIds: [] },
        ],
        proposals: [{ what: "", quote: "x", recordIds: ["a"] }],
      }),
      12,
    );
    expect(parsed?.candidates).toEqual([candidate]);
    expect(parsed?.proposals).toEqual([]);
    expect(parsed?.dropped).toBe(6);
  });

  it("keeps at most the configured number of items per list", () => {
    const parsed = parsePerceptionExtraction(
      JSON.stringify({ candidates: [candidate, candidate, candidate] }),
      2,
    );
    expect(parsed?.candidates).toHaveLength(2);
    expect(parsed?.dropped).toBe(1);
  });

  it("returns null when the output is not the agreed JSON object", () => {
    for (const output of ["", "没有", "[1,2]", '{"candidates":"none"}', '{"candidates":[}'])
      expect(parsePerceptionExtraction(output, 12)).toBeNull();
    expect(parsePerceptionExtraction("{}", 12)).toEqual({
      candidates: [],
      proposals: [],
      doneHints: [],
      dropped: 0,
    });
  });
});

describe("perception source checks", () => {
  it("orders items by time and ends with the current time", () => {
    const prompt = buildPerceptionSourceCheckPrompt({
      kind: "message",
      items: [
        { id: "b", atMs: 2, line: '{"id":"b"}' },
        { id: "a", atMs: 1, line: '{"id":"a"}' },
      ],
      calendar: ["2026-11-12 周四"],
      now: "2026-11-12T12:00",
    });
    expect(prompt.indexOf('{"id":"a"}')).toBeLessThan(prompt.indexOf('{"id":"b"}'));
    expect(prompt.endsWith("2026-11-12T12:00")).toBe(true);
  });

  it("treats every item the model left out or wrote wrongly as ignore", () => {
    const verdicts = parsePerceptionSourceCheck(
      JSON.stringify({
        items: [
          {
            id: "a",
            result: "remind",
            what: "水费 15 号前交",
            due: "2026-11-15",
            reason: "有截止日期",
          },
          { id: "b", result: "remind", what: "x", due: "下周", reason: "y" },
          { id: "zzz", result: "remind", what: "x", due: null, reason: "y" },
          { id: "a", result: "ignore" },
        ],
      }),
      ["a", "b", "c"],
    );
    expect(verdicts).toEqual([
      {
        id: "a",
        result: "remind",
        what: "水费 15 号前交",
        due: "2026-11-15",
        reason: "有截止日期",
      },
      { id: "b", result: "ignore" },
      { id: "c", result: "ignore" },
    ]);
    expect(parsePerceptionSourceCheck("不知道", ["a"])).toBeNull();
  });

  it("reads an image result only when it has both text and a short description", () => {
    expect(parsePerceptionImage('{"text":"发票 120 元","description":"一张发票"}')).toEqual({
      text: "发票 120 元",
      description: "一张发票",
    });
    expect(parsePerceptionImage('{"text":"发票"}')).toBeNull();
    expect(parsePerceptionImage("看不清")).toBeNull();
  });
});

describe("[iOS-5] spoken-command ids are looked up in bounded batches", () => {
  it("splits distinct ids into sorted batches no larger than the batch size", () => {
    const ids = Array.from(
      { length: COMMAND_UTTERANCE_BATCH * 5 + 7 },
      (_, index) => `utterance-${String(index).padStart(6, "0")}`,
    );
    const batches = commandUtteranceBatches([...ids].reverse().concat(ids.slice(0, 50)));
    expect(batches).toHaveLength(6);
    expect(batches.every((batch) => batch.length <= COMMAND_UTTERANCE_BATCH)).toBe(true);
    expect(batches.flat()).toEqual(ids);
    expect(commandUtteranceBatches([])).toEqual([]);
  });
});
