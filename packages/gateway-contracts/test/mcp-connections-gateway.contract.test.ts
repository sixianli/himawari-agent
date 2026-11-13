import { describe, expect, it } from "vitest";

import { ContractValidationError, gatewayV2MessageSchema } from "../src/index.ts";
import { fixture } from "./gateway-v2.fixture.ts";

const create = {
  name: "Claude Code",
  capabilities: ["mcp"],
  readCeiling: "private",
  pushPolicy: "ask",
};

function rejects(message: Record<string, unknown>) {
  expect(() => gatewayV2MessageSchema.parse(message)).toThrow(ContractValidationError);
}

describe("[P5-B] MCP connection gateway messages", () => {
  it("trims a name and accepts every capability once", () => {
    const parsed = gatewayV2MessageSchema.parse(
      fixture("command", "mcp.connection.create", {
        ...create,
        name: "  Codex  ",
        capabilities: ["scheduled_tasks", "mcp", "command_hooks"],
      }),
    ) as { payload: { name: string } };
    expect(parsed.payload.name).toBe("Codex");
  });

  it.each([
    ["an empty name", { name: "  " }],
    ["a name over 64 characters", { name: "名".repeat(65) }],
    ["a name with a hidden character", { name: "a​b" }],
    ["a repeated capability", { capabilities: ["mcp", "mcp"] }],
    ["an unknown capability", { capabilities: ["shell"] }],
    ["the restricted ceiling", { readCeiling: "restricted" }],
    ["an unknown push policy", { pushPolicy: "auto" }],
    ["an extra field", { secret: "x" }],
  ])("rejects a create with %s", (_name, overrides) => {
    rejects(fixture("command", "mcp.connection.create", { ...create, ...overrides }));
  });

  it("rejects a change without every field and a rotate without a connection", () => {
    rejects(fixture("command", "mcp.connection.change", { connectionId: "conn-1", name: null }));
    rejects(fixture("command", "mcp.connection.rotate", {}));
    rejects(fixture("query", "mcp.connections.read", { all: true }));
  });
});
