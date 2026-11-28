import { createHash, randomUUID } from "node:crypto";
import type {
  AgentGatewayV2Port,
  GatewayAuthenticationContext,
  GatewayV2InboundMessage,
  SessionDeviceStatePort,
} from "@himawari-agent/application";
import {
  GATEWAY_V2_SCHEMA_VERSION,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";

export interface OwnerSettingsAuthority {
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export interface OwnerSettingsGatewayPort {
  query(
    sessionId: string,
    type: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  command(input: {
    readonly sessionId: string;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly recentlyAuthenticated: boolean;
  }): Promise<unknown>;
}

export class OwnerSettingsSessionError extends Error {
  constructor() {
    super("OWNER_SETTINGS_SESSION_INACTIVE");
    this.name = "OwnerSettingsSessionError";
  }
}

const SERVER_FILLED = ["authorizationRef", "recentAuthenticationRef"] as const;

function machineId(prefix: string, parts: readonly string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 40)}`;
}

export class ProductionOwnerSettingsGateway implements OwnerSettingsGatewayPort {
  readonly #ownerId: string;
  readonly #gateway: AgentGatewayV2Port;
  readonly #sessions: Pick<SessionDeviceStatePort, "readSession">;
  readonly #authority: () => OwnerSettingsAuthority;

  constructor(options: {
    readonly ownerId: string;
    readonly gateway: AgentGatewayV2Port;
    readonly sessions: Pick<SessionDeviceStatePort, "readSession">;
    readonly authority: () => OwnerSettingsAuthority;
  }) {
    this.#ownerId = options.ownerId;
    this.#gateway = options.gateway;
    this.#sessions = options.sessions;
    this.#authority = options.authority;
  }

  async #authentication(sessionId: string): Promise<GatewayAuthenticationContext> {
    const session = await this.#sessions
      .readSession(sessionId as Parameters<SessionDeviceStatePort["readSession"]>[0])
      .catch(() => undefined);
    if (!session || session.status !== "active" || session.ownerId !== this.#ownerId)
      throw new OwnerSettingsSessionError();
    return {
      subjectId: this.#ownerId,
      ownerId: this.#ownerId,
      deviceId: session.deviceId,
      authenticatedAt: session.lastActiveAt,
      authenticationRef: session.authenticationRef,
      sessionId: session.id,
    };
  }

  #envelope(
    authentication: GatewayAuthenticationContext,
    kind: "query" | "command",
    type: string,
    messageId: string,
  ) {
    const authority = this.#authority();
    return {
      schemaVersion: GATEWAY_V2_SCHEMA_VERSION,
      kind,
      type,
      messageId,
      correlationId: messageId,
      causationId: null,
      dataClassification: "private",
      risk: "low",
      authorizationRef: kind === "command" ? authentication.authenticationRef : null,
      scope: { ownerId: this.#ownerId, agentId: authority.agentId },
      authority: {
        deploymentId: authority.deploymentId,
        authorityEpoch: authority.authorityEpoch,
        fencingToken: authority.fencingToken,
      },
      actor: { actorType: "owner", actorId: this.#ownerId },
    };
  }

  async query(
    sessionId: string,
    type: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    const authentication = await this.#authentication(sessionId);
    const messageId = `settings-read:${randomUUID()}`;
    const message = gatewayV2MessageSchema.parse({
      ...this.#envelope(authentication, "query", type, messageId),
      payload,
    }) as GatewayV2InboundMessage;
    const snapshot = (await this.#gateway.request(authentication, message)) as {
      readonly payload?: unknown;
    };
    return snapshot.payload;
  }

  async command(input: {
    readonly sessionId: string;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly recentlyAuthenticated: boolean;
  }): Promise<unknown> {
    const authentication = await this.#authentication(input.sessionId);
    const payload: Record<string, unknown> = { ...input.payload };
    for (const key of SERVER_FILLED) {
      if (!Object.hasOwn(payload, key)) continue;
      payload[key] =
        key === "authorizationRef" || input.recentlyAuthenticated
          ? authentication.authenticationRef
          : null;
    }
    const messageId = machineId("settings-change", [input.idempotencyKey]);
    const message = gatewayV2MessageSchema.parse({
      ...this.#envelope(authentication, "command", input.type, messageId),
      idempotencyKey: input.idempotencyKey,
      payload,
    }) as GatewayV2InboundMessage;
    return this.#gateway.request(authentication, message);
  }
}
