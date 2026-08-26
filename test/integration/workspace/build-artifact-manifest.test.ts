import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function generateManifest(name: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-artifact-manifest-"));
  temporaryDirectories.push(directory);
  const output = path.join(directory, `${name}.json`);
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-artifact-manifest.mjs", "--output", output],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(output, "utf8"));
}

describe("build artifact manifest", () => {
  it("records deterministic package and lock checksums", async () => {
    const first = await generateManifest("first");
    const second = await generateManifest("second");

    expect(first.schemaVersion).toBe(1);
    expect(first.packages).toHaveLength(14);
    expect(first.packages).toEqual(second.packages);
    expect(first.inputs).toEqual(second.inputs);
    expect(first.packages.every((entry: { files: number }) => entry.files > 0)).toBe(true);
    expect(first.packages.every((entry: { sha256: string }) => entry.sha256.length === 64)).toBe(
      true,
    );
  });
});
