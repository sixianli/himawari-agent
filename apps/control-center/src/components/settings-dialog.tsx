import { type ReactNode, useEffect, useState } from "react";
import {
  ACCENT_COLORS,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
  OWNER_NAME_LIMIT,
} from "../browser-storage.js";
import { UI_LOCALES, useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton, Dropdown, ModalDialog } from "./index.js";

const THEMES = ["light", "dark", "system"] as const;
const themeIcons: Readonly<Record<(typeof THEMES)[number], ReactNode>> = {
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  dark: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" />,
  system: (
    <>
      <rect x="3.5" y="5" width="17" height="11.5" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
};

export function SettingsDialog({
  open,
  onClose,
  locale,
  onLocaleChange,
  preferences,
  onPreferencesChange,
  tools,
  data,
  notifications,
  initialTab = "general",
}: {
  open: boolean;
  onClose: () => void;
  locale: ControlCenterUiLocale;
  onLocaleChange: (locale: ControlCenterUiLocale) => void;
  preferences: ControlCenterPreferences;
  onPreferencesChange: (preferences: ControlCenterPreferences) => void;
  tools?: ReactNode;
  data?: ReactNode;
  notifications?: ReactNode;
  initialTab?: string;
}) {
  const { message } = useControlCenterIntl();
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  const accent = preferences.accent ?? "violet";
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={message("settings.title")}
      closeLabel={message("common.close")}
    >
      <div className="settings-body">
        <nav className="settings-nav" aria-label={message("settings.tabsLabel")}>
          {(
            [
              "general",
              ...(notifications ? (["notifications"] as const) : []),
              "tools",
              "data",
            ] as const
          ).map((id) => (
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
                <span>{message("settings.name")}</span>
                <input
                  className="setting-input"
                  type="text"
                  autoComplete="nickname"
                  maxLength={OWNER_NAME_LIMIT}
                  aria-label={message("settings.name")}
                  value={preferences.name ?? ""}
                  onChange={(event) => {
                    const { name: _name, ...rest } = preferences;
                    onPreferencesChange(
                      event.target.value ? { ...rest, name: event.target.value } : rest,
                    );
                  }}
                />
              </label>
              <div className="setting-row">
                <span>{message("locale.label")}</span>
                <Dropdown
                  label={message("locale.label")}
                  value={locale}
                  options={UI_LOCALES.map((value) => ({
                    value,
                    label: message(
                      value === "zh-CN"
                        ? "locale.zhCN"
                        : value === "ja"
                          ? "locale.ja"
                          : "locale.en",
                    ),
                  }))}
                  onChange={onLocaleChange}
                />
              </div>
              <div className="setting-row">
                <span id="setting-theme">{message("appearance.theme")}</span>
                <fieldset className="theme-switch" aria-labelledby="setting-theme">
                  {THEMES.map((theme) => (
                    <label key={theme} data-checked={preferences.theme === theme}>
                      <input
                        type="radio"
                        name="setting-theme"
                        value={theme}
                        checked={preferences.theme === theme}
                        onChange={() => onPreferencesChange({ ...preferences, theme })}
                      />
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        {themeIcons[theme]}
                      </svg>
                      {message(`review.${theme}`)}
                    </label>
                  ))}
                </fieldset>
              </div>
              <div className="setting-row setting-row-top">
                <span id="setting-accent">{message("appearance.accent")}</span>
                <fieldset className="accent-swatches" aria-labelledby="setting-accent">
                  {ACCENT_COLORS.map((color) => (
                    <label key={color} data-accent={color} data-checked={accent === color}>
                      <input
                        type="radio"
                        name="setting-accent"
                        value={color}
                        checked={accent === color}
                        onChange={() => onPreferencesChange({ ...preferences, accent: color })}
                      />
                      <i aria-hidden="true" />
                      {message(`appearance.${color}`)}
                    </label>
                  ))}
                </fieldset>
              </div>
            </>
          ) : tab === "tools" ? (
            tools
          ) : tab === "notifications" ? (
            notifications
          ) : (
            data
          )}
        </section>
      </div>
    </ModalDialog>
  );
}
