import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const modelId = "deepseek/deepseek-v4-flash-0731";

export function comparisonInputs(original) {
  assert.equal(original.model, modelId);
  assert(Array.isArray(original.messages));
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  assert(lastUser > 0 && original.messages.at(-1).role === "tool");
  const copies = ["original", "without_prior_plaintext_reasoning", "current_turn_only"].map(
    (variant) => {
      const request = structuredClone(original);
      request.stream = false;
      delete request.stream_options;
      delete request.max_completion_tokens;
      request.max_tokens = 2048;
      if (variant === "without_prior_plaintext_reasoning") {
        for (const message of request.messages.slice(0, lastUser)) {
          if (message.role !== "assistant") continue;
          for (const field of ["reasoning", "reasoning_content", "reasoning_text"])
            delete message[field];
          // Do not alter encrypted or signed reasoning; this experiment is plaintext only.
          assert(!message.reasoning_details, "SIGNED_REASONING_NOT_ELIGIBLE");
        }
      }
      if (variant === "current_turn_only") {
        request.messages = [
          ...request.messages.filter((m) => m.role === "system"),
          ...request.messages.slice(lastUser),
        ];
      }
      return { variant, request };
    },
  );
  return copies;
}
export function estimateMaximumMicros(inputs, pricing) {
  const prompt = Number(pricing.prompt),
    completion = Number(pricing.completion);
  assert(Number.isFinite(prompt) && prompt > 0 && Number.isFinite(completion) && completion > 0);
  // Deliberately conservative byte-based input allowance, plus protocol overhead.
  return (
    inputs.reduce(
      (sum, { request }) =>
        sum +
        Math.ceil(
          ((Buffer.byteLength(JSON.stringify(request)) * 2 + 32768) * prompt + 2048 * completion) *
            1e6,
        ),
      0,
    ) * 2
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md",
  );
}
