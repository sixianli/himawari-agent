import type { PerceptionRecord } from "../ports/perception.js";
import type { PushClass } from "./web-push-gate.js";

export const DELIVERY_TIMING_CLASSES: readonly PushClass[] = Object.freeze([
  "scheduled_reminder",
  "run_result",
  "mail_reminder",
]);

export interface DeliveryTimingConfiguration {
  readonly busyAtLeastPermille: number;
  readonly recheckSeconds: number;
  readonly timeoutMs: number;
  readonly perMinute: number;
  readonly reminderMaximumDeferSeconds: number;
  readonly maximumDeferSeconds: number;
  readonly speechFreshSeconds: number;
  readonly motionFreshSeconds: number;
  readonly sleepFreshSeconds: number;
  readonly focusFreshSeconds: number;
  readonly connectivityFreshSeconds: number;
}

export const DELIVERY_TIMING_DEFAULTS: DeliveryTimingConfiguration = Object.freeze({
  busyAtLeastPermille: 700,
  recheckSeconds: 300,
  timeoutMs: 2000,
  perMinute: 30,
  reminderMaximumDeferSeconds: 600,
  maximumDeferSeconds: 7200,
  speechFreshSeconds: 120,
  motionFreshSeconds: 300,
  sleepFreshSeconds: 1800,
  focusFreshSeconds: 600,
  connectivityFreshSeconds: 300,
});

export const DELIVERY_TIMING_RANGES: Readonly<
  Record<keyof DeliveryTimingConfiguration, readonly [number, number]>
> = Object.freeze({
  busyAtLeastPermille: [500, 1000],
  recheckSeconds: [60, 3600],
  timeoutMs: [200, 10_000],
  perMinute: [1, 600],
  reminderMaximumDeferSeconds: [60, 86_400],
  maximumDeferSeconds: [60, 86_400],
  speechFreshSeconds: [10, 3600],
  motionFreshSeconds: [10, 3600],
  sleepFreshSeconds: [60, 14_400],
  focusFreshSeconds: [60, 14_400],
  connectivityFreshSeconds: [10, 3600],
});

export const DELIVERY_TIMING_SIGNALS = [
  "speech",
  "motion",
  "sleep",
  "focus",
  "car_connection",
] as const;
export type DeliveryTimingSignal = (typeof DELIVERY_TIMING_SIGNALS)[number];

export interface OwnerStateFact {
  readonly signal: DeliveryTimingSignal;
  readonly value: string;
  readonly secondsAgo: number;
}

export interface DeliveryTimingModel {
  estimateMicros(input: DeliveryTimingQuestion): number;
  probability(input: DeliveryTimingQuestion & { readonly signal: AbortSignal }): Promise<number>;
}

export interface DeliveryTimingQuestion {
  readonly pushClass: PushClass;
  readonly facts: readonly OwnerStateFact[];
}

export type DeliveryTimingReason =
  | "timing_unknown"
  | "timing_clear"
  | "timing_budget"
  | "timing_failed"
  | "timing_rate"
  | "timing_busy";

export interface DeliveryTimingJudgement {
  readonly action: "deliver" | "defer";
  readonly reasonCode: string;
  readonly confidencePermille: number | null;
  readonly signals: readonly DeliveryTimingSignal[];
  readonly judged: boolean;
}

export const DELIVERY_TIMING_RECORD_TYPES = [
  "speech.utterance",
  "motion.activity",
  "health.sample",
  "context.focus",
  "context.connectivity",
] as const;

export function deliveryTimingLookbackMs(configuration: DeliveryTimingConfiguration): number {
  return (
    Math.max(
      configuration.speechFreshSeconds,
      configuration.motionFreshSeconds,
      configuration.sleepFreshSeconds,
      configuration.focusFreshSeconds,
      configuration.connectivityFreshSeconds,
    ) * 1000
  );
}

function newest(
  records: readonly PerceptionRecord[],
  type: PerceptionRecord["type"],
): PerceptionRecord | undefined {
  let found: PerceptionRecord | undefined;
  for (const record of records)
    if (record.type === type && (!found || record.occurredAtMs > found.occurredAtMs))
      found = record;
  return found;
}

