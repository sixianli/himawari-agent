import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isolatedEnvironment } from "./install-tools.mjs";

const roots = ["ajv", "typescript", "yaml"];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Project the locked dependency graph; npm must not resolve new versions. */
export function gateLock(lock) {
  assert(lock.lockfileVersion === 3 && lock.packages, "GATE_LOCK_VERSION");
  const packages = {};
  const dependencies = {};
  const visit = (location) => {
    if (packages[location]) return;
    const entry = lock.packages[location];
    assert(
      entry &&
        !entry.link &&
        !entry.hasInstallScript &&
        entry.integrity &&
        entry.resolved?.startsWith("https://registry.npmjs.org/"),
      "GATE_DEPENDENCY_UNSAFE",
    );
    packages[location] = { ...entry };
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      assert(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name), "GATE_DEPENDENCY_NAME");
      let scope = location;
      let resolved;
      while (true) {
        const candidate = `${scope ? `${scope}/` : ""}node_modules/${name}`;
        if (lock.packages[candidate]) {
          resolved = candidate;
          break;
        }
        if (!scope) break;
        const parent = scope.lastIndexOf("/node_modules/");
        scope = parent < 0 ? "" : scope.slice(0, parent);
      }
      assert(resolved, "GATE_DEPENDENCY_MISSING");
      visit(resolved);
    }
  };
  for (const name of roots) {
    visit(`node_modules/${name}`);
    dependencies[name] = packages[`node_modules/${name}`].version;
  }
  const manifest = { name: "himawari-ci-gate", version: "1.0.0", private: true, dependencies };
  return {
    manifest,
    lock: {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest, ...packages },
    },
  };
}

export function installGateDependencies({ root = process.cwd(), tools = ".ci-output/tools" } = {}) {
  assert(!existsSync(path.join(root, "node_modules")), "GATE_REQUIRES_CLEAN_DEPENDENCIES");
  const directory = path.join(root, ".ci-output/gate-runtime");
  assert(!existsSync(directory), "GATE_RUNTIME_EXISTS");
  const data = gateLock(JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify(data.manifest));
  writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify(data.lock));
  const node = path.resolve(root, tools, "bin/node");
  const npm = path.resolve(root, tools, "npm/package/bin/npm-cli.js");
  execFileSync(
    node,
    [
      npm,
      "ci",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(root, ".ci-output/npm-cache"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 120_000,
      env: isolatedEnvironment(
        path.join(directory, "environment"),
        path.resolve(root, tools, "bin"),
      ),
    },
  );
  symlinkSync(path.join(directory, "node_modules"), path.join(root, "node_modules"), "dir");
  return { packages: Object.keys(data.lock.packages).length - 1 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(installGateDependencies()));
}
