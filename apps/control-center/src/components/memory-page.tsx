import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryItem, MemoryModel, MemoryOverview } from "../memory.js";
import {
  guessCategory,
  type ImportCandidate,
  type ImportParse,
  parseMemoryExport,
  parseMemoryText,
} from "../memory-import.js";
import type { ProactiveGroup, ProactiveModel } from "../proactive.js";
import { LineIcon } from "./answer-footer.js";
import { MemoryApprovalCard, openNotificationSettings, TextEditor } from "./memory-panel.js";
import { ActionButton } from "./primitives.js";
import {
  clock,
  dayAndClock,
  groupInsights,
  ProactiveAudit,
  ProactiveBanners,
  ProactiveDecisionLog,
  ProactiveInsightRow,
  useHighlight,
} from "./proactive-reminders.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;
type Tab = "pending" | "profile" | "all" | "timeline";
type Notice = { readonly text: string; readonly undo?: () => void } | null;
type Person = MemoryOverview["people"][number];

const DAY_MS = 86_400_000;
const VISIBLE_CHIPS = 5;
const PROFILE_PREVIEW = 3;
const PROFILE_EXPANDED = 8;
const HISTORY_HEAD = 2;
const HISTORY_STEP = 10;
const NOTICE_MS = 6000;
const MAXIMUM_IMPORT_BYTES = 200 * 1024;
const MAXIMUM_IMPORT_ITEMS = 500;
const GRAPH = { x: 190, y: 150, r: 112 };

