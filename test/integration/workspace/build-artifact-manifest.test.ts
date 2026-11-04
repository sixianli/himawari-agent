import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  const nodeRoot = path.join(directory, "runtime");
  const browserRoot = path.join(directory, "browser");
  await Promise.all([mkdir(nodeRoot), mkdir(browserRoot)]);
  await Promise.all([
    writeFile(path.join(nodeRoot, "runtime-manifest.json"), '{"schemaVersion":1}\n'),
    writeFile(path.join(nodeRoot, "entry.mjs"), 'console.log("isolated artifact");\n'),
    writeFile(path.join(browserRoot, "index.html"), "<!doctype html><title>fixture</title>\n"),
  ]);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/generate-artifact-manifest.mjs",
      "--output",
      output,
      "--node-root",
      nodeRoot,
      "--browser-root",
      browserRoot,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(output, "utf8"));
}

async function workspacePackageRoots() {
  const roots: string[] = [];
  for (const parent of ["apps", "packages"])
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = `${parent}/${entry.name}`;
      if (
        await access(path.join(root, "package.json")).then(
          () => true,
          () => false,
        )
      )
        roots.push(root);
    }
  return roots.sort();
}

describe("build artifact manifest", () => {
  it("records deterministic package and lock checksums", async () => {
    const first = await generateManifest("first");
    const second = await generateManifest("second");

    expect(first.schemaVersion).toBe(1);
    expect(first.packages.map((entry: { root: string }) => entry.root).sort()).toEqual(
      await workspacePackageRoots(),
    );
    expect(first.packages).toEqual(second.packages);
    expect(first.inputs).toEqual(second.inputs);
    expect(first.nodeArtifacts).toEqual(second.nodeArtifacts);
    expect(first.nodeArtifacts.map((entry: { path: string }) => entry.path)).toEqual([
      "entry.mjs",
      "runtime-manifest.json",
    ]);
    expect(first.artifacts).toEqual(second.artifacts);
    expect(first.artifacts).toHaveLength(1);
    expect(first.packages.every((entry: { files: number }) => entry.files > 0)).toBe(true);
    expect(first.packages.every((entry: { sha256: string }) => entry.sha256.length === 64)).toBe(
      true,
    );
  });
});
