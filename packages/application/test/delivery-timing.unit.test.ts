import { describe, expect, it } from "vitest";
import {
  DELIVERY_TIMING_DEFAULTS,
  DeliveryTimingJudge,
  type DeliveryTimingModel,
  type DeliveryTimingQuestion,
  deliveryTimingDeadlineMs,
  ownerStateFacts,
  type PerceptionRecord,
} from "../src/index.js";

const NOW = Date.parse("2026-11-15T03:00:00.000Z");

function record(
  type: PerceptionRecord["type"],
  secondsAgo: number,
  evidence: PerceptionRecord["evidence"],
  extra: Partial<PerceptionRecord> = {},
): PerceptionRecord {
  return {
    id: `${type}-${secondsAgo}`,
    deviceId: "device-1",
    type,
    origin: "device",
    captureSource: "background",
    occurredAtMs: NOW - secondsAgo * 1000,
    receivedAtMs: NOW - secondsAgo * 1000,
    occurredAtDevice: "2026-11-15T12:00:00.000+09:00",
    localDay: "2026-11-15",
    confidence: 1000,
    speakerKind: null,
    speakerRef: null,
    episodeId: null,
    contentRef: null,
    dataClassification: "private",
    evidence,
    status: "active",
    ...extra,
  } as unknown as PerceptionRecord;
}

