import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { readRequestBody } from "../fixtures/request-body.ts";

const SENTENCE = "写下一次的日期，其余填 none。";

function splitInsideCharacter(text: string, character: string): readonly [Buffer, Buffer] {
  const bytes = Buffer.from(text, "utf8");
  const cut = bytes.indexOf(Buffer.from(character, "utf8")) + 1;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

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
  const server = createServer((request, response) => {
    received = readRequestBody(request);
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
