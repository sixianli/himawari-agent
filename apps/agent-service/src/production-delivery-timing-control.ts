import {
  ApplicationPortError,
  type ClockPort,
  DELIVERY_TIMING_KEYS,
  DELIVERY_TIMING_RANGES,
  type DeliveryTimingConfiguration,
  type DeliveryTimingSettingsStorePort,
  deliveryTimingOverrideValue,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

import { DELIVERY_TIMING_COPY, DELIVERY_TIMING_VALUE } from "./delivery-timing-copy.js";

export const PRODUCTION_DELIVERY_TIMING_OPERATIONS = Object.freeze([
  "delivery_timing.settings.read",
  "delivery_timing.settings.change",
] as const);

export interface ProductionDeliveryTimingControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly defaults: DeliveryTimingConfiguration;
  readonly store: DeliveryTimingSettingsStorePort;
  readonly clock: ClockPort;
  readonly changed: (overrides: Readonly<Record<string, number>>) => void;
}

export class ProductionDeliveryTimingControl {
  readonly #options: ProductionDeliveryTimingControlOptions;

  constructor(options: ProductionDeliveryTimingControlOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "delivery_timing.settings.read")
      throw new Error("DELIVERY_TIMING_SETTINGS_OPERATION_NOT_INSTALLED");
    const settings = await this.#options.store.read(this.#scope());
    const { locale } = query.payload;
    return {
      ...query,
      kind: "snapshot",
      type: "delivery_timing.settings.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        items: DELIVERY_TIMING_KEYS.map((key) => {
          const [minimum, maximum] = DELIVERY_TIMING_RANGES[key];
          const override = deliveryTimingOverrideValue(key, settings.overrides);
          const copy = DELIVERY_TIMING_COPY[key][locale];
          return {
            key,
            label: copy.label,
            description: copy.description,
            unit: copy.unit,
            kind: DELIVERY_TIMING_VALUE[key].kind,
            storageUnit: DELIVERY_TIMING_VALUE[key].storageUnit,
            value: override ?? this.#options.defaults[key],
            defaultValue: this.#options.defaults[key],
            minimum,
            maximum,
            overridden: override !== undefined,
          };
        }),
        revision: settings.revision,
        generatedAt: this.#options.clock.now(),
      },
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
        "DELIVERY_TIMING_SETTINGS_OWNER_REQUIRED",
      );
    if (command.type !== "delivery_timing.settings.change")
      throw new Error("DELIVERY_TIMING_SETTINGS_OPERATION_NOT_INSTALLED");
    const { key, value } = command.payload;
    const range = Object.hasOwn(DELIVERY_TIMING_RANGES, key)
      ? DELIVERY_TIMING_RANGES[key as keyof DeliveryTimingConfiguration]
      : undefined;
    if (range === undefined || (value !== null && (value < range[0] || value > range[1])))
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "DELIVERY_TIMING_SETTING_INVALID",
      );
    const saved = await this.#options.store.write({
      ownerId,
      agentId,
      key: command.payload.key,
      value: command.payload.value,
      expectedRevision: command.payload.expectedRevision,
      now: this.#options.clock.now(),
    });
    this.#options.changed(saved.overrides);
    return { resultRef: `delivery-timing-settings:${saved.revision}`, replayed: false };
  }
}
