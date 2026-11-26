import type {
  ProactiveDecision,
  ProactiveScope,
  ProactiveSealPort,
  ProactiveSourceReader,
  ProactiveStorePort,
} from "../ports/proactive-checks.js";
import {
  PROACTIVE_SOURCES,
  type ProactiveSource,
  type ProactiveSourceItem,
  type ProactiveSourceRegistry,
  type ProactiveSourceSettings,
} from "../ports/proactive-sources.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { ruleBookFor } from "../rules/rule-book.js";
import { quietEnd, quietHitRefs, startOfZonedDay } from "./proactive-rules.js";

export type ProactiveSourceLimitKind = "per_check" | "per_day";

export interface ProactiveSourceLimitHit {
  readonly source: ProactiveSource;
  readonly kind: ProactiveSourceLimitKind;
  readonly limit: number;
  readonly heldBack: number;
}

export async function readProactiveSourceSettings(
  store: Pick<ProactiveStorePort, "listSourceSettings">,
  scope: ProactiveScope,
  source: ProactiveSource,
): Promise<ProactiveSourceSettings | undefined> {
  return (await store.listSourceSettings(scope)).find((settings) => settings.source === source);
}

export function limitedSourceReader<
  Extra,
  Reader extends ProactiveSourceReader<Extra> = ProactiveSourceReader<Extra>,
>(options: {
  readonly reader: Reader;
  readonly scope: ProactiveScope;
  readonly store: Pick<ProactiveStorePort, "listSourceSettings" | "processedSince" | "unprocessed">;
  readonly clock: ClockPort;
  readonly timeZone: string;
  readonly onLimit?: (hit: ProactiveSourceLimitHit) => void;
}): Reader {
  const { reader, scope, store } = options;
  const source = reader.source;
  const fetch: ProactiveSourceReader<Extra>["fetch"] = async (input) => {
    const fetched = await reader.fetch(input);
    if (fetched.kind !== "items") return fetched;
    const settings = await readProactiveSourceSettings(store, scope, source);
    if (settings === undefined) return fetched;
    const key = (item: ProactiveSourceItem<Extra>) => item.id;
    const fresh = new Set(
      await store.unprocessed({ ...scope, source, messageIds: fetched.items.map(key) }),
    );
    const usedToday = await store.processedSince({
      ...scope,
      source,
      since: startOfZonedDay(options.clock.now(), options.timeZone),
    });
    const leftToday = Math.max(0, settings.perDay - usedToday);
    const allowance = Math.min(settings.perCheck, leftToday);
    if (fresh.size <= allowance) return fetched;
    const kept: ProactiveSourceItem<Extra>[] = [];
    let taken = 0;
    for (const item of fetched.items) {
      if (!fresh.has(key(item))) kept.push(item);
      else if (taken < allowance) {
        kept.push(item);
        taken += 1;
      }
    }
    const perDay = leftToday < settings.perCheck;
    options.onLimit?.({
      source,
      kind: perDay ? "per_day" : "per_check",
      limit: perDay ? settings.perDay : settings.perCheck,
      heldBack: fresh.size - taken,
    });
    return { kind: "items", items: kept, cursor: null };
  };
  return Object.defineProperty(Object.create(reader), "fetch", {
    value: fetch,
    enumerable: true,
  }) as Reader;
}

export const PROGRAM_ENTRY_TEXT_LIMIT = 2_000;
export const PROGRAM_ENTRY_RESULTS = ["act", "check"] as const;
export const PROGRAM_ENTRY_PRIORITIES = ["high", "medium", null] as const;

export interface ProactiveProgramEntry {
  readonly source: ProactiveSource;
  readonly entryId: string;
  readonly summary: string;
  readonly reason: string;
  readonly link: string;
  readonly result: (typeof PROGRAM_ENTRY_RESULTS)[number];
  readonly priority: (typeof PROGRAM_ENTRY_PRIORITIES)[number];
  readonly dueAt: string | null;
  readonly deliverAt: string | null;
}

export type ProactiveProgramEntryOutcome =
  | { readonly kind: "recorded"; readonly decision: ProactiveDecision; readonly insightId: string }
  | {
      readonly kind: "not_recorded";
      readonly reason:
        | "proactive_off"
        | "source_off"
        | "already_recorded"
        | "daily_limit"
        | "source_not_registered"
        | "source_has_reader"
        | "entry_invalid";
    };

export interface ProactiveProgramEntryOptions {
  readonly scope: ProactiveScope;
  readonly store: ProactiveStorePort;
  readonly seal: ProactiveSealPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly timeZone: string;
  readonly registry?: ProactiveSourceRegistry<ProactiveSource>;
  readonly onLimit?: (hit: ProactiveSourceLimitHit) => void;
}

const PROGRAM_ENTRY_TIME_LENGTH_LIMIT = 40;

