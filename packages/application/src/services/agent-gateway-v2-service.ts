import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type AgentGatewayV2Port,
  type GatewayAuthenticationContext,
  type GatewayCommandResult,
  type GatewayV2AccessPolicyPort,
  type GatewayV2ControlPlanePort,
  type GatewayV2InboundMessage,
  type GatewayV2ReadModelPort,
} from "../ports/index.js";
import type { GatewayV2Event, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";

export interface AgentGatewayV2ServiceDependencies {
  readonly access: GatewayV2AccessPolicyPort;
  readonly controlPlane: GatewayV2ControlPlanePort;
  readonly reads: GatewayV2ReadModelPort;
}

export class AgentGatewayV2Service implements AgentGatewayV2Port {
  private readonly dependencies: AgentGatewayV2ServiceDependencies;

  constructor(dependencies: AgentGatewayV2ServiceDependencies) {
    this.dependencies = dependencies;
  }

  async request(
    authentication: GatewayAuthenticationContext,
    message: GatewayV2InboundMessage,
  ): Promise<GatewayCommandResult | GatewayV2Snapshot> {
    await this.authorize(authentication, message);
    return message.kind === "command"
      ? this.dependencies.controlPlane.execute({ authentication, command: message })
      : this.dependencies.reads.query(message);
  }

  async *subscribe(
    authentication: GatewayAuthenticationContext,
    afterCursor: string | null,
  ): AsyncIterable<GatewayV2Event> {
    const seen = new Set<string>();
    const sequences = new Map<string, number>();
    for await (const event of this.dependencies.reads.subscribe({ authentication, afterCursor })) {
      if (event.scope.ownerId !== authentication.ownerId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Gateway v2 event is outside authenticated Owner scope",
        );
      }
      if (seen.has(event.payload.cursor)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Gateway v2 stream repeated a durable cursor",
        );
      }
      const key = `${event.payload.scopeKind}:${event.payload.scopeId}`;
      const previous = sequences.get(key) ?? 0;
      if (event.payload.sequence <= previous) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Gateway v2 stream is not scope ordered",
        );
      }
      seen.add(event.payload.cursor);
      sequences.set(key, event.payload.sequence);
      yield event;
    }
  }

  private async authorize(
    authentication: GatewayAuthenticationContext,
    message: GatewayV2InboundMessage,
  ): Promise<void> {
    if (
      authentication.ownerId !== message.scope.ownerId ||
      authentication.subjectId !== message.actor.actorId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Authenticated Gateway v2 identity does not match product scope",
      );
    }
    const decision = await this.dependencies.access.authorize({ authentication, message });
    if (!decision.allowed) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Authenticated Gateway v2 device is not authorized",
        { reasonCode: decision.reasonCode },
      );
    }
  }
}
