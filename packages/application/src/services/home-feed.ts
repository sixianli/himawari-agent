import type {
  HOME_ACTIONS,
  HOME_ITEM_KINDS,
  HOME_LABEL_BASES,
  HOME_LOCALES,
  HOME_ORIGIN_TYPES,
  HOME_POLARITIES,
  HOME_RANKS,
  HOME_SENTENCE_BASES,
  HOME_SOURCE_NAMES,
  HOME_TARGET_TYPES,
} from "@himawari-agent/gateway-contracts";
import type { DataClassification } from "../ports/common.js";
import type { HomeFeedConfiguration } from "../ports/configuration.js";
import type { HomeUrgencyCandidate, HomeUrgencyFact } from "./home-urgency.js";

export type HomeItemKind = (typeof HOME_ITEM_KINDS)[number];
export type HomeSentenceBasis = (typeof HOME_SENTENCE_BASES)[number];
export type HomeRank = (typeof HOME_RANKS)[number];
export type HomeTargetType = (typeof HOME_TARGET_TYPES)[number];
export type HomeOriginType = (typeof HOME_ORIGIN_TYPES)[number];
export type HomeSourceName = (typeof HOME_SOURCE_NAMES)[number];
export type HomeLocale = (typeof HOME_LOCALES)[number];
export type HomeActionName = (typeof HOME_ACTIONS)[number];

export interface HomeAction {
  readonly action: HomeActionName;
  readonly label: string;
  readonly labelBasis: (typeof HOME_LABEL_BASES)[number];
  readonly polarity: (typeof HOME_POLARITIES)[number];
  readonly ownerPresence: boolean;
  readonly reviewLabel: string | null;
  readonly binding: string | null;
}

export const DEFAULT_HOME_FEED: HomeFeedConfiguration = Object.freeze({
  awaitingLimit: 200,
  otherLimit: 30,
  sourceReadLimit: 200,
  deadlineLeadMinutes: 1440,
  recentHours: 24,
  upcomingLimit: 20,
  upcomingDays: 60,
});

export interface HomeTarget {
  readonly type: HomeTargetType;
  readonly id: string | null;
  readonly threadId: string | null;
  readonly link: string | null;
}

export interface HomeOrigin {
  readonly type: HomeOriginType;
  readonly from: string | null;
  readonly label: string | null;
  readonly threadId: string | null;
  readonly decisionId: string | null;
  readonly at: string;
}

export interface HomeCandidate {
  readonly key: string;
  readonly kind: HomeItemKind;
  readonly awaitsOwner: boolean;
  readonly sentence: string | null;
  readonly sentenceBasis: HomeSentenceBasis;
  readonly target: HomeTarget;
  readonly source: HomeOrigin;
  readonly deadline: string | null;
  readonly createdAt: string;
  readonly actions: readonly HomeAction[];
  readonly ruleHit: boolean;
  readonly dataClassification: DataClassification;
  readonly approval?: HomeApprovalDetail;
}

export interface HomeApprovalDetail {
  readonly id: string;
  readonly semanticSnapshotHash: string;
  readonly facts: { readonly [key: string]: HomeUrgencyFact };
}

export interface HomeFeedItem extends Omit<HomeCandidate, "ruleHit" | "approval"> {
  readonly rank: HomeRank;
}

export interface HomeUpcoming {
  readonly reminderId: string;
  readonly memoryId: string;
  readonly text: string;
  readonly dueAt: string;
  readonly repeat: "none" | "yearly";
  readonly sourceThreadId: string | null;
  readonly dataClassification: DataClassification;
}

export interface HomeSourceInput {
  readonly now: string;
  readonly recentSince: string;
  readonly limit: number;
  readonly locale: HomeLocale;
}

export interface HomeSourceResult {
  readonly items: readonly HomeCandidate[];
  readonly unread: number;
  readonly incomplete?: boolean;
}

export interface HomeSource {
  readonly name: Exclude<HomeSourceName, "upcoming">;
  readonly awaitsOwner: boolean;
  read(input: HomeSourceInput): Promise<HomeSourceResult>;
}

