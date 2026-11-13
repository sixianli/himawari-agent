import {
  IMPORT_DUPLICATE_NONE,
  type ImportDuplicateAnswer,
  ImportDuplicateDecisionFailure,
  type ImportDuplicateDecisionPort,
  importDuplicateCandidateName,
  parseImportDuplicateAnswers,
} from "@himawari-agent/application";
import { MEMORY_IMPORT_DUPLICATE_QUESTION, renderPrompt } from "@himawari-agent/prompt-catalog";
import { redactForExternalText, sequentialPlaceholderTag } from "@himawari-agent/sensitive-capture";

export const IMPORT_DUPLICATE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const MAX_RESPONSE_BYTES = 1_048_576;

export interface MemoryImportDuplicateDecisionOptions {
  readonly model: string;
  readonly apiKey: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export function importDuplicateRequestBody(
  model: string,
  input: {
    readonly existing: readonly { readonly key: string; readonly text: string }[];
    readonly candidates: readonly { readonly text: string }[];
  },
): string {
  const options = { known: new Map<string, string>(), tag: sequentialPlaceholderTag() };
  const choices = [
    ...input.existing.map(({ key }) => ({ value: key })),
    { value: IMPORT_DUPLICATE_NONE },
  ];
  return JSON.stringify({
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_json",
            data: {
              existing: input.existing.map(({ key, text }) => ({
                id: key,
                text: redactForExternalText(text, options).text,
              })),
              candidates: input.candidates.map(({ text }, index) => ({
                id: importDuplicateCandidateName(index),
                text: redactForExternalText(text, options).text,
              })),
            },
          },
        ],
      },
    ],
    questions: input.candidates.map((_, index) => ({
      type: "choice",
      name: importDuplicateCandidateName(index),
      instructions: renderPrompt(MEMORY_IMPORT_DUPLICATE_QUESTION, {
        candidateId: importDuplicateCandidateName(index),
      }),
      choices,
    })),
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
}

export class MemoryImportDuplicateDecision implements ImportDuplicateDecisionPort {
  readonly #options: MemoryImportDuplicateDecisionOptions;

  constructor(options: MemoryImportDuplicateDecisionOptions) {
    this.#options = options;
  }

  async decide(input: {
    readonly existing: readonly { readonly key: string; readonly text: string }[];
    readonly candidates: readonly { readonly text: string }[];
    readonly signal: AbortSignal;
  }): Promise<readonly (ImportDuplicateAnswer | undefined)[]> {
    const base = (this.#options.baseUrl ?? IMPORT_DUPLICATE_GATEWAY_BASE_URL).replace(/\/+$/u, "");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.#options.apiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: importDuplicateRequestBody(this.#options.model, input),
      signal: input.signal,
    });
    if (!response.ok)
      throw new ImportDuplicateDecisionFailure(`IMPORT_DUPLICATE_HTTP_${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
      throw new ImportDuplicateDecisionFailure("IMPORT_DUPLICATE_RESPONSE_TOO_LARGE");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ImportDuplicateDecisionFailure("IMPORT_DUPLICATE_RESPONSE_INVALID");
    }
    return parseImportDuplicateAnswers(
      body,
      this.#options.model,
      input.candidates.length,
      input.existing.map(({ key }) => key),
    );
  }
}
