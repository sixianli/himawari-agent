import { useEffect, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import { type MuseItem, type MuseModel, museDelayParts } from "../muse.js";
import { dayAndClock, clock } from "./proactive-reminders.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

type Judgement = boolean | null;

function Judge({
  label,
  current,
  disabled,
  message,
  onChoose,
}: {
  label: string;
  current: Judgement;
  disabled: boolean;
  message: Message;
  onChoose: (value: boolean) => void;
}) {
  return (
    <fieldset className="muse-judge" aria-label={label}>
      <span className="muse-judge-label">{label}</span>
      {[true, false].map((value) => (
        <button
          key={String(value)}
          type="button"
          aria-pressed={current === value}
          disabled={disabled}
          onClick={() => onChoose(value)}
        >
          {message(value ? "muse.right" : "muse.wrong")}
        </button>
      ))}
    </fieldset>
  );
}

function MuseItemRow({
  item,
  muse,
  message,
  locale,
}: {
  item: MuseItem;
  muse: MuseModel;
  message: Message;
  locale: string | undefined;
}) {
  const [draft, setDraft] = useState<{ timing: Judgement; content: Judgement }>({
    timing: item.timingOk,
    content: item.contentOk,
  });
  useEffect(() => {
    setDraft({ timing: item.timingOk, content: item.contentOk });
  }, [item.timingOk, item.contentOk]);
  const rated = item.timingOk !== null && item.contentOk !== null;
  const choose = (side: "timing" | "content", value: boolean) => {
    const next = { ...draft, [side]: value };
    setDraft(next);
    if (next.timing !== null && next.content !== null)
      void muse.rate(item, next.timing, next.content);
  };
  return (
    <div className="muse-row" data-rated={rated || undefined}>
      <span className="muse-when">{dayAndClock(item.occurredAt, locale)}</span>
      <span className="muse-body">
        <span className="muse-meta">{message(`muse.kind.${item.kind}`)}</span>
        {item.withheld ? (
          <span className="muse-text" data-muted>
            {message("muse.withheld")}
          </span>
        ) : (
          <>
            {item.title ? <span className="muse-title">{item.title}</span> : null}
            <span className="muse-text" data-muted={item.text ? undefined : true}>
              {item.text ?? message("muse.noText")}
            </span>
          </>
        )}
        <span className="muse-judges">
          <Judge
            label={message("muse.timing")}
            current={draft.timing}
            disabled={muse.busy}
            message={message}
            onChoose={(value) => choose("timing", value)}
          />
          <Judge
            label={message("muse.content")}
            current={draft.content}
            disabled={muse.busy}
            message={message}
            onChoose={(value) => choose("content", value)}
          />
          {rated ? (
            <button
              type="button"
              className="reminders-link"
              disabled={muse.busy}
              onClick={() => void muse.rate(item, null, null)}
            >
              {message("muse.undo")}
            </button>
          ) : null}
        </span>
      </span>
    </div>
  );
}

export function MuseReference({
  muse,
  message,
  locale,
}: {
  muse: MuseModel;
  message: Message;
  locale: string | undefined;
}) {
  const overview = muse.overview;
  if (!overview)
    return muse.failed ? <p className="settings-note">{message("muse.failed")}</p> : null;
  const { channel } = overview;
  const lastBatch = channel.lastBatchAt ? `${clock(channel.lastBatchAt, locale)}` : "—";
  const delay = overview.delay;
  const parts = delay ? museDelayParts(delay.medianMinutes) : null;
  const statusLine =
    channel.state === "never"
      ? message("muse.channel.never")
      : channel.state === "paused"
        ? message("muse.channel.paused")
        : message(`muse.channel.${channel.state}`, { time: lastBatch });
  const hasSomething = overview.items.length > 0 || overview.suppressedWeek > 0;
  return (
    <section className="muse-reference" aria-label={message("muse.title")}>
      <h2 className="memory-group">{message("muse.title")}</h2>
      <p
        className="muse-status"
        data-state={channel.state}
        role={channel.state === "down" ? "alert" : undefined}
      >
        {statusLine}
      </p>
      {channel.state === "never" ? null : (
        <>
          {channel.gapCount > 0 ? (
            <p className="settings-note">
              {message("muse.channel.gaps", { count: channel.gapCount })}
            </p>
          ) : null}
          {hasSomething ? (
            <p className="proactive-summary muse-summary">
              <span>{message("muse.received", { count: overview.receivedWeek })}</span>
              <span>{message("muse.pending", { count: overview.pending })}</span>
              {overview.suppressedWeek > 0 ? (
                <span>{message("muse.suppressed", { count: overview.suppressedWeek })}</span>
              ) : null}
              {delay && parts ? (
                <span>
                  {message("muse.delay", {
                    duration: message(`muse.duration.${parts.unit}`, { value: parts.value }),
                    count: delay.samples,
                  })}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="settings-note">{message("muse.empty")}</p>
          )}
          <p className="settings-note">{message("muse.note")}</p>
          {overview.items.map((item) => (
            <MuseItemRow
              key={`${item.kind}:${item.naturalKey}`}
              item={item}
              muse={muse}
              message={message}
              locale={locale}
            />
          ))}
        </>
      )}
    </section>
  );
}

export function MuseDataSettings({ muse, message }: { muse: MuseModel; message: Message }) {
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const paused = muse.overview?.channel.state === "paused";
  return (
    <div className="proactive-data muse-data">
      <div className="setting-row">
        <span>
          {message("muse.settings.title")}
          <small className="setting-description">{message("muse.settings.hint")}</small>
        </span>
        <ActionButton
          variant="secondary"
          disabled={muse.busy || !muse.overview}
          aria-pressed={paused}
          onClick={() => void muse.setPaused(!paused)}
        >
          {message(paused ? "muse.settings.resume" : "muse.settings.pause")}
        </ActionButton>
      </div>
      <div className="setting-row">
        <span>
          {message("muse.settings.clear")}
          <small className="setting-description">{message("muse.settings.clearHint")}</small>
        </span>
        {confirming ? null : (
          <ActionButton
            variant="secondary"
            className="proactive-danger"
            onClick={() => setConfirming(true)}
          >
            {message("muse.settings.clear")}
          </ActionButton>
        )}
      </div>
      {confirming ? (
        <div className="proactive-confirm" role="alert">
          <span>{message("muse.settings.clearConfirm")}</span>
          <span className="actions">
            <ActionButton
              variant="danger"
              disabled={muse.busy}
              onClick={() =>
                void muse.clearAll().then((ok) => {
                  setConfirming(false);
                  setCleared(ok);
                })
              }
            >
              {message("muse.settings.clear")}
            </ActionButton>
            <ActionButton variant="quiet" onClick={() => setConfirming(false)}>
              {message("governed.cancel")}
            </ActionButton>
          </span>
        </div>
      ) : null}
      {cleared ? (
        <output className="settings-note">{message("muse.settings.cleared")}</output>
      ) : null}
    </div>
  );
}
