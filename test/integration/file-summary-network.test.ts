import { readFile } from "node:fs/promises";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { expect, it, vi } from "vitest";
import { boundedOpenRouterFetch } from "./fixtures/file-summary-network.js";

const configuration = parseProductConfiguration(
  JSON.parse(
    await readFile(new URL("./fixtures/file-summary/configuration.json", import.meta.url), "utf8"),
  ),
  "2026-09-07T00:00:00.000Z",
);
const descriptor = configuration.modelDescriptors.find((item) => item.role === "primary");
if (!descriptor || descriptor.role === "embedding") throw new Error("PRIMARY_MISSING");
const body = {
  model: descriptor.model,
  provider: descriptor.providerRouting,
  max_tokens: 2048,
  stream: true,
  messages: [{ role: "user", content: "public fixture" }],
};
const request = (value = body) => ({ method: "POST", body: JSON.stringify(value) });
const endpoint = "https://openrouter.ai/api/v1/chat/completions";

it("blocks changed routes, output limits and unapproved endpoints before sending", async () => {
  const send = vi.fn<typeof globalThis.fetch>(async () => new Response());
  const guard = boundedOpenRouterFetch(configuration, send, new AbortController().signal);
  await expect(guard.fetch(endpoint, request({ ...body, max_tokens: 4096 }))).rejects.toThrow(
    "PROBE_OUTPUT_LIMIT",
  );
  await expect(guard.fetch(endpoint, request({ ...body, provider: undefined }))).rejects.toThrow(
    "PROBE_ROUTING_MISMATCH",
  );
  await expect(guard.fetch("https://example.com", request())).rejects.toThrow(
    "PROBE_ENDPOINT_DENIED",
  );
  expect(send).not.toHaveBeenCalled();
});

it("retains failed request reservations and refuses a fourth generation call", async () => {
  const send = vi.fn(async () => {
    throw new Error("offline transport failure");
  });
  const guard = boundedOpenRouterFetch(configuration, send, new AbortController().signal);
  for (let count = 0; count < 3; count++) {
    await expect(guard.fetch(endpoint, request())).rejects.toThrow("offline transport failure");
  }
  await expect(guard.fetch(endpoint, request())).rejects.toThrow("PROBE_CALL_LIMIT");
  expect(send).toHaveBeenCalledTimes(3);
  expect(guard.reservedCostMicros()).toBe(3 * 63284);
  expect(guard.requests.every((item) => item.status === null)).toBe(true);
});

it("enforces the configured budget before sending and refuses redirects", async () => {
  const send = vi.fn<typeof globalThis.fetch>(async () => new Response());
  const controller = new AbortController();
  const guard = boundedOpenRouterFetch(
    { ...configuration, budgets: { ...configuration.budgets, globalCostMicros: 63284 } },
    send,
    controller.signal,
  );
  await guard.fetch(endpoint, request());
  expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  await expect(guard.fetch(endpoint, request())).rejects.toThrow("PROBE_BUDGET_LIMIT");
  controller.abort();
  await expect(guard.fetch(endpoint, request())).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

it("carries prior attempts into the shared budget and rejects invalid carry-over", async () => {
  const send = vi.fn<typeof globalThis.fetch>(async () => new Response());
  const signal = new AbortController().signal;
  const guard = boundedOpenRouterFetch(configuration, send, signal, 1_000_000 - 63283);
  await expect(guard.fetch(endpoint, request())).rejects.toThrow("PROBE_BUDGET_LIMIT");
  expect(send).not.toHaveBeenCalled();
  expect(() => boundedOpenRouterFetch(configuration, send, signal, -1)).toThrow(
    "PROBE_INVALID_PRIOR_RESERVATION",
  );
});
