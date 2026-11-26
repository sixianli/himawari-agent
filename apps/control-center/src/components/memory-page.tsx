import {
  MEMORY_CATEGORY_NAMES,
  MEMORY_SENSITIVE_CATEGORY_NAMES,
} from "@himawari-agent/gateway-contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { requestChatExport, requestDataExport } from "../data-export.js";
import { DEFAULT_UI_LOCALE, useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryItem, MemoryModel, MemoryOverview } from "../memory.js";
import {
  changeCount,
  type MemoryHistoryNode,
  type MemoryStanceChart,
  memoryChain,
  memoryHeads,
  stanceChart,
} from "../memory-history.js";
import {
  applyImportClassifications,
  applyImportDuplicates,
  type ImportCandidate,
  type ImportParse,
  type MemoryCategory,
  parseMemoryExport,
  parseMemoryText,
} from "../memory-import.js";
import { memorySourceCounts, memorySourceState } from "../memory-source.js";
import type { ProactiveGroup, ProactiveModel } from "../proactive.js";
import { LineIcon } from "./answer-footer.js";
import { CorrectionReviewSection } from "./correction-review.js";
import { ExternalProposalsSection } from "./external-proposals.js";
import { Glyph } from "./glyphs.js";
import {
  MemoryApprovalCard,
  openMemoryPage,
  openNotificationSettings,
  TextEditor,
} from "./memory-panel.js";
import { ActionButton, Dropdown, EmptyState } from "./primitives.js";
import {
  clock,
  dayAndClock,
  groupInsights,
  ProactiveBanners,
  ProactiveInsightRow,
  ProactiveReviewSection,
  useHighlight,
} from "./proactive-reminders.js";
import {
  BuiltInActionRulesSection,
  OwnerAllowancesSection,
  OwnerRulesSection,
} from "./rule-receipt.js";
import { WeeklyReport } from "./weekly-report.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;
type Tab = "memories" | "changes";
type Notice = { readonly text: string; readonly undo?: () => void } | null;
type Person = MemoryOverview["people"][number];
type Scope = {
  readonly status: MemoryItem["status"];
  readonly category: string;
  readonly sub: string | null;
  readonly fresh: boolean;
};

const DAY_MS = 86_400_000;
const VISIBLE_CHIPS = 5;
const GROUP_PREVIEW = 3;
const PAGE_SIZE = 30;
const HISTORY_HEAD = 3;
const CHART = { lane: 28, step: 44, label: 104, pad: 10, axis: 22 };
const NOTICE_MS = 6000;
const MAXIMUM_IMPORT_BYTES = 200 * 1024;
const MAXIMUM_IMPORT_ITEMS = 500;
const GRAPH = { x: 190, y: 150, r: 112 };

const reveal = (element: HTMLElement | null) => element?.scrollIntoView?.({ block: "nearest" });
const live = (item: MemoryItem) =>
  !item.supersededBy && (!item.tentative || item.status !== "active");
const PINNABLE: ReadonlySet<string> = new Set([
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
]);
const pinBlock = (item: MemoryItem) => (PINNABLE.has(item.category) ? null : "category");

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

function StanceChart({ chart, message }: { chart: MemoryStanceChart; message: Message }) {
  const { day: date, moment: time } = useLocaleFormat();
  const width = Math.max(320, CHART.label + CHART.pad * 2 + (chart.points.length - 1) * CHART.step);
  const height = chart.lanes.length * CHART.lane + CHART.axis;
  const span = width - CHART.label - CHART.pad * 2;
  const x = (index: number) =>
    CHART.label +
    CHART.pad +
    (chart.points.length > 1 ? (index * span) / (chart.points.length - 1) : span / 2);
  const y = (lane: number) => CHART.lane / 2 + lane * CHART.lane;
  const path = chart.points
    .map(({ lane }, index) =>
      index === 0
        ? `M${x(0)} ${y(lane)}`
        : `L${x(index)} ${y(chart.points[index - 1]?.lane ?? lane)} L${x(index)} ${y(lane)}`,
    )
    .join(" ");
  const first = chart.points[0]?.node;
  const last = chart.points.at(-1)?.node;
  return (
    <div className="memory-stance-chart">
      <svg
        role="img"
        aria-label={message("memory.page.chartLabel", { lanes: chart.lanes.join(" / ") })}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {chart.lanes.map((lane, index) => (
          <g key={lane}>
            <text x={0} y={y(index) + 4}>
              {lane}
            </text>
            <line x1={CHART.label} x2={width - CHART.pad} y1={y(index)} y2={y(index)} />
          </g>
        ))}
        <path d={path} />
        {chart.points.map(({ lane, node }, index) => (
          <circle
            key={node.key}
            cx={x(index)}
            cy={y(lane)}
            r={node.kind === "reaffirmed" ? 3 : 5}
            data-current={node.current || undefined}
          >
            <title>{`${time(node.at)} · ${node.stance ?? ""}`}</title>
          </circle>
        ))}
        {first ? (
          <text className="memory-stance-axis" x={x(0)} y={height - 4} textAnchor="start">
            {date(first.at)}
          </text>
        ) : null}
        {last && chart.points.length > 1 ? (
          <text
            className="memory-stance-axis"
            x={x(chart.points.length - 1)}
            y={height - 4}
            textAnchor="end"
          >
            {date(last.at)}
          </text>
        ) : null}
      </svg>
    </div>
  );
}

