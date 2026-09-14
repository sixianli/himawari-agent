import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

import { NodePublicHostResolver } from "../src/public-web-transport.ts";

beforeEach(() => {
  lookup.mockReset();
});
describe("public host resolution", () => {
  it.each([
    ["93.184.216.34", "93.184.216.34"],
    ["[2606:4700:4700::1111]", "2606:4700:4700::1111"],
  ])("preserves literal %s without another DNS request", async (hostname, expected) => {
    expect(await new NodePublicHostResolver().resolve(hostname)).toEqual([expected]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("returns every DNS address so the adapter can reject mixed public/private answers", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await new NodePublicHostResolver().resolve("public.example")).toEqual([
      "93.184.216.34",
      "127.0.0.1",
    ]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("public.example", { all: true, verbatim: true });
  });
  it("propagates DNS failure instead of inventing a fallback destination", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(new NodePublicHostResolver().resolve("missing.invalid")).rejects.toThrow(
      "ENOTFOUND",
    );
  });
});
