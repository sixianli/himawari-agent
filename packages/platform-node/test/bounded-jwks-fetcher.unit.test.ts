import { describe, expect, it } from "vitest";
import { BOUNDED_JWKS_ERROR_CODES, BoundedJwksFetcher } from "../src/bounded-jwks-fetcher.js";

const JWKS_URL = "https://team.cloudflareaccess.com/cdn-cgi/access/certs";

function fetchResponse(
  response: Response,
  observed?: (input: { readonly url: string; readonly init: RequestInit }) => void,
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    observed?.({ url: String(input), init });
    return response;
  };
}

describe("BoundedJwksFetcher", () => {
  it("requests only the configured endpoint with a bounded JSON request", async () => {
    let request: { readonly url: string; readonly init: RequestInit } | undefined;
    const fetcher = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 100,
      maximumBodyBytes: 1024,
      fetchImplementation: fetchResponse(
        new Response(JSON.stringify({ keys: [{ kty: "RSA", kid: "key-01" }] }), {
          headers: { "content-type": "application/json" },
        }),
        (value) => {
          request = value;
        },
      ),
    });

    await expect(fetcher.fetch(new URL(JWKS_URL))).resolves.toEqual({
      keys: [{ kty: "RSA", kid: "key-01" }],
    });
    expect(request?.url).toBe(JWKS_URL);
    expect(request?.init).toMatchObject({
      method: "GET",
      redirect: "error",
    });
    expect(new Headers(request?.init.headers).get("accept")).toBe("application/json");
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a URL outside the fixed issuer endpoint before fetching", async () => {
    let calls = 0;
    const fetcher = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 100,
      maximumBodyBytes: 1024,
      fetchImplementation: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(fetcher.fetch(new URL("https://other.example/certs"))).rejects.toMatchObject({
      code: BOUNDED_JWKS_ERROR_CODES.URL_REJECTED,
    });
    expect(calls).toBe(0);
  });

  it("cancels an oversized content-length response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 100,
      maximumBodyBytes: 8,
      fetchImplementation: fetchResponse(
        new Response(body, { status: 200, headers: { "content-length": "9" } }),
      ),
    });

    await expect(fetcher.fetch(new URL(JWKS_URL))).rejects.toMatchObject({
      code: BOUNDED_JWKS_ERROR_CODES.BODY_TOO_LARGE,
    });
    expect(cancelled).toBe(true);
  });

  it("cancels a streaming body after it crosses the byte limit", async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(
          reads === 1 ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6, 7, 8, 9]),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 100,
      maximumBodyBytes: 8,
      fetchImplementation: fetchResponse(new Response(body, { status: 200 })),
    });

    await expect(fetcher.fetch(new URL(JWKS_URL))).rejects.toMatchObject({
      code: BOUNDED_JWKS_ERROR_CODES.BODY_TOO_LARGE,
    });
    expect(cancelled).toBe(true);
  });

  it("aborts and cancels a body that stalls while being read", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 20,
      maximumBodyBytes: 1024,
      fetchImplementation: fetchResponse(new Response(body, { status: 200 })),
    });

    await expect(fetcher.fetch(new URL(JWKS_URL))).rejects.toMatchObject({
      code: BOUNDED_JWKS_ERROR_CODES.TIMEOUT,
    });
    expect(cancelled).toBe(true);
  });

  it("cancels rejected HTTP responses and invalid JSON", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-json"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 100,
      maximumBodyBytes: 1024,
      fetchImplementation: fetchResponse(new Response(body, { status: 503 })),
    });

    await expect(fetcher.fetch(new URL(JWKS_URL))).rejects.toMatchObject({
      code: BOUNDED_JWKS_ERROR_CODES.RESPONSE_INVALID,
    });
    expect(cancelled).toBe(true);

    const invalidJson = new BoundedJwksFetcher({
      allowedUrl: JWKS_URL,
      timeoutMilliseconds: 100,
      maximumBodyBytes: 1024,
      fetchImplementation: fetchResponse(new Response("not-json", { status: 200 })),
    });
    await expect(invalidJson.fetch(new URL(JWKS_URL))).rejects.toMatchObject({
      code: BOUNDED_JWKS_ERROR_CODES.RESPONSE_INVALID,
    });
  });
});
