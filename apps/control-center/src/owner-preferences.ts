import { useCallback, useEffect, useRef } from "react";
import {
  ACCENT_COLORS,
  type AccentColor,
  type ControlCenterBrowserStorage,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
} from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

const SAVE_DELAY_MS = 600;

export interface SharedOwnerPreferences {
  readonly name: string | null;
  readonly locale: ControlCenterUiLocale;
  readonly accent: AccentColor;
}

function shared(
  preferences: ControlCenterPreferences,
  locale: ControlCenterUiLocale,
): SharedOwnerPreferences {
  const name = preferences.name?.trim();
  return { name: name ? name : null, locale, accent: preferences.accent ?? "violet" };
}

export function useOwnerPreferenceSync(input: {
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connected: boolean;
  readonly storage: ControlCenterBrowserStorage;
  readonly preferences: ControlCenterPreferences;
  readonly locale: ControlCenterUiLocale;
  readonly onPreferencesChange: (preferences: ControlCenterPreferences) => void;
  readonly onLocaleChange: (locale: ControlCenterUiLocale) => void;
  readonly delayMs?: number;
}) {
  const { client, configuration, connected } = input;
  const available =
    configuration?.installedGatewayV2Operations?.includes("owner.preferences.read") ?? false;
  const latest = useRef(input);
  latest.current = input;
  const timer = useRef<number | undefined>(undefined);
  const delayMs = input.delayMs ?? SAVE_DELAY_MS;

  const push = useCallback(async () => {
    const current = latest.current;
    if (!current.client || !current.configuration) return;
    try {
      await current.client.mutate(
        commandMessage(
          current.configuration,
          "owner.preferences.set",
          shared(current.preferences, current.locale),
          { risk: "medium" },
        ),
      );
      current.storage.markPreferencesUnsynced(false);
    } catch {
      current.storage.markPreferencesUnsynced(true);
    }
  }, []);

  useEffect(() => {
    if (!available || !client || !configuration || !connected) return;
    let disposed = false;
    void client
      .query(queryMessage(configuration, "owner.preferences.read", {}))
      .then((result) => {
        if (disposed || result.type !== "owner.preferences.snapshot") return;
        const current = latest.current;
        const server = result.payload;
        if (current.storage.readPreferencesUnsynced()) return void push();
        if (server.updatedAt === null) {
          if (current.preferences.name?.trim()) void push();
          return;
        }
        const { name: _name, ...rest } = current.preferences;
        const accent = ACCENT_COLORS.includes(server.accent as AccentColor)
          ? (server.accent as AccentColor)
          : rest.accent;
        current.onPreferencesChange({
          ...rest,
          ...(accent ? { accent } : {}),
          ...(server.name ? { name: server.name } : {}),
        });
        if (server.locale && server.locale !== current.locale)
          current.onLocaleChange(server.locale);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [available, client, configuration, connected, push]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const schedule = useCallback(() => {
    if (
      !latest.current.configuration?.installedGatewayV2Operations?.includes("owner.preferences.set")
    )
      return;
    latest.current.storage.markPreferencesUnsynced(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void push(), delayMs);
  }, [delayMs, push]);

  const changePreferences = useCallback(
    (next: ControlCenterPreferences) => {
      const before = shared(latest.current.preferences, latest.current.locale);
      latest.current.onPreferencesChange(next);
      latest.current = { ...latest.current, preferences: next };
      const after = shared(next, latest.current.locale);
      if (before.name !== after.name || before.accent !== after.accent) schedule();
    },
    [schedule],
  );

  const changeLocale = useCallback(
    (next: ControlCenterUiLocale) => {
      const changed = next !== latest.current.locale;
      latest.current.onLocaleChange(next);
      latest.current = { ...latest.current, locale: next };
      if (changed) schedule();
    },
    [schedule],
  );

  return { changePreferences, changeLocale };
}
