import { expect, it } from "vitest";
import {
  observeProviderRejections,
  type ProviderRejection,
} from "../src/provider-rejection-observation.js";

const run = async (response: Response, input: unknown = "https://provider.test:8443/v1/chat") => {
  const seen: ProviderRejection[] = [];
  const fetch = observeProviderRejections(
    (async () => response) as unknown as typeof globalThis.fetch,
    (rejection) => seen.push(rejection),
  );
  const result = await fetch(input as string, { method: "POST" });
  return { seen, result };
};

it("records status, retry hints and only the host of a rejected response", async () => {
  const { seen, result } = await run(
    new Response("{}", {
      status: 429,
      headers: { "retry-after": "7", "x-should-retry": "true" },
    }),
  );
  expect(result.status).toBe(429);
  expect(seen).toEqual([
    { status: 429, retryAfter: "7", shouldRetry: "true", host: "provider.test:8443" },
  ]);
});

it("prefers retry-after-ms and cuts provider-controlled header text", async () => {
  const { seen } = await run(
    new Response("{}", {
      status: 503,
      headers: { "retry-after-ms": "1500", "x-should-retry": "x".repeat(400) },
    }),
  );
  expect(seen[0]?.retryAfter).toBe("1500ms");
  expect(seen[0]?.shouldRetry).toHaveLength(128);
});

it("reads the host from a request-like object", async () => {
  const { seen } = await run(new Response("{}", { status: 500 }), {
    url: "https://other.test/v1",
  });
  expect(seen[0]?.host).toBe("other.test");
});

it("REVERSE: a successful response is not reported and never carries a path or body", async () => {
  const { seen } = await run(new Response("{}", { status: 200 }));
  expect(seen).toEqual([]);
  const { seen: rejected } = await run(new Response("{}", { status: 429 }));
  expect(JSON.stringify(rejected)).not.toContain("/v1/chat");
});
