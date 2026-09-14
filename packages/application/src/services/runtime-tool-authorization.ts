import type { PermissionDecision, RuntimeToolExecutionResult } from "../ports/index.js";

/** Every governed tool uses the same suspension contract; no model result on ASK. */
export function runtimeToolAuthorizationResult(
  decision: Exclude<PermissionDecision, { decision: "ALLOW" }>,
): RuntimeToolExecutionResult {
  if (decision.decision === "ASK") {
    return {
      outcome: "awaiting_approval",
      approval: {
        approvalRequestId: decision.approvalRequest.id,
        semanticSnapshotHash: decision.approvalRequest.semanticSnapshotHash,
        expiresAt: decision.approvalRequest.expiresAt,
      },
      resultRef: null,
      errorCode: null,
      externalActionId: null,
      modelContent: "",
    };
  }
  return {
    outcome: "failed",
    resultRef: null,
    errorCode: decision.reasonCode,
    externalActionId: null,
    modelContent: `操作未执行：${decision.reasonCode}`,
  };
}
