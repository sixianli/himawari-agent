import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const productBoundaryRoots = [
  "packages/domain/src",
  "packages/application/src",
  "packages/gateway-contracts/src",
  "packages/execution-contracts/src",
];

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}

describe("product-owned type boundary", () => {
  it("contains no driver, HTTP framework, JWT, Mem0 or GitHub SDK type", async () => {
    const files = (
      await Promise.all(productBoundaryRoots.map((root) => collectTypeScriptFiles(root)))
    ).flat();
    const source = (
      await Promise.all(files.map(async (file) => `${file}\n${await readFile(file, "utf8")}`))
    ).join("\n");

    for (const forbidden of [
      "better-sqlite3",
      "mem0ai",
      'from "fastify"',
      'from "jose"',
      "@octokit/",
      "JwtPayload",
      "FastifyRequest",
      "CloudflareJwtPayload",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
