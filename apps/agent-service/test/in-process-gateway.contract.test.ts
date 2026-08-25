import {
  type GatewayAuthenticationContext,
  type GatewayAuthenticatorPort,
  type GatewayRequestResult,
  InProcessGatewayTransport,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const authenticated: GatewayAuthenticationContext = {
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-25T00:00:00.000Z",
  authenticationRef: "auth-session-01",
};

class TokenAuthenticator implements GatewayAuthenticatorPort {
  readonly credentials: unknown[] = [];

  async authenticate(credential: unknown): Promise<GatewayAuthenticationContext> {
    this.credentials.push(credential);
    if (credential !== "local-token") throw new Error("AUTHENTICATION_FAILED");
    return authenticated;
  }
}

describe("InProcessGatewayTransport", () => {
  it("authenticates outside the application service and propagates only the verified context", async () => {
    const authenticator = new TokenAuthenticator();
    const observed: GatewayAuthenticationContext[] = [];
    const gateway = {
      async request(context: GatewayAuthenticationContext): Promise<GatewayRequestResult> {
        observed.push(context);
        return { resultRef: "run:run-01", replayed: false };
      },
      async *subscribe(): AsyncIterable<never> {},
    };
    const transport = new InProcessGatewayTransport(authenticator, gateway);

    const result = await transport.request("local-token", {
      schemaVersion: "gateway.v1",
      kind: "command",
      type: "run.cancel",
      messageId: "message-01",
      correlationId: "correlation-01",
      causationId: null,
      dataClassification: "private",
      scope: { ownerId: "owner-01", agentId: "agent-01" },
      actor: { actorType: "owner", actorId: "owner-01" },
      idempotencyKey: "cancel-01",
      payload: { runId: "run-01", reasonCode: "owner_cancelled" },
    });

    expect(result).toEqual({ resultRef: "run:run-01", replayed: false });
    expect(authenticator.credentials).toEqual(["local-token"]);
    expect(observed).toEqual([authenticated]);
  });

  it("rejects malformed or response-only Gateway messages before application dispatch", async () => {
    const authenticator = new TokenAuthenticator();
    const gateway = {
      async request(): Promise<GatewayRequestResult> {
        throw new Error("must not dispatch");
      },
      async *subscribe(): AsyncIterable<never> {},
    };
    const transport = new InProcessGatewayTransport(authenticator, gateway);

    await expect(transport.request("local-token", { type: "pi.session" })).rejects.toThrow();
  });
});
