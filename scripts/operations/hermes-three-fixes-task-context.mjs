import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function recordedToolError(content) {
  try {
    return JSON.parse(content)?.isError === true;
  } catch {
    return false;
  }
}
// Compare the Harness context extension on the unchanged configured route.
export function currentTaskInputs(original, reminder) {
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  const lastAssistant = original.messages.findLastIndex((m) => m.role === "assistant");
  assert(lastUser >= 0 && lastAssistant > lastUser && original.messages.at(-1).role === "tool");
  const content = original.messages[lastUser].content;
  assert(
    typeof content === "string" ||
      (Array.isArray(content) && content.every((c) => c.type === "text")),
  );
  const prompt = typeof content === "string" ? content : content.map((c) => c.text).join("");
  const calls = original.messages[lastAssistant].tool_calls;
  const results = original.messages.slice(lastAssistant + 1);
  assert(
    calls.length === results.length &&
      results.every((r, i) => r.role === "tool" && r.tool_call_id === calls[i].id),
  );
  const facts = results.map((result, index) => ({
    toolCallId: result.tool_call_id,
    toolName: calls[index].function.name,
    isError: recordedToolError(result.content),
  }));
  return ["original", "current_task_context"].map((variant) => {
    const request = structuredClone(original);
    request.stream = false;
    delete request.stream_options;
    delete request.max_completion_tokens;
    request.max_tokens = 4096;
    if (variant === "current_task_context")
      request.messages.push({
        role: "user",
        content: [{ type: "text", text: reminder(prompt, facts) }],
      });
    return { variant, request };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md",
  );
}
