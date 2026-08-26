import { describe, expect, it } from "vitest";

import { integrationGitHubWorkspace } from "../src/index.ts";

describe("integration-github workspace boundary", () => {
  it("exports a product-owned integration descriptor", () => {
    expect(integrationGitHubWorkspace).toEqual({
      adapterKind: "external-event",
      provider: "github-app",
    });
  });
});
