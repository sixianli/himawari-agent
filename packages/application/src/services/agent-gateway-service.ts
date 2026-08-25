import type { EventSubscription, StreamEvent } from "@himawari-agent/gateway-contracts";
import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type AgentGatewayPort,
  type GatewayAccessPolicyPort,
  type GatewayAuthenticationContext,
  type GatewayControlPlanePort,
  type GatewayInboundMessage,
  type GatewayReadModelPort,
  type GatewayRequestMessage,
  type GatewayRequestResult,
} from "../ports/index.js";

export interface AgentGatewayServiceDependencies {
  readonly access: GatewayAccessPolicyPort;
  readonly controlPlane: GatewayControlPlanePort;
  readonly reads: GatewayReadModelPort;
}

export class AgentGatewayService implements AgentGatewayPort {
  private readonly dependencies: AgentGatewayServiceDependencies;

  constructor(dependencies: AgentGatewayServiceDependencies) {
    this.dependencies = dependencies;
  }

  async request(
    authentication: GatewayAuthenticationContext,
    message: GatewayRequestMessage,
  ): Promise<GatewayRequestResult> {
    await this.authorize(authentication, message);
    if (message.kind === "command") {
      return this.dependencies.controlPlane.execute({ authentication, command: message });
    }
    if (message.type === "thread.get_snapshot") {
      return this.dependencies.reads.getThreadSnapshot(message);
    }
    if (message.type === "run.get_snapshot") {
      return this.dependencies.reads.getRunSnapshot(message);
    }
    return this.dependencies.reads.queryTrace(message);
  }

  async *subscribe(
    authentication: GatewayAuthenticationContext,
    subscription: EventSubscription,
  ): AsyncIterable<StreamEvent> {
    await this.authorize(authentication, subscription);
    const seenCursors = new Set<string>();
    const runSequences = new Map<string, number>();
    for await (const event of this.dependencies.reads.subscribe(subscription)) {
      this.assertEventScope(subscription, event);
      if (seenCursors.has(event.payload.cursor)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `Gateway subscription ${subscription.payload.subscriptionId} repeated cursor ${event.payload.cursor}`,
          { cursor: event.payload.cursor },
        );
      }
      const previous = runSequences.get(event.payload.runId) ?? 0;
      if (event.payload.sequence <= previous) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `Gateway subscription ${subscription.payload.subscriptionId} is not Run-ordered`,
          {
            runId: event.payload.runId,
            previousSequence: String(previous),
            sequence: String(event.payload.sequence),
          },
        );
      }
      seenCursors.add(event.payload.cursor);
      runSequences.set(event.payload.runId, event.payload.sequence);
      yield event;
    }
  }

  private async authorize(
    authentication: GatewayAuthenticationContext,
    message: GatewayInboundMessage,
  ): Promise<void> {
    if (
      authentication.ownerId !== message.scope.ownerId ||
      authentication.subjectId !== message.actor.actorId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Authenticated Gateway identity does not match the product message scope",
        {
          authenticatedOwnerId: authentication.ownerId,
          messageOwnerId: message.scope.ownerId,
          subjectId: authentication.subjectId,
          actorId: message.actor.actorId,
        },
      );
    }
    const decision = await this.dependencies.access.authorize({ authentication, message });
    if (!decision.allowed) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Authenticated Gateway device is not authorized for this product operation",
        { deviceId: authentication.deviceId, reasonCode: decision.reasonCode },
      );
    }
  }

  private assertEventScope(subscription: EventSubscription, event: StreamEvent): void {
    const matches =
      event.scope.ownerId === subscription.scope.ownerId &&
      event.scope.agentId === subscription.scope.agentId &&
      (subscription.payload.sessionId === null ||
        event.payload.sessionId === subscription.payload.sessionId) &&
      (subscription.payload.threadId === null ||
        event.payload.threadId === subscription.payload.threadId) &&
      (subscription.payload.runId === null || event.payload.runId === subscription.payload.runId);
    if (!matches) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Gateway event ${event.messageId} is outside subscription scope`,
        { eventId: event.messageId, subscriptionId: subscription.payload.subscriptionId },
      );
    }
  }
}
