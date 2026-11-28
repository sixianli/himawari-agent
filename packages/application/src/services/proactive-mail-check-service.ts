import type { RunId } from "@himawari-agent/domain";
import type { DataClassification } from "../ports/common.js";
import type { ModelPort } from "../ports/intelligence.js";
import type { OwnerRuleStorePort } from "../ports/owner-rules.js";
import {
  type ProactiveCounts,
  type ProactiveDecision,
  type ProactiveMailReader,
  type ProactiveProcessedMessage,
  type ProactiveScope,
  type ProactiveSealPort,
  ProactiveSourceUnauthorizedError,
  type ProactiveStorePort,
  type ProactiveVerdict,
} from "../ports/proactive-checks.js";
import { mailItem, mailOf, type ProactiveMail } from "../ports/proactive-sources.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { RuleRecord } from "../rules/rule-book.js";
import { ruleRef } from "../rules/rule-ref.js";
import { enforceableOwnerRule, parseOwnerRuleParameters } from "../rules/rule-types.js";
import { mustNotifyHitIds, wholeThreadHitIds } from "./proactive-rules.js";

const LOOKBACK_MS = 3 * 24 * 3_600_000;

export const MAIL_INBOX_SOURCE_KIND = "mail";

export interface ProactiveModelAuthority {
  readonly runId: RunId;
  readonly inputRef: string;
  readonly allowedDisclosureRef: string;
  readonly secretHandleRefs: readonly string[];
  release(): Promise<void>;
}

export interface ProactiveModelInvoker {
  readonly model: ModelPort;
  readonly modelRef: string;
  readonly allowedDataClassifications: readonly DataClassification[];
  prepare(input: {
    readonly invocationId: string;
    readonly prompt: string;
    readonly deadlineAt: string;
    readonly dataClassification: DataClassification;
  }): Promise<ProactiveModelAuthority>;
  readOutput(payloadRef: string): Promise<string>;
  release(payloadRefs: readonly string[]): Promise<void>;
}

export interface MailInboxPort {
  submit(input: {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly sourceVersion: string;
    readonly summary: string;
    readonly externalContent: true;
  }): Promise<{ readonly accepted: boolean }>;
}

export interface ProactiveMailCheckOptions {
  readonly scope: ProactiveScope;
  readonly store: ProactiveStorePort;
  readonly seal: ProactiveSealPort;
  readonly reader: ProactiveMailReader;
  readonly inbox: MailInboxPort;
  readonly perCheckMs: number;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly ownerRules?: readonly RuleRecord[];
  readonly ownerRuleStore?: Pick<OwnerRuleStorePort, "list">;
  readonly onReadFailed?: (failure: ProactiveMailReadFailure) => void;
}

export interface ProactiveMailReadFailure {
  readonly source: string;
  readonly operation: "thread" | "search";
  readonly attempts: number;
  readonly error: unknown;
}

const ON_DEMAND_ATTEMPTS = 2;
const UNAUTHORIZED = Symbol("unauthorized");
const FAILED = Symbol("failed");

const EMPTY_COUNTS: ProactiveCounts = Object.freeze({
  fetched: 0,
  skipped: 0,
  judged: 0,
  act: 0,
  know: 0,
  check: 0,
  ignore: 0,
  floorRaised: 0,
  pushed: 0,
});

type Processed = Omit<
  ProactiveProcessedMessage,
  "reviewedAt" | "ownerRating" | "decisionId" | "processedAt"
> & { readonly receivedAt: string };

interface OwnerMailRule {
  readonly record: RuleRecord;
  readonly summary: string;
}

