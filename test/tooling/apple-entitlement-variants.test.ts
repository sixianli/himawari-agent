import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const app = path.resolve(__dirname, "../../clients/apple/App");
const project = readFileSync(path.join(app, "Himawari.xcodeproj/project.pbxproj"), "utf8");
const paths = [
  ...new Set(
    [...project.matchAll(/CODE_SIGN_ENTITLEMENTS = "([^"]+)";/gu)].flatMap((m) => m[1] ?? []),
  ),
];

const resolve = (template: string, suffix: string) =>
  template.replace("$(HIMAWARI_ENTITLEMENTS_SUFFIX)", suffix);

it("builds every signed target from entitlements files that exist for both signing variants", () => {
  expect(paths.length).toBe(3);
  for (const template of paths) {
    expect(template).toContain("$(HIMAWARI_ENTITLEMENTS_SUFFIX)");
    const full = readFileSync(path.join(app, resolve(template, "")), "utf8");
    const keychainOnly = readFileSync(path.join(app, resolve(template, ".keychain-only")), "utf8");
    expect(full).toContain("com.apple.security.application-groups");
    expect(full).toContain("keychain-access-groups");
    expect(keychainOnly).not.toContain("application-groups");
    expect(keychainOnly).toContain("keychain-access-groups");
  }
});

it("defaults the signing variant to the full App Group build", () => {
  const defaults = [...project.matchAll(/HIMAWARI_ENTITLEMENTS_SUFFIX = ([^;]*);/gu)].map(
    (m) => m[1],
  );
  expect(defaults.length).toBe(2);
  expect(new Set(defaults)).toEqual(new Set(['""']));
});
