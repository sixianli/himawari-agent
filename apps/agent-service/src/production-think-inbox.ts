import { createHash } from "node:crypto";
import type {
  ClockPort,
  PayloadProtectorPort,
  PayloadStorePort,
  ThinkEnqueueOutcome,
  ThinkInboxStorePort,
  ThinkInboxUsage,
} from "@himawari-agent/application";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";

type Scope = Parameters<ThinkInboxStorePort["usage"]>[0] extends infer Input
  ? Omit<Input & object, "day">
  : never;

export const THINK_QUEUE_LIMIT = 20;
export const THINK_DAILY_LIMIT = 50;
export const THINK_EXPIRES_AFTER_HOURS = 48;
export const THINK_STALLED_AFTER_MINUTES = 30;
export const THINK_MAX_ATTEMPTS = 3;
export const THINK_SUMMARY_CHARACTERS = 1000;

const KIND = /^[a-z][a-z0-9_]{0,63}$/u;
const SWEEP_BATCH = 50;

export interface ThinkSource {
  readonly kind: string;
  readonly describe: string;
  readonly externalContent: boolean;
}

export interface ThinkInboxOptions {
  readonly scope: Scope;
  readonly store: ThinkInboxStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly timeZone: string;
  readonly limits?: {
    readonly queueLimit?: number;
    readonly dailyLimit?: number;
    readonly expiresAfterHours?: number;
    readonly stalledAfterMinutes?: number;
    readonly maxAttempts?: number;
    readonly summaryCharacters?: number;
  };
}

export type ThinkSubmitResult =
  | {
      readonly accepted: true;
      readonly entryId: string;
      readonly duplicate: boolean;
    }
  | { readonly accepted: false; readonly reason: string };

export function localDay(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function clip(text: string, maximum: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length <= maximum ? characters.join("") : characters.slice(0, maximum).join("");
}

function entryKey(scope: Scope, kind: string, ref: string, version: string): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.ownerId, scope.agentId, kind, ref, version]))
    .digest("hex")
    .slice(0, 32);
}

export class ThinkSourceRegistry {
  readonly #sources = new Map<string, ThinkSource>();

