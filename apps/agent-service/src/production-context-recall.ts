import type { RuntimeToolDescriptor } from "@himawari-agent/application";

export const TOOL_RESULT_RECALL_CAPABILITY_REF = "context.tool_result_recall";
export const RUNTIME_CONTEXT_EXECUTOR = "runtime_context";

export function toolResultRecallDescriptor(): RuntimeToolDescriptor {
  return {
    definition: "tool-result-recall",
    name: "tool_result_recall",
    capabilityRef: TOOL_RESULT_RECALL_CAPABILITY_REF,
    capabilityHandleRef: null,
  };
}
