import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ThinkWorthDecisionFailure } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkWorthDecision, thinkWorthRequestBody } from "../src/think-worth-decision.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function stub(handler: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const seen: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push({ headers: request.headers, body });
      const result = handler(body);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { seen, baseUrl: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1` };
}

const request = {
  sourceKind: "email",
  sourceDescription: "新邮件",
  summary: "房东来信，请在 11 月 20 日前回复是否续租",
  externalContent: true,
};

const answer = (worth: number) => ({
  model: "typesafe-ai/jev",
  answers: [
    {
      type: "choice",
      name: "think_worth",
      choice: worth >= 0.5 ? "worth" : "not_worth",
      confidence: Math.max(worth, 1 - worth),
      probabilities: [
        { value: "worth", probability: worth },
        { value: "not_worth", probability: 1 - worth },
      ],
    },
  ],
});

describe("think worth decision", () => {
  it("asks one yes or no question with zero data retention and no raw secrets", () => {
    const body = JSON.parse(
      thinkWorthRequestBody("typesafe-ai/jev", {
        ...request,
        summary: "我的银行卡是 4111 1111 1111 1111，请尽快回复",
      }),
    ) as {
      questions: { name: string; choices: { value: string }[] }[];
      providerOptions: { gateway: { zeroDataRetention: boolean } };
    };
    expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]?.choices.map(({ value }) => value)).toEqual(["worth", "not_worth"]);
    expect(JSON.stringify(body)).not.toContain("4111 1111 1111 1111");
  });

  it("posts to /decisions with the key and returns the permille", async () => {
    const { seen, baseUrl } = await stub(() => ({ status: 200, body: answer(0.91) }));
    const decision = new ThinkWorthDecision({
      model: "typesafe-ai/jev",
      apiKey: async () => "key-1",
      baseUrl,
    });
    expect(await decision.decide(request, AbortSignal.timeout(5000))).toEqual({
      worthPermille: 910,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["authorization"]).toBe("Bearer key-1");
  });

  it("fails closed on an HTTP error, a malformed body and an oversized request", async () => {
    const failing = await stub(() => ({ status: 503, body: {} }));
    await expect(
      new ThinkWorthDecision({
        model: "typesafe-ai/jev",
        apiKey: async () => "k",
        baseUrl: failing.baseUrl,
      }).decide(request, AbortSignal.timeout(5000)),
    ).rejects.toThrow("THINK_WORTH_HTTP_503");
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const wrong = await stub(() => ({ status: 200, body: { model: "x", answers: [] } }));
    await expect(
      new ThinkWorthDecision({
        model: "typesafe-ai/jev",
        apiKey: async () => "k",
        baseUrl: wrong.baseUrl,
      }).decide(request, AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(ThinkWorthDecisionFailure);
    expect(() =>
      thinkWorthRequestBody("typesafe-ai/jev", { ...request, summary: "字".repeat(40_000) }),
    ).toThrow("THINK_WORTH_INPUT_TOO_LARGE");
  });
});
