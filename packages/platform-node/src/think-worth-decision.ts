import {
  parseThinkWorthDecision,
  THINK_WORTH_CHOICE_NOT_WORTH,
  THINK_WORTH_CHOICE_WORTH,
  THINK_WORTH_QUESTION_NAME,
  type ThinkWorthAnswer,
  ThinkWorthDecisionFailure,
  type ThinkWorthPort,
  type ThinkWorthRequest,
} from "@himawari-agent/application";
import { THINK_WORTH_QUESTION } from "@himawari-agent/prompt-catalog";
import { redactForExternalText, sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";

export const THINK_WORTH_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 32_768;

export interface ThinkWorthDecisionOptions {
  readonly model: string;
  readonly apiKey: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export function thinkWorthRequestBody(model: string, request: ThinkWorthRequest): string {
  const options = { known: new Map<string, string>(), tag: sequentialPlaceholderTag() };
  const redact = (text: string) => redactForExternalText(text, options).text;
  const body = JSON.stringify({
    model,
    questions: [
      {
        type: "choice",
        name: THINK_WORTH_QUESTION_NAME,
        instructions: THINK_WORTH_QUESTION.text,
        choices: [{ value: THINK_WORTH_CHOICE_WORTH }, { value: THINK_WORTH_CHOICE_NOT_WORTH }],
      },
    ],
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_json",
            data: {
              source: redact(request.sourceDescription),
              summary: redact(request.summary),
              externalContent: request.externalContent,
            },
          },
        ],
      },
    ],
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
    throw new ThinkWorthDecisionFailure("THINK_WORTH_INPUT_TOO_LARGE");
  return body;
}

export class ThinkWorthDecision implements ThinkWorthPort {
  readonly #options: ThinkWorthDecisionOptions;

  constructor(options: ThinkWorthDecisionOptions) {
    this.#options = options;
  }

  async decide(request: ThinkWorthRequest, signal: AbortSignal): Promise<ThinkWorthAnswer> {
    const base = (this.#options.baseUrl ?? THINK_WORTH_GATEWAY_BASE_URL).replace(/\/+$/u, "");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#options.apiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: thinkWorthRequestBody(this.#options.model, request),
      signal,
    });
    if (!response.ok) throw new ThinkWorthDecisionFailure(`THINK_WORTH_HTTP_${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES)
      throw new ThinkWorthDecisionFailure("THINK_WORTH_RESPONSE_TOO_LARGE");
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new ThinkWorthDecisionFailure("THINK_WORTH_RESPONSE_INVALID");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ThinkWorthDecisionFailure("THINK_WORTH_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ThinkWorthDecisionFailure("THINK_WORTH_RESPONSE_INVALID");
    }
    return parseThinkWorthDecision(body, this.#options.model);
  }
}
