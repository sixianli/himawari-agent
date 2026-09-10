import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("node:http", async (original) => ({
  ...(await original<typeof import("node:http")>()),
  createServer,
}));
import { openNetworkEgress } from "../src/network-egress.ts";
it("rejects upstream initialization instead of returning a direct-egress fallback", async () => {
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn(() =>
      queueMicrotask(() =>
        server.emit("error", Object.assign(new Error("address in use"), { code: "EADDRINUSE" })),
      ),
    ),
  });
  createServer.mockReturnValue(server);
  await expect(openNetworkEgress(["example.com:443"])).rejects.toMatchObject({
    code: "EADDRINUSE",
  });
});
