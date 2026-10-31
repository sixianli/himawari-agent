import { useEffect, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import {
  type GmailOutcome,
  type ProactiveModel,
  type ProactiveQuietPeriod,
  type ProactiveSettings,
  proactiveSettings,
} from "../proactive.js";
import { LineIcon } from "./answer-footer.js";
import { Glyph } from "./glyphs.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const SENDER = /^@?[^\s@]*@?[a-z0-9.-]+\.[a-z]{2,}$/i;
const NEW_PERIOD: ProactiveQuietPeriod = {
  days: [0, 1, 2, 3, 4, 5, 6],
  start: "23:00",
  end: "07:00",
};
const MAXIMUM_PERIODS = 8;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const problemOf = (period: ProactiveQuietPeriod) =>
  !CLOCK.test(period.start) || !CLOCK.test(period.end)
    ? ("badTime" as const)
    : period.start === period.end
      ? ("sameTime" as const)
      : period.days.length === 0
        ? ("noDays" as const)
        : null;

const weekdayName = (day: number, locale: string | undefined) =>
  new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 10, 1 + day)),
  );

export function ProactiveNotificationSettings({
  proactive,
  locale,
  message,
}: {
  proactive: ProactiveModel;
  locale: string;
  message: Message;
}) {
  const overview = proactive.overview;
  const [periods, setPeriods] = useState<readonly ProactiveQuietPeriod[]>([]);
  useEffect(() => {
    if (overview) setPeriods(overview.quietHours);
  }, [overview]);
  if (!overview) return null;
  const save = (next: Partial<ProactiveSettings>) =>
    void proactive.saveSettings({ ...proactiveSettings(overview), ...next });
  const commit = (next: readonly ProactiveQuietPeriod[]) => {
    setPeriods(next);
    if (next.every((period) => problemOf(period) === null)) save({ quietHours: next });
  };
  const change = (index: number, value: Partial<ProactiveQuietPeriod>) =>
    periods.map((period, at) => (at === index ? { ...period, ...value } : period));
  const update = (index: number, value: Partial<ProactiveQuietPeriod>) =>
    commit(change(index, value));
  return (
    <section className="proactive-settings">
      <label className="setting-row">
        <span>{message("proactive.settings.enabled")}</span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={overview.enabled}
          aria-label={message("proactive.settings.enabled")}
          checked={overview.enabled}
          disabled={proactive.busy}
          onChange={() => save({ enabled: !overview.enabled })}
        />
      </label>
      <div className="setting-row proactive-quiet-head">
        <span>{message("proactive.settings.quiet")}</span>
      </div>
      {periods.map((period, index) => {
        const label = message("proactive.settings.period", { n: index + 1 });
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: periods have no identity of their own
          <div className="proactive-period" key={index}>
            <span className="proactive-period-hours">
              <b>{label}</b>
              <input
                type="text"
                inputMode="numeric"
                maxLength={5}
                placeholder="23:00"
                aria-label={message("proactive.settings.periodStart", { n: index + 1 })}
                value={period.start}
                onChange={(event) =>
                  setPeriods(change(index, { start: event.target.value.trim() }))
                }
                onBlur={() => commit(periods)}
                onKeyDown={(event) => event.key === "Enter" && commit(periods)}
              />
              {message("proactive.settings.to")}
              <input
                type="text"
                inputMode="numeric"
                maxLength={5}
                placeholder="23:00"
                aria-label={message("proactive.settings.periodEnd", { n: index + 1 })}
                value={period.end}
                onChange={(event) => setPeriods(change(index, { end: event.target.value.trim() }))}
                onBlur={() => commit(periods)}
                onKeyDown={(event) => event.key === "Enter" && commit(periods)}
              />
            </span>
            <span className="proactive-days">
              {WEEK_ORDER.map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={period.days.includes(day)}
                  aria-label={new Intl.DateTimeFormat(locale, {
                    weekday: "long",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(2026, 10, 1 + day)))}
                  disabled={proactive.busy}
                  onClick={() =>
                    update(index, {
                      days: period.days.includes(day)
                        ? period.days.filter((value) => value !== day)
                        : [...period.days, day].sort(),
                    })
                  }
                >
                  {weekdayName(day, locale)}
                </button>
              ))}
              <ActionButton
                variant="quiet"
                disabled={proactive.busy}
                aria-label={message("proactive.settings.removePeriod", { n: index + 1 })}
                onClick={() => commit(periods.filter((_, at) => at !== index))}
              >
                <LineIcon name="close" />
              </ActionButton>
            </span>
            {problemOf(period) ? (
              <small className="proactive-error">
                {message(`proactive.settings.${problemOf(period) ?? "badTime"}`)}
              </small>
            ) : null}
          </div>
        );
      })}
      {periods.length < MAXIMUM_PERIODS ? (
        <ActionButton
          variant="secondary"
          disabled={proactive.busy}
          onClick={() => commit([...periods, NEW_PERIOD])}
        >
          {message("proactive.settings.addPeriod")}
        </ActionButton>
      ) : null}
    </section>
  );
}

