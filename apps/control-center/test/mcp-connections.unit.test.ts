import { describe, expect, it, vi } from "vitest";
import type { ControlCenterRuntimeConfiguration } from "../src/gateway-client.ts";
import {
  mcpConnectionsInstalled,
  takeMcpConnectionAddress,
  withinNameLimit,
} from "../src/mcp-connections.ts";

const base: ControlCenterRuntimeConfiguration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf-fixture",
  authorizationRef: "authorization-01",
  installedGatewayV2Operations: [
    "mcp.connections.read",
    "mcp.connection.create",
    "mcp.connection.change",
    "mcp.connection.rotate",
  ],
};

function reply(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("[P5-B] connected agents in the control center", () => {
  it("shows the page only when the service installed every operation it needs", () => {
    expect(mcpConnectionsInstalled(base)).toBe(true);
    expect(
      mcpConnectionsInstalled({
        ...base,
        installedGatewayV2Operations: ["mcp.connections.read", "mcp.connection.create"],
      }),
    ).toBe(false);
    expect(mcpConnectionsInstalled(null)).toBe(false);
  });

  it("turns the one-time path into a full address on this site", async () => {
    const fetcher = reply(200, { connectionId: "conn-a", path: "/api/mcp/v1/key" });
    await expect(
      takeMcpConnectionAddress(
        "/api/mcp-connections/address",
        "conn-a",
        "https://h.example",
        fetcher,
      ),
    ).resolves.toBe("https://h.example/api/mcp/v1/key");
    expect(fetcher).toHaveBeenCalledWith("/api/mcp-connections/address?connectionId=conn-a", {
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("REVERSE: refuses an address that is gone or points to another site", async () => {
    await expect(
      takeMcpConnectionAddress("/a", "conn-a", "https://h.example", reply(404, {})),
    ).rejects.toThrow("MCP_CONNECTION_ADDRESS_UNAVAILABLE");
    await expect(
      takeMcpConnectionAddress(
        "/a",
        "conn-a",
        "https://h.example",
        reply(200, { path: "https://evil.example/x" }),
      ),
    ).rejects.toThrow("MCP_CONNECTION_ADDRESS_INVALID");
  });

  it("cuts a name at 64 characters the way the service counts them, after leading spaces", () => {
    const face = "\u{1F600}";
    expect(withinNameLimit(face.repeat(64))).toBe(face.repeat(64));
    expect(withinNameLimit(face.repeat(65))).toBe(face.repeat(64));
    expect(withinNameLimit(`  ${"n".repeat(65)}`)).toBe(`  ${"n".repeat(64)}`);
    expect(withinNameLimit("Claude Code")).toBe("Claude Code");
  });
});
