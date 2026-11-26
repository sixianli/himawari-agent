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

function tablerNames(source) {
  const block = source.slice(
    source.indexOf("static let tabler"),
    source.indexOf("public var drawnFromTabler"),
  );
  return [...block.matchAll(/\.(\w+)/gu)].map((match) => match[1]);
}

function rawName(source, caseName) {
  const explicit = source.match(new RegExp(`case ${caseName} = "([a-z0-9-]+)"`, "u"));
  return explicit
    ? explicit[1]
    : caseName.replace(/[A-Z0-9]/gu, (part) => `-${part.toLowerCase()}`);
}

it("names an SF Symbol for every icon and draws only the chosen ones from Tabler", () => {
  const source = iconSource();
  const enumBody = source.slice(
    source.indexOf("enum IconName"),
    source.indexOf("public static let tabler"),
  );
  const cases = [...enumBody.matchAll(/^\s*case\s+(\w+)/gmu)].map((match) => match[1]);
  const mapped = [...source.matchAll(/^\s*case \.(\w+): "([a-z0-9.]+)"$/gmu)].map((m) => m[1]);
  expect(cases.length).toBeGreaterThan(50);
  expect(mapped.sort()).toEqual([...cases].sort());
  const tabler = tablerNames(source);
  expect(tabler.length).toBeGreaterThan(0);
  for (const name of tabler) expect(cases).toContain(name);
  const catalog = path.join(design, "Resources/Icons.xcassets");
  const shipped = readdirSync(catalog)
    .filter((entry) => entry.endsWith(".imageset"))
    .map((entry) => entry.replace(/\.imageset$/u, ""))
    .sort();
  expect(shipped).toEqual(tabler.map((name) => rawName(source, name)).sort());
});

it("ships the Tabler licence and the generator list for exactly the icons it draws", () => {
  expect(existsSync(path.join(design, "Resources/Licenses/tabler-icons.txt"))).toBe(true);
  const listed = Object.keys(
    JSON.parse(readFileSync(path.join(apple, "scripts/icons.json"), "utf8")),
  ).map((key) => key.replace("@", "-"));
  const shipped = readdirSync(path.join(design, "Resources/Icons.xcassets"))
    .filter((entry) => entry.endsWith(".imageset"))
    .map((entry) => entry.replace(/\.imageset$/u, ""));
  expect(listed.sort()).toEqual(shipped.sort());
  const strays = swiftFiles(path.join(apple, "Sources")).filter(
    (file) =>
      /Image\(systemName:/u.test(readFileSync(file, "utf8")) &&
      !file.endsWith("Icon.swift") &&
      !file.endsWith("AnswerCode.swift"),
  );
  expect(strays).toEqual([]);
});
