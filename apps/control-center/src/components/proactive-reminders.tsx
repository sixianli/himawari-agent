import { useEffect, useRef, useState } from "react";
import { DEFAULT_UI_LOCALE } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import {
  openSettings,
  type ProactiveDecision,
  type ProactiveGroup,
  type ProactiveInsight,
  type ProactiveCheckupAction,
  type ProactiveModel,
  type ProactiveOverview,
  type ProactiveRating,
  type ProactiveReviewItem,
  type ProactiveReviewRating,
  proactiveGroup,
} from "../proactive.js";
import { LineIcon } from "./answer-footer.js";
import { DecisionChainDrawer } from "./decision-chain-drawer.js";
import { Glyph } from "./glyphs.js";
import { openNotificationSettings } from "./memory-panel.js";
import { ActionMenu } from "./overlays.js";
import { ActionButton, EmptyState } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

const HIGHLIGHT_MS = 2600;
const DAY_MS = 86_400_000;

export const clock = (value: string, locale: string | undefined) =>
  new Intl.DateTimeFormat(locale ?? DEFAULT_UI_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
export const day = (value: string, locale: string | undefined) =>
  new Intl.DateTimeFormat(locale ?? DEFAULT_UI_LOCALE, {
    month: locale?.startsWith("en") ? "short" : "numeric",
    day: "numeric",
  }).format(new Date(value));
export const dayAndClock = (value: string, locale: string | undefined) =>
  `${day(value, locale)} ${clock(value, locale)}`;
const midnight = (value: string) => {
  const date = new Date(value);
  return date.getHours() === 0 && date.getMinutes() === 0;
};

function RatingChoices({
  choices,
  current,
  disabled,
  message,
  onRate,
}: {
  choices: readonly ProactiveRating[];
  current: ProactiveRating | null;
  disabled: boolean;
  message: Message;
  onRate: (rating: ProactiveRating | null) => void;
}) {
  return (
    <span className="proactive-rate">
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          aria-pressed={current === choice}
          disabled={disabled}
          onClick={() => onRate(current === choice ? null : choice)}
        >
          {message("proactive.rate", { r: choice })}
        </button>
      ))}
    </span>
  );
}

function insightWhen(
  insight: ProactiveInsight,
  group: ProactiveGroup,
  message: Message,
  locale: string | undefined,
) {
  if (group === "check")
    return message("proactive.when.received", { date: day(insight.updatedAt, locale) });
  if (!insight.dueAt) return "—";
  if (group === "know") return day(insight.dueAt, locale);
  if (group === "today")
    return message("proactive.when.dueToday", { time: clock(insight.dueAt, locale) });
  return message("proactive.when.due", {
    time: midnight(insight.dueAt) ? day(insight.dueAt, locale) : dayAndClock(insight.dueAt, locale),
  });
}