  register(source: ThinkSource): void {
    if (!KIND.test(source.kind)) throw new RangeError("Think source kind is invalid");
    if (source.describe.trim().length === 0)
      throw new RangeError("Think source needs a description");
    if (this.#sources.has(source.kind)) throw new RangeError("Think source is already registered");
    this.#sources.set(source.kind, Object.freeze({ ...source }));
  }

  get(kind: string): ThinkSource | undefined {
    return this.#sources.get(kind);
  }

  list(): readonly ThinkSource[] {
    return Object.freeze([...this.#sources.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1)));
  }
}

export class ProductionThinkInbox {
  readonly #options: ThinkInboxOptions;
  readonly sources: ThinkSourceRegistry;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: ThinkInboxOptions, sources = new ThinkSourceRegistry()) {
    this.#options = options;
    this.sources = sources;
  }

  get limits() {
    const limits = this.#options.limits ?? {};
    return {
      queueLimit: limits.queueLimit ?? THINK_QUEUE_LIMIT,
      dailyLimit: limits.dailyLimit ?? THINK_DAILY_LIMIT,
      expiresAfterHours: limits.expiresAfterHours ?? THINK_EXPIRES_AFTER_HOURS,
      stalledAfterMinutes: limits.stalledAfterMinutes ?? THINK_STALLED_AFTER_MINUTES,
      maxAttempts: limits.maxAttempts ?? THINK_MAX_ATTEMPTS,
      summaryCharacters: limits.summaryCharacters ?? THINK_SUMMARY_CHARACTERS,
    };
  }

  async submit(input: {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly sourceVersion: string;
    readonly summary: string;
    readonly externalContent?: boolean;
  }): Promise<ThinkSubmitResult> {
    if (
      typeof input.sourceKind !== "string" ||
      typeof input.sourceRef !== "string" ||
      typeof input.sourceVersion !== "string" ||
      typeof input.summary !== "string" ||
      (input.externalContent !== undefined && typeof input.externalContent !== "boolean")
    )
      return { accepted: false, reason: "THINK_INPUT_INVALID" };
    const source = this.sources.get(input.sourceKind);
    if (!source) return { accepted: false, reason: "THINK_SOURCE_UNREGISTERED" };
    if (input.sourceRef.length < 1 || input.sourceRef.length > 256)
      return { accepted: false, reason: "THINK_SOURCE_REF_INVALID" };
    if (input.sourceVersion.length > 256)
      return { accepted: false, reason: "THINK_SOURCE_VERSION_INVALID" };
    const summary = clip(input.summary, this.limits.summaryCharacters);
    if (summary.length === 0) return { accepted: false, reason: "THINK_SUMMARY_EMPTY" };
    const now = this.#options.clock.now();
    const key = entryKey(
      this.#options.scope,
      input.sourceKind,
      input.sourceRef,
      input.sourceVersion,
    );
    const id = `think:${key}`;
    const summaryRef = `think-summary:${key}`;
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const turn = previous.then(() => this.#accept({ input, source, summary, now, id, summaryRef }));
    const settled = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return turn;
  }

  async #accept(args: {
    readonly input: {
      readonly sourceKind: string;
      readonly sourceRef: string;
      readonly sourceVersion: string;
      readonly externalContent?: boolean;
    };
    readonly source: ThinkSource;
    readonly summary: string;
    readonly now: string;
    readonly id: string;
    readonly summaryRef: string;
  }): Promise<ThinkSubmitResult> {
    const { input, source, summary, now, id, summaryRef } = args;
    let wrote = false;
    if (!(await this.#options.payloads.get(summaryRef as never))) {
      try {
        await this.#options.payloads.put(
          await this.#options.protector.protect({
            ...this.#options.scope,
            ref: summaryRef,
            contentType: "text/plain",
            dataClassification: classificationWithIdentifiers(summary, "private"),
            plaintext: new TextEncoder().encode(summary),
            createdAt: now,
          }),
        );
        wrote = true;
      } catch (error) {
        if (!(await this.#options.payloads.get(summaryRef as never))) throw error;
      }
    }
    let outcome: ThinkEnqueueOutcome;
    try {
      outcome = await this.#options.store.enqueue({
        ...this.#options.scope,
        id,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        sourceVersion: input.sourceVersion,
        externalContent: input.externalContent === true || source.externalContent,
        summaryRef,
        day: localDay(now, this.#options.timeZone),
        now,
        queueLimit: this.limits.queueLimit,
        dailyLimit: this.limits.dailyLimit,
      });
    } catch (error) {
      if (wrote) await this.#discardUnreferenced(summaryRef);
      throw error;
    }
    if (outcome.outcome === "queued") return { accepted: true, entryId: id, duplicate: false };
    if (wrote) await this.#discardUnreferenced(summaryRef);
    if (outcome.outcome === "duplicate") return { accepted: true, entryId: id, duplicate: true };
    return {
      accepted: false,
      reason: outcome.outcome === "queue_full" ? "THINK_QUEUE_FULL" : "THINK_DAILY_LIMIT",
    };
  }

  async #discardUnreferenced(summaryRef: string): Promise<void> {
    const referenced = await this.#options.store
      .summaryReferenced({ ...this.#options.scope, summaryRef })
      .catch(() => true);
    if (!referenced) await this.#options.payloads.delete(summaryRef as never).catch(() => false);
  }

  async maintain(): Promise<{
    readonly recovered: number;
    readonly expired: number;
  }> {
    const now = this.#options.clock.now();
    const limits = this.limits;
    const at = Date.parse(now);
    const recovered = await this.#options.store.recoverStalled({
      ...this.#options.scope,
      stalledBefore: new Date(at - limits.stalledAfterMinutes * 60_000).toISOString(),
      maxAttempts: limits.maxAttempts,
      now,
    });
    const expired = await this.#options.store.expireQueued({
      ...this.#options.scope,
      createdBefore: new Date(at - limits.expiresAfterHours * 3_600_000).toISOString(),
      now,
    });
    const settled = await this.#options.store.settledSummaries({
      ...this.#options.scope,
      limit: SWEEP_BATCH,
    });
    for (const { id, summaryRef } of settled) {
      const gone = await this.#options.payloads
        .delete(summaryRef as never)
        .then(() => true)
        .catch(() => false);
      if (gone)
        await this.#options.store
          .clearSummary({ ...this.#options.scope, id, summaryRef })
          .catch(() => false);
    }
    return { recovered, expired };
  }

  usage(): Promise<ThinkInboxUsage> {
    return this.#options.store.usage({
      ...this.#options.scope,
      day: localDay(this.#options.clock.now(), this.#options.timeZone),
    });
  }
}
