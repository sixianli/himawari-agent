import { useEffect, useState } from "react";
import type { BrowserEntry } from "../browser-entry.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { SunflowerMark } from "./brand.js";
import { ActionButton } from "./primitives.js";

export const AUTOMATIC_RETRY_SECONDS = 5;

export function BrowserEntryScreen({
  entry,
  onRetry,
  onVerifyEmail,
}: {
  readonly entry: BrowserEntry | null;
  readonly onRetry: () => void;
  readonly onVerifyEmail: () => void;
}) {
  const { message } = useControlCenterIntl();
  const automatic = entry?.kind === "unreachable" && entry.automatic;
  const [seconds, setSeconds] = useState(AUTOMATIC_RETRY_SECONDS);
  useEffect(() => {
    if (!automatic) return;
    setSeconds(AUTOMATIC_RETRY_SECONDS);
    const timer = window.setInterval(() => setSeconds((value) => value - 1), 1000);
    return () => window.clearInterval(timer);
  }, [automatic]);
  useEffect(() => {
    if (automatic && seconds <= 0) onRetry();
  }, [automatic, seconds, onRetry]);

  if (entry?.kind === "access-expired")
    return (
      <main className="browser-entry" aria-labelledby="browser-entry-title">
        <SunflowerMark />
        <div className="browser-entry-text">
          <h1 id="browser-entry-title">{message("entry.expired.title")}</h1>
          <p>{message("entry.expired.body")}</p>
        </div>
        <ActionButton className="browser-entry-action" onClick={onVerifyEmail}>
          {message("entry.expired.action")}
        </ActionButton>
      </main>
    );
  if (entry?.kind === "unreachable")
    return (
      <main className="browser-entry is-unreachable" aria-labelledby="browser-entry-title">
        <SunflowerMark />
        <div className="browser-entry-text">
          <h1 id="browser-entry-title">{message("entry.unreachable.title")}</h1>
          <p>{message("entry.unreachable.body")}</p>
        </div>
        <div className="browser-entry-actions">
          <ActionButton className="browser-entry-action" variant="secondary" onClick={onRetry}>
            {message("loading.retry")}
          </ActionButton>
          {automatic ? (
            <output>
              {message("entry.unreachable.retrying", { seconds: Math.max(seconds, 0) })}
            </output>
          ) : null}
        </div>
      </main>
    );
  return (
    <main className="browser-entry is-opening">
      <SunflowerMark busy />
      <output>{message("entry.opening")}</output>
    </main>
  );
}
