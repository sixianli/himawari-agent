import { SANDBOX_RUNTIME_WORKSPACE_MOUNT_PATHS } from "@himawari-agent/execution-contracts";
import {
  DANGEROUS_FILES,
  getDangerousDirectories,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { describe, expect, it } from "vitest";

describe("sandbox runtime workspace mount paths", () => {
  it("matches the paths the pinned sandbox runtime protects in the workspace", () => {
    expect(SANDBOX_RUNTIME_WORKSPACE_MOUNT_PATHS).toEqual([
      ...DANGEROUS_FILES,
      ...getDangerousDirectories(),
    ]);
  });
});
