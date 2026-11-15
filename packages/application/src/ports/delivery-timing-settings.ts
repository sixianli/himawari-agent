import type { AgentId, OwnerId } from "@himawari-agent/domain";

export interface DeliveryTimingSettingsScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface DeliveryTimingSettings {
  readonly overrides: Readonly<Record<string, number>>;
  readonly revision: number;
}

export interface DeliveryTimingSettingsStorePort {
  read(input: DeliveryTimingSettingsScope): Promise<DeliveryTimingSettings>;
  write(
    input: DeliveryTimingSettingsScope & {
      readonly key: string;
      readonly value: number | null;
      readonly expectedRevision: number;
      readonly now: string;
    },
  ): Promise<DeliveryTimingSettings>;
}
