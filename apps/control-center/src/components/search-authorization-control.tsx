import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useEffect, useState } from "react";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { queryMessage } from "../messages.js";
import { setSearchAuthorization } from "../search-authorization.js";
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
          if (result.type !== "search.authorization.snapshot")
            throw new Error("SEARCH_AUTHORIZATION_INVALID");
          if (!disposed) {
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
    setBusy(true);
    setError(false);
    try {
      await setSearchAuthorization({
        client,
        configuration,
        storage,
        snapshot,
        enabled: !snapshot.payload.enabled,
      });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  return (
    <section className="search-authorization">
      <div className="search-authorization-panel">
        <h3>{message("review.settings.tools")}</h3>
        <label className="setting-row">
          <span>
            {message("chat.search.enable")}
            <small className="setting-description">{message("chat.search.scope")}</small>
          </span>
          <input
            type="checkbox"
            aria-label={message(
              snapshot?.payload.enabled ? "chat.search.revoke" : "chat.search.enable",
            )}
            checked={snapshot?.payload.enabled ?? false}
            disabled={
              !connected ||
              busy ||
              !configuration.authorizationRef ||
              !snapshot ||
              (!snapshot.payload.available && !snapshot.payload.enabled)
            }
            onChange={() => void change()}
          />
        </label>
        <p className="settings-note">{message("chat.search.disclosure")}</p>
        <p className="settings-note">{message("chat.search.afterRevoke")}</p>
        <div className="setting-row">
          <span>
            {message("chat.search.other")}
            <small className="setting-description">{message("review.inlineConsent")}</small>
          </span>
        </div>
        {error || loadError ? (
          <div role="alert">
            {message("error.currentUnavailable")}
            <ActionButton
              disabled={!connected || busy}
              onClick={() => setReload((value) => value + 1)}
            >
              {message("common.refresh")}
            </ActionButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}
