import { type FormEvent, useEffect, useRef, useState } from "react";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton } from "./index.js";
import { HimawariBrand } from "./brand.js";

export async function accountRequest(
  path: string,
  body?: unknown,
  csrfToken?: string,
): Promise<unknown> {
  const response = await fetch(`/api/identity/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "IDENTITY_RATE_LIMITED"
        : response.status >= 500
          ? "IDENTITY_SERVICE_UNAVAILABLE"
          : "IDENTITY_LOGIN_REJECTED",
    );
  return response.json();
}

export function AccountLogin({
  csrfToken,
  onComplete,
  onCancel,
}: {
  readonly csrfToken?: string;
  readonly onComplete: () => void;
  readonly onCancel?: () => void;
}) {
  const { message } = useControlCenterIntl();
  const [step, setStep] = useState<"password" | "factor">("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const factorRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === "factor") factorRef.current?.focus();
  }, [step]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      if (step === "password") {
        await accountRequest(
          csrfToken ? "reauthenticate" : "password",
          {
            username: data.get("username"),
            password: data.get("password"),
            deviceLabel: data.get("deviceLabel") || message("authentication.deviceLabel"),
          },
          csrfToken,
        );
        form.reset();
        setStep("factor");
      } else {
        await accountRequest("verify", { code: data.get("code") });
        form.reset();
        onComplete();
      }
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === "IDENTITY_RATE_LIMITED"
          ? message("account.rateLimited")
          : caught instanceof Error && caught.message === "IDENTITY_SERVICE_UNAVAILABLE"
            ? message("error.currentUnavailable")
            : message("account.rejected"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="account-card" aria-labelledby="account-login-heading">
      <HimawariBrand wordmark />
      <h2 id="account-login-heading">
        {message(csrfToken ? "account.reauthenticate" : "account.signIn")}
      </h2>
      <p>{message(step === "password" ? "account.passwordHelp" : "account.factorHelp")}</p>
      <form onSubmit={(event) => void submit(event)} key={step}>
        {step === "password" ? (
          <>
            <label>
              {message("account.username")}
              <input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                required
              />
            </label>
            <label>
              {message("account.password")}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                // HTML counts UTF-16 units; the account accepts up to 128 Unicode code points.
                maxLength={256}
                required
              />
            </label>
            {!csrfToken ? (
              <label>
                {message("account.deviceLabel")}
                <input
                  name="deviceLabel"
                  autoComplete="off"
                  defaultValue={message("authentication.deviceLabel")}
                  maxLength={80}
                  required
                />
              </label>
            ) : null}
          </>
        ) : (
          <label>
            {message("account.factor")}
            <input
              ref={factorRef}
              name="code"
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={80}
              required
            />
          </label>
        )}
        {error ? <p role="alert">{error}</p> : null}
        <ActionButton type="submit" disabled={busy}>
          {message(
            busy
              ? "account.verifying"
              : step === "password"
                ? "account.continue"
                : "account.verify",
          )}
        </ActionButton>
        {step === "factor" ? (
          <ActionButton
            variant="quiet"
            type="button"
            disabled={busy}
            onClick={() => {
              setStep("password");
              setError(null);
            }}
          >
            {message("account.restart")}
          </ActionButton>
        ) : null}
        {onCancel ? (
          <ActionButton type="button" variant="quiet" onClick={onCancel}>
            {message("governed.cancel")}
          </ActionButton>
        ) : null}
      </form>
      <p className="account-help">{message("account.recoveryHelp")}</p>
    </section>
  );
}

interface DeviceView {
  readonly id: string;
  readonly label: string;
  readonly lastSeenAt: string;
  readonly current: boolean;
}
function deviceViews(value: unknown): readonly DeviceView[] {
  if (!value || typeof value !== "object" || !("devices" in value) || !Array.isArray(value.devices))
    throw new Error("IDENTITY_LOGIN_REJECTED");
  return value.devices.map((device: unknown) => {
    if (
      !device ||
      typeof device !== "object" ||
      !("id" in device) ||
      typeof device.id !== "string" ||
      !("label" in device) ||
      typeof device.label !== "string" ||
      !("lastSeenAt" in device) ||
      typeof device.lastSeenAt !== "string" ||
      !("current" in device) ||
      typeof device.current !== "boolean"
    )
      throw new Error("IDENTITY_LOGIN_REJECTED");
    return {
      id: device.id,
      label: device.label,
      lastSeenAt: device.lastSeenAt,
      current: device.current,
    };
  });
}

export function AccountDevices({
  csrfToken,
  onSignedOut,
  onReauthenticated,
}: {
  readonly csrfToken: string;
  readonly onSignedOut: () => void;
  readonly onReauthenticated: () => void;
}) {
  const { message } = useControlCenterIntl();
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  const [error, setError] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void revision;
    let active = true;
    void accountRequest("devices")
      .then(deviceViews)
      .then((items) => {
        if (active) {
          setDevices(items);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const mutate = async (device?: DeviceView) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await accountRequest(
        device ? "devices/revoke" : "logout",
        device ? { deviceId: device.id } : {},
        csrfToken,
      );
      if (!device || device.current) onSignedOut();
      else setRevision((value) => value + 1);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  if (reauthenticate)
    return (
      <AccountLogin
        csrfToken={csrfToken}
        onCancel={() => setReauthenticate(false)}
        onComplete={() => {
          setReauthenticate(false);
          onReauthenticated();
        }}
      />
    );
  return (
    <section className="account-card account-devices">
      <h2>{message("nav.sessionsDevices")}</h2>
      <p>{message("account.devicesHelp")}</p>
      {error ? <p role="alert">{message("account.deviceActionFailed")}</p> : null}
      <ul>
        {devices.map((device) => (
          <li key={device.id}>
            <div>
              <strong>{device.label}</strong>
              {device.current ? <span> · {message("account.currentDevice")}</span> : null}
              <p>
                {message("account.lastSeen")}:{" "}
                <time dateTime={device.lastSeenAt}>
                  {new Date(device.lastSeenAt).toLocaleString()}
                </time>
              </p>
            </div>
            <ActionButton disabled={busy} variant="secondary" onClick={() => void mutate(device)}>
              {message("account.revoke")}
            </ActionButton>
          </li>
        ))}
      </ul>
      <ActionButton disabled={busy} onClick={() => setReauthenticate(true)}>
        {message("account.reauthenticate")}
      </ActionButton>
      <ActionButton disabled={busy} variant="secondary" onClick={() => void mutate()}>
        {message("account.signOut")}
      </ActionButton>
    </section>
  );
}
