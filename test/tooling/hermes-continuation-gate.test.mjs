import { expect, it } from "vitest";
import {
  continuationGateInputs,
  unfinishedReadInput,
} from "../../scripts/operations/hermes-harness-continuation-gate.mjs";
function fixture() {
  const calls = ["ls", "find", "grep", "bash"].map((name, i) => ({
    id: `call-${i}`,
    type: "function",
    function: { name, arguments: "{}" },
  }));
  return {
    model: "same-model",
    provider: { order: ["same-route"] },
    reasoning: { effort: "minimal" },
    tools: ["ls", "find", "grep", "bash", "read"].map((name) => ({
      type: "function",
      function: { name },
    })),
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "four tools" },
      { role: "assistant", content: null, reasoning: "four-step reasoning", tool_calls: calls },
      ...calls.map((c) => ({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify({
          schemaVersion: "pi-result.v1",
          isError: false,
          content: [{ type: "text", text: "script.py" }],
        }),
      })),
    ],
  };
}
it("keeps the complete recorded input while exposing only an explicit continuation request", () => {
  const original = fixture(),
    before = structuredClone(original);
  const [control, candidate] = continuationGateInputs(original);
  expect(original).toEqual(before);
  expect(control.request.messages).toEqual(before.messages);
  expect(candidate.request.messages).toEqual(before.messages);
  expect(candidate.request.provider).toEqual(before.provider);
  expect(candidate.request.reasoning).toEqual(before.reasoning);
  expect(candidate.request.tools.map((t) => t.function.name)).toEqual(["continue_work"]);
  expect(candidate.request.tools[0].function.parameters.properties.toolNames.items.enum).toEqual([
    "ls",
    "find",
    "grep",
    "bash",
    "read",
  ]);
  expect(control.request.tools).toEqual(before.tools);
});
it("constructs a clearly labeled unfinished read using only the original listing result", () => {
  const original = fixture(),
    before = structuredClone(original);
  const positive = unfinishedReadInput(original);
  expect(original).toEqual(before);
  expect(positive.messages.at(-1)).toEqual(before.messages[3]);
  expect(positive.messages.at(-2).tool_calls).toEqual([before.messages[2].tool_calls[0]]);
  expect(positive.messages.at(-2).reasoning).toBeUndefined();
  expect(positive.messages[1].content).toContain("script.py 的完整内容");
  expect(positive.messages).toHaveLength(4);
  expect(() => continuationGateInputs(positive)).not.toThrow();
});
it("rejects ambiguous or incomplete source batches before requesting the model", () => {
  const missing = fixture();
  missing.messages.pop();
  expect(() => continuationGateInputs(missing)).toThrow();
  const forced = fixture();
  forced.tool_choice = "required";
  expect(() => continuationGateInputs(forced)).toThrow();
  const clash = fixture();
  clash.tools.push({ function: { name: "continue_work" } });
  expect(() => continuationGateInputs(clash)).toThrow();
});
