import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

export async function packageNodeRuntime({
  root = repositoryRoot,
  buildRoot = path.join(root, "dist/node-build"),
  runtimeRoot = path.join(root, "dist/node-runtime"),
} = {}) {
  const repositoryRoot = root;
  const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
  async function externalRuntimeRoots() {
    const manifests = await Promise.all(
      internalRoots.map(async (relativeRoot) =>
        JSON.parse(await readFile(path.join(repositoryRoot, relativeRoot, "package.json"), "utf8")),
      ),
    );
    const internalNames = new Set(manifests.map(({ name }) => name));
    return [
      ...new Set(
        manifests.flatMap(({ dependencies = {} }) =>
          Object.keys(dependencies).filter(
            (name) => !internalNames.has(name) && !name.startsWith("@himawari-agent/"),
          ),
        ),
      ),
    ].sort();
  }

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

  function resolvePackageEntry(name, require) {
    try {
      return require.resolve(name);
    } catch (resolutionError) {
      for (const searchRoot of require.resolve.paths(name) ?? []) {
        const root = path.join(searchRoot, ...name.split("/"));
        try {
          const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
          if (manifest.name !== name)
            throw new Error(`Runtime dependency manifest name mismatch: ${name}`);
          return root;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      throw resolutionError;
    }
  }

  async function copyExternalClosure(rootNames) {
    const queue = rootNames.map((name) => ({
      name,
      require: createRequire(path.join(repositoryRoot, "package.json")),
    }));
    const copied = new Map();
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (builtinModules.includes(item.name) || builtinModules.includes(`node:${item.name}`))
        continue;
      const entry = item.entry ?? resolvePackageEntry(item.name, item.require);
      const located = findPackageRoot(entry, item.name);
      const relativeLocation = path.relative(
        path.join(repositoryRoot, "node_modules"),
        located.root,
      );
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
      await cp(located.root, destination, {
        recursive: true,
        dereference: true,
        filter(source) {
          const relative = path.relative(located.root, source);
          if (relative.split(path.sep).includes("node_modules")) return false;
          if (lstatSync(source).isSymbolicLink()) {
            const resolved = realpathSync(source);
            const modulesRoot = realpathSync(path.join(repositoryRoot, "node_modules"));
            if (!resolved.startsWith(`${modulesRoot}${path.sep}`))
              throw new Error(`Runtime dependency symlink escapes node_modules: ${source}`);
          }
          return true;
        },
      });
      const packageRequire = createRequire(path.join(located.root, "package.json"));
      for (const dependency of Object.keys({
        ...(located.manifest.dependencies ?? {}),
        ...(located.manifest.optionalDependencies ?? {}),
      })) {
        try {
          const dependencyEntry = resolvePackageEntry(dependency, packageRequire);
          queue.push({ name: dependency, require: packageRequire, entry: dependencyEntry });
        } catch (error) {
          if (Object.hasOwn(located.manifest.dependencies ?? {}, dependency)) throw error;
        }
      }
    }
    return copied;
  }

  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(runtimeNodeModules, { recursive: true });
  for (const relativeRoot of internalRoots.sort()) await copyInternalPackage(relativeRoot);
  const external = await copyExternalClosure(await externalRuntimeRoots());
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
  return { runtimeRoot, externalDependencyClosure: Object.fromEntries(external) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    const key = { "--build-root": "buildRoot", "--output-root": "runtimeRoot" }[name];
    if (!key || !process.argv[i + 1] || options[key])
      throw new Error(`Invalid package argument: ${name}`);
    options[key] = path.resolve(process.argv[i + 1]);
  }
  const result = await packageNodeRuntime(options);
  console.log(`Relocatable Node runtime written to ${result.runtimeRoot}`);
}
