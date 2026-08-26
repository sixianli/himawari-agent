import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

async function readWorkspacePackages() {
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

async function collectBrowserArtifacts() {
  const outputRoot = path.join(repositoryRoot, "apps/control-center/dist");
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

function outputPathFromArguments() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0) return path.join(repositoryRoot, "dist/build-artifact-manifest.json");
  const output = process.argv[outputIndex + 1];
  if (!output) throw new Error("--output requires a path");
  return path.resolve(process.cwd(), output);
}

const rootManifest = await readFile(path.join(repositoryRoot, "package.json"));
const lockfile = await readFile(path.join(repositoryRoot, "package-lock.json"));
const outputPath = outputPathFromArguments();
const artifactManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  inputs: {
    packageJsonSha256: sha256(rootManifest),
    packageLockSha256: sha256(lockfile),
  },
  packages: await readWorkspacePackages(),
  artifacts: await Promise.all(await collectBrowserArtifacts()),
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifactManifest, null, 2)}\n`);
console.log(`Build artifact manifest written to ${path.relative(repositoryRoot, outputPath)}`);
