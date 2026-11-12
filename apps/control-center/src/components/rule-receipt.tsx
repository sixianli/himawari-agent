import { useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryModel, OwnerRuleAction } from "../memory.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

interface Trial {
  readonly from: string;
  readonly subject: string;
  readonly hit: boolean;
}

interface Replay {
  readonly days: number;
  readonly mailsChecked: number;
  readonly mailsHit: number;
  readonly changed: number;
  readonly usefulChanged: readonly {
    readonly messageId: string;
    readonly from: string;
    readonly subject: string;
  }[];
}

export interface RuleReceipt {
  readonly status: "active" | "proposed" | "soft";
  readonly ruleId: string | null;
  readonly proposalId: string | null;
  readonly type: string;
  readonly summary: string;
  readonly trials: readonly Trial[];
  readonly replay: Replay | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function parseRuleReceipt(output: string): RuleReceipt | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status !== "active" && status !== "proposed" && status !== "soft") return null;
  const replay = record["replay"] as Record<string, unknown> | null | undefined;
  return {
    status,
    ruleId: text(record["ruleId"]) || null,
    proposalId: text(record["proposalId"]) || null,
    type: text(record["type"]),
    summary: text(record["summary"]),
    trials: Array.isArray(record["trials"])
      ? (record["trials"] as Record<string, unknown>[]).map((trial) => ({
          from: text(trial["from"]),
          subject: text(trial["subject"]),
          hit: trial["hit"] === true,
        }))
      : [],
    replay:
      replay && typeof replay === "object"
        ? {
            days: count(replay["days"]),
            mailsChecked: count(replay["mailsChecked"]),
            mailsHit: count(replay["mailsHit"]),
            changed: count(replay["changed"]),
            usefulChanged: Array.isArray(replay["usefulChanged"])
              ? (replay["usefulChanged"] as Record<string, unknown>[]).map((item) => ({
                  messageId: text(item["messageId"]),
                  from: text(item["from"]),
                  subject: text(item["subject"]),
                }))
              : [],
          }
        : null,
  };
}

