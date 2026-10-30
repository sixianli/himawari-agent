import type { AgentId, OwnerId } from "@himawari-agent/domain";

export type OwnerPreferenceLocale = "zh-CN" | "en" | "ja";
export type OwnerPreferenceAccent = "violet" | "blue" | "teal" | "amber" | "rose" | "graphite";
export type OwnerPreferenceTheme = "light" | "dark" | "system";
export type OwnerPreferenceThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface OwnerPreferencesScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface OwnerPreferenceValues {
  readonly name: string | null;
  readonly locale: OwnerPreferenceLocale | null;
  readonly accent: OwnerPreferenceAccent | null;
  readonly theme: OwnerPreferenceTheme | null;
  readonly modelRef: string | null;
  readonly thinkingLevel: OwnerPreferenceThinkingLevel | null;
}

export interface OwnerPreferences extends OwnerPreferenceValues {
  readonly revision: number;
  readonly updatedAt: string | null;
}

export interface OwnerPreferencesStorePort {
  read(input: OwnerPreferencesScope): Promise<OwnerPreferences>;
  write(
    input: OwnerPreferencesScope &
      OwnerPreferenceValues & { readonly expectedRevision: number; readonly now: string },
  ): Promise<OwnerPreferences>;
}
