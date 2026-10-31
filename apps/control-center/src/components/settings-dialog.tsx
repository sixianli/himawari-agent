import { type ReactNode, useEffect, useState } from "react";
import {
  ACCENT_COLORS,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
  OWNER_NAME_LIMIT,
} from "../browser-storage.js";
import { UI_LOCALES, useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton, Dropdown, ModalDialog } from "./index.js";
import { LineGlyph, type LinePath } from "./line-icons.js";

const THEMES = ["light", "dark", "system"] as const;
const themeIcons: Readonly<Record<(typeof THEMES)[number], LinePath>> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
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
                      <LineGlyph name={themeIcons[theme]} />
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
