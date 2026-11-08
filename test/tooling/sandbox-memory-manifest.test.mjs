import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SANDBOX_TOOL_MEMORY_LIMIT_BYTES } from "../../packages/execution-contracts/src/sandbox-memory-limit.ts";

const SEAL = new URL(
  "../../scripts/delivery-mode/packet-template/signing/cloud-seal.mjs",
  import.meta.url,
);

function signedMemoryCeiling(source) {
  const block = /maximumResourceCeiling:\s*\{[^}]*\}/s.exec(source);
  if (!block) return undefined;
  const value = /maxMemoryBytes:\s*(\d+)/.exec(block[0]);
  return value ? Number(value[1]) : undefined;
}

describe("signed sandbox binding memory ceiling", () => {
  it("is at least the tool memory limit, because the effective limit is the smaller of the two", () => {
    expect(signedMemoryCeiling(readFileSync(SEAL, "utf8"))).toBeGreaterThanOrEqual(
      SANDBOX_TOOL_MEMORY_LIMIT_BYTES,
    );
  });

  it("helper reads a stale manifest as below the limit", () => {
    const stale = (bytes) =>
      `maximumResourceCeiling: {\n maxWallTimeMs: 1,\n maxMemoryBytes: ${bytes},\n}`;
    expect(signedMemoryCeiling(stale(536870912))).toBeLessThan(SANDBOX_TOOL_MEMORY_LIMIT_BYTES);
    expect(signedMemoryCeiling(stale(268435456))).toBeLessThan(SANDBOX_TOOL_MEMORY_LIMIT_BYTES);
  });

  it("finds no ceiling in a manifest without one", () => {
    expect(signedMemoryCeiling("const x = 1;")).toBeUndefined();
  });
});
