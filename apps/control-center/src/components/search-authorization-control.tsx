import { useEffect, useState } from "react";
import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import type { MessageId } from "../i18n/message-ids.js";
import { commandMessage, queryMessage } from "../messages.js";
import { ActionButton } from "./primitives.js";

export function SearchAuthorizationControl({
  client,
  configuration,
  storage,
  connected,
  refreshSignal,
  message,
}: {
  client: GatewayClient;
  configuration: ControlCenterRuntimeConfiguration;
  storage: ControlCenterBrowserStorage;
  connected: boolean;
  refreshSignal: number;
  message: (id: MessageId) => string;
}) {
  const [snapshot, setSnapshot] = useState<Extract<
    GatewayV2Snapshot,
    { type: "search.authorization.snapshot" }
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    void reload;
    void refreshSignal;
    if (connected)
      void client
        .query(queryMessage(configuration, "search.authorization.read", {}))
        .then((result) => {
          if (!disposed && result.type === "search.authorization.snapshot") setSnapshot(result);
        })
        .catch(() => {
          if (!disposed) setError(true);
        });
    return () => {
      disposed = true;
    };
  }, [client, configuration, connected, reload, refreshSignal]);
  const change = async () => {
    if (!snapshot || !connected || busy || !configuration.authorizationRef) return;
    const { revision, enabled, recipient } = snapshot.payload;
    const operationKey = `search-authorization:${revision}:${enabled ? "revoke" : "enable"}`;
    const pending = storage.readPendingGovernanceMutation(operationKey);
    const idempotencyKey = pending?.idempotencyKey ?? `governance:${crypto.randomUUID()}`;
    storage.savePendingGovernanceMutation({
      operationKey,
      idempotencyKey,
      commandType: "search.authorization.set",
      objectRef: "search-authorization",
      expectedRevision: revision,
    });
    setBusy(true);
    setError(false);
    try {
      const result = await client.mutate(
        commandMessage(
          configuration,
          "search.authorization.set",
          { expectedRevision: revision, enabled: !enabled, recipient },
          { idempotencyKey, authorizationRef: configuration.authorizationRef, risk: "high" },
        ),
      );
      storage.clearPendingGovernanceMutation(operationKey);
      setError(result.status !== "accepted" && result.status !== "replayed");
    } catch (caught) {
      if (caught && typeof caught === "object" && "status" in caught && caught.status === 409)
        storage.clearPendingGovernanceMutation(operationKey);
      setError(true);
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  return (
    <details className="search-authorization">
      <summary>
        {message(snapshot?.payload.enabled ? "chat.search.allowed" : "chat.search.ask")}
      </summary>
      <div className="search-authorization-panel">
        <p>{message("chat.search.disclosure")}</p>
        <ActionButton
          disabled={!connected || busy || !snapshot?.payload.available}
          onClick={() => void change()}
        >
          {message(snapshot?.payload.enabled ? "chat.search.revoke" : "chat.search.enable")}
        </ActionButton>
        {error ? <p role="alert">{message("error.currentUnavailable")}</p> : null}
      </div>
    </details>
  );
}
