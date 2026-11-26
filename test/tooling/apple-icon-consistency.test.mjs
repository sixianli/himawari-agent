import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const apple = fileURLToPath(new URL("../../clients/apple/", import.meta.url));
const design = path.join(apple, "Sources/HimawariDesign");

function iconSource() {
  return readFileSync(path.join(design, "Icon.swift"), "utf8");
}

function swiftFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return swiftFiles(full);
    return entry.endsWith(".swift") ? [full] : [];
  });
}

it("draws every icon with an SF Symbol and ships no icon images of its own", () => {
  const source = iconSource();
  const enumBody = source.slice(
    source.indexOf("enum IconName"),
    source.indexOf("public var weight"),
  );
  const cases = [...enumBody.matchAll(/^\s*case\s+(\w+)/gmu)].map((match) => match[1]);
  const mapped = [...source.matchAll(/^\s*case \.(\w+): "([a-z0-9.]+)"$/gmu)].map((m) => m[1]);
  expect(cases.length).toBeGreaterThan(50);
  expect(mapped.sort()).toEqual([...cases].sort());
  expect(source).toContain("Image(systemName:");
  expect(source).not.toMatch(/Image\(\s*name\.rawValue/u);
  expect(existsSync(path.join(design, "Resources/Icons.xcassets"))).toBe(false);
});

it("leaves no Tabler icons, scripts or licence behind in the Apple clients", () => {
  expect(
    readdirSync(path.join(design, "Resources/Licenses")).filter((f) => /tabler/iu.test(f)),
  ).toEqual([]);
  expect(existsSync(path.join(apple, "scripts/icons.json"))).toBe(false);
  expect(existsSync(path.join(apple, "scripts/make-icons.mjs"))).toBe(false);
  const mentions = swiftFiles(path.join(apple, "Sources")).filter((file) =>
    /tabler|Icons\.xcassets/iu.test(readFileSync(file, "utf8")),
  );
  expect(mentions).toEqual([]);
});
