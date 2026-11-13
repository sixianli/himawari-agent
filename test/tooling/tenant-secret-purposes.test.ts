import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TENANT_SECRET_PURPOSE_CLASSES } from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const PURPOSE_PATTERNS = [
  /_SECRET_PURPOSE\s*=\s*"([a-z][a-z0-9-]*)"/g,
  /secretReferences[\s\S]{0,160}?purpose\s*===\s*"([a-z][a-z0-9-]*)"/g,
  /(?:requiredSecret|soleSecret)\(\s*[A-Za-z_.]+,\s*"([a-z][a-z0-9-]*)"/g,
  /assertIdentitySecretReference\(\s*secretReferences,\s*[^,]+,\s*"([a-z][a-z0-9-]*)"/g,
];

function secretPurposesIn(source: string): readonly string[] {
  return [
    ...new Set(
      PURPOSE_PATTERNS.flatMap((pattern) =>
        [...source.matchAll(pattern)].map((m) => m[1] as string),
      ),
    ),
  ].sort();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(target);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [target] : [];
    }),
  );
  return nested.flat();
}

describe("every secret purpose the product reads is classified as per-tenant or shared", () => {
  it("finds the purposes in product source and each one has a class", async () => {
    const roots = ["apps", "packages"].map((name) => path.join(repositoryRoot, name));
    const files = (await Promise.all(roots.map(sourceFiles)))
      .flat()
      .filter((file) => file.includes(`${path.sep}src${path.sep}`));
    const found = new Set<string>();
    for (const file of files)
      for (const purpose of secretPurposesIn(await readFile(file, "utf8"))) found.add(purpose);
    expect([...found]).toEqual(
      expect.arrayContaining(["payload-encryption", "identity-csrf", "web-push", "gap-export"]),
    );
    expect([...found].filter((purpose) => !(purpose in TENANT_SECRET_PURPOSE_CLASSES))).toEqual([]);
  });

  it("flags a newly read purpose that nobody classified", () => {
    const source = `const key = configuration.secretReferences.find(\n  ({ purpose }) => purpose === "calendar-token",\n);`;
    expect(
      secretPurposesIn(source).filter((purpose) => !(purpose in TENANT_SECRET_PURPOSE_CLASSES)),
    ).toEqual(["calendar-token"]);
  });
});
