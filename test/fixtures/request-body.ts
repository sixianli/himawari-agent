import type { Readable } from "node:stream";

export async function readRequestBody(
  request: Readable,
  onChunk?: (chunk: Buffer) => void,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    onChunk?.(bytes);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
