import { useEffect, useRef, useState } from "react";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import {
  type DecisionChain,
  type DecisionEmail,
  decisionChainGone,
  type ProactiveModel,
  type ProactiveWeekly,
  type ProactiveWeeklyAccess,
} from "../proactive.js";
import { DecisionChainBody } from "./decision-chain-drawer.js";
import { ActionButton } from "./primitives.js";
import { WeekGlance } from "./weekly-report.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;
type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "gone" }
  | { readonly kind: "ready"; readonly value: T };

const BUCKETS = ["both", "museOnly", "himawariOnly", "bothSilent", "noHimawariRecord"] as const;

function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    void key;
    let disposed = false;
    setState({ kind: "loading" });
    latest
      .current()
      .then((value) => {
        if (!disposed) setState({ kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (!disposed) setState({ kind: decisionChainGone(error) ? "gone" : "failed" });
      });
    return () => {
      disposed = true;
    };
  }, [key]);
  return state;
}

function Note({ state, message }: { state: "loading" | "failed" | "gone"; message: Message }) {
  return (
    <p className="decision-chain-note" role={state === "failed" ? "alert" : undefined}>
      {state === "loading"
        ? "…"
        : message(state === "gone" ? "decision.chain.gone" : "decision.email.failed")}
    </p>
  );
}

function triState(value: boolean | null, message: Message): string {
  return message("decision.email.museJudged", {
    v: value === null ? "unrated" : value ? "ok" : "bad",
  });
}

export function MailDecisionPage({
  proactive,
  weekly,
  messageId,
  endDay,
  message,
  locale,
  onBack,
  onOpenThread,
}: {
  proactive: ProactiveModel;
  weekly: ProactiveWeeklyAccess;
  messageId: string;
  endDay: string | null;
  message: Message;
  locale: string;
  onBack: () => void;
  onOpenThread: (threadId: string, messageId?: string) => void;
}) {
  const { moment } = useLocaleFormat();
  const readMail = proactive.readMail;
  const readChain = proactive.readChain;
  const mail = useLoad<DecisionEmail>(
    () => (readMail ? readMail(messageId) : Promise.reject(new Error("MAIL_UNAVAILABLE"))),
    messageId,
  );
  const decisionId = mail.kind === "ready" ? (mail.value.mail?.decisionId ?? null) : null;
  const chain = useLoad<DecisionChain | null>(
    () =>
      decisionId && readChain
        ? readChain(decisionId)
        : mail.kind === "ready"
          ? Promise.resolve(null)
          : new Promise<never>(() => undefined),
    `${messageId}:${decisionId ?? ""}:${mail.kind}`,
  );
  const week = useLoad<ProactiveWeekly>(() => weekly.read(endDay), endDay ?? "latest");
  const detail = mail.kind === "ready" ? mail.value : null;
  const judged = detail?.mail ?? null;
  const thisMail = judged
    ? {
        ruleIds: new Set(judged.ruleIds ?? []),
        memoryIds: new Set(judged.memoryIds ?? []),
      }
    : undefined;
  const count = (value: number | null) =>
    value === null ? message("decision.chain.noRecord") : String(value);
  const compared = detail?.comparison ?? null;
  const mark = BUCKETS.find((bucket) => bucket === compared) ?? null;
  return (
    <section className="mail-decision" aria-label={message("decision.email.title")}>
      <header className="mail-decision-head">
        <ActionButton variant="quiet" onClick={onBack}>
          {message("decision.email.back")}
        </ActionButton>
        <h2>{message("decision.email.title")}</h2>
      </header>
      {mail.kind !== "ready" ? <Note state={mail.kind} message={message} /> : null}
      {detail ? (
        <div className="mail-decision-grid">
          <div className="mail-decision-column" data-column="chain">
            <section
              className="mail-decision-card"
              aria-label={message("decision.email.mailTitle")}
            >
              <h3>{message("decision.email.mailTitle")}</h3>
              {judged ? (
                <dl className="memory-detail">
                  <dt>{message("decision.chain.decision")}</dt>
                  <dd>
                    {message("decision.email.outcome", { o: judged.outcome })}
                    {judged.skipReason
                      ? ` · ${message("decision.email.skip", { r: judged.skipReason })}`
                      : ""}
                    {` · ${moment(judged.processedAt)}`}
                  </dd>
                  <dt>{message("decision.chain.rating")}</dt>
                  <dd>
                    {judged.rating
                      ? message("proactive.rate", { r: judged.rating })
                      : message("decision.chain.unrated")}
                  </dd>
                  <dt>{message("decision.email.thisMailUsed")}</dt>
                  <dd>
                    {message("decision.email.counts", {
                      rules: count(judged.ruleIds === null ? null : judged.ruleIds.length),
                      memories: count(judged.memoryIds === null ? null : judged.memoryIds.length),
                      related: count(judged.relatedMessages),
                    })}
                  </dd>
                </dl>
              ) : (
                <p className="decision-chain-note">{message("decision.email.noMail")}</p>
              )}
            </section>
            {judged ? (
              <section className="mail-decision-card" aria-label={message("decision.chain.title")}>
                <h3>{message("decision.chain.title")}</h3>
                <p className="decision-chain-note">{message("decision.email.sameJudgment")}</p>
                {chain.kind === "ready" && chain.value ? (
                  <DecisionChainBody
                    chain={chain.value}
                    message={message}
                    onOpenThread={onOpenThread}
                    {...(thisMail ? { thisMail } : {})}
                  />
                ) : chain.kind === "ready" ? (
                  <p className="decision-chain-note">{message("decision.chain.noRecord")}</p>
                ) : (
                  <Note state={chain.kind} message={message} />
                )}
              </section>
            ) : null}
          </div>
          <div className="mail-decision-column" data-column="compare">
            <section className="mail-decision-card" aria-label={message("decision.email.week")}>
              <h3>{message("decision.email.week")}</h3>
              {week.kind === "ready" ? (
                <WeekGlance
                  report={week.value.report}
                  message={message}
                  locale={locale}
                  mark={mark}
                />
              ) : (
                <Note state={week.kind} message={message} />
              )}
            </section>
            <section className="mail-decision-card" aria-label={message("decision.email.muse")}>
              <h3>{message("decision.email.muse")}</h3>
              {detail.muse.entries.length === 0 ? (
                <p className="decision-chain-note">{message("decision.email.museNone")}</p>
              ) : (
                <ul className="decision-chain-list">
                  {detail.muse.entries.map((entry) => (
                    <li key={entry.entryId} className="mail-muse-entry">
                      <p>
                        {message("decision.email.museReminded", {
                          v: entry.reminded ? "yes" : "no",
                        })}
                        {` · ${moment(entry.museAt)}`}
                      </p>
                      <p className="memory-text">
                        {entry.textWithheld
                          ? message("weekly.cases.withheld")
                          : [entry.title, entry.text].filter(Boolean).join(" · ") ||
                            message("weekly.cases.noText")}
                      </p>
                      {entry.reminded ? (
                        <small>
                          {message("decision.email.museRating", {
                            timing: triState(entry.timingOk, message),
                            content: triState(entry.contentOk, message),
                          })}
                        </small>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {detail.muse.truncated ? <small>{message("decision.email.museCut")}</small> : null}
            </section>
            <section
              className="mail-decision-card"
              aria-label={message("decision.email.compareTitle")}
            >
              <h3>{message("decision.email.compareTitle")}</h3>
              <p data-comparison={detail.comparison}>
                {message("decision.email.compare", { c: detail.comparison })}
              </p>
            </section>
          </div>
        </div>
      ) : null}
    </section>
  );
}
