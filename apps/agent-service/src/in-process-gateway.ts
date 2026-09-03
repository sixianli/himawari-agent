import type {
  AgentGatewayPort,
  AgentGatewayV2Port,
  GatewayAuthenticationContext,
  GatewayRequestMessage,
  GatewayRequestResult,
} from "@himawari-agent/application";
import {
  type EventSubscription,
  type StreamEvent,
  gatewayMessageSchema,
  gatewayV2MessageSchema,
  type GatewayV2Event,
  type GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export interface GatewayAuthenticatorPort {
  authenticate(credential: unknown): Promise<GatewayAuthenticationContext>;
}

export class InProcessGatewayV2Transport {
  readonly #authenticator: GatewayAuthenticatorPort;
  readonly #gateway: AgentGatewayV2Port;

  constructor(authenticator: GatewayAuthenticatorPort, gateway: AgentGatewayV2Port) {
    this.#authenticator = authenticator;
    this.#gateway = gateway;
  }

  async request(
    credential: unknown,
    input: unknown,
  ): Promise<GatewayRequestResult | GatewayV2Snapshot> {
    const authentication = await this.#authenticator.authenticate(credential);
    const message = gatewayV2MessageSchema.parse(input);
    if (message.kind !== "command" && message.kind !== "query")
      throw new TypeError(`Gateway v2 request cannot dispatch ${message.kind} messages`);
    return this.#gateway.request(authentication, message);
  }

  async *subscribe(credential: unknown, afterCursor: string | null): AsyncIterable<GatewayV2Event> {
    const authentication = await this.#authenticator.authenticate(credential);
    for await (const event of this.#gateway.subscribe(authentication, afterCursor)) yield event;
  }
}

export class InProcessGatewayTransport {
  private readonly authenticator: GatewayAuthenticatorPort;
  private readonly gateway: AgentGatewayPort;

  constructor(authenticator: GatewayAuthenticatorPort, gateway: AgentGatewayPort) {
    this.authenticator = authenticator;
    this.gateway = gateway;
  }

  async request(credential: unknown, input: unknown): Promise<GatewayRequestResult> {
    const authentication = await this.authenticator.authenticate(credential);
    const message = gatewayMessageSchema.parse(input);
    if (message.kind !== "command" && message.kind !== "query") {
      throw new TypeError(`Gateway request transport cannot dispatch ${message.kind} messages`);
    }
    return this.gateway.request(authentication, message as GatewayRequestMessage);
  }

  async *subscribe(credential: unknown, input: unknown): AsyncIterable<StreamEvent> {
    const authentication = await this.authenticator.authenticate(credential);
    const message = gatewayMessageSchema.parse(input);
    if (message.kind !== "subscription") {
      throw new TypeError(
        `Gateway subscription transport cannot dispatch ${message.kind} messages`,
      );
    }
    for await (const event of this.gateway.subscribe(
      authentication,
      message as EventSubscription,
    )) {
      yield event;
    }
  }
}
