import { describe, expect, it } from "vitest";
import { runtimeToolAuthorizationResult } from "../src/services/runtime-tool-authorization.js";

const approvalRequest = {
  id: "approval:1",
  semanticSnapshotHash: "sha256:snapshot",
  expiresAt: "2026-09-21T00:05:00.000Z",
};

describe("runtime tool authorization result", () => {
  it("suspends the tool batch on ASK without exposing model text", () => {
    expect(
      runtimeToolAuthorizationResult({
        decision: "ASK",
        approvalRequest: approvalRequest as never,
      }),
    ).toEqual({
      outcome: "awaiting_approval",
      approval: {
        approvalRequestId: "approval:1",
        semanticSnapshotHash: "sha256:snapshot",
        expiresAt: "2026-09-21T00:05:00.000Z",
      },
      resultRef: null,
      errorCode: null,
      externalActionId: null,
      modelContent: "",
    });
  });

  it("reports a safer alternative as a failure that requires a new concrete request", () => {
    const result = runtimeToolAuthorizationResult({
      decision: "DENY",
      reasonCode: "automatic_review_suggested_alternative",
      alternativesAllowed: true,
      automaticReview: {
        outcome: "alternative",
        reasonCode: "OUT_OF_SCOPE",
        suggestionRef: "payload-suggestion",
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "automatic_review_suggested_alternative",
      resultRef: null,
    });
    // Only the host's bounded reason code reaches the model, and the message always
    // requires a new request through the same permission entry.
    expect(result.modelContent).toContain("OUT_OF_SCOPE");
    expect(result.modelContent).toContain("新的具体请求");
    expect(result.modelContent).not.toContain("payload-suggestion");
  });

  it("keeps an ordinary denial free of any review suggestion", () => {
    const result = runtimeToolAuthorizationResult({
      decision: "DENY",
      reasonCode: "policy_denied",
      alternativesAllowed: false,
    });
    expect(result).toMatchObject({ outcome: "failed", errorCode: "policy_denied" });
    expect(result.modelContent).toBe("操作未执行：policy_denied");
  });
});
