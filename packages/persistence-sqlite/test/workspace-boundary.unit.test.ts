import { describe, expect, it } from "vitest";

import { persistenceSqliteWorkspace } from "../src/index.ts";

describe("persistence-sqlite workspace boundary", () => {
  it("exports only a product-owned adapter descriptor before implementation", () => {
    expect(persistenceSqliteWorkspace).toEqual({
      adapterKind: "persistence",
      authority: "sqlite",
    });
  });
});
