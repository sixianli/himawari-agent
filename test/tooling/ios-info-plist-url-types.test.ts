import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plist = readFileSync(
  new URL("../../clients/apple/App/iOS/Info.plist", import.meta.url),
  "utf8",
);

describe("the iOS Info.plist registers the app link scheme and the server origin", () => {
  it("has exactly one CFBundleURLTypes key", () => {
    expect(plist.match(/<key>CFBundleURLTypes<\/key>/g)?.length).toBe(1);
  });

  it("registers himawari and no longer the pairing link", () => {
    expect(plist).toContain("<string>himawari</string>");
    expect(plist).not.toContain("<string>himawari-pair</string>");
  });

  it("reads the server origin from the build setting", () => {
    expect(plist).toMatch(
      /<key>HimawariServerOrigin<\/key>\s*<string>\$\(HIMAWARI_SERVER_ORIGIN\)<\/string>/,
    );
  });
});
