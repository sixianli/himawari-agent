import { useEffect, useRef, useState } from "react";
import { DEFAULT_UI_LOCALE } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import {
  openSettings,
  type ProactiveDecision,
  type ProactiveGroup,
  type ProactiveInsight,
  type ProactiveModel,
  type ProactiveOverview,
  type ProactiveRating,
  proactiveGroup,
} from "../proactive.js";
import { LineIcon } from "./answer-footer.js";
import { openNotificationSettings } from "./memory-panel.js";
import { Glyph } from "./glyphs.js";
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

export function ProactiveAudit({
  proactive,
  message,
}: {
  proactive: ProactiveModel;
  message: Message;
}) {
  const [open, setOpen] = useState(false);
  const audit = proactive.overview?.audit;
  if (!audit?.active || audit.items.length === 0) return null;
  return (
    <section className="proactive-audit">
      <div className="proactive-audit-head">
        <span>{message("proactive.audit.title", { count: audit.items.length })}</span>
        <button
          type="button"
          className="reminders-link"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {message(open ? "proactive.audit.hide" : "proactive.audit.open")}
        </button>
      </div>
      {open ? (
        <>
          <p className="settings-note">{message("proactive.audit.note")}</p>
          <ul className="proactive-audit-list">
            {audit.items.map((item) => (
              <li key={item.messageId}>
                <span className="proactive-audit-from">{item.from}</span>
                <span className="proactive-audit-subject">
                  {item.link ? (
                    <a href={item.link} target="_blank" rel="noopener noreferrer">
                      {item.subject}
                    </a>
                  ) : (
                    item.subject
                  )}
                </span>
                <RatingChoices
                  choices={["missed"]}
                  current={item.rating}
                  disabled={proactive.busy}
                  message={message}
                  onRate={(rating) => void proactive.rateAudit(item.messageId, rating)}
                />
              </li>
            ))}
          </ul>
          {audit.pending === 0 ? (
            <p className="settings-note">{message("proactive.audit.doneOk")}</p>
          ) : (
            <ActionButton
              variant="secondary"
              disabled={proactive.busy}
              onClick={() =>
                void proactive.reviewAudit(audit.items.map(({ messageId }) => messageId))
              }
            >
              {message("proactive.audit.done")}
            </ActionButton>
          )}
        </>
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
}: {
  locale?: string | undefined;
  proactive: ProactiveModel;
  message: Message;
}) {
  const overview = proactive.overview;
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
            <span>
              {message("proactive.metric.spoke")} <b>{overview.metrics.spoke}</b>
            </span>
            <span>
              {message("proactive.metric.hits")} <b>{overview.metrics.hits}</b>
            </span>
            <span>
              {message("proactive.metric.misfires")}{" "}
              <b data-tone="warn">{overview.metrics.misfires}</b>
            </span>
            <span>
              {message("proactive.metric.missed")} <b data-tone="need">{overview.metrics.missed}</b>
              {" · "}
              {message("proactive.metric.reviewed", { count: overview.metrics.reviewed })}
            </span>
          </p>
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
    </section>
  );
}
