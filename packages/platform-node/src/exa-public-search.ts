import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { PublicWebAdapterPort, WebSearchCandidate } from "@himawari-agent/application";
import { scanMachineSecrets } from "@himawari-agent/application";
import { fetch as proxyFetch, ProxyAgent } from "undici";

const endpoint = "https://mcp.exa.ai/mcp";
export function parseExaSearchResults(text: string, limit: number): readonly WebSearchCandidate[] {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("WEB_SEARCH_OUTPUT_LIMIT");
  const results: WebSearchCandidate[] = [];
  for (const part of text.split(/\n\s*---\s*\n/)) {
    const title = /^Title:\s*(.+)$/m.exec(part)?.[1];
    const rawUrl = /^URL:\s*(\S+)$/m.exec(part)?.[1];
    if (!title || !rawUrl) continue;
    const url = new URL(rawUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
    // Exa's Z suffix means UTC. Spell it out for readers without converting
    // the source time or assigning a zone to date-only / offset-free values.
    // Only annotate the metadata header; quoted excerpt text stays intact.
    const highlights = part.indexOf("\nHighlights:");
    const headerEnd = highlights < 0 ? part.length : highlights;
    const summary =
      part
        .slice(0, headerEnd)
        .replace(
          /^Published: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/m,
          "Published: $1 (UTC)",
        ) + part.slice(headerEnd);
    results.push({
      url: url.href,
      title: title.slice(0, 1024),
      summary: summary.slice(0, 12000),
      resultRank: results.length + 1,
      openedResourceId: null,
    });
    if (results.length >= limit) break;
  }
  if (!results.length && text.trim()) throw new Error("WEB_SEARCH_RESPONSE_UNRECOGNIZED");
  return results;
}

/** Public search only. Transport remains the MCP SDK; the host owns disclosure
 * admission and the authenticated SRT egress proxy. No browser cookies or API key. */
export class ExaPublicSearchAdapter implements Pick<PublicWebAdapterPort, "search"> {
  async search(input: {
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly WebSearchCandidate[]> {
    if (
      !input.query.trim() ||
      Buffer.byteLength(input.query) > 4096 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10 ||
      scanMachineSecrets(input.query).length
    )
      throw new Error("WEB_SEARCH_INPUT_INVALID");
    const proxyUrl = process.env["HTTPS_PROXY"];
    if (!proxyUrl) throw new Error("WEB_SEARCH_SANDBOX_PROXY_REQUIRED");
    const proxy = new URL(proxyUrl);
    if (
      proxy.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(proxy.hostname) ||
      !proxy.username ||
      !proxy.password
    )
      throw new Error("WEB_SEARCH_SANDBOX_PROXY_INVALID");
    const token = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    proxy.username = "";
    proxy.password = "";
    const dispatcher = new ProxyAgent({ uri: proxy.href, token });
    const client = new Client({ name: "himawari-public-search", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (url, init) => {
        if (String(url) !== endpoint) throw new Error("WEB_SEARCH_ENDPOINT_CHANGED");
        if (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
          throw new Error("WEB_SEARCH_REQUEST_INVALID");
        const response = await proxyFetch(String(url), {
          ...(init?.method ? { method: init.method } : {}),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
          redirect: "error",
          dispatcher,
        });
        if (!response.body)
          return new Response(null, {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          });
        let total = 0;
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                total += chunk.byteLength;
                if (total > 256 * 1024) throw new Error("WEB_SEARCH_RESPONSE_LIMIT");
                controller.enqueue(chunk);
              },
            }),
          ),
          {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
          },
        );
      },
    });
    try {
      await client.connect(transport, { timeout: 15000 });
      const result = await client.callTool(
        {
          name: "web_search_exa",
          arguments: {
            query: input.query.trim(),
            objective:
              "Find current public sources matching the query. Return titles, source URLs, publication dates and relevant excerpts.",
            numResults: input.limit,
          },
        },
        { timeout: 30000 },
      );
      if (result.isError || !Array.isArray(result.content))
        throw new Error("WEB_SEARCH_PROVIDER_FAILED");
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n\n---\n\n");
      if (scanMachineSecrets(text).length) throw new Error("WEB_SEARCH_OUTPUT_REDACTED");
      return parseExaSearchResults(text, input.limit);
    } finally {
      await client.close().catch(() => undefined);
      await dispatcher.close();
    }
  }
}
