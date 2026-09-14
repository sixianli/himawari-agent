import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  comparisonInputs,
  estimateMaximumMicros,
} from "../../scripts/operations/hermes-three-fixes-input-comparison.mjs";

import {
  providerComparisonInputs,
  estimateProviderMaximumMicros,
} from "../../scripts/operations/hermes-three-fixes-provider-comparison.mjs";

it("keeps current tool reasoning and results intact in isolated history comparisons", () => {
  const original = {
    model: "deepseek/deepseek-v4-flash-0731",
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer", reasoning: "old thinking" },
      { role: "user", content: "new request" },
      {
        role: "assistant",
        content: null,
        reasoning: "current thinking",
        tool_calls: [{ id: "current", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "current", content: "actual result" },
    ],
  };
  const before = structuredClone(original);
  const variants = comparisonInputs(original);
  expect(original).toEqual(before);
  expect(variants[0].request.messages).toEqual(before.messages);
  expect(variants[1].request.messages[2].reasoning).toBeUndefined();
  expect(variants[1].request.messages.slice(3)).toEqual(before.messages.slice(3));
  expect(variants[2].request.messages).toEqual([before.messages[0], ...before.messages.slice(3)]);
  original.messages[2].reasoning_details = [{ type: "reasoning.encrypted", data: "opaque" }];
  expect(() => comparisonInputs(original)).toThrow("SIGNED_REASONING_NOT_ELIGIBLE");
  expect(() => estimateMaximumMicros(variants, { prompt: "unknown", completion: "0.1" })).toThrow();
  expect(
    estimateMaximumMicros(variants, { prompt: "0.000001", completion: "0.000002" }),
  ).toBeGreaterThan(0);
});

it("bounds regression cost evidence to authorized test threads and verifies frozen helpers", () => {
  const result = execFileSync(
    "python3",
    ["-B", fileURLToPath(new URL("./fixtures/hermes-three-fixes-check.py", import.meta.url))],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(result).toBe("");
});

it("isolates native result content while retaining complete history and current reasoning", () => {
  const calls = ["ls", "find", "grep", "bash"].map((name) => ({
    id: name,
    function: { name, arguments: "{}" },
  }));
  const original = {
    model: "deepseek/deepseek-v4-flash-0731",
    provider: { zdr: true, data_collection: "deny" },
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "previous request" },
      { role: "assistant", content: "previous answer", reasoning: "previous reasoning" },
      { role: "user", content: "current request" },
      { role: "assistant", content: null, reasoning: "current reasoning", tool_calls: calls },
      ...calls.map((c) => ({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify({
          schemaVersion: "pi-result.v1",
          isError: false,
          content: [{ type: "text", text: c.id + " output" }],
          source: { toolCallId: "internal-id" },
        }),
      })),
    ],
  };
  const before = structuredClone(original);
  const variants = providerComparisonInputs(original);
  expect(variants).toHaveLength(4);
  expect(original).toEqual(before);
  for (const variant of variants) {
    expect(variant.request.messages.slice(0, 5)).toEqual(before.messages.slice(0, 5));
    expect(variant.request.provider).toMatchObject({
      zdr: true,
      data_collection: "deny",
      allow_fallbacks: false,
      only: [variant.provider],
    });
    expect(variant.request.messages.slice(5).map((m) => m.tool_call_id)).toEqual(
      calls.map((c) => c.id),
    );
    if (variant.variant === "native_current_tool_content")
      expect(variant.request.messages.slice(5).map((m) => m.content)).toEqual(
        calls.map((c) => c.id + " output"),
      );
    else expect(variant.request.messages).toEqual(before.messages);
  }
  expect(
    estimateProviderMaximumMicros(
      variants,
      ["OpenInference", "DeepInfra"].map((provider_name) => ({
        provider_name,
        status: 0,
        pricing: { prompt: "0.00000006", completion: "0.00000018" },
      })),
    ),
  ).toBeGreaterThan(0);
  expect(() =>
    providerComparisonInputs({ ...original, provider: { only: ["OpenInference"] } }),
  ).toThrow("PROVIDER_NOT_AUTHORIZED_BY_ORIGINAL_ROUTE");
  original.messages[5].content = JSON.stringify({
    schemaVersion: "pi-result.v1",
    isError: true,
    content: [{ type: "text", text: "failure" }],
  });
  expect(() => providerComparisonInputs(original)).toThrow();
});

