import { useEffect, useRef, useState } from "react";
import { type BasisTree, basisTree, type DecisionChainMemory } from "../decision-chain.js";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import { type DecisionChain, decisionChainGone } from "../proactive.js";
import { LineIcon } from "./answer-footer.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;
type SectionState = DecisionChain["rules"]["state"];

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly chain: DecisionChain };

function SectionNote({ state, message }: { state: SectionState; message: Message }) {
  return <p className="decision-chain-note">{message("decision.chain.state", { s: state })}</p>;
}

function BasisNodes({ tree, message }: { tree: BasisTree; message: Message }) {
  const { moment } = useLocaleFormat();
  const { node } = tree;
  return (
    <li>
      <p>
        {node.text ?? message("decision.chain.noText")}
        {node.action ? ` · ${message("decision.chain.action", { a: node.action })}` : ""}
        {node.changedAt ? ` · ${moment(node.changedAt)}` : ""}
        {node.repeated ? ` · ${message("decision.chain.repeated")}` : ""}
        {node.truncated ? ` · ${message("decision.chain.nodeCut")}` : ""}
      </p>
      {tree.children.length > 0 ? (
        <ul>
          {tree.children.map((child, index) => (
            <BasisNodes key={`${child.node.memoryId}:${index}`} tree={child} message={message} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function MemoryEntry({
  item,
  message,
  onOpenThread,
}: {
  item: DecisionChainMemory;
  message: Message;
  onOpenThread: (threadId: string, messageId?: string) => void;
}) {
  const tree = basisTree(item.basis.nodes);
  const tags = [
    item.status && item.status !== "active"
      ? message("decision.chain.status", { s: item.status })
      : null,
    item.usedByModel ? message("decision.chain.used") : null,
    item.tentative ? message("decision.chain.tentative") : null,
    item.inference ? message("decision.chain.inference") : null,
    item.changedSinceDecision ? message("decision.chain.changed") : null,
  ].filter((tag): tag is string => tag !== null);
  const source = item.source;
  return (
    <li className="decision-chain-memory" data-state={item.state}>
      <p className="memory-text">
        {item.state === "visible" && item.text
          ? item.text
          : message("decision.chain.memoryState", { s: item.state })}
      </p>
      {tags.length > 0 ? <small>{tags.join(" · ")}</small> : null}
      {item.supersededBy ? (
        <small>
          {item.supersededBy.text
            ? message("decision.chain.supersededBy", {
                text: item.supersededBy.text,
              })
            : message("decision.chain.supersededNoText")}
        </small>
      ) : null}
      {item.state === "visible" ? (
        <div className="decision-chain-source">
          {source.quote ? (
            <q>{source.quote}</q>
          ) : source.importBatchId ? (
            <small>{message("decision.chain.sourceImport")}</small>
          ) : source.threadId || item.source.refs.length > 0 ? null : (
            <small>{message("decision.chain.noRecord")}</small>
          )}
          {source.firstSourceDeleted ? (
            <small>{message("decision.chain.sourceDeleted")}</small>
          ) : source.threadId ? (
            <button
              type="button"
              className="memory-link"
              onClick={() =>
                source.threadId && onOpenThread(source.threadId, source.messageId ?? undefined)
              }
            >
              {message("decision.chain.openSource")}
            </button>
          ) : null}
        </div>
      ) : null}
      {item.state === "visible" && item.inference ? (
        <div className="decision-chain-basis">
          <strong>{message("decision.chain.basis")}</strong>
          {tree ? (
            <ul>
              <BasisNodes tree={tree} message={message} />
            </ul>
          ) : item.basis.complete ? (
            <small>{message("decision.chain.noRecord")}</small>
          ) : null}
          {!item.basis.complete ? <small>{message("decision.chain.basisCut")}</small> : null}
        </div>
      ) : null}
    </li>
  );
}

export function DecisionChainDrawer({
  decisionId,
  readChain,
  message,
  onOpenThread,
  onGone,
  onClose,
}: {
  decisionId: string;
  readChain: (decisionId: string) => Promise<DecisionChain>;
  message: Message;
  onOpenThread: (threadId: string, messageId?: string) => void;
  onGone: () => void;
  onClose: () => void;
}) {
  const { moment } = useLocaleFormat();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const gone = useRef(onGone);
  gone.current = onGone;
  const read = useRef(readChain);
  read.current = readChain;
  useEffect(() => {
    panel.current?.focus?.();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    let disposed = false;
    setLoaded({ kind: "loading" });
    void read
      .current(decisionId)
      .then((chain) => {
        if (!disposed) setLoaded({ kind: "ready", chain });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (decisionChainGone(error)) gone.current();
        else setLoaded({ kind: "failed" });
      });
    return () => {
      disposed = true;
    };
  }, [decisionId]);
  const chain = loaded.kind === "ready" ? loaded.chain : null;
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
        className="memory-drawer decision-chain"
        role="dialog"
        aria-label={message("decision.chain.title")}
      >
        <header>
          <strong>{message("decision.chain.title")}</strong>
          <ActionButton variant="quiet" aria-label={message("common.close")} onClick={onClose}>
            <LineIcon name="close" />
          </ActionButton>
        </header>
        {loaded.kind === "loading" ? <p className="decision-chain-note">…</p> : null}
        {loaded.kind === "failed" ? (
          <p className="decision-chain-note" role="alert">
            {message("decision.chain.failed")}
          </p>
        ) : null}
        {chain ? (
          <>
            <dl className="memory-detail">
              <dt>{message("decision.chain.decision")}</dt>
              <dd>
                {chain.decision.kind === "proactive"
                  ? message("proactive.verdict", { v: chain.decision.outcome })
                  : message("decision.chain.kind", { k: chain.decision.kind })}
                {` · ${moment(chain.decision.decidedAt)}`}
              </dd>
              <dt>{message("decision.chain.rating")}</dt>
              <dd>
                {chain.decision.rating
                  ? `${message("proactive.rate", { r: chain.decision.rating })}${
                      chain.decision.ratedAt ? ` · ${moment(chain.decision.ratedAt)}` : ""
                    }`
                  : message("decision.chain.unrated")}
              </dd>
            </dl>
            {chain.inputs === "not_recorded" ? (
              <p className="decision-chain-note">{message("decision.chain.noRecord")}</p>
            ) : null}
            <section aria-label={message("decision.chain.rules")}>
              <h3>{message("decision.chain.rules")}</h3>
              {chain.rules.state === "recorded" ? (
                <ul className="decision-chain-list">
                  {chain.rules.items.map((rule, index) => (
                    <li key={`${rule.ruleId}:${index}`}>
                      <p>
                        {message("decision.chain.rule", { id: rule.ruleId })}
                        {` · ${message("decision.chain.origin", { o: rule.origin ?? "unknown" })}`}
                        {rule.document ? ` · ${rule.document}` : ""}
                      </p>
                      <small>
                        {message("decision.chain.ruleMails", {
                          count: rule.mailCount,
                        })}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <SectionNote state={chain.rules.state} message={message} />
              )}
            </section>
            {chain.mails ? (
              <section aria-label={message("decision.chain.mails")}>
                <h3>{message("decision.chain.mails")}</h3>
                <p>
                  {chain.mails.judged === null
                    ? message("decision.chain.noRecord")
                    : message("decision.chain.judged", {
                        count: chain.mails.judged,
                      })}
                  {chain.mails.related === null
                    ? ""
                    : ` · ${message("decision.chain.related", { count: chain.mails.related })}`}
                </p>
                <small>
                  {message("decision.chain.read", {
                    s: chain.mails.relatedRead,
                  })}
                </small>
              </section>
            ) : null}
            <section aria-label={message("decision.chain.memories")}>
              <h3>{message("decision.chain.memories")}</h3>
              {chain.memories.recall ? (
                <small>
                  {message("decision.chain.recall", {
                    s: chain.memories.recall,
                  })}
                </small>
              ) : null}
              {chain.memories.state === "recorded" ? (
                <>
                  <ul className="decision-chain-list">
                    {chain.memories.items.map((item) => (
                      <MemoryEntry
                        key={item.memoryId}
                        item={item}
                        message={message}
                        onOpenThread={onOpenThread}
                      />
                    ))}
                  </ul>
                  {chain.memories.truncated ? (
                    <small>
                      {message("decision.chain.memoriesCut", {
                        shown: chain.memories.items.length,
                        total: chain.memories.total,
                      })}
                    </small>
                  ) : null}
                </>
              ) : (
                <SectionNote state={chain.memories.state} message={message} />
              )}
            </section>
          </>
        ) : null}
      </aside>
    </>
  );
}
