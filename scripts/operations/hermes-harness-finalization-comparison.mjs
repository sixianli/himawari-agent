import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function finalizationInputs(original) {
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  const lastAssistant = original.messages.findLastIndex((m) => m.role === "assistant");
  assert(lastUser >= 0 && lastAssistant > lastUser);
  const calls = original.messages[lastAssistant].tool_calls;
  const results = original.messages.slice(lastAssistant + 1);
  assert(Array.isArray(calls) && calls.length === 4 && results.length === 4);
  assert.deepEqual(
    calls.map((c) => c.function.name),
    ["ls", "find", "grep", "bash"],
  );
  assert(new Set(calls.map((c) => c.id)).size === 4);
  assert(results.every((r, i) => r.role === "tool" && r.tool_call_id === calls[i].id));
  assert(original.tool_choice === undefined || original.tool_choice === "auto");
  assert(
    results.every((r) => {
      const value = JSON.parse(r.content);
      return value.schemaVersion === "pi-result.v1" && value.isError === false;
    }),
  );
  return ["original", "no_active_tools"].map((variant) => {
    const request = structuredClone(original);
    request.stream = false;
    delete request.stream_options;
    delete request.max_completion_tokens;
    request.max_tokens = 4096;
    if (variant === "no_active_tools") {
      request.tools = [];
      delete request.tool_choice;
    }
    return { variant, request };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md",
  );
}
