import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CHAT_EGRESS_LEGEND } from "@himawari-agent/prompt-catalog";
import { expect, it } from "vitest";
import { isAgentRequest } from "../fixtures/agent-request.ts";
import { readRequestBody } from "../fixtures/request-body.ts";

const SENTENCE = "写下一次的日期，其余填 none。";
const PROVIDER_STUB = fileURLToPath(
  new URL("./production-http-composition-process.test.ts", import.meta.url),
);
const PRODUCT_PATH_PROVIDER = fileURLToPath(
  new URL("../fixtures/product-path-harness.ts", import.meta.url),
);

function splitInsideCharacter(text: string, character: string): readonly [Buffer, Buffer] {
  const bytes = Buffer.from(text, "utf8");
  const cut = bytes.indexOf(Buffer.from(character, "utf8")) + 1;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

const CHUNKWISE_STRING_DECODING = /\b\w+\s*\+=\s*chunk\s*;/u;
const READ_REQUEST_BODY_CALL = /\breadRequestBody\s*\(\s*request\b/gu;

function chunkwiseDecodingProblems(source: string, minimumReadCalls: number): readonly string[] {
  const problems: string[] = [];
  if (CHUNKWISE_STRING_DECODING.test(source)) problems.push("string += chunk");
  if ((source.match(READ_REQUEST_BODY_CALL) ?? []).length < minimumReadCalls)
    problems.push(`fewer than ${minimumReadCalls} readRequestBody(request) calls`);
  return problems;
}

const legacyAgentFilter = ({
  path: route,
  body,
}: {
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}) =>
  route === "/v1/chat/completions" &&
  Array.isArray(body?.["messages"]) &&
  (body["messages"] as Array<{ role?: unknown }>)[0]?.role === "system";

it("[PR-A] keeps a multi-byte character that is split across two request chunks", async () => {
  const [head, tail] = splitInsideCharacter(SENTENCE, "次");
  expect(await readRequestBody(Readable.from([head, tail]))).toBe(SENTENCE);
});

it("[PR-A] REVERSE: appending chunks to a string, the way the provider stub used to, corrupts the same input", async () => {
  const [head, tail] = splitInsideCharacter(SENTENCE, "次");
  let body = "";
  for await (const chunk of Readable.from([head, tail])) body += chunk;
  expect(body).toContain("�");
  expect(body).not.toBe(SENTENCE);
});

it("[PR-A] keeps the character when a real HTTP request delivers it in two separate chunks", async () => {
  const [head, tail] = splitInsideCharacter(SENTENCE, "次");
  let received: Promise<string> | undefined;
  let chunkCount = 0;
  const server = createServer((request, response) => {
    received = readRequestBody(request, () => {
      chunkCount += 1;
    });
    void received.then(() => response.end("ok"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port, method: "POST", headers: { "transfer-encoding": "chunked" } },
        (response) => {
          response.resume();
          response.on("end", resolve);
        },
      );
      outgoing.on("error", reject);
      outgoing.write(head);
      setTimeout(() => outgoing.end(tail), 50);
    });
    expect(await received).toBe(SENTENCE);
    expect(chunkCount).toBeGreaterThanOrEqual(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("[PR-A] no fake model server decodes request bodies chunk by chunk", () => {
  expect(chunkwiseDecodingProblems(readFileSync(PROVIDER_STUB, "utf8"), 2)).toEqual([]);
  expect(chunkwiseDecodingProblems(readFileSync(PRODUCT_PATH_PROVIDER, "utf8"), 0)).toEqual([]);
});

it("[PR-A] REVERSE: the guard flags chunk-by-chunk decoding however the variable is named", () => {
  expect(
    chunkwiseDecodingProblems(`request.on("data", (chunk) => {\n  body += chunk;\n});`, 0),
  ).toContain("string += chunk");
  expect(chunkwiseDecodingProblems(`raw  +=  chunk;`, 0)).toContain("string += chunk");
  expect(chunkwiseDecodingProblems("readRequestBody(request)", 2)).toContain(
    "fewer than 2 readRequestBody(request) calls",
  );
  expect(
    chunkwiseDecodingProblems(
      "readRequestBody(\n  request,\n)\nreadRequestBody(request, onChunk)",
      2,
    ),
  ).toEqual([]);
});

it("[PR-A] counts an agent request but not a background request that carries only the egress legend", () => {
  const agent = {
    path: "/v1/chat/completions",
    body: { messages: [{ role: "system", content: "# 你是谁\n你是 Himawari" }, { role: "user" }] },
  };
  const background = {
    path: "/v1/chat/completions",
    body: {
      messages: [{ role: "system", content: CHAT_EGRESS_LEGEND.text }, { role: "user" }],
    },
  };
  expect(isAgentRequest(agent)).toBe(true);
  expect(isAgentRequest(background)).toBe(false);
  expect(isAgentRequest({ path: "/v1/embeddings", body: agent.body })).toBe(false);
  expect(isAgentRequest({ path: "/v1/chat/completions", body: { messages: [] } })).toBe(false);
  expect(isAgentRequest({ path: "/v1/chat/completions" })).toBe(false);
});

it("[PR-A] REVERSE: the filter used before the fix would have counted the background request", () => {
  const background = {
    path: "/v1/chat/completions",
    body: {
      messages: [{ role: "system", content: CHAT_EGRESS_LEGEND.text }, { role: "user" }],
    },
  };
  expect(legacyAgentFilter(background)).toBe(true);
  expect(isAgentRequest(background)).toBe(false);
});
