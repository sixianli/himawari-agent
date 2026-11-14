import { useState } from "react";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import {
  type SensitiveInterceptionItem,
  type SensitiveInterceptionsModel,
  sensitiveInterceptionTotal,
} from "../sensitive-interceptions.js";
import { Glyph } from "./glyphs.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;
type Filter = "all" | "masked" | "withheld" | "notSaved";

const OUTCOME_FILTER: Readonly<Record<SensitiveInterceptionItem["outcome"], Filter>> = {
  masked: "masked",
  withheld: "withheld",
  not_saved: "notSaved",
};

function localDay(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function SensitiveInterceptionsEntry({
  model,
  message,
  onOpen,
}: {
  model: SensitiveInterceptionsModel;
  message: Message;
  onOpen: () => void;
}) {
  const total = model.counts ? sensitiveInterceptionTotal(model.counts) : null;
  return (
    <div className="setting-row sensitive-entry">
      <span>
        {message("sensitive.title")}
        {total === null ? null : (
          <small className="setting-description">
            {total === 0 ? message("sensitive.none") : message("sensitive.count", { count: total })}
          </small>
        )}
      </span>
      <ActionButton variant="secondary" onClick={onOpen}>
        {message("sensitive.open")}
      </ActionButton>
    </div>
  );
}

export function SensitiveInterceptionsPage({
  model,
  message,
  threadTitle,
  onBack,
  onOpenThread,
}: {
  model: SensitiveInterceptionsModel;
  message: Message;
  threadTitle: (threadId: string) => string | undefined;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const format = useLocaleFormat();
  const [filter, setFilter] = useState<Filter>("all");
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const counts = model.counts;
  const total = counts ? sensitiveInterceptionTotal(counts) : 0;
  const filters: readonly { readonly id: Filter; readonly count: number }[] = counts
    ? [
        { id: "all", count: total },
        { id: "masked", count: counts.masked },
        ...(counts.withheld > 0 ? [{ id: "withheld" as const, count: counts.withheld }] : []),
        { id: "notSaved", count: counts.notSaved },
      ]
    : [];
  const shown = model.items.filter(
    (item) => filter === "all" || OUTCOME_FILTER[item.outcome] === filter,
  );
  const now = new Date();
  const today = localDay(now.toISOString());
  const yesterday = localDay(new Date(now.getTime() - 86_400_000).toISOString());
  const dayLabel = (value: string) => {
    const day = localDay(value);
    if (day === today) return message("sensitive.today");
    if (day === yesterday) return message("sensitive.yesterday");
    return format.dayHeading(value);
  };
  const groups: { day: string; label: string; items: SensitiveInterceptionItem[] }[] = [];
  for (const item of shown) {
    const day = localDay(item.firstSeenAt);
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, label: dayLabel(item.firstSeenAt), items: [item] });
  }
  const where = (item: SensitiveInterceptionItem) => {
    const purpose =
      item.purpose === null || (item.purpose === "chat" && item.threadId !== null)
        ? null
        : message(
            (MESSAGE_PURPOSES.has(item.purpose)
              ? `sensitive.purpose.${item.purpose}`
              : "sensitive.purpose.other") as MessageId,
          );
    const part =
      item.source !== "chat" && item.part === "owner_message"
        ? null
        : message(`sensitive.part.${item.part}` as MessageId);
    const title = item.threadId === null ? undefined : threadTitle(item.threadId);
    const origin =
      item.threadId === null
        ? message("sensitive.background")
        : title
          ? message("sensitive.thread", { title })
          : message("sensitive.threadUntitled");
    return [...new Set([origin, purpose, part])].filter((value) => value !== null).join(" · ");
  };
  const what = (item: SensitiveInterceptionItem) => {
    const time = format.clockShort(item.firstSeenAt);
    if (item.outcome === "not_saved") return message("sensitive.notSaved", { time });
    if (item.outcome === "withheld") return message("sensitive.withheld", { time });
    return item.seenCount <= 1
      ? message("sensitive.maskedOnce", { time })
      : message("sensitive.maskedMany", { time, later: item.seenCount - 1 });
  };
  return (
    <div className="sensitive-page">
      <ActionButton variant="quiet" className="sensitive-back" onClick={onBack}>
        <Glyph name="chevron" size={14} className="sensitive-back-icon" />
        {message("review.settings.data")}
      </ActionButton>
      <div className="sensitive-heading">
        <h3>{message("sensitive.title")}</h3>
        <span>{message("sensitive.hint")}</span>
      </div>
      {model.failed ? (
        <output className="settings-note sensitive-failed">{message("sensitive.failed")}</output>
      ) : null}
      {counts && total > 0 ? (
        <fieldset className="sensitive-filter" aria-label={message("sensitive.title")}>
          {filters.map(({ id, count }) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {message(`sensitive.filter.${id}` as MessageId, { count })}
            </button>
          ))}
        </fieldset>
      ) : null}
      {counts && total === 0 ? (
        <p className="sensitive-empty">{message("sensitive.none")}</p>
      ) : null}
      {groups.map((group) => (
        <section key={group.day} className="sensitive-day">
          <h4>{group.label}</h4>
          <ul>
            {group.items.map((item) => (
              <li key={item.id} className="sensitive-item">
                <span className="sensitive-chip">
                  {message(`sensitive.category.${item.category}` as MessageId)}
                </span>
                <span className="sensitive-body">
                  <span className="sensitive-where">{where(item)}</span>
                  <span
                    className="sensitive-what"
                    data-tone={item.outcome === "not_saved" ? "warning" : undefined}
                  >
                    {what(item)}
                  </span>
                </span>
                {item.threadId !== null ? (
                  <ActionButton
                    variant="quiet"
                    className="sensitive-go"
                    onClick={() => onOpenThread(item.threadId as string)}
                  >
                    {message("sensitive.openThread")}
                  </ActionButton>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {model.hasMore ? (
        <ActionButton
          variant="secondary"
          className="sensitive-more"
          disabled={model.busy}
          onClick={() => void model.loadMore()}
        >
          {message("sensitive.more")}
        </ActionButton>
      ) : null}
      {counts && total > 0 ? (
        <div className="sensitive-foot">
          <span>{message("sensitive.footer")}</span>
          {confirming ? null : (
            <ActionButton
              variant="secondary"
              className="proactive-danger"
              onClick={() => {
                setCleared(false);
                setConfirming(true);
              }}
            >
              {message("sensitive.clear")}
            </ActionButton>
          )}
        </div>
      ) : null}
      {confirming ? (
        <div className="proactive-confirm" role="alert">
          <span>{message("sensitive.clearConfirm")}</span>
          <span className="actions">
            <ActionButton
              variant="danger"
              disabled={model.busy}
              onClick={() =>
                void model.clear().then((ok) => {
                  setConfirming(false);
                  setCleared(ok);
                  setFilter("all");
                })
              }
            >
              {message("sensitive.clearButton")}
            </ActionButton>
            <ActionButton variant="quiet" onClick={() => setConfirming(false)}>
              {message("governed.cancel")}
            </ActionButton>
          </span>
        </div>
      ) : null}
      {cleared ? <output className="settings-note">{message("sensitive.cleared")}</output> : null}
    </div>
  );
}

const MESSAGE_PURPOSES: ReadonlySet<string> = new Set([
  "chat",
  "thread-title",
  "memory-capture",
  "memory-episode",
  "memory-consolidation",
  "mail-judgment",
  "action-review",
  "review-prereview",
  "home-urgency",
  "rule-review",
  "other",
]);
