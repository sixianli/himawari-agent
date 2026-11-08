import { describe, expect, it } from "vitest";
import { SANDBOX_TOOL_MEMORY_LIMIT_BYTES } from "../src/index.ts";

describe("sandbox tool memory limit", () => {
  it("is 1 GiB, four times the 256 MiB that PDF conversion baselines already touched", () => {
    expect(SANDBOX_TOOL_MEMORY_LIMIT_BYTES).toBe(1_073_741_824);
    expect(SANDBOX_TOOL_MEMORY_LIMIT_BYTES / (256 * 1024 * 1024)).toBe(4);
  });

  it("is a safe integer that still fits the 3 concurrent sandboxes on the 8 GB production host", () => {
    expect(Number.isSafeInteger(SANDBOX_TOOL_MEMORY_LIMIT_BYTES)).toBe(true);
    expect(3 * SANDBOX_TOOL_MEMORY_LIMIT_BYTES).toBeLessThan(4 * 1024 * 1024 * 1024);
  });
});
