import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryModel, MemoryReview } from "../memory.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

interface FlaggedMemory {
  readonly memoryId: string;
  readonly text: string | null;
  readonly sources: MemoryReview["memories"];
}

function byMemory(items: MemoryReview["memories"]): readonly FlaggedMemory[] {
  const groups = new Map<string, FlaggedMemory>();
  for (const item of items) {
    const group = groups.get(item.memoryId);
    groups.set(item.memoryId, {
      memoryId: item.memoryId,
      text: item.text,
      sources: [...(group?.sources ?? []), item],
    });
  }
  return [...groups.values()];
}

export function CorrectionReviewSection({
  memory,
  message,
  onOpenMemory,
}: {
  memory: Pick<MemoryModel, "review" | "respondReview" | "busy">;
  message: Message;
  onOpenMemory: (memoryId: string) => void;
}) {
  const review = memory.review;
  if (!review) return null;
  const memories = byMemory(review.memories);
  const count = memories.length + review.rules.length;
  if (!count) return null;
  return (
    <section
      id="memory-review"
      className="memory-confirm"
      aria-label={message("review.title", { count })}
    >
      <h4>{message("review.title", { count })}</h4>
      <p className="settings-note">{message("review.note")}</p>
      {review.rules.map((rule) => (
        <section className="memory-card" key={rule.ruleId} data-review-rule={rule.ruleId}>
          <span className="memory-tag" data-kind="rule">
            {message("memory.page.kind", { k: "rule" })}
          </span>
          <small>
            {" "}
            {rule.suspendReason
              ? message("review.suspendReason", { r: rule.suspendReason })
              : message(rule.rechecking ? "review.checking" : "review.notChecking")}
            {rule.suspendReason && rule.rechecking ? ` ${message("review.rechecking")}` : null}
          </small>
          <p className="memory-text">{rule.summary}</p>
          {rule.suggestion ? (
            <p className="settings-note">{message("review.suggestion", { s: rule.suggestion })}</p>
          ) : null}
          {rule.suggestion
            ? rule.suggestionConditions.map((condition) => (
                <small key={condition.field} data-review-condition={condition.field}>
                  {message("review.condition", {
                    f: condition.field,
                    v: condition.values.join("、"),
                  })}{" "}
                </small>
              ))
            : null}
          <div className="actions">
            {rule.status === "suspended" && rule.suggestion ? (
              <ActionButton
                disabled={memory.busy}
                onClick={() => void memory.respondReview(rule.ruleId, "adopt", rule.revision)}
              >
                {message("review.adopt")}
              </ActionButton>
            ) : null}
            {rule.status === "suspended" ? (
              <ActionButton
                variant="secondary"
                disabled={memory.busy}
                onClick={() =>
                  void memory.respondReview(rule.ruleId, "confirm_suspended", rule.revision)
                }
              >
                {message("review.confirmSuspended")}
              </ActionButton>
            ) : null}
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void memory.respondReview(rule.ruleId, "restore", rule.revision)}
            >
              {message(rule.status === "suspended" ? "review.restore" : "review.dismiss")}
            </ActionButton>
          </div>
        </section>
      ))}
      {memories.map((item) => (
        <section className="memory-card" key={item.memoryId} data-review-memory={item.memoryId}>
          <span className="memory-tag" data-kind="inferred">
            {message("memory.page.kind", { k: "inferred" })}
          </span>
          {item.sources.map((source) => (
            <small key={source.upstreamMemoryId} data-review-upstream={source.upstreamMemoryId}>
              {" "}
              {message("review.reason", { r: source.reason })}
              {" · "}
              {source.upstreamText
                ? message("review.upstream", { t: source.upstreamText })
                : message("review.upstreamGone")}
            </small>
          ))}
          {item.sources.some(({ truncated }) => truncated) ? (
            <small data-review-truncated=""> {message("review.truncated")}</small>
          ) : null}
          <p className="memory-text">{item.text ?? message("review.textGone")}</p>
          <div className="actions">
            <ActionButton variant="secondary" onClick={() => onOpenMemory(item.memoryId)}>
              {message("review.open")}
            </ActionButton>
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void memory.respondReview(item.memoryId, "dismiss", null)}
            >
              {message("review.dismiss")}
            </ActionButton>
          </div>
        </section>
      ))}
    </section>
  );
}
