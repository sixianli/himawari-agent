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
  const write = vi.fn(
    async (_input: { contentType: string; plaintext: Uint8Array }) => "payload:fixture",
  );
  const resolve = vi.fn(async () => options.addresses ?? ["93.184.216.34"]);
  const request = vi.fn(
    async () => new Response("hello", { headers: { "content-type": "text/plain" } }),
  );
  const search = vi.fn(async () => []);
  const adapter = new BoundedPublicWebAdapter({
    transport: options.transport ?? { request },
    resolver: { resolve },
    timeoutMs: options.timeoutMs ?? 1000,
    search: { search },
    payloads: { write },
    digest: { digest: () => "digest:fixture" },
  });
  return { adapter, write, resolve, request, search };
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

describe("bounded response validation and cleanup", () => {
  it("delegates only the supplied search query and limit", async () => {
    const f = fixture();
    const query = { query: "public documentation", limit: 3 };
    expect(await f.adapter.search(query)).toEqual([]);
    expect(f.search).toHaveBeenCalledExactlyOnceWith(query);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([0, -1, 60001, 1.5, Number.NaN])("rejects timeout %s before requesting", (timeoutMs) => {
    expect(() => fixture({ timeoutMs })).toThrow("Invalid web timeout");
  });
  it.each([0, -1, 16 * 1024 * 1024 + 1, 0.5])(
    "rejects response bound %s before resolving",
    async (maximumBytes) => {
      const f = fixture();
      await expect(f.adapter.open({ ...input, maximumBytes })).rejects.toThrow(
        "Invalid web response size limit",
      );
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
  it.each(["file:///private/file", "https://user@public.example/", "ftp://public.example/"])(
    "rejects unsafe URL %s",
    async (requestedUrl) => {
      const f = fixture();
      await expect(f.adapter.open({ ...input, requestedUrl })).rejects.toThrow("WEB_URL_UNSAFE");
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ "content-type": "application/zip" }, "WEB_CONTENT_TYPE_UNSUPPORTED"],
    [
      { "content-type": "text/plain", "content-encoding": "gzip" },
      "WEB_CONTENT_ENCODING_UNSUPPORTED",
    ],
    [{ "content-type": "text/plain", "content-length": "-1" }, "WEB_RESOURCE_TOO_LARGE"],
    [{ "content-type": "text/plain", "content-length": "2048" }, "WEB_RESOURCE_TOO_LARGE"],
    [{ "content-type": "text/plain", "content-length": "NaN" }, "WEB_RESOURCE_TOO_LARGE"],
  ] as const)("rejects headers %j without persisting a body", async (headers, reason) => {
    const cancel = vi.fn(async () => {
      throw new Error("body cleanup failed");
    });
    const f = fixture({
      transport: { request: async () => new Response(new ReadableStream({ cancel }), { headers }) },
    });
    await expect(f.adapter.open(input)).rejects.toThrow(reason);
    await Promise.resolve();
    expect(f.write).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("enforces redirect count and cancels every response", async () => {
    const cancel = vi.fn();
    const request = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: "/again" },
        }),
    );
    const f = fixture({ transport: { request } });
    await expect(f.adapter.open(input)).rejects.toThrow("WEB_REDIRECT_LIMIT");
    expect(request).toHaveBeenCalledTimes(6);
    expect(cancel).toHaveBeenCalledTimes(6);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects a redirect without a destination", async () => {
    const f = fixture({ transport: { request: async () => new Response(null, { status: 301 }) } });
    await expect(f.adapter.open(input)).rejects.toThrow("WEB_REDIRECT_LIMIT");
  });
  it("accepts a bodyless response and preserves its actual status", async () => {
    const f = fixture({
      transport: {
        request: async () =>
          new Response(null, { status: 204, headers: { "content-type": "text/plain" } }),
      },
    });
    expect(await f.adapter.open(input)).toMatchObject({
      statusCode: 204,
      title: "public.example",
      selectedFragmentRefs: ["fragment:0:0"],
    });
    expect(f.write.mock.calls[0]?.[0].plaintext).toEqual(new Uint8Array());
  });
  it("preserves a read failure even when cancellation also rejects", async () => {
    const f = fixture({
      transport: {
        request: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("fixture stream failure"));
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
      },
    });
    await expect(f.adapter.open(input)).rejects.toThrow("fixture stream failure");
    await Promise.resolve();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("uses the final URL for title fallback after a relative redirect", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/final" } }))
      .mockResolvedValueOnce(
        new Response("<p>source</p>", { headers: { "content-type": "text/html" } }),
      );
    const f = fixture({ transport: { request } });
    expect(await f.adapter.open(input)).toMatchObject({
      canonicalUrl: "https://public.example/final",
      redirectChain: ["https://public.example/final"],
      title: "public.example",
    });
  });
});
