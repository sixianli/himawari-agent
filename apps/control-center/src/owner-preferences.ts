import { useCallback, useEffect, useRef } from "react";
import {
  ACCENT_COLORS,
  type AccentColor,
  type ControlCenterBrowserStorage,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
  SHARED_OWNER_PREFERENCE_FIELDS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

const SAVE_DELAY_MS = 600;

type SharedField = (typeof SHARED_OWNER_PREFERENCE_FIELDS)[number];

export interface SharedOwnerPreferences {
  readonly name: string | null;
  readonly locale: ControlCenterUiLocale;
  readonly accent: AccentColor;
  readonly theme: ControlCenterPreferences["theme"];
  readonly modelRef: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
}

interface ServerPreferences {
  readonly name: string | null;
  readonly locale: ControlCenterUiLocale | null;
  readonly accent: string | null;
  readonly theme: ControlCenterPreferences["theme"] | null;
  readonly modelRef: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly revision: number;
  readonly updatedAt: string | null;
}

function shared(
  preferences: ControlCenterPreferences,
  locale: ControlCenterUiLocale,
): SharedOwnerPreferences {
  const name = preferences.name?.trim();
  return {
    name: name ? name : null,
    locale,
    accent: preferences.accent ?? "violet",
    theme: preferences.theme,
    modelRef: preferences.modelRef ?? null,
    thinkingLevel: preferences.thinkingLevel ?? null,
  };
}

function toPreferences(values: SharedOwnerPreferences): ControlCenterPreferences {
  return {
    theme: values.theme,
    accent: values.accent,
    ...(values.name ? { name: values.name } : {}),
    ...(values.modelRef ? { modelRef: values.modelRef } : {}),
    ...(values.thinkingLevel ? { thinkingLevel: values.thinkingLevel } : {}),
  };
}

function fromServer(server: ServerPreferences, local: SharedOwnerPreferences) {
  const neverSaved = server.updatedAt === null;
  const accent = ACCENT_COLORS.includes(server.accent as AccentColor)
    ? (server.accent as AccentColor)
    : local.accent;
  return {
    name: neverSaved ? local.name : server.name,
    locale: server.locale ?? local.locale,
    accent,
    theme: server.theme ?? local.theme,
    modelRef: server.modelRef,
    thinkingLevel: server.thinkingLevel,
  } satisfies SharedOwnerPreferences;
}

function differs(left: SharedOwnerPreferences, right: ServerPreferences): boolean {
  return SHARED_OWNER_PREFERENCE_FIELDS.some((field) => left[field] !== right[field]);
}

function savedRevision(resultRef: string, fallback: number): number {
  const revision = Number(/^owner-preferences:(\d+)$/.exec(resultRef)?.[1]);
  return Number.isSafeInteger(revision) ? revision : fallback;
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
  const dirty = useRef(new Set<SharedField>());
  const delayMs = input.delayMs ?? SAVE_DELAY_MS;

  const apply = useCallback((values: SharedOwnerPreferences) => {
    const current = latest.current;
    const next = toPreferences(values);
    current.onPreferencesChange(next);
    if (values.locale !== current.locale) current.onLocaleChange(values.locale);
    latest.current = { ...current, preferences: next, locale: values.locale };
  }, []);

  const readServer = useCallback(async (): Promise<ServerPreferences | null> => {
    const current = latest.current;
    if (!current.client || !current.configuration) return null;
    const result = await current.client.query(
      queryMessage(current.configuration, "owner.preferences.read", {}),
    );
    return result.type === "owner.preferences.snapshot"
      ? (result.payload as ServerPreferences)
      : null;
  }, []);

  const send = useCallback(async (expectedRevision: number) => {
    const current = latest.current;
    if (!current.client || !current.configuration) throw new Error("OWNER_PREFERENCES_OFFLINE");
    const result = await current.client.mutate(
      commandMessage(
        current.configuration,
        "owner.preferences.set",
        { ...shared(current.preferences, current.locale), expectedRevision },
        { risk: "medium" },
      ),
    );
    current.storage.savePreferencesRevision(savedRevision(result.resultRef, expectedRevision + 1));
    current.storage.markPreferencesUnsynced(false);
    dirty.current.clear();
  }, []);

  const push = useCallback(async () => {
    const storage = latest.current.storage;
    try {
      await send(storage.readPreferencesRevision());
      return;
    } catch {
      storage.markPreferencesUnsynced(true);
    }
    try {
      const server = await readServer();
      if (!server || server.revision === storage.readPreferencesRevision()) return;
      const mine = shared(latest.current.preferences, latest.current.locale);
      const merged = { ...fromServer(server, mine) } as Record<SharedField, unknown>;
      for (const field of dirty.current) merged[field] = mine[field];
      apply(merged as unknown as SharedOwnerPreferences);
      storage.savePreferencesRevision(server.revision);
      await send(server.revision);
    } catch {
      storage.markPreferencesUnsynced(true);
    }
  }, [apply, readServer, send]);

  const pull = useCallback(async () => {
    const server = await readServer();
    if (!server) return;
    const current = latest.current;
    const storage = current.storage;
    if (storage.readPreferencesUnsynced() && server.revision === storage.readPreferencesRevision())
      return void push();
    dirty.current.clear();
    storage.markPreferencesUnsynced(false);
    storage.savePreferencesRevision(server.revision);
    const values = fromServer(server, shared(current.preferences, current.locale));
    apply(values);
    if (
      differs(values, server) &&
      current.configuration?.installedGatewayV2Operations?.includes("owner.preferences.set")
    )
      void push();
  }, [apply, push, readServer]);

  useEffect(() => {
    if (!available || !client || !configuration || !connected) return;
    let disposed = false;
    const refresh = () => {
      if (!disposed && document.visibilityState !== "hidden") void pull().catch(() => undefined);
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [available, client, configuration, connected, pull]);

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
      const changed = SHARED_OWNER_PREFERENCE_FIELDS.filter(
        (field) => before[field] !== after[field],
      );
      for (const field of changed) dirty.current.add(field);
      if (changed.length > 0) schedule();
    },
    [schedule],
  );

  const changeLocale = useCallback(
    (next: ControlCenterUiLocale) => {
      const changed = next !== latest.current.locale;
      latest.current.onLocaleChange(next);
      latest.current = { ...latest.current, locale: next };
      if (changed) {
        dirty.current.add("locale");
        schedule();
      }
    },
    [schedule],
  );

  const changeModelChoice = useCallback(
    (choice: { readonly modelRef: string; readonly thinkingLevel: string }) => {
      const { modelRef: _model, thinkingLevel: _level, ...rest } = latest.current.preferences;
      changePreferences({
        ...rest,
        ...(choice.modelRef ? { modelRef: choice.modelRef } : {}),
        ...(THINKING_LEVELS.includes(choice.thinkingLevel as ThinkingLevel)
          ? { thinkingLevel: choice.thinkingLevel as ThinkingLevel }
          : {}),
      });
    },
    [changePreferences],
  );

  return { changePreferences, changeLocale, changeModelChoice };
}
