import type {
  DecisionKind,
  DecisionLedgerEntry,
  DecisionLedgerPort,
} from "../ports/decision-ledger.js";
import type { ProactiveRating, ProactiveScope } from "../ports/proactive-checks.js";
import type { ProactiveOverview } from "./proactive-overview.js";
import { startOfZonedDay } from "./proactive-rules.js";

export const DAILY_REVIEW_WINDOW_DAYS = 7;
export const DAILY_REVIEW_POOL_LIMIT = 500;
export const DAILY_REVIEW_MAX_RATINGS = 50;

export type DailyReviewGroup =
  | "proactive"
  | "memory_skipped"
  | "memory_kept"
  | "consolidation"
  | "other";

const DEFAULT_GROUPS: readonly DailyReviewGroup[] = [
  "memory_skipped",
  "proactive",
  "memory_kept",
  "consolidation",
];
export type DailyReviewSource = "ledger" | "mail";
export type DailyReviewKind = DecisionKind | "mail";

export interface DailyReviewPoolItem {
  readonly key: string;
  readonly group: DailyReviewGroup;
  readonly done: boolean;
  readonly doneAt: string | null;
}

export interface DailyReviewSelection {
  readonly shown: readonly string[];
  readonly sampled: number;
  readonly notSampled: number;
  readonly foldedTotal: number;
  readonly foldedShown: readonly string[];
}

export function reviewCapacity(budgetSeconds: number, secondsPerItem: number): number {
  return Math.max(1, Math.floor(budgetSeconds / secondsPerItem));
}

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export function selectDailyReview(input: {
  readonly pool: readonly DailyReviewPoolItem[];
  readonly dayStart: string;
  readonly seed: string;
  readonly capacity: number;
}): DailyReviewSelection {
  const { dayStart, seed, capacity } = input;
  const eligible = input.pool.filter(
    (item) => !item.done || (item.doneAt !== null && item.doneAt >= dayStart),
  );
  const order = (items: readonly DailyReviewPoolItem[]) =>
    [...items].sort(
      (left, right) =>
        hash(`${seed}|${dayStart}|${left.key}`) - hash(`${seed}|${dayStart}|${right.key}`) ||
        left.key.localeCompare(right.key),
    );
  const defaults = eligible.filter(({ group }) => group !== "other");
  const queues = DEFAULT_GROUPS.map((name) =>
    order(defaults.filter(({ group }) => group === name)),
  );
  const taken: DailyReviewPoolItem[] = [];
  for (let round = 0; taken.length < capacity; round += 1) {
    let added = false;
    for (const queue of queues) {
      const next = queue[round];
      if (next === undefined || taken.length >= capacity) continue;
      taken.push(next);
      added = true;
    }
    if (!added) break;
  }
  const takenKeys = new Set(taken.map(({ key }) => key));
  const other = eligible.filter(({ group }) => group === "other");
  return Object.freeze({
    shown: Object.freeze(taken.map(({ key }) => key)),
    sampled: taken.length,
    notSampled: defaults.filter(({ key, done }) => !done && !takenKeys.has(key)).length,
    foldedTotal: other.filter(({ done }) => !done).length,
    foldedShown: Object.freeze(
      order(other)
        .slice(0, capacity)
        .map(({ key }) => key),
    ),
  });
}

export type DailyReviewRating = ProactiveRating;

export interface DailyReviewMemoryText {
  readonly text: string;
  readonly hidden: boolean;
}

export interface DailyReviewItem {
  readonly key: string;
  readonly source: DailyReviewSource;
  readonly kind: DailyReviewKind;
  readonly outcome: string;
  readonly decidedAt: string;
  readonly acted: boolean;
  readonly rating: DailyReviewRating | null;
  readonly text: string;
  readonly textHidden: boolean;
  readonly category: string | null;
  readonly fetched: number | null;
}

export interface DailyReview {
  readonly day: string;
  readonly capacity: number;
  readonly sampled: number;
  readonly notSampled: number;
  readonly items: readonly DailyReviewItem[];
  readonly folded: { readonly total: number; readonly items: readonly DailyReviewItem[] };
}

const LEDGER_PREFIX = "ledger:";
const MAIL_PREFIX = "mail:";

export const reviewKey = (source: DailyReviewSource, id: string) =>
  `${source === "ledger" ? LEDGER_PREFIX : MAIL_PREFIX}${id}`;

export function parseReviewKey(
  key: string,
): { readonly source: DailyReviewSource; readonly id: string } | undefined {
  if (key.startsWith(LEDGER_PREFIX) && key.length > LEDGER_PREFIX.length)
    return { source: "ledger", id: key.slice(LEDGER_PREFIX.length) };
  if (key.startsWith(MAIL_PREFIX) && key.length > MAIL_PREFIX.length)
    return { source: "mail", id: key.slice(MAIL_PREFIX.length) };
  return undefined;
}

const TEXT_LIMIT = 200;

function clip(text: string): string {
  return [...text.replace(/\p{Cc}+/gu, " ").trim()].slice(0, TEXT_LIMIT).join("");
}

function ledgerGroup(entry: DecisionLedgerEntry): DailyReviewGroup {
  if (entry.kind === "proactive") return "proactive";
  if (entry.kind === "memory_candidate")
    return entry.outcome === "discarded" ? "memory_skipped" : "memory_kept";
  if (entry.kind === "consolidation") return "consolidation";
  return "other";
}

