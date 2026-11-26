import type { SpeechConfiguration } from "@himawari-agent/application";
import { redactForExternalText } from "@himawari-agent/sensitive-capture";

export const SPEECH_ERROR_CODES = Object.freeze({
  INPUT_INVALID: "SPEECH_INPUT_INVALID",
  SENSITIVE_TEXT: "SPEECH_SENSITIVE_TEXT",
  FIRST_AUDIO_TIMEOUT: "SPEECH_FIRST_AUDIO_TIMEOUT",
  UPSTREAM_REJECTED: "SPEECH_UPSTREAM_REJECTED",
  UPSTREAM_FAILED: "SPEECH_UPSTREAM_FAILED",
  RESPONSE_UNRECOGNIZED: "SPEECH_RESPONSE_UNRECOGNIZED",
} as const);

export type SpeechErrorCode = (typeof SPEECH_ERROR_CODES)[keyof typeof SPEECH_ERROR_CODES];

export class SpeechSynthesisError extends Error {
  readonly code: SpeechErrorCode;
  readonly upstreamStatus: number | undefined;

  constructor(code: SpeechErrorCode, upstreamStatus?: number) {
    super(code);
    this.name = "SpeechSynthesisError";
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface SpeechAudio {
  readonly mediaType: string;
  readonly sampleRate: number;
  readonly firstAudioMs: number;
  readonly characters: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}

export interface SpeechSynthesisPort {
  synthesize(input: { readonly text: string; readonly signal?: AbortSignal }): Promise<SpeechAudio>;
}

export const DASHSCOPE_QWEN_TTS_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
export const DASHSCOPE_QWEN_TTS_SAMPLE_RATE = 24_000;
export const SPEECH_PCM_MEDIA_TYPE = `audio/L16;rate=${DASHSCOPE_QWEN_TTS_SAMPLE_RATE};channels=1`;
const SSE_LINE_LIMIT = 4 * 1024 * 1024;

export interface MagpieSpeechOptions {
  readonly configuration: SpeechConfiguration;
  readonly magpieBaseUrl: string;
  readonly gatewayKey: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function magpieNativeSpeechUrl(baseUrl: string, provider: string): string {
  const root = new URL(baseUrl);
  root.pathname = `/v1/magpie/native/${provider}${DASHSCOPE_QWEN_TTS_PATH}`;
  return root.href;
}

function audioFromEvent(payload: string): Uint8Array | null {
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new SpeechSynthesisError(SPEECH_ERROR_CODES.RESPONSE_UNRECOGNIZED);
  }
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  const code = record["code"];
  if (typeof code === "string" && code !== "")
    throw new SpeechSynthesisError(SPEECH_ERROR_CODES.UPSTREAM_REJECTED);
  const output = record["output"];
  const audio =
    output && typeof output === "object" ? (output as Record<string, unknown>)["audio"] : undefined;
  const data =
    audio && typeof audio === "object" ? (audio as Record<string, unknown>)["data"] : undefined;
  if (typeof data !== "string" || data === "") return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.length === 0 ? null : new Uint8Array(bytes);
}

async function* sseAudio(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  let data: string[] = [];
  const flush = function* (): Generator<Uint8Array> {
    if (data.length === 0) return;
    const audio = audioFromEvent(data.join("\n"));
    data = [];
    if (audio) yield audio;
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    if (buffered.length > SSE_LINE_LIMIT)
      throw new SpeechSynthesisError(SPEECH_ERROR_CODES.RESPONSE_UNRECOGNIZED);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (line === "") yield* flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered.startsWith("data:")) data.push(buffered.slice(5).trimStart());
  yield* flush();
}

export class MagpieDashScopeSpeech implements SpeechSynthesisPort {
  readonly #options: MagpieSpeechOptions;
  readonly #url: string;

  constructor(options: MagpieSpeechOptions) {
    if (options.configuration.adapter !== "dashscope-qwen-tts")
      throw new Error("SPEECH_ADAPTER_UNSUPPORTED");
    this.#options = options;
    this.#url = magpieNativeSpeechUrl(options.magpieBaseUrl, options.configuration.provider);
  }

  async synthesize(input: {
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<SpeechAudio> {
    const configuration = this.#options.configuration;
    const text = input.text.trim();
    const characters = [...text].length;
    if (characters === 0 || characters > configuration.maximumCharacters)
      throw new SpeechSynthesisError(SPEECH_ERROR_CODES.INPUT_INVALID);
    if (redactForExternalText(text).findings.length > 0)
      throw new SpeechSynthesisError(SPEECH_ERROR_CODES.SENSITIVE_TEXT);
    const now = this.#options.now ?? (() => performance.now());
    const started = now();
    const abort = new AbortController();
    const forward = () => abort.abort();
    input.signal?.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, configuration.firstAudioTimeoutMs);
    const release = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", forward);
    };
    const failure = (error: unknown): SpeechSynthesisError => {
      if (timedOut) return new SpeechSynthesisError(SPEECH_ERROR_CODES.FIRST_AUDIO_TIMEOUT);
      if (error instanceof SpeechSynthesisError) return error;
      return new SpeechSynthesisError(SPEECH_ERROR_CODES.UPSTREAM_FAILED);
    };
    let iterator: AsyncGenerator<Uint8Array>;
    let first: IteratorResult<Uint8Array>;
    try {
      const response = await (this.#options.fetch ?? fetch)(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.#options.gatewayKey()}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-dashscope-sse": "enable",
        },
        body: JSON.stringify({
          model: configuration.model,
          input: {
            text,
            voice: configuration.voice,
            language_type: configuration.languageType,
          },
        }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechSynthesisError(SPEECH_ERROR_CODES.UPSTREAM_REJECTED, response.status);
      }
      iterator = sseAudio(response.body);
      first = await iterator.next();
    } catch (error) {
      release();
      throw failure(error);
    }
    clearTimeout(timer);
    if (first.done) {
      release();
      throw new SpeechSynthesisError(SPEECH_ERROR_CODES.RESPONSE_UNRECOGNIZED);
    }
    const firstAudioMs = Math.max(0, Math.round(now() - started));
    const head = first.value;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      try {
        yield head;
        yield* iterator;
      } finally {
        release();
        abort.abort();
      }
    }
    return {
      mediaType: SPEECH_PCM_MEDIA_TYPE,
      sampleRate: DASHSCOPE_QWEN_TTS_SAMPLE_RATE,
      firstAudioMs,
      characters,
      chunks: chunks(),
    };
  }
}
