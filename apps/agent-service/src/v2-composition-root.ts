import {
  AgentGatewayV2Service,
  type GatewayV2AccessPolicyPort,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
} from "@himawari-agent/application";
import type { GatewayV2Event, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import {
  type GatewayAuthenticatorPort,
  InProcessGatewayV2Transport,
} from "./in-process-gateway.js";

export interface AgentGatewayV2CompositionOptions {
  readonly authenticator: GatewayAuthenticatorPort;
  readonly access: GatewayV2AccessPolicyPort;
  readonly controlPlane: GatewayV2ControlPlanePort;
  readonly reads: GatewayV2ReadModelPort;
}

export class LocalAgentGatewayV2Process {
  readonly #transport: InProcessGatewayV2Transport;
  #status: "stopped" | "ready" = "stopped";

  constructor(transport: InProcessGatewayV2Transport) {
    this.#transport = transport;
  }

  start(): void {
    this.#status = "ready";
  }

  stop(): void {
    this.#status = "stopped";
  }

  request(
    credential: unknown,
    message: unknown,
  ): Promise<GatewayV2Snapshot | { readonly resultRef: string; readonly replayed: boolean }> {
    this.#assertReady();
    return this.#transport.request(credential, message) as Promise<
      GatewayV2Snapshot | { readonly resultRef: string; readonly replayed: boolean }
    >;
  }

  subscribe(credential: unknown, afterCursor: string | null): AsyncIterable<GatewayV2Event> {
    this.#assertReady();
    return this.#transport.subscribe(credential, afterCursor);
  }

  #assertReady() {
    if (this.#status !== "ready") throw new Error("GATEWAY_V2_NOT_READY");
  }
}

export function createAgentGatewayV2Composition(options: AgentGatewayV2CompositionOptions) {
  const gateway = new AgentGatewayV2Service({
    access: options.access,
    controlPlane: options.controlPlane,
    reads: options.reads,
  });
  const transport = new InProcessGatewayV2Transport(options.authenticator, gateway);
  return Object.freeze({ gateway, process: new LocalAgentGatewayV2Process(transport) });
}
