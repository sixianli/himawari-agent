import { describe, expect, it } from "vitest";

import { integrationGithubWorkspace } from "../src/index.ts";

describe("integration-github workspace boundary", () => {
  it("exports a product-owned integration descriptor", () => {
    expect(integrationGithubWorkspace).toEqual({
      adapterKind: "external-event",
      provider: "github-app",
    });
  });
});
