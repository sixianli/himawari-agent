import { createHash } from "node:crypto";
import {
  type ClockPort,
  type InboxEnqueueOutcome,
  type InboxStorePort,
  type InboxUsage,
  inboxSettingDefinition,
  type PayloadProtectorPort,
  type PayloadStorePort,
} from "@himawari-agent/application";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";

export type InboxScope = Parameters<InboxStorePort["usage"]>[0];

export const INBOX_STALLED_AFTER_MINUTES =
  inboxSettingDefinition("stalledAfterMinutes").defaultValue;
export const INBOX_MAX_ATTEMPTS = inboxSettingDefinition("maxAttempts").defaultValue;
export const INBOX_SUMMARY_CHARACTERS = inboxSettingDefinition("summaryCharacters").defaultValue;

const KIND = /^[a-z][a-z0-9_]{0,63}$/u;
const SWEEP_BATCH = 50;

export interface InboxSource {
  readonly kind: string;
  readonly describe: string;
  readonly externalContent: boolean;
  readonly fromOwner: boolean;
  readonly priority: number;
}

export interface InboxOptions {
  readonly scope: InboxScope;
  readonly store: InboxStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly limits?: {
    readonly stalledAfterMinutes?: number;
    readonly maxAttempts?: number;
    readonly summaryCharacters?: number;
  };
  readonly overrides?: () => Promise<Readonly<Record<string, number>>>;
}

export type InboxSubmitResult =
  | {
      readonly accepted: true;
      readonly entryId: string;
      readonly duplicate: boolean;
    }
  | { readonly accepted: false; readonly reason: string };

function clip(text: string, maximum: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length <= maximum ? characters.join("") : characters.slice(0, maximum).join("");
}

function entryKey(scope: InboxScope, kind: string, ref: string, version: string): string {
  return createHash("sha256")
    .update(JSON.stringify([scope.ownerId, scope.agentId, kind, ref, version]))
    .digest("hex")
    .slice(0, 32);
}

export class InboxSourceRegistry {
  readonly #sources = new Map<string, InboxSource>();

