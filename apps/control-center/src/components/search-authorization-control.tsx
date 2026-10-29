import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useEffect, useId, useState } from "react";
import type { ControlCenterBrowserStorage } from "../browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { queryMessage } from "../messages.js";
import { setSearchAuthorization } from "../search-authorization.js";
import { LineIcon } from "./answer-footer.js";
import { ActionButton } from "./primitives.js";

export function searchRecipientHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

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
  message: (id: MessageId, values?: Record<string, string>) => string;
}) {
  const [snapshot, setSnapshot] = useState<Extract<
    GatewayV2Snapshot,
    { type: "search.authorization.snapshot" }
  > | null>(null);
  const switchId = useId();
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
        <div className="setting-row">
          <span>
            <label htmlFor={switchId}>{message("chat.search.enable")}</label>
            <small className="setting-description">
              {message("chat.search.purpose")}
              {snapshot && !snapshot.payload.enabled
                ? ` ${message("chat.search.afterRevoke")}`
                : ""}
            </small>
            <details className="settings-details">
              <summary>
                {message("chat.search.whatIsSent")}
                <LineIcon name="chevron" />
              </summary>
              <p>{message("chat.search.sentQuery")}</p>
              {snapshot?.payload.recipients.length ? (
                <ul className="search-recipients">
                  {[...new Set(snapshot.payload.recipients.map(searchRecipientHost))].map(
                    (host) => (
                      <li key={host}>
                        <code>{host}</code>
                      </li>
                    ),
                  )}
                </ul>
              ) : null}
              <p>{message("chat.search.sentLimits")}</p>
            </details>
          </span>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            aria-checked={snapshot?.payload.enabled ?? false}
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
        </div>
        <div className="setting-row">
          <span>
            {message("chat.search.other")}
            <small className="setting-description">{message("chat.search.otherScope")}</small>
          </span>
          <span className="setting-fixed">{message("chat.search.alwaysOn")}</span>
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