export function ProactiveInsightRow({
  insight,
  group,
  proactive,
  message,
  highlighted,
  onNotice,
  locale,
}: {
  locale?: string | undefined;
  insight: ProactiveInsight;
  group: ProactiveGroup;
  proactive: ProactiveModel;
  message: Message;
  highlighted: boolean;
  onNotice: (text: string, undo: () => void) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "center" });
  }, [highlighted]);
  const title = insight.summary || insight.subject;
  const [why, setWhy] = useState(false);
  const hasReason =
    insight.basis === "daily_limit" || Boolean(insight.reason) || Boolean(insight.floorRaised);
  const tone =
    group === "due" || group === "today" ? "urgent" : group === "check" ? "check" : undefined;
  const settle = (action: "done" | "mute") =>
    !proactive.busy &&
    void proactive.respondInsight(insight, action).then(
      (ok) =>
        ok &&
        onNotice(
          message(action === "done" ? "proactive.doneNotice" : "proactive.mutedNotice", {
            text: title,
          }),
          () => void proactive.respondInsight(insight, "reopen"),
        ),
    );
  return (
    <div
      ref={ref}
      className="reminder-row proactive-row"
      data-tone={tone}
      data-highlight={highlighted || undefined}
      id={`reminder-${insight.id}`}
    >
      <span className="reminder-when" data-soon={tone === "urgent" || undefined}>
        {insightWhen(insight, group, message, locale)}
      </span>
      <span className="reminder-text">
        <span className="proactive-title">{title}</span>
        {why ? (
          <span className="proactive-why">
            {insight.basis === "daily_limit" ? (
              <span className="proactive-key">{message("proactive.dailyBasis")}</span>
            ) : insight.reason ? (
              <span className="proactive-key">{insight.reason}</span>
            ) : null}
            {insight.floorRaised ? (
              <span className="proactive-key">{message("proactive.floorRaised")}</span>
            ) : null}
          </span>
        ) : null}
        <span className="proactive-meta">
          <span className="proactive-source">
            <LineIcon name="mail" />
            {insight.from}
          </span>
          {insight.priority ? (
            <span className="proactive-priority" data-priority={insight.priority}>
              {message("proactive.priority", { p: insight.priority })}
            </span>
          ) : null}
          {insight.link ? (
            <a href={insight.link} target="_blank" rel="noopener noreferrer">
              {message("proactive.openMail")}
            </a>
          ) : null}
          {insight.status === "replied" ? <span>{message("proactive.replied")}</span> : null}
          {insight.pushed ? (
            <>
              <span>
                {message("proactive.pushed", { reaction: insight.pushReaction ?? "none" })}
              </span>
              <RatingChoices
                choices={["useful", "unneeded"]}
                current={insight.rating}
                disabled={proactive.busy}
                message={message}
                onRate={(rating) => void proactive.respondInsight(insight, "rate", rating)}
              />
            </>
          ) : null}
        </span>
      </span>
      <span className="actions">
        <ActionButton variant="primary" disabled={proactive.busy} onClick={() => settle("done")}>
          {message("proactive.done")}
        </ActionButton>
        <ActionMenu
          label={
            <>
              <Glyph name="more" size={18} />
              <span className="sr-only">{message("proactive.moreActions")}</span>
            </>
          }
          items={[
            ...(hasReason
              ? [
                  {
                    id: "why",
                    label: message(why ? "proactive.whyHide" : "proactive.why"),
                    onSelect: () => setWhy(!why),
                  },
                ]
              : []),
            {
              id: "mute",
              label: message("proactive.mute"),
              onSelect: () => settle("mute"),
            },
          ]}
        />
      </span>
    </div>
  );
}

