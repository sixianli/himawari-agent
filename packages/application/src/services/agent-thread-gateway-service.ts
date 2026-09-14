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
    signal?: AbortSignal,
  ): AsyncIterable<ThreadGatewayEvent> {
    await this.#authorize(authentication, subscription);
    const seen = new Set<string>();
    const revisions = new Map<string, number>();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const iterator = this.#dependencies.reads
      .subscribe({ authentication, subscription, signal: controller.signal })
      [Symbol.asyncIterator]();
    let pending = iterator.next();
    try {
      while (!controller.signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        });
        let item: IteratorResult<ThreadGatewayEvent> | null;
        try {
          item = await Promise.race([pending, tick]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (controller.signal.aborted) return;
        await this.#authorize(authentication, subscription);
        if (!item) continue;
        if (item.done) return;
        const event = item.value;
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
        pending = iterator.next();
      }
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", abort);
      void pending.catch(() => undefined);
      void iterator.return?.().catch(() => undefined);
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
