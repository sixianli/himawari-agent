import { useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryItem, MemoryModel, PendingMemory } from "../memory.js";
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

function MemoryRow({
  item,
  memory,
  message,
  onOpenThread,
}: {
  item: MemoryItem;
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
            {new Date(item.updatedAt).toLocaleDateString()}
          </small>
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
  const memories =
    overview?.memories.filter((item) => !needle || item.text.toLowerCase().includes(needle)) ?? [];
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
      {overview?.memories.length ? (
        <p className="settings-note">
          {message("memory.count", { count: overview.memories.length })}
        </p>
      ) : null}
      <p className="settings-note">{message("memory.note")}</p>
    </section>
  );
}