class RecordingModel implements DeliveryTimingModel {
  readonly asked: DeliveryTimingQuestion[] = [];
  readonly answer: number | Error;
  constructor(answer: number | Error = 0.9) {
    this.answer = answer;
  }
  estimateMicros(): number {
    return 7;
  }
  async probability(input: DeliveryTimingQuestion): Promise<number> {
    this.asked.push(input);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function judge(model: DeliveryTimingModel, reserve = async () => true, now = () => NOW) {
  return new DeliveryTimingJudge({
    model,
    configuration: () => DELIVERY_TIMING_DEFAULTS,
    reserve,
    now,
  });
}

const driving: DeliveryTimingQuestion = {
  pushClass: "run_result",
  facts: [{ signal: "motion", value: "driving", secondsAgo: 20 }],
};

describe("[IOS-4] owner state facts from perception records", () => {
  it("keeps only fresh reports and names what each one says", () => {
    const facts = ownerStateFacts(
      [
        record("motion.activity", 40, { activity: "driving" }),
        record("context.focus", 100, { active: true, focusName: "work" }),
        record("context.connectivity", 10, { network: "cellular", carPlay: true }),
        record("speech.utterance", 30, {}, { speakerKind: "contact" }),
        record("health.sample", 600, { subtype: "sleep", value: 1, unit: "s", endMs: NOW + 1000 }),
      ],
      NOW,
      DELIVERY_TIMING_DEFAULTS,
    );
    expect(facts).toEqual([
      { signal: "speech", value: "owner_and_others", secondsAgo: 30 },
      { signal: "motion", value: "driving", secondsAgo: 40 },
      { signal: "sleep", value: "asleep", secondsAgo: 600 },
      { signal: "focus", value: "on", secondsAgo: 100 },
      { signal: "car_connection", value: "connected", secondsAgo: 10 },
    ]);
  });

  it("REVERSE: reports older than their freshness window are not used", () => {
    expect(
      ownerStateFacts(
        [
          record("motion.activity", 301, { activity: "driving" }),
          record("context.focus", 601, { active: true }),
          record("context.connectivity", 301, { carPlay: true }),
          record("speech.utterance", 121, {}, { speakerKind: "contact" }),
          record("health.sample", 1801, { subtype: "sleep", value: 1, unit: "s" }),
        ],
        NOW,
        DELIVERY_TIMING_DEFAULTS,
      ),
    ).toEqual([]);
  });

  it("REVERSE: deleted records, other health samples and speech without a speaker are ignored", () => {
    expect(
      ownerStateFacts(
        [
          record("motion.activity", 10, { activity: "driving" }, { status: "deleted" }),
          record("health.sample", 10, { subtype: "steps", value: 3, unit: "count" }),
          record("speech.utterance", 10, {}, { speakerKind: null }),
        ],
        NOW,
        DELIVERY_TIMING_DEFAULTS,
      ),
    ).toEqual([]);
  });

  it("uses the newest report of a kind, so a stopped drive is not still driving", () => {
    const facts = ownerStateFacts(
      [
        record("motion.activity", 200, { activity: "driving" }),
        record("motion.activity", 20, { activity: "stationary" }),
      ],
      NOW,
      DELIVERY_TIMING_DEFAULTS,
    );
    expect(facts).toEqual([{ signal: "motion", value: "stationary", secondsAgo: 20 }]);
  });

  it("reads an ended sleep sample as awake", () => {
    const facts = ownerStateFacts(
      [record("health.sample", 60, { subtype: "sleep", value: 1, unit: "s", endMs: NOW - 5000 })],
      NOW,
      DELIVERY_TIMING_DEFAULTS,
    );
    expect(facts).toEqual([{ signal: "sleep", value: "awake", secondsAgo: 60 }]);
  });
});

describe("[IOS-4] delivery timing judge", () => {
  it("defers when the model says the owner is busy", async () => {
    const model = new RecordingModel(0.92);
    const result = await judge(model).decide(driving);
    expect(result).toMatchObject({
      action: "defer",
      reasonCode: "timing_busy",
      confidencePermille: 920,
      judged: true,
      signals: ["motion"],
    });
  });

  it("delivers when the model says it is fine", async () => {
    const result = await judge(new RecordingModel(0.1)).decide(driving);
    expect(result).toMatchObject({ action: "deliver", reasonCode: "timing_clear", judged: true });
  });

  it("REVERSE: asks nothing and delivers when no report is fresh", async () => {
    const model = new RecordingModel(1);
    const result = await judge(model).decide({ pushClass: "run_result", facts: [] });
    expect(result).toMatchObject({
      action: "deliver",
      reasonCode: "timing_unknown",
      judged: false,
    });
    expect(model.asked).toHaveLength(0);
  });

  it("REVERSE: delivers when the model fails, answers out of range or the budget is spent", async () => {
    expect(await judge(new RecordingModel(new Error("down"))).decide(driving)).toMatchObject({
      action: "deliver",
      reasonCode: "timing_failed",
    });
    expect(await judge(new RecordingModel(1.5)).decide(driving)).toMatchObject({
      action: "deliver",
      reasonCode: "timing_failed",
    });
    const spent = new RecordingModel(1);
    expect(await judge(spent, async () => false).decide(driving)).toMatchObject({
      action: "deliver",
      reasonCode: "timing_budget",
    });
    expect(spent.asked).toHaveLength(0);
  });

  it("REVERSE: a budget check that throws delivers instead of failing the push", async () => {
    const model = new RecordingModel(1);
    const result = await judge(model, async () => {
      throw new Error("limit store down");
    }).decide(driving);
    expect(result).toMatchObject({ action: "deliver", reasonCode: "timing_budget" });
  });

  it("asks once for the same situation within the recheck window, and asks again after it", async () => {
    let now = NOW;
    const model = new RecordingModel(0.9);
    const asker = judge(
      model,
      async () => true,
      () => now,
    );
    await asker.decide(driving);
    await asker.decide({
      ...driving,
      facts: driving.facts.map((fact) => ({ ...fact, secondsAgo: 50 })),
    });
    expect(model.asked).toHaveLength(1);
    now += DELIVERY_TIMING_DEFAULTS.recheckSeconds * 1000 + 1;
    await asker.decide(driving);
    expect(model.asked).toHaveLength(2);
    await asker.decide({ ...driving, pushClass: "mail_reminder" });
    expect(model.asked).toHaveLength(3);
  });

  it("does not remember a failed answer, so the next check asks again", async () => {
    const model = new RecordingModel(new Error("down"));
    const asker = judge(model);
    await asker.decide(driving);
    await asker.decide(driving);
    expect(model.asked).toHaveLength(2);
  });

  it("REVERSE: stops asking past the per-minute limit and delivers", async () => {
    const model = new RecordingModel(0.9);
    const asker = judge(model);
    let last = await asker.decide(driving);
    for (let index = 0; index < DELIVERY_TIMING_DEFAULTS.perMinute; index += 1)
      last = await asker.decide({
        pushClass: "run_result",
        facts: [{ signal: "motion", value: `activity-${index}`, secondsAgo: 5 }],
      });
    expect(last).toMatchObject({ action: "deliver", reasonCode: "timing_rate" });
    expect(model.asked).toHaveLength(DELIVERY_TIMING_DEFAULTS.perMinute);
  });
});

describe("[IOS-4] latest delivery time", () => {
  it("is short for reminders and longer for task results and mail", () => {
    const created = NOW;
    expect(deliveryTimingDeadlineMs("scheduled_reminder", created, DELIVERY_TIMING_DEFAULTS)).toBe(
      created + 600_000,
    );
    for (const pushClass of ["run_result", "mail_reminder"] as const)
      expect(deliveryTimingDeadlineMs(pushClass, created, DELIVERY_TIMING_DEFAULTS)).toBe(
        created + 7_200_000,
      );
  });
});
