import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.join(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8");
const HARNESS = "test/fixtures/product-path-harness.ts";
const PRODUCTION_SEAL = "scripts/delivery-mode/packet-template/signing/cloud-seal.mjs";

function slice(source, file, start, end, from = 0) {
  const at = source.indexOf(start, from);
  const to = source.indexOf(end, at + start.length);
  if (at < 0 || to < 0) throw new Error(`WALKTHROUGH_PERMISSION_SOURCE_MOVED ${file} ${start}`);
  return source
    .slice(at + start.length, to)
    .trim()
    .replace(/,$/, "");
}

function harnessOperations() {
  const source = read(HARNESS);
  const tools = JSON.parse(
    slice(source, HARNESS, "const codingTools =", "as const;").replaceAll(/\s+/g, ""),
  );
  const expression = slice(
    source,
    HARNESS,
    "directoryOperations:",
    "network:",
    source.indexOf('runnerFile: "pi-coding-main.js"'),
  );
  const directoryOperations = new Function("operation", `return ${expression};`);
  return Object.fromEntries(tools.map((tool) => [tool, directoryOperations(tool)]));
}

function productionOperations() {
  const source = read(PRODUCTION_SEAL);
  const tools = JSON.parse(
    slice(source, PRODUCTION_SEAL, '"pi-coding-main.js",', "],", source.indexOf('"pi",')) + "]",
  );
  const expression = slice(source, PRODUCTION_SEAL, "directoryOperations:", "network:");
  const directoryOperations = new Function("key", "operation", `return ${expression};`);
  const receipt = JSON.parse(
    slice(source, PRODUCTION_SEAL, "bashDirectoryOperations:", "],") + "]",
  );
  return {
    operations: Object.fromEntries(tools.map((tool) => [tool, directoryOperations("pi", tool)])),
    receipt,
  };
}

describe("release walkthrough command permissions", () => {
  it("grants the walkthrough installation the same directory operations production seals for each coding tool", () => {
    const harness = harnessOperations();
    const production = productionOperations();
    expect(Object.keys(harness).sort()).toEqual(Object.keys(production.operations).sort());
    expect(harness).toEqual(production.operations);
    expect(production.receipt).toEqual(production.operations["bash"]);
  });
});
