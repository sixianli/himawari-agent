import { ModelEgress } from "@himawari-agent/application";

const key = new Uint8Array([7, 7, 7, 7]);

function sign(secret: Uint8Array, message: string): Uint8Array {
  let hash = secret[0] ?? 0;
  const out = new Uint8Array(8);
  for (const char of message) {
    hash = (hash * 131 + char.charCodeAt(0)) % 2147483647;
    out[hash % 8] = (out[hash % 8] ?? 0) ^ (hash & 255);
  }
  return out;
}

export async function toolResultSentToModel(output: string): Promise<string> {
  const exchange = new ModelEgress({ key: async () => key, sign }).exchange();
  let body = "";
  const fetch = exchange.wrapFetch(
    async (_input: string, init?: { method?: string; body?: unknown }) => {
      body = String(init?.body);
      return { ok: true };
    },
  );
  await fetch("https://gateway.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "m",
      messages: [{ role: "tool", tool_call_id: "call", content: output }],
    }),
  });
  return body;
}
