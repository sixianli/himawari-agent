import { describe, expect, it, vi } from "vitest";
import { injectProgramSecrets } from "../src/program-secret-injection.js";

const granted = [{ secretRef: "deepseek-web", secretVersion: "v1" }];
const stored = (value: unknown) => Buffer.from(JSON.stringify(value));
const decoded = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8"));

describe("program secret injection", () => {
  it("replaces granted secret names with values resolved from the host source", async () => {
    const resolve = vi.fn(async () => "fixture-value");
    const result = await injectProgramSecrets({
      stored: stored({
        query: "q",
        providers: ["deepseek"],
        secretRefs: { deepseek: "deepseek-web" },
      }),
      granted,
      networkOnly: true,
      secrets: { resolve },
    });
    expect(resolve).toHaveBeenCalledWith("deepseek-web", "v1");
    expect(decoded(result)).toEqual({
      query: "q",
      providers: ["deepseek"],
      secrets: { deepseek: "fixture-value" },
    });
  });

  it.each([
    {
      label: "no secret source",
      networkOnly: true,
      secrets: undefined,
      input: { secretRefs: { deepseek: "deepseek-web" } },
    },
    {
      label: "a filesystem program",
      networkOnly: false,
      input: { secretRefs: { deepseek: "deepseek-web" } },
    },
    {
      label: "a value already present",
      networkOnly: true,
      input: { secretRefs: { deepseek: "deepseek-web" }, secrets: { deepseek: "x" } },
    },
    {
      label: "an ungranted reference",
      networkOnly: true,
      input: { secretRefs: { deepseek: "other" } },
    },
    { label: "a granted reference left unnamed", networkOnly: true, input: { secretRefs: {} } },
    { label: "no name map", networkOnly: true, input: { query: "q" } },
    {
      label: "an unsafe name",
      networkOnly: true,
      input: { secretRefs: { "Deep Seek": "deepseek-web" } },
    },
  ])("refuses $label", async ({ networkOnly, input, ...rest }) => {
    const resolve = vi.fn(async () => "fixture-value");
    await expect(
      injectProgramSecrets({
        stored: stored(input),
        granted,
        networkOnly,
        ...("secrets" in rest ? {} : { secrets: { resolve } }),
      }),
    ).rejects.toThrow(/SANDBOX_SECRET_/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves a missing host secret out so the program falls back to the next provider", async () => {
    const result = await injectProgramSecrets({
      stored: stored({ secretRefs: { deepseek: "deepseek-web" } }),
      granted,
      networkOnly: true,
      secrets: {
        resolve: async () => {
          throw new Error("/var/lib/himawari/secrets/deepseek-web.v1 missing");
        },
      },
    });
    expect(decoded(result)).toEqual({ secrets: {} });
  });
});
