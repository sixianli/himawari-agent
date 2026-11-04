import path from "node:path";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";
import {
  buildProductPathConfiguration,
  type ProductPathConfigurationInput,
} from "../fixtures/product-path-configuration.ts";

const root = path.join("/tmp", "himawari-product-path-configuration");
const input = (
  extra: Partial<ProductPathConfigurationInput> = {},
): ProductPathConfigurationInput => ({
  deploymentId: "deployment-product-path",
  ownerId: "owner-product-path",
  agentId: "agent-product-path",
  stateRoot: path.join(root, "state"),
  runtimeDirectory: path.join(root, "state", "runtime"),
  publicOrigin: "https://himawari.example.test",
  staticRoot: path.join(root, "browser"),
  issuer: "https://127.0.0.1:9443",
  hostId: "host-product-path",
  workerInstanceId: "worker-product-path",
  grantId: "grant-product-path",
  capabilityDeployment: undefined,
  ...extra,
});

const LOADED_AT = "2026-11-02T00:00:00.000Z";

describe("[I-74] the product path test configuration is one the product accepts", () => {
  it.each([
    ["the default installation", {}],
    ["ask-before-running approval", { approval: "ask" as const }],
    ["web search enabled", { webSearch: true }],
    [
      "selectable models from a Magpie list",
      { modelCatalogUrl: "http://127.0.0.1:3425/v1", approval: "ask" as const, webSearch: true },
    ],
  ])("parses for %s", (_name, extra) => {
    const parsed = parseProductConfiguration(
      buildProductPathConfiguration(input(extra)),
      LOADED_AT,
    );
    expect(parsed.modelDescriptors.filter(({ role }) => role === "primary")).toHaveLength(1);
  });

  it("makes the selectable-models installation a Magpie primary, the way production lists models", () => {
    const parsed = parseProductConfiguration(
      buildProductPathConfiguration(input({ modelCatalogUrl: "http://127.0.0.1:3425/v1" })),
      LOADED_AT,
    );
    expect(parsed.modelDescriptors[0]).toMatchObject({
      provider: "magpie",
      baseUrl: "http://127.0.0.1:3425/v1",
    });
  });

  it("would have refused the earlier shape that listed the extra models in the file", () => {
    const configuration = buildProductPathConfiguration(input());
    const [primary, ...rest] = configuration.modelDescriptors;
    const broken = {
      ...configuration,
      modelDescriptors: [
        primary,
        { ...primary, ref: "magpie:opencode-go/acceptance-alpha", priority: 2 },
        ...rest,
      ],
    };
    expect(() => parseProductConfiguration(broken, LOADED_AT)).toThrow();
  });
});