function ImportantSenders({ proactive, message }: { proactive: ProactiveModel; message: Message }) {
  const overview = proactive.overview;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!overview) return null;
  const entries = draft
    .split(/[\s,，、]+/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = entries.filter((value) => !SENDER.test(value));
  return (
    <div className="proactive-senders">
      <div className="setting-row">
        <span>{message("proactive.apps.senders")}</span>
        <span className="actions">
          <span className="setting-description">
            {message("proactive.apps.sendersCount", { count: overview.importantSenders.length })}
          </span>
          {editing ? null : (
            <ActionButton
              variant="secondary"
              onClick={() => {
                setDraft(overview.importantSenders.join("\n"));
                setEditing(true);
              }}
            >
              {message("proactive.apps.manage")}
            </ActionButton>
          )}
        </span>
      </div>
      {editing ? (
        <div className="proactive-senders-editor">
          <textarea
            aria-label={message("proactive.apps.senders")}
            rows={6}
            value={draft}
            placeholder={message("proactive.apps.sendersPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
          {invalid.length ? (
            <small className="proactive-error">
              {message("proactive.apps.sendersInvalid", { value: invalid[0] ?? "" })}
            </small>
          ) : null}
          <span className="actions">
            <ActionButton
              variant="primary"
              disabled={proactive.busy || invalid.length > 0 || entries.length > 200}
              onClick={() =>
                void proactive
                  .saveSettings({
                    ...proactiveSettings(overview),
                    importantSenders: [...new Set(entries)],
                  })
                  .then((ok) => ok && setEditing(false))
              }
            >
              {message("proactive.apps.save")}
            </ActionButton>
            <ActionButton variant="quiet" onClick={() => setEditing(false)}>
              {message("governed.cancel")}
            </ActionButton>
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function ProactiveAppsSettings({
  proactive,
  message,
  outcome,
}: {
  proactive: ProactiveModel;
  message: Message;
  outcome: GmailOutcome | null;
}) {
  const overview = proactive.overview;
  const [confirming, setConfirming] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  if (!overview) return null;
  const status = overview.connection.status;
  return (
    <section className="proactive-apps">
      <h4>{message("proactive.apps.title")}</h4>
      {outcome ? (
        <output
          className="proactive-outcome"
          data-tone={outcome === "connected" ? undefined : "warn"}
        >
          {message("proactive.apps.outcome", { o: outcome })}
        </output>
      ) : null}
      {disconnected ? (
        <output className="proactive-outcome">{message("proactive.apps.disconnected")}</output>
      ) : null}
      <div className="setting-row proactive-app">
        <span className="proactive-app-icon" aria-hidden="true">
          <LineIcon name="mail" />
        </span>
        <span className="proactive-app-name">
          {message("proactive.apps.gmail")}
          <small
            className="setting-description"
            data-tone={status === "needs_reconnect" ? "need" : undefined}
          >
            {status === "connected"
              ? message("proactive.apps.connectedAs", {
                  account: overview.connection.account ?? "—",
                })
              : status === "needs_reconnect"
                ? message("proactive.apps.needsReconnect")
                : message("proactive.apps.notConnected")}
          </small>
        </span>
        {status === "disconnected" ? (
          <ActionButton variant="primary" onClick={proactive.connect}>
            {message("proactive.connect.button")}
          </ActionButton>
        ) : confirming ? null : (
          <span className="actions">
            {status === "needs_reconnect" ? (
              <ActionButton variant="primary" onClick={proactive.connect}>
                {message("proactive.reconnect.button")}
              </ActionButton>
            ) : null}
            <ActionButton variant="secondary" onClick={() => setConfirming(true)}>
              {message("proactive.apps.disconnect")}
            </ActionButton>
          </span>
        )}
      </div>
      {confirming ? (
        <div className="proactive-confirm" role="alert">
          <span>{message("proactive.apps.disconnectConfirm")}</span>
          <span className="actions">
            <ActionButton
              variant="danger"
              disabled={proactive.busy}
              onClick={() =>
                void proactive.disconnect().then((ok) => {
                  setConfirming(false);
                  setDisconnected(ok);
                })
              }
            >
              {message("proactive.apps.disconnect")}
            </ActionButton>
            <ActionButton variant="quiet" onClick={() => setConfirming(false)}>
              {message("governed.cancel")}
            </ActionButton>
          </span>
        </div>
      ) : null}
      <details className="proactive-what">
        <summary>
          <Glyph className="summary-chevron" name="chevron" size={14} />
          {message("proactive.apps.what")}
        </summary>
        <ul>
          <li>{message("proactive.apps.what1")}</li>
          <li>{message("proactive.apps.what2")}</li>
          <li>{message("proactive.apps.what3")}</li>
          <li>{message("proactive.apps.what4")}</li>
          <li>{message("proactive.apps.what5")}</li>
        </ul>
      </details>
      <ImportantSenders proactive={proactive} message={message} />
    </section>
  );
}

export function ProactiveDataSettings({
  proactive,
  message,
}: {
  proactive: ProactiveModel;
  message: Message;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  return (
    <div className="proactive-data">
      <div className="setting-row">
        <span>
          {message("proactive.data.title")}
          <small className="setting-description">{message("proactive.data.hint")}</small>
        </span>
        {confirming ? null : (
          <ActionButton
            variant="secondary"
            className="proactive-danger"
            onClick={() => setConfirming(true)}
          >
            {message("proactive.data.delete")}
          </ActionButton>
        )}
      </div>
      {confirming ? (
        <div className="proactive-confirm" role="alert">
          <span>{message("proactive.data.confirm")}</span>
          <span className="actions">
            <ActionButton
              variant="danger"
              disabled={proactive.busy}
              onClick={() =>
                void proactive.clearRecords().then((ok) => {
                  setConfirming(false);
                  setCleared(ok);
                })
              }
            >
              {message("proactive.data.delete")}
            </ActionButton>
            <ActionButton variant="quiet" onClick={() => setConfirming(false)}>
              {message("governed.cancel")}
            </ActionButton>
          </span>
        </div>
      ) : null}
      {cleared ? (
        <output className="settings-note">{message("proactive.data.cleared")}</output>
      ) : null}
    </div>
  );
}
