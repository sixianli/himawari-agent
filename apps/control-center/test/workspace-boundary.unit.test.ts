import { describe, expect, it } from "vitest";

import { controlCenterWorkspace } from "../src/index.ts";

describe("control-center workspace boundary", () => {
  it("is explicitly browser-only", () => {
    expect(controlCenterWorkspace).toEqual({
      applicationKind: "browser-control-center",
      browserOnly: true,
    });
  });
});
