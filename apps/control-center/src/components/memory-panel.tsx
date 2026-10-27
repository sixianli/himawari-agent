import { useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryModel, MemoryReminder, PendingMemory } from "../memory.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

export const OPEN_MEMORY_SETTINGS = "himawari:open-memory-settings";

export const OPEN_NOTIFICATION_SETTINGS = "himawari:open-notification-settings";

export function openMemorySettings(memoryIds: readonly string[] = []) {
  window.dispatchEvent(new CustomEvent(OPEN_MEMORY_SETTINGS, { detail: memoryIds }));
}

export function focusedMemoryIds(event: Event): readonly string[] {
  return event instanceof CustomEvent && Array.isArray(event.detail) ? event.detail : [];
}

export function openNotificationSettings() {
  window.dispatchEvent(new Event(OPEN_NOTIFICATION_SETTINGS));
}

export function TextEditor({
  initial,
  placeholder,
  busy,
  message,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
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
        placeholder={placeholder}
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

export function MemoryReminders({ memory, message }: { memory: MemoryModel; message: Message }) {
  const items: readonly MemoryReminder[] = memory.overview?.reminders ?? [];
  if (!items.length) return null;
  const time = (value: string) =>
    new Date(value).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <aside className="memory-reminders" aria-live="polite">
      {items.map((item) => (
        <section className="memory-reminder" key={item.reminderId}>
          <strong>{message("memory.reminderTitle")}</strong>
          <p className="memory-text">{item.text}</p>
          <small>{message("memory.reminderDue", { time: time(item.dueAt) })}</small>
          <div className="actions">
            <ActionButton
              disabled={memory.busy}
              onClick={() => void memory.respondReminder(item, "dismiss")}
            >
              {message("memory.reminderDismiss")}
            </ActionButton>
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void memory.respondReminder(item, "snooze")}
            >
              {message("memory.reminderSnooze")}
            </ActionButton>
          </div>
        </section>
      ))}
    </aside>
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
        <button
          type="button"
          className="memory-saved"
          onClick={() => openMemorySettings(saved.map((item) => item.memoryId))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4.5h10v15.5l-5-3.5-5 3.5z" />
          </svg>
          <span>{message("memory.saved", { count: saved.length })}</span>
          <span className="memory-saved-link">{message("memory.view")}</span>
        </button>
      ) : null}
    </div>
  );
}
