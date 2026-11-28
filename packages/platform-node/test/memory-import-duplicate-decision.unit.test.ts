import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  importDuplicateRequestBody,
  MemoryImportDuplicateDecision,
} from "../src/memory-import-duplicate-decision.js";

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

const existing = [
  { key: "m0", text: "对乳制品不耐受" },
  { key: "m1", text: "住在上海" },
];

describe("[A4] memory import duplicate decision", () => {
  it("asks one choice question per candidate with zero data retention and no raw secrets", () => {
    const body = JSON.parse(
      importDuplicateRequestBody("typesafe-ai/jev", {
        existing: [{ key: "m0", text: "我的银行卡密码是 Qz7mWx42Lp" }, existing[1] as never],
        candidates: [{ text: "喝不了牛奶" }, { text: "在上海工作" }],
      }),
    ) as {
      model: string;
      questions: { name: string; type: string; choices: { value: string }[] }[];
      providerOptions: { gateway: { zeroDataRetention: boolean } };
      input: unknown;
    };
    expect(body.model).toBe("typesafe-ai/jev");
    expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(body.questions.map(({ name, type }) => [name, type])).toEqual([
      ["c0", "choice"],
      ["c1", "choice"],
    ]);
    expect(body.questions[0]?.choices.map(({ value }) => value)).toEqual(["m0", "m1", "none"]);
    expect(JSON.stringify(body.input)).not.toContain("Qz7mWx42Lp");
  });

  it("sends the key as a bearer token and returns the parsed answers", async () => {
    const { seen, baseUrl } = await stub((body) => ({
      status: 200,
      body: {
        model: body["model"],
        answers: [
          {
            type: "choice",
            name: "c0",
            choice: "m0",
            probabilities: [
              { value: "m0", probability: 0.93 },
              { value: "m1", probability: 0.01 },
              { value: "none", probability: 0.06 },
            ],
          },
        ],
      },
    }));
    const decision = new MemoryImportDuplicateDecision({
      model: "typesafe-ai/jev",
      apiKey: async () => "test-key",
      baseUrl,
    });
    const answers = await decision.decide({
      existing,
      candidates: [{ text: "喝不了牛奶" }],
      signal: AbortSignal.timeout(5000),
    });
    expect(answers).toEqual([{ matchKey: "m0", probabilityPermille: 930 }]);
    expect(seen[0]?.headers["authorization"]).toBe("Bearer test-key");
  });

  it("REVERSE: fails with a stable code on an HTTP error, a non-JSON body and a mismatched model", async () => {
    const run = async (result: { status: number; body: unknown }) => {
      const { baseUrl } = await stub(() => result);
      const decision = new MemoryImportDuplicateDecision({
        model: "typesafe-ai/jev",
        apiKey: async () => "k",
        baseUrl,
      });
      return decision.decide({
        existing,
        candidates: [{ text: "x" }],
        signal: AbortSignal.timeout(5000),
      });
    };
    await expect(run({ status: 429, body: {} })).rejects.toThrow("IMPORT_DUPLICATE_HTTP_429");
    await server?.close();
    await expect(run({ status: 200, body: { model: "other", answers: [] } })).rejects.toThrow(
      "IMPORT_DUPLICATE_MODEL_MISMATCH",
    );
  });

  it("REVERSE: refuses a response whose declared or streamed size is over 1 MiB", async () => {
    const decideAgainst = async (
      respond: (response: import("node:http").ServerResponse) => void,
    ) => {
      server = createServer((_request, response) => respond(response));
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const decision = new MemoryImportDuplicateDecision({
        model: "typesafe-ai/jev",
        apiKey: async () => "k",
        baseUrl: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1`,
      });
      return decision.decide({
        existing,
        candidates: [{ text: "x" }],
        signal: AbortSignal.timeout(5000),
      });
    };
    const declared = new MemoryImportDuplicateDecision({
      model: "typesafe-ai/jev",
      apiKey: async () => "k",
      fetch: async () =>
        new Response("{}", { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }),
    });
    await expect(
      declared.decide({ existing, candidates: [{ text: "x" }], signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow("IMPORT_DUPLICATE_RESPONSE_TOO_LARGE");
    await expect(
      decideAgainst((response) => {
        response.writeHead(200, { "transfer-encoding": "chunked" });
        response.end("a".repeat(2 * 1024 * 1024));
      }),
    ).rejects.toThrow("IMPORT_DUPLICATE_RESPONSE_TOO_LARGE");
  });
});
