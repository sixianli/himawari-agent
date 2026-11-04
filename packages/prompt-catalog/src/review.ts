import { text } from "./entry.js";

const questions = {
  within_delegated_scope: {
    type: "choice",
    instructions:
      "Is this action covered by the Owner's delegation for exactly this frozen request? " +
      "Answer outside when the scope, recipient, budget or target is unclear.",
    criteria: {
      within: "The action is one the Owner already delegated for this exact request.",
      outside: "The action is not covered by the delegation, or the summary is insufficient.",
    },
  },
  decision: {
    type: "choice",
    instructions:
      "Should the host approve this exact request, deny it, or leave it for the human Owner?",
    criteria: {
      approve: "Safe to execute as frozen, with no widened scope.",
      deny: "Must not execute.",
      human: "Cannot be decided from the summary alone.",
    },
  },
  reason_code: {
    type: "choice",
    instructions: "Pick the single best reason for the decision.",
    criteria: {
      WITHIN_DELEGATION: "Delegated and safe to approve.",
      OUTSIDE_DELEGATION: "Not covered by the delegation.",
      HIGH_RISK: "Effect or risk is too high for automatic approval.",
      INSUFFICIENT_CONTEXT: "The frozen summary is not enough to decide.",
      POLICY_UNCERTAIN: "Policy or delegation state is ambiguous.",
    },
  },
};

export const REVIEW_TYPESAFE_QUESTIONS = Object.freeze({
  id: "review.typesafe-questions",
  purpose: "自动审批走 TypeSafe 路线时，发给审查模型的三组问题、指令和判断标准",
  usedBy: ["packages/platform-node/src/typesafe-jev-transport.ts"],
  layer: "background" as const,
  output: "structured-choice" as const,
  parser: "parseAutomaticReviewDecision",
  questions,
  segments: Object.freeze([text(JSON.stringify(questions, null, 2))]),
});
