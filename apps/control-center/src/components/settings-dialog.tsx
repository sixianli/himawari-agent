import { useEffect, useState, type ReactNode } from "react";
import {
  ACCENT_COLORS,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
} from "../browser-storage.js";
import { useControlCenterIntl, UI_LOCALES } from "../i18n/runtime.js";
import { ActionButton, ModalDialog } from "./index.js";
export function SettingsDialog({
  open,
  onClose,
  locale,
  onLocaleChange,
  preferences,
  onPreferencesChange,
  tools,
  data,
}: {
  open: boolean;
  onClose: () => void;
  locale: ControlCenterUiLocale;
  onLocaleChange: (locale: ControlCenterUiLocale) => void;
  preferences: ControlCenterPreferences;
  onPreferencesChange: (preferences: ControlCenterPreferences) => void;
  tools?: ReactNode;
  data?: ReactNode;
}) {
  const { message } = useControlCenterIntl();
  const [tab, setTab] = useState("general");
  useEffect(() => {
    if (open) setTab("general");
  }, [open]);
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={message("settings.title")}
      closeLabel={message("common.close")}
    >
      <div className="settings-body">
        <nav className="settings-nav" aria-label={message("settings.tabsLabel")}>
          {(["general", "tools", "data"] as const).map((id) => (
            <ActionButton
              key={id}
              variant="quiet"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {message(`review.settings.${id}`)}
            </ActionButton>
          ))}
        </nav>
        <section className="settings-content">
          {tab === "general" ? (
            <>
              <h3>{message("review.settings.general")}</h3>
              <label className="setting-row">
                {message("locale.label")}
                <select
                  aria-label={message("locale.label")}
                  value={locale}
                  onChange={(e) => onLocaleChange(e.target.value as ControlCenterUiLocale)}
                >
                  {UI_LOCALES.map((value) => (
                    <option key={value} value={value}>
                      {message(
                        value === "zh-CN"
                          ? "locale.zhCN"
                          : value === "ja"
                            ? "locale.ja"
                            : "locale.en",
                      )}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                {message("appearance.theme")}
                <select
                  aria-label={message("appearance.theme")}
                  value={preferences.theme}
                  onChange={(e) =>
                    onPreferencesChange({
                      ...preferences,
                      theme: e.target.value as ControlCenterPreferences["theme"],
                    })
                  }
                >
                  <option value="light">{message("review.light")}</option>
                  <option value="dark">{message("review.dark")}</option>
                  <option value="system">{message("review.system")}</option>
                </select>
              </label>
              <label className="setting-row">
                {message("appearance.accent")}
                <select
                  aria-label={message("appearance.accent")}
                  value={preferences.accent ?? "violet"}
                  onChange={(e) =>
                    onPreferencesChange({
                      ...preferences,
                      accent: e.target.value as (typeof ACCENT_COLORS)[number],
                    })
                  }
                >
                  {ACCENT_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {message(`appearance.${color}`)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="settings-note">{message("review.localeNote")}</p>
            </>
          ) : tab === "tools" ? (
            tools
          ) : (
            <>
              {data}
              <details className="local-data-details">
                <summary>{message("review.localDataTitle")}</summary>
                <p className="settings-note">{message("review.localData")}</p>
              </details>
            </>
          )}
        </section>
      </div>
    </ModalDialog>
  );
}
