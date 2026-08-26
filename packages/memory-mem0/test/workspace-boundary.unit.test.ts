import { describe, expect, it } from "vitest";

import { memoryMem0Workspace } from "../src/index.ts";

describe("memory-mem0 workspace boundary", () => {
  it("does not expose Mem0 SDK types through its public surface", () => {
    expect(memoryMem0Workspace).toEqual({
      adapterKind: "memory-projection",
      provider: "mem0ai/oss@3.1.7",
      requiresExplicitProviders: true,
    });
  });
});
