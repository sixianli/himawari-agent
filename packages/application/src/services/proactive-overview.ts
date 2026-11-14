import type { DataClassification } from "../ports/common.js";
import {
  PROACTIVE_INSIGHT_LIST_MAXIMUM,
  type ProactiveCounts,
  type ProactiveInsight,
  type ProactiveInsightContent,
  type ProactiveQuietPeriod,
  type ProactiveRating,
  type ProactiveScope,
  type ProactiveSourceItem,
  type ProactiveSealPort,
  type ProactiveSource,
  type ProactiveStorePort,
  type ProactiveVerdict,
} from "../ports/proactive-checks.js";
import type { WebPushFeedback } from "../ports/web-push.js";
import { ruleBookFor } from "../rules/rule-book.js";
import {
  floorHitIds,
  fromAddressOf,
  isReminderWorthy,
  startOfZonedDay,
} from "./proactive-rules.js";

const AUDIT_DAYS = 7;
const METRIC_DAYS = 30;
const REACTION_WINDOW_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export interface ProactiveOverviewInsight {
  readonly id: string;
  readonly result: ProactiveInsight["result"];
  readonly floorRaised: boolean;
  readonly summary: string;
  readonly reason: string;
  readonly basis: ProactiveInsightContent["basis"];
  readonly from: string;
  readonly subject: string;
  readonly link: string;
  readonly dueAt: string | null;
  readonly priority: ProactiveInsight["priority"];
  readonly status: ProactiveInsight["status"];
  readonly pushed: boolean;
  readonly pushReaction: "opened" | "dismissed" | null;
  readonly rating: ProactiveRating | null;
  readonly decisionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: DataClassification;
}

export interface ProactiveOverviewBackoff {
  readonly classKey: string;
  readonly domain: string;
  readonly stage: 1 | 2;
  readonly ignoredCount: number;
  readonly changedAt: string;
}

export interface ProactiveOverviewAuditItem {
  readonly messageId: string;
  readonly decidedAt: string;
  readonly reviewedAt: string | null;
  readonly from: string;
  readonly subject: string;
  readonly link: string;
  readonly rating: ProactiveRating | null;
}

export interface ProactiveOverviewDecision {
  readonly id: string;
  readonly checkedAt: string;
  readonly verdict: ProactiveVerdict;
  readonly reasonCode: string;
  readonly counts: ProactiveCounts;
  readonly opened: boolean;
  readonly rating: ProactiveRating | null;
}

export interface ProactiveOverview {
  readonly source: ProactiveSource;
  readonly connection: {
    readonly status: "disconnected" | "connected" | "needs_reconnect";
    readonly account: string | null;
    readonly connectedAt: string | null;
    readonly changedAt: string | null;
  };
  readonly enabled: boolean;
  readonly quietHours: readonly ProactiveQuietPeriod[];
  readonly importantSenders: readonly string[];
  readonly dailyLimitReached: boolean;
  readonly backoff: readonly ProactiveOverviewBackoff[];
  readonly insights: readonly ProactiveOverviewInsight[];
  readonly insightsCapped: boolean;
  readonly audit: {
    readonly active: boolean;
    readonly since: string;
    readonly items: readonly ProactiveOverviewAuditItem[];
    readonly pending: number;
  };
  readonly decisions: readonly ProactiveOverviewDecision[];
  readonly metrics: {
    readonly spoke: number;
    readonly hits: number;
    readonly misfires: number;
    readonly missed: number;
    readonly reviewed: number;
  };
}

function parse<T>(text: string | undefined): Partial<T> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Partial<T>;
  } catch {
    return {};
  }
}

