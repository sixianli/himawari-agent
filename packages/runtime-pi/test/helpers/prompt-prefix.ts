export interface PrefixBreak {
  readonly where: string;
  readonly index: number;
}

interface ParsedBody {
  readonly raw: string;
  readonly parsed: Record<string, unknown> & { messages: unknown[] };
}

function parse(raw: string): ParsedBody {
  const parsed = JSON.parse(raw) as ParsedBody["parsed"];
  if (!Array.isArray(parsed.messages)) throw new TypeError("PROMPT_PREFIX_BODY_HAS_NO_MESSAGES");
  return { raw, parsed };
}

function messagesPrefixBytes(body: ParsedBody): string {
  const marker = '"messages":';
  const start = body.raw.indexOf(marker) + marker.length;
  const end = start + JSON.stringify(body.parsed.messages).length;
  return body.raw.slice(0, end - 1);
}

function midSystemMessage(body: ParsedBody): PrefixBreak | null {
  const index = body.parsed.messages.findIndex(
    (message, position) =>
      position > 0 &&
      ["system", "developer"].includes(String((message as { role?: unknown } | null)?.role)),
  );
  return index < 0 ? null : { where: "mid-system-message", index };
}

export function findPrefixBreak(previousRaw: string, nextRaw: string): PrefixBreak | null {
  const previous = parse(previousRaw);
  const next = parse(nextRaw);
  const midSystem = midSystemMessage(previous) ?? midSystemMessage(next);
  if (midSystem) return midSystem;
  for (const key of Object.keys(previous.parsed)) {
    if (key === "messages" || key === "max_tokens") continue;
    if (JSON.stringify(previous.parsed[key]) !== JSON.stringify(next.parsed[key]))
      return { where: `field:${key}`, index: -1 };
  }
  if (next.parsed.messages.length < previous.parsed.messages.length)
    return { where: "messages-shortened", index: next.parsed.messages.length };
  for (let index = 0; index < previous.parsed.messages.length; index += 1) {
    if (
      JSON.stringify(previous.parsed.messages[index]) !==
      JSON.stringify(next.parsed.messages[index])
    )
      return { where: "message-changed", index };
  }
  if (
    !next.raw.startsWith(`${messagesPrefixBytes(previous)},`) &&
    next.parsed.messages.length > previous.parsed.messages.length
  )
    return { where: "bytes-changed", index: previous.parsed.messages.length };
  return null;
}

export function findConversationBreak(
  bodies: readonly string[],
): (PrefixBreak & { request: number }) | null {
  for (let request = 1; request < bodies.length; request += 1) {
    const found = findPrefixBreak(bodies[request - 1] ?? "", bodies[request] ?? "");
    if (found) return { ...found, request };
  }
  return null;
}

export function findPerceptionPlacementBreak(
  bodies: readonly string[],
  marker: string,
): (PrefixBreak & { request: number }) | null {
  let previousLength = 0;
  let seen = false;
  for (const [request, raw] of bodies.entries()) {
    const body = parse(raw);
    if (JSON.stringify(body.parsed["tools"] ?? null).includes(marker))
      return { where: "perception-in-tools", index: -1, request };
    for (const [index, message] of body.parsed.messages.entries()) {
      if (!JSON.stringify(message).includes(marker)) continue;
      const role = String((message as { role?: unknown } | null)?.role);
      if (role === "system" || role === "developer")
        return { where: "perception-in-system", index, request };
      if (role !== "tool") return { where: "perception-not-tool-result", index, request };
      if (!seen && index < previousLength)
        return { where: "perception-inserted-earlier", index, request };
      seen = true;
    }
    previousLength = body.parsed.messages.length;
  }
  return seen ? null : { where: "perception-missing", index: -1, request: -1 };
}
