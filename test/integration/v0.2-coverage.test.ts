import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const checkerPath = path.join(repositoryRoot, "scripts/check-v0.2-coverage.mjs");
const manifestPath = path.join(repositoryRoot, "test/fixtures/v0.2/coverage-manifest.json");
const temporaryDirectories: string[] = [];

interface MutableCoverageManifest {
  prd: {
    sha256: string;
  };
  specifications: Array<{
    acceptances: Array<{
      verificationEntrypoints: string[];
    }>;
  }>;
}

async function changedManifest(change: (manifest: MutableCoverageManifest) => void) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "himawari-v0.2-coverage-"));
  temporaryDirectories.push(temporaryDirectory);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableCoverageManifest;
  change(manifest);
  const outputPath = path.join(temporaryDirectory, "coverage-manifest.json");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return outputPath;
}

function runChecker(pathToManifest = manifestPath) {
  return spawnSync(process.execPath, [checkerPath, "--manifest", pathToManifest], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("v0.2 coverage baseline", () => {
  it("accepts the owner-reviewed manifest", () => {
    const result = runChecker();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "v0.2 coverage check passed for 79 requirements, 53 acceptance IDs, and 10 Specs/Plans.",
    );
  });

  it("rejects a stale PRD digest", async () => {
    const staleManifest = await changedManifest((manifest) => {
      manifest.prd.sha256 = "0".repeat(64);
    });

    const result = runChecker(staleManifest);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PRD digest differs");
    expect(result.stderr).toContain("S0 recorded PRD digest differs from manifest");
  });

  it("rejects an acceptance without a verification entrypoint", async () => {
    const incompleteManifest = await changedManifest((manifest) => {
      const specification = manifest.specifications[2];
      if (!specification) throw new Error("fixture is missing S2");
      const acceptance = specification.acceptances[0];
      if (!acceptance) throw new Error("fixture is missing S2-A01");
      acceptance.verificationEntrypoints = [];
    });

    const result = runChecker(incompleteManifest);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("S2-A01 has no verification entrypoint");
  });
});
