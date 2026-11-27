export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly purpose: string;
  readonly session: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
}

export interface ChatResult {
  readonly text: string;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly completionTokens: number;
  readonly ms: number;
}

export interface PurposeUsage {
  calls: number;
  failures: number;
  rateLimited: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  usd: number;
}

export interface ModelPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

export const DEEPSEEK_V4_1_FLASH_PRICES: ModelPrices = Object.freeze({
  input: 0.15e-6,
  output: 0.6e-6,
  cacheRead: 0.003e-6,
});

export class BudgetReachedError extends Error {
  constructor(spent: number, cap: number) {
    super(`BENCH_BUDGET_REACHED ${spent.toFixed(4)} / ${cap}`);
  }
}

export class ChatClient {
  readonly usage = new Map<string, PurposeUsage>();
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #prices: ModelPrices;
  readonly #capUsd: number;
  readonly #fetch: typeof fetch;
  readonly #waiting: (() => void)[] = [];
  #active = 0;
  readonly #concurrency: number;
  readonly #rateLimitPauseMs: number;
  readonly #rateLimitGiveUpMs: number;
  #pausedUntil = 0;
  readonly #bearer: string;

  constructor(options: {
    readonly baseUrl: string;
    readonly model: string;
    readonly prices: ModelPrices;
    readonly capUsd: number;
    readonly concurrency: number;
    readonly fetch?: typeof fetch;
    readonly rateLimitPauseMs?: number;
    readonly rateLimitGiveUpMs?: number;
    readonly bearer?: string;
  }) {
    this.#bearer = options.bearer ?? "proxy-injected";
    this.#rateLimitPauseMs = options.rateLimitPauseMs ?? 60_000;
    this.#rateLimitGiveUpMs = options.rateLimitGiveUpMs ?? 90 * 60_000;
    this.#baseUrl = options.baseUrl;
    this.#model = options.model;
    this.#prices = options.prices;
    this.#capUsd = options.capUsd;
    this.#concurrency = options.concurrency;
    this.#fetch = options.fetch ?? fetch;
  }

  get model(): string {
    return this.#model;
  }

  get spentUsd(): number {
    let total = 0;
    for (const entry of this.usage.values()) total += entry.usd;
    return total;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    await this.#acquire();
    try {
      return await this.#send(request);
    } finally {
      this.#release();
    }
  }

  #entry(purpose: string): PurposeUsage {
    let entry = this.usage.get(purpose);
    if (!entry) {
      entry = {
        calls: 0,
        failures: 0,
        rateLimited: 0,
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        usd: 0,
      };
      this.usage.set(purpose, entry);
    }
    return entry;
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active -= 1;
  }

  async #send(request: ChatRequest): Promise<ChatResult> {
    const entry = this.#entry(request.purpose);
    let lastError = "";
    const limitedSince = { value: null as number | null };
    for (let attempt = 0; attempt < 5; ) {
      if (this.spentUsd >= this.#capUsd) throw new BudgetReachedError(this.spentUsd, this.#capUsd);
      const pause = this.#pausedUntil - Date.now();
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      else if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
      const started = performance.now();
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#bearer}`,
          "x-opencode-session": request.session,
        },
        body: JSON.stringify({
          model: this.#model,
          temperature: 0,
          max_tokens: request.maxTokens,
          thinking: { type: "disabled" },
          messages: request.messages,
        }),
        signal: AbortSignal.timeout(180_000),
      }).catch((error: Error) => error);
      if (response instanceof Error) {
        lastError = `BENCH_MODEL_NETWORK ${response.message}`;
        attempt += 1;
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          prompt_cache_hit_tokens?: number;
        };
      };
      if (!response.ok) {
        lastError = `BENCH_MODEL_${response.status} ${JSON.stringify(body).slice(0, 300)}`;
        if (response.status === 429) {
          entry.rateLimited += 1;
          limitedSince.value ??= Date.now();
          if (Date.now() - limitedSince.value >= this.#rateLimitGiveUpMs) break;
          this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + this.#rateLimitPauseMs);
          continue;
        }
        if (response.status < 500) break;
        attempt += 1;
        continue;
      }
      const promptTokens = body.usage?.prompt_tokens ?? 0;
      const cachedTokens =
        body.usage?.prompt_tokens_details?.cached_tokens ??
        body.usage?.prompt_cache_hit_tokens ??
        0;
      const completionTokens = body.usage?.completion_tokens ?? 0;
      entry.calls += 1;
      entry.promptTokens += promptTokens;
      entry.cachedTokens += cachedTokens;
      entry.completionTokens += completionTokens;
      entry.usd +=
        (promptTokens - cachedTokens) * this.#prices.input +
        cachedTokens * this.#prices.cacheRead +
        completionTokens * this.#prices.output;
      return {
        text: body.choices?.[0]?.message?.content ?? "",
        promptTokens,
        cachedTokens,
        completionTokens,
        ms: Math.round(performance.now() - started),
      };
    }
    entry.failures += 1;
    throw new Error(lastError);
  }
}
