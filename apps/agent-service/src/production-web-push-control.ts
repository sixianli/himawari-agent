import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type WebPushStorePort,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import type { ProductionWebPush, WebPushPresence } from "./production-web-push.js";

export const PRODUCTION_WEB_PUSH_OPERATIONS = Object.freeze([
  "push.status.read",
  "push.subscription.set",
  "push.kind.set",
  "push.test",
  "presence.heartbeat",
  "push.feedback.record",
] as const);

export function webPushSubscriptionId(endpoint: string): string {
  return `web-push-${createHash("sha256").update(endpoint).digest("hex").slice(0, 24)}`;
}

export interface ProductionWebPushControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: WebPushStorePort;
  readonly presence: WebPushPresence;
  readonly push: Pick<ProductionWebPush, "publicKey" | "sendTest"> | undefined;
  readonly clock: ClockPort;
}

export class ProductionWebPushControl {
  readonly #options: ProductionWebPushControlOptions;

  constructor(options: ProductionWebPushControlOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  #webPush() {
    const push = this.#options.push;
    return push?.publicKey ? push : undefined;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "push.status.read") throw new Error("WEB_PUSH_OPERATION_NOT_INSTALLED");
    const push = this.#webPush();
    const subscriptions = push ? await this.#options.store.listSubscriptions(this.#scope()) : [];
    const kinds = await this.#options.store.readKinds(this.#scope());
    return {
      ...query,
      kind: "snapshot",
      type: "push.status.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        available: push !== undefined,
        publicKey: push?.publicKey ?? null,
        kinds: [...kinds],
        subscriptions: subscriptions.map((subscription) => ({
          subscriptionId: subscription.id,
          deviceLabel: subscription.deviceLabel,
          endpointHost: new URL(subscription.endpoint).host,
          locale: subscription.locale,
          kinds: [...kinds],
          state: subscription.state,
          failureCode: subscription.failureCode,
          createdAt: subscription.createdAt,
          lastDeliveredAt: subscription.lastDeliveredAt,
        })),
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
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "WEB_PUSH_OWNER_REQUIRED");
    const now = this.#options.clock.now();
    if (command.type === "presence.heartbeat") {
      this.#options.presence.beat(
        `${command.actor.actorId}:${command.payload.clientId}`,
        command.payload.visible,
        now,
      );
      return { resultRef: "presence", replayed: false };
    }
    if (command.type === "push.feedback.record") {
      const recorded = await this.#options.store.recordReactions({
        ownerId,
        agentId,
        reactions: command.payload.events,
        now,
      });
      return { resultRef: `web-push-feedback:${recorded}`, replayed: false };
    }
    if (command.type === "push.kind.set") {
      const saved = await this.#options.store.setKind({
        ownerId,
        agentId,
        kind: command.payload.kind,
        enabled: command.payload.enabled,
        now,
      });
      return { resultRef: `web-push-kinds:${saved.length}`, replayed: false };
    }
    const push = this.#webPush();
    if (!push)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "WEB_PUSH_NOT_CONFIGURED");
    if (command.type === "push.test") {
      const result = await push.sendTest(command.payload.subscriptionId);
      if (result.kind !== "sent")
        throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, result.code);
      return { resultRef: `web-push-test:${command.payload.subscriptionId}`, replayed: false };
    }
    if (command.type !== "push.subscription.set")
      throw new Error("WEB_PUSH_OPERATION_NOT_INSTALLED");
    const { action, subscriptionId, endpoint, keys, locale, deviceLabel, kinds } = command.payload;
    if (action === "unsubscribe") {
      if (!subscriptionId)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "WEB_PUSH_SUBSCRIPTION_INCOMPLETE",
        );
      const removed = await this.#options.store.removeSubscription({
        ownerId,
        agentId,
        subscriptionId,
      });
      return {
        resultRef: `web-push-unsubscribed:${removed ? subscriptionId : "none"}`,
        replayed: false,
      };
    }
    if (!endpoint || !keys || !locale || !deviceLabel?.trim())
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "WEB_PUSH_SUBSCRIPTION_INCOMPLETE",
      );
    const saved = await this.#options.store.saveSubscription({
      ownerId,
      agentId,
      id: webPushSubscriptionId(endpoint),
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      locale,
      deviceLabel: deviceLabel.trim(),
      now,
    });
    if (kinds)
      await this.#options.store.writeKinds({ ownerId, agentId, kinds: [...new Set(kinds)], now });
    return { resultRef: saved.id, replayed: false };
  }
}
