import { mcpConnectionNameHasHiddenCharacter } from "@himawari-agent/application/mcp-connections";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { fixture } from "../../packages/gateway-contracts/test/gateway-v2.fixture.ts";

describe("[P5-B] connection names", () => {
  it("the gateway and the connection store refuse exactly the same hidden characters", () => {
    const disagreements: string[] = [];
    const codes = [
      ...Array.from({ length: 0x10000 }, (_, code) => code),
      ...Array.from({ length: 0x100 }, (_, offset) => 0xe0000 + offset - 0x10),
    ];
    for (const code of codes) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const name = `a${String.fromCodePoint(code)}b`;
      let accepted = true;
      try {
        gatewayV2MessageSchema.parse(
          fixture("command", "mcp.connection.create", {
            name,
            capabilities: ["mcp"],
            readCeiling: "private",
            pushPolicy: "ask",
          }),
        );
      } catch {
        accepted = false;
      }
      if (accepted === mcpConnectionNameHasHiddenCharacter(name))
        disagreements.push(code.toString(16));
    }
    expect(disagreements).toEqual([]);
  });
});
