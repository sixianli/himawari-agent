import type { VoiceAddresseeModel } from "@himawari-agent/application";
import { VOICE_ADDRESSEE_QUESTION } from "@himawari-agent/prompt-catalog";
import { redactForExternalText, sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";

export const VOICE_ADDRESSEE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const QUESTION_NAME = "addressed";
const MAX_RESPONSE_BYTES = 65_536;

export interface VoiceAddresseeDecisionOptions {
  readonly model: string;
  readonly inputMicrosPerMillionTokens: number;
  readonly apiKey: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export class VoiceAddresseeDecisionFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "VoiceAddresseeDecisionFailure";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function voiceAddresseeProbability(body: unknown, model: string): number {
  if (!isRecord(body) || body["model"] !== model)
    throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_MODEL_MISMATCH");
  const answers = body["answers"];
  if (!Array.isArray(answers) || answers.length !== 1)
    throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_ANSWER_INVALID");
  const answer: unknown = answers[0];
  if (!isRecord(answer) || answer["type"] !== "predicate" || answer["name"] !== QUESTION_NAME)
    throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_ANSWER_INVALID");
  const probability = answer["probability"];
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_ANSWER_INVALID");
  return probability;
}

export function voiceAddresseeRequestBody(
  model: string,
  input: { readonly heardName: string; readonly text: string },
): string {
  const options = { known: new Map<string, string>(), tag: sequentialPlaceholderTag() };
  return JSON.stringify({
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_json",
            data: {
              assistantName: redactForExternalText(input.heardName, options).text,
              heardSentence: redactForExternalText(input.text, options).text,
            },
          },
        ],
      },
    ],
    questions: [
      { type: "predicate", name: QUESTION_NAME, instructions: VOICE_ADDRESSEE_QUESTION.text },
    ],
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
}

export class VoiceAddresseeDecision implements VoiceAddresseeModel {
  readonly #options: VoiceAddresseeDecisionOptions;

  constructor(options: VoiceAddresseeDecisionOptions) {
    this.#options = options;
  }

  estimateMicros(input: { readonly heardName: string; readonly text: string }): number {
    const characters =
      [...VOICE_ADDRESSEE_QUESTION.text].length +
      [...input.heardName].length +
      [...input.text].length;
    return Math.ceil((characters * this.#options.inputMicrosPerMillionTokens) / 1_000_000);
  }

  async probability(input: {
    readonly heardName: string;
    readonly text: string;
    readonly signal: AbortSignal;
  }): Promise<number> {
    const base = (this.#options.baseUrl ?? VOICE_ADDRESSEE_GATEWAY_BASE_URL).replace(/\/+$/u, "");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#options.apiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: voiceAddresseeRequestBody(this.#options.model, input),
      signal: input.signal,
    });
    if (!response.ok)
      throw new VoiceAddresseeDecisionFailure(`VOICE_ADDRESSEE_HTTP_${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
      throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_RESPONSE_TOO_LARGE");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_RESPONSE_INVALID");
    }
    return voiceAddresseeProbability(body, this.#options.model);
  }
}
