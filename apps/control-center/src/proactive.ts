import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useState } from "react";
import { accountRequest } from "./components/account-login.js";
import {
  type ControlCenterRuntimeConfiguration,
  type GatewayClient,
  refreshRuntimeConfiguration,
} from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

export type ProactiveOverview = Extract<
  GatewayV2Snapshot,
  { type: "proactive.overview.snapshot" }
>["payload"];
export type ProactiveInsight = ProactiveOverview["insights"][number];
export type ProactiveDecision = ProactiveOverview["decisions"][number];
export type ProactiveAuditItem = ProactiveOverview["audit"]["items"][number];
export type ProactiveQuietPeriod = ProactiveOverview["quietHours"][number];
export type ProactiveRating = NonNullable<ProactiveInsight["rating"]>;
export type ProactiveReview = Extract<
  GatewayV2Snapshot,
  { type: "proactive.review.snapshot" }
>["payload"];
export type DecisionChain = Extract<
  GatewayV2Snapshot,
  { type: "decision.chain.snapshot" }
>["payload"];
export type ProactiveReviewItem = ProactiveReview["items"][number];
export type ProactiveCheckupAction = "confirm" | "delete" | "merge" | "undo";
export interface ProactiveReviewRating {
  readonly key: string;
  readonly rating: ProactiveRating | null;
}
export type ProactiveWeekly = Extract<
  GatewayV2Snapshot,
  { type: "proactive.weekly.snapshot" }
>["payload"];
export type ObservationDay = ProactiveWeekly["observation"]["days"][number];
export type ObservationCheckItem = ObservationDay["checks"][number];
export type CalibrationGroupSummary = ProactiveWeekly["report"]["groups"][number];
export type DecisionEmail = Extract<
  GatewayV2Snapshot,
  { type: "decision.email.snapshot" }
>["payload"];
export interface ProactiveWeeklyAccess {
  readonly read: (end?: string | null) => Promise<ProactiveWeekly>;
  readonly recentAuthentication: () => Promise<{
    readonly reference: string | null;
    readonly csrfToken: string;
  }>;
  readonly identityMethod: () => Promise<"built-in" | "cloudflare-access" | null>;
  readonly start: (startDay: string, recentAuthenticationRef: string) => Promise<void>;
  readonly markGapCase: (caseId: string, endDay: string, marked: boolean) => Promise<void>;
}
export interface ProactiveSettings {
  readonly enabled: boolean;
  readonly quietHours: readonly ProactiveQuietPeriod[];
  readonly importantSenders: readonly string[];
}

export const PROACTIVE_GOOGLE_START_PATH = "/api/proactive/v1/google/start";
const PROACTIVE_REFRESH_MS = 300_000;

export interface ProactiveModel {
  readonly overview: ProactiveOverview | null;
  readonly review: ProactiveReview | null;
  readonly weekly: ProactiveWeeklyAccess | null;
  readonly readChain: ((decisionId: string) => Promise<DecisionChain>) | null;
  readonly readMail: ((messageId: string) => Promise<DecisionEmail>) | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly respondInsight: (
    insight: Pick<ProactiveInsight, "id">,
    action: "done" | "mute" | "reopen" | "rate",
    rating?: ProactiveRating | null,
  ) => Promise<boolean>;
  readonly rateDecision: (
    decision: Pick<ProactiveDecision, "id">,
    rating: ProactiveRating | null,
  ) => Promise<boolean>;
  readonly rateReview: (ratings: readonly ProactiveReviewRating[]) => Promise<boolean>;
  readonly actCheckup: (
    key: string,
    action: ProactiveCheckupAction,
    keep?: string | null,
  ) => Promise<boolean>;
  readonly saveSettings: (settings: ProactiveSettings) => Promise<boolean>;
  readonly disconnect: () => Promise<boolean>;
  readonly clearRecords: () => Promise<boolean>;
  readonly connect: () => void;
}