export async function readProactiveOverview(options: {
  readonly scope: ProactiveScope;
  readonly source: ProactiveSource;
  readonly store: ProactiveStorePort;
  readonly seal: ProactiveSealPort;
  readonly timeZone: string;
  readonly dailyCostMicros: number;
  readonly now: string;
  readonly feedback: (sentFrom: string) => Promise<readonly WebPushFeedback[]>;
}): Promise<ProactiveOverview> {
  const { scope, store, seal, now } = options;
  const settings = await store.readSettings(scope);
  const rules = ruleBookFor(settings);
  const connection = await store.readConnection({ ...scope, source: options.source });
  const open = (ref: string) => seal.open({ ...scope, ref });
  const account = connection ? ((await open(connection.accountRef)) ?? null) : null;
  const today = startOfZonedDay(now, options.timeZone);
  const decisionsToday = await store.listDecisions({ ...scope, since: today, limit: 500 });
  const dailyLimitReached =
    (await store.costSince({ ...scope, since: today })) >= options.dailyCostMicros ||
    decisionsToday.some(({ verdict }) => verdict === "capped_daily");
  const metricSince = new Date(Date.parse(now) - METRIC_DAYS * DAY_MS).toISOString();
  const feedback = new Map(
    (await options.feedback(metricSince)).map((entry) => [entry.sourceKey, entry]),
  );
  const reaction = (sourceKey: string | null) => {
    const sent = sourceKey ? feedback.get(sourceKey) : undefined;
    return sent?.openedAt ? "opened" : sent?.dismissedAt ? "dismissed" : null;
  };
  const auditSince = new Date(Date.parse(now) - AUDIT_DAYS * DAY_MS).toISOString();
  const insights: ProactiveOverviewInsight[] = [];
  const filteredInsights: ProactiveOverviewAuditItem[] = [];
  const storedInsights = await store.listInsights({ ...scope, statuses: ["open", "replied"] });
  let insightsCapped = false;
  if (storedInsights.length >= PROACTIVE_INSIGHT_LIST_MAXIMUM) {
    const openCount = (await store.listInsights({ ...scope, statuses: ["open"] })).length;
    insightsCapped =
      openCount >= PROACTIVE_INSIGHT_LIST_MAXIMUM ||
      openCount > storedInsights.filter(({ status }) => status === "open").length;
  }
  for (const insight of storedInsights) {
    const content = parse<ProactiveInsightContent>(await open(insight.contentRef));
    const floor =
      insight.floorRaised ||
      (content.floorHit ??
        floorHitIds(
          {
            fromAddress: fromAddressOf(content.from ?? ""),
            subject: content.subject ?? "",
            snippet: content.summary ?? "",
          } as ProactiveSourceItem,
          rules,
        ).length > 0);
    if (!isReminderWorthy(insight.result, insight.priority, floor)) {
      if (insight.updatedAt >= auditSince)
        filteredInsights.push(
          Object.freeze({
            messageId: insight.lastMessageId,
            decidedAt: insight.updatedAt,
            reviewedAt: null,
            from: content.from ?? "",
            subject: content.subject ?? "",
            link: content.link ?? "",
            rating: null,
          }),
        );
      continue;
    }
    insights.push(
      Object.freeze({
        id: insight.id,
        result: insight.result,
        floorRaised: insight.floorRaised,
        summary: content.summary ?? "",
        reason: content.reason ?? "",
        basis: content.basis ?? "model",
        from: content.from ?? "",
        subject: content.subject ?? "",
        link: content.link ?? "",
        dueAt: insight.dueAt,
        priority: insight.priority,
        status: insight.status,
        pushed: insight.pushSourceKey !== null,
        pushReaction: reaction(insight.pushSourceKey),
        rating: insight.ownerRating,
        decisionId: insight.decisionId,
        createdAt: insight.createdAt,
        updatedAt: insight.updatedAt,
        dataClassification:
          (await seal.classificationOf?.({ ...scope, ref: insight.contentRef })) ?? "private",
      }),
    );
  }
  const auditActive = connection !== undefined;
  const ignored = auditActive
    ? await store.listProcessed({ ...scope, since: auditSince, outcome: "ignore", limit: 500 })
    : [];
  const storedFiltered = new Map<
    string,
    { readonly ownerRating: ProactiveRating | null; readonly reviewedAt: string | null }
  >();
  if (auditActive && filteredInsights.length > 0)
    for (const outcome of ["act", "know", "check"] as const)
      for (const row of await store.listProcessed({
        ...scope,
        since: auditSince,
        outcome,
        limit: 500,
      }))
        storedFiltered.set(row.messageId, row);
  const auditItems: ProactiveOverviewAuditItem[] = auditActive
    ? filteredInsights.map((item) =>
        Object.freeze({
          ...item,
          rating: storedFiltered.get(item.messageId)?.ownerRating ?? null,
          reviewedAt: storedFiltered.get(item.messageId)?.reviewedAt ?? null,
        }),
      )
    : [];
  for (const message of ignored) {
    const header = parse<{ from: string; subject: string; link: string }>(
      message.headerRef ? await open(message.headerRef) : undefined,
    );
    auditItems.push(
      Object.freeze({
        messageId: message.messageId,
        decidedAt: message.processedAt,
        reviewedAt: message.reviewedAt,
        from: header.from ?? "",
        subject: header.subject ?? "",
        link: header.link ?? "",
        rating: message.ownerRating,
      }),
    );
  }
  const recent = await store.listDecisions({ ...scope, since: metricSince, limit: 500 });
  let hits = 0;
  let misfires = 0;
  for (const decision of recent) {
    if (decision.verdict !== "pushed" && decision.verdict !== "deferred") continue;
    const sent = decision.pushSourceKey ? feedback.get(decision.pushSourceKey) : undefined;
    const opened =
      sent?.openedAt !== null &&
      sent?.openedAt !== undefined &&
      Date.parse(sent.openedAt) - Date.parse(sent.firstSentAt) <= REACTION_WINDOW_MS;
    if (decision.ownerRating === "useful" || opened) hits += 1;
    else if (
      decision.ownerRating === "unneeded" ||
      (sent !== undefined &&
        (sent.dismissedAt !== null ||
          Date.parse(now) - Date.parse(sent.firstSentAt) > REACTION_WINDOW_MS))
    )
      misfires += 1;
  }
  const missedAudit = (
    await store.listProcessed({ ...scope, since: metricSince, outcome: "ignore", limit: 500 })
  ).filter(({ ownerRating }) => ownerRating === "missed").length;
  const decisions: ProactiveOverviewDecision[] = recent.slice(0, 200).map((decision) =>
    Object.freeze({
      id: decision.id,
      checkedAt: decision.checkedAt,
      verdict: decision.verdict,
      reasonCode: decision.reasonCode,
      counts: decision.counts,
      opened: decision.pushSourceKey
        ? (feedback.get(decision.pushSourceKey)?.openedAt ?? null) !== null
        : false,
      rating: decision.ownerRating,
    }),
  );
  return Object.freeze({
    source: options.source,
    connection: Object.freeze({
      status: connection?.status ?? "disconnected",
      account,
      connectedAt: connection?.connectedAt ?? null,
      changedAt: connection?.updatedAt ?? null,
    }),
    enabled: settings.enabled,
    quietHours: settings.quietHours,
    importantSenders: settings.importantSenders,
    dailyLimitReached,
    backoff: Object.freeze(
      (await store.listBackoff(scope))
        .filter(({ stage }) => stage > 0)
        .map(({ classKey, stage, ignoredCount, stageChangedAt, updatedAt }) =>
          Object.freeze({
            classKey,
            domain: classKey.slice(classKey.indexOf(":") + 1),
            stage: stage as 1 | 2,
            ignoredCount,
            changedAt: stageChangedAt ?? updatedAt,
          }),
        ),
    ),
    insights: Object.freeze(insights),
    insightsCapped,
    audit: Object.freeze({
      active: auditActive,
      since: auditSince,
      items: Object.freeze(auditItems.slice(0, 500)),
      pending:
        ignored.filter(({ reviewedAt }) => reviewedAt === null).length +
        auditItems.filter(
          ({ messageId }) =>
            storedFiltered.has(messageId) && storedFiltered.get(messageId)?.reviewedAt === null,
        ).length,
    }),
    decisions: Object.freeze(decisions),
    metrics: Object.freeze({
      spoke: recent.filter(({ verdict }) => verdict === "pushed" || verdict === "deferred").length,
      hits,
      misfires,
      missed: recent.filter(({ ownerRating }) => ownerRating === "missed").length + missedAudit,
      reviewed: await store.reviewedCount(scope),
    }),
  });
}
