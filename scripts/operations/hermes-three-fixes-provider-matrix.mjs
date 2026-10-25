import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const modelId = "deepseek/deepseek-v4-flash-0731";

const providers = [
  { provider: "OpenInference", endpoint: "open-inference/fp8" },
  { provider: "BaseTen", endpoint: "baseten/fp8" },
  { provider: "DeepInfra", endpoint: "deepinfra/fp8" },
];
export function providerMatrixInputs(original) {
  assert.equal(original.model, modelId);
  assert(Array.isArray(original.messages) && original.messages.at(-1)?.role === "tool");
  return providers.map(({ provider, endpoint }) => {
    const prior = original.provider ?? {};
    assert(
      !prior.only || prior.only.includes(provider) || prior.only.includes(endpoint),
      "PROVIDER_NOT_AUTHORIZED_BY_ORIGINAL_ROUTE",
    );
    assert(
      !prior.ignore?.includes(provider) && !prior.ignore?.includes(endpoint),
      "PROVIDER_EXCLUDED_BY_ORIGINAL_ROUTE",
    );
    const request = structuredClone(original);
    request.stream = false;
    delete request.stream_options;
    delete request.max_completion_tokens;
    request.max_tokens = 4096;
    request.provider = { ...prior, order: [endpoint], only: [endpoint], allow_fallbacks: false };
    return { provider, endpoint, request };
  });
}
export function priceProviderMatrix(inputs, endpoints) {
  return inputs.map((input) => {
    const matching = endpoints.filter(
      (e) => e.provider_name === input.provider && e.tag === input.endpoint && e.status === 0,
    );
    assert(matching.length > 0, "NO_PROVIDER_ENDPOINT");
    const prompt = Math.max(...matching.map((e) => Number(e.pricing.prompt)));
    const completion = Math.max(...matching.map((e) => Number(e.pricing.completion)));
    assert(Number.isFinite(prompt) && prompt > 0 && Number.isFinite(completion) && completion > 0);
    const request = structuredClone(input.request);
    request.provider.max_price = { prompt: prompt * 1e6, completion: completion * 1e6, request: 0 };
    const maximumCostMicros = Math.ceil(
      ((Buffer.byteLength(JSON.stringify(request)) * 2 + 32768) * prompt + 4096 * completion) * 1e6,
    );
    assert(Number.isSafeInteger(maximumCostMicros) && maximumCostMicros > 0);
    return { ...input, request, maximumCostMicros };
  });
}
export function recordedCostUpper(results) {
  return results.reduce(
    (sum, r) =>
      sum +
      (Number.isFinite(r.usage?.cost) && r.usage.cost >= 0
        ? Math.ceil(r.usage.cost * 1e6)
        : r.maximumCostMicros),
    0,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md",
  );
}