export function useProactive(input: {
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connected: boolean;
  readonly refreshSignal: number;
  readonly assign?: (url: string) => void;
}): ProactiveModel | null {
  const { client, configuration, connected, refreshSignal } = input;
  const assign = input.assign ?? ((url: string) => window.location.assign(url));
  const available =
    configuration?.installedGatewayV2Operations?.includes("proactive.overview.read") ?? false;
  const reviewAvailable =
    configuration?.installedGatewayV2Operations?.includes("proactive.review.read") ?? false;
  const weeklyAvailable =
    configuration?.installedGatewayV2Operations?.includes("proactive.weekly.read") ?? false;
  const chainAvailable =
    configuration?.installedGatewayV2Operations?.includes("decision.chain.read") ?? false;
  const mailAvailable =
    configuration?.installedGatewayV2Operations?.includes("decision.email.read") ?? false;
  const [overview, setOverview] = useState<ProactiveOverview | null>(null);
  const [review, setReview] = useState<ProactiveReview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void reload;
    void refreshSignal;
    if (!available || !client || !configuration || !connected) return;
    let disposed = false;
    void client
      .query(queryMessage(configuration, "proactive.overview.read", {}))
      .then((result) => {
        if (result.type !== "proactive.overview.snapshot") throw new Error("PROACTIVE_INVALID");
        if (!disposed) {
          setOverview(result.payload);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    if (reviewAvailable)
      void client
        .query(queryMessage(configuration, "proactive.review.read", {}))
        .then((result) => {
          if (result.type === "proactive.review.snapshot" && !disposed) setReview(result.payload);
        })
        .catch(() => {
          if (!disposed) setReview(null);
        });
    return () => {
      disposed = true;
    };
  }, [available, reviewAvailable, client, configuration, connected, reload, refreshSignal]);
  useEffect(() => {
    if (!available || !connected) return;
    const timer = window.setInterval(() => setReload((value) => value + 1), PROACTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [available, connected]);
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }, []);
  if (!available || !client || !configuration) return null;
  const send = (type: GatewayV2Command["type"], payload: unknown) =>
    run(() => client.mutate(commandMessage(configuration, type, payload, { risk: "medium" })));
  const weekly: ProactiveWeeklyAccess | null = weeklyAvailable
    ? {
        read: async (end = null) => {
          const result = await client.query(
            queryMessage(configuration, "proactive.weekly.read", { end }),
          );
          if (result.type !== "proactive.weekly.snapshot") throw new Error("PROACTIVE_INVALID");
          return result.payload;
        },
        recentAuthentication: async () => {
          const fresh = await refreshRuntimeConfiguration(window.fetch.bind(window), configuration);
          return { reference: fresh.recentAuthenticationRef ?? null, csrfToken: fresh.csrfToken };
        },
        identityMethod: async () => {
          const value = await accountRequest("method").catch(() => null);
          return value && typeof value === "object" && "method" in value
            ? value.method === "built-in" || value.method === "cloudflare-access"
              ? value.method
              : null
            : null;
        },
        markGapCase: async (caseId, endDay, marked) => {
          await client.mutate(
            commandMessage(
              configuration,
              "proactive.gapcase.mark",
              { caseId, endDay, marked },
              { risk: "low" },
            ),
          );
        },
        start: async (startDay, recentAuthenticationRef) => {
          await client.mutate(
            commandMessage(
              configuration,
              "proactive.observation.start",
              { startDay, recentAuthenticationRef },
              { risk: "medium" },
            ),
          );
        },
      }
    : null;
  const readChain = chainAvailable
    ? async (decisionId: string) => {
        const result = await client.query(
          queryMessage(configuration, "decision.chain.read", { decisionId }),
        );
        if (result.type !== "decision.chain.snapshot") throw new Error("PROACTIVE_INVALID");
        return result.payload;
      }
    : null;
  const readMail = mailAvailable
    ? async (messageId: string) => {
        const result = await client.query(
          queryMessage(configuration, "decision.email.read", { messageId }),
        );
        if (result.type !== "decision.email.snapshot") throw new Error("PROACTIVE_INVALID");
        return result.payload;
      }
    : null;
  return {
    overview,
    review,
    weekly,
    readChain,
    readMail,
    failed,
    busy,
    respondInsight: (insight, action, rating = null) =>
      send("proactive.insight.respond", { insightId: insight.id, action, rating }),
    rateDecision: (decision, rating) =>
      send("proactive.decision.rate", { decisionId: decision.id, rating }),
    rateReview: (ratings) =>
      send("proactive.review.rate", {
        ratings: ratings.map(({ key, rating }) => ({ key, rating })),
      }),
    actCheckup: (key, action, keep = null) =>
      send("proactive.review.checkup", { key, action, keep }),
    saveSettings: (settings) =>
      send("proactive.settings.set", {
        enabled: settings.enabled,
        quietHours: settings.quietHours,
        importantSenders: settings.importantSenders,
      }),
    disconnect: () => send("proactive.source.manage", { source: "gmail", action: "disconnect" }),
    clearRecords: () =>
      send("proactive.source.manage", { source: "gmail", action: "clear_records" }),
    connect: () => assign(PROACTIVE_GOOGLE_START_PATH),
  };
}

export function proactiveSettings(overview: ProactiveOverview): ProactiveSettings {
  return {
    enabled: overview.enabled,
    quietHours: overview.quietHours,
    importantSenders: overview.importantSenders,
  };
}

export type ProactiveGroup = "due" | "today" | "check" | "week" | "later" | "none" | "know";
export const PROACTIVE_GROUP_ORDER: readonly ProactiveGroup[] = [
  "due",
  "today",
  "check",
  "week",
  "later",
  "none",
  "know",
];
const DAY_MS = 86_400_000;

export function proactiveGroup(insight: ProactiveInsight, now: Date): ProactiveGroup {
  if (insight.result === "check") return "check";
  if (insight.result === "know") return "know";
  if (!insight.dueAt) return "none";
  const due = Date.parse(insight.dueAt);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  if (due < now.valueOf()) return "due";
  if (due < today + DAY_MS) return "today";
  if (due < today + 7 * DAY_MS) return "week";
  return "later";
}

export function proactiveDueCount(overview: ProactiveOverview | null, now: Date): number {
  if (!overview) return 0;
  const urgent = overview.insights.filter((insight) => {
    const group = proactiveGroup(insight, now);
    return insight.status === "open" && (group === "due" || group === "today");
  }).length;
  return urgent + (overview.connection.status === "needs_reconnect" ? 1 : 0);
}

export const OPEN_REMINDERS_PAGE = "himawari:open-reminders-page";
export const OPEN_SETTINGS = "himawari:open-settings";
export type SettingsTab = "general" | "notifications" | "tools" | "data";

export function openRemindersPage(insightId: string | null = null) {
  window.dispatchEvent(new CustomEvent(OPEN_REMINDERS_PAGE, { detail: insightId }));
}

export function openSettings(tab: SettingsTab) {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS, { detail: tab }));
}

