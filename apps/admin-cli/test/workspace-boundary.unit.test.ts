import { describe, expect, it } from "vitest";

import { adminCliWorkspace } from "../src/index.ts";

describe("admin-cli workspace boundary", () => {
  it("starts as an offline-only application boundary", () => {
    expect(adminCliWorkspace).toEqual({
      applicationKind: "offline-admin",
      networkListener: false,
    });
  });
});
