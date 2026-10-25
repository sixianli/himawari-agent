import { useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryItem, MemoryModel, MemoryTidyUp, PendingMemory } from "../memory.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

export const OPEN_MEMORY_SETTINGS = "himawari:open-memory-settings";

export function openMemorySettings() {
  window.dispatchEvent(new Event(OPEN_MEMORY_SETTINGS));
}

function TextEditor({
  initial,
  busy,
  message,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  message: Message;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="memory-editor">
      <textarea
        aria-label={message("memory.editAction")}
        maxLength={500}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <div className="actions">
        <ActionButton disabled={busy || !text.trim()} onClick={() => onSave(text.trim())}>
          {message("memory.save")}
        </ActionButton>
        <ActionButton variant="quiet" disabled={busy} onClick={onCancel}>
          {message("governed.cancel")}
        </ActionButton>
      </div>
    </div>
  );
}

export function MemoryApprovalCard({
  item,
  memory,
  message,
}: {
  item: PendingMemory;
  memory: MemoryModel;
  message: Message;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="approval-inline memory-approval" aria-label={message("memory.proposal")}>
      <strong>{message("memory.proposal")}</strong>
      {editing ? (
        <TextEditor
          initial={item.text}
          busy={memory.busy}
          message={message}
          onCancel={() => setEditing(false)}
          onSave={(text) => void memory.respond(item, "edited", text)}
        />
      ) : (
        <>
          <p className="memory-text">{item.text}</p>
          <p className="settings-note">
            {message("memory.pendingReason", { topic: message(`memory.topic.${item.topic}`) })}
          </p>
          <div className="actions">
            <ActionButton
              disabled={memory.busy}
              onClick={() => void memory.respond(item, "approved")}
            >
              {message("memory.approve")}
            </ActionButton>
            <ActionButton variant="quiet" disabled={memory.busy} onClick={() => setEditing(true)}>
              {message("memory.edit")}
            </ActionButton>
            <ActionButton
              variant="secondary"
              disabled={memory.busy}
              onClick={() => void memory.respond(item, "rejected")}
            >
              {message("memory.reject")}
            </ActionButton>
          </div>
        </>
      )}
    </section>
  );
}

export function MemoryTurnNote({
  ownerRefs,
  memory,
  message,
}: {
  ownerRefs: readonly string[];
  memory: MemoryModel;
  message: Message;
}) {
  const overview = memory.overview;
  if (!overview || ownerRefs.length === 0) return null;
  const pending = overview.pending.filter((item) => ownerRefs.includes(item.sourceRef));
  const saved = overview.memories.filter((item) =>
    item.sourceRefs.some((ref) => ownerRefs.includes(ref)),
  );
  if (!pending.length && !saved.length) return null;
  return (
    <div className="memory-turn">
      {pending.map((item) => (
        <MemoryApprovalCard key={item.requestId} item={item} memory={memory} message={message} />
      ))}
      {saved.length ? (
        <details className="memory-saved">
          <summary>{message("memory.saved", { count: saved.length })}</summary>
          <ul>
            {saved.map((item) => (
              <li key={item.memoryId}>{item.text}</li>
            ))}
          </ul>
          <ActionButton variant="quiet" onClick={openMemorySettings}>
            {message("memory.manage")}
          </ActionButton>
        </details>
      ) : null}
    </div>
  );
}

const RECENT_MS = 7 * 86_400_000;
const day = (value: string) => new Date(value).toLocaleDateString();

