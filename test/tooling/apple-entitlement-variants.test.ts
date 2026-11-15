import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../clients/apple/App");
const project = readFileSync(path.join(app, "Himawari.xcodeproj/project.pbxproj"), "utf8");
const lines = [...project.matchAll(/CODE_SIGN_ENTITLEMENTS = "([^"]+)";/gu)].flatMap(
  (m) => m[1] ?? [],
);
const templates = [...new Set(lines)];

const resolve = (template: string, suffix: string) =>
  template.replace("$(HIMAWARI_ENTITLEMENTS_SUFFIX)", suffix);

it("takes every signed configuration's entitlements file from the signing variant setting", () => {
  expect(templates.length).toBeGreaterThanOrEqual(3);
  expect(lines.length).toBe(templates.length * 2);
  for (const line of lines) {
    expect(line).toContain("$(HIMAWARI_ENTITLEMENTS_SUFFIX)");
  }
});

it("has an entitlements file for both signing variants, the keychain-only one without App Groups", () => {
  for (const template of templates) {
    expect(existsSync(path.join(app, resolve(template, "")))).toBe(true);
    expect(existsSync(path.join(app, resolve(template, ".keychain-only")))).toBe(true);
    const full = readFileSync(path.join(app, resolve(template, "")), "utf8");
    const keychainOnly = readFileSync(path.join(app, resolve(template, ".keychain-only")), "utf8");
    expect(full).toContain("com.apple.security.application-groups");
    expect(keychainOnly).not.toContain("application-groups");
    if (!/^(Watch|WatchWidgets)\//u.test(template)) {
      expect(full).toContain("keychain-access-groups");
      expect(keychainOnly).toContain("keychain-access-groups");
    }
  }
});

it("defaults the signing variant to the full App Group build in every project-level configuration", () => {
  const defaults = [...project.matchAll(/HIMAWARI_ENTITLEMENTS_SUFFIX = ([^;]*);/gu)].map(
    (m) => m[1],
  );
  expect(defaults.length).toBe(2);
  expect(new Set(defaults)).toEqual(new Set(['""']));
});

it("leaves HIMAWARI_APP_GROUP only at project level so clearing it reaches every target", () => {
  const all = [...project.matchAll(/HIMAWARI_APP_GROUP = ([^;]*);/gu)];
  expect(all.length).toBe(2);
});
