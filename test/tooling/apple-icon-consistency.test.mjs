import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const design = new URL("../../clients/apple/Sources/HimawariDesign/", import.meta.url);

function configNames() {
  const icons = JSON.parse(
    readFileSync(new URL("../../clients/apple/scripts/icons.json", import.meta.url), "utf8"),
  );
  return Object.keys(icons).map((key) => {
    const [source, variant] = key.split("@");
    return variant ? `${source}-${variant}` : source;
  });
}

function swiftNames() {
  const source = readFileSync(new URL("Icon.swift", design), "utf8");
  const body = source.slice(source.indexOf("enum IconName"), source.indexOf("public struct Icon"));
  return [...body.matchAll(/^\s*case\s+(\w+)(?:\s*=\s*"([^"]+)")?\s*$/gmu)].map(
    (match) => match[2] ?? match[1],
  );
}

function catalogNames() {
  return readdirSync(new URL("Resources/Icons.xcassets/", design))
    .filter((entry) => entry.endsWith(".imageset"))
    .map((entry) => entry.slice(0, -".imageset".length));
}

it("lists every icon in icons.json, Icon.swift and the asset catalog", () => {
  const config = configNames().sort();
  const swift = swiftNames().sort();
  const catalog = catalogNames().sort();
  expect(new Set(config).size).toBe(config.length);
  expect(config.length).toBeGreaterThan(50);
  expect(swift).toEqual(config);
  expect(catalog).toEqual(config);
});