it("keeps endpoint comparisons lossless and reserves the cost of missing responses", async () => {
  const { providerMatrixInputs, priceProviderMatrix, recordedCostUpper } = await import(
    "../../scripts/operations/hermes-three-fixes-provider-matrix.mjs"
  );
  const original = {
    model: "deepseek/deepseek-v4-flash-0731",
    provider: { zdr: true, data_collection: "deny" },
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "current" },
      {
        role: "assistant",
        content: null,
        reasoning: "original thinking",
        tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "actual output" },
    ],
  };
  const before = structuredClone(original);
  const inputs = providerMatrixInputs(original);
  expect(inputs.map((i) => i.provider)).toEqual(["OpenInference", "BaseTen", "DeepInfra"]);
  for (const { request, endpoint } of inputs) {
    expect(request.messages).toEqual(before.messages);
    expect(request.provider).toMatchObject({
      zdr: true,
      data_collection: "deny",
      only: [endpoint],
      allow_fallbacks: false,
    });
  }
  const priced = priceProviderMatrix(
    inputs,
    inputs.map(({ provider, endpoint }) => ({
      provider_name: provider,
      tag: endpoint,
      status: 0,
      pricing: { prompt: "0.00000013", completion: "0.00000026" },
    })),
  );
  expect(original).toEqual(before);
  expect(inputs.every((i) => i.request.provider.max_price === undefined)).toBe(true);
  expect(
    priced.every((i) => i.maximumCostMicros > 0 && i.request.provider.max_price.request === 0),
  ).toBe(true);
  expect(
    recordedCostUpper([
      { maximumCostMicros: 4000, usage: { cost: 0.00002 } },
      { maximumCostMicros: 5000 },
      { maximumCostMicros: 0, status: "skipped_provider_failure" },
    ]),
  ).toBe(5020);
  expect(() => priceProviderMatrix(inputs, [])).toThrow("NO_PROVIDER_ENDPOINT");
  expect(() => providerMatrixInputs({ ...original, provider: { ignore: ["BaseTen"] } })).toThrow(
    "PROVIDER_EXCLUDED_BY_ORIGINAL_ROUTE",
  );
});

it("qualifies current-task reminders without rewriting history or selecting another provider", async () => {
  const { currentTaskInputs } = await import(
    "../../scripts/operations/hermes-three-fixes-task-context.mjs"
  );
  const { currentTaskReminder } = await import(
    "../../packages/runtime-pi/test/fixtures/rejected-current-task-context.ts"
  );
  const original = {
    model: "any-supported-model",
    provider: { order: ["original-endpoint"], allow_fallbacks: false, data_collection: "deny" },
    messages: [
      { role: "user", content: "previous task" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: [{ type: "text", text: "current task" }] },
      {
        role: "assistant",
        content: null,
        reasoning: "current reasoning",
        tool_calls: [{ id: "current", function: { name: "read", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "current",
        content: JSON.stringify({
          isError: false,
          content: [{ type: "text", text: "actual result" }],
        }),
      },
    ],
  };
  const before = structuredClone(original);
  const [control, candidate] = currentTaskInputs(original, currentTaskReminder);
  expect(original).toEqual(before);
  expect(control.request.messages).toEqual(before.messages);
  expect(candidate.request.messages.slice(0, -1)).toEqual(before.messages);
  expect(candidate.request.provider).toEqual(before.provider);
  expect(candidate.request.messages.at(-1)).toMatchObject({ role: "user" });
  expect(JSON.stringify(candidate.request.messages.at(-1))).toContain("current task");
  expect(JSON.stringify(candidate.request.messages.at(-1))).not.toContain("previous task");
});
