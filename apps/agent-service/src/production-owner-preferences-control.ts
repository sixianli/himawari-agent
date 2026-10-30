import {
  ApplicationPortError,
  type ClockPort,
  type OwnerPreferencesStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_OWNER_PREFERENCE_OPERATIONS = Object.freeze([
  "owner.preferences.read",
  "owner.preferences.set",
] as const);

export interface ProductionOwnerPreferencesControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: OwnerPreferencesStorePort;
  readonly clock: ClockPort;
}

export class ProductionOwnerPreferencesControl {
  readonly #options: ProductionOwnerPreferencesControlOptions;

  constructor(options: ProductionOwnerPreferencesControlOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "owner.preferences.read")
      throw new Error("OWNER_PREFERENCES_OPERATION_NOT_INSTALLED");
    const preferences = await this.#options.store.read(this.#scope());
    return {
      ...query,
      kind: "snapshot",
      type: "owner.preferences.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: { ...preferences },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const { ownerId, agentId } = this.#scope();
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "OWNER_PREFERENCES_OWNER_REQUIRED",
      );
    if (command.type !== "owner.preferences.set")
      throw new Error("OWNER_PREFERENCES_OPERATION_NOT_INSTALLED");
    const saved = await this.#options.store.write({
      ownerId,
      agentId,
      name: command.payload.name,
      locale: command.payload.locale,
      accent: command.payload.accent,
      theme: command.payload.theme,
      modelRef: command.payload.modelRef,
      thinkingLevel: command.payload.thinkingLevel,
      expectedRevision: command.payload.expectedRevision,
      now: this.#options.clock.now(),
    });
    return { resultRef: `owner-preferences:${saved.revision}`, replayed: false };
  }
}