const reveal = (element: HTMLElement | null) => element?.scrollIntoView?.({ block: "nearest" });
const live = (item: MemoryItem) => !item.supersededBy && !item.tentative;
const date = (value: string) => new Date(value).toLocaleDateString();
const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    ...(new Date(value).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function Chips<T extends string>({
  label,
  items,
  value,
  onPick,
  message,
}: {
  label?: string;
  items: readonly { key: T; label: string; count: number; hint?: string }[];
  value: T;
  onPick: (key: T) => void;
  message: Message;
}) {
  const [more, setMore] = useState(false);
  const hidden = items.length - VISIBLE_CHIPS - 1;
  const shown = more || hidden <= 0 ? items : items.slice(0, VISIBLE_CHIPS + 1);
  const chosen = items.find((item) => item.key === value);
  return (
    <div className="memory-chips">
      {label ? <span>{label}</span> : null}
      {[...shown, ...(chosen && !shown.includes(chosen) ? [chosen] : [])].map((item) => (
        <button
          type="button"
          key={item.key}
          title={item.hint}
          aria-pressed={item.key === value}
          onClick={() => onPick(item.key)}
        >
          {item.label} <small>{item.count}</small>
        </button>
      ))}
      {hidden > 0 ? (
        <button type="button" className="memory-more" onClick={() => setMore(!more)}>
          {more ? message("memory.page.less") : message("memory.page.moreCats", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
}

function MemoryHistory({
  item,
  history,
  older,
  onMore,
  memory,
  message,
}: {
  item: MemoryItem;
  history: readonly MemoryItem[];
  older: number;
  onMore: () => void;
  memory: MemoryModel;
  message: Message;
}) {
  const past = [...history].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const hidden = past.length - HISTORY_HEAD - older;
  const folded = hidden > 1 ? hidden : 0;
  const head = folded ? past.slice(0, HISTORY_HEAD - 1 + older) : past;
  const tail = folded ? past.slice(-1) : [];
  const point = (entry: MemoryItem, current: boolean) => (
    <li key={entry.memoryId} data-current={current || undefined}>
      <span className="memory-history-dot" aria-hidden="true" />
      <div>
        <small>
          {time(entry.recordedAt)} · {message(current ? "memory.page.now" : "memory.page.replaced")}
        </small>
        <p>{entry.text}</p>
        {current ? null : (
          <button
            type="button"
            className="memory-link"
            disabled={memory.busy}
            onClick={() => void memory.restore(entry)}
          >
            {message("memory.page.useThis")}
          </button>
        )}
      </div>
    </li>
  );
  return (
    <ol className="memory-history-line" data-scroll={older > 0 || undefined}>
      {point(item, true)}
      {head.map((entry) => point(entry, false))}
      {folded ? (
        <li className="memory-history-fold">
          <button type="button" onClick={onMore}>
            {message("memory.page.olderChanges", { count: folded })}
          </button>
        </li>
      ) : null}
      {tail.map((entry) => point(entry, false))}
    </ol>
  );
}

function MemoryRow({
  item,
  history,
  reminder,
  justSaved,
  memory,
  message,
  notify,
  onOpenThread,
}: {
  item: MemoryItem;
  history: readonly MemoryItem[];
  reminder: string | null;
  justSaved: boolean;
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [older, setOlder] = useState(0);
  const sensitive = item.dataClassification === "sensitive" || item.topic;
  const origin = item.importBatchId
    ? "import"
    : item.memoryId.startsWith("memory:owner:")
      ? "owner"
      : item.sourceThreadId
        ? null
        : "tidy";
  if (editing)
    return (
      <li className="memory-row">
        <TextEditor
          initial={item.text}
          busy={memory.busy}
          message={message}
          onCancel={() => setEditing(false)}
          onSave={(text) => void memory.correct(item, text).then((ok) => ok && setEditing(false))}
        />
        <small className="settings-note">{message("memory.page.editNote")}</small>
      </li>
    );
  return (
    <li className="memory-row" data-status={item.status} data-just-saved={justSaved || undefined}>
      <button
        type="button"
        className="memory-row-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="memory-text">{item.text}</span>
        <span className="memory-tags">
          {justSaved ? (
            <span className="memory-tag" data-kind="new">
              {message("memory.justSaved")}
            </span>
          ) : null}
          <span className="memory-tag">
            {message("memory.cat", { c: item.category })}
            {item.subCategory ? ` · ${item.subCategory}` : ""}
          </span>
          {sensitive ? (
            <span className="memory-tag" data-kind="sensitive">
              {message("memory.sensitive")}
              {item.topic ? ` · ${message(`memory.topic.${item.topic}`)}` : ""}
            </span>
          ) : null}
          {item.inference ? (
            <span className="memory-tag" data-kind="inferred">
              {message("memory.inferred")}
            </span>
          ) : null}
          {reminder ? <span className="memory-tag">{message("memory.page.reminder")}</span> : null}
          {history.length ? (
            <span className="memory-tag">
              {message("memory.page.changed", { count: history.length })}
            </span>
          ) : null}
          <small>{date(item.recordedAt)}</small>
        </span>
      </button>
      {open ? (
        <dl className="memory-detail">
          <dt>{message("memory.page.source")}</dt>
          <dd>
            {origin ? (
              message("memory.page.origin", { o: origin })
            ) : (
              <button
                type="button"
                className="memory-link"
                onClick={() => item.sourceThreadId && onOpenThread(item.sourceThreadId)}
              >
                {message("memory.source")}
              </button>
            )}
            {` · ${time(item.recordedAt)}`}
          </dd>
          <dt>{message("memory.page.used")}</dt>
          <dd>{item.lastUsedAt ? time(item.lastUsedAt) : message("memory.page.notUsed")}</dd>
          {reminder ? (
            <>
              <dt>{message("memory.page.reminder")}</dt>
              <dd>{reminder}</dd>
            </>
          ) : null}
          {history.length ? (
            <>
              <dt>{message("memory.page.history")}</dt>
              <dd>
                <MemoryHistory
                  item={item}
                  history={history}
                  older={older}
                  onMore={() => setOlder(older + HISTORY_STEP)}
                  memory={memory}
                  message={message}
                />
              </dd>
            </>
          ) : null}
          <dd className="actions memory-detail-actions">
            {item.status === "trashed" ? (
              <>
                <small>{message("memory.page.trashNote")}</small>
                <ActionButton disabled={memory.busy} onClick={() => void memory.recover(item)}>
                  {message("memory.page.recover")}
                </ActionButton>
              </>
            ) : (
              <>
                {item.status === "archived" ? (
                  <>
                    <small>{message("memory.page.archivedNote")}</small>
                    <ActionButton disabled={memory.busy} onClick={() => void memory.recover(item)}>
                      {message("memory.page.unarchive")}
                    </ActionButton>
                  </>
                ) : (
                  <ActionButton variant="secondary" onClick={() => setEditing(true)}>
                    {message("memory.editAction")}
                  </ActionButton>
                )}
                <ActionButton
                  variant="danger"
                  disabled={memory.busy}
                  onClick={() =>
                    void memory.remove(item).then(
                      (ok) =>
                        ok &&
                        notify({
                          text: message("memory.page.deleted"),
                          undo: () => void memory.recover({ ...item, revision: item.revision + 1 }),
                        }),
                    )
                  }
                >
                  {message("memory.deleteAction")}
                </ActionButton>
              </>
            )}
          </dd>
        </dl>
      ) : null}
    </li>
  );
}

function PendingTab({ memory, message }: { memory: MemoryModel; message: Message }) {
  const overview = memory.overview;
  if (!overview) return null;
  const people = new Map(overview.people.map((person) => [person.personId, person.name]));
  return (
    <>
      <p className="settings-note">{message("memory.page.pendingNote")}</p>
      {overview.pending.map((item) => (
        <MemoryApprovalCard key={item.requestId} item={item} memory={memory} message={message} />
      ))}
      {overview.memories
        .filter((item) => item.tentative && !item.supersededBy && item.status === "active")
        .map((item) => (
          <section className="memory-card" key={item.memoryId}>
            <span className="memory-tag" data-kind="inferred">
              {message("memory.page.kind", { k: item.category === "rule" ? "rule" : "inferred" })}
            </span>
            <small>
              {" "}
              {message("memory.page.reason", { k: item.category === "rule" ? "rule" : "inferred" })}
            </small>
            <p className="memory-text">{item.text}</p>
            <div className="actions">
              <ActionButton disabled={memory.busy} onClick={() => void memory.confirm(item)}>
                {message("memory.approve")}
              </ActionButton>
              <ActionButton
                variant="quiet"
                disabled={memory.busy}
                onClick={() => void memory.remove(item)}
              >
                {message("memory.reject")}
              </ActionButton>
            </div>
          </section>
        ))}
      {overview.personSuggestions.map((suggestion) => (
        <section className="memory-card" key={suggestion.suggestionId}>
          <span className="memory-tag" data-kind="inferred">
            {message("memory.page.kind", { k: "person" })}
          </span>
          <small> {message("memory.page.reason", { k: "person" })}</small>
          <p className="memory-text">
            {message("memory.page.samePerson", {
              a: people.get(suggestion.candidateId) ?? "",
              b: people.get(suggestion.personId) ?? "",
            })}
          </p>
          <div className="actions">
            {[true, false].map((merge) => (
              <ActionButton
                key={String(merge)}
                variant={merge ? "primary" : "quiet"}
                disabled={memory.busy}
                onClick={() => void memory.respondPerson(suggestion.suggestionId, merge)}
              >
                {message("memory.page.same", { merge: String(merge) })}
              </ActionButton>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function RemindersPage({
  memory,
  proactive = null,
  focus = null,
  locale,
  message,
  onBack,
  onOpenThread,
}: {
  memory: MemoryModel | null;
  proactive?: ProactiveModel | null;
  focus?: string | null;
  locale?: string | undefined;
  message: Message;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const [view, setView] = useState<"list" | "log">("list");
  const highlight = useHighlight(focus);
  useEffect(() => {
    if (focus) setView("list");
  }, [focus]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const overview = memory?.overview;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const groupOf = (at: string) => {
    const value = Date.parse(at);
    return value < today + DAY_MS ? "today" : value < today + 7 * DAY_MS ? "week" : "later";
  };
  const groups = new Map<string, NonNullable<typeof overview>["upcoming"][number][]>();
  for (const item of [...(overview?.upcoming ?? [])].sort((a, b) => a.dueAt.localeCompare(b.dueAt)))
    groups.set(groupOf(item.dueAt), [...(groups.get(groupOf(item.dueAt)) ?? []), item]);
  const mail = groupInsights(proactive?.overview, now);
  const meta = (yearly: boolean, threadId: string | null) =>
    yearly || threadId ? (
      <small>
        {yearly ? message("memory.page.yearly") : null}
        {yearly && threadId ? " · " : null}
        {threadId ? (
          <button
            type="button"
            className="memory-link reminder-source"
            onClick={() => onOpenThread(threadId)}
          >
            {message("memory.source")}
          </button>
        ) : null}
      </small>
    ) : null;
  const when = (at: string) =>
    groupOf(at) === "today" ? clock(at, locale) : dayAndClock(at, locale);
  const mailRows = (group: ProactiveGroup) =>
    proactive
      ? (mail.get(group) ?? []).map((insight) => (
          <ProactiveInsightRow
            key={insight.id}
            insight={insight}
            group={group}
            proactive={proactive}
            message={message}
            highlighted={highlight === insight.id}
            locale={locale}
            onNotice={(text, undo) => setNotice({ text, undo })}
          />
        ))
      : [];
  const mailGroup = (group: "check" | "none" | "know") => {
    const rows = mailRows(group);
    return rows.length ? (
      <section key={group}>
        <h2 className="memory-group" data-tone={group === "check" ? "check" : undefined}>
          {message("proactive.group", { g: group })}
        </h2>
        {rows}
      </section>
    ) : null;
  };
  const dueRows = mailRows("due");
  const reminderGroups = (["today", "week", "later"] as const).map((group) => {
    const items = groups.get(group) ?? [];
    const rows = mailRows(group);
    if (!items.length && !rows.length) return null;
    return (
      <section key={group}>
        <h2 className="memory-group">{message("reminders.group", { g: group })}</h2>
        {items.map((item) => (
          <div className="reminder-row" key={item.reminderId}>
            <span className="reminder-when">{when(item.dueAt)}</span>
            <span className="reminder-text">
              {item.text}
              {meta(item.repeat === "yearly", item.sourceThreadId)}
            </span>
            <span className="actions">
              <ActionButton
                variant="quiet"
                disabled={memory?.busy}
                onClick={() =>
                  void memory
                    ?.respondReminder(item, "cancel")
                    .then(
                      (ok) =>
                        ok &&
                        setNotice({ text: message("memory.page.cancelled", { text: item.text }) }),
                    )
                }
              >
                {message("memory.reminderDismiss")}
              </ActionButton>
            </span>
          </div>
        ))}
        {rows}
      </section>
    );
  });
  if (view === "log" && proactive)
    return (
      <ProactiveDecisionLog
        proactive={proactive}
        message={message}
        locale={locale}
        onBack={() => setView("list")}
      />
    );
  const mailCount = [...mail.values()].reduce((total, rows) => total + rows.length, 0);
  const watching = proactive?.overview && proactive.overview.connection.status !== "disconnected";
  return (
    <section className="reminders-page side-page-body" aria-label={message("nav.reminders")}>
      <header className="memory-header">
        <div className="side-page-title">
          <ActionButton variant="quiet" aria-label={message("common.back")} onClick={onBack}>
            <LineIcon name="back" />
          </ActionButton>
          <h1>{message("nav.reminders")}</h1>
          {watching ? (
            <button
              type="button"
              className="reminders-link reminders-log-link"
              onClick={() => setView("log")}
            >
              {message("proactive.log")}
            </button>
          ) : null}
        </div>
      </header>
      {!memory ? (
        <p className="settings-note">{message("common.notConfigured")}</p>
      ) : !overview ? (
        <div className="files-library-skeleton" aria-hidden="true">
          <i />
          <i />
        </div>
      ) : (
        <>
          {proactive ? (
            <ProactiveBanners proactive={proactive} message={message} locale={locale} />
          ) : null}
          {overview.reminders.length || dueRows.length ? (
            <section>
              <h2 className="memory-group" data-tone="urgent">
                {message("memory.page.dueNow")}
              </h2>
              {overview.reminders.map((item) => (
                <div className="reminder-row" data-kind="due" key={item.reminderId}>
                  <span className="reminder-when">{when(item.dueAt)}</span>
                  <span className="reminder-text">
                    {item.text}
                    {meta(false, item.sourceThreadId)}
                  </span>
                  <span className="actions">
                    <ActionButton
                      disabled={memory.busy}
                      onClick={() => void memory.respondReminder(item, "dismiss")}
                    >
                      {message("memory.reminderDismiss")}
                    </ActionButton>
                    <ActionButton
                      variant="secondary"
                      disabled={memory.busy}
                      onClick={() => void memory.respondReminder(item, "snooze")}
                    >
                      {message("memory.reminderSnooze")}
                    </ActionButton>
                  </span>
                </div>
              ))}
              {dueRows}
            </section>
          ) : null}
          {reminderGroups[0]}
          {mailGroup("check")}
          {reminderGroups[1]}
          {reminderGroups[2]}
          {mailGroup("none")}
          {mailGroup("know")}
          {!overview.reminders.length && !overview.upcoming.length && !mailCount ? (
            <p className="reminders-empty">{message("reminders.empty")}</p>
          ) : null}
          {proactive ? <ProactiveAudit proactive={proactive} message={message} /> : null}
          <p className="settings-note reminders-notify">
            {message(watching ? "proactive.foot" : "memory.page.notify")}{" "}
            <button type="button" className="reminders-link" onClick={openNotificationSettings}>
              {message("push.openSettings")}
            </button>
          </p>
        </>
      )}
      {notice ? (
        <output className="memory-notice">
          {notice.text}
          {notice.undo ? (
            <button
              type="button"
              onClick={() => {
                notice.undo?.();
                setNotice(null);
              }}
            >
              {message("memory.undo")}
            </button>
          ) : null}
        </output>
      ) : null}
    </section>
  );
}

function PeopleCard({
  people,
  overview,
  message,
}: {
  people: readonly Person[];
  overview: MemoryOverview;
  message: Message;
}) {
  const [center, setCenter] = useState<string | null>(null);
  const byId = new Map(people.map((person) => [person.personId, person]));
  const focus = center ? byId.get(center) : undefined;
  const me = message("memory.page.me");
  const around: { id: string | null; name: string; rel: string }[] = focus
    ? [
        ...(focus.relation ? [{ id: null, name: me, rel: focus.reverseRelation ?? "" }] : []),
        ...focus.links.flatMap((link) => {
          const other = byId.get(link.personId);
          return other ? [{ id: other.personId, name: other.name, rel: link.relation }] : [];
        }),
      ]
    : people
        .filter((person) => person.relation)
        .map((person) => ({ id: person.personId, name: person.name, rel: person.relation ?? "" }));
  const shown = around.slice(0, 12);
  const angle = (index: number) => ((-90 + (index * 360) / shown.length) * Math.PI) / 180;
  const texts = new Map(overview.memories.map((item) => [item.memoryId, item]));
  const list = focus ? around.filter((entry) => entry.id) : around;
  return (
    <section className="memory-card memory-people">
      <h4>
        {message("memory.page.people")}{" "}
        <small>{message("memory.page.peopleCount", { count: people.length })}</small>
      </h4>
      <div className="memory-people-body">
        <div className="memory-graph" aria-hidden="true">
          {shown.map((entry, index) => {
            const a = angle(index);
            return (
              <span
                key={`${entry.id}-line`}
                className="memory-edge"
                style={{
                  left: GRAPH.x,
                  top: GRAPH.y,
                  width: GRAPH.r,
                  transform: `rotate(${(a * 180) / Math.PI}deg)`,
                }}
              />
            );
          })}
          {shown.map((entry, index) => {
            const a = angle(index);
            const along = shown.length > 8 && index % 2 ? 0.62 : 0.46;
            return entry.rel ? (
              <small
                key={`${entry.id}-rel`}
                className="memory-edge-label"
                style={{
                  left: Math.round(GRAPH.x + GRAPH.r * along * Math.cos(a)),
                  top: Math.round(GRAPH.y + GRAPH.r * along * Math.sin(a)),
                }}
              >
                {entry.rel}
              </small>
            ) : null;
          })}
          <button
            type="button"
            tabIndex={-1}
            className="memory-node"
            data-center="true"
            style={{ left: GRAPH.x, top: GRAPH.y }}
          >
            {focus?.name ?? me}
          </button>
          {shown.map((entry, index) => (
            <button
              type="button"
              tabIndex={-1}
              key={entry.id ?? "me"}
              className="memory-node"
              style={{
                left: Math.round(GRAPH.x + GRAPH.r * Math.cos(angle(index))),
                top: Math.round(GRAPH.y + GRAPH.r * Math.sin(angle(index))),
              }}
              onClick={() => setCenter(entry.id)}
            >
              {entry.name}
            </button>
          ))}
        </div>
        <div>
          <strong>{focus?.name ?? me}</strong>{" "}
          <small>
            {focus
              ? focus.relation
                ? message("memory.page.yourRel", { rel: focus.relation })
                : ""
              : message("memory.page.direct")}
          </small>
          {focus ? (
            <ActionButton variant="quiet" onClick={() => setCenter(null)}>
              {message("memory.page.back")}
            </ActionButton>
          ) : null}
          {focus?.aliases.length ? (
            <p className="settings-note">
              {message("memory.page.aliases", { names: focus.aliases.join("、") })}
            </p>
          ) : null}
          {focus && list.length ? <h5>{message("memory.page.knows")}</h5> : null}
          <ul className="memory-list">
            {list.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="memory-line" onClick={() => setCenter(entry.id)}>
                  <span>{entry.name}</span>
                  <small>
                    {focus
                      ? message("memory.page.theirRel", { name: focus.name, rel: entry.rel })
                      : message("memory.page.yourRel", { rel: entry.rel })}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {focus ? (
            <>
              <h5>{message("memory.page.facts")}</h5>
              <ul className="memory-list">
                {focus.memoryIds.flatMap((id) => {
                  const item = texts.get(id);
                  return item && item.status === "active" && !item.supersededBy
                    ? [<li key={id}>{item.text}</li>]
                    : [];
                })}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ProfileTab({
  memory,
  message,
  focus,
  onViewAll,
}: {
  memory: MemoryModel;
  message: Message;
  focus: readonly string[];
  onViewAll: (category: string) => void;
}) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const overview = memory.overview;
  if (!overview) return null;
  const items = new Map(overview.memories.map((item) => [item.memoryId, item]));
  const recent = Date.now() - 7 * DAY_MS;
  return (
    <>
      <p className="settings-note">{message("memory.page.profileNote")}</p>
      <div className="memory-profile-columns">
        {overview.profile.map((section) => {
          const groups = new Map<string, typeof section.lines>();
          for (const line of section.lines) {
            const sub = items.get(line.memoryId)?.subCategory ?? "";
            groups.set(sub, [...(groups.get(sub) ?? []), line]);
          }
          const ordered = [...groups.values()].flat();
          const open = more[section.kind] === true;
          const visible = new Set(
            ordered
              .slice(0, open ? PROFILE_EXPANDED : PROFILE_PREVIEW)
              .map((line) => line.memoryId),
          );
          const categories = section.lines.flatMap((line) => {
            const category = items.get(line.memoryId)?.category;
            return category ? [category] : [];
          });
          const category =
            [...new Set(categories)].sort(
              (a, b) =>
                categories.filter((value) => value === b).length -
                categories.filter((value) => value === a).length,
            )[0] ?? "all";
          return (
            <section className="memory-card" key={section.kind}>
              <h4>
                {message(`memory.profile.${section.kind}`)}{" "}
                <small>{message("memory.page.lines", { count: section.lines.length })}</small>
              </h4>
              {[...groups].map(([sub, lines]) =>
                lines.some((line) => visible.has(line.memoryId)) ? (
                  <div key={sub}>
                    {groups.size > 1 || (sub && section.kind === "relationship") ? (
                      <h5>{sub || message("memory.cat", { c: "other" })}</h5>
                    ) : null}
                    {lines
                      .filter((line) => visible.has(line.memoryId))
                      .map((line) => {
                        const item = items.get(line.memoryId);
                        return editing === line.memoryId && item ? (
                          <TextEditor
                            key={line.memoryId}
                            initial={item.text}
                            busy={memory.busy}
                            message={message}
                            onCancel={() => setEditing(null)}
                            onSave={(text) =>
                              void memory.correct(item, text).then((ok) => ok && setEditing(null))
                            }
                          />
                        ) : (
                          <button
                            type="button"
                            className="memory-line"
                            key={line.memoryId}
                            disabled={!item}
                            onClick={() => setEditing(line.memoryId)}
                          >
                            <span>{line.text}</span>
                            {focus.includes(line.memoryId) ? (
                              <span className="memory-tag" data-kind="new">
                                {message("memory.justSaved")}
                              </span>
                            ) : Date.parse(line.updatedAt) > recent ? (
                              <span className="memory-tag" data-kind="new">
                                {message("memory.recent")}
                              </span>
                            ) : null}
                            {item?.inference ? (
                              <span className="memory-tag" data-kind="inferred">
                                {message("memory.inferred")}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                  </div>
                ) : null,
              )}
              {ordered.length > PROFILE_PREVIEW ? (
                <div className="memory-card-more">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setMore({ ...more, [section.kind]: !open })}
                  >
                    {open
                      ? message("memory.page.less")
                      : message("memory.page.more", {
                          count: Math.min(ordered.length, PROFILE_EXPANDED) - PROFILE_PREVIEW,
                        })}
                  </button>
                  {ordered.length > PROFILE_EXPANDED ? (
                    <button type="button" onClick={() => onViewAll(category)}>
                      {message("memory.page.viewAll", {
                        count: ordered.length,
                        kind: message(`memory.profile.${section.kind}`),
                      })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {overview.people.length ? (
        <PeopleCard people={overview.people} overview={overview} message={message} />
      ) : null}
    </>
  );
}

function AllTab({
  memory,
  message,
  notify,
  onOpenThread,
  focus,
  initialCategory,
}: {
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  onOpenThread: (threadId: string) => void;
  focus: readonly string[];
  initialCategory: string;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(initialCategory);
  const [sub, setSub] = useState("all");
  const [status, setStatus] = useState<MemoryItem["status"]>("active");
  const overview = memory.overview;
  if (!overview) return <p>{message("state.loading")}</p>;
  const history = new Map<string, MemoryItem[]>();
  for (const item of overview.memories)
    if (item.supersededBy)
      history.set(item.supersededBy, [...(history.get(item.supersededBy) ?? []), item]);
  const reminders = new Map(
    overview.upcoming.map((item) => [
      item.memoryId,
      `${time(item.dueAt)}${item.repeat === "yearly" ? ` · ${message("memory.page.yearly")}` : ""}`,
    ]),
  );
  const visible = overview.memories.filter(live);
  const pool = visible.filter((item) => item.status === status);
  const needle = search.trim().toLowerCase();
  type Facet = { status: MemoryItem["status"]; category: string; sub: string };
  const picked: Facet = { status, category, sub };
  const matching = (facet: Facet) =>
    visible.filter(
      (item) =>
        item.status === facet.status &&
        (facet.category === "all" || item.category === facet.category) &&
        (facet.sub === "all" || item.subCategory === facet.sub) &&
        (!needle || item.text.toLowerCase().includes(needle)),
    );
  const ranked = <K extends string>(entries: { key: K; count: number }[], current: string) =>
    entries
      .filter((entry) => entry.count > 0 || entry.key === "all" || entry.key === current)
      .sort((a, b) => (a.key === "all" ? -1 : b.key === "all" ? 1 : b.count - a.count));
  const categories = ranked(
    ["all", ...new Set([...pool.map((item) => item.category), category])].map((key) => ({
      key,
      count: matching({ ...picked, category: key, sub: "all" }).length,
    })),
    category,
  ).map((entry) => ({
    ...entry,
    label:
      entry.key === "all"
        ? message("memory.page.everything")
        : message("memory.cat", { c: entry.key }),
  }));
  const subNames = [
    ...new Set(
      pool.flatMap((item) =>
        item.category === category && item.subCategory ? [item.subCategory] : [],
      ),
    ),
  ];
  const subs =
    category !== "all" && subNames.length > 1
      ? ranked(
          ["all", ...subNames].map((key) => ({
            key,
            count: matching({ ...picked, sub: key }).length,
          })),
          sub,
        ).map((entry) => ({
          ...entry,
          label: entry.key === "all" ? message("memory.page.everything") : entry.key,
        }))
      : [];
  const states = (["active", "archived", "trashed"] as const)
    .map((key) => ({
      key,
      label: message("memory.page.status", { s: key }),
      hint: message("memory.page.statusHint", { s: key }),
      count: matching({ ...picked, status: key, sub: "all" }).length,
    }))
    .filter(
      (entry) =>
        entry.key !== "trashed" ||
        status === "trashed" ||
        visible.some((item) => item.status === "trashed"),
    );
  const shown = matching(picked).sort(
    (a, b) => Number(focus.includes(b.memoryId)) - Number(focus.includes(a.memoryId)),
  );
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const groupOf = (item: MemoryItem) =>
    focus.includes(item.memoryId) && status === "active"
      ? "today"
      : status !== "active"
        ? status
        : Date.parse(item.recordedAt) >= today
          ? "today"
          : Date.parse(item.recordedAt) >= today - 6 * DAY_MS
            ? "week"
            : "earlier";
  const groups = new Map<string, MemoryItem[]>();
  for (const item of shown) groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);
  return (
    <>
      <p className="settings-note">{message("memory.page.allNote")}</p>
      <input
        type="search"
        className="memory-search"
        aria-label={message("memory.search")}
        placeholder={message("memory.search")}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      <Chips
        items={categories}
        value={category}
        message={message}
        onPick={(key) => {
          setCategory(key);
          setSub("all");
        }}
      />
      {subs.length ? (
        <Chips
          label={message("memory.page.sub")}
          items={subs}
          value={sub}
          message={message}
          onPick={setSub}
        />
      ) : null}
      <Chips
        label={message("memory.page.state")}
        items={states}
        value={status}
        message={message}
        onPick={(key) => {
          setStatus(key);
          setSub("all");
        }}
      />
      {groups.size ? (
        [...groups].map(([group, rows]) => (
          <section key={group}>
            <h5 className="memory-group">
              {message("memory.page.group", { g: group, count: rows.length })}
            </h5>
            <ul className="memory-list">
              {rows.map((item) => (
                <MemoryRow
                  key={`${item.memoryId}:${item.revision}`}
                  item={item}
                  history={history.get(item.memoryId) ?? []}
                  reminder={reminders.get(item.memoryId) ?? null}
                  justSaved={focus.includes(item.memoryId)}
                  memory={memory}
                  message={message}
                  notify={notify}
                  onOpenThread={onOpenThread}
                />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="settings-note">
          {visible.length ? message("memory.page.noResults") : message("memory.empty")}
        </p>
      )}
    </>
  );
}

function TimelineTab({
  memory,
  message,
  onConfirm,
}: {
  memory: MemoryModel;
  message: Message;
  onConfirm: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const overview = memory.overview;
  if (!overview) return null;
  type Event = {
    key: string;
    at: string;
    type: "new" | "tidy" | "correct" | "import";
    kind: string;
    text: string;
    note?: string;
    undone?: boolean;
    undo?: () => void;
    confirm?: boolean;
  };
  const byId = new Map(overview.memories.map((item) => [item.memoryId, item]));
  const everything: Event[] = [
    ...overview.memories.flatMap((item): Event[] =>
      item.importBatchId
        ? []
        : item.supersededBy
          ? [
              {
                key: item.memoryId,
                at:
                  item.validTo && !Number.isNaN(Date.parse(item.validTo))
                    ? item.validTo
                    : item.updatedAt,
                type: "correct",
                kind: "correct",
                text: `${item.text} → ${byId.get(item.supersededBy)?.text ?? ""}`,
              },
            ]
          : [
              {
                key: item.memoryId,
                at: item.recordedAt,
                type: "new",
                kind: "new",
                text: item.text,
              },
            ],
    ),
    ...overview.tidyUps.map(
      (item): Event => ({
        key: item.changeId,
        at: item.createdAt,
        type: "tidy",
        kind: item.action,
        text: item.text,
        note: item.relatedText ? message("memory.tidyKept", { text: item.relatedText }) : "",
        undone: item.undone,
        undo: () => void memory.undoTidy(item),
        confirm: item.action === "reflect",
      }),
    ),
    ...overview.imports.map(
      (item): Event => ({
        key: item.batchId,
        at: item.createdAt,
        type: "import",
        kind: "import",
        text: message("memory.page.imported", { source: item.source, count: item.itemCount }),
        undone: item.undone,
        undo: () => void memory.importUndo(item.batchId),
      }),
    ),
  ];
  const events = everything
    .filter((event) => filter === "all" || event.type === filter)
    .sort((a, b) => b.at.localeCompare(a.at));
  const days = new Map<string, Event[]>();
  for (const event of events) {
    const day = new Date(event.at).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  const pending = new Set(
    overview.memories.filter((item) => item.tentative).map((item) => item.text),
  );
  return (
    <>
      <Chips
        items={(["all", "new", "tidy", "correct", "import"] as const).map((key) => ({
          key,
          label: message("memory.page.filter", { f: key }),
          count:
            key === "all"
              ? everything.length
              : everything.filter((event) => event.type === key).length,
        }))}
        value={filter}
        message={message}
        onPick={setFilter}
      />
      <p className="settings-note">{message("memory.page.timelineNote")}</p>
      {[...days].map(([day, list]) => (
        <section className="memory-day" key={day}>
          <strong>{day}</strong>
          {list.map((event) => (
            <p key={event.key}>
              <span className="memory-tag" data-kind={event.type}>
                {message("memory.page.event", { e: event.kind })}
              </span>
              <span className={event.undone ? "memory-undone" : undefined}>
                {event.text}
                <small>{event.note}</small>
              </span>
              {event.undone ? (
                <small>{message("memory.undone")}</small>
              ) : event.undo ? (
                <ActionButton variant="quiet" disabled={memory.busy} onClick={event.undo}>
                  {message("memory.undo")}
                </ActionButton>
              ) : null}
              {event.confirm && pending.has(event.text) ? (
                <ActionButton variant="quiet" onClick={onConfirm}>
                  {message("memory.page.goConfirm")}
                </ActionButton>
              ) : null}
            </p>
          ))}
        </section>
      ))}
    </>
  );
}

function ImportPanel({
  memory,
  message,
  notify,
  onClose,
}: {
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"codex" | "assistant" | "himawari" | null>(null);
  const [pasted, setPasted] = useState("");
  const [items, setItems] = useState<readonly ImportCandidate[]>([]);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState("");
  const existing = (memory.overview?.memories ?? [])
    .filter((item) => item.status !== "trashed")
    .map((item) => item.text);
  const load = (parsed: readonly ImportParse[]) => {
    const all = parsed.flatMap((entry) => entry.items).slice(0, MAXIMUM_IMPORT_ITEMS);
    setDropped(parsed.reduce((total, entry) => total + entry.dropped, 0));
    setItems(all);
    setError(all.length ? "" : message("memory.page.importEmpty"));
  };
  const read = (files: FileList | null, parse: (name: string, text: string) => ImportParse) => {
    const list = [...(files ?? [])];
    if (list.some((file) => file.size > MAXIMUM_IMPORT_BYTES)) {
      setError(message("memory.page.importTooBig"));
      return;
    }
    void Promise.all(list.map(async (file) => parse(file.name, await file.text())))
      .then(load)
      .catch(() => setError(message("memory.page.importUnreadable")));
  };
  const reset = () => {
    setSource(null);
    setItems([]);
    setError("");
    setDropped(0);
    setPasted("");
  };
  const chosen = items.filter((item) => item.checked);
  const prompt = message("memory.page.aiPrompt");
  return (
    <section className="memory-card memory-import" ref={reveal}>
      <h4>
        {message("memory.page.import")}{" "}
        <ActionButton variant="quiet" onClick={onClose}>
          {message("memory.page.less")}
        </ActionButton>
      </h4>
      <p className="settings-note">{message("memory.page.importNote")}</p>
      {items.length ? (
        <>
          <strong>
            {message("memory.page.importSummary", {
              all: items.length,
              on: chosen.length,
            })}
          </strong>
          <ul className="memory-list memory-preview">
            {items.map((item, index) => (
              <li key={`${index}:${item.text}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.checked}
                    disabled={item.duplicate}
                    onChange={() =>
                      setItems(
                        items.map((entry, position) =>
                          position === index ? { ...entry, checked: !entry.checked } : entry,
                        ),
                      )
                    }
                  />
                  <span>
                    {item.text}
                    <span className="memory-tags">
                      <span className="memory-tag">
                        {message("memory.cat", { c: item.category })}
                        {item.subCategory ? ` · ${item.subCategory}` : ""}
                      </span>
                      {item.sensitive || item.duplicate || item.coding ? (
                        <span className="memory-tag" data-kind="sensitive">
                          {message("memory.page.importFlag", {
                            f: item.duplicate
                              ? "duplicate"
                              : item.sensitive
                                ? "sensitive"
                                : "coding",
                          })}
                        </span>
                      ) : null}
                      <small>{item.from}</small>
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {dropped ? (
            <p className="settings-note">
              {message("memory.page.importDropped", { count: dropped })}
            </p>
          ) : null}
          <div className="actions">
            <ActionButton
              disabled={memory.busy || !chosen.length || !source}
              onClick={() =>
                source &&
                void memory.importCommit(source, chosen).then((ok) => {
                  if (!ok) return;
                  notify({ text: message("memory.page.importDone", { count: chosen.length }) });
                  onClose();
                })
              }
            >
              {message("memory.page.importCommit", { count: chosen.length })}
            </ActionButton>
            <ActionButton variant="quiet" onClick={reset}>
              {message("memory.page.importAgain")}
            </ActionButton>
          </div>
        </>
      ) : source === null ? (
        <div className="memory-sources">
          {(["codex", "assistant", "himawari"] as const).map((key) => (
            <button type="button" key={key} onClick={() => setSource(key)}>
              <strong>{message("memory.page.sourceTitle", { s: key })}</strong>
              <small>{message("memory.page.sourceHelp", { s: key })}</small>
            </button>
          ))}
        </div>
      ) : (
        <>
          {source === "assistant" ? (
            <>
              <p>{message("memory.page.aiStep1")}</p>
              <textarea
                readOnly
                className="memory-search"
                value={prompt}
                aria-label={message("memory.page.aiStep1")}
              />
              <ActionButton
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(prompt)
                    .then(() => notify({ text: message("memory.page.copied") }))
                    .catch(() => notify({ text: message("memory.page.copyFailed") }))
                }
              >
                {message("memory.page.copy")}
              </ActionButton>
              <p>{message("memory.page.aiStep2")}</p>
              <textarea
                className="memory-search"
                aria-label={message("memory.page.aiStep2")}
                value={pasted}
                onChange={(event) => setPasted(event.currentTarget.value)}
              />
              <ActionButton
                disabled={!pasted.trim()}
                onClick={() =>
                  load([
                    parseMemoryText(
                      message("memory.page.sourceTitle", { s: "assistant" }),
                      pasted,
                      existing,
                    ),
                  ])
                }
              >
                {message("memory.page.parse")}
              </ActionButton>
            </>
          ) : (
            <>
              <p>{message("memory.page.fileHelp", { s: source })}</p>
              <input
                type="file"
                multiple={source === "codex"}
                accept={source === "codex" ? ".md,.txt" : ".json"}
                aria-label={message("memory.page.sourceTitle", { s: source })}
                onChange={(event) =>
                  read(event.currentTarget.files, (name, text) =>
                    source === "codex"
                      ? parseMemoryText(name, text, existing)
                      : parseMemoryExport(name, text, existing),
                  )
                }
              />
            </>
          )}
          <ActionButton variant="quiet" onClick={reset}>
            {message("memory.page.importAgain")}
          </ActionButton>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function ExportPanel({
  overview,
  message,
  onClose,
}: {
  overview: MemoryOverview;
  message: Message;
  onClose: () => void;
}) {
  const [sensitive, setSensitive] = useState(false);
  const items = overview.memories.filter(
    (item) =>
      item.status !== "trashed" &&
      !item.tentative &&
      (sensitive || (item.dataClassification !== "sensitive" && !item.topic)),
  );
  const download = () => {
    const body = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        memories: items.map((item) => ({
          text: item.text,
          category: item.category,
          subCategory: item.subCategory,
          sensitive: item.dataClassification === "sensitive" || item.topic !== null,
          status: item.supersededBy ? "superseded" : item.status,
          recordedAt: item.recordedAt,
          lastUsedAt: item.lastUsedAt,
        })),
      },
      null,
      2,
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    link.download = "himawari-memories.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <section className="memory-card" ref={reveal}>
      <h4>{message("memory.page.exportTitle", { count: items.length })}</h4>
      <label className="memory-check">
        <input type="checkbox" checked={sensitive} onChange={() => setSensitive(!sensitive)} />
        {message("memory.page.exportSensitive")}
      </label>
      <div className="actions">
        <ActionButton disabled={!items.length} onClick={download}>
          {message("memory.page.download")}
        </ActionButton>
        <ActionButton variant="quiet" onClick={onClose}>
          {message("memory.page.less")}
        </ActionButton>
      </div>
    </section>
  );
}

function AddForm({
  memory,
  message,
  notify,
  onDone,
}: {
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  onDone: () => void;
}) {
  return (
    <section className="memory-card" data-kind="add">
      <strong>{message("memory.page.addTitle")}</strong>
      <p className="settings-note">{message("memory.page.addNote")}</p>
      <TextEditor
        initial=""
        placeholder={message("memory.page.addPlaceholder")}
        busy={memory.busy}
        message={message}
        onCancel={onDone}
        onSave={(text) => {
          const guess = guessCategory(text);
          void memory.create(text, guess.category, guess.sensitive, false).then((ok) => {
            if (!ok) return;
            notify({
              text: message("memory.page.added", {
                cat: message("memory.cat", { c: guess.category }),
              }),
            });
            onDone();
          });
        }}
      />
    </section>
  );
}

export function MemoryPage({
  memory,
  message,
  focus = [],
  onBack,
  onOpenThread,
}: {
  memory: MemoryModel | null;
  message: Message;
  focus?: readonly string[];
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(focus.length ? "all" : "pending");
  const [allCategory, setAllCategory] = useState("all");
  const [panel, setPanel] = useState<"add" | "import" | "export" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!memory) return <p>{message("common.notConfigured")}</p>;
  const overview = memory.overview;
  const notify = (next: Notice) => {
    window.clearTimeout(timer.current);
    setNotice(next);
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  };
  const memories = overview?.memories.filter(live) ?? [];
  const active = memories.filter((item) => item.status === "active");
  const queue =
    (overview?.pending.length ?? 0) +
    (overview?.personSuggestions.length ?? 0) +
    (overview?.memories.filter(
      (item) => item.tentative && !item.supersededBy && item.status === "active",
    ).length ?? 0);
  const current: Tab = tab === "pending" && !queue ? "profile" : tab;
  const paused = overview?.capturePaused ?? false;
  const ready = overview?.manualAddReady ?? false;
  const tabs: { key: Tab; count?: string; urgent?: boolean }[] = [
    ...(queue ? [{ key: "pending" as const, count: String(queue), urgent: true }] : []),
    { key: "profile" },
    { key: "all", ...(overview ? { count: String(active.length) } : {}) },
    { key: "timeline" },
  ];
  const body: Record<Tab, () => ReactNode> = {
    pending: () => <PendingTab memory={memory} message={message} />,
    profile: () => (
      <ProfileTab
        memory={memory}
        message={message}
        focus={focus}
        onViewAll={(category) => {
          setAllCategory(category);
          setTab("all");
        }}
      />
    ),
    all: () => (
      <AllTab
        key={allCategory}
        memory={memory}
        message={message}
        notify={notify}
        onOpenThread={onOpenThread}
        focus={focus}
        initialCategory={allCategory}
      />
    ),
    timeline: () => (
      <TimelineTab memory={memory} message={message} onConfirm={() => setTab("pending")} />
    ),
  };
  const week = Date.now() - 7 * DAY_MS;
  return (
    <section className="memory-page side-page-body" aria-label={message("nav.memory")}>
      <header className="memory-header">
        <div className="side-page-title">
          <ActionButton variant="quiet" aria-label={message("common.back")} onClick={onBack}>
            <LineIcon name="back" />
          </ActionButton>
          <h1>{message("nav.memory")}</h1>
          {overview ? (
            <small>
              {message("memory.page.summary", {
                live: active.length,
                week: active.filter((item) => Date.parse(item.recordedAt) > week).length,
                archived: memories.filter((item) => item.status === "archived").length,
              })}
            </small>
          ) : null}
        </div>
        <div className="actions">
          <label className="memory-switch">
            {message("memory.page.auto")}
            <input
              type="checkbox"
              role="switch"
              aria-checked={!paused}
              checked={!paused}
              disabled={memory.busy || !overview}
              onChange={() =>
                void memory.setPaused(!paused).then(
                  (ok) =>
                    ok &&
                    notify({
                      text: message("memory.page.pauseDone", { paused: String(!paused) }),
                    }),
                )
              }
            />
            <small>{message("memory.page.autoState", { paused: String(paused) })}</small>
          </label>
          <ActionButton
            variant="secondary"
            disabled={!ready}
            onClick={() => setPanel(panel === "add" ? null : "add")}
          >
            {message("memory.page.add")}
          </ActionButton>
        </div>
      </header>
      {memory.failed ? <p role="alert">{message("error.currentUnavailable")}</p> : null}
      {paused ? (
        <p className="memory-banner" data-kind="paused">
          {message("memory.page.pausedNote")}
        </p>
      ) : null}
      {overview && !ready ? (
        <p className="memory-banner">{message("memory.page.notReady")}</p>
      ) : null}
      {panel === "add" ? (
        <AddForm memory={memory} message={message} notify={notify} onDone={() => setPanel(null)} />
      ) : null}
      <div role="tablist" className="memory-tabs" aria-label={message("nav.memory")}>
        {tabs.map((item) => (
          <button
            type="button"
            role="tab"
            key={item.key}
            aria-selected={current === item.key}
            data-urgent={item.urgent || undefined}
            className={item.key === "profile" ? "memory-tab-split" : undefined}
            onClick={() => setTab(item.key)}
          >
            {message("memory.page.tab", { t: item.key })}
            {item.count ? <small>{item.count}</small> : null}
          </button>
        ))}
      </div>
      {overview ? body[current]() : <p>{message("state.loading")}</p>}
      <footer className="memory-footer">
        <small>{message("memory.note")}</small>
        <span>
          {(["import", "export"] as const).map((key) => (
            <ActionButton
              key={key}
              variant="quiet"
              disabled={key === "import" && !ready}
              aria-expanded={panel === key}
              onClick={() => setPanel(panel === key ? null : key)}
            >
              {message(`memory.page.${key}`)}
            </ActionButton>
          ))}
        </span>
      </footer>
      {panel === "import" ? (
        <ImportPanel
          memory={memory}
          message={message}
          notify={notify}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === "export" && overview ? (
        <ExportPanel overview={overview} message={message} onClose={() => setPanel(null)} />
      ) : null}
      {notice ? (
        <output className="memory-notice">
          {notice.text}
          {notice.undo ? (
            <button
              type="button"
              onClick={() => {
                notice.undo?.();
                setNotice(null);
              }}
            >
              {message("memory.undo")}
            </button>
          ) : null}
        </output>
      ) : null}
    </section>
  );
}
