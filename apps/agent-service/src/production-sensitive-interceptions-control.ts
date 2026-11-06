import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  SENSITIVE_INTERCEPTION_PAGE_LIMIT,
  type SensitiveInterceptionStorePort,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_SENSITIVE_INTERCEPTION_OPERATIONS = Object.freeze([
  "sensitive.interceptions.read",
  "sensitive.interceptions.clear",
] as const);

export interface ProductionSensitiveInterceptionsControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: SensitiveInterceptionStorePort;
  readonly clock: ClockPort;
  readonly beforeRead?: () => Promise<void>;
}

export class ProductionSensitiveInterceptionsControl {
  readonly #options: ProductionSensitiveInterceptionsControlOptions;

  constructor(options: ProductionSensitiveInterceptionsControlOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "sensitive.interceptions.read")
      throw new Error("SENSITIVE_INTERCEPTIONS_OPERATION_NOT_INSTALLED");
    await this.#options.beforeRead?.();
    const scope = this.#scope();
    const [page, summary] = await Promise.all([
      this.#options.store.list({
        ...scope,
        limit: SENSITIVE_INTERCEPTION_PAGE_LIMIT,
        before: query.payload.before,
      }),
      this.#options.store.summarize(scope),
    ]);
    return {
      ...query,
      kind: "snapshot",
      type: "sensitive.interceptions.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        counts: {
          masked: summary.masked,
          withheld: summary.withheld,
          notSaved: summary.not_saved,
        },
        items: page.items.map((item) => ({
          id: item.id,
          threadId: item.threadId,
          source: item.source,
          purpose: item.purpose,
          part: item.part,
          category: item.category,
          outcome: item.outcome,
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
          seenCount: item.seenCount,
        })),
        next: page.next,
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
        "SENSITIVE_INTERCEPTIONS_OWNER_REQUIRED",
      );
    if (command.type !== "sensitive.interceptions.clear")
      throw new Error("SENSITIVE_INTERCEPTIONS_OPERATION_NOT_INSTALLED");
    await this.#options.beforeRead?.();
    const { cleared } = await this.#options.store.clear({ ownerId, agentId });
    return { resultRef: `sensitive-interceptions-cleared:${cleared}`, replayed: false };
  }
}
