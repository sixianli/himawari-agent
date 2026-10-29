import type { AgentId, OwnerId } from "@himawari-agent/domain";

export type OwnerPreferenceLocale = "zh-CN" | "en" | "ja";
export type OwnerPreferenceAccent = "violet" | "blue" | "teal" | "amber" | "rose" | "graphite";

export interface OwnerPreferencesScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface OwnerPreferences {
  readonly name: string | null;
  readonly locale: OwnerPreferenceLocale | null;
  readonly accent: OwnerPreferenceAccent | null;
  readonly updatedAt: string | null;
}

export interface OwnerPreferencesStorePort {
  read(input: OwnerPreferencesScope): Promise<OwnerPreferences>;
  write(
    input: OwnerPreferencesScope & Omit<OwnerPreferences, "updatedAt"> & { readonly now: string },
  ): Promise<OwnerPreferences>;
}