export interface HomeFeed {
  readonly items: readonly HomeFeedItem[];
  readonly awaitingCount: number;
  readonly awaitingTruncated: boolean;
  readonly incompleteSources: readonly HomeSourceName[];
  readonly upcoming: readonly HomeUpcoming[];
  readonly revision: string;
  readonly generatedAt: string;
}

export interface HomeFeedServiceOptions {
  readonly sources: readonly HomeSource[];
  readonly upcoming?: (input: {
    readonly now: string;
    readonly until: string;
    readonly limit: number;
  }) => Promise<{ readonly items: readonly HomeUpcoming[]; readonly incomplete: boolean }>;
  readonly settings: HomeFeedConfiguration;
  readonly clock: { now(): string };
  readonly digest: (text: string) => string;
  readonly onSourceFailure: (source: HomeSourceName, error: unknown) => void;
  readonly scores?: (
    candidates: readonly HomeUrgencyCandidate[],
  ) => Promise<ReadonlyMap<string, number>>;
  readonly onScoreFailure?: (error: unknown) => void;
}

export const HOME_SCORING_LOCALE: HomeLocale = "en";

export function homeUrgencyCandidate(candidate: HomeCandidate): HomeUrgencyCandidate {
  const { approval } = candidate;
  if (approval)
    return {
      key: candidate.key,
      kind: candidate.kind,
      deadline: candidate.deadline,
      dataClassification: candidate.dataClassification,
      digestBasis: approval.semanticSnapshotHash,
      facts: approval.facts,
      approvalRequestId: approval.id,
    };
  const text = candidate.sentenceBasis === "model" ? null : candidate.sentence;
  return {
    key: candidate.key,
    kind: candidate.kind,
    deadline: candidate.deadline,
    dataClassification: candidate.dataClassification,
    digestBasis: JSON.stringify([
      candidate.kind,
      candidate.sentenceBasis === "recorded" ? candidate.sentence : null,
      candidate.deadline,
    ]),
    facts: {
      text,
      origin: candidate.source.type,
      from: candidate.source.from,
      label: candidate.source.label,
      ruleHit: candidate.ruleHit,
    },
  };
}

const RANK_ORDER: Readonly<Record<HomeRank, number>> = {
  rule: 0,
  deadline: 1,
  unscored: 2,
  model: 3,
  recency: 4,
};

