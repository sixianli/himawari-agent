import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const modelId = "deepseek/deepseek-v4-flash-0731";

export function providerComparisonInputs(original) {
  assert.equal(original.model, modelId);
  assert(Array.isArray(original.messages));
  const lastUser = original.messages.findLastIndex((m) => m.role === "user");
  assert(lastUser > 0 && original.messages.at(-1).role === "tool");
  const currentTools = original.messages.slice(lastUser).filter((m) => m.role === "tool");
  const multiTool = currentTools.length === 4;
  assert(currentTools.length === 1 || multiTool);
  const inputs = [];
  for (const provider of ["OpenInference", "DeepInfra"]) {
    const prior = original.provider ?? {};
    assert(
      !prior.only || prior.only.includes(provider),
      "PROVIDER_NOT_AUTHORIZED_BY_ORIGINAL_ROUTE",
    );
    assert(!prior.ignore?.includes(provider), "PROVIDER_EXCLUDED_BY_ORIGINAL_ROUTE");
    for (const variant of multiTool ? ["original", "native_current_tool_content"] : ["original"]) {
      const request = structuredClone(original);
      request.stream = false;
      delete request.stream_options;
      delete request.max_completion_tokens;
      request.max_tokens = 4096;
      request.provider = { ...prior, order: [provider], only: [provider], allow_fallbacks: false };
      if (variant === "native_current_tool_content") {
        for (const m of request.messages.slice(lastUser)) {
          if (m.role !== "tool") continue;
          assert.equal(typeof m.content, "string");
          const envelope = JSON.parse(m.content);
          assert.equal(envelope.schemaVersion, "pi-result.v1");
          assert.equal(envelope.isError, false);
          assert(Array.isArray(envelope.content) && envelope.content.length > 0);
          assert(envelope.content.every((c) => c.type === "text" && typeof c.text === "string"));
          m.content = envelope.content.map((c) => c.text).join("\n");
        }
      }
      inputs.push({ variant, provider, request });
    }
  }
  return inputs;
}
export function estimateProviderMaximumMicros(inputs, endpoints) {
  return (
    inputs.reduce((sum, { request, provider }) => {
      const matching = endpoints.filter((e) => e.provider_name === provider && e.status === 0);
      assert(matching.length > 0, "NO_PROVIDER_ENDPOINT");
      const prompt = Math.max(...matching.map((e) => Number(e.pricing.prompt)));
      const completion = Math.max(...matching.map((e) => Number(e.pricing.completion)));
      assert(
        Number.isFinite(prompt) && prompt > 0 && Number.isFinite(completion) && completion > 0,
      );
      request.provider.max_price = {
        prompt: prompt * 1e6,
        completion: completion * 1e6,
        request: 0,
      };
      return (
        sum +
        Math.ceil(
          ((Buffer.byteLength(JSON.stringify(request)) * 2 + 32768) * prompt + 4096 * completion) *
            1e6,
        )
      );
    }, 0) * 2
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md",
  );
}
