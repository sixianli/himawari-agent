import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type CandidateWorkspacePort,
  type CommandProfile,
  type CommandSandboxPort,
  candidatePathsWithinScopes,
  type ImprovementComparison,
  type JsonObject,
  normalizeCandidatePath,
  normalizeCandidateScopes,
  type PayloadRef,
} from "@himawari-agent/application";

const execFile = promisify(execFileCallback);
const environment = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
};

interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly digest: string | null;
}
interface FrozenEntry extends TreeEntry {
  readonly bytes: Uint8Array | null;
}
interface CandidateManifest {
  readonly version: 1;
  readonly candidateId: string;
  readonly baseRevision: string;
  readonly baseDigest: string;
  readonly allowedPaths: readonly string[];
  readonly spaceBudgetBytes: number;
  readonly sourceIdentity: string;
  readonly sourceMode: number;
  readonly baseEntries: readonly TreeEntry[];
  readonly lifecycle: "active" | "quarantining" | "quarantined" | "disposing" | "disposed";
  readonly quarantineReason: string | null;
}
interface CandidateRecord {
  readonly manager: string;
  readonly source: string;
  readonly manifest: CandidateManifest;
}

export class QualifiedCandidateWorkspace implements CandidateWorkspacePort {
  readonly #baseRepository: string;
  readonly #candidateRoot: string;
  readonly #sandbox: CommandSandboxPort;
  readonly #qualification: CandidateWorkspacePort["qualify"];
  readonly #readPayload: (ref: PayloadRef) => Promise<Uint8Array>;
  readonly #protectPayload: (bytes: Uint8Array, contentType: string) => Promise<PayloadRef>;
  readonly #compareRunner: (input: {
    readonly baseRepository: string;
    readonly candidateRoot: string;
    readonly inputSetDigest: string;
    readonly comparisonDefinition: JsonObject;
  }) => Promise<ImprovementComparison>;

  constructor(input: {
    readonly baseRepository: string;
    readonly candidateRoot: string;
    readonly sandbox: CommandSandboxPort;
    readonly qualification: CandidateWorkspacePort["qualify"];
    readonly readPayload: (ref: PayloadRef) => Promise<Uint8Array>;
    readonly protectPayload: (bytes: Uint8Array, contentType: string) => Promise<PayloadRef>;
    readonly compareRunner: (input: {
      readonly baseRepository: string;
      readonly candidateRoot: string;
      readonly inputSetDigest: string;
      readonly comparisonDefinition: JsonObject;
    }) => Promise<ImprovementComparison>;
  }) {
    this.#baseRepository = path.resolve(input.baseRepository);
    this.#candidateRoot = path.resolve(input.candidateRoot);
    this.#sandbox = input.sandbox;
    this.#qualification = input.qualification;
    this.#readPayload = input.readPayload;
    this.#protectPayload = input.protectPayload;
    this.#compareRunner = input.compareRunner;
  }

  qualify() {
    return this.#qualification();
  }

  async create(input: Parameters<CandidateWorkspacePort["create"]>[0]): Promise<string> {
    if (!(await this.qualify()).qualified) throw new Error("CANDIDATE_ISOLATION_NOT_QUALIFIED");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.candidateId) ||
      !Number.isSafeInteger(input.spaceBudgetBytes) ||
      input.spaceBudgetBytes < 1
    )
      throw new Error("CANDIDATE_MANIFEST_INVALID");
    const allowedPaths = normalizeCandidateScopes(input.allowedPaths);
    const base = await realpath(this.#baseRepository);
    const revision = (
      await this.#git(base, ["rev-parse", "--verify", `${input.baseRevision}^{commit}`])
    ).trim();
    const tree = await this.#git(base, ["ls-tree", "-rz", "-r", revision]);
    if (
      tree.split("\0").some((entry) => entry.startsWith("120000 ") || entry.startsWith("160000 "))
    )
      throw new Error("CANDIDATE_BASE_LINK_OR_SUBMODULE_FORBIDDEN");
    await mkdir(this.#candidateRoot, { recursive: true, mode: 0o700 });
    const manager = await mkdtemp(
      path.join(await realpath(this.#candidateRoot), `${input.candidateId}-`),
    );
    const source = path.join(manager, "source");
    try {
      const archive = (
        await execFile("git", ["-C", base, "archive", "--format=tar", revision], {
          encoding: "buffer",
          env: environment,
          maxBuffer: input.spaceBudgetBytes,
        })
      ).stdout;
      if (digest(archive) !== input.baseDigest) throw new Error("CANDIDATE_BASE_DIGEST_CHANGED");
      await mkdir(source, { mode: 0o700 });
      const archivePath = path.join(manager, "base.tar");
      await writeExclusive(archivePath, archive);
      await execFile("tar", ["-xf", archivePath, "-C", source], {
        env: environment,
        maxBuffer: 1024 * 1024,
      });
      await rm(archivePath);
      const entries = await inventory(source, input.spaceBudgetBytes);
      const sourceInfo = await lstat(source);
      const manifest: CandidateManifest = {
        version: 1,
        candidateId: input.candidateId,
        baseRevision: revision,
        baseDigest: input.baseDigest,
        allowedPaths,
        spaceBudgetBytes: input.spaceBudgetBytes,
        sourceIdentity: identity(sourceInfo),
        sourceMode: sourceInfo.mode & 0o7777,
        baseEntries: entries.map(description),
        lifecycle: "active",
        quarantineReason: null,
      };
      await writeExclusive(
        path.join(manager, "manifest.json"),
        Buffer.from(JSON.stringify(manifest)),
      );
      await syncDirectory(manager);
      return source;
    } catch (error) {
      await rm(manager, { recursive: true, force: true });
      throw error;
    }
  }

  async patch(input: Parameters<CandidateWorkspacePort["patch"]>[0]) {
    const record = await this.#active(input.workspaceRef);
    const { manifest, source } = record;
    if (
      manifest.baseDigest !== input.expectedBaseDigest ||
      JSON.stringify(manifest.allowedPaths) !==
        JSON.stringify(normalizeCandidateScopes(input.allowedPaths))
    )
      throw new Error("CANDIDATE_MANIFEST_CHANGED");
    assertTreeScope(manifest, await inventory(source, manifest.spaceBudgetBytes));
    const bytes = await this.#readPayload(input.patchRef);
    if (bytes.byteLength > manifest.spaceBudgetBytes) throw new Error("CANDIDATE_PATCH_TOO_LARGE");
    const temporary = await mkdtemp(path.join(record.manager, ".patch-"));
    try {
      const patchFile = path.join(temporary, "input.patch");
      await writeExclusive(patchFile, bytes);
      const options = {
        cwd: source,
        env: { ...environment, GIT_CEILING_DIRECTORIES: record.manager },
        encoding: "utf8" as const,
      };
      const output = await execFile("git", ["apply", "--numstat", "-z", patchFile], options);
      const changedPaths = patchPaths(output.stdout);
      if (
        changedPaths.length === 0 ||
        !candidatePathsWithinScopes(changedPaths, manifest.allowedPaths)
      )
        throw new Error("CANDIDATE_PATCH_SCOPE_ESCAPE");
      await execFile("git", ["apply", "--check", patchFile], options);
      await execFile("git", ["apply", "--whitespace=error-all", patchFile], options);
      assertTreeScope(manifest, await inventory(source, manifest.spaceBudgetBytes));
      return Object.freeze({
        patchDigest: digest(bytes),
        changedPaths: Object.freeze(changedPaths),
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async validate(input: Parameters<CandidateWorkspacePort["validate"]>[0]) {
    const record = await this.#active(input.workspaceRef);
    const { source, manifest } = record;
    const results = [];
    for (const profile of input.profiles) {
      await this.#assertProfile(profile, input.workspaceRef, source);
      const before = await inventory(source, manifest.spaceBudgetBytes);
      assertTreeScope(manifest, before);
      const observation = await this.#sandbox.execute({
        profile,
        argv: profile.argvPattern,
        secretBindings: [],
      });
      await this.#active(input.workspaceRef);
      const after = await inventory(source, manifest.spaceBudgetBytes);
      const changedPaths = changedTreePaths(before, after);
      const scopePreserved = treeScopePreserved(manifest, after);
      const bytes = Buffer.from(
        JSON.stringify({
          exitCode: observation.exitCode,
          signal: observation.signal,
          timedOut: observation.timedOut,
          outputLimitExceeded: observation.outputLimitExceeded,
          wallTimeMs: observation.wallTimeMs,
          fileObservationRefs: observation.fileObservationRefs,
          networkObservationRefs: observation.networkObservationRefs,
          changedPaths,
          scopePreserved,
        }),
      );
      results.push(
        Object.freeze({
          profileId: profile.id,
          commandObservationRef: await this.#protectPayload(bytes, "application/json"),
          outcome:
            observation.exitCode === 0 &&
            !observation.timedOut &&
            !observation.outputLimitExceeded &&
            observation.networkObservationRefs.length > 0 &&
            observation.networkObservationRefs.every(
              (ref) => ref === "command-network:none:enforced",
            ) &&
            scopePreserved
              ? ("passed" as const)
              : ("failed" as const),
        }),
      );
    }
    return Object.freeze(results);
  }

  async compare(input: Parameters<CandidateWorkspacePort["compare"]>[0]) {
    const record = await this.#active(input.workspaceRef);
    assertTreeScope(
      record.manifest,
      await inventory(record.source, record.manifest.spaceBudgetBytes),
    );
    return this.#compareRunner({
      baseRepository: await realpath(this.#baseRepository),
      candidateRoot: record.source,
      inputSetDigest: input.inputSetDigest,
      comparisonDefinition: input.comparisonDefinition,
    });
  }

  async packageArtifact(input: Parameters<CandidateWorkspacePort["packageArtifact"]>[0]) {
    const record = await this.#active(input.workspaceRef);
    if (input.spaceBudgetBytes !== record.manifest.spaceBudgetBytes)
      throw new Error("CANDIDATE_ARTIFACT_BUDGET_CHANGED");
    const frozen = await inventory(record.source, record.manifest.spaceBudgetBytes);
    assertTreeScope(record.manifest, frozen);
    const temporary = await mkdtemp(path.join(record.manager, ".artifact-"));
    try {
      const staging = path.join(temporary, "tree");
      await mkdir(staging, { mode: 0o700 });
      // Archive only captured, checked bytes. Never reread mutable source files for publication.
      for (const entry of frozen) {
        const destination = path.join(staging, entry.path);
        if (entry.kind === "directory") await mkdir(destination, { recursive: true, mode: 0o700 });
        else {
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          if (!entry.bytes) throw new Error("CANDIDATE_ARTIFACT_BYTES_MISSING");
          await writeExclusive(destination, entry.bytes);
          await chmod(destination, entry.mode);
        }
      }
      for (const entry of [...frozen].reverse())
        if (entry.kind === "directory") await chmod(path.join(staging, entry.path), entry.mode);
      const archive = (
        await execFile("tar", ["-cf", "-", "-C", staging, "."], {
          encoding: "buffer",
          env: environment,
          maxBuffer: input.spaceBudgetBytes,
        })
      ).stdout;
      if (archive.byteLength > input.spaceBudgetBytes)
        throw new Error("CANDIDATE_ARTIFACT_SPACE_EXCEEDED");
      return Object.freeze({
        artifactRef: await this.#protectPayload(archive, "application/x-tar"),
        artifactDigest: digest(archive),
      });
    } finally {
      // These directories contain only manager-created frozen bytes, outside the sandbox.
      for (const entry of frozen)
        if (entry.kind === "directory")
          await chmod(path.join(temporary, "tree", entry.path), 0o700).catch(missing);
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async quarantine(workspaceRef: string, reasonCode: string): Promise<void> {
    const record = await this.#record(workspaceRef);
    if (record.manifest.lifecycle === "disposed" || record.manifest.lifecycle === "quarantined")
      return;
    await this.#saveManifest(record, {
      ...record.manifest,
      lifecycle: "quarantining",
      quarantineReason: reasonCode,
    });
    const destination = path.join(record.manager, "quarantine");
    const sourceInfo = await lstat(record.source).catch(missing);
    const destinationInfo = await lstat(destination).catch(missing);
    if (sourceInfo) {
      assertDirectoryIdentity(sourceInfo, record.manifest.sourceIdentity);
      if (destinationInfo) throw new Error("CANDIDATE_QUARANTINE_TARGET_EXISTS");
      await rename(record.source, destination);
    } else if (destinationInfo)
      assertDirectoryIdentity(destinationInfo, record.manifest.sourceIdentity);
    await this.#saveManifest(record, {
      ...record.manifest,
      lifecycle: "quarantined",
      quarantineReason: reasonCode,
    });
  }

  async dispose(workspaceRef: string): Promise<void> {
    const record = await this.#record(workspaceRef);
    const locations = [record.source, path.join(record.manager, "quarantine")];
    for (const location of locations) {
      const info = await lstat(location).catch(missing);
      if (info) assertDirectoryIdentity(info, record.manifest.sourceIdentity);
    }
    await this.#saveManifest(record, { ...record.manifest, lifecycle: "disposing" });
    for (const location of locations) await rm(location, { recursive: true, force: true });
    for (const name of await readdir(record.manager)) {
      if (
        name === "base.tar" ||
        /^\.(?:artifact|patch)-[A-Za-z0-9]{6}$/.test(name) ||
        /^\.manifest-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)
      )
        await removeManagerScratch(path.join(record.manager, name));
    }
    await this.#saveManifest(record, { ...record.manifest, lifecycle: "disposed" });
  }

  async #record(reference: string): Promise<CandidateRecord> {
    if (!path.isAbsolute(reference) || path.basename(reference) !== "source")
      throw new Error("CANDIDATE_WORKSPACE_SCOPE_INVALID");
    const manager = await realpath(path.dirname(reference));
    const root = await realpath(this.#candidateRoot);
    if (
      path.dirname(manager) !== root ||
      !/^[A-Za-z0-9._:-]+-[A-Za-z0-9]+$/.test(path.basename(manager)) ||
      path.resolve(reference) !== path.join(manager, "source")
    )
      throw new Error("CANDIDATE_WORKSPACE_SCOPE_INVALID");
    const manifest = JSON.parse(
      Buffer.from(await readSafeFile(path.join(manager, "manifest.json"))).toString("utf8"),
    ) as CandidateManifest;
    if (
      manifest.version !== 1 ||
      !manifest.candidateId ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.baseDigest) ||
      !Array.isArray(manifest.baseEntries) ||
      !Number.isSafeInteger(manifest.spaceBudgetBytes) ||
      !/^[0-9]+:[0-9]+$/.test(manifest.sourceIdentity)
    )
      throw new Error("CANDIDATE_MANIFEST_INVALID");
    normalizeCandidateScopes(manifest.allowedPaths);
    for (const entry of manifest.baseEntries) {
      normalizeCandidatePath(entry.path);
      if (
        !["file", "directory"].includes(entry.kind) ||
        !Number.isSafeInteger(entry.mode) ||
        (entry.kind === "file" && !/^sha256:[a-f0-9]{64}$/.test(entry.digest ?? ""))
      )
        throw new Error("CANDIDATE_MANIFEST_INVALID");
    }
    return { manager, source: path.join(manager, "source"), manifest };
  }

  async #active(reference: string): Promise<CandidateRecord> {
    const record = await this.#record(reference);
    if (record.manifest.lifecycle !== "active") throw new Error("CANDIDATE_WORKSPACE_NOT_ACTIVE");
    const info = await lstat(record.source);
    assertDirectoryIdentity(info, record.manifest.sourceIdentity);
    if ((info.mode & 0o7777) !== record.manifest.sourceMode)
      throw new Error("CANDIDATE_ROOT_MODE_CHANGED");
    return record;
  }

  async #assertProfile(profile: CommandProfile, reference: string, source: string) {
    if (
      profile.workspaceId !== reference ||
      !path.isAbsolute(profile.workdir) ||
      profile.fileScopes.length !== 1 ||
      !path.isAbsolute(profile.fileScopes[0] ?? "") ||
      (await realpath(profile.workdir)) !== source ||
      (await realpath(profile.fileScopes[0] ?? "")) !== source ||
      profile.network !== "none" ||
      profile.environmentNames.length !== 0 ||
      profile.sandboxTier !== "isolated-high-risk" ||
      profile.revokedAt !== null
    )
      throw new Error("CANDIDATE_COMMAND_PROFILE_SCOPE_INVALID");
  }

  async #saveManifest(record: CandidateRecord, manifest: CandidateManifest) {
    const temporary = path.join(record.manager, `.manifest-${randomUUID()}`);
    try {
      await writeExclusive(temporary, Buffer.from(JSON.stringify(manifest)));
      await rename(temporary, path.join(record.manager, "manifest.json"));
      await syncDirectory(record.manager);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #git(root: string, args: readonly string[]): Promise<string> {
    return (
      await execFile("git", ["-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: environment,
      })
    ).stdout;
  }
}

