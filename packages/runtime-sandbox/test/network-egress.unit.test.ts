import { createServer, request } from "node:http";
import type * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicEgressAddress, openNetworkEgress } from "../src/network-egress.ts";

const { lookup, dial } = vi.hoisted(() => ({ lookup: vi.fn(), dial: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  connect: dial,
}));
afterEach(() => {
  vi.clearAllMocks();
});

function get(
  proxy: Awaited<ReturnType<typeof openNetworkEgress>>,
  url = "http://example.com/test",
  auth = true,
) {
  const endpoint = new URL(proxy.parentProxy.http);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: endpoint.hostname,
        port: endpoint.port,
        path: url,
        headers: auth
          ? {
              "Proxy-Authorization": `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`,
            }
          : {},
      },
      (res) => {
        let body = "";
        res.on("data", (data) => {
          body += data;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("per-job public network egress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.31.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "fe80::1",
    "fc00::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "3fff::1",
    "invalid",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicEgressAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts public unicast %s",
    (address) => {
      expect(isPublicEgressAddress(address)).toBe(true);
    },
  );
  it("rejects wrong credentials and unapproved ports without DNS", async () => {
    const proxy = await openNetworkEgress(["example.com:80"]);
    try {
      expect((await get(proxy, undefined, false)).status).toBe(407);
      expect((await get(proxy, "http://example.com:81/")).status).toBe(403);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });
  it("rejects mixed public/private answers before connecting", async () => {
    lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const proxy = await openNetworkEgress(["example.com:80"]);
    try {
      expect((await get(proxy)).status).toBe(403);
      expect(dial).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });
  it("does not dial when a pending resolver completes after revocation", async () => {
    let resolved!: (value: unknown) => void;
    lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolved = resolve;
        }),
    );
    const proxy = await openNetworkEgress(["example.com:80"]);
    const result = get(proxy).catch(() => null);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    await proxy.close();
    resolved([{ address: "8.8.8.8", family: 4 }]);
    await result;
    expect(dial).not.toHaveBeenCalled();
    await proxy.close();
  });
  it("pins a CONNECT dial to the checked address and closes established tunnels", async () => {
    // Controlled transport: intercept only the numeric public dial and route it
    // to our fake server. This verifies routing/lifecycle, not host isolation.
    const real = await vi.importActual<typeof import("node:net")>("node:net");
    const server = createServer((_req, res) => res.end("synthetic"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    dial.mockImplementation((options) => real.connect({ ...options, host: "127.0.0.1", port }));
    lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const proxy = await openNetworkEgress(["example.com:443"]);
    try {
      const endpoint = new URL(proxy.parentProxy.http);
      const client = real.connect(Number(endpoint.port), endpoint.hostname);
      client.on("error", () => {});
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      const data = new Promise<string>((resolve) =>
        client.once("data", (chunk) => resolve(chunk.toString())),
      );
      client.write(
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}\r\n\r\n`,
      );
      expect(await data).toContain("200 Connection Established");
      expect(dial).toHaveBeenCalledWith({
        host: "8.8.8.8",
        family: 4,
        port: 443,
        allowHalfOpen: true,
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      await proxy.close();
      await closed;
    } finally {
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
