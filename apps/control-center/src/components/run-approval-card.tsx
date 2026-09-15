import type { ContentPreviewValue } from "./content-preview.js";
import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState } from "react";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import { executionItems } from "../execution-view.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { queryMessage } from "../messages.js";
import { findPendingRunApproval, type RunApproval, respondToRunApproval } from "../run-approval.js";
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
  message: (id: MessageId) => string;
  onSettled: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [snapshot, setSnapshot] = useState<RunApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rememberSearch, setRememberSearch] = useState(true);
  const isSearch =
    snapshot?.payload.intent.operation === "web_search" &&
    snapshot.payload.intent.sideEffect === "none" &&
    snapshot.payload.intent.recipientRefs.includes("https://mcp.exa.ai");
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
        const id = await findPendingRunApproval(client, configuration, runId);
        const detail = id
          ? await client.query(
              queryMessage(configuration, "approval.detail", { approvalRequestId: id }),
            )
          : null;
        if (disposed) return;
        setLoadError(null);
        if (
          detail?.type === "approval.snapshot" &&
          detail.payload.intent.runId === runId &&
          detail.payload.status === "pending"
        ) {
          setSnapshot(detail);
        } else setSnapshot(null);
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
        if (!policy.payload.enabled)
          await setSearchAuthorization({
            client,
            configuration,
            storage,
            snapshot: policy,
            enabled: true,
          });
      }
      const result = await respondToRunApproval({
        client,
        configuration,
        storage,
        snapshot,
        runId,
        decision,
      });
      if (result.status === "accepted" || result.status === "replayed") setSnapshot(null);
      else setError(message("mutation.rejected"));
      await onSettled();
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
  const input = snapshot
    ? executionItems(records).findLast(
        (item) =>
          item.kind === "tool" &&
          ["started", "updated"].includes(item.phase) &&
          item.name === snapshot.payload.intent.operation,
      )?.input
    : null;
  let draft: { title: string; text: string } | undefined;
  if (input)
    try {
      const args = JSON.parse(input);
      if (typeof args.content === "string")
        draft = {
          title: typeof args.path === "string" ? args.path : message("threads.draft"),
          text: args.content,
        };
    } catch {
      /* Incomplete arguments are not a preview. */
    }
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
          {input ? <pre className="approval-input">{input}</pre> : null}
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
          <div className="actions">
            <ActionButton
              disabled={busy || connection !== "connected"}
              onClick={() => void respond("approved")}
            >
              {message(isSearch ? "chat.search.enable" : "chat.allowOnce")}
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
        <p>{message("state.loading")}</p>
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
