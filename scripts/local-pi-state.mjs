import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const ARTIFACTS = Object.freeze([
  "packages/coding-agent/dist/index.js",
  "packages/coding-agent/dist/index.d.ts",
  "packages/agent/dist/index.js",
  "packages/ai/dist/index.js",
  "packages/client/dist/index.js",
  "packages/protocol/dist/index.js",
  "packages/tui/dist/index.js",
]);

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function pathsFor(root) {
  const repositoryRoot = resolve(root);
  const localRoot = resolve(repositoryRoot, "..", "pi-mono");
  const installedPackage = resolve(
    repositoryRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  return Object.freeze({
    repositoryRoot,
    localRoot,
    localPackage: resolve(localRoot, "packages", "coding-agent"),
    runtimeManifest: resolve(repositoryRoot, "packages", "runtime-pi", "package.json"),
    lockfile: resolve(repositoryRoot, "package-lock.json"),
    installedPackage,
    backupPackage: resolve(
      repositoryRoot,
      "node_modules",
      "@earendil-works",
      ".pi-coding-agent.published-backup",
    ),
    stateFile: resolve(repositoryRoot, "node_modules", ".himawari-local-pi-link.json"),
  });
}

async function contractHashes(paths) {
  return Object.freeze({
    runtimeManifest: await sha256(paths.runtimeManifest),
    lockfile: await sha256(paths.lockfile),
  });
}

function assertHashesUnchanged(before, after) {
  if (before.runtimeManifest !== after.runtimeManifest || before.lockfile !== after.lockfile) {
    throw new Error("LOCAL_PI_CONTRACT_CHANGED: package manifest or lockfile changed");
  }
}

export async function inspectLocalPi(root = process.cwd()) {
  const paths = pathsFor(root);
  if (!(await exists(paths.localRoot))) {
    throw new Error(`LOCAL_PI_NOT_FOUND: ${paths.localRoot}`);
  }

  const [runtimeManifest, localManifest] = await Promise.all([
    readJson(paths.runtimeManifest),
    readJson(resolve(paths.localPackage, "package.json")),
  ]);
  const expectedVersion = runtimeManifest.dependencies?.[PACKAGE_NAME];
  if (typeof expectedVersion !== "string") {
    throw new Error(`LOCAL_PI_PIN_MISSING: ${PACKAGE_NAME}`);
  }
  if (localManifest.name !== PACKAGE_NAME || localManifest.version !== expectedVersion) {
    throw new Error(
      `LOCAL_PI_VERSION_MISMATCH: expected ${PACKAGE_NAME}@${expectedVersion}, found ${localManifest.name}@${localManifest.version}`,
    );
  }

  const artifacts = await Promise.all(
    ARTIFACTS.map(async (relativePath) => ({
      path: relativePath,
      present: await exists(resolve(paths.localRoot, relativePath)),
    })),
  );
  const installed = await exists(paths.installedPackage);
  const installedRealPath = installed ? await realpath(paths.installedPackage) : null;
  const localRealPath = await realpath(paths.localPackage);
  const mode = installedRealPath === localRealPath ? "local" : "published";

  return Object.freeze({
    packageName: PACKAGE_NAME,
    expectedVersion,
    localVersion: localManifest.version,
    localRoot: paths.localRoot,
    localPackage: paths.localPackage,
    installedPackage: paths.installedPackage,
    installedRealPath,
    mode,
    ready: artifacts.every(({ present }) => present),
    artifacts: Object.freeze(artifacts),
  });
}

export async function linkLocalPi(root = process.cwd()) {
  const paths = pathsFor(root);
  const inspection = await inspectLocalPi(root);
  if (!inspection.ready) {
    const missing = inspection.artifacts
      .filter(({ present }) => !present)
      .map(({ path }) => path)
      .join(", ");
    throw new Error(`LOCAL_PI_BUILD_MISSING: ${missing}`);
  }
  if (inspection.mode === "local") return inspection;
  if (!(await exists(paths.installedPackage))) {
    throw new Error("PUBLISHED_PI_NOT_INSTALLED: run npm ci --ignore-scripts first");
  }
  if ((await exists(paths.stateFile)) || (await exists(paths.backupPackage))) {
    throw new Error("LOCAL_PI_LINK_STATE_CONFLICT: unlink or repair the existing local state");
  }

  const before = await contractHashes(paths);
  await mkdir(dirname(paths.backupPackage), { recursive: true });
  await rename(paths.installedPackage, paths.backupPackage);
  try {
    await symlink(paths.localPackage, paths.installedPackage, "dir");
    await writeFile(
      paths.stateFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          packageName: PACKAGE_NAME,
          expectedVersion: inspection.expectedVersion,
          localPackage: paths.localPackage,
          backupPackage: paths.backupPackage,
          contractHashes: before,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    assertHashesUnchanged(before, await contractHashes(paths));
    const linked = await inspectLocalPi(root);
    if (linked.mode !== "local") throw new Error("LOCAL_PI_LINK_VERIFICATION_FAILED");
    return linked;
  } catch (error) {
    if (await exists(paths.installedPackage)) await rm(paths.installedPackage);
    if (await exists(paths.backupPackage))
      await rename(paths.backupPackage, paths.installedPackage);
    if (await exists(paths.stateFile)) await rm(paths.stateFile);
    throw error;
  }
}

export async function unlinkLocalPi(root = process.cwd()) {
  const paths = pathsFor(root);
  if (!(await exists(paths.stateFile))) {
    const inspection = await inspectLocalPi(root);
    if (inspection.mode === "local") {
      throw new Error("LOCAL_PI_LINK_UNMANAGED: refusing to replace an untracked symlink");
    }
    return inspection;
  }

  const state = await readJson(paths.stateFile);
  const currentHashes = await contractHashes(paths);
  assertHashesUnchanged(state.contractHashes, currentHashes);
  const linkedRealPath = await realpath(paths.installedPackage);
  if (linkedRealPath !== (await realpath(paths.localPackage))) {
    throw new Error("LOCAL_PI_LINK_TARGET_CHANGED: refusing to replace an unexpected target");
  }
  if (!(await exists(paths.backupPackage))) {
    throw new Error("LOCAL_PI_PUBLISHED_BACKUP_MISSING");
  }

  await rm(paths.installedPackage);
  await rename(paths.backupPackage, paths.installedPackage);
  await rm(paths.stateFile);
  assertHashesUnchanged(currentHashes, await contractHashes(paths));
  const restored = await inspectLocalPi(root);
  if (restored.mode !== "published") throw new Error("PUBLISHED_PI_RESTORE_FAILED");
  const installedManifest = await readJson(resolve(paths.installedPackage, "package.json"));
  if (
    installedManifest.name !== PACKAGE_NAME ||
    installedManifest.version !== restored.expectedVersion
  ) {
    throw new Error("PUBLISHED_PI_VERSION_MISMATCH_AFTER_UNLINK");
  }
  return restored;
}
