import { describe, expect, it } from "vitest";
import {
  errorUnits,
  parseObservations,
  renderReport,
  scoreCommand,
  scorePrefetch,
  scoreSpeaker,
  scoreTranscription,
} from "../../scripts/evals/listening-score.mjs";

function clip(overrides) {
  return {
    id: overrides.id,
    file: `${overrides.id}.wav`,
    purpose: "speaker",
    source: "owner",
    speaker: "owner",
    language: "zh-Hans",
    reference: "",
    placement: "hand",
    condition: "quiet",
    route: "device_microphone",
    inEar: null,
    ...overrides,
  };
}

function observation(clipOverrides, rest = {}) {
  return {
    clip: clip(clipOverrides),
    transcripts: [],
    speakerModel: "fluidaudio-wespeaker-0.18.3",
    speakerScore: null,
    loudnessScore: null,
    call: null,
    ...rest,
  };
}

function transcript(text, at = 2) {
  return {
    engine: "transcriber",
    locale: "zh-CN",
    pieces: [{ at, start: 0, text, isFinal: true }],
    processingSeconds: 0.2,
  };
}

describe("listening evaluation scoring", () => {
  it("finds the speaker threshold that keeps other voices out", () => {
    const owner = [910, 880, 860, 840].map((score, index) =>
      observation(
        { id: `o${index}`, condition: index % 2 ? "noisy" : "quiet" },
        { speakerScore: score },
      ),
    );
    const others = [300, 420, 510, 650].map((score, index) =>
      observation(
        {
          id: `p${index}`,
          source: "public",
          speaker: `librispeech:${index % 2}`,
          condition: index % 2 ? "noisy" : "quiet",
        },
        { speakerScore: score },
      ),
    );
    const result = scoreSpeaker([...owner, ...others]);
    expect(result.owner).toBe(4);
    expect(result.others).toBe(4);
    expect(result.otherSpeakers).toBe(2);
    expect(result.equalErrorRate).toBe(0);
    expect(result.equalErrorThreshold).toBeGreaterThan(650);
    expect(result.equalErrorThreshold).toBeLessThanOrEqual(840);
    expect(result.byCondition.noisy.othersMax).toBe(650);
  });

  it("uses the server's own command decision and never counts a call without a request", () => {
    const ownerAirpods = observation(
      { id: "a", purpose: "command", placement: "airpods", route: "airpods", inEar: true },
      { loudnessScore: 900, call: { nameHeard: true, request: "帮我看天气", prepared: [] } },
    );
    const farAirpods = observation(
      {
        id: "b",
        purpose: "bystander",
        source: "synthetic",
        speaker: "synthetic:Kyoko",
        placement: "airpods",
        route: "airpods",
        inEar: true,
      },
      { loudnessScore: 600, call: { nameHeard: true, request: "電気を消して", prepared: [] } },
    );
    const ownerTable = observation(
      { id: "c", purpose: "command", placement: "table" },
      { speakerScore: 850, call: { nameHeard: true, request: "明天几点起床", prepared: [] } },
    );
    const tvTable = observation(
      {
        id: "d",
        purpose: "tv_mention",
        source: "synthetic",
        speaker: "synthetic:Tingting",
        placement: "table",
      },
      {
        speakerScore: 300,
        call: { nameHeard: true, request: "田是今年最受欢迎的拍照地点", prepared: [] },
      },
    );
    const tvNoRequest = observation(
      {
        id: "e",
        purpose: "tv_mention",
        source: "synthetic",
        speaker: "synthetic:Tingting",
        placement: "table",
      },
      { speakerScore: 990, call: { nameHeard: false, request: null, prepared: [] } },
    );
    const ownerMention = observation(
      { id: "f", purpose: "owner_mention", placement: "table" },
      {
        speakerScore: 900,
        call: { nameHeard: true, request: "昨天那个提醒挺有用的", prepared: [] },
      },
    );
    const result = scoreCommand([
      ownerAirpods,
      farAirpods,
      ownerTable,
      tvTable,
      tvNoRequest,
      ownerMention,
    ]);
    expect(result.positives).toBe(2);
    expect(result.negatives).toBe(3);
    expect(result.recommended.airpods.threshold).toBe(900);
    expect(result.recommended.airpods.executed.share).toBe(1);
    expect(result.recommended.ambient.threshold).toBe(850);
    const permissive = result.sweeps.ambient.find((row) => row.threshold === 300);
    expect(permissive.wronglyExecuted).toBe(1);
    expect(result.nameHeard["tv_mention/table/zh-Hans"]).toEqual({ heard: 1, total: 2 });
    expect(result.ownerMentions).toEqual({ total: 1, nameHeard: 1, executedAtRecommended: 1 });
  });

  it("measures characters for Chinese and Japanese and words for English", () => {
    expect(errorUnits("zh-Hans", "今天，天气 不错。")).toEqual([..."今天天气不错"]);
    expect(errorUnits("en", "The train was late.")).toEqual(["the", "train", "was", "late"]);
    const rows = scoreTranscription([
      observation(
        { id: "z", reference: "今天天气不错。" },
        { transcripts: [transcript("今天天气不错")] },
      ),
      observation(
        {
          id: "e",
          language: "en",
          source: "public",
          speaker: "fleurs:en:1",
          purpose: "public_speech",
          reference: "The train was late.",
        },
        { transcripts: [{ ...transcript("the train is late", 60), locale: "en-US" }] },
      ),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        language: "en",
        speaker: "public",
        errorRate: 0.25,
        measure: "word",
        minutes: 1,
      }),
      expect.objectContaining({
        language: "zh-Hans",
        speaker: "owner",
        errorRate: 0,
        measure: "character",
      }),
    ]);
  });

  it("counts a prepared request as adopted with the server's similarity rule", () => {
    const result = scorePrefetch([
      observation(
        { id: "p1", purpose: "command" },
        { call: { nameHeard: true, request: "帮我看天气。", prepared: ["帮我", "帮我看天气"] } },
      ),
      observation(
        { id: "p2", purpose: "command" },
        { call: { nameHeard: true, request: "帮我看天气", prepared: ["帮我看"] } },
      ),
      observation(
        { id: "p3", purpose: "command" },
        { call: { nameHeard: true, request: "提醒我", prepared: [] } },
      ),
    ]);
    expect(result.commands).toBe(3);
    expect(result.withPrepared).toBe(2);
    expect(result.preparedPerCommand).toBe(1);
    expect(result.reused.successes).toBe(1);
    expect(result.similarity.find((row) => row.threshold === 1000).rate.successes).toBe(1);
    expect(result.similarity.find((row) => row.threshold === 800).rate.successes).toBe(1);
  });

  it("reads JSON lines and renders every section", () => {
    const parsed = parseObservations(
      `${JSON.stringify(observation({ id: "x" }, { speakerScore: 900 }))}\n\n`,
    );
    expect(parsed).toHaveLength(1);
    const report = renderReport({
      observations: 1,
      speaker: scoreSpeaker(parsed),
      command: scoreCommand(parsed),
      transcription: scoreTranscription(parsed),
      prefetch: scorePrefetch(parsed),
    });
    for (const heading of ["## 认人", "## 口头指令", "## 转文字", "## 抢跑"])
      expect(report).toContain(heading);
  });
});
