import { useState } from "react";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { accountRequest } from "./account-login.js";
import { ActionButton } from "./index.js";

export function SignOutSetting({
  csrfToken,
  onSignedOut,
}: {
  readonly csrfToken: string;
  readonly onSignedOut: () => void;
}) {
  const { message } = useControlCenterIntl();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await accountRequest("logout", {}, csrfToken);
      onSignedOut();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <div className="setting-row">
      <ActionButton disabled={busy} variant="secondary" onClick={() => void signOut()}>
        {message("account.signOut")}
      </ActionButton>
      {failed ? <span role="alert">{message("account.deviceActionFailed")}</span> : null}
    </div>
  );
}