export function mailInboxSummary(item: ProactiveMail, rules: readonly string[]): string {
  return [
    `邮件 ${item.messageId}（邮件串 ${item.threadId}）`,
    `发件人：${item.from}`,
    `标题：${item.subject}`,
    `收到：${item.receivedAt}`,
    ...rules.map((summary) => `主人立过的规则命中：${summary}`),
    item.attachments.length > 0
      ? `附件：${item.attachments.map(({ filename }) => filename).join("、")}`
      : "",
    `开头：${item.snippet}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export type FlatMailFetchResult =
  | {
      readonly kind: "items";
      readonly items: readonly ProactiveMail[];
      readonly cursor: string | null;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly step: string };

export interface FlatMailReader {
  readonly source: ProactiveMailReader["source"];
  readonly thread?:
    | ((
        input: Parameters<NonNullable<ProactiveMailReader["thread"]>>[0],
      ) => Promise<readonly ProactiveMail[] | undefined>)
    | undefined;
  readonly search?:
    | ((
        input: Parameters<NonNullable<ProactiveMailReader["search"]>>[0],
      ) => Promise<readonly ProactiveMail[]>)
    | undefined;
  fetch(input: Parameters<ProactiveMailReader["fetch"]>[0]): Promise<FlatMailFetchResult>;
}

export function flatMailReader(reader: ProactiveMailReader): FlatMailReader {
  return {
    source: reader.source,
    get thread() {
      const thread = reader.thread;
      if (thread === undefined) return undefined;
      return async (input: Parameters<NonNullable<FlatMailReader["thread"]>>[0]) =>
        (await thread(input))?.map(mailOf);
    },
    get search() {
      const search = reader.search;
      if (search === undefined) return undefined;
      return async (input: Parameters<NonNullable<FlatMailReader["search"]>>[0]) =>
        (await search(input)).map(mailOf);
    },
    async fetch(input) {
      const fetched = await reader.fetch(input);
      return fetched.kind === "items" ? { ...fetched, items: fetched.items.map(mailOf) } : fetched;
    },
  };
}

export function mailReader(flat: FlatMailReader): ProactiveMailReader {
  return {
    source: flat.source,
    get thread() {
      const thread = flat.thread;
      if (thread === undefined) return undefined;
      return async (input: Parameters<NonNullable<ProactiveMailReader["thread"]>>[0]) =>
        (await thread(input))?.map(mailItem);
    },
    get search() {
      const search = flat.search;
      if (search === undefined) return undefined;
      return async (input: Parameters<NonNullable<ProactiveMailReader["search"]>>[0]) =>
        (await search(input)).map(mailItem);
    },
    async fetch(input) {
      const fetched = await flat.fetch(input);
      return fetched.kind === "items"
        ? { ...fetched, items: fetched.items.map(mailItem) }
        : fetched;
    },
  };
}

export class ProactiveMailCheckService {
  readonly #options: ProactiveMailCheckOptions;

  constructor(options: ProactiveMailCheckOptions) {
    this.#options = options;
  }

  async run(): Promise<ProactiveDecision | undefined> {
    const { store, scope, reader } = this.#options;
    const settings = await store.readSettings(scope);
    if (!settings.enabled) return undefined;
    const connection = await store.readConnection({ ...scope, source: reader.source });
    if (!connection || connection.status !== "connected") return undefined;
    const startedAt = this.#options.clock.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.perCheckMs);
    try {
      return await this.#check(connection.tokenRef, startedAt, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async readThread(
    threadId: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "thread"; readonly mails: readonly ProactiveMail[] }
    | { readonly kind: "not_connected" | "not_found" | "unsupported" | "failed" }
  > {
    const { store, scope, reader, seal } = this.#options;
    const thread = reader.thread;
    if (!thread) return { kind: "unsupported" };
    const connection = await store.readConnection({ ...scope, source: reader.source });
    if (!connection || connection.status !== "connected") return { kind: "not_connected" };
    const token = await seal.open({ ...scope, ref: connection.tokenRef });
    if (!token) return { kind: "not_connected" };
    const items = await this.#onDemand("thread", signal, () => thread({ token, threadId, signal }));
    if (items === UNAUTHORIZED) return { kind: "not_connected" };
    if (items === FAILED) return { kind: "failed" };
    if (items === undefined || items.length === 0) return { kind: "not_found" };
    return { kind: "thread", mails: items.map(mailOf) };
  }

  async searchMail(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "found"; readonly mails: readonly ProactiveMail[] }
    | { readonly kind: "not_connected" | "unsupported" | "failed" }
  > {
    const { store, scope, reader, seal } = this.#options;
    const search = reader.search;
    if (!search) return { kind: "unsupported" };
    const connection = await store.readConnection({ ...scope, source: reader.source });
    if (!connection || connection.status !== "connected") return { kind: "not_connected" };
    const token = await seal.open({ ...scope, ref: connection.tokenRef });
    if (!token) return { kind: "not_connected" };
    const items = await this.#onDemand("search", signal, () =>
      search({ token, query, limit, signal }),
    );
    if (items === UNAUTHORIZED) return { kind: "not_connected" };
    if (items === FAILED) return { kind: "failed" };
    return { kind: "found", mails: items.map(mailOf) };
  }

  async #onDemand<T>(
    operation: ProactiveMailReadFailure["operation"],
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T | typeof UNAUTHORIZED | typeof FAILED> {
    for (let attempts = 1; ; attempts += 1) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof ProactiveSourceUnauthorizedError) {
          await this.#options.store.markConnection({
            ...this.#options.scope,
            source: this.#options.reader.source,
            status: "needs_reconnect",
            cursor: null,
            now: this.#options.clock.now(),
          });
          return UNAUTHORIZED;
        }
        if (attempts >= ON_DEMAND_ATTEMPTS || signal.aborted) {
          this.#options.onReadFailed?.({
            source: this.#options.reader.source,
            operation,
            attempts,
            error,
          });
          return FAILED;
        }
      }
    }
  }

  async #ownerRules(): Promise<readonly OwnerMailRule[]> {
    const rules: OwnerMailRule[] = (this.#options.ownerRules ?? []).map((record) => ({
      record,
      summary: record.source,
    }));
    const store = this.#options.ownerRuleStore;
    if (!store) return rules;
    for (const row of await store.list({ ...this.#options.scope, includeRetired: false })) {
      const record = enforceableOwnerRule(row);
      if (!record) continue;
      rules.push({ record, summary: parseOwnerRuleParameters(row.parameters).summary });
    }
    return rules;
  }

  async #check(tokenRef: string, startedAt: string, signal: AbortSignal) {
    const { store, scope, reader, seal } = this.#options;
    const token = await seal.open({ ...scope, ref: tokenRef });
    if (!token) return this.#needsOwner(startedAt, "SOURCE_TOKEN_MISSING");
    const fetched = await reader
      .fetch({
        token,
        cursor: (await store.readConnection({ ...scope, source: reader.source }))?.cursor ?? null,
        since: new Date(Date.parse(startedAt) - LOOKBACK_MS).toISOString(),
        signal,
        unseen: (messageIds) => store.unprocessed({ ...scope, source: reader.source, messageIds }),
      })
      .catch(() => ({ kind: "failed" as const, step: signal.aborted ? "timeout" : "read" }));
    if (fetched.kind === "unauthorized") return this.#needsOwner(startedAt, "SOURCE_UNAUTHORIZED");
    if (fetched.kind === "failed")
      return this.#finish({
        startedAt,
        verdict: "failed",
        reasonCode: `READ_${fetched.step.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`.slice(0, 64),
        counts: EMPTY_COUNTS,
        processed: [],
        cursor: null,
      });
    const fresh = new Set(
      await store.unprocessed({
        ...scope,
        source: reader.source,
        messageIds: fetched.items.map(({ id }) => id),
      }),
    );
    const items = fetched.items.map(mailOf).filter(({ messageId }) => fresh.has(messageId));
    const rules = items.length > 0 ? await this.#ownerRules() : [];
    const processed: Processed[] = [];
    let handed = 0;
    let failed = 0;
    for (const item of items) {
      if (item.categories.includes("spam")) {
        processed.push(this.#skip(item, "category"));
        continue;
      }
      if (item.sentByOwner) {
        processed.push(this.#skip(item, "own_mail"));
        continue;
      }
      const records = rules.map(({ record }) => record);
      const hits = new Set([
        ...mustNotifyHitIds(item, records),
        ...wholeThreadHitIds(item, records),
      ]);
      const summaries = rules
        .filter(({ record }) => hits.has(ruleRef(record.id, record.revision)))
        .map(({ summary }) => summary);
      const submitted = await this.#options.inbox
        .submit({
          sourceKind: MAIL_INBOX_SOURCE_KIND,
          sourceRef: item.messageId,
          sourceVersion: item.messageId,
          summary: mailInboxSummary(item, summaries),
          externalContent: true,
        })
        .catch(() => ({ accepted: false }));
      if (!submitted.accepted) {
        failed += 1;
        continue;
      }
      handed += 1;
      processed.push({
        source: item.source,
        messageId: item.messageId,
        threadId: item.threadId,
        receivedAt: item.receivedAt,
        outcome: "check",
        skipReason: null,
        headerRef: null,
      });
    }
    return this.#finish({
      startedAt,
      verdict: failed > 0 ? "failed" : "silent",
      reasonCode:
        failed > 0 ? "INBOX_SUBMIT_FAILED" : handed > 0 ? "HANDED_TO_INBOX" : "NO_NEW_MAIL",
      counts: {
        ...EMPTY_COUNTS,
        fetched: items.length,
        skipped: processed.length - handed,
        check: handed,
      },
      processed,
      cursor: failed > 0 ? null : fetched.cursor,
    });
  }

  #skip(item: ProactiveMail, reason: Processed["skipReason"]): Processed {
    return {
      source: item.source,
      messageId: item.messageId,
      threadId: item.threadId,
      receivedAt: item.receivedAt,
      outcome: "skipped",
      skipReason: reason,
      headerRef: null,
    };
  }

  async #needsOwner(startedAt: string, reasonCode: string): Promise<ProactiveDecision> {
    await this.#options.store.markConnection({
      ...this.#options.scope,
      source: this.#options.reader.source,
      status: "needs_reconnect",
      cursor: null,
      now: startedAt,
    });
    return this.#finish({
      startedAt,
      verdict: "needs_owner",
      reasonCode,
      counts: EMPTY_COUNTS,
      processed: [],
      cursor: null,
    });
  }

  async #finish(input: {
    readonly startedAt: string;
    readonly verdict: ProactiveVerdict;
    readonly reasonCode: string;
    readonly counts: ProactiveCounts;
    readonly processed: readonly Processed[];
    readonly cursor: string | null;
  }): Promise<ProactiveDecision> {
    const { store, scope, ids, clock } = this.#options;
    const finishedAt = clock.now();
    const decision: ProactiveDecision = Object.freeze({
      id: ids.next("proactive-decision"),
      scenario: this.#options.reader.source,
      checkedAt: input.startedAt,
      counts: Object.freeze({ ...input.counts }),
      verdict: input.verdict,
      reasonCode: input.reasonCode,
      pushSourceKey: null,
      costMicros: 0,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(input.startedAt)),
      ownerRating: null,
      ratedAt: null,
    });
    const result = await store.record({
      ...scope,
      decision,
      inputs: {
        ruleIds: [],
        sourceIds: [],
        floorHits: {},
        memoryInjected: false,
        memoryIds: [],
        usedMemoryIds: [],
        memoryByMail: {},
        memoryRecall: "off",
      },
      modelPayloads: [],
      processed: input.processed,
      insights: [],
      repliedThreads: [],
      push: null,
      cursor: input.cursor,
    });
    if (result.releasedRefs.length > 0)
      await this.#options.seal.release({ ...scope, refs: result.releasedRefs });
    return decision;
  }
}
