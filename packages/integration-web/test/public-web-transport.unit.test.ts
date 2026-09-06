import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  BoundedPublicWebAdapter,
  NodePublicWebTransport,
  type PublicWebTransport,
} from "../src/index.js";
import { isPublicWebAddress } from "../src/public-ip-address.js";

function fixture(
  options: {
    transport?: PublicWebTransport;
    addresses?: readonly string[];
    timeoutMs?: number;
  } = {},
) {
  const write = vi.fn(async () => "payload:fixture");
  const resolve = vi.fn(async () => options.addresses ?? ["93.184.216.34"]);
  const request = vi.fn(
    async () => new Response("hello", { headers: { "content-type": "text/plain" } }),
  );
  const adapter = new BoundedPublicWebAdapter({
    transport: options.transport ?? { request },
    resolver: { resolve },
    timeoutMs: options.timeoutMs ?? 1000,
    search: { search: async () => [] },
    payloads: { write },
    digest: { digest: () => "digest:fixture" },
  });
  return { adapter, write, resolve, request };
}
const input = { requestedUrl: "https://public.example/source", maximumBytes: 1024 };

describe("public web transport boundaries", () => {
  it.each([
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "100.64.0.1",
    "::",
    "fe90::1",
    "fc00::1",
    "ff02::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "127.1",
    "garbage",
    "192.168.1.1",
    "224.0.0.1",
  ])("blocks %s before transport", async (address) => {
    const { adapter, request } = fixture({ addresses: [address] });
    await expect(adapter.open(input)).rejects.toThrow("WEB_SSRF_TARGET_BLOCKED");
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts globally routable IPv4 and IPv6", () => {
    expect(isPublicWebAddress("93.184.216.34")).toBe(true);
    expect(isPublicWebAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("passes only the checked address and original URL to transport", async () => {
    const { adapter, resolve, request } = fixture();
    await adapter.open(input);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url: input.requestedUrl, address: "93.184.216.34" }),
    );
  });

  it("cancels redirect bodies and rejects a new private target", async () => {
    const cancel = vi.fn();
    const request = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: "http://internal.example/secret" },
        }),
    );
    const { adapter, resolve, write } = fixture({ transport: { request } });
    resolve.mockResolvedValueOnce(["93.184.216.34"]).mockResolvedValueOnce(["127.0.0.1"]);
    await expect(adapter.open(input)).rejects.toThrow("WEB_SSRF_TARGET_BLOCKED");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("stops an oversized chunked response before consuming all chunks", async () => {
    let pulled = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(600));
        if (pulled === 100) controller.close();
      },
      cancel,
    });
    const { adapter, write } = fixture({
      transport: {
        request: async () => new Response(body, { headers: { "content-type": "text/plain" } }),
      },
    });
    await expect(adapter.open(input)).rejects.toThrow("WEB_RESOURCE_TOO_LARGE");
    expect(pulled).toBeLessThan(100);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("times out a stalled body and cancels the transport signal", async () => {
    const cancel = vi.fn();
    let signal: AbortSignal | undefined;
    const { adapter } = fixture({
      timeoutMs: 20,
      transport: {
        request: async (request) => {
          signal = request.signal;
          return new Response(new ReadableStream({ cancel }), {
            headers: { "content-type": "text/plain" },
          });
        },
      },
    });
    await expect(adapter.open(input)).rejects.toThrow("WEB_REQUEST_TIMEOUT");
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("times out DNS resolution without opening a connection", async () => {
    const { adapter, resolve, request } = fixture({ timeoutMs: 20 });
    resolve.mockImplementation(() => new Promise(() => {}));
    await expect(adapter.open(input)).rejects.toThrow("WEB_REQUEST_TIMEOUT");
    expect(request).not.toHaveBeenCalled();
  });

  it("connects to the selected IP while retaining the original Host", async () => {
    let host: string | undefined;
    const server = createServer((request, response) => {
      host = request.headers.host;
      response.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await new NodePublicWebTransport().request({
        url: `http://unresolvable.invalid:${port}/`,
        address: "127.0.0.1",
        signal: AbortSignal.timeout(1000),
      });
      expect(await result.text()).toBe("pinned");
      expect(host).toBe(`unresolvable.invalid:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
