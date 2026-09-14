import type { Message } from "@earendil-works/pi-ai";
import { type AgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";

type NativeMessage = AgentSession["agent"]["state"]["messages"][number];
type RestorableMessage = Message | Extract<NativeMessage, { role: "custom" }>;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function content(value: unknown, allowed: readonly string[], text = false): boolean {
  return (
    (text && typeof value === "string") ||
    (Array.isArray(value) &&
      value.every(
        (block) =>
          record(block) &&
          allowed.includes(String(block["type"])) &&
          ((block["type"] === "text" && typeof block["text"] === "string") ||
            (block["type"] === "thinking" && typeof block["thinking"] === "string") ||
            (block["type"] === "image" &&
              typeof block["data"] === "string" &&
              typeof block["mimeType"] === "string") ||
            (block["type"] === "toolCall" &&
              typeof block["id"] === "string" &&
              typeof block["name"] === "string" &&
              record(block["arguments"]))),
      ))
  );
}
/** Preserve native custom events in SessionManager; Pi converts them only for model input. */
export function nativeHistoryMessages(values: readonly unknown[]): RestorableMessage[] {
  const native: NativeMessage[] = [];
  for (const item of values) {
    if (
      !record(item) ||
      typeof item["timestamp"] !== "number" ||
      !Number.isFinite(item["timestamp"])
    )
      throw new Error("PI_HISTORY_MESSAGE_INVALID");
    const role = item["role"];
    const valid =
      (role === "user" && content(item["content"], ["text", "image"], true)) ||
      (role === "assistant" &&
        Array.isArray(item["content"]) &&
        content(item["content"], ["text", "thinking", "toolCall"]) &&
        ["provider", "api", "model", "stopReason"].every((key) => typeof item[key] === "string") &&
        ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(
          String(item["stopReason"]),
        ) &&
        record(item["usage"])) ||
      (role === "toolResult" &&
        content(item["content"], ["text", "image"]) &&
        typeof item["toolCallId"] === "string" &&
        typeof item["toolName"] === "string" &&
        typeof item["isError"] === "boolean") ||
      (role === "custom" &&
        typeof item["customType"] === "string" &&
        content(item["content"], ["text", "image"], true)) ||
      (role === "compactionSummary" &&
        typeof item["summary"] === "string" &&
        typeof item["tokensBefore"] === "number") ||
      (role === "branchSummary" &&
        typeof item["summary"] === "string" &&
        typeof item["fromId"] === "string");
    if (!valid) throw new Error("PI_HISTORY_MESSAGE_INVALID");
    // Product context is refreshed for this Run; do not duplicate stale memory/worker blocks.
    if (role === "custom" && item["customType"] === "himawari.context.block") continue;
    native.push(structuredClone(item) as unknown as NativeMessage);
  }
  // SessionManager accepts custom messages directly. Converting them here would
  // persist product events as user-authored messages on the next history save.
  // Summary messages cannot be appended directly; retain Pi's summary encoding.
  return native.flatMap<RestorableMessage>((message) =>
    message.role === "custom" ? [message] : convertToLlm([message]),
  );
}
