import { describe, expect, it } from "vitest";
import {
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  sandboxFileOperationFailureReason,
} from "../src/pi-runner-v1.ts";
import {
  FILE_WRITE_NOT_STARTED,
  isSandboxBoundedToolFailure,
  isSandboxCeilingExceededReason,
  isSandboxOutputLimitReason,
  isSandboxToolResultLost,
  SANDBOX_CPU_TIME_LIMIT,
  SANDBOX_MEMORY_LIMIT,
  SANDBOX_OUTPUT_LIMIT,
  SANDBOX_RESOURCE_LIMIT,
  SANDBOX_WRITE_EFFECT_UNVERIFIED,
  type SandboxOperationContract,
  sandboxResourceLimitReason,
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

  it("[I-84] treats an output limit as a bounded failure the model can be told about", () => {
    expect(isSandboxBoundedToolFailure(failure(SANDBOX_OUTPUT_LIMIT))).toBe(true);
    expect(isSandboxOutputLimitReason(SANDBOX_OUTPUT_LIMIT)).toBe(true);
    expect(isSandboxCeilingExceededReason(SANDBOX_OUTPUT_LIMIT)).toBe(true);
    expect(isSandboxCeilingExceededReason(SANDBOX_MEMORY_LIMIT)).toBe(true);
    expect(isSandboxOutputLimitReason(SANDBOX_MEMORY_LIMIT)).toBe(false);
    expect(isSandboxCeilingExceededReason("SANDBOX_OPERATION_FAILED")).toBe(false);
  });

  it("[I-84] rejects an output limit whose termination is not a failure", () => {
    expect(
      isSandboxBoundedToolFailure({
        kind: "error",
        reasonCode: SANDBOX_OUTPUT_LIMIT,
        termination: { type: "exit", exitCode: 1 },
      } as never),
    ).toBe(false);
    expect(
      isSandboxBoundedToolFailure({ kind: "unknown", reasonCode: SANDBOX_OUTPUT_LIMIT } as never),
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

describe("sandboxResourceLimitReason", () => {
  const ceiling = { maxCpuTimeMs: 1000, maxMemoryBytes: 2000 };

  it("[I-84] names the limit the command crossed", () => {
    expect(
      sandboxResourceLimitReason(ceiling, { observedCpuTimeMs: 1001, peakObservedMemoryBytes: 10 }),
    ).toBe(SANDBOX_CPU_TIME_LIMIT);
    expect(
      sandboxResourceLimitReason(ceiling, { observedCpuTimeMs: 10, peakObservedMemoryBytes: 2001 }),
    ).toBe(SANDBOX_MEMORY_LIMIT);
  });

  it("[I-84] falls back to the unnamed limit when the observation is missing or within both limits", () => {
    expect(sandboxResourceLimitReason(ceiling, null)).toBe(SANDBOX_RESOURCE_LIMIT);
    expect(
      sandboxResourceLimitReason(ceiling, {
        observedCpuTimeMs: 1000,
        peakObservedMemoryBytes: 2000,
      }),
    ).toBe(SANDBOX_RESOURCE_LIMIT);
  });

  it("[I-84] bounds every resource-limit failure so the turn does not wait for reconciliation", () => {
    for (const reasonCode of [SANDBOX_CPU_TIME_LIMIT, SANDBOX_MEMORY_LIMIT, SANDBOX_RESOURCE_LIMIT])
      expect(isSandboxBoundedToolFailure(failure(reasonCode))).toBe(true);
    expect(
      isSandboxBoundedToolFailure({
        kind: "error",
        reasonCode: SANDBOX_CPU_TIME_LIMIT,
        termination: { type: "exit", exitCode: 1 },
      } as never),
    ).toBe(false);
  });
});
