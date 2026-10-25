import { describe, expect, it } from "vitest";

import { memoryMem0Workspace } from "../src/index.ts";

describe("memory-mem0 workspace boundary", () => {
  it("[R2-L5] does not expose Mem0 SDK types through its public surface", () => {
    expect(memoryMem0Workspace).toEqual({
      adapterKind: "memory-projection",
      provider: "mem0ai/oss@3.3.1",
      requiresExplicitProviders: true,
    });
  });
});
