import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  allowedInternalDependencies,
  browserOnlyPackages,
  isBrowserImportAllowed,
  isExactExternalVersion,
  isNodeImportAllowed,
  packageSpecifier,
  piDependencyOwner,
} from "./boundary-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageRoots = [path.join(repositoryRoot, "apps"), path.join(repositoryRoot, "packages")];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

async function readWorkspacePackages() {
  const packages = [];

  for (const packageRoot of packageRoots) {
    const entries = await readdir(packageRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const directory = path.join(packageRoot, entry.name);
      const manifestPath = path.join(directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      packages.push({ directory, manifest, manifestPath });
    }
  }

  return packages;
}

async function walkSourceFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (["coverage", "dist", "node_modules"].includes(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(entryPath)));
    } else if (sourceExtensions.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function dependenciesOf(manifest) {
  return {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
}

function checkExactExternalDependencies(manifest, manifestLabel, workspaceNames) {
  const errors = [];

  for (const [dependency, version] of Object.entries(dependenciesOf(manifest))) {
    if (!workspaceNames.has(dependency) && !isExactExternalVersion(version)) {
      errors.push(
        `${manifestLabel}: direct external dependency ${dependency} must use an exact version, found ${version}`,
      );
    }
  }

  return errors;
}

function detectCycles(graph) {
  const errors = [];
  const visited = new Set();
  const active = [];

  function visit(packageName) {
    const activeIndex = active.indexOf(packageName);
    if (activeIndex >= 0) {
      errors.push(
        `workspace dependency cycle: ${[...active.slice(activeIndex), packageName].join(" -> ")}`,
      );
      return;
    }
    if (visited.has(packageName)) return;

    active.push(packageName);
    for (const dependency of graph.get(packageName) ?? []) visit(dependency);
    active.pop();
    visited.add(packageName);
  }

  for (const packageName of graph.keys()) visit(packageName);
  return errors;
}

const workspacePackages = await readWorkspacePackages();
const workspaceNames = new Set(workspacePackages.map(({ manifest }) => manifest.name));
const graph = new Map();
const errors = [];
const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));

errors.push(...checkExactExternalDependencies(rootManifest, "package.json", workspaceNames));

for (const { directory, manifest, manifestPath } of workspacePackages) {
  const packageName = manifest.name;
  const allowed = allowedInternalDependencies.get(packageName);
  const manifestLabel = path.relative(repositoryRoot, manifestPath);

  if (!allowed) {
    errors.push(`${manifestLabel}: unknown workspace package ${String(packageName)}`);
    continue;
  }

  const declaredDependencies = dependenciesOf(manifest);
  errors.push(...checkExactExternalDependencies(manifest, manifestLabel, workspaceNames));
  const internalDependencies = new Set();
  for (const [dependency, version] of Object.entries(declaredDependencies)) {
    if (workspaceNames.has(dependency)) {
      internalDependencies.add(dependency);
      if (!allowed.has(dependency)) {
        errors.push(`${manifestLabel}: ${packageName} must not depend on ${dependency}`);
      }
      if (version !== "0.0.0") {
        errors.push(`${manifestLabel}: internal dependency ${dependency} must be pinned to 0.0.0`);
      }
    }

    if (dependency.startsWith("@earendil-works/pi-") && packageName !== piDependencyOwner) {
      errors.push(
        `${manifestLabel}: Pi dependency ${dependency} is only allowed in @himawari-agent/runtime-pi`,
      );
    }
  }
  graph.set(packageName, internalDependencies);

  const files = await walkSourceFiles(directory);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const fileLabel = path.relative(repositoryRoot, file);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;

      if (specifier.startsWith(".")) {
        const resolvedImport = path.resolve(path.dirname(file), specifier);
        const relativeImport = path.relative(directory, resolvedImport);
        if (relativeImport === ".." || relativeImport.startsWith(`..${path.sep}`)) {
          errors.push(
            `${fileLabel}: relative import ${specifier} escapes workspace ${packageName}`,
          );
        }
      }

      const importedPackage = packageSpecifier(specifier);
      if (importedPackage.startsWith("@earendil-works/pi-") && packageName !== piDependencyOwner) {
        errors.push(`${fileLabel}: direct Pi import ${specifier} is outside packages/runtime-pi`);
      }
      if (specifier.startsWith("node:") && !isNodeImportAllowed(packageName)) {
        errors.push(`${fileLabel}: Node.js import ${specifier} is not allowed in ${packageName}`);
      }
      if (!isBrowserImportAllowed(packageName, specifier, workspaceNames)) {
        errors.push(
          `${fileLabel}: browser-only workspace ${packageName} must not import ${specifier}`,
        );
      }
      if (
        workspaceNames.has(importedPackage) &&
        importedPackage !== packageName &&
        !declaredDependencies[importedPackage]
      ) {
        errors.push(
          `${fileLabel}: ${importedPackage} is imported but not declared in ${manifestLabel}`,
        );
      }
      if (
        workspaceNames.has(importedPackage) &&
        importedPackage !== packageName &&
        !allowed.has(importedPackage)
      ) {
        errors.push(`${fileLabel}: ${packageName} must not import ${importedPackage}`);
      }
      if (
        packageName === piDependencyOwner &&
        importedPackage === "@himawari-agent/application" &&
        specifier !== "@himawari-agent/application/runtime-port"
      ) {
        errors.push(
          `${fileLabel}: runtime-pi may import only @himawari-agent/application/runtime-port`,
        );
      }
    }
  }
}

for (const { manifest, manifestPath } of workspacePackages) {
  if (!browserOnlyPackages.has(manifest.name)) continue;
  for (const dependency of Object.keys(dependenciesOf(manifest))) {
    if (
      !workspaceNames.has(dependency) &&
      !isBrowserImportAllowed(manifest.name, dependency, workspaceNames)
    ) {
      errors.push(
        `${path.relative(repositoryRoot, manifestPath)}: browser-only workspace ${manifest.name} must not declare ${dependency}`,
      );
    }
  }
}

errors.push(...detectCycles(graph));

if (errors.length > 0) {
  console.error("Dependency boundary check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Dependency boundary check passed for ${workspacePackages.length} workspaces.`);
}
