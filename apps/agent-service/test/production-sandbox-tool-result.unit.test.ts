import type {
  SandboxEffectObservation,
  SandboxOperationContract,
  SandboxOperationResult,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { sandboxCommandEffectReason } from "../src/production-sandbox-tool-result.js";

const identity = {
  jobId: "job",
  attemptId: "attempt",
  invocationId: "invocation",
  receiptRef: "receipt",
  hostId: "host",
  ownerId: "owner",
  agentId: "agent",
  threadId: null,
  runId: "run",
  toolCallId: "call",
};

function commandResult(exitCode: number): SandboxOperationResult {
  return {
    schemaVersion: "sandbox-execution.v2",
    identity,
    environmentId: "environment",
    policyDigest: "d".repeat(64),
    contract: { ref: "shell", version: "1" },
    occurredAt: "2026-09-23T00:00:00.000Z",
    kind: "error",
    output: { ref: "output", digest: "f".repeat(64), byteLength: 0 },
    reasonCode: "exit_failed",
    termination: { type: "exit", exitCode },
  };
}

describe("sandbox command effect reason", () => {
  const operationKind: SandboxOperationContract["kind"] = "command";
  const effectKind: SandboxEffectObservation["kind"] = "not_asserted";

  it("keeps nonzero command failure separate from unverified workspace effects", () => {
    expect(
      sandboxCommandEffectReason({
        operationKind,
        result: commandResult(7),
        effectKind,
      }),
    ).toBe("SANDBOX_COMMAND_EFFECT_UNVERIFIED");
  });

  it("does not classify a successful exit or a different operation as a failed command", () => {
    expect(
      sandboxCommandEffectReason({
        operationKind,
        result: commandResult(0),
        effectKind,
      }),
    ).toBeNull();
    expect(
      sandboxCommandEffectReason({
        operationKind: "fixed_read",
        result: commandResult(7),
        effectKind,
      }),
    ).toBeNull();
  });

  it("does not replace stronger effect evidence", () => {
    expect(
      sandboxCommandEffectReason({
        operationKind,
        result: commandResult(7),
        effectKind: "verified",
      }),
    ).toBeNull();
    expect(
      sandboxCommandEffectReason({
        operationKind,
        result: commandResult(7),
        effectKind: "unknown",
      }),
    ).toBeNull();
  });
});
