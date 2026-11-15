import type {
  ClockPort,
  PayloadProtectorPort,
  PayloadStorePort,
  StoredThinkEntry,
  ThinkInboxStorePort,
  ThinkWorthPort,
} from "@himawari-agent/application";
import { judgeThinkWorth, THINK_WORTH_DEFAULTS } from "@himawari-agent/application";
import type { ProductionThinkInbox } from "./production-think-inbox.js";

export interface ThinkRunResult {
  readonly outcome: "proposed" | "skipped";
  readonly reasonCode: string;
}

export interface ThinkRunner {
  think(input: {
    readonly entry: StoredThinkEntry;
    readonly summary: string;
    readonly signal: AbortSignal;
  }): Promise<ThinkRunResult>;
}

export interface ThinkWorkerOptions {
  readonly scope: Parameters<ThinkInboxStorePort["usage"]>[0] extends infer Input
    ? Omit<Input & object, "day">
    : never;
  readonly inbox: Pick<ProductionThinkInbox, "maintain" | "sources">;
  readonly store: ThinkInboxStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly worth: {
    readonly port: ThinkWorthPort;
    readonly yesAtLeastPermille?: number;
    readonly noAtMostPermille?: number;
    readonly requestTimeoutMs?: number;
  };
  readonly runner: ThinkRunner;
  readonly runTimeoutMs: number;
  readonly onFailure?: (entryId: string, error: unknown) => void;
}

export type ThinkWorkerStep =
  | { readonly status: "idle" }
  | {
      readonly status: "done";
      readonly entryId: string;
      readonly outcome: string;
      readonly reasonCode: string;
    }
  | { readonly status: "aborted"; readonly entryId?: string }
  | { readonly status: "unsettled"; readonly entryId: string };

export class ProductionThinkWorker {
  readonly #options: ThinkWorkerOptions;

  constructor(options: ThinkWorkerOptions) {
    this.#options = options;
  }

  async runOnce(signal?: AbortSignal): Promise<ThinkWorkerStep> {
    if (signal?.aborted) return { status: "aborted" };
    const { store, scope, clock } = this.#options;
    const report = (entryId: string, error: unknown) => {
      if (signal?.aborted) return;
      try {
        this.#options.onFailure?.(entryId, error);
      } catch {}
    };
    await this.#options.inbox.maintain().catch((error: unknown) => report("", error));
    const entry = await store.claimNext({ ...scope, now: clock.now() });
    if (!entry) return { status: "idle" };
    const settle = async (to: "proposed" | "skipped" | "failed", reasonCode: string) => {
      await store.finish({ ...scope, id: entry.id, to, reasonCode, now: clock.now() });
      return { status: "done" as const, entryId: entry.id, outcome: to, reasonCode };
    };
    try {
      const source = this.#options.inbox.sources.get(entry.sourceKind);
      if (!source) return await settle("failed", "source_unregistered");
      const summary = await this.#summary(entry);
      if (summary === undefined) return await settle("failed", "summary_missing");
      const verdict = await this.#decide(entry, source.describe, summary, signal).catch(
        (error: unknown) => {
          report(entry.id, error);
          return undefined;
        },
      );
      if (verdict === undefined) {
        if (signal?.aborted) return { status: "aborted" as const, entryId: entry.id };
        return await settle("failed", "worth_unavailable");
      }
      if (verdict === "skip") return await settle("skipped", "worth_no");
      if (verdict === "unsure") return await settle("skipped", "worth_unsure");
      const run = await this.#options.runner.think({
        entry,
        summary,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.#options.runTimeoutMs)])
          : AbortSignal.timeout(this.#options.runTimeoutMs),
      });
      return await settle(run.outcome, run.reasonCode.slice(0, 64));
    } catch (error) {
      report(entry.id, error);
      if (signal?.aborted) return { status: "aborted" as const, entryId: entry.id };
      return await settle("failed", "think_failed").catch((settleError: unknown) => {
        report(entry.id, settleError);
        return { status: "unsettled" as const, entryId: entry.id };
      });
    }
  }

  async #summary(entry: StoredThinkEntry): Promise<string | undefined> {
    if (entry.summaryRef === null) return undefined;
    const payload = await this.#options.payloads.get(entry.summaryRef as never);
    if (!payload) return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({ ...this.#options.scope, payload }),
    );
  }

  async #decide(
    entry: StoredThinkEntry,
    sourceDescription: string,
    summary: string,
    signal?: AbortSignal,
  ) {
    const worth = this.#options.worth;
    const timeout = AbortSignal.timeout(
      worth.requestTimeoutMs ?? THINK_WORTH_DEFAULTS.requestTimeoutMs,
    );
    const answer = await worth.port.decide(
      {
        sourceKind: entry.sourceKind,
        sourceDescription,
        summary,
        externalContent: entry.externalContent,
      },
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    return judgeThinkWorth(answer, {
      yesAtLeastPermille: worth.yesAtLeastPermille ?? THINK_WORTH_DEFAULTS.yesAtLeastPermille,
      noAtMostPermille: worth.noAtMostPermille ?? THINK_WORTH_DEFAULTS.noAtMostPermille,
    });
  }
}
