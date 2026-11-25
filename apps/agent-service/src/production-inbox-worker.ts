import {
  type ClockPort,
  INBOX_LOOP_DEFAULTS,
  type InboxConversation,
  type InboxStorePort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type StoredInboxEvent,
} from "@himawari-agent/application";
import {
  INBOX_MAX_ATTEMPTS,
  type InboxScope,
  type InboxSource,
  type ProductionInbox,
} from "./production-inbox.js";

const RUN_SETTLE_MS = 60_000;
const STORED_OUTCOME = /^[a-z][a-z0-9_]{0,31}$/u;

const storableResult = (result: {
  readonly outcome: string;
  readonly reasonCode: string;
  readonly runId: string | null;
}): boolean =>
  STORED_OUTCOME.test(result.outcome) &&
  result.reasonCode.length > 0 &&
  (result.runId === null || (result.runId.length > 0 && result.runId.length <= 256));

export interface InboxDeliveryEvent {
  readonly entry: StoredInboxEvent;
  readonly source: InboxSource;
  readonly summary: string;
}

export type InboxDeliveryResult =
  | {
      readonly status: "handled";
      readonly outcome: string;
      readonly reasonCode: string;
      readonly runId: string | null;
    }
  | { readonly status: "retry"; readonly reasonCode: string }
  | { readonly status: "yield" };

export interface InboxDelivery {
  deliver(input: {
    readonly threadId: string | null;
    readonly fromOwner: boolean;
    readonly events: readonly InboxDeliveryEvent[];
    readonly signal: AbortSignal;
  }): Promise<InboxDeliveryResult>;
  sweep?(): Promise<void>;
}

export interface InboxWorkerOptions {
  readonly scope: InboxScope;
  readonly inbox: Pick<ProductionInbox, "maintain" | "sources">;
  readonly store: InboxStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly delivery: InboxDelivery;
  readonly runTimeoutMs: number;
  readonly eventsPerRun?: number;
  readonly maxAttempts?: number;
  readonly overrides?: () => Promise<Readonly<Record<string, number>>>;
  readonly onFailure?: (entryId: string, error: unknown) => void;
}

export interface InboxClaim {
  readonly threadId: string | null;
  readonly fromOwner: boolean;
  readonly entries: readonly StoredInboxEvent[];
}

export type InboxWorkStep =
  | {
      readonly status: "done";
      readonly entryIds: readonly string[];
      readonly result: "handled" | "retry" | "yield" | "failed";
    }
  | { readonly status: "aborted"; readonly entryIds: readonly string[] }
  | { readonly status: "unsettled"; readonly entryIds: readonly string[] };

export class ProductionInboxWorker {
  readonly #options: InboxWorkerOptions;

  constructor(options: InboxWorkerOptions) {
    this.#options = options;
  }

  async #overrides(): Promise<Readonly<Record<string, number>>> {
    return (await this.#options.overrides?.().catch(() => undefined)) ?? {};
  }

