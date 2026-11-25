import type { ContentPreviewValue } from "./content-preview.js";
import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState } from "react";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import { executionItems } from "../execution-view.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { queryMessage } from "../messages.js";
import {
  APPROVAL_ALLOWANCE_DAYS,
  type ApprovalAllowFor,
  approvalAllowanceChoices,
  approvalsDecidedTogether,
  findPendingRunApprovals,
  type RunApproval,
  respondToRunApproval,
  setApprovalAllowance,
} from "../run-approval.js";
import { setSearchAuthorization } from "../search-authorization.js";
import { ActionButton } from "./primitives.js";

export function RunApprovalCard({
  runId,
  onPreview,
  records,
  client,
  configuration,
  storage,
  connection,
  refreshSignal,
  message,
  onSettled,
  onUnauthorized,
}: {
  runId: string;
  onPreview?: ((preview: ContentPreviewValue) => void) | undefined;
  records: readonly ThreadExecutionRecord[];
  client: GatewayClient;
  configuration: ControlCenterRuntimeConfiguration;
  storage: ControlCenterBrowserStorage;
  connection: string;
  refreshSignal: number;
  message: (id: MessageId, values?: Record<string, string>) => string;
  onSettled: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [group, setGroup] = useState<readonly RunApproval[]>([]);
  const [continuing, setContinuing] = useState(false);
  const snapshot = group[0] ?? null;
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rememberSearch, setRememberSearch] = useState(true);
  const [allowFor, setAllowFor] = useState<ApprovalAllowFor>("once");
  const isSearch =
    (snapshot?.payload.intent.operation === "web_search" ||
      snapshot?.payload.intent.operation === "web_fetch") &&
    snapshot.payload.intent.sideEffect === "none";
  const choices: readonly ApprovalAllowFor[] =
    snapshot && !isSearch ? approvalAllowanceChoices(snapshot) : ["once"];
  const chosen = choices.includes(allowFor) ? allowFor : "once";
  const responseLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    void refreshSignal;
    void reload;
    if (connection !== "connected") return;
    void (async () => {
      try {
        const pending = await findPendingRunApprovals(client, configuration, runId);
        if (disposed) return;
        setLoadError(null);
        setGroup(approvalsDecidedTogether(pending));
        if (pending.length > 0) setContinuing(false);
      } catch (caught) {
        if (!disposed)
          setLoadError(
            caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED",
          );
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client, configuration, runId, connection, refreshSignal, reload]);
  const respond = async (decision: "approved" | "denied") => {
    if (!snapshot || responseLock.current || connection !== "connected") return;
    responseLock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (
        decision === "approved" &&
        snapshot.payload.recentAuthenticationRequired &&
        !configuration.recentAuthenticationRef
      )
        throw new Error("CONTROL_CENTER_RECENT_AUTHENTICATION_REQUIRED");
      if (decision === "approved" && isSearch && rememberSearch) {
        const policy = await client.query(
          queryMessage(configuration, "search.authorization.read", {}),
        );
        if (policy.type !== "search.authorization.snapshot")
          throw new Error("SEARCH_AUTHORIZATION_INVALID");
        if (
          !policy.payload.enabled &&
          policy.payload.recipients.length > 0 &&
          policy.payload.recipients.every((value) =>
            snapshot.payload.intent.recipientRefs.includes(value),
          )
        )
          await setSearchAuthorization({
            client,
            configuration,
            storage,
            snapshot: policy,
            enabled: true,
          });
      }
      for (const approval of group) {
        const result = await respondToRunApproval({
          client,
          configuration,
          storage,
          snapshot: approval,
          runId,
          decision,
        });
        if (result.status !== "accepted" && result.status !== "replayed")
          throw new Error(message("mutation.rejected"));
      }
      let allowanceSaved = true;
      if (decision === "approved" && chosen !== "once")
        for (const approval of group) {
          const result = await setApprovalAllowance({
            client,
            configuration,
            snapshot: approval,
            allowFor: chosen,
          }).catch(() => null);
          if (result?.status !== "accepted" && result?.status !== "replayed")
            allowanceSaved = false;
        }
      setAllowFor("once");
      setGroup([]);
      setContinuing(true);
      await onSettled();
      if (!allowanceSaved) setError(message("chat.allowance.failed"));
    } catch (caught) {
      if (caught && typeof caught === "object" && "status" in caught && caught.status === 401)
        onUnauthorized();
      setError(
        caught instanceof Error &&
          caught.message === "CONTROL_CENTER_RECENT_AUTHENTICATION_REQUIRED"
          ? message("governance.blocker.recentAuthentication")
          : caught instanceof Error
            ? caught.message
            : "CONTROL_CENTER_REQUEST_REJECTED",
      );
    } finally {
      responseLock.current = false;
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  const inputs = snapshot
    ? executionItems(records)
        .filter(
          (item) =>
            item.kind === "tool" &&
            ["started", "updated"].includes(item.phase) &&
            item.name === snapshot.payload.intent.operation,
        )
        .map((item) => item.input)
        .filter((value): value is string => Boolean(value))
    : [];
  const input = inputs.at(-1);
  let draft: { title: string; text: string } | undefined;
  if (input)
    try {
      const args = JSON.parse(input);
      if (typeof args.content === "string")
        draft = {
          title: typeof args.path === "string" ? args.path : message("threads.draft"),
          text: args.content,
        };
    } catch {}
  return (
    <section
      id={`approval-${runId}`}
      className="approval-inline"
      aria-label={message("runs.status.awaitingApproval")}
    >
      <strong>{message("runs.status.awaitingApproval")}</strong>
      {snapshot ? (
        <>
          <dl>
            <dt>{message("governance.operation")}</dt>
            <dd>{snapshot.payload.intent.operation}</dd>

            <dt>{message("governance.sideEffect")}</dt>
            <dd>{message(`review.impact.${snapshot.payload.intent.sideEffect}`)}</dd>
          </dl>
          {group.length > 1 ? (
            <p>
              {message(isSearch ? "chat.approval.searchBatch" : "chat.approval.batch", {
                count: String(group.length),
              })}
            </p>
          ) : null}
          {(group.length > 1 ? inputs : inputs.slice(-1)).map((value, index) => (
            <pre key={`${index}:${value}`} className="approval-input">
              {value}
            </pre>
          ))}
          <details>
            <summary>{message("common.details")}</summary>
            <dl>
              <dt>{message("governance.recipients")}</dt>
              <dd>{snapshot.payload.intent.recipientRefs.join(", ") || "—"}</dd>
              <dt>{message("governance.targets")}</dt>
              <dd>{snapshot.payload.intent.targetRefs.join(", ")}</dd>
              <dt>{message("governance.dataClassification")}</dt>
              <dd>{snapshot.payload.intent.dataClassification}</dd>
            </dl>
          </details>
          {snapshot.payload.recentAuthenticationRequired &&
          !configuration.recentAuthenticationRef ? (
            <p>{message("account.reauthenticate")}</p>
          ) : null}
          {isSearch ? (
            <>
              <p>{message("chat.search.disclosure")}</p>
              <label className="search-remember">
                <input
                  type="checkbox"
                  checked={rememberSearch}
                  disabled={busy}
                  onChange={(event) => setRememberSearch(event.currentTarget.checked)}
                />
                {message("chat.search.remember")}
              </label>
            </>
          ) : null}
          {choices.length > 1 ? (
            <fieldset className="approval-scope">
              <legend>{message("chat.allowance.legend")}</legend>
              {choices.map((choice) => (
                <label key={choice}>
                  <input
                    type="radio"
                    name={`approval-scope-${runId}`}
                    value={choice}
                    checked={chosen === choice}
                    disabled={busy}
                    onChange={() => setAllowFor(choice)}
                  />
                  {message("chat.allowance.option", {
                    scope: choice,
                    days: String(APPROVAL_ALLOWANCE_DAYS),
                  })}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="actions">
            <ActionButton
              disabled={busy || connection !== "connected"}
              onClick={() => void respond("approved")}
            >
              {isSearch
                ? message("chat.search.enable")
                : chosen !== "once"
                  ? message("chat.allowance.allow")
                  : group.length > 1
                    ? message("chat.allowAll", { count: String(group.length) })
                    : message("chat.allowOnce")}
            </ActionButton>
            {draft && onPreview ? (
              <ActionButton variant="quiet" onClick={() => draft && onPreview(draft)}>
                {message("review.preview")}
              </ActionButton>
            ) : null}
            <ActionButton
              disabled={busy || connection !== "connected"}
              variant="secondary"
              onClick={() => void respond("denied")}
            >
              {message("approvals.deny")}
            </ActionButton>
          </div>
        </>
      ) : (
        <p>{message(continuing ? "chat.approval.continuing" : "state.loading")}</p>
      )}
      {loadError ? (
        <ActionButton
          disabled={connection !== "connected" || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          {message("common.refresh")}
        </ActionButton>
      ) : null}
      {error || loadError ? (
        <p role="alert" style={{ overflowWrap: "anywhere" }}>
          {error ?? loadError}
        </p>
      ) : null}
    </section>
  );
}