export function useHighlight(focus: string | null): string | null {
  const [highlight, setHighlight] = useState(focus);
  useEffect(() => {
    setHighlight(focus);
    if (!focus) return;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [focus]);
  return highlight;
}

export function groupInsights(overview: ProactiveOverview | null | undefined, now: Date) {
  const groups = new Map<ProactiveGroup, ProactiveInsight[]>();
  if (!overview || overview.connection.status === "disconnected") return groups;
  const sorted = [...overview.insights].sort(
    (a, b) =>
      (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  for (const insight of sorted) {
    const group = proactiveGroup(insight, now);
    groups.set(group, [...(groups.get(group) ?? []), insight]);
  }
  return groups;
}

export function ProactiveBanners({
  proactive,
  message,
  locale,
}: {
  locale?: string | undefined;
  proactive: ProactiveModel;
  message: Message;
}) {
  const overview = proactive.overview;
  if (!overview) return null;
  if (overview.connection.status === "disconnected")
    return (
      <section className="proactive-connect">
        <h2>{message("proactive.connect.title")}</h2>
        <p>{message("proactive.connect.body")}</p>
        <ActionButton variant="primary" onClick={() => openSettings("tools")}>
          {message("proactive.connect.button")}
        </ActionButton>
      </section>
    );
  const since = overview.decisions.find(({ verdict }) => verdict === "needs_owner")?.checkedAt;
  return (
    <>
      {overview.connection.status === "needs_reconnect" ? (
        <div className="proactive-banner" data-tone="need" role="alert">
          <span>
            <strong>{message("proactive.reconnect.title")}</strong>
            <small>
              {message("proactive.reconnect.body", { time: since ? clock(since, locale) : "—" })}
            </small>
          </span>
          <ActionButton variant="primary" onClick={proactive.connect}>
            {message("proactive.reconnect.button")}
          </ActionButton>
        </div>
      ) : null}
      {overview.dailyLimitReached ? (
        <output className="proactive-banner" data-tone="need">
          <span>{message("proactive.dailyLimit")}</span>
        </output>
      ) : null}
      {!overview.enabled ? (
        <output className="proactive-banner">
          <span>
            {message("proactive.paused")}{" "}
            <button type="button" className="reminders-link" onClick={openNotificationSettings}>
              {message("push.openSettings")}
            </button>
          </span>
        </output>
      ) : null}
    </>
  );
}

const REVIEW_PAGE_SIZE = 6;

function reviewTag(item: ProactiveReviewItem): MessageId {
  return item.kind === "mail"
    ? "dailyReview.tag.mail"
    : item.kind === "proactive"
      ? item.outcome === "silent"
        ? "dailyReview.tag.silent"
        : "dailyReview.tag.pushed"
      : item.kind === "memory_candidate"
        ? item.outcome === "discarded"
          ? "dailyReview.tag.skippedMemory"
          : item.outcome === "kept"
            ? "dailyReview.tag.keptMemory"
            : item.outcome === "capture_retrying"
              ? "dailyReview.tag.captureRetrying"
              : item.outcome === "capture_queued"
                ? "dailyReview.tag.captureQueued"
                : item.outcome === "capture_gave_up"
                  ? "dailyReview.tag.captureGaveUp"
                  : "dailyReview.tag.pendingMemory"
        : item.kind === "consolidation"
          ? "dailyReview.tag.consolidation"
          : item.kind === "context_truncation"
            ? "dailyReview.tag.truncation"
            : item.kind === "retrieval_degrade"
              ? "dailyReview.tag.degrade"
              : item.kind === "rule_review"
                ? "dailyReview.tag.ruleReview"
                : "dailyReview.tag.externalRead";
}

function reviewText(item: ProactiveReviewItem, message: Message): string {
  if (item.text) return item.text;
  if (item.textHidden) return message("dailyReview.hidden");
  if (item.kind === "proactive" && item.fetched !== null)
    return message("dailyReview.fetched", { count: item.fetched });
  if (item.kind === "rule_review") return message("dailyReview.ruleReview");
  if (item.kind === "memory_candidate" && item.outcome === "capture_retrying")
    return message("dailyReview.captureRetrying");
  if (item.kind === "memory_candidate" && item.outcome === "capture_queued")
    return message("dailyReview.captureQueued");
  if (item.kind === "memory_candidate" && item.outcome === "capture_gave_up")
    return message("dailyReview.captureGaveUp");
  return "";
}

function ReviewRow({
  item,
  busy,
  message,
  locale,
  onRate,
}: {
  item: ProactiveReviewItem;
  busy: boolean;
  message: Message;
  locale: string | undefined;
  onRate: (rating: ProactiveRating | null) => void;
}) {
  const text = reviewText(item, message);
  return (
    <li>
      <span className="proactive-review-tag">{message(reviewTag(item))}</span>
      <span className="proactive-review-text">
        {text}
        <small>{dayAndClock(item.decidedAt, locale)}</small>
      </span>
      <RatingChoices
        choices={item.acted ? ["useful", "unneeded"] : ["useful", "missed"]}
        current={item.rating}
        disabled={busy}
        message={message}
        onRate={(rating) => {
          if (item.source === "mail" && rating === null && item.rating === "useful") return;
          onRate(rating);
        }}
      />
    </li>
  );
}

const CHECKUP_REASON: Readonly<Record<string, MessageId>> = {
  conflict: "dailyReview.checkup.reason.conflict",
  unused: "dailyReview.checkup.reason.unused",
  low_confidence: "dailyReview.checkup.reason.lowConfidence",
  source_unavailable: "dailyReview.checkup.reason.sourceUnavailable",
};
const CHECKUP_DONE: Readonly<Record<string, MessageId>> = {
  confirm: "dailyReview.checkup.done.confirm",
  delete: "dailyReview.checkup.done.delete",
  merge: "dailyReview.checkup.done.merge",
};

function CheckupRow({
  item,
  unusedDays,
  busy,
  message,
  onAct,
}: {
  item: ProactiveReviewItem;
  unusedDays: number;
  busy: boolean;
  message: Message;
  onAct: (action: ProactiveCheckupAction, keep?: string | null) => void;
}) {
  const checkup = item.checkup;
  if (!checkup) return null;
  const reason = CHECKUP_REASON[checkup.reason] ?? "dailyReview.checkup.reason.unused";
  const text = item.text || (item.textHidden ? message("dailyReview.hidden") : "");
  const pair = checkup.relatedMemoryId !== null;
  const related = checkup.relatedText || message("dailyReview.hidden");
  const done = checkup.action ? CHECKUP_DONE[checkup.action] : undefined;
  return (
    <li data-checkup={checkup.reason}>
      <span className="proactive-review-tag">{message(reason, { days: unusedDays })}</span>
      <span className="proactive-review-text proactive-checkup-text">
        {pair ? (
          <>
            <span>{message("dailyReview.checkup.newer", { text })}</span>
            <span>{message("dailyReview.checkup.older", { text: related })}</span>
          </>
        ) : (
          text
        )}
      </span>
      <span className="proactive-checkup-actions">
        {done ? (
          <>
            <span className="proactive-review-tag">{message(done)}</span>
            <ActionButton variant="quiet" disabled={busy} onClick={() => onAct("undo")}>
              {message("dailyReview.checkup.undo")}
            </ActionButton>
          </>
        ) : pair ? (
          <>
            <ActionButton variant="secondary" disabled={busy} onClick={() => onAct("confirm")}>
              {message("dailyReview.checkup.keepBoth")}
            </ActionButton>
            <ActionButton
              variant="secondary"
              disabled={busy}
              onClick={() => onAct("merge", checkup.memoryId)}
            >
              {message("dailyReview.checkup.replace")}
            </ActionButton>
            <ActionButton variant="quiet" disabled={busy} onClick={() => onAct("delete")}>
              {message("dailyReview.checkup.deleteNewer")}
            </ActionButton>
          </>
        ) : (
          <>
            <ActionButton variant="secondary" disabled={busy} onClick={() => onAct("confirm")}>
              {message("dailyReview.checkup.confirm")}
            </ActionButton>
            <ActionButton variant="quiet" disabled={busy} onClick={() => onAct("delete")}>
              {message("dailyReview.checkup.delete")}
            </ActionButton>
          </>
        )}
      </span>
    </li>
  );
}

export function ProactiveReviewSection({
  proactive,
  message,
  locale,
}: {
  proactive: ProactiveModel;
  message: Message;
  locale?: string | undefined;
}) {
  const review = proactive.review;
  const [folded, setFolded] = useState(false);
  const [page, setPage] = useState(0);
  const list = review ? (folded ? review.folded.items : review.items) : [];
  const pages = Math.max(1, Math.ceil(list.length / REVIEW_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = list.slice(current * REVIEW_PAGE_SIZE, (current + 1) * REVIEW_PAGE_SIZE);
  const rowsDone =
    rows.length > 0 &&
    rows.every((item) => (item.checkup ? item.checkup.action !== null : item.rating !== null));
  const wasDone = useRef({ page: -1, done: false });
  useEffect(() => {
    const finishedHere = rowsDone && wasDone.current.page === current && !wasDone.current.done;
    wasDone.current = { page: current, done: rowsDone };
    if (finishedHere && current < pages - 1) setPage(current + 1);
  }, [rowsDone, current, pages]);
  if (
    !review ||
    (review.items.length === 0 && review.folded.total === 0 && review.hiddenByModel === 0)
  )
    return null;
  const unrated = rows.filter(({ rating, checkup }) => checkup === null && rating === null);
  const rate = (ratings: readonly ProactiveReviewRating[]) =>
    !proactive.busy && void proactive.rateReview(ratings);
  return (
    <section className="proactive-review" aria-label={message("dailyReview.title")}>
      <div className="proactive-review-head">
        <h2>{message("dailyReview.title")}</h2>
        {folded ? null : (
          <span className="proactive-review-count">
            {message(review.notSampled > 0 ? "dailyReview.countLeft" : "dailyReview.count", {
              count: review.sampled,
              left: review.notSampled,
            })}
          </span>
        )}
      </div>
      {!folded && review.notSampled > 0 ? (
        <p className="settings-note">{message("dailyReview.note")}</p>
      ) : null}
      {!folded && review.hiddenByModel > 0 ? (
        <p className="settings-note proactive-review-hidden">
          {message("dailyReview.hiddenByModel", { count: review.hiddenByModel })}
        </p>
      ) : null}
      <ul className="proactive-review-list">
        {rows.map((item) =>
          item.checkup ? (
            <CheckupRow
              key={item.key}
              item={item}
              unusedDays={review.memoryUnusedDays}
              busy={proactive.busy}
              message={message}
              onAct={(action, keep) =>
                !proactive.busy && void proactive.actCheckup(item.key, action, keep ?? null)
              }
            />
          ) : (
            <ReviewRow
              key={item.key}
              item={item}
              busy={proactive.busy}
              message={message}
              locale={locale}
              onRate={(rating) => rate([{ key: item.key, rating }])}
            />
          ),
        )}
      </ul>
      <div className="proactive-review-foot">
        <ActionButton
          variant="secondary"
          disabled={proactive.busy || unrated.length === 0}
          onClick={() => rate(unrated.map(({ key }) => ({ key, rating: "useful" as const })))}
        >
          {message("dailyReview.allFine")}
        </ActionButton>
        {pages > 1 ? (
          <span className="proactive-review-pager">
            <button
              type="button"
              className="reminders-link"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              {message("dailyReview.prev")}
            </button>
            {message("dailyReview.page", { page: current + 1, pages })}
            <button
              type="button"
              className="reminders-link"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              {message("dailyReview.next")}
            </button>
          </span>
        ) : null}
      </div>
      {review.folded.total > 0 ? (
        <div className="proactive-review-fold">
          <span>{message("dailyReview.folded", { count: review.folded.total })}</span>
          <button
            type="button"
            className="reminders-link"
            aria-expanded={folded}
            onClick={() => {
              setFolded(!folded);
              setPage(0);
            }}
          >
            {message(folded ? "dailyReview.back" : "dailyReview.expand")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type LogTone = "need" | "warn" | "spoke" | "held" | "quiet";

const toneOf = (decision: ProactiveDecision): LogTone =>
  decision.verdict === "needs_owner"
    ? "need"
    : decision.verdict === "failed" ||
        decision.verdict === "capped" ||
        decision.verdict === "capped_daily"
      ? "warn"
      : decision.verdict === "pushed"
        ? "spoke"
        : decision.verdict === "deferred"
          ? "held"
          : "quiet";

function failureLine(reasonCode: string): MessageId {
  if (reasonCode === "MODEL_OUTPUT_INVALID") return "proactive.line.modelFailed";
  if (reasonCode === "MODEL_OUTPUT_TRUNCATED") return "proactive.line.modelCutOff";
  if (reasonCode === "MODEL_NOT_COMPLETED") return "proactive.line.modelUnfinished";
  if (reasonCode === "MODEL_CALL_ERROR" || reasonCode.startsWith("MODEL_FAILED_"))
    return "proactive.line.modelNoAnswer";
  return "proactive.line.readFailed";
}

function decisionLine(decision: ProactiveDecision, message: Message): string {
  const { counts, reasonCode } = decision;
  if (decision.verdict === "needs_owner") return message("proactive.line.needsOwner");
  if (decision.verdict === "pushed")
    return message("proactive.line.pushed", { count: Math.max(counts.pushed, 1) });
  if (decision.verdict === "deferred") return message("proactive.line.deferred");
  if (decision.verdict === "capped") return message("proactive.line.capped");
  if (decision.verdict === "capped_daily") return message("proactive.line.cappedDaily");
  if (decision.verdict === "failed") return message(failureLine(reasonCode));
  if (counts.fetched === 0) return message("proactive.line.noMail");
  if (counts.skipped === counts.fetched)
    return message("proactive.line.allSkipped", { count: counts.fetched });
  if (counts.floorRaised > 0)
    return message("proactive.line.floorRaised", {
      count: counts.fetched,
      raised: counts.floorRaised,
    });
  return message("proactive.line.quiet", { count: counts.fetched, skipped: counts.skipped });
}

const localDay = (value: string) => {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
};

export function ProactiveDecisionLog({
  proactive,
  message,
  locale,
  onOpenThread,
}: {
  locale?: string | undefined;
  proactive: ProactiveModel;
  message: Message;
  onOpenThread?: ((threadId: string, messageId?: string) => void) | undefined;
}) {
  const overview = proactive.overview;
  const [chainFor, setChainFor] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const readChain = proactive.readChain;
  const now = new Date();
  const today = localDay(now.toISOString());
  const dayLabel = (value: string) => {
    const at = localDay(value);
    return at === today
      ? message("proactive.log.today")
      : at === today - DAY_MS
        ? message("proactive.log.yesterday")
        : day(value, locale);
  };
  const decisions = overview?.decisions ?? [];
  const days = new Set(decisions.map(({ checkedAt }) => localDay(checkedAt))).size;
  let last = "";
  return (
    <section className="proactive-log" aria-label={message("proactive.log")}>
      {!overview ? (
        <div className="files-library-skeleton" aria-hidden="true">
          <i />
          <i />
        </div>
      ) : (
        <>
          <p className="proactive-summary">
            <span>{message("proactive.log.range", { days })}</span>
          </p>
          {cleared ? (
            <output className="decision-chain-note">{message("decision.chain.gone")}</output>
          ) : null}
          {decisions.length === 0 ? <EmptyState title={message("proactive.log.empty")} /> : null}
          {decisions.map((decision) => {
            const label = dayLabel(decision.checkedAt);
            const heading = label !== last ? <h2 className="memory-group">{label}</h2> : null;
            last = label;
            const tone = toneOf(decision);
            const judged = decision.counts.judged > 0 && decision.verdict !== "needs_owner";
            return (
              <div key={decision.id}>
                {heading}
                <div className="proactive-log-row" data-tone={tone}>
                  <span className="proactive-log-time">{clock(decision.checkedAt, locale)}</span>
                  <span className="proactive-log-dot" aria-hidden="true" />
                  <span className="proactive-log-body">
                    <span className="proactive-log-head">
                      <span className="proactive-verdict">
                        {message("proactive.verdict", { v: decision.verdict })}
                      </span>
                      {decisionLine(decision, message)}
                    </span>
                    {judged ? (
                      <small>
                        {message("proactive.line.judged", {
                          judged: decision.counts.judged,
                          act: decision.counts.act,
                          check: decision.counts.check,
                          know: decision.counts.know,
                        })}
                      </small>
                    ) : null}
                    {decision.opened ? <small>{message("proactive.line.opened")}</small> : null}
                    {decision.verdict === "pushed" || decision.verdict === "deferred" ? (
                      <RatingChoices
                        choices={["useful", "unneeded"]}
                        current={decision.rating}
                        disabled={proactive.busy}
                        message={message}
                        onRate={(rating) => void proactive.rateDecision(decision, rating)}
                      />
                    ) : decision.verdict === "silent" ? (
                      <RatingChoices
                        choices={["missed"]}
                        current={decision.rating}
                        disabled={proactive.busy}
                        message={message}
                        onRate={(rating) => void proactive.rateDecision(decision, rating)}
                      />
                    ) : null}
                    {readChain ? (
                      <button
                        type="button"
                        className="memory-link"
                        onClick={() => {
                          setCleared(false);
                          setChainFor(decision.id);
                        }}
                      >
                        {message("decision.chain.open")}
                      </button>
                    ) : null}
                    {decision.verdict === "needs_owner" &&
                    overview.connection.status === "needs_reconnect" ? (
                      <ActionButton variant="primary" onClick={proactive.connect}>
                        {message("proactive.reconnect.button")}
                      </ActionButton>
                    ) : null}
                  </span>
                </div>
              </div>
            );
          })}
        </>
      )}
      {chainFor && readChain ? (
        <DecisionChainDrawer
          decisionId={chainFor}
          readChain={readChain}
          message={message}
          onOpenThread={(threadId, messageId) => {
            setChainFor(null);
            onOpenThread?.(threadId, messageId);
          }}
          onGone={() => {
            setChainFor(null);
            setCleared(true);
          }}
          onClose={() => setChainFor(null)}
        />
      ) : null}
    </section>
  );
}
