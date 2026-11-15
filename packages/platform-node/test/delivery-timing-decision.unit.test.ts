import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeliveryTimingDecision,
  deliveryTimingRequestBody,
} from "../src/delivery-timing-decision.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function stub(status: number, body: unknown) {
  const seen: Record<string, unknown>[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { seen, baseUrl: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1` };
}

const question = {
  pushClass: "run_result" as const,
  facts: [{ signal: "motion" as const, value: "driving", secondsAgo: 12 }],
};

function decision(baseUrl: string) {
  return new DeliveryTimingDecision({
    model: "typesafe-ai/jev",
    inputMicrosPerMillionTokens: 100_000,
    apiKey: async () => "key",
    baseUrl,
  });
}

describe("[IOS-4] delivery timing decision", () => {
  it("asks one yes/no question with zero data retention and sends only the kind and the structured reports", () => {
    const body = JSON.parse(deliveryTimingRequestBody("typesafe-ai/jev", question)) as {
      questions: { name: string; type: string }[];
      providerOptions: { gateway: { zeroDataRetention: boolean } };
      input: { content: { data: unknown }[] }[];
    };
    expect(body.questions).toMatchObject([{ type: "predicate", name: "unwelcome" }]);
    expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(body.input[0]?.content[0]?.data).toEqual({
      notificationKind: "run_result",
      ownerReports: [{ signal: "motion", value: "driving", secondsAgo: 12 }],
    });
  });

  it("returns the probability the service answers", async () => {
    const jev = await stub(200, {
      model: "typesafe-ai/jev",
      answers: [{ type: "predicate", name: "unwelcome", probability: 0.77 }],
    });
    expect(
      await decision(jev.baseUrl).probability({ ...question, signal: AbortSignal.timeout(2000) }),
    ).toBe(0.77);
    expect(jev.seen).toHaveLength(1);
  });

  it("REVERSE: rejects an HTTP error, a malformed answer and an answer for another model", async () => {
    for (const [status, body] of [
      [500, {}],
      [200, { model: "typesafe-ai/jev", answers: [] }],
      [
        200,
        { model: "other", answers: [{ type: "predicate", name: "unwelcome", probability: 1 }] },
      ],
    ] as const) {
      const jev = await stub(status, body);
      await expect(
        decision(jev.baseUrl).probability({ ...question, signal: AbortSignal.timeout(2000) }),
      ).rejects.toThrow();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("estimates the cost from the request size", () => {
    expect(decision("http://127.0.0.1:1/v1").estimateMicros(question)).toBeGreaterThan(0);
  });
});
