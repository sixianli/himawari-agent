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
  mine = false,
}: {
  item: DecisionChainMemory;
  mine?: boolean;
  message: Message;
  onOpenThread: (threadId: string, messageId?: string) => void;
}) {
  const tree = basisTree(item.basis.nodes);
  const tags = [
    item.status && item.status !== "active"
      ? message("decision.chain.status", { s: item.status })
      : null,
    mine ? message("decision.email.thisMail") : null,
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

type ChainRule = DecisionChain["rules"]["items"][number];
type RuleWording = NonNullable<ChainRule["wording"]>;

const SUNDAY = Date.UTC(2024, 0, 7);
const DAY_MS = 24 * 60 * 60 * 1000;

function wordingText(wording: RuleWording, locale: string, separator: string): string {
  const list = (values: readonly string[]) => values.join(separator);
  if (wording.amount) {
    const format = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: wording.amount.currency,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
    return format.format(wording.amount.minor / 10 ** digits);
  }
  if (wording.quietHours.length > 0) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return list(
      wording.quietHours.map(
        ({ days, start, end }) =>
          `${days.map((day) => weekday.format(new Date(SUNDAY + day * DAY_MS))).join(" ")} ${start}–${end}`,
      ),
    );
  }
  return list(wording.values);
}

function RuleItem({
  rule,
  message,
  showMails,
  thisMail,
}: {
  rule: ChainRule;
  message: Message;
  showMails: boolean;
  thisMail: boolean;
}) {
  const { moment, locale } = useLocaleFormat();
  const wording = rule.wording
    ? wordingText(rule.wording, locale, message("decision.chain.listSeparator"))
    : "";
  return (
    <li data-rule-id={rule.ruleId}>
      <p>
        {message("decision.chain.rule", { k: rule.kind, id: rule.ruleId })}
        {` · ${message("decision.chain.origin", { o: rule.origin ?? "unknown" })}`}
        {rule.status === "needs_review" ? ` · ${message("decision.chain.ruleNeedsReview")}` : ""}
        {rule.status === "suspended" ? ` · ${message("decision.chain.ruleSuspended")}` : ""}
        {thisMail ? ` · ${message("decision.email.thisMail")}` : ""}
      </p>
      {rule.memory ? (
        <p className="decision-chain-rule-text">
          {message("decision.chain.ruleQuote", {
            text:
              rule.memory.state === "visible" && rule.memory.text
                ? rule.memory.text
                : message("decision.chain.noText"),
          })}
        </p>
      ) : null}
      <p className="decision-chain-rule-text">
        {rule.wording
          ? message("decision.chain.ruleWording", {
              k: rule.kind,
              text: wording,
              empty: wording.length === 0 ? "yes" : "no",
            })
          : message("decision.chain.ruleWordingMissing")}
      </p>
      <small className="decision-chain-rule-source">
        {message("decision.chain.ruleSource", {
          source: rule.source ?? message("decision.chain.noRecord"),
          revision: rule.revision ?? "?",
        })}
        {rule.changedAt ? ` · ${moment(rule.changedAt)}` : ""}
        {rule.current ? ` · ${message("decision.chain.ruleCurrent")}` : ""}
      </small>
      <small className="decision-chain-rule-tests" data-tests={rule.tests.state}>
        {message("decision.chain.ruleTests", {
          s: rule.tests.state,
          total: rule.tests.total,
          at: rule.tests.failedAt ?? 0,
        })}
      </small>
      {showMails ? (
        <small>{message("decision.chain.ruleMails", { count: rule.mailCount })}</small>
      ) : null}
    </li>
  );
}

export function DecisionChainBody({
  chain,
  message,
  onOpenThread,
  thisMail,
}: {
  chain: DecisionChain;
  message: Message;
  onOpenThread: (threadId: string, messageId?: string) => void;
  thisMail?: { readonly ruleIds: ReadonlySet<string>; readonly memoryIds: ReadonlySet<string> };
}) {
  const { moment } = useLocaleFormat();
  const rulesHeading = message(
    chain.decision.kind === "rule_review" ? "decision.chain.reviewRules" : "decision.chain.rules",
  );
  return (
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
      <section aria-label={rulesHeading}>
        <h3>{rulesHeading}</h3>
        {chain.rules.state === "recorded" ? (
          <ul className="decision-chain-list">
            {chain.rules.items.map((rule, index) => (
              <RuleItem
                key={`${rule.ruleId}:${index}`}
                rule={rule}
                message={message}
                showMails={chain.mails !== null}
                thisMail={thisMail?.ruleIds.has(rule.ruleId) ?? false}
              />
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
          {chain.mails.summaries ? (
            <small>
              {message("decision.chain.summaries", {
                s: chain.mails.summaries.read,
                count: chain.mails.summaries.count,
              })}
            </small>
          ) : null}
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
                  mine={thisMail?.memoryIds.has(item.memoryId) ?? false}
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
          <DecisionChainBody chain={chain} message={message} onOpenThread={onOpenThread} />
        ) : null}
      </aside>
    </>
  );
}
