import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const installerPath = path.join(repositoryRoot, "scripts/install-node-runtime.mjs");
const RUNTIME_INSTALL_TIMEOUT_MS = 180_000;
const SMALL_FILE_BYTES = 1024 * 1024;
const DIRECTORY_MODE = 0o755;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const SEALED_DIRECTORY_MODE = 0o555;
const SEALED_FILE_MODE = 0o444;
const SEALED_EXECUTABLE_MODE = 0o555;

export interface SharedNodeRuntime {
  readonly prefix: string;
  readonly runtimeRoot: string;
  readonly fileCount: number;
  readonly structureSha256: string;
  readonly manifestSha256: string;
  readonly installElapsedMs: number;
}

declare module "vitest" {
  interface ProvidedContext {
    sharedNodeRuntime?: SharedNodeRuntime;
  }
}

export type RuntimeSource =
  | { readonly kind: "shared"; readonly shared: SharedNodeRuntime }
  | { readonly kind: "development" };

interface StructureEntry {
  readonly path: string;
  readonly mode: number;
  readonly bytes: number;
  readonly modifiedMs: number;
}

const digestOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function structureOf(root: string): Promise<{ entries: StructureEntry[]; digest: string }> {
  const entries: StructureEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const listed = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of listed) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`SHARED_RUNTIME_LINK_FORBIDDEN:${name}`);
      const info = await lstat(filename);
      if (info.isDirectory()) {
        await visit(filename, name);
        continue;
      }
      if (!info.isFile()) throw new Error(`SHARED_RUNTIME_SPECIAL_FILE:${name}`);
      if (entry.name === ".DS_Store") continue;
      entries.push({
        path: name,
        mode: info.mode & 0o777,
        bytes: info.size,
        modifiedMs: info.mtimeMs,
      });
    }
  };
  await visit(root, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, digest: digestOf(entries) };
}

interface ManifestEntry {
  readonly path: string;
  readonly mode: number;
  readonly bytes: number;
  readonly sha256: string;
}

async function digestFile(filename: string, bytes: number): Promise<string> {
  if (bytes < SMALL_FILE_BYTES)
    return createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

async function manifestOf(root: string): Promise<{ entries: ManifestEntry[]; digest: string }> {
  const entries: ManifestEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const listed = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of listed) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`SHARED_RUNTIME_LINK_FORBIDDEN:${name}`);
      const info = await lstat(filename);
      if (info.isDirectory()) {
        await visit(filename, name);
        continue;
      }
      if (!info.isFile()) throw new Error(`SHARED_RUNTIME_SPECIAL_FILE:${name}`);
      if (entry.name === ".DS_Store") continue;
      entries.push({
        path: name,
        mode: info.mode & 0o777,
        bytes: info.size,
        sha256: await digestFile(filename, info.size),
      });
    }
  };
  await visit(root, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, digest: digestOf(entries) };
}

async function setTreeModes(
  root: string,
  modeFor: (mode: number, directory: boolean) => number,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename);
      if (info.isDirectory()) {
        await visit(filename);
        await chmod(filename, modeFor(info.mode, true));
      } else if (info.isFile()) await chmod(filename, modeFor(info.mode, false));
    }
  };
  await visit(root);
  await chmod(root, modeFor((await lstat(root)).mode, true));
}

export async function sealRuntimeTree(root: string): Promise<void> {
  await setTreeModes(root, (mode, directory) =>
    directory
      ? SEALED_DIRECTORY_MODE
      : (mode & 0o111) !== 0
        ? SEALED_EXECUTABLE_MODE
        : SEALED_FILE_MODE,
  );
}

export async function openRuntimeTree(root: string): Promise<void> {
  await setTreeModes(root, (mode, directory) =>
    directory ? DIRECTORY_MODE : (mode & 0o111) !== 0 ? EXECUTABLE_MODE : FILE_MODE,
  );
}

