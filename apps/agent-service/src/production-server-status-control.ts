import type { ClockPort, ProductConfiguration } from "@himawari-agent/application";
import type { GatewayV2Query, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";

export const PRODUCTION_SERVER_STATUS_OPERATIONS = Object.freeze(["server.status.read"] as const);

export interface ServerStatusHealthPort {
  authenticatedSnapshot(authenticated: boolean): {
    readonly live: boolean;
    readonly ready: boolean;
    readonly status: "healthy" | "degraded" | "not_ready" | "not_live";
    readonly dependencies: readonly {
      readonly name: string;
      readonly required: boolean;
      readonly status: "healthy" | "degraded" | "blocked" | "unavailable";
      readonly reasonCode: string | null;
    }[];
  };
}

export interface ProductionServerStatusControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly health: ServerStatusHealthPort;
  readonly clock: ClockPort;
}

export class ProductionServerStatusControl {
  readonly #options: ProductionServerStatusControlOptions;

  constructor(options: ProductionServerStatusControlOptions) {
    this.#options = options;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "server.status.read")
      throw new Error("SERVER_STATUS_OPERATION_NOT_INSTALLED");
    const snapshot = this.#options.health.authenticatedSnapshot(true);
    return {
      ...query,
      kind: "snapshot",
      type: "server.status.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        live: snapshot.live,
        ready: snapshot.ready,
        status: snapshot.status,
        dependencies: snapshot.dependencies.map((dependency) => ({
          name: dependency.name,
          required: dependency.required,
          status: dependency.status,
          reasonCode: dependency.reasonCode,
        })),
        generatedAt: this.#options.clock.now(),
      },
    };
  }
}
