import { describe, expect, it } from "vitest";
import {
  isSandboxBoundedToolFailure,
  isSandboxToolResultLost,
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
});