export function settingsTabOf(event: Event): SettingsTab {
  const detail = (event as CustomEvent<unknown>).detail;
  return detail === "notifications" || detail === "tools" || detail === "data" ? detail : "general";
}

export function reminderFocusOf(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  return typeof detail === "string" ? detail : null;
}

export type GmailOutcome = "connected" | "failed" | "denied" | "demo";
export interface LaunchIntent {
  readonly reminder: string | null;
  readonly settings: SettingsTab | null;
  readonly gmail: GmailOutcome | null;
}

const LAUNCH_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function readLaunchIntent(
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState" | "state">,
): LaunchIntent {
  const url = new URL(location.href);
  const reminder = url.searchParams.get("reminder");
  const settings = url.searchParams.get("settings");
  const gmail = url.searchParams.get("gmail");
  if (reminder === null && settings === null && gmail === null)
    return { reminder: null, settings: null, gmail: null };
  for (const key of ["reminder", "settings", "gmail"]) url.searchParams.delete(key);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return {
    reminder: reminder && LAUNCH_ID.test(reminder) ? reminder : null,
    settings: settings === "apps" ? "tools" : settings === "notifications" ? "notifications" : null,
    gmail:
      gmail === "connected" || gmail === "failed" || gmail === "denied" || gmail === "demo"
        ? gmail
        : null,
  };
}

export function decisionChainGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "PORT_NOT_FOUND" || (error as Error & { status?: unknown }).status === 404)
  );
}