function ledgerActed(entry: DecisionLedgerEntry): boolean {
  if (entry.kind === "proactive") return entry.outcome !== "silent";
  if (entry.kind === "memory_candidate") return entry.outcome !== "discarded";
  return true;
}

function reviewedMemoryId(entry: DecisionLedgerEntry): string | undefined {
  if (entry.kind === "memory_candidate" && entry.outcome !== "discarded")
    return entry.subjectRef ?? entry.inputs.memoryIds[0];
  if (entry.kind === "consolidation")
    return (
      entry.inputs.resultMemoryIds[0] ?? entry.inputs.memoryIds[0] ?? entry.subjectRef ?? undefined
    );
  return undefined;
}

const OWNER_DECIDED_DISCARD = "approval_rejected";

export async function readDailyReview(options: {
  readonly scope: ProactiveScope;
  readonly ledger: Pick<DecisionLedgerPort, "listReviewPool">;
  readonly overview: ProactiveOverview;
  readonly readMemoryText: (ref: string) => Promise<string | undefined>;
  readonly readMemory?: (memoryId: string) => Promise<DailyReviewMemoryText | undefined>;
  readonly timeZone: string;
  readonly now: string;
  readonly budgetSeconds: number;
  readonly secondsPerItem: number;
}): Promise<DailyReview> {
  const { scope, overview, now } = options;
  const dayStart = startOfZonedDay(now, options.timeZone);
  const capacity = reviewCapacity(options.budgetSeconds, options.secondsPerItem);
  const since = new Date(Date.parse(now) - DAILY_REVIEW_WINDOW_DAYS * 86_400_000).toISOString();
  const entries = await options.ledger.listReviewPool({
    ...scope,
    since,
    ratedSince: dayStart,
    limit: DAILY_REVIEW_POOL_LIMIT,
  });
  const checks = new Map(overview.decisions.map((decision) => [decision.id, decision]));
  const candidates = new Map<
    string,
    { readonly item: DailyReviewPoolItem; readonly build: () => Promise<DailyReviewItem> }
  >();
  for (const entry of entries) {
    if (entry.kind === "memory_candidate" && entry.reasonCode === OWNER_DECIDED_DISCARD) continue;
    const check = entry.kind === "proactive" ? checks.get(entry.id) : undefined;
    if (entry.kind === "proactive" && entry.outcome === "silent" && (check?.counts.judged ?? 0) < 1)
      continue;
    const key = reviewKey("ledger", entry.id);
    candidates.set(key, {
      item: {
        key,
        group: ledgerGroup(entry),
        done: entry.ownerRating !== null,
        doneAt: entry.ratedAt,
      },
      build: async () => {
        let text = "";
        let hidden = false;
        if (entry.contentRef !== null && entry.kind === "memory_candidate")
          text = clip(
            (await options.readMemoryText(entry.contentRef).catch(() => undefined)) ?? "",
          );
        const memoryId = reviewedMemoryId(entry);
        if (text === "" && memoryId !== undefined && options.readMemory) {
          const memory = await options.readMemory(memoryId).catch(() => undefined);
          if (memory) {
            hidden = memory.hidden;
            text = hidden ? "" : clip(memory.text);
          }
        }
        return {
          key,
          source: "ledger" as const,
          kind: entry.kind,
          outcome: entry.outcome,
          decidedAt: entry.decidedAt,
          acted: ledgerActed(entry),
          rating: entry.ownerRating,
          text,
          textHidden:
            (entry.kind === "memory_candidate" || entry.kind === "consolidation") && text === "",
          category: entry.category,
          fetched: check ? check.counts.fetched : null,
        };
      },
    });
  }
  for (const mail of overview.audit.items) {
    const key = reviewKey("mail", mail.messageId);
    const done = mail.reviewedAt !== null || mail.rating !== null;
    candidates.set(key, {
      item: { key, group: "proactive", done, doneAt: mail.reviewedAt },
      build: async () => ({
        key,
        source: "mail" as const,
        kind: "mail" as const,
        outcome: "skipped",
        decidedAt: mail.decidedAt,
        acted: false,
        rating: mail.rating ?? (mail.reviewedAt !== null ? "useful" : null),
        text: clip(mail.subject ? `${mail.from} · ${mail.subject}` : mail.from),
        textHidden: false,
        category: null,
        fetched: null,
      }),
    });
  }
  const selection = selectDailyReview({
    pool: [...candidates.values()].map(({ item }) => item),
    dayStart,
    seed: `${scope.ownerId}:${scope.agentId}`,
    capacity,
  });
  const build = (keys: readonly string[]) =>
    Promise.all(keys.map((key) => candidates.get(key)?.build())).then((items) =>
      items.filter((item): item is DailyReviewItem => item !== undefined),
    );
  return Object.freeze({
    day: dayStart,
    capacity,
    sampled: selection.sampled,
    notSampled: selection.notSampled,
    items: Object.freeze(await build(selection.shown)),
    folded: Object.freeze({
      total: selection.foldedTotal,
      items: Object.freeze(await build(selection.foldedShown)),
    }),
  });
}