export function RuleReceiptCard({
  output,
  memory,
  message,
}: {
  output: string;
  memory: Pick<MemoryModel, "respondRule" | "busy">;
  message: Message;
}) {
  const receipt = parseRuleReceipt(output);
  const [done, setDone] = useState<OwnerRuleAction | null>(null);
  if (!receipt) return null;
  const act = async (target: string, action: OwnerRuleAction) => {
    if (await memory.respondRule(target, action)) setDone(action);
  };
  return (
    <section className="memory-card rule-receipt" aria-label={message("rules.receipt.label")}>
      <span className="memory-tag" data-kind="rule">
        {message("rules.receipt.status", {
          s:
            done === "undo"
              ? "undone"
              : done === "confirm"
                ? "active"
                : done === "reject"
                  ? "rejected"
                  : receipt.status,
        })}
      </span>
      <p className="memory-text">{receipt.summary}</p>
      {receipt.status === "soft" ? null : (
        <>
          <h5>{message("rules.receipt.trials")}</h5>
          <ul className="rule-trials">
            {receipt.trials.map((trial, index) => (
              <li key={`${index}-${trial.from}`} data-hit={String(trial.hit)}>
                {message("rules.receipt.trial", {
                  hit: String(trial.hit),
                  from: trial.from,
                  subject: trial.subject,
                })}
              </li>
            ))}
          </ul>
          {receipt.replay ? (
            <>
              <p className="settings-note">
                {message("rules.receipt.replay", {
                  kind: receipt.type,
                  days: receipt.replay.days,
                  checked: receipt.replay.mailsChecked,
                  hit: receipt.replay.mailsHit,
                  changed: receipt.replay.changed,
                  useful: receipt.replay.usefulChanged.length,
                })}
              </p>
              {receipt.replay.usefulChanged.length ? (
                <ul className="rule-replay-useful">
                  {receipt.replay.usefulChanged.map((item) => (
                    <li key={item.messageId}>
                      {item.from} · {item.subject}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="settings-note">{message("rules.receipt.replayNote")}</p>
            </>
          ) : (
            <p className="settings-note">{message("rules.receipt.replayNone")}</p>
          )}
        </>
      )}
      {done ? null : (
        <div className="actions">
          {receipt.status === "active" && receipt.ruleId ? (
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void act(receipt.ruleId ?? "", "undo")}
            >
              {message("rules.undo")}
            </ActionButton>
          ) : null}
          {receipt.status === "proposed" && receipt.proposalId ? (
            <ActionButton
              disabled={memory.busy}
              onClick={() => void act(receipt.proposalId ?? "", "confirm")}
            >
              {message("rules.receipt.confirm")}
            </ActionButton>
          ) : null}
          {receipt.status === "proposed" && receipt.proposalId ? (
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void act(receipt.proposalId ?? "", "reject")}
            >
              {message("rules.pending.reject")}
            </ActionButton>
          ) : null}
        </div>
      )}
    </section>
  );
}

function PendingRuleProposals({
  memory,
  message,
}: {
  memory: Pick<MemoryModel, "proposals" | "respondRule" | "busy">;
  message: Message;
}) {
  const pending = memory.proposals;
  if (!pending || !pending.proposals.length) return null;
  return (
    <section
      id="memory-rule-proposals"
      className="memory-confirm"
      aria-label={message("rules.pending.title", { count: pending.pendingCount })}
    >
      <h4>{message("rules.pending.title", { count: pending.pendingCount })}</h4>
      <p className="settings-note">
        {message("rules.pending.note", {
          count: pending.pendingCount,
          limit: pending.limit,
          days: pending.expiresAfterDays,
        })}
      </p>
      {pending.proposals.map((proposal) => (
        <section
          className="memory-card"
          key={proposal.proposalId}
          data-proposal={proposal.proposalId}
        >
          <span className="memory-tag" data-kind="rule" data-origin={proposal.origin}>
            {message("rules.type", { t: proposal.type })}
          </span>
          <small> {message("rules.pending.origin", { o: proposal.origin })}</small>
          <p className="memory-text">{proposal.summary}</p>
          <small>
            {message("rules.pending.expires", { date: proposal.expiresAt.slice(0, 10) })}
          </small>
          {proposal.refusedBefore > 0 ? (
            <small> {message("rules.pending.refused", { count: proposal.refusedBefore })}</small>
          ) : null}
          <details>
            <summary>{message("rules.pending.evidence")}</summary>
            {proposal.quote === null && !proposal.trials.length && proposal.replay === null ? (
              <p className="settings-note">{message("rules.pending.noEvidence")}</p>
            ) : (
              <>
                {proposal.quote === null ? null : <blockquote>{proposal.quote}</blockquote>}
                {proposal.trials.length ? (
                  <ul className="rule-trials">
                    {proposal.trials.map((trial, index) => (
                      <li key={`${index}-${trial.from ?? ""}`} data-hit={String(trial.hit)}>
                        {message("rules.receipt.trial", {
                          hit: String(trial.hit),
                          from: trial.from ?? "",
                          subject: trial.subject ?? "",
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {proposal.replay ? (
                  <p className="settings-note">
                    {message("rules.pending.replay", {
                      days: proposal.replay.days,
                      checked: proposal.replay.mailsChecked,
                      hit: proposal.replay.mailsHit,
                      changed: proposal.replay.changed,
                    })}
                  </p>
                ) : null}
              </>
            )}
          </details>
          <div className="actions">
            <ActionButton
              disabled={memory.busy}
              onClick={() => void memory.respondRule(proposal.proposalId, "confirm")}
            >
              {message("rules.receipt.confirm")}
            </ActionButton>
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void memory.respondRule(proposal.proposalId, "reject")}
            >
              {message("rules.pending.reject")}
            </ActionButton>
          </div>
        </section>
      ))}
    </section>
  );
}

export function OwnerRulesSection({
  memory,
  message,
}: {
  memory: Pick<MemoryModel, "rules" | "proposals" | "respondRule" | "busy">;
  message: Message;
}) {
  const proposals = <PendingRuleProposals memory={memory} message={message} />;
  if (!memory.rules.length) return proposals;
  return (
    <>
      {proposals}
      <section
        id="memory-rules"
        className="memory-confirm"
        aria-label={message("rules.title", { count: memory.rules.length })}
      >
        <h4>{message("rules.title", { count: memory.rules.length })}</h4>
        <p className="settings-note">{message("rules.note")}</p>
        {memory.rules.map((rule) => (
          <section className="memory-card" key={rule.ruleId} data-rule={rule.ruleId}>
            <span className="memory-tag" data-kind="rule">
              {message("rules.type", { t: rule.type })}
            </span>
            {rule.status === "needs_review" ? <small> {message("rules.needsReview")}</small> : null}
            {rule.enforced ? null : <small> {message("rules.notEnforced")}</small>}
            <p className="memory-text">{rule.summary}</p>
            <div className="actions">
              {rule.status === "needs_review" && rule.enforced ? (
                <ActionButton
                  disabled={memory.busy}
                  onClick={() => void memory.respondRule(rule.ruleId, "reconfirm")}
                >
                  {message("rules.reconfirm")}
                </ActionButton>
              ) : null}
              <ActionButton
                variant="quiet"
                disabled={memory.busy}
                onClick={() => void memory.respondRule(rule.ruleId, "undo")}
              >
                {message("rules.undo")}
              </ActionButton>
            </div>
          </section>
        ))}
      </section>
    </>
  );
}
