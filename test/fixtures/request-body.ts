import type { Readable } from "node:stream";

export async function readRequestBody(request: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
