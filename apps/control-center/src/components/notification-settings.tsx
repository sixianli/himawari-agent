import { useEffect, useMemo, useState } from "react";
import type { ControlCenterUiLocale } from "../browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import {
  currentPushBrowser,
  type PushBrowser,
  PushController,
  type PushStatus,
  pushPlatform,
  pushSupport,
  WEB_PUSH_KINDS,
  type WebPushKind,
} from "../web-push.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

export function NotificationSettings({
  client,
  configuration,
  locale,
  connected,
  message,
  browser: providedBrowser,
}: {
  client: Pick<GatewayClient, "query" | "mutate">;
  configuration: ControlCenterRuntimeConfiguration;
  locale: ControlCenterUiLocale;
  connected: boolean;
  message: Message;
  browser?: PushBrowser;
}) {
  const browser = useMemo(() => providedBrowser ?? currentPushBrowser(), [providedBrowser]);
  const controller = useMemo(
    () => new PushController(client, configuration, browser),
    [client, configuration, browser],
  );
  const support = pushSupport(browser);
  const platform = pushPlatform(browser);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [permission, setPermission] = useState(controller.permission);
  const [kinds, setKinds] = useState<readonly WebPushKind[]>(WEB_PUSH_KINDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    void reload;
    if (!connected) return;
    void Promise.all([controller.status(), controller.currentSubscriptionId()])
      .then(([next, id]) => {
        if (disposed) return;
        setStatus(next);
        const mine = next.subscriptions.find((item) => item.subscriptionId === id);
        setCurrentId(mine ? mine.subscriptionId : null);
        if (mine) setKinds(mine.kinds);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
    };
  }, [controller, connected, reload]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  const deviceLabel = message(browser.standalone ? "push.deviceApp" : "push.deviceBrowser", {
    platform,
  });
  const enable = (nextKinds: readonly WebPushKind[], sendTest: boolean) =>
    run(async () => {
      if (!status?.publicKey) return;
      const result = await controller.enable({
        publicKey: status.publicKey,
        locale,
        deviceLabel,
        kinds: nextKinds,
        sendTest,
      });
      setPermission(controller.permission);
      if (result === "enabled" && sendTest) setTestSent(true);
    });
  const toggle = (kind: WebPushKind) => {
    const next = kinds.includes(kind)
      ? kinds.filter((value) => value !== kind)
      : WEB_PUSH_KINDS.filter((value) => value === kind || kinds.includes(value));
    setKinds(next);
    if (currentId) void enable(next, false);
  };
  const mine = status?.subscriptions.find((item) => item.subscriptionId === currentId);
  const others = status?.subscriptions.filter((item) => item.subscriptionId !== currentId) ?? [];
  const delivered = (value: string | null) =>
    value
      ? message("push.lastDelivered", {
          time: new Intl.DateTimeFormat(locale, {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(value)),
        })
      : message("push.neverDelivered");
  const phone = platform === "iPhone" || platform === "iPad";
  return (
    <section className="notification-settings">
      {support === "install-first" ? (
        <div className="push-install">
          <h4>{message("push.installTitle")}</h4>
          <p className="settings-note">{message("push.installWhy")}</p>
          <ol>
            <li>{message("push.installStep1")}</li>
            <li>{message("push.installStep2")}</li>
            <li>{message("push.installStep3")}</li>
          </ol>
          <p className="settings-note">{message("push.installNote")}</p>
        </div>
      ) : support === "unsupported" ? (
        <p className="settings-note">{message("push.unsupported")}</p>
      ) : status && !status.available ? (
        <p className="settings-note">{message("push.unavailable")}</p>
      ) : (
        <>
          {WEB_PUSH_KINDS.map((kind) => (
            <label className="setting-row" key={kind}>
              <span>
                {message(`push.kind.${kind}`)}
                <small className="setting-description">{message(`push.kind.${kind}Hint`)}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={kinds.includes(kind)}
                aria-label={message(`push.kind.${kind}`)}
                checked={kinds.includes(kind)}
                disabled={busy || !status}
                onChange={() => toggle(kind)}
              />
            </label>
          ))}
          {permission === "denied" ? (
            <div className="push-denied" role="alert">
              <strong>{message("push.deniedTitle")}</strong>
              {phone ? (
                <p>{message("push.deniedPhone")}</p>
              ) : (
                <ol>
                  <li>{message("push.denied1")}</li>
                  <li>{message("push.denied2")}</li>
                </ol>
              )}
            </div>
          ) : mine ? (
            <div className="push-device">
              <div className="setting-row">
                <span>
                  {message("push.thisDevice")} · {message("push.on")}
                  <small className="setting-description">
                    {mine.deviceLabel} · {delivered(mine.lastDeliveredAt)}
                  </small>
                </span>
                <span className="actions">
                  <ActionButton
                    variant="secondary"
                    disabled={busy || !connected}
                    onClick={() =>
                      void run(async () => {
                        await controller.test(mine.subscriptionId);
                        setTestSent(true);
                      })
                    }
                  >
                    {message("push.test")}
                  </ActionButton>
                  <ActionButton
                    variant="quiet"
                    disabled={busy || !connected}
                    onClick={() => void run(() => controller.remove(mine.subscriptionId))}
                  >
                    {message("push.turnOff")}
                  </ActionButton>
                </span>
              </div>
              {mine.state === "paused" ? (
                <div className="push-paused" role="alert">
                  <strong>{message("push.pausedTitle")}</strong>
                  <p>{message("push.pausedBody", { code: mine.failureCode ?? "-" })}</p>
                </div>
              ) : null}
              {testSent ? <p className="settings-note">{message("push.testSent")}</p> : null}
            </div>
          ) : (
            <div className="setting-row">
              <span>
                <ActionButton
                  variant="primary"
                  disabled={busy || !connected || !status?.publicKey || kinds.length === 0}
                  onClick={() => void enable(kinds, true)}
                >
                  {message("push.enable")}
                </ActionButton>
                <small className="setting-description">{message("push.enableHint")}</small>
              </span>
            </div>
          )}
          {others.length ? (
            <>
              <h4>{message("push.otherDevices")}</h4>
              <ul className="push-devices">
                {others.map((item) => (
                  <li className="setting-row" key={item.subscriptionId}>
                    <span>
                      {item.deviceLabel}
                      <small className="setting-description">
                        {item.state === "paused"
                          ? message("push.pausedTitle")
                          : delivered(item.lastDeliveredAt)}
                      </small>
                    </span>
                    <ActionButton
                      variant="quiet"
                      disabled={busy || !connected}
                      onClick={() => void run(() => controller.remove(item.subscriptionId))}
                    >
                      {message("push.remove")}
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      {error ? (
        <div role="alert">
          {message("push.failed")}
          <ActionButton disabled={busy} onClick={() => setReload((value) => value + 1)}>
            {message("common.refresh")}
          </ActionButton>
        </div>
      ) : null}
    </section>
  );
}
