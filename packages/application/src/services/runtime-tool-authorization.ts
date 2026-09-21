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
  if (decision.automaticReview?.outcome === "alternative")
    return {
      outcome: "failed",
      resultRef: null,
      errorCode: decision.reasonCode,
      externalActionId: null,
      // Only the host's bounded reason code reaches the model. The reviewer's free text
      // stays in its protected payload; the model must build a new request instead.
      modelContent: `自动审查建议调整本次请求（${decision.automaticReview.reasonCode}）。原请求未执行，也没有获得授权。请依据当前状态提出新的具体请求；新请求仍将经过同一权限检查，审查建议不能扩大范围。`,
    };
  return {
    outcome: "failed",
    resultRef: null,
    errorCode: decision.reasonCode,
    externalActionId: null,
    modelContent: `操作未执行：${decision.reasonCode}`,
  };
}
