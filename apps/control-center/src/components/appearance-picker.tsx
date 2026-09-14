import { useEffect, useRef } from "react";
import { ACCENT_COLORS, type ControlCenterPreferences } from "../browser-storage.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton } from "./primitives.js";

export function AppearancePicker({
  preferences,
  onChange,
}: {
  readonly preferences: ControlCenterPreferences;
  readonly onChange: (preferences: ControlCenterPreferences) => void;
}) {
  const { message } = useControlCenterIntl();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target))
        ref.current.open = false;
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, []);
  return (
    <details
      ref={ref}
      className="appearance-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={message("appearance.title")} title={message("appearance.title")}>
        ◐
      </summary>
      <div className="appearance-panel">
        <fieldset>
          <legend>{message("appearance.theme")}</legend>
          <div className="theme-choices">
            {(["light", "dark"] as const).map((theme) => (
              <ActionButton
                key={theme}
                variant="quiet"
                aria-pressed={preferences.theme === theme}
                onClick={() => onChange({ ...preferences, theme })}
              >
                {theme === "light" ? "☼ Light" : "☾ Dark"}
              </ActionButton>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>{message("appearance.accent")}</legend>
          <div className="accent-choices">
            {ACCENT_COLORS.map((accent) => (
              <ActionButton
                key={accent}
                variant="quiet"
                aria-pressed={(preferences.accent ?? "violet") === accent}
                onClick={() => onChange({ ...preferences, accent })}
              >
                <span className="accent-swatch" data-accent={accent} />
                {message(`appearance.${accent}`)}
              </ActionButton>
            ))}
          </div>
        </fieldset>
        <p>{message("appearance.hint")}</p>
      </div>
    </details>
  );
}
