import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState } from "react";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
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
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (menu.current && event.target instanceof Node && !menu.current.contains(event.target))
        menu.current.open = false;
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, []);
  const [snapshot, setSnapshot] = useState<Extract<
    GatewayV2Snapshot,
    { type: "search.authorization.snapshot" }
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [loadError, setLoadError] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    void reload;
    void refreshSignal;
    if (connected)
      void client
        .query(queryMessage(configuration, "search.authorization.read", {}))
        .then((result) => {
          if (!disposed && result.type === "search.authorization.snapshot") {
            setSnapshot(result);
            setLoadError(false);
          }
        })
        .catch(() => {
          if (!disposed) setLoadError(true);
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
    <details
      className="search-authorization"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
        </svg>
        {message("chat.execute")} <span aria-hidden="true">⌄</span>
      </summary>
      <div className="search-authorization-panel">
        <p className="search-authorization-status">
          {message(snapshot?.payload.enabled ? "chat.search.allowed" : "chat.search.ask")}
        </p>
        <p>{message("chat.search.disclosure")}</p>
        <ActionButton
          disabled={!connected || busy || !snapshot?.payload.available}
          onClick={() => void change()}
        >
          {message(snapshot?.payload.enabled ? "chat.search.revoke" : "chat.search.enable")}
        </ActionButton>
        {error || loadError ? <p role="alert">{message("error.currentUnavailable")}</p> : null}
      </div>
    </details>
  );
}
