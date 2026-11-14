import {
  type CalibrationGroup,
  calibrationGroup as calibrationGroupOf,
} from "@himawari-agent/calibration";
import { isPrereviewGroup } from "@himawari-agent/calibration/prereview";
import type { DataClassification } from "../ports/common.js";
import {
  type DecisionKind,
  type DecisionLedgerEntry,
  type DecisionLedgerPort,
  EXTERNAL_PROPOSAL_REASON_CODES,
  isMemoryCaptureFailure,
} from "../ports/decision-ledger.js";
import type {
  MemoryCheckupAction,
  MemoryCheckupItem,
  MemoryCheckupReason,
} from "../ports/memory-checkup.js";
import type { ProactiveRating, ProactiveScope } from "../ports/proactive-checks.js";
import { highestClassification, isModelVisible } from "./model-visibility.js";
import type { ProactiveOverview } from "./proactive-overview.js";
import { startOfZonedDay } from "./proactive-rules.js";

export const DAILY_REVIEW_WINDOW_DAYS = 7;
export const DAILY_REVIEW_POOL_LIMIT = 500;
export const DAILY_REVIEW_MAX_RATINGS = 50;

export type DailyReviewGroup =
  | "proactive"
  | "proactive_silent"
  | "memory_skipped"
  | "memory_kept"
  | "consolidation"
  | "memory_checkup"
  | "other";

const DEFAULT_GROUPS: readonly DailyReviewGroup[] = [
  "memory_skipped",
  "proactive",
  "memory_kept",
  "consolidation",
  "memory_checkup",
];
export type DailyReviewSource = "ledger" | "mail" | "checkup";
export type DailyReviewKind = Exclude<DecisionKind, "web_push"> | "mail" | "checkup";

export interface DailyReviewPoolItem {
  readonly key: string;
  readonly group: DailyReviewGroup;
  readonly done: boolean;
  readonly doneAt: string | null;
}

export interface DailyReviewSelection {
  readonly shown: readonly string[];
  readonly hiddenByModel: number;
  readonly sampled: number;
  readonly notSampled: number;
  readonly foldedTotal: number;
  readonly foldedShown: readonly string[];
}

export function reviewCapacity(budgetSeconds: number, secondsPerItem: number): number {
  return Math.max(1, Math.floor(budgetSeconds / secondsPerItem));
}

export function reviewHash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export const SILENT_SHARE_MAX = 1000;

function mixBySilentShare<T>(acted: readonly T[], silent: readonly T[], share: number): T[] {
  const mixed: T[] = [];
  let actedAt = 0;
  let silentAt = 0;
  for (let slot = 0; actedAt < acted.length || silentAt < silent.length; slot += 1) {
    const wantSilent =
      Math.floor(((slot + 1) * share) / SILENT_SHARE_MAX) >
      Math.floor((slot * share) / SILENT_SHARE_MAX);
    const next =
      silentAt < silent.length && (wantSilent || actedAt >= acted.length)
        ? silent[silentAt++]
        : actedAt < acted.length
          ? acted[actedAt++]
          : silent[silentAt++];
    mixed.push(next as T);
  }
  return mixed;
}

