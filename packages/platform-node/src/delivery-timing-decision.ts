import type { DeliveryTimingModel, DeliveryTimingQuestion } from "@himawari-agent/application";
import { DELIVERY_TIMING_QUESTION } from "@himawari-agent/prompt-catalog";
import { redactForExternalText, sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";

export const DELIVERY_TIMING_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const QUESTION_NAME = "unwelcome";
const MAX_RESPONSE_BYTES = 65_536;

export interface DeliveryTimingDecisionOptions {
  readonly model: string;
  readonly inputMicrosPerMillionTokens: number;
  readonly apiKey: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export class DeliveryTimingDecisionFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "DeliveryTimingDecisionFailure";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deliveryTimingProbability(body: unknown, model: string): number {
  if (!isRecord(body) || body["model"] !== model)
    throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_MODEL_MISMATCH");
  const answers = body["answers"];
  if (!Array.isArray(answers) || answers.length !== 1)
    throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_ANSWER_INVALID");
  const answer: unknown = answers[0];
  if (!isRecord(answer) || answer["type"] !== "predicate" || answer["name"] !== QUESTION_NAME)
    throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_ANSWER_INVALID");
  const probability = answer["probability"];
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_ANSWER_INVALID");
  return probability;
}

export function deliveryTimingRequestBody(model: string, input: DeliveryTimingQuestion): string {
  const options = { known: new Map<string, string>(), tag: sequentialPlaceholderTag() };
  return JSON.stringify({
    model,
    questions: [
      { type: "predicate", name: QUESTION_NAME, instructions: DELIVERY_TIMING_QUESTION.text },
    ],
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_json",
            data: {
              notificationKind: input.pushClass,
              ownerReports: input.facts.map(({ signal, value, secondsAgo }) => ({
                signal,
                value: redactForExternalText(value, options).text,
                secondsAgo,
              })),
            },
          },
        ],
      },
    ],
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
}

export class DeliveryTimingDecision implements DeliveryTimingModel {
  readonly #options: DeliveryTimingDecisionOptions;

  constructor(options: DeliveryTimingDecisionOptions) {
    this.#options = options;
  }

  estimateMicros(input: DeliveryTimingQuestion): number {
    const characters = [...deliveryTimingRequestBody("", input)].length;
    return Math.ceil((characters * this.#options.inputMicrosPerMillionTokens) / 1_000_000);
  }

  async probability(
    input: DeliveryTimingQuestion & { readonly signal: AbortSignal },
  ): Promise<number> {
    const base = (this.#options.baseUrl ?? DELIVERY_TIMING_GATEWAY_BASE_URL).replace(/\/+$/u, "");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#options.apiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: deliveryTimingRequestBody(this.#options.model, input),
      signal: input.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeliveryTimingDecisionFailure(`DELIVERY_TIMING_HTTP_${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_RESPONSE_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_RESPONSE_INVALID");
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DeliveryTimingDecisionFailure("DELIVERY_TIMING_RESPONSE_INVALID");
    }
    return deliveryTimingProbability(body, this.#options.model);
  }
}