function rankOf(candidate: HomeCandidate, now: string, leadMs: number, scored: boolean): HomeRank {
  if (!candidate.awaitsOwner) return "recency";
  if (candidate.ruleHit) return "rule";
  if (candidate.deadline !== null && Date.parse(candidate.deadline) - Date.parse(now) <= leadMs)
    return "deadline";
  return scored ? "model" : "unscored";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareItems(
  left: HomeFeedItem,
  right: HomeFeedItem,
  scores: ReadonlyMap<string, number>,
): number {
  const rank = RANK_ORDER[left.rank] - RANK_ORDER[right.rank];
  if (rank !== 0) return rank;
  if (left.rank === "model") {
    const score = (scores.get(right.key) ?? 0) - (scores.get(left.key) ?? 0);
    if (score !== 0) return score;
  }
  if (left.awaitsOwner) {
    if (left.deadline !== right.deadline) {
      if (left.deadline === null) return 1;
      if (right.deadline === null) return -1;
      const deadline = Date.parse(left.deadline) - Date.parse(right.deadline);
      if (deadline !== 0) return deadline;
    }
  }
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (created !== 0) return created;
  return compareText(left.key, right.key);
}

export function orderHomeItems(
  candidates: readonly HomeCandidate[],
  now: string,
  deadlineLeadMinutes: number,
  scores: ReadonlyMap<string, number> = new Map(),
): HomeFeedItem[] {
  const leadMs = deadlineLeadMinutes * 60_000;
  const seen = new Set<string>();
  const items: HomeFeedItem[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const { ruleHit: _ruleHit, approval: _approval, ...rest } = candidate;
    items.push({ ...rest, rank: rankOf(candidate, now, leadMs, scores.has(candidate.key)) });
  }
  return items.sort((left, right) => compareItems(left, right, scores));
}

export class HomeFeedService {
  readonly #options: HomeFeedServiceOptions;

  constructor(options: HomeFeedServiceOptions) {
    this.#options = options;
  }

  async #collect(input: HomeSourceInput, awaitingOnly: boolean) {
    const candidates: HomeCandidate[] = [];
    const incomplete: HomeSourceName[] = [];
    let unread = 0;
    for (const source of this.#options.sources) {
      if (awaitingOnly && !source.awaitsOwner) continue;
      try {
        const result = await source.read(input);
        for (const item of result.items)
          if (item.awaitsOwner === source.awaitsOwner) candidates.push(item);
        if (source.awaitsOwner) unread += Math.max(0, result.unread);
        if (result.incomplete) incomplete.push(source.name);
      } catch (error) {
        incomplete.push(source.name);
        this.#options.onSourceFailure(source.name, error);
      }
    }
    return { candidates, incomplete, unread };
  }

  #input(now: string, locale: HomeLocale): HomeSourceInput {
    const { settings } = this.#options;
    return {
      now,
      recentSince: new Date(Date.parse(now) - settings.recentHours * 3_600_000).toISOString(),
      limit: settings.sourceReadLimit,
      locale,
    };
  }

  async awaitingCount(): Promise<number | undefined> {
    const now = this.#options.clock.now();
    const { candidates, incomplete, unread } = await this.#collect(
      this.#input(now, HOME_SCORING_LOCALE),
      true,
    );
    if (incomplete.length > 0) return undefined;
    return new Set(candidates.map(({ key }) => key)).size + unread;
  }

  async awaitingCandidates(): Promise<readonly HomeUrgencyCandidate[]> {
    const now = this.#options.clock.now();
    const { candidates } = await this.#collect(this.#input(now, HOME_SCORING_LOCALE), true);
    return candidates.map(homeUrgencyCandidate);
  }

  async #scores(candidates: readonly HomeCandidate[]): Promise<ReadonlyMap<string, number>> {
    const { scores } = this.#options;
    const awaiting = candidates.filter(({ awaitsOwner }) => awaitsOwner);
    if (!scores || awaiting.length === 0) return new Map();
    try {
      return await scores(awaiting.map(homeUrgencyCandidate));
    } catch (error) {
      this.#options.onScoreFailure?.(error);
      return new Map();
    }
  }

  async read(input: { readonly locale: HomeLocale }): Promise<HomeFeed> {
    const { settings } = this.#options;
    const now = this.#options.clock.now();
    const { candidates, incomplete, unread } = await this.#collect(
      this.#input(now, input.locale),
      false,
    );
    const ordered = orderHomeItems(
      [
        ...candidates.filter(({ awaitsOwner }) => awaitsOwner),
        ...candidates.filter(({ awaitsOwner }) => !awaitsOwner),
      ],
      now,
      settings.deadlineLeadMinutes,
      await this.#scores(candidates),
    );
    const awaiting = ordered.filter(({ awaitsOwner }) => awaitsOwner);
    const others = ordered.filter(({ awaitsOwner }) => !awaitsOwner);
    const items = [
      ...awaiting.slice(0, settings.awaitingLimit),
      ...others.slice(0, settings.otherLimit),
    ];
    let upcoming: readonly HomeUpcoming[] = [];
    if (this.#options.upcoming)
      try {
        const result = await this.#options.upcoming({
          now,
          until: new Date(Date.parse(now) + settings.upcomingDays * 86_400_000).toISOString(),
          limit: settings.upcomingLimit,
        });
        upcoming = result.items;
        if (result.incomplete) incomplete.push("upcoming");
      } catch (error) {
        incomplete.push("upcoming");
        this.#options.onSourceFailure("upcoming", error);
      }
    const awaitingCount = awaiting.length + unread;
    const awaitingTruncated = unread > 0 || awaiting.length > settings.awaitingLimit;
    return {
      items,
      awaitingCount,
      awaitingTruncated,
      incompleteSources: incomplete,
      upcoming,
      revision: this.#options.digest(
        JSON.stringify([items, awaitingCount, awaitingTruncated, incomplete, upcoming]),
      ),
      generatedAt: now,
    };
  }
}
