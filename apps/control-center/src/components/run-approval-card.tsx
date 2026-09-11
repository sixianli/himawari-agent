import { useEffect, useState } from "react";
import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { executionItems } from "../execution-view.js";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { queryMessage } from "../messages.js";
import { findPendingRunApproval, respondToRunApproval, type RunApproval } from "../run-approval.js";
import { ActionButton } from "./primitives.js";

export function RunApprovalCard({
  runId,
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
        if (
          detail?.type === "approval.snapshot" &&
          detail.payload.intent.runId === runId &&
          detail.payload.status === "pending"
        ) {
          setSnapshot(detail);
          setError(null);
        } else setSnapshot(null);
      } catch (caught) {
        if (!disposed)
          setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client, configuration, runId, connection, refreshSignal, reload]);
  const respond = async (decision: "approved" | "denied") => {
    if (!snapshot || busy || connection !== "connected") return;
    setBusy(true);
    setError(null);
    try {
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
      setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  const input = snapshot
    ? executionItems(records).findLast(
        (item) =>
          item.kind === "tool" &&
          item.phase === "started" &&
          item.name === snapshot.payload.intent.operation,
      )?.input
    : null;
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
            <dd>{snapshot.payload.intent.sideEffect}</dd>
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
              <dt>{message("governance.semanticHash")}</dt>
              <dd>{snapshot.payload.semanticSnapshotHash}</dd>
            </dl>
          </details>
          {snapshot.payload.recentAuthenticationRequired &&
          !configuration.recentAuthenticationRef ? (
            <p>{message("account.reauthenticate")}</p>
          ) : null}
          <div className="actions">
            <ActionButton
              disabled={busy || connection !== "connected"}
              onClick={() => void respond("approved")}
            >
              {message("chat.allowOnce")}
            </ActionButton>
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
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
