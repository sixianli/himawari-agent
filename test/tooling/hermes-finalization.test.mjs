import { expect, it } from "vitest";
import { finalizationInputs } from "../../scripts/operations/hermes-harness-finalization-comparison.mjs";
const fixture = () => {
  const calls = ["ls", "find", "grep", "bash"].map((name, i) => ({
    id: `call-${i}`,
    type: "function",
    function: { name, arguments: JSON.stringify({ path: "synthetic" }) },
  }));
  return {
    model: "configured-model",
    provider: { order: ["configured-endpoint"], allow_fallbacks: false, data_collection: "deny" },
    reasoning: { effort: "minimal" },
    temperature: 0.3,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 2000,
    tools: [{ type: "function", function: { name: "ls" } }],
    tool_choice: "auto",
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "old task" },
      { role: "assistant", content: "old answer", reasoning: "native reasoning" },
      { role: "user", content: "four tool status" },
      { role: "assistant", content: null, reasoning: "current reasoning", tool_calls: calls },
      ...calls.map((c) => ({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify({
          schemaVersion: "pi-result.v1",
          isError: false,
          content: [{ type: "text", text: "synthetic result" }],
        }),
      })),
    ],
  };
};
it("keeps complete recorded history, routing and reasoning in both finalization variants", () => {
  const original = fixture(),
    before = structuredClone(original);
  const [control, candidate] = finalizationInputs(original);
  expect(original).toEqual(before);
  for (const input of [control, candidate]) {
    expect(input.request.messages).toEqual(before.messages);
    expect(input.request.provider).toEqual(before.provider);
    expect(input.request.reasoning).toEqual(before.reasoning);
    expect(input.request.temperature).toBe(before.temperature);
    expect(input.request.max_tokens).toBe(4096);
    expect(input.request.max_completion_tokens).toBeUndefined();
  }
  expect(control.request.tools).toEqual(before.tools);
  expect(control.request.tool_choice).toBe("auto");
  expect(candidate.request.tools).toEqual([]);
  expect(candidate.request.tool_choice).toBeUndefined();
  candidate.request.messages[0].content = "changed only in clone";
  expect(control.request.messages).toEqual(before.messages);
  expect(original).toEqual(before);
});
it("rejects incomplete, failed, mismatched and mandatory-tool batches before making requests", () => {
  const missing = fixture();
  missing.messages.pop();
  expect(() => finalizationInputs(missing)).toThrow();
  const failed = fixture();
  failed.messages.at(-1).content = JSON.stringify({ schemaVersion: "pi-result.v1", isError: true });
  expect(() => finalizationInputs(failed)).toThrow();
  const mismatched = fixture();
  mismatched.messages.at(-1).tool_call_id = "other";
  expect(() => finalizationInputs(mismatched)).toThrow();
  const mandatory = fixture();
  mandatory.tool_choice = "required";
  expect(() => finalizationInputs(mandatory)).toThrow();
  const duplicate = fixture();
  duplicate.messages[4].tool_calls[1].id = "call-0";
  expect(() => finalizationInputs(duplicate)).toThrow();
});
