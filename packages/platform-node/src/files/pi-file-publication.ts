import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { HostDirectoryGrant, HostFilePublication } from "@himawari-agent/application";
import { type SandboxScope, sandboxScopeSchema } from "@himawari-agent/execution-contracts";
import { ConstrainedHostFileSystem } from "./constrained-file-system.js";

export interface PiPreparedFileWrite {
  readonly relativePath: string;
  readonly publication: HostFilePublication;
  readonly contentDigest: string;
  readonly byteLength: number;
}
export interface PiVerifiedFileWrite {
  readonly path: string;
  readonly contentDigest: string;
  readonly byteLength: number;
}
interface Context {
  readonly privateDirectory: string;
  readonly workspace: string;
  readonly scope: SandboxScope;
  readonly parametersJson: string;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(): never {
  throw new Error("PI_PUBLICATION_RECORD_INVALID");
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const length = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 16 * 1024 * 1024;
const identityPart = (value: unknown) => typeof value === "string" && /^[0-9]+$/.test(value);

/** Shared durable, scope-bound records for installed fixed-operation runners. */
export function createPrivatePublicationRecords<K extends string>(input: {
  readonly privateDirectory: string;
  readonly bindingDigest: string;
  readonly names: Readonly<Record<K, string>>;
  readonly maximumBytes?: number;
}) {
  const { bindingDigest, names } = input;
  const directory = async () => {
    if ((await realpath(input.privateDirectory)) !== input.privateDirectory) fail();
    const info = await lstat(input.privateDirectory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      fail();
    return `${info.dev}:${info.ino}`;
  };
  const syncDirectory = async () => {
    const fd = await open(input.privateDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  };
  const read = async (kind: K): Promise<unknown | undefined> => {
    const parent = await directory();
    const filename = path.join(input.privateDirectory, names[kind]);
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!fd) return undefined;
    try {
      const before = await fd.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > (input.maximumBytes ?? 32768) ||
        (before.mode & 0o077) !== 0
      )
        fail();
      const bytes = Buffer.alloc(before.size);
      for (let offset = 0; offset < bytes.length; ) {
        const read = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) fail();
        offset += read.bytesRead;
      }
      const after = await fd.stat();
      const current = await lstat(filename);
      if (
        bytes.length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.nlink !== 1 ||
        parent !== (await directory())
      )
        fail();
      const parsed = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (
        parsed["schemaVersion"] !== `pi-file-${kind}.v1` ||
        parsed["bindingDigest"] !== bindingDigest
      )
        fail();
      return parsed["proof"];
    } finally {
      await fd.close();
    }
  };
  const write = async (kind: K, proof: unknown) => {
    const parent = await directory();
    const temporary = path.join(input.privateDirectory, `pi-publication-${randomUUID()}.tmp`);
    const destination = path.join(input.privateDirectory, names[kind]);
    const bytes = Buffer.from(
      JSON.stringify({ schemaVersion: `pi-file-${kind}.v1`, bindingDigest, proof }),
    );
    if (bytes.length > (input.maximumBytes ?? 32768)) fail();
    const fd = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (parent !== (await directory())) fail();
    // A prior record is never replaced. An interrupted preparation cannot become
    // a second write by reopening the runner with the same private directory.
    await link(temporary, destination);
    await unlink(temporary);
    await syncDirectory();
    if (parent !== (await directory())) fail();
  };
  return { read, write };
}

/** Private metadata for one installed fixed-file runner. It contains no candidate
 * text and grants no execution right. Scope and parsed input bind every record. */
export function createPiFilePublicationJournal(value: Context) {
  const copy = structuredClone(value);
  const input = { ...copy, scope: sandboxScopeSchema.parse(copy.scope) };
  const target = input.scope.fileTarget ?? fail();
  if (
    !target ||
    !["write", "edit"].includes(input.scope.operation) ||
    !path.isAbsolute(input.workspace) ||
    path.normalize(input.workspace) !== input.workspace ||
    !path.isAbsolute(input.privateDirectory) ||
    path.normalize(input.privateDirectory) !== input.privateDirectory ||
    input.privateDirectory === input.workspace ||
    input.privateDirectory.startsWith(`${input.workspace}/`) ||
    input.workspace.startsWith(`${input.privateDirectory}/`) ||
    Buffer.byteLength(input.parametersJson) > 49152
  )
    fail();
  const parameters = record(JSON.parse(input.parametersJson));
  if (
    typeof parameters["path"] !== "string" ||
    path.resolve(input.workspace, parameters["path"]) !==
      path.join(input.workspace, target.relativePath)
  )
    fail();
  const bindingDigest = hash(
    JSON.stringify([input.scope, input.workspace, input.privateDirectory, parameters]),
  );
  const names = {
    prepared: "pi-file-prepared.v1.json",
    verified: "pi-file-verified.v1.json",
    commit: "pi-file-commit.v1.json",
    conflict: "pi-file-conflict.v1.json",
  } as const;
  const { read, write } = createPrivatePublicationRecords({ ...input, bindingDigest, names });
  type Parent = { readonly device: string; readonly inode: string };
  const captureParents = async (): Promise<readonly Parent[]> => {
    let current = input.workspace;
    const parents: Parent[] = [];
    const parts = target.relativePath.split("/");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) current = path.join(current, parts[index - 1] as string);
      const info = await lstat(current);
      const expected = target.lineage[index];
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        String(info.dev) !== target.lineage[0]?.device ||
        (expected && String(info.ino) !== expected.inode)
      )
        fail();
      parents.push({ device: String(info.dev), inode: String(info.ino) });
    }
    return parents;
  };
  const prepared = (
    value: unknown,
  ): PiPreparedFileWrite & { readonly parents: readonly Parent[] } => {
    const proof = record(value),
      publication = record(proof["publication"]),
      identity = record(publication["identity"]);
    if (
      proof["relativePath"] !== target.relativePath ||
      !digest(proof["contentDigest"]) ||
      !length(proof["byteLength"]) ||
      typeof publication["stagedRelativePath"] !== "string" ||
      !/^\.himawari-recovery\/staged-[0-9a-f-]{36}\.tmp$/.test(publication["stagedRelativePath"]) ||
      identity["canonicalPath"] !== path.join(input.workspace, publication["stagedRelativePath"]) ||
      !identityPart(identity["device"]) ||
      !identityPart(identity["inode"]) ||
      identity["device"] !== target.lineage[0]?.device ||
      !Number.isSafeInteger(identity["mode"]) ||
      (Number(identity["mode"]) & constants.S_IFMT) !== constants.S_IFREG ||
      identity["linkCount"] !== 1 ||
      identity["sizeBytes"] !== proof["byteLength"] ||
      typeof identity["modifiedAtMillis"] !== "number" ||
      !Number.isFinite(identity["modifiedAtMillis"]) ||
      !Array.isArray(proof["parents"]) ||
      proof["parents"].length !== target.relativePath.split("/").length ||
      proof["parents"].some((item: unknown, index: number) => {
        const parent = record(item),
          expected = target.lineage[index];
        return (
          !identityPart(parent["device"]) ||
          !identityPart(parent["inode"]) ||
          parent["device"] !== target.lineage[0]?.device ||
          (expected !== undefined && parent["inode"] !== expected.inode)
        );
      })
    )
      fail();
    return structuredClone(proof) as unknown as PiPreparedFileWrite & {
      readonly parents: readonly Parent[];
    };
  };
  const verified = (value: unknown, preparation: PiPreparedFileWrite): PiVerifiedFileWrite => {
    const proof = record(value);
    if (
      proof["path"] !== path.join(input.workspace, target.relativePath) ||
      proof["contentDigest"] !== preparation.contentDigest ||
      proof["byteLength"] !== preparation.byteLength
    )
      fail();
    return {
      path: proof["path"] as string,
      contentDigest: preparation.contentDigest,
      byteLength: preparation.byteLength,
    };
  };
  const conflictProof = {
    reasonCode: "FILE_VERSION_CONFLICT",
    phase: "before_publish",
    target,
    candidateDigest: input.scope.preparedFile?.contentDigest,
  };
  return {
    async commitStarting() {
      if (await read("conflict")) fail();
      await write("commit", { target });
    },
    async conflicted() {
      if (
        !input.scope.preparedFile ||
        target.missingParents ||
        (await read("commit")) ||
        (await read("verified"))
      )
        fail();
      await write("conflict", conflictProof);
      return conflictProof;
    },
    async recoverConflict() {
      const proof = await read("conflict");
      if (proof === undefined) return undefined;
      if (
        !input.scope.preparedFile ||
        target.missingParents ||
        (await read("commit")) ||
        (await read("verified")) ||
        JSON.stringify(proof) !== JSON.stringify(conflictProof)
      )
        fail();
      return conflictProof;
    },
    async prepared(value: PiPreparedFileWrite) {
      const proof = structuredClone(value);
      await write("prepared", prepared({ ...proof, parents: await captureParents() }));
    },
    async verified(value: PiVerifiedFileWrite) {
      const before = prepared(await read("prepared"));
      await write("verified", verified(value, before));
    },
    /** Caller must first establish that the original Job Host can no longer write.
     * This can remove only this publication's private alias; it never republishes
     * candidate bytes, consumes a Grant or starts a tool. */
    async recover(grant: HostDirectoryGrant): Promise<PiVerifiedFileWrite | undefined> {
      grant = structuredClone(grant);
      if (
        grant.id !== input.scope.directoryGrant.ref ||
        grant.revision !== input.scope.directoryGrant.revision ||
        grant.canonicalRootId !== input.scope.directoryGrant.canonicalRootId ||
        grant.displayPath !== input.workspace ||
        grant.hostId !== input.scope.hostId ||
        grant.authorizationRef !== input.scope.directoryGrant.authorizationRef
      )
        fail();
      const raw = await read("prepared");
      if (raw === undefined) return undefined;
      const preparation = prepared(raw);
      const final = await read("verified");
      // Already witnessed effects remain historical facts even if a later user
      // edit changes the path. Recovery must never overwrite that later edit.
      if (final !== undefined) return verified(final, preparation);
      if (JSON.stringify(await captureParents()) !== JSON.stringify(preparation.parents)) fail();
      const platform = new ConstrainedHostFileSystem();
      const identity = await platform.recoverPublication(
        grant,
        target.relativePath,
        preparation.publication,
      );
      const bytes = await platform.read(
        grant,
        target.relativePath,
        Math.max(1, preparation.byteLength),
        identity,
      );
      if (bytes.byteLength !== preparation.byteLength || hash(bytes) !== preparation.contentDigest)
        fail();
      if (JSON.stringify(await captureParents()) !== JSON.stringify(preparation.parents)) fail();
      const proof = {
        path: path.join(input.workspace, target.relativePath),
        contentDigest: preparation.contentDigest,
        byteLength: preparation.byteLength,
      };
      // Recovery returns evidence. Only the caller's protected durable artifact
      // can accept it; no new runner receipt is fabricated here.
      return proof;
    },
  };
}