export function ownerStateFacts(
  records: readonly PerceptionRecord[],
  nowMs: number,
  configuration: DeliveryTimingConfiguration,
): readonly OwnerStateFact[] {
  const facts: OwnerStateFact[] = [];
  const ago = (record: PerceptionRecord) =>
    Math.max(0, Math.floor((nowMs - record.occurredAtMs) / 1000));
  const fresh = (record: PerceptionRecord, seconds: number) =>
    record.status === "active" && nowMs - record.occurredAtMs <= seconds * 1000;
  const speech = records.filter(
    (record) =>
      record.type === "speech.utterance" &&
      fresh(record, configuration.speechFreshSeconds) &&
      record.speakerKind !== null,
  );
  const heard = newest(speech, "speech.utterance");
  if (heard) {
    const others = speech.some(({ speakerKind }) => speakerKind !== "owner");
    facts.push({
      signal: "speech",
      value: others ? "owner_and_others" : "owner_only",
      secondsAgo: ago(heard),
    });
  }
  const motion = newest(records, "motion.activity");
  if (motion && fresh(motion, configuration.motionFreshSeconds)) {
    const activity = motion.evidence["activity"];
    if (typeof activity === "string")
      facts.push({ signal: "motion", value: activity, secondsAgo: ago(motion) });
  }
  const sleeps = records.filter(
    (record) =>
      record.type === "health.sample" &&
      record.evidence["subtype"] === "sleep" &&
      fresh(record, configuration.sleepFreshSeconds),
  );
  const slept = newest(sleeps, "health.sample");
  if (slept) {
    const endMs = slept.evidence["endMs"];
    const asleep = typeof endMs !== "number" || endMs >= nowMs;
    facts.push({ signal: "sleep", value: asleep ? "asleep" : "awake", secondsAgo: ago(slept) });
  }
  const focus = newest(records, "context.focus");
  if (focus && fresh(focus, configuration.focusFreshSeconds))
    facts.push({
      signal: "focus",
      value: focus.evidence["active"] === true ? "on" : "off",
      secondsAgo: ago(focus),
    });
  const connection = newest(records, "context.connectivity");
  if (connection && fresh(connection, configuration.connectivityFreshSeconds))
    facts.push({
      signal: "car_connection",
      value: connection.evidence["carPlay"] === true ? "connected" : "not_connected",
      secondsAgo: ago(connection),
    });
  return Object.freeze(facts);
}

export interface DeliveryTimingJudgeOptions {
  readonly model: DeliveryTimingModel;
  readonly configuration: () => DeliveryTimingConfiguration;
  readonly reserve: (micros: number) => Promise<boolean>;
  readonly now: () => number;
}

interface Remembered {
  readonly judged: Promise<DeliveryTimingJudgement>;
  readonly at: number;
}

const REMEMBERED_ENTRIES = 64;

function unknown(): DeliveryTimingJudgement {
  return Object.freeze({
    action: "deliver",
    reasonCode: "timing_unknown",
    confidencePermille: null,
    signals: Object.freeze([]),
    judged: false,
  });
}

export class DeliveryTimingJudge {
  readonly #options: DeliveryTimingJudgeOptions;
  readonly #remembered = new Map<string, Remembered>();
  #recent: number[] = [];

  constructor(options: DeliveryTimingJudgeOptions) {
    this.#options = options;
  }

  async decide(question: DeliveryTimingQuestion): Promise<DeliveryTimingJudgement> {
    if (question.facts.length === 0) return unknown();
    const configuration = this.#options.configuration();
    const at = this.#options.now();
    const key = JSON.stringify([
      question.pushClass,
      question.facts.map(({ signal, value }) => [signal, value]),
    ]);
    for (const [name, entry] of this.#remembered)
      if (at - entry.at > configuration.recheckSeconds * 1000) this.#remembered.delete(name);
    const known = this.#remembered.get(key);
    if (known) return known.judged;
    this.#recent = this.#recent.filter((time) => at - time < 60_000);
    if (this.#recent.length >= configuration.perMinute)
      return this.#settled(question, "deliver", "timing_rate", null, false);
    this.#recent.push(at);
    const judged = this.#reserveAndJudge(question, configuration);
    this.#remembered.set(key, { judged, at });
    while (this.#remembered.size > REMEMBERED_ENTRIES) {
      const oldest = this.#remembered.keys().next().value;
      if (oldest === undefined) break;
      this.#remembered.delete(oldest);
    }
    const result = await judged;
    if (result.reasonCode === "timing_budget" || result.reasonCode === "timing_failed")
      if (this.#remembered.get(key)?.judged === judged) this.#remembered.delete(key);
    return result;
  }

  #settled(
    question: DeliveryTimingQuestion,
    action: "deliver" | "defer",
    reasonCode: string,
    confidencePermille: number | null,
    judged: boolean,
  ): DeliveryTimingJudgement {
    return Object.freeze({
      action,
      reasonCode,
      confidencePermille,
      signals: Object.freeze([...new Set(question.facts.map(({ signal }) => signal))]),
      judged,
    });
  }

  async #reserveAndJudge(
    question: DeliveryTimingQuestion,
    configuration: DeliveryTimingConfiguration,
  ): Promise<DeliveryTimingJudgement> {
    let reserved = false;
    try {
      reserved = await this.#options.reserve(this.#options.model.estimateMicros(question));
    } catch {
      reserved = false;
    }
    if (!reserved) return this.#settled(question, "deliver", "timing_budget", null, false);
    try {
      const probability = await this.#options.model.probability({
        ...question,
        signal: AbortSignal.timeout(configuration.timeoutMs),
      });
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        return this.#settled(question, "deliver", "timing_failed", null, false);
      const permille = Math.round(probability * 1000);
      return probability * 1000 >= configuration.busyAtLeastPermille
        ? this.#settled(question, "defer", "timing_busy", permille, true)
        : this.#settled(question, "deliver", "timing_clear", permille, true);
    } catch {
      return this.#settled(question, "deliver", "timing_failed", null, false);
    }
  }
}

export function deliveryTimingDeadlineMs(
  pushClass: PushClass,
  createdAtMs: number,
  configuration: DeliveryTimingConfiguration,
): number {
  const seconds =
    pushClass === "scheduled_reminder"
      ? configuration.reminderMaximumDeferSeconds
      : configuration.maximumDeferSeconds;
  return createdAtMs + seconds * 1000;
}
