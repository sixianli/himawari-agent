import {
  APPROVAL_ALLOWANCE_DAYS_MAXIMUM,
  APPROVAL_ALLOWANCE_DAYS_MINIMUM,
} from "@himawari-agent/gateway-contracts";
import { useState } from "react";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import type { MemoryModel, OwnerRuleAction, PendingProposal, ProposalAction } from "../memory.js";
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
  memory: Pick<MemoryModel, "proposals" | "respondRule" | "respondProposal" | "busy">;
  message: Message;
}) {
  const receipt = parseRuleReceipt(output);
  const [done, setDone] = useState<OwnerRuleAction | ProposalAction | null>(null);
  if (!receipt) return null;
  const act = async (target: string, action: OwnerRuleAction) => {
    if (await memory.respondRule(target, action)) setDone(action);
  };
  const waiting = memory.proposals?.proposals.find(
    ({ proposalId }) => proposalId === receipt.proposalId,
  );
  const refuse = async (proposal: PendingProposal) => {
    if (await memory.respondProposal(proposal, "reject")) setDone("reject");
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
          {receipt.status === "proposed" && waiting ? (
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void refuse(waiting)}
            >
              {message("proposals.reject")}
            </ActionButton>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function OwnerRulesSection({
  memory,
  message,
}: {
  memory: Pick<MemoryModel, "rules" | "respondRule" | "busy">;
  message: Message;
}) {
  if (!memory.rules.length) return null;
  return (
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
          {rule.status === "suspended" ? <small> {message("rules.suspended")}</small> : null}
          {rule.enforced || rule.status === "suspended" ? null : (
            <small> {message("rules.notEnforced")}</small>
          )}
          <p className="memory-text">{rule.summary}</p>
          <div className="actions">
            {(rule.status === "needs_review" && rule.enforced) || rule.status === "suspended" ? (
              <ActionButton
                disabled={memory.busy}
                onClick={() => void memory.respondRule(rule.ruleId, "reconfirm")}
              >
                {message(rule.status === "suspended" ? "rules.resume" : "rules.reconfirm")}
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
  );
}

export function BuiltInActionRulesSection({
  memory,
  message,
}: {
  memory: Pick<MemoryModel, "builtInRules" | "respondRule" | "busy">;
  message: Message;
}) {
  if (!memory.builtInRules.length) return null;
  const title = message("rules.builtIn.title", { count: memory.builtInRules.length });
  return (
    <section id="memory-built-in-rules" className="memory-confirm" aria-label={title}>
      <h4>{title}</h4>
      <p className="settings-note">{message("rules.builtIn.note")}</p>
      {memory.builtInRules.map((rule) => (
        <section
          className="memory-card"
          key={rule.ruleId}
          data-built-in-rule={rule.ruleId}
          data-outcome={rule.outcome}
        >
          <p className="memory-text">{message("rules.builtIn.name", { id: rule.ruleId })}</p>
          <small>{message("rules.builtIn.when", { id: rule.ruleId })}</small>
          <small>
            {" "}
            {message("rules.builtIn.examples", {
              hit: rule.examplesHit,
              miss: rule.examplesMiss,
            })}
          </small>
          {rule.askFirst === null ? null : (
            <div className="actions">
              <label className="memory-switch">
                {message("rules.builtIn.askFirst")}
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={rule.askFirst}
                  checked={rule.askFirst}
                  disabled={memory.busy}
                  onChange={() =>
                    void memory.respondRule(
                      rule.ruleId,
                      rule.askFirst ? "allow_directly" : "ask_first",
                    )
                  }
                />
              </label>
            </div>
          )}
        </section>
      ))}
    </section>
  );
}

export function OwnerAllowancesSection({
  memory,
  message,
}: {
  memory: Pick<
    MemoryModel,
    "allowances" | "respondRule" | "busy" | "allowanceDays" | "setAllowanceDays"
  >;
  message: Message;
}) {
  const { moment } = useLocaleFormat();
  const [draft, setDraft] = useState<string | null>(null);
  if (!memory.allowances.length && memory.allowanceDays === null) return null;
  const title = message("rules.allowances.title", { count: memory.allowances.length });
  const shown = draft ?? (memory.allowanceDays === null ? "" : String(memory.allowanceDays));
  const days = Number(shown);
  const valid =
    /^\d+$/.test(shown) &&
    days >= APPROVAL_ALLOWANCE_DAYS_MINIMUM &&
    days <= APPROVAL_ALLOWANCE_DAYS_MAXIMUM;
  const changed = valid && days !== memory.allowanceDays;
  return (
    <section id="memory-allowances" className="memory-confirm" aria-label={title}>
      <h4>{title}</h4>
      <p className="settings-note">{message("rules.allowances.note")}</p>
      {memory.allowanceDays === null ? null : (
        <div className="allowance-days">
          <label className="setting-row">
            <span>{message("rules.allowances.days")}</span>
            <input
              className="setting-input"
              type="number"
              inputMode="numeric"
              min={APPROVAL_ALLOWANCE_DAYS_MINIMUM}
              max={APPROVAL_ALLOWANCE_DAYS_MAXIMUM}
              aria-invalid={!valid}
              value={shown}
              disabled={memory.busy}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <ActionButton
            variant="quiet"
            disabled={memory.busy || !changed}
            onClick={() =>
              void memory.setAllowanceDays(days).then((saved) => {
                if (saved) setDraft(null);
              })
            }
          >
            {message("rules.allowances.daysSave")}
          </ActionButton>
          <small>
            {message("rules.allowances.daysNote", {
              minimum: String(APPROVAL_ALLOWANCE_DAYS_MINIMUM),
              maximum: String(APPROVAL_ALLOWANCE_DAYS_MAXIMUM),
            })}
          </small>
        </div>
      )}
      {memory.allowances.map((allowance) => (
        <section
          className="memory-card"
          key={allowance.allowanceId}
          data-allowance={allowance.allowanceId}
          data-scope={allowance.allowFor}
        >
          <p className="memory-text">{allowance.title}</p>
          <small>
            {message("rules.allowances.scope", {
              scope: allowance.allowFor,
              until: allowance.expiresAt ? moment(allowance.expiresAt) : "",
            })}
          </small>
          <div className="actions">
            <ActionButton
              variant="quiet"
              disabled={memory.busy}
              onClick={() => void memory.respondRule(allowance.allowanceId, "revoke")}
            >
              {message("rules.allowances.revoke")}
            </ActionButton>
          </div>
        </section>
      ))}
    </section>
  );
}
