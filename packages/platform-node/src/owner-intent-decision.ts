import {
  OWNER_INTENT_QUESTION_NAME,
  OwnerIntentDecisionFailure,
  type OwnerIntentCheckPort,
  type OwnerIntentCheckRequest,
  parseOwnerIntentDecision,
} from "@himawari-agent/application";
import { OWNER_INTENT_QUESTION } from "@himawari-agent/prompt-catalog";
import { redactForExternalText, sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";

export const OWNER_INTENT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 32_768;

export interface OwnerIntentDecisionOptions {
  readonly model: string;
  readonly apiKey: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

type Redactor = (text: string) => string;

function redactedValue(value: unknown, redact: Redactor): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactedValue(entry, redact));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        redact(key),
        redactedValue(entry, redact),
      ]),
    );
  return value;
}

export function ownerIntentRequestBody(model: string, request: OwnerIntentCheckRequest): string {
  const options = { known: new Map<string, string>(), tag: sequentialPlaceholderTag() };
  const redact: Redactor = (text) => redactForExternalText(text, options).text;
  const body = JSON.stringify({
    model,
    questions: [
      {
        type: "choice",
        name: OWNER_INTENT_QUESTION_NAME,
        instructions: OWNER_INTENT_QUESTION.text,
        choices: [{ value: "explicit" }, { value: "not_explicit" }],
      },
    ],
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_json",
            data: {
              ownerWords: request.ownerWords.map(redact),
              action: {
                tool: request.action.tool,
                operation: request.action.operation,
                parameters: redactedValue(request.action.parameters, redact),
              },
            },
          },
        ],
      },
    ],
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
    throw new OwnerIntentDecisionFailure("OWNER_INTENT_INPUT_TOO_LARGE");
  return body;
}

export class OwnerIntentDecision implements OwnerIntentCheckPort {
  readonly #options: OwnerIntentDecisionOptions;

  constructor(options: OwnerIntentDecisionOptions) {
    this.#options = options;
  }

  async check(request: OwnerIntentCheckRequest, signal: AbortSignal): Promise<unknown> {
    const base = (this.#options.baseUrl ?? OWNER_INTENT_GATEWAY_BASE_URL).replace(/\/+$/u, "");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#options.apiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: ownerIntentRequestBody(this.#options.model, request),
      signal,
    });
    if (!response.ok) throw new OwnerIntentDecisionFailure(`OWNER_INTENT_HTTP_${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES)
      throw new OwnerIntentDecisionFailure("OWNER_INTENT_RESPONSE_TOO_LARGE");
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new OwnerIntentDecisionFailure("OWNER_INTENT_RESPONSE_INVALID");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OwnerIntentDecisionFailure("OWNER_INTENT_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new OwnerIntentDecisionFailure("OWNER_INTENT_RESPONSE_INVALID");
    }
    return parseOwnerIntentDecision(body, this.#options.model);
  }
}
