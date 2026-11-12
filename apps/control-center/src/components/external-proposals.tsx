import { EXTERNAL_PROPOSAL_TEXT_MAXIMUM } from "@himawari-agent/gateway-contracts";
import { useState } from "react";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import type { ExternalDecision, ExternalProposal, MemoryModel } from "../memory.js";
import { TextEditor } from "./memory-panel.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

interface Sent {
  readonly batchId: string;
  readonly count: number;
}

export function externalResult(
  sent: Sent | null,
  batches: readonly {
    readonly batchId: string;
    readonly committed: number;
    readonly rejected: number;
  }[],
) {
  if (!sent) return null;
  const batch = batches.find((entry) => entry.batchId === sent.batchId);
  if (!batch) return null;
  return {
    kept: batch.committed,
    rejected: batch.rejected,
    left: Math.max(0, sent.count - batch.committed - batch.rejected),
  };
}

function ProposalRow({
  item,
  checked,
  editing,
  memory,
  message,
  onToggle,
  onEdit,
  onSave,
}: {
  item: ExternalProposal;
  checked: boolean;
  editing: boolean;
  memory: MemoryModel;
  message: Message;
  onToggle: () => void;
  onEdit: (open: boolean) => void;
  onSave: (text: string) => void;
}) {
  const format = useLocaleFormat();
  return (
    <li className="external-proposal" data-proposal={item.proposalId}>
      {editing ? (
        <TextEditor
          initial={item.text}
          maxLength={EXTERNAL_PROPOSAL_TEXT_MAXIMUM}
          busy={memory.busy}
          message={message}
          onCancel={() => onEdit(false)}
          onSave={onSave}
        />
      ) : (
        <label>
          <input type="checkbox" checked={checked} disabled={memory.busy} onChange={onToggle} />
          <span>
            <span className="memory-text">{item.text}</span>
            <span className="memory-tags">
              <span className="memory-tag">{message("memory.cat", { c: item.category })}</span>
              {item.dataClassification === "sensitive" ? (
                <span className="memory-tag" data-kind="sensitive">
                  {message("memory.external.sensitive")}
                </span>
              ) : null}
              <small>
                {message("memory.external.from", {
                  client: item.client,
                  time: format.moment(item.receivedAt),
                })}
              </small>
            </span>
          </span>
        </label>
      )}
      {editing ? null : (
        <ActionButton variant="quiet" disabled={memory.busy} onClick={() => onEdit(true)}>
          {message("memory.external.edit")}
        </ActionButton>
      )}
    </li>
  );
}

export function ExternalProposalsSection({
  memory,
  message,
}: {
  memory: MemoryModel;
  message: Message;
}) {
  const format = useLocaleFormat();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const external = memory.overview?.externalProposals;
  if (!external || (external.total === 0 && external.batches.length === 0)) return null;
  const shown = new Set(external.items.map(({ proposalId }) => proposalId));
  const picked = [...chosen].filter((id) => shown.has(id));
  const all = external.items.length > 0 && picked.length === external.items.length;
  const result = externalResult(sent, external.batches);
  const ready = memory.externalReady;
  const answer = async (items: readonly ExternalDecision[]) => {
    setSent(null);
    const batchId = await memory.externalRespond(items);
    if (batchId === null) return;
    setSent({ batchId, count: items.length });
    setChosen(new Set());
    setEditing(null);
  };
  const decide = (decision: "keep" | "reject") =>
    void answer(picked.map((proposalId) => ({ proposalId, decision, editedText: null })));
  return (
    <section
      id="memory-external"
      className="memory-confirm memory-external"
      data-waiting={external.total > 0 ? "true" : "false"}
      aria-label={message("memory.external.title", { count: external.total })}
    >
      <h4>{message("memory.external.title", { count: external.total })}</h4>
      <p className="settings-note">{message("memory.external.note")}</p>
      {external.total > external.items.length ? (
        <p className="settings-note">
          {message("memory.external.partial", {
            total: external.total,
            shown: external.items.length,
          })}
        </p>
      ) : null}
      {result ? (
        <output className="memory-external-result" aria-live="polite">
          {message(
            result.left > 0 ? "memory.external.resultLeft" : "memory.external.result",
            result,
          )}
        </output>
      ) : null}
      {external.items.length ? (
        <>
          <label className="memory-external-all">
            <input
              type="checkbox"
              checked={all}
              disabled={memory.busy || !ready}
              onChange={() =>
                setChosen(
                  all ? new Set() : new Set(external.items.map(({ proposalId }) => proposalId)),
                )
              }
            />
            <span>{message("memory.external.all")}</span>
          </label>
          <ul className="memory-list external-proposals">
            {external.items.map((item) => (
              <ProposalRow
                key={item.proposalId}
                item={item}
                checked={chosen.has(item.proposalId)}
                editing={editing === item.proposalId}
                memory={memory}
                message={message}
                onToggle={() => {
                  const next = new Set(chosen);
                  if (!next.delete(item.proposalId)) next.add(item.proposalId);
                  setChosen(next);
                }}
                onEdit={(open) => setEditing(open ? item.proposalId : null)}
                onSave={(text) =>
                  void answer([{ proposalId: item.proposalId, decision: "keep", editedText: text }])
                }
              />
            ))}
          </ul>
          <div className="actions">
            <ActionButton
              disabled={memory.busy || !ready || picked.length === 0}
              onClick={() => decide("keep")}
            >
              {message("memory.external.keep", { count: picked.length })}
            </ActionButton>
            <ActionButton
              variant="secondary"
              disabled={memory.busy || !ready || picked.length === 0}
              onClick={() => decide("reject")}
            >
              {message("memory.external.reject", { count: picked.length })}
            </ActionButton>
          </div>
        </>
      ) : null}
      {external.batches.length ? (
        <ul
          className="memory-list external-batches"
          aria-label={message("memory.external.batches")}
        >
          {external.batches.map((batch) => (
            <li key={batch.batchId}>
              <span>
                {message("memory.external.batch", {
                  time: format.moment(batch.decidedAt),
                  kept: batch.committed,
                  rejected: batch.rejected,
                })}
              </span>
              <ActionButton
                variant="quiet"
                disabled={memory.busy || !ready}
                onClick={() =>
                  void memory.externalUndo(batch.batchId).then((ok) => {
                    if (ok && sent?.batchId === batch.batchId) setSent(null);
                  })
                }
              >
                {message("memory.external.undo")}
              </ActionButton>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
