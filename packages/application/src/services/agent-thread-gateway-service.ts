import type {
  ThreadGatewayEvent,
  ThreadGatewayRequestResult,
  ThreadGatewaySubscription,
} from "@himawari-agent/gateway-contracts";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type AgentThreadGatewayPort,
  type GatewayAuthenticationContext,
  type ThreadGatewayAccessPolicyPort,
  type ThreadGatewayControlPlanePort,
  type ThreadGatewayInboundMessage,
  type ThreadGatewayRequestMessage,
  type ThreadGatewayReadModelPort,
} from "../ports/index.js";

export interface AgentThreadGatewayServiceDependencies {
  readonly access: ThreadGatewayAccessPolicyPort;
  readonly controlPlane: ThreadGatewayControlPlanePort;
  readonly reads: ThreadGatewayReadModelPort;
}

export class AgentThreadGatewayService implements AgentThreadGatewayPort {
  readonly #dependencies: AgentThreadGatewayServiceDependencies;

  constructor(dependencies: AgentThreadGatewayServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async request(
    authentication: GatewayAuthenticationContext,
    message: ThreadGatewayRequestMessage,
  ): Promise<ThreadGatewayRequestResult> {
    await this.#authorize(authentication, message);
    return message.kind === "command"
      ? this.#dependencies.controlPlane.execute({ authentication, command: message })
      : this.#dependencies.reads.query({ authentication, query: message });
  }

  async *subscribe(
    authentication: GatewayAuthenticationContext,
    subscription: ThreadGatewaySubscription,
  ): AsyncIterable<ThreadGatewayEvent> {
    await this.#authorize(authentication, subscription);
    const seen = new Set<string>();
    const revisions = new Map<string, number>();
    for await (const event of this.#dependencies.reads.subscribe({
      authentication,
      subscription,
    })) {
      if (event.scope.ownerId !== authentication.ownerId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Thread Gateway event is outside authenticated Owner scope",
        );
      }
      if (seen.has(event.payload.cursor)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Thread Gateway stream repeated a durable cursor",
        );
      }
      const previousRevision = revisions.get(event.payload.threadId) ?? 0;
      if (event.payload.revision < previousRevision) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Thread Gateway stream moved a Thread revision backwards",
        );
      }
      seen.add(event.payload.cursor);
      revisions.set(event.payload.threadId, event.payload.revision);
      yield event;
    }
  }

  async #authorize(
    authentication: GatewayAuthenticationContext,
    message: ThreadGatewayInboundMessage,
  ): Promise<void> {
    if (
      authentication.ownerId !== message.scope.ownerId ||
      authentication.subjectId !== message.actor.actorId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Authenticated Thread Gateway identity does not match product scope",
      );
    }
    const decision = await this.#dependencies.access.authorize({ authentication, message });
    if (!decision.allowed) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Authenticated Thread Gateway device is not authorized",
        { reasonCode: decision.reasonCode },
      );
    }
  }
}
