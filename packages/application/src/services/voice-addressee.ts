import type { VoiceTrigger } from "./voice-command.js";

export const VOICE_ADDRESSEE_REFUSALS = [
  "not_addressed",
  "addressed_unsure",
  "addressed_budget",
] as const;
export type VoiceAddresseeRefusal = (typeof VOICE_ADDRESSEE_REFUSALS)[number];
export type VoiceAddresseeOutcome = "addressed" | VoiceAddresseeRefusal;

export interface VoiceAddresseeConfiguration {
  readonly yesAtLeastPermille: number;
  readonly noAtMostPermille: number;
  readonly timeoutMs: number;
  readonly perDevicePerMinute: number;
  readonly maximumCharacters: number;
  readonly cacheSeconds: number;
  readonly cacheEntriesPerDevice: number;
}

export const VOICE_ADDRESSEE_DEFAULTS: VoiceAddresseeConfiguration = Object.freeze({
  yesAtLeastPermille: 700,
  noAtMostPermille: 300,
  timeoutMs: 1500,
  perDevicePerMinute: 20,
  maximumCharacters: 1024,
  cacheSeconds: 600,
  cacheEntriesPerDevice: 64,
});

export const VOICE_ADDRESSEE_RANGES: Readonly<
  Record<keyof VoiceAddresseeConfiguration, readonly [number, number]>
> = Object.freeze({
  yesAtLeastPermille: [500, 1000],
  noAtMostPermille: [0, 500],
  timeoutMs: [200, 10_000],
  perDevicePerMinute: [1, 600],
  maximumCharacters: [16, 4096],
  cacheSeconds: [10, 86_400],
  cacheEntriesPerDevice: [1, 4096],
});

export interface VoiceAddresseeModel {
  estimateMicros(input: { readonly heardName: string; readonly text: string }): number;
  probability(input: {
    readonly heardName: string;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<number>;
}

export interface VoiceAddresseeRequest {
  readonly deviceId: string;
  readonly utteranceId: string;
  readonly trigger: VoiceTrigger;
  readonly heardName: string | null;
  readonly text: string;
}

export interface VoiceAddresseeJudgeOptions {
  readonly model: VoiceAddresseeModel;
  readonly configuration: () => VoiceAddresseeConfiguration;
  readonly reserve: (micros: number) => Promise<boolean>;
  readonly now: () => number;
}

interface Remembered {
  readonly judged: Promise<VoiceAddresseeOutcome | null>;
  readonly at: number;
}

function sameWords(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function outcomeForProbability(
  probability: number,
  configuration: VoiceAddresseeConfiguration,
): VoiceAddresseeOutcome {
  const permille = probability * 1000;
  if (permille >= configuration.yesAtLeastPermille) return "addressed";
  if (permille <= configuration.noAtMostPermille) return "not_addressed";
  return "addressed_unsure";
}

export class VoiceAddresseeJudge {
  readonly #options: VoiceAddresseeJudgeOptions;
  readonly #remembered = new Map<string, Map<string, Remembered>>();
  readonly #recent = new Map<string, number[]>();

  constructor(options: VoiceAddresseeJudgeOptions) {
    this.#options = options;
  }

  async decide(request: VoiceAddresseeRequest): Promise<VoiceAddresseeOutcome> {
    if (request.trigger === "hands_on") return "addressed";
    const configuration = this.#options.configuration();
    if (request.heardName === null || [...request.text].length > configuration.maximumCharacters)
      return "addressed_unsure";
    const at = this.#options.now();
    const device = this.#device(request.deviceId, at, configuration);
    const key = JSON.stringify([
      request.utteranceId,
      request.trigger,
      request.heardName,
      sameWords(request.text),
    ]);
    const known = device.get(key);
    if (known) return (await known.judged) ?? "addressed_unsure";
    if (!this.#admit(request.deviceId, at, configuration)) return "addressed_unsure";
    const input = { heardName: request.heardName, text: request.text };
    if (!(await this.#options.reserve(this.#options.model.estimateMicros(input))))
      return "addressed_budget";
    const judged = this.#judge(input, configuration);
    device.set(key, { judged, at });
    while (device.size > configuration.cacheEntriesPerDevice) {
      const oldest = device.keys().next().value;
      if (oldest === undefined) break;
      device.delete(oldest);
    }
    const outcome = await judged;
    if (outcome === null) {
      if (device.get(key)?.judged === judged) device.delete(key);
      return "addressed_unsure";
    }
    return outcome;
  }

  async #judge(
    input: { readonly heardName: string; readonly text: string },
    configuration: VoiceAddresseeConfiguration,
  ): Promise<VoiceAddresseeOutcome | null> {
    try {
      const probability = await this.#options.model.probability({
        ...input,
        signal: AbortSignal.timeout(configuration.timeoutMs),
      });
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
      return outcomeForProbability(probability, configuration);
    } catch {
      return null;
    }
  }

  #device(
    deviceId: string,
    at: number,
    configuration: VoiceAddresseeConfiguration,
  ): Map<string, Remembered> {
    const device = this.#remembered.get(deviceId) ?? new Map<string, Remembered>();
    this.#remembered.set(deviceId, device);
    for (const [key, entry] of device)
      if (at - entry.at > configuration.cacheSeconds * 1000) device.delete(key);
    return device;
  }

  #admit(deviceId: string, at: number, configuration: VoiceAddresseeConfiguration): boolean {
    const recent = (this.#recent.get(deviceId) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= configuration.perDevicePerMinute) {
      this.#recent.set(deviceId, recent);
      return false;
    }
    recent.push(at);
    this.#recent.set(deviceId, recent);
    return true;
  }
}
