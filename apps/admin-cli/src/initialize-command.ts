import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  acquireStateRootLock,
  applyMigrations,
  initializeProductIdentity,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  initializeStateRoot,
  JsonFileConfigurationPort,
  writeAuthorityFile,
} from "@himawari-agent/platform-node";

/** Explicit host administration; this command never publishes an HTTP bootstrap. */
export async function runInitializeCommand(arguments_: readonly string[]): Promise<unknown> {
  if (
    arguments_.length !== 3 ||
    arguments_[1] !== "--config" ||
    !arguments_[2] ||
    !path.isAbsolute(arguments_[2])
  )
    throw new Error("INITIALIZATION_ARGUMENT_INVALID");
  const configuration = await new JsonFileConfigurationPort(arguments_[2]).load();
  const root = configuration.stateRoot;
  const parent = await realpath(path.dirname(root));
  if (
    root !== path.join(parent, path.basename(root)) ||
    root === parent ||
    configuration.runtimeDirectory !== path.join(root, "runtime") ||
    configuration.cacheDirectory !== path.join(root, "cache") ||
    !configuration.memory.storagePath.startsWith(`${path.join(root, "data")}${path.sep}`)
  )
    throw new Error("INITIALIZATION_LAYOUT_INVALID");
  // mkdir without recursive is the installation claim. Existing directories, files
  // and symlinks are never overwritten, including after an interrupted attempt.
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("INITIALIZATION_TARGET_EXISTS");
    throw error;
  }
  const layout = await initializeStateRoot(root);
  const lock = await acquireStateRootLock(root);
  try {
    await mkdir(configuration.memory.storagePath, { recursive: true, mode: 0o700 });
    const database = openQualifiedDatabase(path.join(layout.data, "product.sqlite"));
    let authority: ReturnType<typeof initializeProductIdentity>;
    try {
      applyMigrations(database, await loadBundledMigrations());
      authority = initializeProductIdentity(database, {
        ...configuration,
        now: new Date().toISOString(),
      });
    } finally {
      database.close();
    }
    const { loadedAt: _loadedAt, ...storedConfiguration } = configuration;
    const filename = path.join(root, "configuration.json");
    const file = await open(filename, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(storedConfiguration, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    // The authority marker is published last. A failed/partial installation cannot
    // pass normal service startup, which requires this file and the matching DB.
    await writeAuthorityFile(layout, authority);
    return {
      schemaVersion: 1,
      command: "init",
      stateRoot: root,
      configurationPath: filename,
      ownerId: authority.ownerId,
      agentId: authority.agentId,
      deploymentId: authority.id,
      accountReady: false,
      capabilityQualificationReady: false,
    };
  } finally {
    await lock.release();
  }
}
