import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function continuationGateInputs(original) {
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  const lastAssistant = original.messages.findLastIndex((m) => m.role === "assistant");
  assert(lastUser >= 0 && lastAssistant > lastUser);
  const calls = original.messages[lastAssistant].tool_calls;
  const results = original.messages.slice(lastAssistant + 1);
  assert(Array.isArray(calls) && [1, 4].includes(calls.length) && results.length === calls.length);
  assert.deepEqual(
    calls.map((c) => c.function.name),
    calls.length === 1 ? ["ls"] : ["ls", "find", "grep", "bash"],
  );
  assert(new Set(calls.map((c) => c.id)).size === calls.length);
  assert(results.every((r, i) => r.role === "tool" && r.tool_call_id === calls[i].id));
  assert(original.tool_choice === undefined || original.tool_choice === "auto");
  assert(
    results.every((r) => {
      const value = JSON.parse(r.content);
      return value.schemaVersion === "pi-result.v1" && value.isError === false;
    }),
  );
  return ["original", "continuation_gate"].map((variant) => {
    const request = structuredClone(original);
    request.stream = false;
    delete request.stream_options;
    delete request.max_completion_tokens;
    request.max_tokens = 4096;
    if (variant === "continuation_gate") {
      const names = original.tools.map((t) => t.function.name);
      assert(!names.includes("continue_work"));
      request.tools = [
        {
          type: "function",
          function: {
            name: "continue_work",
            description:
              "The previous tool results are available. Answer the current user request directly if they are sufficient. Use this only when further tool work is necessary to complete that request. Identify the needed tools and explain the missing evidence or unfinished action. Do not repeat already completed work unless fresh results are necessary.",
            parameters: {
              type: "object",
              properties: {
                reason: { type: "string" },
                toolNames: {
                  type: "array",
                  items: { type: "string", enum: names },
                  minItems: 1,
                  uniqueItems: true,
                },
              },
              required: ["reason", "toolNames"],
              additionalProperties: false,
            },
          },
        },
      ];
      delete request.tool_choice;
    }
    return { variant, request };
  });
}
// Positive control: a listing cannot answer a question about a file's contents.
// Keep the same authorized synthetic workspace, old history and actual ls result.
export function unfinishedReadInput(original) {
  const request = structuredClone(original);
  const lastUser = request.messages.findLastIndex((m) => m.role === "user");
  const lastAssistant = request.messages.findLastIndex((m) => m.role === "assistant");
  assert(lastUser >= 0 && lastAssistant > lastUser);
  const assistant = request.messages[lastAssistant];
  assert.equal(assistant.tool_calls[0].function.name, "ls");
  const result = request.messages[lastAssistant + 1];
  assert.equal(result.tool_call_id, assistant.tool_calls[0].id);
  request.messages[lastUser].content =
    "先列出工作目录 /data/hermes/himawari/workspaces/default，然后读取 script.py 的完整内容，说明它的输入、输出和失败情况。不要仅凭文件名推断其行为。";
  // The retained ls call is a constructed first step, not a recorded full Run.
  delete assistant.reasoning;
  delete assistant.reasoning_content;
  delete assistant.reasoning_details;
  assistant.content = null;
  assistant.tool_calls = assistant.tool_calls.slice(0, 1);
  request.messages = request.messages.slice(0, lastAssistant + 1).concat([result]);
  return request;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md",
  );
}