  register(source: InboxSource): void {
    if (!KIND.test(source.kind)) throw new RangeError("Inbox source kind is invalid");
    if (source.describe.trim().length === 0)
      throw new RangeError("Inbox source needs a description");
    if (!Number.isInteger(source.priority) || source.priority < 1 || source.priority > 9)
      throw new RangeError("Inbox source priority is invalid");
    if (source.fromOwner && source.externalContent)
      throw new RangeError("Inbox source cannot be both the owner and outside content");
    if (this.#sources.has(source.kind)) throw new RangeError("Inbox source is already registered");
    this.#sources.set(source.kind, Object.freeze({ ...source }));
  }

  get(kind: string): InboxSource | undefined {
    return this.#sources.get(kind);
  }

  list(): readonly InboxSource[] {
    return Object.freeze([...this.#sources.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1)));
  }
}

export class ProductionInbox {
  readonly #options: InboxOptions;
  readonly sources: InboxSourceRegistry;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #listeners = new Set<() => void>();

  constructor(options: InboxOptions, sources = new InboxSourceRegistry()) {
    this.#options = options;
    this.sources = sources;
  }

  onQueued(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #announce(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {}
    }
  }

  get limits() {
    return this.#merge({});
  }

  async currentLimits() {
    const overrides = await this.#options.overrides?.().catch(() => ({}));
    return this.#merge(overrides ?? {});
  }

  #merge(overrides: Readonly<Record<string, number>>) {
    const limits = { ...this.#options.limits, ...overrides };
    return {
      stalledAfterMinutes: limits.stalledAfterMinutes ?? INBOX_STALLED_AFTER_MINUTES,
      maxAttempts: limits.maxAttempts ?? INBOX_MAX_ATTEMPTS,
      summaryCharacters: limits.summaryCharacters ?? INBOX_SUMMARY_CHARACTERS,
    };
  }

  async submit(input: {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly sourceVersion: string;
    readonly summary: string;
    readonly externalContent?: boolean;
    readonly threadId?: string | null;
  }): Promise<InboxSubmitResult> {
    if (
      typeof input.sourceKind !== "string" ||
      typeof input.sourceRef !== "string" ||
      typeof input.sourceVersion !== "string" ||
      typeof input.summary !== "string" ||
      (input.externalContent !== undefined && typeof input.externalContent !== "boolean") ||
      (input.threadId !== undefined &&
        input.threadId !== null &&
        typeof input.threadId !== "string")
    )
      return { accepted: false, reason: "INBOX_INPUT_INVALID" };
    const source = this.sources.get(input.sourceKind);
    if (!source) return { accepted: false, reason: "INBOX_SOURCE_UNREGISTERED" };
    if (input.sourceRef.length < 1 || input.sourceRef.length > 256)
      return { accepted: false, reason: "INBOX_SOURCE_REF_INVALID" };
    if (input.sourceVersion.length > 256)
      return { accepted: false, reason: "INBOX_SOURCE_VERSION_INVALID" };
    if (
      typeof input.threadId === "string" &&
      (input.threadId.length < 1 || input.threadId.length > 256)
    )
      return { accepted: false, reason: "INBOX_THREAD_INVALID" };
    if (source.fromOwner && input.externalContent === true)
      return { accepted: false, reason: "INBOX_OWNER_SOURCE_CANNOT_BE_OUTSIDE" };
    const limits = await this.currentLimits();
    const summary = clip(input.summary, limits.summaryCharacters);
    if (summary.length === 0) return { accepted: false, reason: "INBOX_SUMMARY_EMPTY" };
    const now = this.#options.clock.now();
    const key = entryKey(
      this.#options.scope,
      input.sourceKind,
      input.sourceRef,
      input.sourceVersion,
    );
    const id = `inbox:${key}`;
    const summaryRef = `inbox-summary:${key}`;
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
      readonly threadId?: string | null;
    };
    readonly source: InboxSource;
    readonly summary: string;
    readonly now: string;
    readonly id: string;
    readonly summaryRef: string;
  }): Promise<InboxSubmitResult> {
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
    let outcome: InboxEnqueueOutcome;
    try {
      outcome = await this.#options.store.enqueue({
        ...this.#options.scope,
        id,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        sourceVersion: input.sourceVersion,
        externalContent: input.externalContent === true || source.externalContent,
        fromOwner: source.fromOwner,
        priority: source.priority,
        threadId: input.threadId ?? null,
        summaryRef,
        now,
      });
    } catch (error) {
      if (wrote) await this.#discardUnreferenced(summaryRef);
      throw error;
    }
    if (outcome.outcome === "queued") {
      this.#announce();
      return { accepted: true, entryId: id, duplicate: false };
    }
    if (wrote) await this.#discardUnreferenced(summaryRef);
    return { accepted: true, entryId: outcome.entry.id, duplicate: true };
  }

  async #discardUnreferenced(summaryRef: string): Promise<void> {
    const referenced = await this.#options.store
      .summaryReferenced({ ...this.#options.scope, summaryRef })
      .catch(() => true);
    if (!referenced) await this.#options.payloads.delete(summaryRef as never).catch(() => false);
  }

  async maintain(
    input: { readonly runsLastUpToMs?: number } = {},
  ): Promise<{ readonly recovered: number }> {
    const now = this.#options.clock.now();
    const limits = await this.currentLimits();
    const at = Date.parse(now);
    const stalledAfterMs = Math.max(limits.stalledAfterMinutes * 60_000, input.runsLastUpToMs ?? 0);
    const recovered = await this.#options.store.recoverStalled({
      ...this.#options.scope,
      stalledBefore: new Date(at - stalledAfterMs).toISOString(),
      maxAttempts: limits.maxAttempts,
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
    if (recovered > 0) this.#announce();
    return { recovered };
  }

  usage(): Promise<InboxUsage> {
    return this.#options.store.usage(this.#options.scope);
  }
}
