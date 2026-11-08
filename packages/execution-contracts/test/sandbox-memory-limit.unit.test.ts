import { describe, expect, it } from "vitest";
import { SANDBOX_TOOL_MEMORY_LIMIT_BYTES } from "../src/index.ts";

describe("sandbox tool memory limit", () => {
  it("is 1 GiB", () => {
    expect(SANDBOX_TOOL_MEMORY_LIMIT_BYTES).toBe(1_073_741_824);
  });

  it("is a safe integer", () => {
    expect(Number.isSafeInteger(SANDBOX_TOOL_MEMORY_LIMIT_BYTES)).toBe(true);
  });
});
