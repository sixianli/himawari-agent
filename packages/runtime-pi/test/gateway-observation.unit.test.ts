import { expect, it } from "vitest";
import { observeGatewayFetch } from "../src/gateway-observation.js";

const stream = (): Response =>
  new Response(
    `data: ${JSON.stringify({ id: "gen-1", model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

it("allows the request to be resent after the gateway rejected it with a non-success status", async () => {
  const replies = [new Response("{}", { status: 429 }), stream()];
  let calls = 0;
  const { fetch } = observeGatewayFetch(async () => {
    calls += 1;
    return replies.shift() ?? stream();
  }, "m");
  expect((await fetch("https://gateway.test/v1/chat/completions", { method: "POST" })).status).toBe(
    429,
  );
  expect((await fetch("https://gateway.test/v1/chat/completions", { method: "POST" })).status).toBe(
    200,
  );
  expect(calls).toBe(2);
});

it("REVERSE: a second request after a successful one is still forbidden and invalidates the observation", async () => {
  const observed = observeGatewayFetch(async () => stream(), "m");
  await observed.fetch("https://gateway.test/v1/chat/completions", { method: "POST" });
  await expect(
    observed.fetch("https://gateway.test/v1/chat/completions", { method: "POST" }),
  ).rejects.toThrow("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");
  expect(await observed.result()).toEqual({ status: "invalid" });
});

it("REVERSE: after a transport error a resend surfaces the original error, not a second request", async () => {
  let calls = 0;
  const original = new TypeError("fetch failed");
  const { fetch } = observeGatewayFetch(async () => {
    calls += 1;
    throw original;
  }, "m");
  await expect(fetch("https://gateway.test/x", { method: "POST" })).rejects.toBe(original);
  await expect(fetch("https://gateway.test/x", { method: "POST" })).rejects.toBe(original);
  expect(calls).toBe(1);
});

it("REVERSE: a status the provider will not retry keeps the gateway closed to a resend", async () => {
  let calls = 0;
  const { fetch } = observeGatewayFetch(async () => {
    calls += 1;
    return new Response("{}", { status: 400 });
  }, "m");
  expect((await fetch("https://gateway.test/x", { method: "POST" })).status).toBe(400);
  await expect(fetch("https://gateway.test/x", { method: "POST" })).rejects.toThrow(
    "AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN",
  );
  expect(calls).toBe(1);
});

it("REVERSE: resends stop after the configured number of rejected attempts", async () => {
  let calls = 0;
  const { fetch } = observeGatewayFetch(async () => {
    calls += 1;
    return new Response("{}", { status: 503 });
  }, "m");
  for (let attempt = 0; attempt < 3; attempt += 1)
    expect((await fetch("https://gateway.test/x", { method: "POST" })).status).toBe(503);
  await expect(fetch("https://gateway.test/x", { method: "POST" })).rejects.toThrow(
    "AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN",
  );
  expect(calls).toBe(3);
});
