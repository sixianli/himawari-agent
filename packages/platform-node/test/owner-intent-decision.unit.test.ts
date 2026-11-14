import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseOwnerIntentDecision } from "@himawari-agent/application";
import { OwnerIntentDecision, ownerIntentRequestBody } from "../src/owner-intent-decision.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function stub(handler: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const seen: {
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }[] = [];
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
  return {
    seen,
    baseUrl: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1`,
  };
}

const request = {
  ownerWords: ["明天九点提醒我给房东回电话"],
  action: {
    tool: "reminder_set",
    capabilityRef: "reminder.set",
    operation: "set",
    parameters: { text: "给房东回电话", due: "2026-11-15T09:00" },
  },
};

const answer = (explicit: number) => ({
  model: "typesafe-ai/jev",
  answers: [
    {
      type: "choice",
      name: "owner_intent",
      choice: explicit >= 0.5 ? "explicit" : "not_explicit",
      confidence: Math.max(explicit, 1 - explicit),
      probabilities: [
        { value: "explicit", probability: explicit },
        { value: "not_explicit", probability: 1 - explicit },
      ],
    },
  ],
});

describe("[ADR-0257] owner intent decision", () => {
  it("asks one choice question with zero data retention, only the owner's words and the action, and no raw secrets", () => {
    const body = JSON.parse(
      ownerIntentRequestBody("typesafe-ai/jev", {
        ...request,
        ownerWords: ["我的银行卡是 4111 1111 1111 1111，明天提醒我还款"],
      }),
    ) as {
      model: string;
      questions: { name: string; type: string; choices: { value: string }[] }[];
      providerOptions: { gateway: { zeroDataRetention: boolean } };
      input: unknown;
    };
    expect(body.model).toBe("typesafe-ai/jev");
    expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]?.choices.map(({ value }) => value)).toEqual([
      "explicit",
      "not_explicit",
    ]);
    expect(JSON.stringify(body.input)).not.toContain("4111 1111 1111 1111");
    expect(JSON.stringify(body.input)).not.toContain("capabilityRef");
  });

  it("refuses an oversized request before sending it", () => {
    expect(() =>
      ownerIntentRequestBody("typesafe-ai/jev", {
        ...request,
        action: {
          ...request.action,
          parameters: { text: "字".repeat(40_000) },
        },
      }),
    ).toThrow("OWNER_INTENT_INPUT_TOO_LARGE");
  });

  it("sends the key as a bearer token and returns the answer as verdict and confidence", async () => {
    const { seen, baseUrl } = await stub(() => ({
      status: 200,
      body: answer(0.97),
    }));
    const decision = new OwnerIntentDecision({
      model: "typesafe-ai/jev",
      apiKey: async () => "secret-key",
      baseUrl,
    });
    expect(await decision.check(request, new AbortController().signal)).toEqual({
      verdict: "explicit",
      confidence: 970,
      quote: null,
    });
    expect(seen[0]?.headers["authorization"]).toBe("Bearer secret-key");
    const low = await stub(() => ({ status: 200, body: answer(0.1) }));
    expect(
      await new OwnerIntentDecision({
        model: "typesafe-ai/jev",
        apiKey: async () => "k",
        baseUrl: low.baseUrl,
      }).check(request, new AbortController().signal),
    ).toEqual({ verdict: "not_explicit", confidence: 900, quote: null });
  });

  it("fails closed on an HTTP error, a different model, a refusal, or an unknown choice", async () => {
    const cases: readonly [string, { status: number; body: unknown }][] = [
      ["OWNER_INTENT_HTTP_429", { status: 429, body: {} }],
      ["OWNER_INTENT_MODEL_MISMATCH", { status: 200, body: { ...answer(0.9), model: "other" } }],
      [
        "OWNER_INTENT_ANSWER_INVALID",
        {
          status: 200,
          body: { model: "typesafe-ai/jev", answers: [{ type: "refusal" }] },
        },
      ],
      [
        "OWNER_INTENT_ANSWER_INVALID",
        {
          status: 200,
          body: {
            model: "typesafe-ai/jev",
            answers: [
              {
                type: "choice",
                name: "owner_intent",
                choice: "maybe",
                confidence: 0.9,
              },
            ],
          },
        },
      ],
      [
        "OWNER_INTENT_ANSWER_COUNT",
        { status: 200, body: { model: "typesafe-ai/jev", answers: [] } },
      ],
    ];
    for (const [code, response] of cases) {
      const { baseUrl } = await stub(() => response);
      await expect(
        new OwnerIntentDecision({
          model: "typesafe-ai/jev",
          apiKey: async () => "k",
          baseUrl,
        }).check(request, new AbortController().signal),
        code,
      ).rejects.toThrow(code);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe("[ADR-0257] owner intent answer parsing fails closed", () => {
  const MODEL = "typesafe-ai/jev";
  const reply = (answer: Record<string, unknown>) => ({
    model: MODEL,
    answers: [{ type: "choice", name: "owner_intent", ...answer }],
  });
  const pair = (yes: number, no: number) => [
    { value: "explicit", probability: yes },
    { value: "not_explicit", probability: no },
  ];

  it.each([
    ["probabilities missing", { choice: "explicit", confidence: 0.99 }],
    [
      "object probabilities contradict the choice",
      {
        choice: "explicit",
        confidence: 0.99,
        probabilities: { explicit: 0.1, not_explicit: 0.9 },
      },
    ],
    [
      "only one option",
      {
        choice: "explicit",
        confidence: 0.99,
        probabilities: [{ value: "explicit", probability: 0.99 }],
      },
    ],
    ["sum above one", { choice: "explicit", confidence: 0.9, probabilities: pair(0.9, 0.9) }],
    ["sum below one", { choice: "explicit", confidence: 0.5, probabilities: pair(0.5, 0.1) }],
    [
      "duplicate option",
      {
        choice: "explicit",
        confidence: 0.5,
        probabilities: [...pair(0.5, 0.5), { value: "explicit", probability: 0.5 }],
      },
    ],
    [
      "choice is not the most likely",
      { choice: "explicit", confidence: 0.1, probabilities: pair(0.1, 0.9) },
    ],
    [
      "confidence out of range",
      { choice: "explicit", confidence: 1.5, probabilities: pair(0.9, 0.1) },
    ],
  ])("rejects %s", (_name, answer) => {
    expect(() => parseOwnerIntentDecision(reply(answer), MODEL)).toThrow(
      "OWNER_INTENT_ANSWER_INVALID",
    );
  });

  it("accepts the object form of probabilities when consistent", () => {
    expect(
      parseOwnerIntentDecision(
        reply({
          choice: "explicit",
          confidence: 0.9,
          probabilities: { explicit: 0.9, not_explicit: 0.1 },
        }),
        MODEL,
      ),
    ).toEqual({ verdict: "explicit", confidence: 900, quote: null });
  });

  it("judges by the probabilities when the confidence field differs from the top probability", () => {
    expect(
      parseOwnerIntentDecision(
        reply({
          choice: "explicit",
          confidence: 0.95,
          probabilities: { explicit: 1, not_explicit: 0 },
        }),
        MODEL,
      ),
    ).toEqual({ verdict: "explicit", confidence: 1000, quote: null });
  });

  it("does not round a probability just under one half up to explicit", () => {
    expect(
      parseOwnerIntentDecision(
        reply({
          choice: "not_explicit",
          confidence: 0.5001,
          probabilities: pair(0.4999, 0.5001),
        }),
        MODEL,
      ),
    ).toEqual({ verdict: "not_explicit", confidence: 500, quote: null });
  });

  it("redacts sensitive text in parameter keys", () => {
    const body = ownerIntentRequestBody(MODEL, {
      ...request,
      action: { ...request.action, parameters: { "4111 1111 1111 1111": "x" } },
    });
    expect(body).not.toContain("4111 1111 1111 1111");
  });
});
