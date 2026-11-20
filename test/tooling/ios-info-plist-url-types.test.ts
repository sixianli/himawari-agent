import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plist = readFileSync(
  new URL("../../clients/apple/App/iOS/Info.plist", import.meta.url),
  "utf8",
);

describe("the iOS Info.plist registers both link schemes", () => {
  it("has exactly one CFBundleURLTypes key", () => {
    expect(plist.match(/<key>CFBundleURLTypes<\/key>/g)?.length).toBe(1);
  });

  it("registers himawari and himawari-pair", () => {
    expect(plist).toContain("<string>himawari</string>");
    expect(plist).toContain("<string>himawari-pair</string>");
  });
});
