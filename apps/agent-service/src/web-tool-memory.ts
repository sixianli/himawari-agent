import { createHash } from "node:crypto";
import type {
  RuntimeToolExecutionResult,
  RuntimeToolSettledResult,
  WebProviderId,
} from "@himawari-agent/application";

const SEARCH_TTL_MS = 10 * 60 * 1000;
const FETCH_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 128;
const BREAKER_FAILURES = 3;
const BREAKER_WINDOW_MS = 5 * 60 * 1000;
const BREAKER_OPEN_MS = 2 * 60 * 1000;

type WebTool = "web_search" | "web_fetch";

export class WebToolMemory {
  readonly #now: () => number;
  readonly #results = new Map<
    string,
    { readonly expiresAt: number; readonly result: RuntimeToolSettledResult }
  >();
  readonly #failures = new Map<WebProviderId, number[]>();
  readonly #openUntil = new Map<WebProviderId, number>();

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  key(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly tool: WebTool;
    readonly providers: readonly WebProviderId[];
    readonly arguments: Record<string, unknown>;
  }): string {
    const args =
      input.tool === "web_search"
        ? {
            query: String(input.arguments["query"] ?? "")
              .trim()
              .replace(/\s+/g, " ")
              .toLowerCase(),
            limit: input.arguments["limit"] ?? 5,
          }
        : { url: input.arguments["url"], offset: input.arguments["offset"] ?? 0 };
    return createHash("sha256")
      .update(
        JSON.stringify([
          input.ownerId,
          input.agentId,
          input.tool,
          [...input.providers].sort(),
          args,
        ]),
      )
      .digest("hex");
  }

  cached(key: string): RuntimeToolSettledResult | undefined {
    const entry = this.#results.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#results.delete(key);
      return undefined;
    }
    return entry.result;
  }

  remember(key: string, tool: WebTool, result: RuntimeToolExecutionResult): void {
    if (result.outcome !== "succeeded" || !result.modelContent) return;
    this.#results.delete(key);
    this.#results.set(key, {
      expiresAt: this.#now() + (tool === "web_search" ? SEARCH_TTL_MS : FETCH_TTL_MS),
      result: {
        outcome: "succeeded",
        dispatchState: "not_sent",
        resultRef: null,
        errorCode: null,
        externalActionId: null,
        modelContent: result.modelContent,
      },
    });
    while (this.#results.size > MAX_ENTRIES) {
      const oldest = this.#results.keys().next().value;
      if (oldest === undefined) break;
      this.#results.delete(oldest);
    }
  }

  order(providers: readonly WebProviderId[]): readonly WebProviderId[] {
    const now = this.#now();
    const healthy = providers.filter((id) => (this.#openUntil.get(id) ?? 0) <= now);
    if (!healthy.length || healthy.length === providers.length) return providers;
    return [...healthy, ...providers.filter((id) => !healthy.includes(id))];
  }

  observe(providers: readonly WebProviderId[], result: RuntimeToolExecutionResult): void {
    if (result.outcome === "awaiting_approval" || result.outcome === "result_unknown") return;
    const now = this.#now();
    let report: { provider?: unknown; fallbackFrom?: unknown } = {};
    try {
      report = JSON.parse(result.modelContent) as typeof report;
    } catch {
      report = {};
    }
    const failed = Array.isArray(report.fallbackFrom)
      ? report.fallbackFrom
          .map((entry) => (entry as { provider?: unknown }).provider)
          .filter((id): id is WebProviderId => providers.includes(id as WebProviderId))
      : [];
    if (result.outcome === "failed" && result.dispatchState === "accepted")
      failed.push(...providers.filter((id) => !failed.includes(id)));
    for (const id of failed) {
      const recent = (this.#failures.get(id) ?? []).filter((at) => now - at < BREAKER_WINDOW_MS);
      recent.push(now);
      this.#failures.set(id, recent);
      if (recent.length >= BREAKER_FAILURES) {
        this.#openUntil.set(id, now + BREAKER_OPEN_MS);
        this.#failures.delete(id);
      }
    }
    if (
      result.outcome === "succeeded" &&
      typeof report.provider === "string" &&
      providers.includes(report.provider as WebProviderId)
    ) {
      this.#failures.delete(report.provider as WebProviderId);
      this.#openUntil.delete(report.provider as WebProviderId);
    }
  }
}
