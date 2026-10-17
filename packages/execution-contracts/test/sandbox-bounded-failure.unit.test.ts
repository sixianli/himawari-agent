import { describe, expect, it } from "vitest";
import {
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  sandboxFileOperationFailureReason,
} from "../src/pi-runner-v1.ts";
import {
  FILE_WRITE_NOT_STARTED,
  isSandboxBoundedToolFailure,
  isSandboxToolResultLost,
  SANDBOX_WRITE_EFFECT_UNVERIFIED,
  type SandboxOperationContract,
} from "../src/sandbox-execution-v2.ts";

const failure = (reasonCode: string) =>
  ({ kind: "error", reasonCode, termination: { type: "failure" } }) as never;

describe("isSandboxBoundedToolFailure", () => {
  it("accepts only the authenticated bounded failures", () => {
    expect(isSandboxBoundedToolFailure(failure("SANDBOX_TOOL_RESULT_LOST"))).toBe(true);
    expect(isSandboxBoundedToolFailure(failure("SANDBOX_TOOL_DEADLINE_EXCEEDED"))).toBe(true);
    expect(isSandboxBoundedToolFailure(failure("SANDBOX_TOOL_NOT_STARTED"))).toBe(true);
    expect(isSandboxToolResultLost(failure("SANDBOX_TOOL_RESULT_LOST"))).toBe(true);
  });

  it("rejects every outcome that still needs external reconciliation", () => {
    expect(isSandboxBoundedToolFailure(undefined)).toBe(false);
    expect(isSandboxBoundedToolFailure(null)).toBe(false);
    expect(
      isSandboxBoundedToolFailure({ kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" } as never),
    ).toBe(false);
    expect(isSandboxBoundedToolFailure({ kind: "started" } as never)).toBe(false);
    expect(isSandboxBoundedToolFailure({ kind: "result" } as never)).toBe(false);
    expect(
      isSandboxBoundedToolFailure({
        kind: "error",
        reasonCode: "SANDBOX_OPERATION_FAILED",
        termination: { type: "failure" },
      } as never),
    ).toBe(false);
    expect(
      isSandboxBoundedToolFailure({
        kind: "error",
        reasonCode: "SANDBOX_TOOL_NOT_STARTED",
        termination: { type: "exit", exitCode: 1 },
      } as never),
    ).toBe(false);
  });

  it("[R2-T12] treats a contradicted host completion as a bounded failure", () => {
    expect(isSandboxBoundedToolFailure(failure("SANDBOX_HOST_COMPLETION_CONTRADICTED"))).toBe(true);
  });

  it("[R2-T12] rejects a contradicted completion whose termination is not a failure", () => {
    expect(
      isSandboxBoundedToolFailure({
        kind: "error",
        reasonCode: "SANDBOX_HOST_COMPLETION_CONTRADICTED",
        termination: { type: "exit", exitCode: 1 },
      } as never),
    ).toBe(false);
  });
});

describe("sandboxFileOperationFailureReason", () => {
  const plan = (operation: string, contract: Partial<SandboxOperationContract> = {}) =>
    ({
      operation,
      operationContract: {
        ...PI_RUNNER_CONTRACT,
        kind: "verified_effect",
        verifierRef: PI_WRITE_VERIFIER.ref,
        verifierVersion: PI_WRITE_VERIFIER.version,
        targetRef: PI_WRITE_VERIFIER.targetRef,
        ...contract,
      },
    }) as never;

  it("[R2-T14] names a verified pre-commit write failure and keeps it outside bounded failures", () => {
    expect(sandboxFileOperationFailureReason(plan("edit"), "not_written")).toBe(
      FILE_WRITE_NOT_STARTED,
    );
    expect(isSandboxBoundedToolFailure(failure(FILE_WRITE_NOT_STARTED))).toBe(false);
  });

  it("[R2-T14] bounds a Pi write or edit failure whose effect could not be verified", () => {
    expect(sandboxFileOperationFailureReason(plan("write"), null)).toBe(
      SANDBOX_WRITE_EFFECT_UNVERIFIED,
    );
    expect(sandboxFileOperationFailureReason(plan("edit"), null)).toBe(
      SANDBOX_WRITE_EFFECT_UNVERIFIED,
    );
    expect(isSandboxBoundedToolFailure(failure(SANDBOX_WRITE_EFFECT_UNVERIFIED))).toBe(true);
    expect(
      isSandboxBoundedToolFailure({
        kind: "error",
        reasonCode: SANDBOX_WRITE_EFFECT_UNVERIFIED,
        termination: { type: "exit", exitCode: 1 },
      } as never),
    ).toBe(false);
  });

  it("[R2-T14] keeps conflicts and other verified operations on their existing reasons", () => {
    expect(sandboxFileOperationFailureReason(plan("write"), "conflict")).toBe(
      "FILE_VERSION_CONFLICT",
    );
    expect(
      sandboxFileOperationFailureReason(plan("save_copy", { verifierRef: "copy-save" }), null),
    ).toBe("SANDBOX_OPERATION_FAILED");
    expect(sandboxFileOperationFailureReason(plan("move"), null)).toBe("SANDBOX_OPERATION_FAILED");
  });
});