export function selectDailyReview(input: {
  readonly pool: readonly DailyReviewPoolItem[];
  readonly dayStart: string;
  readonly seed: string;
  readonly capacity: number;
  readonly silentShare?: number;
  readonly hidden?: ReadonlySet<string>;
}): DailyReviewSelection {
  const { dayStart, seed, capacity } = input;
  const eligible = input.pool.filter(
    (item) => !item.done || (item.doneAt !== null && item.doneAt >= dayStart),
  );
  const order = (items: readonly DailyReviewPoolItem[]) =>
    [...items].sort(
      (left, right) =>
        reviewHash(`${seed}|${dayStart}|${left.key}`) -
          reviewHash(`${seed}|${dayStart}|${right.key}`) ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    );
  const defaults = eligible.filter(({ group }) => group !== "other");
  const queueOf = (name: DailyReviewGroup) => {
    const own = defaults.filter(({ group }) => group === name);
    if (name !== "proactive") return order(own);
    const silent = defaults.filter(({ group }) => group === "proactive_silent");
    return input.silentShare === undefined
      ? order([...own, ...silent])
      : mixBySilentShare(order(own), order(silent), input.silentShare);
  };
  const queues = DEFAULT_GROUPS.map(queueOf);
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
  const hidden = input.hidden ?? new Set<string>();
  const shown = taken.filter(({ key, done }) => done || !hidden.has(key));
  return Object.freeze({
    shown: Object.freeze(shown.map(({ key }) => key)),
    hiddenByModel: taken.length - shown.length,
    sampled: shown.length,
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

export interface DailyReviewCandidate {
  readonly key: string;
  readonly group: CalibrationGroup | null;
  readonly text: () => Promise<string>;
}

function calibrationGroup(entry: DecisionLedgerEntry): CalibrationGroup | null {
  return calibrationGroupOf({
    kind: entry.kind,
    outcome: entry.outcome,
    ownerRating: null,
    delivered: false,
  });
}

export function reviewMemoryVisible(classification: string): boolean {
  return isModelVisible(classification);
}

export interface DailyReviewMemoryText {
  readonly text: string;
  readonly hidden: boolean;
  readonly dataClassification?: DataClassification;
}

export interface DailyReviewCheckup {
  readonly reason: MemoryCheckupReason;
  readonly action: MemoryCheckupAction | null;
  readonly memoryId: string;
  readonly relatedMemoryId: string | null;
  readonly relatedText: string;
  readonly keptMemoryId: string | null;
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
  readonly checkup: DailyReviewCheckup | null;
}

export interface DailyReview {
  readonly day: string;
  readonly capacity: number;
  readonly sampled: number;
  readonly notSampled: number;
  readonly hiddenByModel: number;
  readonly items: readonly DailyReviewItem[];
  readonly folded: {
    readonly total: number;
    readonly items: readonly DailyReviewItem[];
  };
}

const KEY_PREFIXES: readonly DailyReviewSource[] = ["ledger", "mail", "checkup"];

export const reviewKey = (source: DailyReviewSource, id: string) => `${source}:${id}`;

export function parseReviewKey(
  key: string,
): { readonly source: DailyReviewSource; readonly id: string } | undefined {
  for (const source of KEY_PREFIXES)
    if (key.startsWith(`${source}:`) && key.length > source.length + 1)
      return { source, id: key.slice(source.length + 1) };
  return undefined;
}

const TEXT_LIMIT = 200;

function clipTo(text: string, limit: number): string {
  const cleaned = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, "")
    .trim();
  let clipped = "";
  for (const character of cleaned) {
    if (clipped.length + character.length > limit) break;
    clipped += character;
  }
  return clipped;
}

function clip(text: string): string {
  return clipTo(text, TEXT_LIMIT);
}

function ledgerGroup(entry: DecisionLedgerEntry): DailyReviewGroup {
  if (entry.kind === "proactive")
    return entry.outcome === "silent" ? "proactive_silent" : "proactive";
  if (entry.kind === "memory_candidate") {
    if (entry.outcome === "discarded") return "memory_skipped";
    return entry.outcome === "kept" ? "memory_kept" : "other";
  }
  if (entry.kind === "consolidation") return "consolidation";
  return "other";
}

function ledgerActed(entry: DecisionLedgerEntry): boolean {
  if (entry.kind === "proactive") return entry.outcome !== "silent";
  if (entry.kind === "memory_candidate")
    return entry.outcome !== "discarded" && !isMemoryCaptureFailure(entry.outcome);
  return true;
}

const PART_LIMIT = 80;

function reviewedMemoryIds(entry: DecisionLedgerEntry): {
  readonly before: readonly string[];
  readonly after: string | undefined;
} {
  if (
    entry.kind === "memory_candidate" &&
    entry.outcome !== "discarded" &&
    !isMemoryCaptureFailure(entry.outcome)
  ) {
    const id = entry.subjectRef ?? entry.inputs.memoryIds[0];
    return { before: [], after: id };
  }
  if (entry.kind === "consolidation") {
    const after = entry.inputs.resultMemoryIds[0];
    const before = entry.inputs.memoryIds.filter((id) => id !== after).slice(0, 2);
    if (after === undefined && before.length === 0 && entry.subjectRef !== null)
      return { before: [entry.subjectRef], after: undefined };
    return { before, after };
  }
  return { before: [], after: undefined };
}

const EXTERNAL_PROPOSAL_NOT_SAVED: ReadonlySet<string> = new Set([
  EXTERNAL_PROPOSAL_REASON_CODES.pending,
  EXTERNAL_PROPOSAL_REASON_CODES.superseded,
]);

const OWNER_DECIDED_DISCARDS: ReadonlySet<string> = new Set([
  "approval_rejected",
  EXTERNAL_PROPOSAL_REASON_CODES.declined,
]);

interface DailyReviewSourceOptions {
  readonly scope: ProactiveScope;
  readonly ledger: Pick<DecisionLedgerPort, "listReviewPool">;
  readonly overview: ProactiveOverview;
  readonly readMemoryText: (ref: string) => Promise<string | undefined>;
  readonly readMemoryClassification?: (ref: string) => Promise<DataClassification | undefined>;
  readonly readMemory?: (memoryId: string) => Promise<DailyReviewMemoryText | undefined>;
  readonly timeZone: string;
  readonly now: string;
  readonly checkup?: readonly MemoryCheckupItem[];
}

interface BuiltReviewItem {
  readonly item: DailyReviewItem;
  readonly dataClassification: DataClassification | null;
}

interface ReviewCandidate {
  readonly candidate: Omit<DailyReviewCandidate, "text">;
  readonly item: DailyReviewPoolItem;
  readonly build: () => Promise<BuiltReviewItem>;
}

function visibleClassification(
  classifications: readonly (DataClassification | undefined)[],
): DataClassification | null {
  if (classifications.length === 0) return null;
  const known = classifications.filter(
    (classification): classification is DataClassification => classification !== undefined,
  );
  if (known.length !== classifications.length) return null;
  const highest = highestClassification(known[0] as DataClassification, known.slice(1));
  return isModelVisible(highest) ? highest : null;
}

async function collectReviewCandidates(
  options: DailyReviewSourceOptions,
  ratedSince: (since: string, dayStart: string) => string,
): Promise<{ readonly dayStart: string; readonly candidates: Map<string, ReviewCandidate> }> {
  const { scope, overview, now } = options;
  const dayStart = startOfZonedDay(now, options.timeZone);
  const since = new Date(Date.parse(now) - DAILY_REVIEW_WINDOW_DAYS * 86_400_000).toISOString();
  const entries = await options.ledger.listReviewPool({
    ...scope,
    since,
    ratedSince: ratedSince(since, dayStart),
    limit: DAILY_REVIEW_POOL_LIMIT,
  });
  const checks = new Map(overview.decisions.map((decision) => [decision.id, decision]));
  const pairKey = (ids: Iterable<string>) => [...new Set(ids)].sort().join("\u0000");
  const checkupPairs = new Set<string>(
    (options.checkup ?? []).flatMap(({ reason, memoryId, relatedMemoryId }) =>
      reason === "conflict" && relatedMemoryId ? [pairKey([memoryId, relatedMemoryId])] : [],
    ),
  );
  const candidates = new Map<string, ReviewCandidate>();
  for (const entry of entries) {
    const kind = entry.kind;
    if (kind === "web_push") continue;
    if (entry.kind === "memory_candidate" && OWNER_DECIDED_DISCARDS.has(entry.reasonCode)) continue;
    if (entry.kind === "memory_candidate" && EXTERNAL_PROPOSAL_NOT_SAVED.has(entry.reasonCode))
      continue;
    if (
      entry.kind === "consolidation" &&
      entry.outcome === "hold" &&
      checkupPairs.has(pairKey([...entry.inputs.memoryIds, ...entry.inputs.resultMemoryIds]))
    )
      continue;
    const check = entry.kind === "proactive" ? checks.get(entry.id) : undefined;
    if (entry.kind === "proactive" && entry.outcome === "silent" && (check?.counts.judged ?? 0) < 1)
      continue;
    const key = reviewKey("ledger", entry.id);
    candidates.set(key, {
      candidate: { key, group: calibrationGroup(entry) },
      item: {
        key,
        group: ledgerGroup(entry),
        done: entry.ownerRating !== null,
        doneAt: entry.ratedAt,
      },
      build: async () => {
        let text = "";
        let dataClassification: DataClassification | null = null;
        if (entry.kind === "memory_candidate" && entry.outcome === "discarded") {
          if (entry.contentRef !== null) {
            const ref = entry.contentRef;
            text = clip((await options.readMemoryText(ref).catch(() => undefined)) ?? "");
            dataClassification = visibleClassification([
              await options.readMemoryClassification?.(ref).catch(() => undefined),
            ]);
          }
        } else if (options.readMemory) {
          const { before, after } = reviewedMemoryIds(entry);
          const read = async (id: string) =>
            options.readMemory?.(id).catch(() => undefined) ?? undefined;
          const olds = await Promise.all(before.map(read));
          const next = after === undefined ? undefined : await read(after);
          const parts = [...olds, ...(after === undefined ? [] : [next])];
          const shown = parts.filter(
            (memory): memory is DailyReviewMemoryText => memory !== undefined,
          );
          if (
            shown.length === parts.length &&
            shown.length > 0 &&
            shown.every((memory) => !memory.hidden)
          ) {
            const clipped = (memory: DailyReviewMemoryText) =>
              clipTo(memory.text, shown.length > 1 ? PART_LIMIT : TEXT_LIMIT);
            const oldText = olds.flatMap((memory) => (memory ? [clipped(memory)] : [])).join(" + ");
            text = clipTo(
              next === undefined
                ? oldText
                : oldText === ""
                  ? clipped(next)
                  : `${oldText} → ${clipped(next)}`,
              TEXT_LIMIT,
            );
            dataClassification = visibleClassification(
              shown.map((memory) => memory.dataClassification),
            );
          }
        }
        return {
          dataClassification: text === "" ? null : dataClassification,
          item: {
            key,
            source: "ledger" as const,
            kind,
            outcome: entry.outcome,
            decidedAt: entry.decidedAt,
            acted: ledgerActed(entry),
            rating: entry.ownerRating,
            text,
            textHidden:
              (entry.kind === "memory_candidate" || entry.kind === "consolidation") &&
              text === "" &&
              !isMemoryCaptureFailure(entry.outcome),
            category: entry.category,
            fetched: check ? check.counts.fetched : null,
            checkup: null,
          },
        };
      },
    });
  }
  for (const mail of overview.audit.items) {
    const key = reviewKey("mail", mail.messageId);
    const done = mail.reviewedAt !== null || mail.rating !== null;
    candidates.set(key, {
      candidate: { key, group: "proactive_silent" },
      item: { key, group: "proactive", done, doneAt: mail.reviewedAt },
      build: async () => ({
        dataClassification: MAIL_REVIEW_CLASSIFICATION,
        item: {
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
          checkup: null,
        },
      }),
    });
  }
  for (const entry of options.checkup ?? []) {
    const key = reviewKey("checkup", entry.id);
    candidates.set(key, {
      candidate: { key, group: null },
      item: {
        key,
        group: "memory_checkup",
        done: entry.action !== null,
        doneAt: entry.handledAt,
      },
      build: async () => {
        const read = async (id: string | null) =>
          id === null ? undefined : options.readMemory?.(id).catch(() => undefined);
        const subject = await read(entry.memoryId);
        const related = await read(entry.relatedMemoryId);
        const shown = (memory: DailyReviewMemoryText | undefined) =>
          memory && !memory.hidden ? clip(memory.text) : "";
        return {
          dataClassification: null,
          item: {
            key,
            source: "checkup" as const,
            kind: "checkup" as const,
            outcome: entry.action ?? "pending",
            decidedAt: entry.createdAt,
            acted: false,
            rating: null,
            text: shown(subject),
            textHidden: subject?.hidden === true,
            category: null,
            fetched: null,
            checkup: {
              reason: entry.reason,
              action: entry.action,
              memoryId: entry.memoryId,
              relatedMemoryId: entry.relatedMemoryId,
              relatedText: shown(related),
              keptMemoryId: entry.keptMemoryId,
            },
          },
        };
      },
    });
  }
  return { dayStart, candidates };
}

const MAIL_REVIEW_CLASSIFICATION: DataClassification = "private";

export interface DailyReviewSubject {
  readonly key: string;
  readonly group: CalibrationGroup;
  readonly category: string | null;
  readonly text: string;
  readonly dataClassification: DataClassification;
  readonly ownerRating: DailyReviewRating | null;
}

export interface DailyReviewSubjectSource {
  readonly key: string;
  readonly group: CalibrationGroup;
  readonly rated: boolean;
  readonly build: () => Promise<DailyReviewSubject | undefined>;
}

export async function listDailyReviewSubjects(
  options: DailyReviewSourceOptions,
): Promise<readonly DailyReviewSubjectSource[]> {
  const { candidates } = await collectReviewCandidates(options, (since) => since);
  return [...candidates.values()].flatMap(({ candidate, item: pooled, build }) => {
    const group = candidate.group;
    if (!isPrereviewGroup(group)) return [];
    return [
      {
        key: candidate.key,
        group,
        rated: pooled.done,
        build: async (): Promise<DailyReviewSubject | undefined> => {
          const { item, dataClassification } = await build();
          if (dataClassification === null || item.textHidden || item.text === "") return undefined;
          return {
            key: item.key,
            group,
            category: item.category,
            text: item.text,
            dataClassification,
            ownerRating: item.rating,
          };
        },
      },
    ];
  });
}

export async function readDailyReviewSubjects(
  options: DailyReviewSourceOptions,
): Promise<readonly DailyReviewSubject[]> {
  const subjects: DailyReviewSubject[] = [];
  for (const source of await listDailyReviewSubjects(options)) {
    const subject = await source.build();
    if (subject !== undefined) subjects.push(subject);
  }
  return subjects;
}

export async function readDailyReview(
  options: DailyReviewSourceOptions & {
    readonly budgetSeconds: number;
    readonly secondsPerItem: number;
    readonly silentShare?: number;
    readonly hideByModel?: (
      candidates: readonly DailyReviewCandidate[],
    ) => Promise<ReadonlySet<string>>;
  },
): Promise<DailyReview> {
  const { scope } = options;
  const capacity = reviewCapacity(options.budgetSeconds, options.secondsPerItem);
  const { dayStart, candidates } = await collectReviewCandidates(
    options,
    (_since, dayStart) => dayStart,
  );
  const hidden = options.hideByModel
    ? await options.hideByModel(
        [...candidates.values()].map(({ candidate, build }) => ({
          ...candidate,
          text: async () => (await build()).item.text,
        })),
      )
    : undefined;
  const selection = selectDailyReview({
    pool: [...candidates.values()].map(({ item }) => item),
    ...(hidden === undefined ? {} : { hidden }),
    dayStart,
    seed: `${scope.ownerId}:${scope.agentId}`,
    capacity,
    ...(options.silentShare === undefined ? {} : { silentShare: options.silentShare }),
  });
  const handledEarlier = (options.checkup ?? [])
    .filter(({ handledAt }) => handledAt !== null && handledAt < dayStart)
    .map(({ id }) => reviewKey("checkup", id));
  const build = (keys: readonly string[]) =>
    Promise.all(keys.map((key) => candidates.get(key)?.build())).then((built) =>
      built.flatMap((entry) => (entry === undefined ? [] : [entry.item])),
    );
  return Object.freeze({
    day: dayStart,
    capacity,
    sampled: selection.sampled,
    notSampled: selection.notSampled,
    hiddenByModel: selection.hiddenByModel,
    items: Object.freeze(await build([...selection.shown, ...handledEarlier])),
    folded: Object.freeze({
      total: selection.foldedTotal,
      items: Object.freeze(await build(selection.foldedShown)),
    }),
  });
}
