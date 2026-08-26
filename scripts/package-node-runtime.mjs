import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(repositoryRoot, "dist/node-build");
const runtimeRoot = path.join(repositoryRoot, "dist/node-runtime");
const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
const internalRoots = [
  "apps/admin-cli",
  "apps/agent-service",
  "apps/execution-worker",
  "packages/application",
  "packages/domain",
  "packages/execution-contracts",
  "packages/gateway-contracts",
  "packages/persistence-sqlite",
  "packages/platform-node",
];

function runtimeManifest(manifest, relativeRoot) {
  const convert = (target) =>
    typeof target === "string"
      ? target.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js")
      : Object.fromEntries(Object.entries(target).map(([key, value]) => [key, convert(value)]));
  return {
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: "module",
    exports: convert(manifest.exports ?? { ".": "./src/index.ts" }),
    ...(relativeRoot === "apps/admin-cli"
      ? { bin: { himawari: "./dist/main.js" } }
      : relativeRoot === "apps/agent-service"
        ? { bin: { "himawari-agent-service": "./dist/main.js" } }
        : relativeRoot === "apps/execution-worker"
          ? { bin: { "himawari-execution-worker": "./dist/main.js" } }
          : {}),
  };
}

async function copyInternalPackage(relativeRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, relativeRoot, "package.json"), "utf8"),
  );
  const packageNameParts = manifest.name.split("/");
  const destination = path.join(runtimeNodeModules, ...packageNameParts);
  await mkdir(destination, { recursive: true });
  await cp(path.join(buildRoot, relativeRoot, "src"), path.join(destination, "dist"), {
    recursive: true,
  });
  await writeFile(
    path.join(destination, "package.json"),
    `${JSON.stringify(runtimeManifest(manifest, relativeRoot), null, 2)}\n`,
  );
  if (relativeRoot === "packages/persistence-sqlite") {
    await cp(
      path.join(repositoryRoot, relativeRoot, "src/migrations"),
      path.join(destination, "dist/migrations"),
      { recursive: true },
    );
  }
}

function findPackageRoot(resolvedPath, expectedName) {
  let current = path.dirname(resolvedPath);
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(current, "package.json"), "utf8"));
      if (manifest.name === expectedName) return { root: current, manifest };
    } catch {}
    current = path.dirname(current);
  }
  throw new Error(`Unable to locate runtime dependency ${expectedName}`);
}

async function copyExternalClosure(rootNames) {
  const queue = rootNames.map((name) => ({ name, require: createRequire(import.meta.url) }));
  const copied = new Map();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (builtinModules.includes(item.name) || builtinModules.includes(`node:${item.name}`))
      continue;
    const entry = item.require.resolve(item.name);
    const located = findPackageRoot(entry, item.name);
    const previous = copied.get(item.name);
    if (previous && previous !== located.manifest.version) {
      throw new Error(`Conflicting runtime dependency versions for ${item.name}`);
    }
    if (previous) continue;
    copied.set(item.name, located.manifest.version);
    const destination = path.join(runtimeNodeModules, ...item.name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(located.root, destination, { recursive: true });
    const packageRequire = createRequire(path.join(located.root, "package.json"));
    for (const dependency of Object.keys({
      ...(located.manifest.dependencies ?? {}),
      ...(located.manifest.optionalDependencies ?? {}),
    })) {
      try {
        packageRequire.resolve(dependency);
        queue.push({ name: dependency, require: packageRequire });
      } catch {}
    }
  }
  return copied;
}

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeNodeModules, { recursive: true });
for (const relativeRoot of internalRoots.sort()) await copyInternalPackage(relativeRoot);
const external = await copyExternalClosure(["better-sqlite3"]);
await writeFile(
  path.join(runtimeRoot, "runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      nodeMinimum: "22.19.0",
      entrypoints: {
        himawari: "node_modules/@himawari-agent/admin-cli/dist/main.js",
        agentService: "node_modules/@himawari-agent/agent-service/dist/main.js",
        executionWorker: "node_modules/@himawari-agent/execution-worker/dist/main.js",
      },
      externalDependencies: Object.fromEntries([...external.entries()].sort()),
    },
    null,
    2,
  )}\n`,
);
console.log("Relocatable Node runtime written to dist/node-runtime");