function MemoryHistory({
  head,
  chain,
  memory,
  message,
  onOpenThread,
}: {
  head: MemoryItem;
  chain: readonly MemoryHistoryNode[];
  memory: MemoryModel;
  message: Message;
  onOpenThread: (threadId: string) => void;
}) {
  const { moment: time } = useLocaleFormat();
  const [expanded, setExpanded] = useState(false);
  const newest = [...chain].reverse();
  const shown = expanded ? newest : newest.slice(0, HISTORY_HEAD);
  const hidden = newest.length - shown.length;
  const chart = stanceChart(chain);
  return (
    <div className="memory-history-block">
      {chart ? <StanceChart chart={chart} message={message} /> : null}
      <p className="memory-history-summary">
        {message("memory.page.flips", {
          changes: changeCount(chain),
          again: chain.filter((node) => node.kind === "reaffirmed").length,
        })}
      </p>
      <ol className="memory-history-line">
        {shown.map((node) => (
          <li
            key={node.key}
            data-current={node.current || undefined}
            data-again={node.kind === "reaffirmed" || undefined}
          >
            <span className="memory-history-dot" aria-hidden="true" />
            <div>
              <small>
                {time(node.at)} ·{" "}
                {node.current
                  ? message("memory.page.now")
                  : message("memory.page.node", { k: node.kind })}
                {node.sourceThreadId ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="memory-link"
                      onClick={() => node.sourceThreadId && onOpenThread(node.sourceThreadId)}
                    >
                      {message("memory.source")}
                    </button>
                  </>
                ) : node.sourceDeleted ? (
                  ` · ${message("memory.page.sourceDeleted")}`
                ) : null}
              </small>
              {node.kind === "reaffirmed" && !node.current ? null : <p>{node.text}</p>}
              {node.quote ? (
                <p className="memory-history-quote">
                  {message("memory.page.quote", { quote: node.quote })}
                </p>
              ) : null}
              {node.restorable ? (
                <button
                  type="button"
                  className="memory-link"
                  disabled={memory.busy}
                  onClick={() => void memory.restore(node.record)}
                >
                  {message("memory.page.useThis")}
                </button>
              ) : node.versionRestorable ? (
                <button
                  type="button"
                  className="memory-link"
                  disabled={memory.busy}
                  onClick={() => void memory.restoreVersion(head, node.historyId)}
                >
                  {message("memory.page.restoreVersion")}
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {hidden || expanded ? (
          <li className="memory-history-fold">
            <button type="button" onClick={() => setExpanded(!expanded)}>
              {expanded
                ? message("memory.page.collapseHistory")
                : message("memory.page.olderChanges", { count: hidden })}
            </button>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function PinSwitch({
  item,
  carried,
  memory,
  message,
  notify,
  label,
}: {
  item: MemoryItem;
  carried: boolean;
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  label?: string;
}) {
  const on =
    pinBlock(item) === "category" ? false : item.profilePin ? item.profilePin === "on" : carried;
  return (
    <label className="memory-switch memory-pin">
      {label ? null : message("memory.page.pin")}
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-checked={on}
        checked={on}
        disabled={memory.busy || pinBlock(item) !== null}
        onChange={() =>
          void memory
            .setPinned(item, !on)
            .then(
              (ok) => ok && notify({ text: message("memory.page.pinDone", { on: String(!on) }) }),
            )
        }
      />
    </label>
  );
}

function MemoryLine({
  item,
  changes,
  reminder,
  carried,
  justSaved,
  showTopic,
  message,
  onOpen,
}: {
  item: MemoryItem;
  changes: number;
  reminder: boolean;
  carried: boolean;
  justSaved: boolean;
  showTopic: boolean;
  message: Message;
  onOpen: () => void;
}) {
  const { day: date } = useLocaleFormat();
  const sensitive = item.dataClassification === "sensitive" || item.topic;
  return (
    <li className="memory-row" data-status={item.status} data-just-saved={justSaved || undefined}>
      <button type="button" className="memory-row-head" aria-haspopup="dialog" onClick={onOpen}>
        <span className="memory-text">{item.text}</span>
        <span className="memory-tags">
          {justSaved ? (
            <span className="memory-tag" data-kind="new">
              {message("memory.justSaved")}
            </span>
          ) : null}
          {carried ? (
            <span className="memory-tag" data-kind="carried">
              {message("memory.page.carried")}
            </span>
          ) : null}
          {showTopic ? (
            <span className="memory-tag">
              {message("memory.cat", { c: item.category })}
              {item.subCategory ? ` · ${item.subCategory}` : ""}
            </span>
          ) : null}
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
          {changes ? (
            <span className="memory-tag">{message("memory.page.changed", { count: changes })}</span>
          ) : null}
          <small>{date(item.recordedAt)}</small>
        </span>
      </button>
    </li>
  );
}

function MissedReport({
  item,
  memory,
  message,
  notify,
}: {
  item: MemoryItem;
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const choices =
    memory.overview?.memories.filter(
      (other) => other.memoryId !== item.memoryId && other.status === "active" && live(other),
    ) ?? [];
  if (!choices.length) return null;
  if (!open)
    return (
      <ActionButton variant="quiet" onClick={() => setOpen(true)}>
        {message("memory.page.missed")}
      </ActionButton>
    );
  return (
    <div className="memory-add-options" data-missed-report="">
      <label>
        {message("memory.page.missedPick")}
        <select value={picked} onChange={(event) => setPicked(event.currentTarget.value)}>
          <option value="">-</option>
          {choices.map((other) => (
            <option key={other.memoryId} value={other.memoryId}>
              {Array.from(other.text).slice(0, 60).join("")}
            </option>
          ))}
        </select>
      </label>
      <ActionButton
        disabled={memory.busy || !picked}
        onClick={() =>
          void memory.reportMissed(picked, item.memoryId).then((ok) => {
            if (!ok) return;
            notify({ text: message("memory.page.missedSaved") });
            setPicked("");
            setOpen(false);
          })
        }
      >
        {message("memory.page.missedSubmit")}
      </ActionButton>
    </div>
  );
}

function MemoryDetail({
  item,
  chain,
  reminder,
  carried,
  memory,
  message,
  notify,
  onOpenThread,
  onClose,
}: {
  item: MemoryItem;
  chain: readonly MemoryHistoryNode[];
  reminder: string | null;
  carried: boolean;
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  onOpenThread: (threadId: string, messageId?: string) => void;
  onClose: () => void;
}) {
  const { moment: time } = useLocaleFormat();
  const [editing, setEditing] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    panel.current?.focus?.();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const block = pinBlock(item);
  const recategorizable =
    (item.status === "active" || item.status === "archived") &&
    item.dataClassification !== "sensitive" &&
    !item.topic;
  const categoryChoices = MEMORY_CATEGORY_NAMES.filter(
    (key) =>
      key === item.category ||
      !(MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(key),
  );
  const [checkedLost, setCheckedLost] = useState(false);
  const origin = checkedLost ? "unavailable" : memorySourceState(item);
  const importSource = item.importBatchId
    ? memory.overview?.imports.find(({ batchId }) => batchId === item.importBatchId)?.source
    : undefined;
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="memory-drawer-backdrop"
        aria-label={message("common.close")}
        onClick={onClose}
      />
      <aside
        ref={panel}
        tabIndex={-1}
        className="memory-drawer"
        role="dialog"
        aria-label={message("memory.page.detail")}
        data-status={item.status}
      >
        <header>
          <strong>{message("memory.page.detail")}</strong>
          <ActionButton variant="quiet" aria-label={message("common.close")} onClick={onClose}>
            <LineIcon name="close" />
          </ActionButton>
        </header>
        {editing ? (
          <>
            <TextEditor
              initial={item.text}
              busy={memory.busy}
              message={message}
              onCancel={() => setEditing(false)}
              onSave={(text) =>
                void memory.correct(item, text).then((ok) => ok && setEditing(false))
              }
            />
            <small className="settings-note">{message("memory.page.editNote")}</small>
          </>
        ) : (
          <p className="memory-text memory-drawer-text">{item.text}</p>
        )}
        {item.status === "active" ? (
          <div className="memory-drawer-pin">
            <PinSwitch
              item={item}
              carried={carried}
              memory={memory}
              message={message}
              notify={notify}
            />
            <small>
              {message("memory.page.pinHint", { r: block ?? item.profilePin ?? "auto" })}
            </small>
          </div>
        ) : null}
        <dl className="memory-detail">
          <dt>{message("memory.page.topic")}</dt>
          <dd>
            {recategorizable ? (
              <Dropdown
                label={message("memory.page.topicChange")}
                value={item.category as MemoryCategory}
                options={categoryChoices.map((key) => ({
                  value: key,
                  label: message("memory.cat", { c: key }),
                }))}
                onChange={(key) =>
                  void memory.setCategory(item, key).then(
                    (ok) =>
                      ok &&
                      notify({
                        text: message("memory.page.topicDone", {
                          c: message("memory.cat", { c: key }),
                        }),
                      }),
                  )
                }
              />
            ) : (
              message("memory.cat", { c: item.category })
            )}
            {item.subCategory ? ` · ${item.subCategory}` : ""}
          </dd>
          <dt>{message("memory.page.importance")}</dt>
          <dd>
            {message("memory.page.importanceValue", {
              value: item.importance,
              by:
                origin === "owner" || origin === "external" || origin === "external_direct"
                  ? "owner"
                  : "model",
            })}
          </dd>
          <dt>{message("memory.page.source")}</dt>
          <dd>
            {origin === "jump" && item.sourceThreadId && item.sourceMessageId ? (
              <button
                type="button"
                className="memory-link"
                onClick={() => {
                  void memory.checkSource(item.memoryId).then((fresh) => {
                    if (fresh?.sourceThreadId && fresh.sourceMessageId)
                      onOpenThread(fresh.sourceThreadId, fresh.sourceMessageId);
                    else setCheckedLost(true);
                  });
                }}
              >
                {message("memory.page.jumpToQuote")}
              </button>
            ) : origin === "reminder" && item.sourceThreadId ? (
              <>
                {message("memory.page.origin", { o: origin })}
                {" · "}
                <button
                  type="button"
                  className="memory-link"
                  onClick={() => item.sourceThreadId && onOpenThread(item.sourceThreadId)}
                >
                  {message("memory.source")}
                </button>
              </>
            ) : origin === "unavailable" ? (
              <>
                {message("memory.page.sourceUnavailable")}
                {item.sourceThreadId ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="memory-link"
                      onClick={() => item.sourceThreadId && onOpenThread(item.sourceThreadId)}
                    >
                      {message("memory.source")}
                    </button>
                  </>
                ) : null}
              </>
            ) : origin === "import" && importSource ? (
              message("memory.page.originImport", { source: importSource })
            ) : (
              message("memory.page.origin", { o: origin })
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
          {chain.length > 1 ? (
            <>
              <dt>{message("memory.page.history")}</dt>
              <dd>
                <MemoryHistory
                  head={item}
                  chain={chain}
                  memory={memory}
                  message={message}
                  onOpenThread={onOpenThread}
                />
              </dd>
            </>
          ) : null}
        </dl>
        <div className="actions memory-detail-actions">
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
              ) : editing ? null : (
                <ActionButton variant="secondary" onClick={() => setEditing(true)}>
                  {message("memory.editAction")}
                </ActionButton>
              )}
              <ActionButton
                variant="danger"
                disabled={memory.busy}
                onClick={() =>
                  void memory.remove(item).then((ok) => {
                    if (!ok) return;
                    notify({
                      text: message("memory.page.deleted"),
                      undo: () => void memory.recover({ ...item, revision: item.revision + 1 }),
                    });
                    onClose();
                  })
                }
              >
                {message("memory.deleteAction")}
              </ActionButton>
              <MissedReport item={item} memory={memory} message={message} notify={notify} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function ConfirmSection({ memory, message }: { memory: MemoryModel; message: Message }) {
  const overview = memory.overview;
  if (!overview) return null;
  const people = new Map(overview.people.map((person) => [person.personId, person.name]));
  const guesses = overview.memories.filter(
    (item) => item.tentative && !item.supersededBy && item.status === "active",
  );
  const count = overview.pending.length + overview.personSuggestions.length + guesses.length;
  if (!count) return null;
  return (
    <section
      id="memory-confirm"
      className="memory-confirm"
      aria-label={message("memory.page.confirmTitle", { count })}
    >
      <h4>{message("memory.page.confirmTitle", { count })}</h4>
      <p className="settings-note">{message("memory.page.pendingNote")}</p>
      {overview.pending.map((item) => (
        <MemoryApprovalCard key={item.requestId} item={item} memory={memory} message={message} />
      ))}
      {guesses.map((item) => (
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
    </section>
  );
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ReminderAddCard({
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
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [yearly, setYearly] = useState(false);
  const past = due !== "" && !(Date.parse(due) > Date.now());
  const save = () =>
    void memory.createReminder(text.trim(), due, yearly ? "yearly" : "none").then((ok) => {
      if (!ok) return;
      notify({ text: message("reminders.added", { text: text.trim() }) });
      onDone();
    });
  return (
    <section className="memory-card" data-kind="add">
      <div className="memory-editor">
        <textarea
          aria-label={message("reminders.add")}
          maxLength={500}
          placeholder={message("reminders.addPlaceholder")}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <div className="memory-add-options">
          <label>
            {message("reminders.addWhen")}
            <input
              type="datetime-local"
              value={due}
              min={localInput(new Date())}
              onChange={(event) => setDue(event.currentTarget.value)}
            />
          </label>
          <label className="memory-switch">
            {message("reminders.addYearly")}
            <input
              type="checkbox"
              role="switch"
              aria-checked={yearly}
              checked={yearly}
              onChange={() => setYearly(!yearly)}
            />
          </label>
        </div>
        {past ? <small className="settings-note">{message("reminders.addPast")}</small> : null}
        <div className="actions">
          <ActionButton disabled={memory.busy || !text.trim() || due === "" || past} onClick={save}>
            {message("memory.save")}
          </ActionButton>
          <ActionButton variant="quiet" disabled={memory.busy} onClick={onDone}>
            {message("governed.cancel")}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

export function RemindersPage({
  memory,
  proactive = null,
  focus = null,
  locale,
  message,
  onOpenThread,
}: {
  memory: MemoryModel | null;
  proactive?: ProactiveModel | null;
  focus?: string | null;
  locale?: string | undefined;
  message: Message;
  onOpenThread: (threadId: string, messageId?: string) => void;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"reminders" | "report">("reminders");
  const highlight = useHighlight(focus);
  const weekly = proactive?.weekly ?? null;
  useEffect(() => {
    if (focus) setTab("reminders");
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
  const restore = (item: { readonly reminderId: string; readonly text: string }) =>
    memory?.respondReminder(item, "restore").then((ok) =>
      setNotice({
        text: ok
          ? message("memory.page.restored", { text: item.text })
          : message("memory.page.restoreFailed"),
      }),
    );
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
                  void memory?.respondReminder(item, "cancel").then(
                    (ok) =>
                      ok &&
                      setNotice({
                        text: message("memory.page.cancelled", { text: item.text }),
                        undo: () => void restore(item),
                      }),
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
  const mailCount = [...mail.values()].reduce((total, rows) => total + rows.length, 0);
  const watching = proactive?.overview && proactive.overview.connection.status !== "disconnected";
  const notifyNote = (
    <>
      {message(watching ? "proactive.foot" : "memory.page.notify")}{" "}
      <button type="button" className="reminders-link" onClick={openNotificationSettings}>
        {message("push.openSettings")}
      </button>
    </>
  );
  const showReport = tab === "report" && proactive !== null && weekly !== null;
  return (
    <section className="reminders-page side-page-body">
      {proactive && weekly ? (
        <div role="tablist" className="memory-tabs" aria-label={message("nav.reminders")}>
          {(["reminders", "report"] as const).map((key) => (
            <button
              type="button"
              role="tab"
              key={key}
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {message(key === "reminders" ? "reminders.tab.reminders" : "reminders.tab.report")}
            </button>
          ))}
        </div>
      ) : null}
      {showReport ? (
        <WeeklyReport
          proactive={proactive}
          weekly={weekly}
          message={message}
          locale={locale ?? DEFAULT_UI_LOCALE}
          onRate={() => {
            setTab("reminders");
            window.requestAnimationFrame(() =>
              document.querySelector(".proactive-review")?.scrollIntoView?.({ block: "start" }),
            );
          }}
        />
      ) : !memory ? (
        <p className="settings-note">{message("common.notConfigured")}</p>
      ) : !overview ? (
        <div className="files-library-skeleton" aria-hidden="true">
          <i />
          <i />
        </div>
      ) : (
        <>
          {overview.manualAddReady && !adding ? (
            <div className="actions">
              <ActionButton variant="secondary" onClick={() => setAdding(true)}>
                {message("reminders.add")}
              </ActionButton>
            </div>
          ) : null}
          {adding ? (
            <ReminderAddCard
              memory={memory}
              message={message}
              notify={setNotice}
              onDone={() => setAdding(false)}
            />
          ) : null}
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
          {overview.cancelled.length ? (
            <section>
              <h2 className="memory-group">{message("reminders.cancelledGroup")}</h2>
              {overview.cancelled.map((item) => (
                <div className="reminder-row" data-kind="cancelled" key={item.reminderId}>
                  <span className="reminder-when">{when(item.dueAt)}</span>
                  <span className="reminder-text">
                    {item.text}
                    {meta(item.repeat === "yearly", null)}
                  </span>
                  <span className="actions">
                    <ActionButton
                      variant="quiet"
                      disabled={memory.busy}
                      onClick={() => void restore(item)}
                    >
                      {message("memory.reminderRestore")}
                    </ActionButton>
                  </span>
                </div>
              ))}
            </section>
          ) : null}
          {!overview.reminders.length &&
          !overview.upcoming.length &&
          !overview.cancelled.length &&
          !mailCount ? (
            <EmptyState
              icon={<LineIcon name="bell" />}
              title={message("reminders.emptyTitle")}
              footer={notifyNote}
            >
              {message("reminders.empty")}
            </EmptyState>
          ) : null}
          {overview.externalProposals.total > 0 ? (
            <p className="settings-note reminders-external">
              {message("memory.external.reviewHint", { count: overview.externalProposals.total })}{" "}
              <ActionButton variant="quiet" onClick={() => openMemoryPage()}>
                {message("memory.external.go")}
              </ActionButton>
            </p>
          ) : null}
          {proactive ? (
            <ProactiveReviewSection proactive={proactive} message={message} locale={locale} />
          ) : null}
          {overview.reminders.length ||
          overview.upcoming.length ||
          overview.cancelled.length ||
          mailCount ? (
            <p className="settings-note reminders-notify">{notifyNote}</p>
          ) : null}
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

function CarryCard({
  overview,
  memory,
  message,
  notify,
  onOpen,
}: {
  overview: MemoryOverview;
  memory: MemoryModel;
  message: Message;
  notify: (notice: Notice) => void;
  onOpen: (item: MemoryItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const items = new Map(overview.memories.map((item) => [item.memoryId, item]));
  const usage = overview.profileUsage;
  const count = overview.profile.reduce((total, section) => total + section.lines.length, 0);
  const queued = usage.queued.flatMap((id) => {
    const item = items.get(id);
    return item && live(item) && item.status === "active" ? [item] : [];
  });
  const off = overview.memories.filter(
    (item) => live(item) && item.status === "active" && item.profilePin === "off",
  );
  const title = message("memory.page.carry.title");
  const others = (heading: MessageId, list: readonly MemoryItem[], note: MessageId): ReactNode =>
    list.length ? (
      <div className="memory-carry-section">
        <h5>
          {message(heading)} <small>{message("memory.page.lines", { count: list.length })}</small>
        </h5>
        <p className="settings-note">{message(note)}</p>
        <ul className="memory-list">
          {list.map((item) => (
            <li key={item.memoryId} className="memory-carry-line">
              <button type="button" className="memory-line" onClick={() => onOpen(item)}>
                <span>{item.text}</span>
              </button>
              <PinSwitch
                item={item}
                carried={false}
                memory={memory}
                message={message}
                notify={notify}
                label={message("memory.page.pinFor", { text: item.text })}
              />
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <section className="memory-card memory-carry" aria-label={title}>
      <div className="memory-carry-head">
        <div>
          <h4>{title}</h4>
          <small>
            {message("memory.page.carry.summary", {
              count,
              used: usage.used,
              limit: usage.limit,
            })}
            {queued.length
              ? ` · ${message("memory.page.carry.queued", { count: queued.length })}`
              : ""}
          </small>
        </div>
        <ActionButton variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
          {message(open ? "memory.page.less" : "memory.page.carry.open")}
        </ActionButton>
      </div>
      {usage.pinned > usage.limit ? (
        <p className="settings-note" data-testid="memory-carry-pinned-over">
          {message("memory.page.carry.pinnedOver", {
            pinned: usage.pinned,
            limit: usage.limit,
            over: usage.pinned - usage.limit,
          })}
        </p>
      ) : null}
      <meter
        className="memory-carry-meter"
        min={0}
        max={usage.limit}
        value={usage.used}
        aria-label={message("memory.page.carry.meter")}
      />
      {open ? (
        <>
          <p className="settings-note">
            {message("memory.page.carry.note", { limit: usage.limit })}
          </p>
          {overview.profile.length ? null : (
            <p className="settings-note">{message("memory.page.carry.none")}</p>
          )}
          {overview.profile.map((section) => (
            <div className="memory-carry-section" key={section.kind}>
              <h5>
                {message(`memory.profile.${section.kind}`)}{" "}
                <small>{message("memory.page.lines", { count: section.lines.length })}</small>
              </h5>
              <ul className="memory-list">
                {section.lines.map((line) => {
                  const item = items.get(line.memoryId);
                  return (
                    <li key={line.memoryId} className="memory-carry-line">
                      <button
                        type="button"
                        className="memory-line"
                        disabled={!item}
                        onClick={() => item && onOpen(item)}
                      >
                        <span>{line.text}</span>
                        {item?.profilePin === "on" ? (
                          <span className="memory-tag" data-kind="carried">
                            {message("memory.page.carry.yours")}
                          </span>
                        ) : null}
                      </button>
                      {item ? (
                        <PinSwitch
                          item={item}
                          carried
                          memory={memory}
                          message={message}
                          notify={notify}
                          label={message("memory.page.pinFor", { text: line.text })}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {others("memory.page.carry.queuedTitle", queued, "memory.page.carry.queuedNote")}
          {others("memory.page.carry.offTitle", off, "memory.page.carry.offNote")}
        </>
      ) : count ? (
        <p className="memory-carry-kinds">
          {overview.profile.map((section) => (
            <span key={section.kind} className="memory-carry-kind">
              {message(`memory.profile.${section.kind}`)} <small>{section.lines.length}</small>
            </span>
          ))}
        </p>
      ) : (
        <p className="settings-note">{message("memory.page.carry.none")}</p>
      )}
    </section>
  );
}

function MemoryBrowser({
  memory,
  overview,
  message,
  notify,
  focus,
  since,
  initialOpen,
  addReady,
  adding,
  onAdd,
  onOpenThread,
}: {
  memory: MemoryModel;
  overview: MemoryOverview;
  addReady: boolean;
  adding: boolean;
  onAdd: () => void;
  message: Message;
  notify: (notice: Notice) => void;
  focus: readonly string[];
  since: string | null;
  initialOpen: string | null;
  onOpenThread: (threadId: string, messageId?: string) => void;
}) {
  const { moment: time } = useLocaleFormat();
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<Scope>({
    status: "active",
    category: "all",
    sub: null,
    fresh: false,
  });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const byId = new Map(overview.memories.map((item) => [item.memoryId, item]));
  const carried = new Set(
    overview.profile.flatMap((section) => section.lines.map((line) => line.memoryId)),
  );
  const reminders = new Map(
    overview.upcoming.map((item) => [
      item.memoryId,
      `${time(item.dueAt)}${item.repeat === "yearly" ? ` · ${message("memory.page.yearly")}` : ""}`,
    ]),
  );
  const visible = overview.memories.filter(live);
  const sinceAt = since ? Date.parse(since) : Number.NaN;
  const fresh = (item: MemoryItem) =>
    item.status === "active" && Date.parse(item.recordedAt) > sinceAt;
  const freshCount = visible.filter(fresh).length;
  const needle = search.trim().toLowerCase();
  const pool = visible.filter(
    (item) =>
      item.status === scope.status &&
      (!scope.fresh || fresh(item)) &&
      (!needle || item.text.toLowerCase().includes(needle)),
  );
  const topics = [...new Set(pool.map((item) => item.category))]
    .map((category) => {
      const rows = pool.filter((item) => item.category === category);
      const subs = [
        ...new Set(rows.flatMap((item) => (item.subCategory ? [item.subCategory] : []))),
      ]
        .map((sub) => ({ sub, count: rows.filter((item) => item.subCategory === sub).length }))
        .sort((a, b) => b.count - a.count);
      return { category, count: rows.length, subs };
    })
    .sort((a, b) => b.count - a.count);
  const rank = (a: MemoryItem, b: MemoryItem) =>
    Number(focus.includes(b.memoryId)) - Number(focus.includes(a.memoryId)) ||
    b.recordedAt.localeCompare(a.recordedAt);
  const shown = pool
    .filter(
      (item) =>
        (scope.category === "all" || item.category === scope.category) &&
        (scope.sub === null || item.subCategory === scope.sub),
    )
    .sort(rank);
  const go = (next: Partial<Scope>) => {
    setScope({ ...scope, ...next });
    setLimit(PAGE_SIZE);
    setTopicsOpen(false);
  };
  const grouped = scope.category === "all" && !needle && !scope.fresh && scope.status === "active";
  const line = (item: MemoryItem) => (
    <MemoryLine
      key={`${item.memoryId}:${item.revision}`}
      item={item}
      changes={changeCount(memoryChain(item, overview.memories))}
      reminder={reminders.has(item.memoryId)}
      carried={carried.has(item.memoryId)}
      justSaved={focus.includes(item.memoryId)}
      showTopic={scope.category === "all" && !grouped}
      message={message}
      onOpen={() => setOpenId(item.memoryId)}
    />
  );
  let opened = openId ? byId.get(openId) : undefined;
  while (opened?.supersededBy) opened = byId.get(opened.supersededBy);
  const topicName =
    scope.category === "all"
      ? message("memory.page.allTopics")
      : `${message("memory.cat", { c: scope.category })}${scope.sub ? ` · ${scope.sub}` : ""}`;
  const sourceCounts = memorySourceCounts(overview.memories);
  const archived = visible.filter((item) => item.status === "archived").length;
  const trashed = visible.filter((item) => item.status === "trashed").length;
  return (
    <>
      <CarryCard
        overview={overview}
        memory={memory}
        message={message}
        notify={notify}
        onOpen={(item) => setOpenId(item.memoryId)}
      />
      {since && freshCount && !scope.fresh && scope.status === "active" ? (
        <p className="memory-banner" data-kind="fresh">
          {message("memory.page.newSince", { count: freshCount })}{" "}
          <button type="button" className="memory-link" onClick={() => go({ fresh: true })}>
            {message("memory.page.showNew")}
          </button>
        </p>
      ) : null}
      {sourceCounts.unavailable ? (
        <p className="memory-banner" data-kind="source-unavailable">
          {message("memory.page.sourceUnavailableCount", { count: sourceCounts.unavailable })}
        </p>
      ) : null}
      {sourceCounts.importedWithoutQuote ? (
        <p className="memory-banner" data-kind="import-no-quote">
          {message("memory.page.importNoQuoteCount", {
            count: sourceCounts.importedWithoutQuote,
          })}
        </p>
      ) : null}
      <div className="memory-search-row">
        <input
          type="search"
          className="memory-search"
          aria-label={message("memory.search")}
          placeholder={message("memory.search")}
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setLimit(PAGE_SIZE);
          }}
        />
        <ActionButton
          variant="secondary"
          className="memory-add-button"
          disabled={!addReady}
          aria-expanded={adding}
          onClick={onAdd}
        >
          <Glyph name="plus" size={18} />
          {message("memory.page.add")}
        </ActionButton>
      </div>
      {scope.status === "active" ? null : (
        <p className="memory-banner" data-kind={scope.status}>
          {message("memory.page.group", { g: scope.status, count: pool.length })}{" "}
          <button
            type="button"
            className="memory-link"
            onClick={() => go({ status: "active", category: "all", sub: null })}
          >
            {message("memory.page.backToActive")}
          </button>
        </p>
      )}
      <div className="memory-browse">
        <button
          type="button"
          className="memory-topics-toggle"
          aria-expanded={topicsOpen}
          onClick={() => setTopicsOpen(!topicsOpen)}
        >
          {message("memory.page.topicNow", { topic: topicName })}
          <LineIcon name="chevron" />
        </button>
        <nav
          className="memory-topics"
          aria-label={message("memory.page.topics")}
          data-open={topicsOpen || undefined}
        >
          <button
            type="button"
            aria-pressed={scope.category === "all"}
            onClick={() => go({ category: "all", sub: null })}
          >
            {message("memory.page.allTopics")}
          </button>
          {topics.map((topic) => (
            <div key={topic.category}>
              <button
                type="button"
                aria-pressed={scope.category === topic.category && scope.sub === null}
                onClick={() => go({ category: topic.category, sub: null })}
              >
                {message("memory.cat", { c: topic.category })} <small>{topic.count}</small>
              </button>
              {scope.category === topic.category && topic.subs.length > 1
                ? topic.subs.map((entry) => (
                    <button
                      type="button"
                      key={entry.sub}
                      className="memory-topic-sub"
                      aria-pressed={scope.sub === entry.sub}
                      onClick={() => go({ category: topic.category, sub: entry.sub })}
                    >
                      {entry.sub} <small>{entry.count}</small>
                    </button>
                  ))
                : null}
            </div>
          ))}
        </nav>
        <div className="memory-results">
          <p className="memory-crumbs">
            {scope.fresh ? (
              <>
                <strong>{message("memory.page.newSince", { count: pool.length })}</strong>{" "}
                <button type="button" className="memory-link" onClick={() => go({ fresh: false })}>
                  {message("memory.page.clearNew")}
                </button>
              </>
            ) : (
              <>
                <strong>{topicName}</strong>{" "}
                <small>
                  {grouped
                    ? message("memory.page.groupedNote", {
                        count: shown.length,
                        preview: GROUP_PREVIEW,
                      })
                    : message("memory.page.lines", { count: shown.length })}
                </small>
              </>
            )}
          </p>
          {scope.category === "relationship" &&
          scope.status === "active" &&
          overview.people.length ? (
            <PeopleCard people={overview.people} overview={overview} message={message} />
          ) : null}
          {!shown.length ? (
            visible.length ? (
              <EmptyState title={message("memory.page.noResults")} />
            ) : (
              <EmptyState title={message("memory.emptyTitle")}>
                {message("memory.empty")}
              </EmptyState>
            )
          ) : grouped ? (
            topics.map((topic) => {
              const rows = shown.filter((item) => item.category === topic.category);
              return (
                <section key={topic.category} className="memory-topic-group">
                  <h5 className="memory-group">
                    {message("memory.cat", { c: topic.category })}{" "}
                    <small>{message("memory.page.lines", { count: rows.length })}</small>
                  </h5>
                  <ul className="memory-list">{rows.slice(0, GROUP_PREVIEW).map(line)}</ul>
                  {rows.length > GROUP_PREVIEW ? (
                    <button
                      type="button"
                      className="memory-link"
                      onClick={() => go({ category: topic.category, sub: null })}
                    >
                      {message("memory.page.seeAll", { count: rows.length })}
                    </button>
                  ) : null}
                </section>
              );
            })
          ) : (
            <>
              <ul className="memory-list">{shown.slice(0, limit).map(line)}</ul>
              {shown.length > limit ? (
                <button
                  type="button"
                  className="memory-link memory-load-more"
                  onClick={() => setLimit(limit + PAGE_SIZE)}
                >
                  {message("memory.page.loadMore", {
                    count: Math.min(PAGE_SIZE, shown.length - limit),
                  })}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
      <p className="memory-status-links">
        {scope.status !== "archived" && archived ? (
          <button
            type="button"
            className="memory-link"
            onClick={() => go({ status: "archived", category: "all", sub: null, fresh: false })}
          >
            {message("memory.page.statusLink", { s: "archived", count: archived })}
          </button>
        ) : null}
        {scope.status !== "trashed" && trashed ? (
          <button
            type="button"
            className="memory-link"
            onClick={() => go({ status: "trashed", category: "all", sub: null, fresh: false })}
          >
            {message("memory.page.statusLink", { s: "trashed", count: trashed })}
          </button>
        ) : null}
      </p>
      {opened ? (
        <MemoryDetail
          key={opened.memoryId}
          item={opened}
          chain={memoryChain(opened, overview.memories)}
          reminder={reminders.get(opened.memoryId) ?? null}
          carried={carried.has(opened.memoryId)}
          memory={memory}
          message={message}
          notify={notify}
          onOpenThread={onOpenThread}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}

function TimelineTab({
  memory,
  message,
  onConfirm,
  onShowMemory,
}: {
  memory: MemoryModel;
  message: Message;
  onConfirm: () => void;
  onShowMemory: (memoryId: string) => void;
}) {
  const { dayHeading } = useLocaleFormat();
  const [filter, setFilter] = useState("all");
  const overview = memory.overview;
  if (!overview) return null;
  type Event = {
    key: string;
    at: string;
    type: "new" | "tidy" | "correct" | "import" | "drop";
    kind: string;
    text: string;
    note?: string;
    undone?: boolean;
    undo?: () => void;
    locked?: boolean;
    confirm?: boolean;
    change?: number;
    show?: () => void;
  };
  const waiting = new Set(
    overview.memories.filter((item) => item.tentative).map((item) => item.memoryId),
  );
  const everything: Event[] = [
    ...memoryHeads(overview.memories).flatMap((head) =>
      memoryChain(head, overview.memories).flatMap((node): Event[] =>
        node.kind === "reaffirmed" || (node.change === 0 && node.record.importBatchId)
          ? []
          : node.change === 0
            ? [{ key: node.key, at: node.at, type: "new", kind: "new", text: node.text }]
            : [
                {
                  key: node.key,
                  at: node.at,
                  type: "correct",
                  kind: "correct",
                  text: message("memory.page.nowIs", { text: node.text }),
                  change: node.change,
                  show: () => onShowMemory(head.memoryId),
                },
              ],
      ),
    ),
    ...memoryHeads(overview.memories)
      .filter((head) => head.status === "trashed")
      .map(
        (head): Event => ({
          key: `${head.memoryId}:dropped`,
          at: head.updatedAt,
          type: "drop",
          kind: head.tentative ? "dropped" : "deleted",
          text: head.text,
          undo: () => void memory.recover(head),
        }),
      ),
    ...overview.tidyUps.map(
      (item): Event => ({
        key: item.changeId,
        at: item.createdAt,
        type: "tidy",
        kind: item.action,
        text: item.text,
        note: item.relatedText
          ? message(item.action === "hold" ? "memory.tidyOther" : "memory.tidyKept", {
              text: item.relatedText,
            })
          : "",
        undone: item.undone,
        ...(!item.undone && !item.undoable
          ? { locked: true }
          : item.action === "hold" && !waiting.has(item.memoryId)
            ? {}
            : { undo: () => void memory.undoTidy(item) }),
        confirm:
          (item.action === "reflect" || item.action === "hold") && waiting.has(item.memoryId),
      }),
    ),
    ...overview.conversationReviews.map((item): Event => {
      const count = (action: string) =>
        item.changes.filter((change) => change.action === action).length;
      return {
        key: item.reviewId,
        at: item.finishedAt,
        type: "tidy",
        kind: "review",
        text: message("memory.page.reviewed", {
          created: count("created"),
          superseded: count("superseded"),
          confirmed: count("confirmed"),
        }),
        note: item.changes
          .flatMap(({ memoryId, action }) => {
            const found = overview.memories.find((entry) => entry.memoryId === memoryId);
            if (!found) return [];
            const quote = found.history.find((entry) => entry.quote)?.quote ?? null;
            return [
              message("memory.page.reviewItem", { action, text: found.text }) +
                (quote ? message("memory.page.reviewQuote", { quote }) : ""),
            ];
          })
          .join(" "),
        undone: item.undone,
        ...(!item.undone && !item.undoable
          ? { locked: true }
          : { undo: () => void memory.undoReview(item) }),
      };
    }),
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
    const day = dayHeading(event.at);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  return (
    <>
      <Chips
        items={(["all", "new", "drop", "tidy", "correct", "import"] as const).map((key) => ({
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
                {event.change ? (
                  <small>
                    {message("memory.page.changeNo", { n: event.change })}
                    {" · "}
                    <button type="button" className="memory-link" onClick={event.show}>
                      {message("memory.page.seeAllChanges")}
                    </button>
                  </small>
                ) : null}
              </span>
              {event.undone ? (
                <small>{message("memory.undone")}</small>
              ) : event.locked ? (
                <small>{message("memory.undoLocked")}</small>
              ) : event.undo ? (
                <ActionButton variant="quiet" disabled={memory.busy} onClick={event.undo}>
                  {message("memory.undo")}
                </ActionButton>
              ) : null}
              {event.confirm ? (
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
  const [error, setError] = useState("");
  const round = useRef(0);
  const load = (parsed: readonly ImportParse[]) => {
    const all = parsed.flatMap((entry) => entry.items).slice(0, MAXIMUM_IMPORT_ITEMS);
    const current = ++round.current;
    setItems(all);
    setError(all.length ? "" : message("memory.page.importEmpty"));
    if (!all.length) return;
    const waiting = all.filter((item) => item.status === "classifying").map((item) => item.text);
    void (async () => {
      const classifications = waiting.length ? await memory.classify(waiting) : [];
      if (round.current !== current) return;
      const sorted = applyImportClassifications(all, classifications);
      setItems(sorted);
      const askable = sorted.filter((item) => !item.sensitive && item.status === "ready");
      const answers = askable.length
        ? await memory.importDuplicates(askable.map((item) => item.text))
        : [];
      if (round.current !== current) return;
      let next = 0;
      const verdicts = sorted.map((item) => {
        if (item.sensitive || item.status !== "ready") return "skipped" as const;
        const verdict = answers[next] ?? "skipped";
        next += 1;
        return verdict;
      });
      setItems(applyImportDuplicates(sorted, verdicts));
    })();
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
    round.current += 1;
    setSource(null);
    setItems([]);
    setError("");
    setPasted("");
  };
  const chosen = items.filter((item) => item.checked);
  const classifying = items.some(
    (item) => item.status === "classifying" || item.duplicateCheck === "pending",
  );
  const prompt = message("memory.page.aiPrompt");
  return (
    <section className="memory-card memory-import" ref={reveal}>
      <h4>
        {message("memory.page.import")}{" "}
        <ActionButton variant="quiet" onClick={onClose}>
          {message("memory.page.less")}
        </ActionButton>
      </h4>
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
                    disabled={
                      item.duplicate ||
                      item.status === "classifying" ||
                      item.duplicateCheck === "pending"
                    }
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
                      {item.sensitive ||
                      item.duplicate ||
                      item.coding ||
                      item.duplicateCheck !== "clear" ||
                      item.status === "classifying" ? (
                        <span className="memory-tag" data-kind="sensitive">
                          {message("memory.page.importFlag", {
                            f: item.duplicate
                              ? "duplicate"
                              : item.status === "classifying" || item.duplicateCheck === "pending"
                                ? "classifying"
                                : item.status === "unclassified"
                                  ? "unclassified"
                                  : item.sensitive
                                    ? "sensitive"
                                    : item.duplicateCheck === "similar"
                                      ? "similar"
                                      : item.duplicateCheck === "unchecked"
                                        ? "unchecked"
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
          <div className="actions">
            <ActionButton
              disabled={memory.busy || classifying || !chosen.length || !source}
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
                    parseMemoryText(message("memory.page.sourceTitle", { s: "assistant" }), pasted),
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
                      ? parseMemoryText(name, text)
                      : parseMemoryExport(name, text),
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

function ExportPanel({ message, onClose }: { message: Message; onClose: () => void }) {
  const [state, setState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "working" }
    | {
        readonly kind: "done";
        readonly memories: number;
        readonly rules: number;
        readonly withheld: number;
      }
    | { readonly kind: "failed" }
  >({ kind: "idle" });
  const download = async () => {
    setState({ kind: "working" });
    try {
      const result = await requestDataExport();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(result.blob);
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(link.href);
      setState({
        kind: "done",
        memories: result.memories,
        rules: result.rules,
        withheld: result.withheld,
      });
    } catch {
      setState({ kind: "failed" });
    }
  };
  return (
    <section className="memory-card" ref={reveal}>
      <h4>{message("memory.page.exportTitle")}</h4>
      <p>{message("memory.page.exportNote")}</p>
      <div className="actions">
        <ActionButton disabled={state.kind === "working"} onClick={download}>
          {message("memory.page.download")}
        </ActionButton>
        <ActionButton variant="quiet" onClick={onClose}>
          {message("memory.page.less")}
        </ActionButton>
      </div>
      {state.kind === "working" ? <output>{message("memory.page.exportWorking")}</output> : null}
      {state.kind === "done" ? (
        <output>
          {message("memory.page.exportDone", {
            count: state.memories,
            rules: state.rules,
            withheld: state.withheld,
          })}
        </output>
      ) : null}
      {state.kind === "failed" ? <p role="alert">{message("memory.page.exportFailed")}</p> : null}
    </section>
  );
}

function ChatExportPanel({ message, onClose }: { message: Message; onClose: () => void }) {
  const [state, setState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "working" }
    | {
        readonly kind: "done";
        readonly threads: number;
        readonly messages: number;
        readonly withheld: number;
      }
    | { readonly kind: "failed"; readonly tooLarge: boolean }
  >({ kind: "idle" });
  const download = async () => {
    setState({ kind: "working" });
    try {
      const result = await requestChatExport();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(result.blob);
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(link.href);
      setState({
        kind: "done",
        threads: result.threads,
        messages: result.messages,
        withheld: result.withheld,
      });
    } catch (error) {
      setState({
        kind: "failed",
        tooLarge: error instanceof Error && error.message === "CHAT_EXPORT_TOO_LARGE",
      });
    }
  };
  return (
    <section className="memory-card" ref={reveal}>
      <h4>{message("memory.page.chatExportTitle")}</h4>
      <p>{message("memory.page.chatExportNote")}</p>
      <div className="actions">
        <ActionButton disabled={state.kind === "working"} onClick={download}>
          {message("memory.page.chatDownload")}
        </ActionButton>
        <ActionButton variant="quiet" onClick={onClose}>
          {message("memory.page.less")}
        </ActionButton>
      </div>
      {state.kind === "working" ? <output>{message("memory.page.exportWorking")}</output> : null}
      {state.kind === "done" ? (
        <output>
          {message("memory.page.chatExportDone", {
            threads: state.threads,
            messages: state.messages,
            withheld: state.withheld,
          })}
        </output>
      ) : null}
      {state.kind === "failed" ? (
        <p role="alert">
          {message(state.tooLarge ? "memory.page.chatExportTooLarge" : "memory.page.exportFailed")}
        </p>
      ) : null}
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
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<MemoryCategory | null>(null);
  const [pinned, setPinned] = useState(false);
  const pinnable = picked === null || PINNABLE.has(picked);
  const save = () =>
    void memory
      .create(text.trim(), picked, (category) => pinned && PINNABLE.has(category))
      .then((category) => {
        if (category === null) return;
        notify({
          text: message("memory.page.added", {
            cat: message("memory.cat", { c: category }),
            pinned: String(pinned && PINNABLE.has(category)),
          }),
        });
        onDone();
      });
  return (
    <section className="memory-card" data-kind="add">
      <strong>{message("memory.page.addTitle")}</strong>
      <div className="memory-editor">
        <textarea
          aria-label={message("memory.page.addTitle")}
          maxLength={500}
          placeholder={message("memory.page.addPlaceholder")}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <div className="memory-add-options">
          <label>
            {message("memory.page.topic")}
            <select
              value={picked ?? ""}
              onChange={(event) =>
                setPicked(
                  event.currentTarget.value === ""
                    ? null
                    : (event.currentTarget.value as MemoryCategory),
                )
              }
            >
              <option value="">{message("memory.page.autoCategory")}</option>
              {MEMORY_CATEGORY_NAMES.map((key) => (
                <option key={key} value={key}>
                  {message("memory.cat", { c: key })}
                </option>
              ))}
            </select>
          </label>
          <label className="memory-switch">
            {message("memory.page.pin")}
            <input
              type="checkbox"
              role="switch"
              aria-checked={pinned && pinnable}
              checked={pinned && pinnable}
              disabled={!pinnable}
              onChange={() => setPinned(!pinned)}
            />
          </label>
        </div>
        <small className="settings-note">
          {message("memory.page.pinHint", {
            r: pinnable ? "add" : "category",
          })}
        </small>
        <div className="actions">
          <ActionButton disabled={memory.busy || !text.trim()} onClick={save}>
            {message("memory.save")}
          </ActionButton>
          <ActionButton variant="quiet" disabled={memory.busy} onClick={onDone}>
            {message("governed.cancel")}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

export function MemoryPage({
  memory,
  message,
  focus = [],
  onOpenThread,
}: {
  memory: MemoryModel | null;
  message: Message;
  focus?: readonly string[];
  onOpenThread: (threadId: string, messageId?: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("memories");
  const [showId, setShowId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"add" | "import" | "export" | "chats" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [since, setSince] = useState<string | null | undefined>(undefined);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const loaded = memory?.overview ? memory.overview.lastViewedAt : undefined;
  const markViewed = memory?.markViewed;
  useEffect(() => {
    if (loaded === undefined || since !== undefined || !markViewed) return;
    setSince(loaded);
    void markViewed();
  }, [loaded, since, markViewed]);
  if (!memory) return <p>{message("common.notConfigured")}</p>;
  const overview = memory.overview;
  const notify = (next: Notice) => {
    window.clearTimeout(timer.current);
    setNotice(next);
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  };
  const memories = overview?.memories.filter(live) ?? [];
  const active = memories.filter((item) => item.status === "active");
  const paused = overview?.capturePaused ?? false;
  const ready = overview?.manualAddReady ?? false;
  const tabs: { key: Tab; count?: string }[] = [
    { key: "memories", ...(overview ? { count: String(active.length) } : {}) },
    { key: "changes" },
  ];
  return (
    <section className="memory-page side-page-body">
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
      <ExternalProposalsSection memory={memory} message={message} />
      <ConfirmSection memory={memory} message={message} />
      <OwnerRulesSection memory={memory} message={message} />
      <OwnerAllowancesSection memory={memory} message={message} />
      <BuiltInActionRulesSection memory={memory} message={message} />
      <CorrectionReviewSection
        memory={memory}
        message={message}
        onOpenMemory={(memoryId) => {
          setShowId(memoryId);
          setTab("memories");
        }}
      />
      <div role="tablist" className="memory-tabs" aria-label={message("nav.memory")}>
        {tabs.map((item) => (
          <button
            type="button"
            role="tab"
            key={item.key}
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {message("memory.page.tab", { t: item.key })}
            {item.count ? <small>{item.count}</small> : null}
          </button>
        ))}
      </div>
      {!overview ? (
        <p>{message("state.loading")}</p>
      ) : tab === "memories" ? (
        <MemoryBrowser
          key={showId ?? ""}
          memory={memory}
          overview={overview}
          message={message}
          notify={notify}
          focus={focus}
          since={since ?? null}
          initialOpen={showId}
          addReady={ready}
          adding={panel === "add"}
          onAdd={() => setPanel(panel === "add" ? null : "add")}
          onOpenThread={onOpenThread}
        />
      ) : (
        <TimelineTab
          memory={memory}
          message={message}
          onConfirm={() => reveal(document.getElementById("memory-confirm"))}
          onShowMemory={(memoryId) => {
            setShowId(memoryId);
            setTab("memories");
          }}
        />
      )}
      <footer className="memory-footer">
        <span>
          {(["import", "export", "chats"] as const).map((key) => (
            <ActionButton
              key={key}
              variant="quiet"
              disabled={key === "import" && !ready}
              aria-expanded={panel === key}
              onClick={() => setPanel(panel === key ? null : key)}
            >
              {message(key === "chats" ? "memory.page.chatExport" : `memory.page.${key}`)}
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
        <ExportPanel message={message} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "chats" && overview ? (
        <ChatExportPanel message={message} onClose={() => setPanel(null)} />
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