async function inventory(root: string, maximumBytes: number): Promise<readonly FrozenEntry[]> {
  const entries: FrozenEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const relative = normalizeCandidatePath(prefix ? `${prefix}/${name}` : name);
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (info.mode & 0o7000) !== 0)
        throw new Error("CANDIDATE_VALIDATION_LINK_OR_MODE_FORBIDDEN");
      if ((await realpath(absolute)) !== absolute)
        throw new Error("CANDIDATE_VALIDATION_LINK_FORBIDDEN");
      if (info.isDirectory()) {
        entries.push({
          path: relative,
          kind: "directory",
          mode: info.mode & 0o7777,
          digest: null,
          bytes: null,
        });
        await visit(absolute, relative);
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size + totalBytes > maximumBytes)
          throw new Error("CANDIDATE_VALIDATION_OBJECT_OR_SIZE_FORBIDDEN");
        const bytes = await readSafeFile(absolute);
        totalBytes += bytes.byteLength;
        if (totalBytes > maximumBytes) throw new Error("CANDIDATE_SPACE_BUDGET_EXCEEDED");
        const after = await lstat(absolute);
        if (identity(info) !== identity(after) || info.mode !== after.mode)
          throw new Error("CANDIDATE_FILE_CHANGED_DURING_SNAPSHOT");
        entries.push({
          path: relative,
          kind: "file",
          mode: info.mode & 0o7777,
          digest: digest(bytes),
          bytes,
        });
      }
    }
  };
  await visit(root, "");
  return entries;
}
function description(entry: TreeEntry): TreeEntry {
  return { path: entry.path, kind: entry.kind, mode: entry.mode, digest: entry.digest };
}
function fingerprint(entry: TreeEntry) {
  return `${entry.kind}:${entry.mode}:${entry.digest}`;
}
function changedTreePaths(
  before: readonly TreeEntry[],
  after: readonly TreeEntry[],
): readonly string[] {
  const previous = new Map(before.map((entry) => [entry.path, fingerprint(entry)]));
  const current = new Map(after.map((entry) => [entry.path, fingerprint(entry)]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((relative) => previous.get(relative) !== current.get(relative))
    .sort();
}
function treeScopePreserved(manifest: CandidateManifest, after: readonly TreeEntry[]): boolean {
  const beforeByPath = new Map(manifest.baseEntries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  return changedTreePaths(manifest.baseEntries, after).every((relative) => {
    const before = beforeByPath.get(relative);
    const current = afterByPath.get(relative);
    if (before && current && before.kind !== current.kind) return false;
    if (candidatePathsWithinScopes([relative], manifest.allowedPaths)) return true;
    // Creating/removing a structural parent directory is necessary for an explicitly allowed child.
    return (
      (!before || !current) &&
      (before ?? current)?.kind === "directory" &&
      manifest.allowedPaths.some((scope) => scope.startsWith(`${relative}/`))
    );
  });
}
function assertTreeScope(manifest: CandidateManifest, entries: readonly TreeEntry[]) {
  if (!treeScopePreserved(manifest, entries)) throw new Error("CANDIDATE_ARTIFACT_SCOPE_CHANGED");
}
function patchPaths(value: string): string[] {
  const fields = value.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(?:[0-9]+|-)\t(?:[0-9]+|-)\t(.*)$/.exec(field);
    if (!match) throw new Error("CANDIDATE_PATCH_PATH_INVALID");
    if (match[1]) paths.push(normalizeCandidatePath(match[1]));
    else {
      paths.push(
        normalizeCandidatePath(fields[++index] ?? ""),
        normalizeCandidatePath(fields[++index] ?? ""),
      );
    }
  }
  return [...new Set(paths)].sort();
}
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function identity(info: { readonly dev: number | bigint; readonly ino: number | bigint }) {
  return `${String(info.dev)}:${String(info.ino)}`;
}
function assertDirectoryIdentity(info: Awaited<ReturnType<typeof lstat>>, expected: string) {
  if (!info.isDirectory() || info.isSymbolicLink() || identity(info) !== expected)
    throw new Error("CANDIDATE_WORKSPACE_IDENTITY_CHANGED");
}
function missing(error: unknown): undefined {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    return undefined;
  throw error;
}

/** Manager-owned scratch never enters a sandbox; links are removed without following their target. */
async function removeManagerScratch(filename: string): Promise<void> {
  const info = await lstat(filename).catch(missing);
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(filename, 0o700);
    for (const name of await readdir(filename))
      await removeManagerScratch(path.join(filename, name));
  }
  await rm(filename, { recursive: true, force: true });
}
async function readSafeFile(filename: string): Promise<Uint8Array> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("CANDIDATE_OBJECT_UNSAFE");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function writeExclusive(filename: string, bytes: Uint8Array) {
  const file = await open(
    filename,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(directory: string) {
  const file = await open(directory, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