  #runTimeoutMs(overrides: Readonly<Record<string, number>>): number {
    const minutes = overrides["runTimeoutMinutes"];
    return minutes === undefined ? this.#options.runTimeoutMs : minutes * 60_000;
  }

  #report(entryId: string, error: unknown): void {
    try {
      this.#options.onFailure?.(entryId, error);
    } catch {}
  }

  async claim(skip: readonly InboxConversation[] = []): Promise<InboxClaim | undefined> {
    const { store, scope, clock } = this.#options;
    const overrides = await this.#overrides();
    await this.#options.inbox
      .maintain({ runsLastUpToMs: this.#runTimeoutMs(overrides) + RUN_SETTLE_MS })
      .catch((error: unknown) => this.#report("", error));
    await this.#options.delivery.sweep?.().catch((error: unknown) => this.#report("", error));
    const limit =
      overrides["eventsPerRun"] ?? this.#options.eventsPerRun ?? INBOX_LOOP_DEFAULTS.eventsPerRun;
    const entries = await store.claimBatch({ ...scope, now: clock.now(), limit, skip });
    const first = entries[0];
    if (!first) return undefined;
    return Object.freeze({ threadId: first.threadId, fromOwner: first.fromOwner, entries });
  }

  async handle(claim: InboxClaim, signal?: AbortSignal): Promise<InboxWorkStep> {
    const { store, scope, clock } = this.#options;
    const ids = claim.entries.map((entry) => entry.id);
    const overrides = await this.#overrides();
    const maxAttempts = overrides["maxAttempts"] ?? this.#options.maxAttempts ?? INBOX_MAX_ATTEMPTS;
    const runTimeoutMs = this.#runTimeoutMs(overrides);
    const settle = async (
      entryIds: readonly string[],
      to: "done" | "failed",
      outcome: string | null,
      reasonCode: string,
      runId: string | null,
    ) => {
      if (entryIds.length === 0) return;
      await store.finish({
        ...scope,
        ids: entryIds,
        to,
        outcome,
        reasonCode: reasonCode.slice(0, 64),
        runId,
        now: clock.now(),
      });
    };
    const putBack = async (countAttempt: boolean, reasonCode: string) => {
      const spent = countAttempt
        ? claim.entries.filter((entry) => entry.attempts >= maxAttempts).map((entry) => entry.id)
        : [];
      await settle(spent, "failed", null, reasonCode, null);
      const rest = ids.filter((id) => !spent.includes(id));
      if (rest.length > 0)
        await store.release({ ...scope, ids: rest, countAttempt, now: clock.now() });
    };
    try {
      const events: InboxDeliveryEvent[] = [];
      for (const entry of claim.entries) {
        const source = this.#options.inbox.sources.get(entry.sourceKind);
        if (!source) {
          await settle([entry.id], "failed", null, "source_unregistered", null);
          continue;
        }
        const summary = await this.#summary(entry);
        if (summary === undefined) {
          await settle([entry.id], "failed", null, "summary_missing", null);
          continue;
        }
        events.push({ entry, source, summary });
      }
      if (events.length === 0) return { status: "done", entryIds: ids, result: "failed" };
      const deliveredIds = events.map((event) => event.entry.id);
      const timeout = AbortSignal.timeout(runTimeoutMs);
      const result = await this.#options.delivery.deliver({
        threadId: claim.threadId,
        fromOwner: claim.fromOwner,
        events,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (result.status === "handled") {
        const recorded = (to: Parameters<typeof settle>): Promise<boolean> =>
          settle(...to).then(
            () => true,
            (error: unknown) => {
              this.#report(deliveredIds[0] ?? "", error);
              return false;
            },
          );
        const settled: Parameters<typeof settle> = storableResult(result)
          ? [deliveredIds, "done", result.outcome, result.reasonCode, result.runId]
          : [deliveredIds, "done", null, "result_invalid", null];
        if (!storableResult(result))
          this.#report(deliveredIds[0] ?? "", new Error("Inbox delivery result is invalid"));
        if (!(await recorded(settled)) && !(await recorded(settled)))
          return { status: "unsettled", entryIds: ids };
        return { status: "done", entryIds: ids, result: "handled" };
      }
      if (result.status === "yield") {
        await store.release({ ...scope, ids: deliveredIds, countAttempt: false, now: clock.now() });
        return { status: "done", entryIds: ids, result: "yield" };
      }
      await putBack(true, result.reasonCode);
      return { status: "done", entryIds: ids, result: "retry" };
    } catch (error) {
      this.#report(ids[0] ?? "", error);
      if (signal?.aborted) {
        await store
          .release({ ...scope, ids, countAttempt: false, now: clock.now() })
          .catch((releaseError: unknown) => this.#report(ids[0] ?? "", releaseError));
        return { status: "aborted", entryIds: ids };
      }
      try {
        await putBack(true, "delivery_failed");
        return { status: "done", entryIds: ids, result: "retry" };
      } catch (settleError) {
        this.#report(ids[0] ?? "", settleError);
        return { status: "unsettled", entryIds: ids };
      }
    }
  }

  async #summary(entry: StoredInboxEvent): Promise<string | undefined> {
    if (entry.summaryRef === null) return undefined;
    const payload = await this.#options.payloads.get(entry.summaryRef as never);
    if (!payload) return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({ ...this.#options.scope, payload }),
    );
  }
}

export class InboxLoop {
  readonly #worker: Pick<ProductionInboxWorker, "claim" | "handle">;
  readonly #intervalMs: () => Promise<number>;
  readonly #onFailure: (error: unknown) => void;
  readonly #inflight = new Set<Promise<void>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #ticking: Promise<void> | undefined;
  #again = false;

  constructor(options: {
    readonly worker: Pick<ProductionInboxWorker, "claim" | "handle">;
    readonly intervalMs: number | (() => Promise<number>);
    readonly onFailure: (error: unknown) => void;
  }) {
    this.#worker = options.worker;
    const interval = options.intervalMs;
    this.#intervalMs = typeof interval === "number" ? async () => interval : interval;
    this.#onFailure = options.onFailure;
  }

  start(): void {
    if (this.#controller) return;
    this.#controller = new AbortController();
    this.wake();
  }

  wake(): void {
    const controller = this.#controller;
    if (!controller || controller.signal.aborted) return;
    if (this.#ticking) {
      this.#again = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#ticking = this.#tick(controller.signal).finally(() => {
      this.#ticking = undefined;
      if (this.#again) {
        this.#again = false;
        this.wake();
      }
    });
  }

  #fail(error: unknown): void {
    try {
      this.#onFailure(error);
    } catch {}
  }

  async #tick(signal: AbortSignal): Promise<void> {
    const started: InboxConversation[] = [];
    for (;;) {
      if (signal.aborted) return;
      let claim: InboxClaim | undefined;
      try {
        claim = await this.#worker.claim(started);
      } catch (error) {
        this.#fail(error);
        break;
      }
      if (!claim) break;
      const handling: Promise<void> = this.#worker
        .handle(claim, signal)
        .then(
          (step) => step.status === "done" && step.result === "yield",
          (error: unknown) => {
            this.#fail(error);
            return false;
          },
        )
        .then((yielded) => {
          this.#inflight.delete(handling);
          if (!yielded) this.wake();
        });
      this.#inflight.add(handling);
      started.push({ threadId: claim.threadId, fromOwner: claim.fromOwner });
    }
    if (signal.aborted) return;
    const delay = await this.#intervalMs().catch(() => INBOX_LOOP_DEFAULTS.idleSeconds * 1000);
    if (signal.aborted || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.wake();
    }, delay);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#ticking?.catch(() => undefined);
    await Promise.all([...this.#inflight]);
  }
}
