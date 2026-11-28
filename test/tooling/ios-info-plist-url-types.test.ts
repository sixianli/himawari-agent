import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plist = readFileSync(
  new URL("../../clients/apple/App/iOS/Info.plist", import.meta.url),
  "utf8",
);

describe("the iOS Info.plist registers every link scheme the app opens and the server origin", () => {
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

  it("registers otpauth so a site's two-step link opens the vault form", () => {
    expect(plist).toContain("<string>otpauth</string>");
  });
});