function MemoryProfile({ memory, message }: { memory: MemoryModel; message: Message }) {
  const overview = memory.overview;
  const [editing, setEditing] = useState<string | null>(null);
  if (!overview?.profile.length) return null;
  const items = new Map(overview.memories.map((item) => [item.memoryId, item]));
  const now = Date.now();
  return (
    <details className="memory-profile" open>
      <summary>{message("memory.profileTitle")}</summary>
      {overview.profile.map((section) => (
        <section key={section.kind}>
          <h5>{message(`memory.profile.${section.kind}`)}</h5>
          <ul>
            {section.lines.map((line) => {
              const item = items.get(line.memoryId);
              return (
                <li key={line.memoryId}>
                  {editing === line.memoryId && item ? (
                    <TextEditor
                      initial={item.text}
                      busy={memory.busy}
                      message={message}
                      onCancel={() => setEditing(null)}
                      onSave={(text) =>
                        void memory.correct(item, text).then((ok) => ok && setEditing(null))
                      }
                    />
                  ) : (
                    <>
                      {line.text}
                      {now - new Date(line.updatedAt).valueOf() < RECENT_MS ? (
                        <small className="memory-new"> {message("memory.recent")}</small>
                      ) : null}
                      {item ? (
                        <ActionButton variant="quiet" onClick={() => setEditing(line.memoryId)}>
                          {message("memory.editAction")}
                        </ActionButton>
                      ) : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="settings-note">{message("memory.profileNote")}</p>
    </details>
  );
}

function MemoryHistory({
  items,
  memory,
  message,
}: {
  items: readonly MemoryItem[];
  memory: MemoryModel;
  message: Message;
}) {
  if (!items.length) return null;
  return (
    <details className="memory-history">
      <summary>{message("memory.history", { count: items.length })}</summary>
      <ul>
        {items.map((item) => (
          <li key={item.memoryId}>
            <s>{item.text}</s>
            {item.validTo ? (
              <small> {message("memory.until", { date: day(item.validTo) })}</small>
            ) : null}
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void memory.restore(item)}
            >
              {message("memory.restore")}
            </ActionButton>
          </li>
        ))}
      </ul>
    </details>
  );
}

function MemoryTentative({
  items,
  memory,
  message,
}: {
  items: readonly MemoryItem[];
  memory: MemoryModel;
  message: Message;
}) {
  if (!items.length) return null;
  return (
    <>
      <h4>{message("memory.tentativeTitle", { count: items.length })}</h4>
      <p className="settings-note">{message("memory.tentativeNote")}</p>
      <ul className="memory-list">
        {items.map((item) => (
          <li key={item.memoryId} className="memory-row">
            <p className="memory-text">{item.text}</p>
            <div className="actions">
              <ActionButton disabled={memory.busy} onClick={() => void memory.confirm(item)}>
                {message("memory.confirm")}
              </ActionButton>
              <ActionButton
                variant="secondary"
                disabled={memory.busy}
                onClick={() => void memory.remove(item)}
              >
                {message("memory.reject")}
              </ActionButton>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function MemoryTidyUps({
  items,
  memory,
  message,
}: {
  items: readonly MemoryTidyUp[];
  memory: MemoryModel;
  message: Message;
}) {
  if (!items.length) return null;
  return (
    <details className="memory-history memory-tidy">
      <summary>{message("memory.tidyTitle", { count: items.length })}</summary>
      <ul>
        {items.map((item) => (
          <li key={item.changeId}>
            <strong>{message(`memory.tidy.${item.action}`)}</strong> {item.text}
            {item.relatedText ? (
              <small> {message("memory.tidyKept", { text: item.relatedText })}</small>
            ) : null}
            <small> · {day(item.createdAt)}</small>
            {item.undone ? (
              <small> · {message("memory.undone")}</small>
            ) : (
              <ActionButton
                variant="quiet"
                disabled={memory.busy}
                onClick={() => void memory.undoTidy(item)}
              >
                {message("memory.undo")}
              </ActionButton>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function MemoryRow({
  item,
  history,
  memory,
  message,
  onOpenThread,
}: {
  item: MemoryItem;
  history: readonly MemoryItem[];
  memory: MemoryModel;
  message: Message;
  onOpenThread: (threadId: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  return (
    <li className="memory-row">
      {mode === "edit" ? (
        <TextEditor
          initial={item.text}
          busy={memory.busy}
          message={message}
          onCancel={() => setMode("view")}
          onSave={(text) => void memory.correct(item, text).then((ok) => ok && setMode("view"))}
        />
      ) : (
        <>
          <p className="memory-text">{item.text}</p>
          <small className="setting-description">
            {item.dataClassification === "sensitive" || item.topic
              ? `${message("memory.sensitive")} · `
              : ""}
            {item.inference ? `${message("memory.inferred")} · ` : ""}
            {day(item.updatedAt)}
            {item.validTo ? ` · ${message("memory.until", { date: day(item.validTo) })}` : ""}
          </small>
          <MemoryHistory items={history} memory={memory} message={message} />
          {mode === "delete" ? (
            <div className="actions" role="alert">
              <span>{message("memory.deleteConfirm")}</span>
              <ActionButton
                variant="secondary"
                disabled={memory.busy}
                onClick={() => void memory.remove(item)}
              >
                {message("memory.deleteAction")}
              </ActionButton>
              <ActionButton variant="quiet" onClick={() => setMode("view")}>
                {message("governed.cancel")}
              </ActionButton>
            </div>
          ) : (
            <div className="actions">
              {item.sourceThreadId ? (
                <ActionButton
                  variant="quiet"
                  onClick={() => item.sourceThreadId && onOpenThread(item.sourceThreadId)}
                >
                  {message("memory.source")}
                </ActionButton>
              ) : null}
              <ActionButton variant="quiet" onClick={() => setMode("edit")}>
                {message("memory.editAction")}
              </ActionButton>
              <ActionButton variant="quiet" onClick={() => setMode("delete")}>
                {message("memory.deleteAction")}
              </ActionButton>
            </div>
          )}
        </>
      )}
    </li>
  );
}

export function MemorySettings({
  memory,
  message,
  onOpenThread,
}: {
  memory: MemoryModel | null;
  message: Message;
  onOpenThread: (threadId: string) => void;
}) {
  const [search, setSearch] = useState("");
  if (!memory) return <p>{message("common.notConfigured")}</p>;
  const overview = memory.overview;
  const needle = search.trim().toLowerCase();
  const all = overview?.memories ?? [];
  const history = new Map<string, MemoryItem[]>();
  for (const item of all) {
    if (!item.supersededBy) continue;
    history.set(item.supersededBy, [...(history.get(item.supersededBy) ?? []), item]);
  }
  const live = all.filter((item) => !item.supersededBy && !item.tentative);
  const tentative = all.filter((item) => !item.supersededBy && item.tentative);
  const memories = live.filter((item) => !needle || item.text.toLowerCase().includes(needle));
  return (
    <section className="memory-settings">
      <h3>{message("review.settings.memory")}</h3>
      {memory.failed ? <p role="alert">{message("error.currentUnavailable")}</p> : null}
      {overview?.pending.length ? (
        <>
          <h4>{message("memory.pendingTitle", { count: overview.pending.length })}</h4>
          {overview.pending.map((item) => (
            <MemoryApprovalCard
              key={item.requestId}
              item={item}
              memory={memory}
              message={message}
            />
          ))}
        </>
      ) : null}
      <MemoryTentative items={tentative} memory={memory} message={message} />
      <MemoryProfile memory={memory} message={message} />
      <input
        type="search"
        className="memory-search"
        aria-label={message("memory.search")}
        placeholder={message("memory.search")}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {!overview ? (
        <p>{message("state.loading")}</p>
      ) : memories.length ? (
        <ul className="memory-list">
          {memories.map((item) => (
            <MemoryRow
              key={`${item.memoryId}:${item.revision}`}
              item={item}
              history={history.get(item.memoryId) ?? []}
              memory={memory}
              message={message}
              onOpenThread={onOpenThread}
            />
          ))}
        </ul>
      ) : (
        <p className="settings-note">
          {needle ? message("common.noRecords") : message("memory.empty")}
        </p>
      )}
      {live.length ? (
        <p className="settings-note">{message("memory.count", { count: live.length })}</p>
      ) : null}
      <MemoryTidyUps items={overview?.tidyUps ?? []} memory={memory} message={message} />
      <p className="settings-note">{message("memory.note")}</p>
    </section>
  );
}
