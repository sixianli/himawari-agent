import { CHAT_EGRESS_LEGEND } from "@himawari-agent/prompt-catalog";

export function isAgentRequest({
  path: route,
  body,
}: {
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>> | undefined;
}): boolean {
  if (route !== "/v1/chat/completions" || !Array.isArray(body?.["messages"])) return false;
  const first = (body["messages"] as Array<{ role?: unknown; content?: unknown }>)[0];
  return first?.role === "system" && first.content !== CHAT_EGRESS_LEGEND.text;
}
