import { type ReactNode, useEffect, useState } from "react";
import {
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
  OWNER_NAME_LIMIT,
} from "../browser-storage.js";
import { readBuildInfo } from "../build-info.js";
import { useLocaleFormat } from "../i18n/locale-format.js";
import { UI_LOCALES, useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton, Dropdown, ModalDialog } from "./index.js";
import { Glyph, type GlyphName } from "./glyphs.js";

const THEMES = ["light", "dark", "system"] as const;
const themeIcons: Readonly<Record<(typeof THEMES)[number], GlyphName>> = {
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
  devices,
  personalization,
  account,
  initialTab = "general",
  onTabChange,
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
  devices?: ReactNode;
  personalization?: ReactNode;
  account?: ReactNode;
  initialTab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const { message } = useControlCenterIntl();
  const format = useLocaleFormat();
  const build = readBuildInfo();
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
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
              "personalization",
              "general",
              ...(notifications ? (["notifications"] as const) : []),
              ...(devices ? (["devices"] as const) : []),
              "tools",
              "data",
            ] as const
          ).map((id) => (
            <ActionButton
              key={id}
              variant="quiet"
              aria-pressed={tab === id}
              onClick={() => {
                setTab(id);
                onTabChange?.(id);
              }}
            >
              {message(`review.settings.${id}`)}
            </ActionButton>
          ))}
        </nav>
        <section className="settings-content">
          {tab === "personalization" ? (
            <>
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
              {personalization}
            </>
          ) : tab === "general" ? (
            <>
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
                      <Glyph name={themeIcons[theme]} />
                      {message(`review.${theme}`)}
                    </label>
                  ))}
                </fieldset>
              </div>
              {account}
              {build ? (
                <p className="settings-version">
                  {message("settings.version", {
                    revision: build.revision,
                    date: new Intl.DateTimeFormat(format.locale, {
                      year: "numeric",
                      month: "numeric",
                      day: "numeric",
                      timeZone: "UTC",
                    }).format(new Date(build.date)),
                  })}
                </p>
              ) : null}
            </>
          ) : tab === "tools" ? (
            tools
          ) : tab === "notifications" ? (
            notifications
          ) : tab === "devices" ? (
            devices
          ) : (
            data
          )}
        </section>
      </div>
    </ModalDialog>
  );
}