export async function describeRuntimeTree(
  prefix: string,
  installElapsedMs = 0,
): Promise<SharedNodeRuntime> {
  await sealRuntimeTree(prefix);
  const runtimeRoot = path.join(prefix, "lib/himawari-agent");
  const manifest = await manifestOf(prefix);
  const structure = await structureOf(prefix);
  return {
    prefix,
    runtimeRoot,
    fileCount: manifest.entries.length,
    structureSha256: structure.digest,
    manifestSha256: manifest.digest,
    installElapsedMs,
  };
}

export async function prepareSharedNodeRuntime(options: {
  readonly artifact: string;
  readonly context: string;
}): Promise<SharedNodeRuntime> {
  const prefix = await mkdtemp(path.join(testTemporaryRoot(), "shared-runtime-"));
  const startedAt = Date.now();
  const installed = spawnSync(
    process.execPath,
    [
      installerPath,
      "--prefix",
      prefix,
      "--artifact",
      options.artifact,
      "--context",
      options.context,
    ],
    {
      encoding: "utf8",
      timeout: RUNTIME_INSTALL_TIMEOUT_MS,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  const installElapsedMs = Date.now() - startedAt;
  if (installed.status !== 0) {
    await rm(prefix, { recursive: true, force: true });
    throw new Error(`SHARED_RUNTIME_INSTALL_FAILED:${installed.stderr || installed.stdout}`);
  }
  return describeRuntimeTree(prefix, installElapsedMs);
}

export async function assertSharedRuntime(shared: SharedNodeRuntime): Promise<void> {
  const info = await lstat(shared.runtimeRoot).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    throw new Error(`SHARED_RUNTIME_MISMATCH:${shared.runtimeRoot}:not-a-directory`);
  if ((info.mode & 0o222) !== 0 || (info.mode & 0o022) !== 0)
    throw new Error(`SHARED_RUNTIME_MISMATCH:${shared.runtimeRoot}:not-read-only`);
  if ((await realpath(shared.runtimeRoot)) !== shared.runtimeRoot)
    throw new Error(`SHARED_RUNTIME_MISMATCH:${shared.runtimeRoot}:not-canonical`);
  const structure = await structureOf(shared.prefix);
  if (structure.entries.length !== shared.fileCount || structure.digest !== shared.structureSha256)
    throw new Error(`SHARED_RUNTIME_MISMATCH:${shared.runtimeRoot}:${structure.digest}`);
}

export async function verifySharedRuntime(shared: SharedNodeRuntime): Promise<void> {
  const manifest = await manifestOf(shared.prefix);
  if (manifest.entries.length !== shared.fileCount || manifest.digest !== shared.manifestSha256)
    throw new Error(`SHARED_RUNTIME_MODIFIED:${shared.runtimeRoot}`);
}

export async function removeSharedRuntime(shared: SharedNodeRuntime): Promise<void> {
  let verificationFailure: unknown;
  try {
    await verifySharedRuntime(shared);
  } catch (error) {
    verificationFailure = error;
  }
  await openRuntimeTree(shared.prefix);
  try {
    await rm(shared.prefix, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`SHARED_RUNTIME_CLEANUP_FAILED:${shared.prefix}`, { cause: error });
  }
  if (verificationFailure) throw verificationFailure;
}

export async function selectRuntimeSource(input: {
  readonly shared: SharedNodeRuntime | undefined;
  readonly artifact: string | undefined;
  readonly context: string | undefined;
  readonly errorPrefix: string;
}): Promise<RuntimeSource> {
  const { shared, artifact, context, errorPrefix } = input;
  if (!artifact && !context) return shared ? { kind: "shared", shared } : { kind: "development" };
  if (!artifact || !context) throw new Error(`${errorPrefix}_ARTIFACT_CONTEXT_REQUIRED`);
  if (!shared) throw new Error(`${errorPrefix}_SHARED_RUNTIME_REQUIRED`);
  await assertSharedRuntime(shared);
  return { kind: "shared", shared };
}
