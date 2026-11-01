import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryModel } from "../memory.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

export function AutoMemorySetting({
  memory,
  message,
}: {
  readonly memory: MemoryModel;
  readonly message: Message;
}) {
  const overview = memory.overview;
  const paused = overview?.capturePaused ?? false;
  return (
    <label className="setting-row">
      <span>{message("memory.page.auto")}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={message("memory.page.auto")}
        aria-checked={!paused}
        checked={!paused}
        disabled={memory.busy || !overview}
        onChange={() => void memory.setPaused(!paused)}
      />
    </label>
  );
}
