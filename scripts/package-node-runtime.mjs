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
  "packages/integration-github",
  "packages/memory-mem0",
  "packages/persistence-sqlite",
  "packages/platform-node",
  "packages/runtime-pi",
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
  try {
    const manifest = JSON.parse(readFileSync(path.join(resolvedPath, "package.json"), "utf8"));
    if (manifest.name === expectedName) return { root: resolvedPath, manifest };
  } catch {}
  let current = path.dirname(resolvedPath);
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(current, "package.json"), "utf8"));
      if (manifest.name === expectedName) return { root: current, manifest };
    } catch {}
    current = path.dirname(current);
  }
  throw new Error(`Unable to locate runtime dependency ${expectedName} from ${resolvedPath}`);
}

function packageRootFromNodeModules(name) {
  const packageParts = name.startsWith("@") ? name.split("/", 2) : [name];
  return path.join(repositoryRoot, "node_modules", ...packageParts);
}

function resolvePackageEntry(name, require) {
  try {
    return require.resolve(name);
  } catch (error) {
    const root = packageRootFromNodeModules(name);
    try {
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const main = typeof manifest.main === "string" ? manifest.main : "index.js";
      return path.join(root, main);
    } catch {
      throw error;
    }
  }
}

async function copyExternalClosure(rootNames) {
  const queue = rootNames.map((name) => ({ name, require: createRequire(import.meta.url) }));
  const copied = new Map();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (builtinModules.includes(item.name) || builtinModules.includes(`node:${item.name}`))
      continue;
    const entry = item.entry ?? resolvePackageEntry(item.name, item.require);
    const located = findPackageRoot(entry, item.name);
    const relativeLocation = path.relative(path.join(repositoryRoot, "node_modules"), located.root);
    if (
      relativeLocation === "" ||
      relativeLocation === ".." ||
      relativeLocation.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeLocation)
    ) {
      throw new Error(`Runtime dependency escaped root node_modules: ${item.name}`);
    }
    const previous = copied.get(relativeLocation);
    if (
      previous &&
      (previous.name !== item.name || previous.version !== located.manifest.version)
    ) {
      throw new Error(`Conflicting runtime dependency at ${relativeLocation}`);
    }
    if (previous) continue;
    copied.set(relativeLocation, { name: item.name, version: located.manifest.version });
    const destination = path.join(runtimeNodeModules, relativeLocation);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(located.root, destination, { recursive: true });
    const packageRequire = createRequire(path.join(located.root, "package.json"));
    for (const dependency of Object.keys({
      ...(located.manifest.dependencies ?? {}),
      ...(located.manifest.optionalDependencies ?? {}),
    })) {
      try {
        const dependencyEntry = resolvePackageEntry(dependency, packageRequire);
        queue.push({ name: dependency, require: packageRequire, entry: dependencyEntry });
      } catch {}
    }
  }
  return copied;
}

await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
await mkdir(runtimeNodeModules, { recursive: true });
for (const relativeRoot of internalRoots.sort()) await copyInternalPackage(relativeRoot);
const external = await copyExternalClosure([
  "@earendil-works/pi-coding-agent",
  "@fastify/cookie",
  "@fastify/csrf-protection",
  "@fastify/helmet",
  "@fastify/rate-limit",
  "@fastify/static",
  "@octokit/app",
  "better-sqlite3",
  "fastify",
  "jose",
  "mem0ai",
]);
const rootExternal = new Map(
  [...external.entries()]
    .filter(([location, { name }]) => location === path.join(...name.split("/")))
    .map(([, { name, version }]) => [name, version]),
);
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
      externalDependencies: Object.fromEntries([...rootExternal.entries()].sort()),
      externalDependencyClosure: Object.fromEntries(
        [...external.entries()]
          .map(([location, identity]) => [location.split(path.sep).join("/"), identity])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    null,
    2,
  )}\n`,
);
console.log("Relocatable Node runtime written to dist/node-runtime");
