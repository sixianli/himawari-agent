import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { collectArtifactFiles } from "./ci/artifact-files.mjs";

const excludedEntries = new Set([".DS_Store", "coverage", "dist", "node_modules", "test"]);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function collectFiles(directory, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });

  for (const entry of entries) {
    if (excludedEntries.has(entry.name)) continue;

    const relativePath = path.posix.join(
      relativeDirectory.split(path.sep).join(path.posix.sep),
      entry.name,
    );
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

async function checksumFiles(directory, relativeFiles) {
  const records = [];
  for (const relativeFile of relativeFiles) {
    const content = await readFile(path.join(directory, relativeFile));
    records.push({ path: relativeFile, sha256: sha256(content) });
  }
  return {
    files: records.length,
    sha256: sha256(records.map((record) => `${record.path}\0${record.sha256}\n`).join("")),
  };
}

async function readWorkspacePackages(repositoryRoot) {
  const packages = [];
  for (const group of ["apps", "packages"]) {
    const groupDirectory = path.join(repositoryRoot, group);
    const entries = await readdir(groupDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspaceRoot = path.join(groupDirectory, entry.name);
      const manifest = JSON.parse(await readFile(path.join(workspaceRoot, "package.json"), "utf8"));
      const relativeFiles = await collectFiles(workspaceRoot);
      packages.push({
        name: manifest.name,
        root: path.posix.join(group, entry.name),
        version: manifest.version,
        ...(await checksumFiles(workspaceRoot, relativeFiles)),
      });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectBrowserArtifacts(outputRoot) {
  try {
    const relativeFiles = await collectFiles(outputRoot);
    return relativeFiles.map(async (relativeFile) => {
      const content = await readFile(path.join(outputRoot, relativeFile));
      return {
        path: path.posix.join("apps/control-center/dist", relativeFile),
        sha256: sha256(content),
        size: content.byteLength,
      };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function generateArtifactManifest({
  root = repositoryRoot,
  output = path.join(root, "dist/build-artifact-manifest.json"),
  nodeRoot = path.join(root, "dist/node-runtime"),
  browserRoot = path.join(root, "apps/control-center/dist"),
  requireBuiltArtifacts = false,
} = {}) {
  const rootManifest = await readFile(path.join(root, "package.json"));
  const lockfile = await readFile(path.join(root, "package-lock.json"));
  let nodeArtifacts = [];
  let runtime = null;
  try {
    runtime = JSON.parse(await readFile(path.join(nodeRoot, "runtime-manifest.json"), "utf8"));
    nodeArtifacts = await collectArtifactFiles(nodeRoot);
  } catch (error) {
    if (requireBuiltArtifacts || error.code !== "ENOENT") throw error;
  }
  const browserArtifacts = await Promise.all(await collectBrowserArtifacts(browserRoot));
  if (requireBuiltArtifacts && (nodeArtifacts.length === 0 || browserArtifacts.length === 0))
    throw new Error("BUILD_ARTIFACTS_MISSING");
  const artifactManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    inputs: { packageJsonSha256: sha256(rootManifest), packageLockSha256: sha256(lockfile) },
    packages: await readWorkspacePackages(root),
    artifacts: browserArtifacts,
    nodeArtifacts,
    runtime,
    platform: { os: process.platform, arch: process.arch, abi: process.versions.modules },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifactManifest, null, 2)}\n`);
  return artifactManifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = {
      "--output": "output",
      "--node-root": "nodeRoot",
      "--browser-root": "browserRoot",
    }[process.argv[i]];
    if (!key || !process.argv[i + 1] || options[key])
      throw new Error(`Invalid manifest argument: ${process.argv[i]}`);
    options[key] = path.resolve(process.argv[i + 1]);
  }
  await generateArtifactManifest(options);
  console.log(
    `Build artifact manifest written to ${options.output ?? "dist/build-artifact-manifest.json"}`,
  );
}
