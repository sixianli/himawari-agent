import { ExaPublicSearchAdapter } from "@himawari-agent/platform-node";

// Installed fixed-read program; Worker supplies admitted protected input and SRT
// restricts network access to the declared search provider.
try {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error("WEB_SEARCH_INPUT_LIMIT");
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("WEB_SEARCH_INPUT_INVALID");
  const args = input as Record<string, unknown>;
  if (
    Object.keys(args).some((key) => !["query", "limit"].includes(key)) ||
    typeof args["query"] !== "string" ||
    (args["limit"] !== undefined && typeof args["limit"] !== "number")
  )
    throw new Error("WEB_SEARCH_INPUT_INVALID");
  const results = await new ExaPublicSearchAdapter().search({
    query: args["query"],
    limit: (args["limit"] as number | undefined) ?? 5,
  });
  process.stdout.write(
    JSON.stringify({
      retrievedAt: new Date().toISOString(),
      source: "Exa public web search",
      contentKind: "search_excerpts",
      pagesOpened: false,
      results,
    }),
  );
} catch {
  // Provider errors can include transport credentials; only this stable code exits.
  process.stderr.write("WEB_SEARCH_FAILED\n");
  process.exitCode = 1;
}