function httpsLinkOrEmpty(value: unknown): boolean {
  if (typeof value !== "string" || value.length > PROGRAM_ENTRY_TEXT_LIMIT) return false;
  if (value === "") return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isoTimeOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > PROGRAM_ENTRY_TIME_LENGTH_LIMIT) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export async function recordProactiveProgramEntry(
  options: ProactiveProgramEntryOptions,
  entry: ProactiveProgramEntry,
): Promise<ProactiveProgramEntryOutcome> {
  const { scope, store, seal, clock, ids } = options;
  if (typeof entry !== "object" || entry === null)
    return { kind: "not_recorded", reason: "entry_invalid" };
  const definition = (options.registry ?? PROACTIVE_SOURCES).get(entry.source);
  if (definition === undefined) return { kind: "not_recorded", reason: "source_not_registered" };
  if (definition.intake !== "written_by_program")
    return { kind: "not_recorded", reason: "source_has_reader" };
  if (
    !(PROGRAM_ENTRY_RESULTS as readonly unknown[]).includes(entry.result) ||
    !(PROGRAM_ENTRY_PRIORITIES as readonly unknown[]).includes(entry.priority) ||
    typeof entry.entryId !== "string" ||
    entry.entryId.length < 1 ||
    entry.entryId.length > 256 ||
    typeof entry.summary !== "string" ||
    entry.summary.trim().length < 1 ||
    entry.summary.length > PROGRAM_ENTRY_TEXT_LIMIT ||
    typeof entry.reason !== "string" ||
    entry.reason.length > PROGRAM_ENTRY_TEXT_LIMIT ||
    !httpsLinkOrEmpty(entry.link) ||
    !isoTimeOrNull(entry.dueAt) ||
    !isoTimeOrNull(entry.deliverAt)
  )
    return { kind: "not_recorded", reason: "entry_invalid" };
  const settings = await store.readSettings(scope);
  if (!settings.enabled) return { kind: "not_recorded", reason: "proactive_off" };
  const sourceSettings = await readProactiveSourceSettings(store, scope, entry.source);
  if (sourceSettings !== undefined && !sourceSettings.enabled)
    return { kind: "not_recorded", reason: "source_off" };
  const fresh = await store.unprocessed({
    ...scope,
    source: entry.source,
    messageIds: [entry.entryId],
  });
  if (fresh.length === 0) return { kind: "not_recorded", reason: "already_recorded" };
  const now = clock.now();
  if (sourceSettings !== undefined) {
    const usedToday = await store.processedSince({
      ...scope,
      source: entry.source,
      since: startOfZonedDay(now, options.timeZone),
    });
    if (usedToday >= sourceSettings.perDay) {
      options.onLimit?.({
        source: entry.source,
        kind: "per_day",
        limit: sourceSettings.perDay,
        heldBack: 1,
      });
      return { kind: "not_recorded", reason: "daily_limit" };
    }
  }
  const wanted = entry.deliverAt !== null && entry.deliverAt > now ? entry.deliverAt : now;
  const rules = ruleBookFor(settings);
  const quiet = quietEnd(wanted, rules, settings.quietHours, options.timeZone);
  const readyAt = quiet ?? wanted;
  const pending = readyAt > now ? await store.pendingPush({ ...scope, readyAt }) : undefined;
  const push = { id: pending?.id ?? ids.next("proactive-push"), readyAt };
  const contentRef = await seal.seal({
    ...scope,
    text: JSON.stringify({
      summary: entry.summary,
      reason: entry.reason,
      basis: "model",
      floorHit: false,
      from: "",
      subject: "",
      link: entry.link,
    }),
    at: now,
  });
  const insightId = ids.next("source-insight");
  const decision: ProactiveDecision = Object.freeze({
    id: ids.next("proactive-decision"),
    scenario: entry.source,
    checkedAt: now,
    counts: Object.freeze({
      fetched: 1,
      skipped: 0,
      judged: 0,
      act: entry.result === "act" ? 1 : 0,
      know: 0,
      check: entry.result === "check" ? 1 : 0,
      ignore: 0,
      floorRaised: 0,
      pushed: 1,
    }),
    verdict: readyAt > now ? "deferred" : "pushed",
    reasonCode: quiet ? "QUIET_HOURS" : readyAt > now ? "DELIVER_AT" : "PROGRAM_ENTRY",
    pushSourceKey: `proactive:${push.id}`,
    costMicros: 0,
    durationMs: 0,
    ownerRating: null,
    ratedAt: null,
  });
  try {
    const recorded = await store.record({
      ...scope,
      decision,
      inputs: {
        ruleIds: quiet ? [...quietHitRefs(wanted, rules, options.timeZone)].sort() : [],
        sourceIds: [entry.entryId],
        floorHits: {},
        ruleHits: {},
        memoryInjected: false,
        memoryIds: [],
        usedMemoryIds: [],
        tentativeMemoryIds: [],
        memoryByMail: {},
        memoryRecall: "off",
      },
      modelPayloads: [],
      processed: [
        {
          source: entry.source,
          messageId: entry.entryId,
          threadId: entry.entryId,
          outcome: entry.result,
          skipReason: null,
          headerRef: null,
          receivedAt: now,
        },
      ],
      insights: [
        {
          id: insightId,
          threadId: entry.entryId,
          lastMessageId: entry.entryId,
          result: entry.result,
          floorRaised: false,
          contentRef,
          dueAt: entry.dueAt,
          priority: entry.priority,
          push: true,
        },
      ],
      repliedThreads: [],
      push,
      cursor: null,
      onlyIfNew: {
        source: entry.source,
        since: startOfZonedDay(now, options.timeZone),
      },
    });
    if (recorded.refused !== undefined) {
      await seal.release({ ...scope, refs: [contentRef] }).catch(() => undefined);
      if (recorded.refused === "daily_limit" && sourceSettings !== undefined)
        options.onLimit?.({
          source: entry.source,
          kind: "per_day",
          limit: sourceSettings.perDay,
          heldBack: 1,
        });
      return { kind: "not_recorded", reason: recorded.refused };
    }
    if (recorded.releasedRefs.length > 0)
      await seal.release({ ...scope, refs: recorded.releasedRefs });
    return { kind: "recorded", decision, insightId: recorded.insightIds[0] ?? insightId };
  } catch (error) {
    await seal.release({ ...scope, refs: [contentRef] }).catch(() => undefined);
    throw error;
  }
}
