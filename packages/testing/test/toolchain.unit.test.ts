import { describe, expect, it } from "vitest";

describe("toolchain baseline", () => {
  it("runs on the accepted Node.js floor or newer", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);

    expect(major).toBeGreaterThanOrEqual(22);
    if (major === 22) expect(minor).toBeGreaterThanOrEqual(19);
  });
});
