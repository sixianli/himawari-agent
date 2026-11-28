import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const approve = {
  grantId: "grant-AAAAAAAAAAAAAAAAAAAAAA",
  name: null,
  pushPolicy: "direct",
  write: true,
};

function rejects(message: Record<string, unknown>) {
  expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
}

describe("MCP connection gateway messages", () => {
  it("trims the name an approval gives the new connection", () => {
    const parsed = gatewayV2MessageSchema.parse(
      fixture("command", "mcp.grant.approve", { ...approve, name: "  Codex  " }),
    ) as { payload: { name: string } };
    expect(parsed.payload.name).toBe("Codex");
  });

  it.each([
    ["an empty name", { name: "  " }],
    ["a name over 64 characters", { name: "名".repeat(65) }],
    ["a name with a hidden character", { name: "a​b" }],
    ["an unknown push policy", { pushPolicy: "auto" }],
    ["no write choice", { write: undefined }],
    ["an extra field", { secret: "x" }],
  ])("rejects an approval with %s", (_name, overrides) => {
    rejects(fixture("command", "mcp.grant.approve", { ...approve, ...overrides }));
  });

  it("rejects a change without every field, a deny without a grant and a read with fields", () => {
    rejects(fixture("command", "mcp.connection.change", { connectionId: "conn-1", name: null }));
    rejects(fixture("command", "mcp.grant.deny", {}));
    rejects(fixture("query", "mcp.grants.read", { all: true }));
    rejects(fixture("query", "mcp.connections.read", { all: true }));
  });

  it("no longer knows the commands that made and rotated secret addresses", () => {
    rejects(fixture("command", "mcp.connection.create", { name: "x" }));
    rejects(fixture("command", "mcp.connection.rotate", { connectionId: "conn-1" }));
  });
});
