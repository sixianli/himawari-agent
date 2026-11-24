import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import { OwnerRuleError, type ProductionOwnerRuleWriter } from "./production-owner-rules.js";

export const PRODUCTION_QUIET_HOURS_OPERATIONS = Object.freeze([
  "quiet_hours.read",
  "quiet_hours.set",
] as const);

export interface ProductionQuietHoursControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly rules: Pick<ProductionOwnerRuleWriter, "quietHours" | "setQuietHours">;
  readonly clock: ClockPort;
}

export class ProductionQuietHoursControl {
  readonly #options: ProductionQuietHoursControlOptions;

  constructor(options: ProductionQuietHoursControlOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "quiet_hours.read") throw new Error("QUIET_HOURS_OPERATION_NOT_INSTALLED");
    const state = await this.#options.rules.quietHours();
    return {
      ...query,
      kind: "snapshot",
      type: "quiet_hours.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        version: state.version,
        editable: state.editable,
        enabled: state.enabled,
        start: state.start,
        end: state.end,
        classes: [...state.classes],
        rules: state.rules.map(({ ruleId, summary }) => ({ ruleId, summary })),
      },
    };
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const { ownerId, agentId } = this.#options.configuration;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "QUIET_HOURS_OWNER_REQUIRED",
      );
    if (command.type !== "quiet_hours.set") throw new Error("QUIET_HOURS_OPERATION_NOT_INSTALLED");
    try {
      const state = await this.#options.rules.setQuietHours(command.payload);
      return { resultRef: `quiet-hours:${state.version}`, replayed: false };
    } catch (error) {
      if (error instanceof OwnerRuleError)
        throw new ApplicationPortError(
          error.code === "RULE_CONFLICT"
            ? PORT_ERROR_CODES.CONFLICT
            : PORT_ERROR_CODES.INVALID_OPERATION,
          error.code,
        );
      throw error;
    }
  }
}
