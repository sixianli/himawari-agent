import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WorkspacePlatformPort } from "@himawari-agent/application";

type CommitInput = Parameters<WorkspacePlatformPort["commit"]>[0];
type Result = Awaited<ReturnType<WorkspacePlatformPort["commit"]>>;
type Git = (
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<string>;

interface JournalBasis {
  readonly version: 1;
  readonly input: CommitInput;
  readonly ref: string;
  readonly ownerIndexDigest: string;
  readonly nextIndexPath: string;
  readonly lockIdentity: string;
  readonly processId: number;
}

type Journal = JournalBasis &
  (
    | {
        readonly phase: "preparing";
        readonly commit: null;
        readonly nextIndexDigest: null;
        readonly result: null;
      }
    | {
        readonly phase: "prepared";
        readonly commit: string;
        readonly nextIndexDigest: string;
        readonly result: Result | null;
      }
  );

const activeIndexes = new Set<string>();

/** Owns the real index lock and the recoverable HEAD/index publication boundary. */
interface TransactionDependencies {
  readonly git: Git;
  readonly indexPath: string;
  readonly stagingIndexPath: string;
  readonly inspect: () => ReturnType<WorkspacePlatformPort["inspectCommitState"]>;
  readonly remaining: () => Promise<readonly string[]>;
}

export class GitIndexTransaction {
  private readonly dependencies: TransactionDependencies;

  constructor(dependencies: TransactionDependencies) {
    this.dependencies = dependencies;
  }

  async commit(input: CommitInput): Promise<Result> {
    const prior = await this.readJournal();
    if (prior) {
      if (JSON.stringify(prior.input) !== JSON.stringify(input))
        throw new Error("WORKSPACE_COMMIT_OPERATION_CONFLICT");
      const result = await this.reconcile(input.operationId, input.expectedHead);
      if (result) return result;
      throw new Error("WORKSPACE_COMMIT_REQUIRES_REVIEW");
    }
    const { indexPath, stagingIndexPath, git } = this.dependencies;
    if (activeIndexes.has(indexPath)) throw new Error("WORKSPACE_INDEX_LOCKED");
    activeIndexes.add(indexPath);
    let lock: FileHandle | undefined;
    let prepared = false;
    let lockIdentity: string | undefined;
    try {
      lock = await open(
        this.privateLockPath(),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      lockIdentity = identity(await lock.stat());
      const preparing: Journal = {
        version: 1,
        phase: "preparing",
        input,
        commit: null,
        ref: input.expectedBranch ? `refs/heads/${input.expectedBranch}` : "HEAD",
        ownerIndexDigest: input.expectedOwnerIndexDigest,
        nextIndexDigest: null,
        nextIndexPath: `${stagingIndexPath}.owner-next`,
        lockIdentity,
        processId: process.pid,
        result: null,
      };
      // The inode is durable before it can become Git's public lock. A process kill
      // can leave a private orphan, but can never leave an unidentifiable index.lock.
      await lock.sync();
      await durableCreate(this.journalPath(), Buffer.from(JSON.stringify(preparing)));
      await syncDirectory(path.dirname(this.journalPath()));
      await link(this.privateLockPath(), `${indexPath}.lock`);
      await unlink(this.privateLockPath());
      await syncDirectory(path.dirname(indexPath));
      const ownerIndex = await safeRead(indexPath);
      if (digest(ownerIndex) !== input.expectedOwnerIndexDigest)
        throw new Error("WORKSPACE_OWNER_INDEX_CHANGED");
      const current = await this.dependencies.inspect();
      if (
        current.head !== input.expectedHead ||
        current.branch !== input.expectedBranch ||
        current.indexTree !== input.expectedIndexTree ||
        current.ownerIndexDigest !== input.expectedOwnerIndexDigest ||
        current.hooksDigest !== input.expectedHooksDigest ||
        current.configurationDigest !== input.expectedConfigurationDigest
      )
        throw new Error("WORKSPACE_COMMIT_PREVIEW_CHANGED");
      const environment = { GIT_INDEX_FILE: stagingIndexPath };
      const taskPaths = (
        await git(["diff", "--cached", "--name-only", "-z", input.expectedHead], environment)
      )
        .split("\0")
        .filter(Boolean);
      if (taskPaths.length === 0) throw new Error("WORKSPACE_STAGING_SCOPE_CHANGED");
      // No Owner staged entry at a task path may be replaced, even if it existed before preview.
      if (
        (
          await git([
            "diff",
            "--cached",
            "--name-only",
            "-z",
            input.expectedHead,
            "--",
            ...taskPaths,
          ])
        ).length !== 0
      )
        throw new Error("WORKSPACE_OWNER_INDEX_OVERLAP");
      const nextIndexPath = `${stagingIndexPath}.owner-next`;
      await durableCreate(nextIndexPath, ownerIndex);
      for (const taskPath of taskPaths) {
        const entry = (await git(["ls-files", "--stage", "-z", "--", taskPath], environment))
          .split("\0")
          .filter(Boolean);
        if (entry.length === 0)
          await git(["update-index", "--force-remove", "--", taskPath], {
            GIT_INDEX_FILE: nextIndexPath,
          });
        else {
          const match =
            entry.length === 1 ? /^(\d+) ([a-f0-9]{40,64}) 0\t/.exec(entry[0] ?? "") : null;
          if (!match) throw new Error("WORKSPACE_INDEX_ENTRY_UNSAFE");
          await git(
            ["update-index", "--add", "--cacheinfo", `${match[1]},${match[2]},${taskPath}`],
            { GIT_INDEX_FILE: nextIndexPath },
          );
        }
      }
      const nextIndex = await safeRead(nextIndexPath);
      await syncFile(nextIndexPath);
      await lock.writeFile(nextIndex);
      await lock.sync();
      const commit = (
        await git([
          "commit-tree",
          input.expectedIndexTree,
          "-p",
          input.expectedHead,
          "-m",
          input.message,
          "-m",
          `Himawari-Operation-Id: ${input.operationId}`,
        ])
      ).trim();
      const journal: Journal = {
        version: 1,
        phase: "prepared",
        input,
        commit,
        ref: input.expectedBranch ? `refs/heads/${input.expectedBranch}` : "HEAD",
        ownerIndexDigest: digest(ownerIndex),
        nextIndexDigest: digest(nextIndex),
        nextIndexPath,
        lockIdentity,
        processId: process.pid,
        result: null,
      };
      await this.saveJournal(journal);
      prepared = true;
      await git(["update-ref", "--no-deref", journal.ref, commit, input.expectedHead]);
      if ((await git(["rev-parse", "HEAD"])).trim() !== commit)
        throw new Error("WORKSPACE_COMMIT_RECOVERY_HEAD_CHANGED");
      await rename(`${indexPath}.lock`, indexPath);
      await syncDirectory(path.dirname(indexPath));
      return await this.complete(journal);
    } finally {
      await lock?.close();
      if (!prepared && lockIdentity) await this.removeOwnedLock(lockIdentity);
      if (lockIdentity) await this.removePrivateLock(lockIdentity);
      activeIndexes.delete(indexPath);
    }
  }

  async reconcile(operationId: string, expectedParent: string): Promise<Result | null> {
    const journal = await this.readJournal();
    if (!journal) return null;
    if (journal.input.operationId !== operationId || journal.input.expectedHead !== expectedParent)
      throw new Error("WORKSPACE_COMMIT_OPERATION_CONFLICT");
    if (journal.result) return journal.result;
    const { indexPath, git } = this.dependencies;
    if (
      activeIndexes.has(indexPath) ||
      (journal.processId !== process.pid && processAlive(journal.processId))
    )
      throw new Error("WORKSPACE_COMMIT_STILL_RUNNING");
    activeIndexes.add(indexPath);
    try {
      await this.removePrivateLock(journal.lockIdentity);
      if (journal.phase === "preparing") {
        // No reference publication is possible before the prepared phase is durable.
        await this.removeOwnedLock(journal.lockIdentity);
        return null;
      }
      const head = (await git(["rev-parse", "HEAD"])).trim();
      const currentDigest = digest(await safeRead(indexPath));
      if (head === expectedParent) {
        if (currentDigest !== journal.ownerIndexDigest)
          throw new Error("WORKSPACE_COMMIT_RECOVERY_INDEX_CHANGED");
        await this.removeOwnedLock(journal.lockIdentity);
        return null;
      }
      const branch =
        (await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() || null;
      if (head !== journal.commit || branch !== journal.input.expectedBranch)
        throw new Error("WORKSPACE_COMMIT_RECOVERY_HEAD_CHANGED");
      if (
        (await git(["rev-parse", `${head}^`])).trim() !== expectedParent ||
        (await git(["rev-parse", `${head}^{tree}`])).trim() !== journal.input.expectedIndexTree
      )
        throw new Error("WORKSPACE_COMMIT_RECOVERY_OBJECT_CHANGED");
      if (currentDigest !== journal.nextIndexDigest) {
        if (currentDigest !== journal.ownerIndexDigest)
          throw new Error("WORKSPACE_COMMIT_RECOVERY_INDEX_CHANGED");
        const next = await safeRead(journal.nextIndexPath);
        if (digest(next) !== journal.nextIndexDigest)
          throw new Error("WORKSPACE_COMMIT_RECOVERY_ARTIFACT_CHANGED");
        const existingLock = await lstat(`${indexPath}.lock`).catch(missing);
        if (existingLock) {
          if (
            identity(existingLock) !== journal.lockIdentity ||
            digest(await safeRead(`${indexPath}.lock`)) !== journal.nextIndexDigest
          )
            throw new Error("WORKSPACE_INDEX_LOCKED");
        } else {
          const lock = await open(
            this.privateLockPath(),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          const acquiredIdentity = identity(await lock.stat());
          try {
            await lock.writeFile(next);
            await lock.sync();
            await this.saveJournal({
              ...journal,
              lockIdentity: acquiredIdentity,
              processId: process.pid,
            });
            await link(this.privateLockPath(), `${indexPath}.lock`);
            await unlink(this.privateLockPath());
            if (digest(await safeRead(indexPath)) !== journal.ownerIndexDigest)
              throw new Error("WORKSPACE_COMMIT_RECOVERY_INDEX_CHANGED");
          } catch (error) {
            await this.removeOwnedLock(acquiredIdentity);
            throw error;
          } finally {
            await lock.close();
            await this.removePrivateLock(acquiredIdentity);
          }
        }
        if ((await git(["rev-parse", "HEAD"])).trim() !== journal.commit)
          throw new Error("WORKSPACE_COMMIT_RECOVERY_HEAD_CHANGED");
        await rename(`${indexPath}.lock`, indexPath);
        await syncDirectory(path.dirname(indexPath));
      } else await this.removeOwnedLock(journal.lockIdentity);
      return await this.complete(journal);
    } finally {
      activeIndexes.delete(indexPath);
    }
  }

  private async complete(journal: Extract<Journal, { phase: "prepared" }>): Promise<Result> {
    const result: Result = {
      commit: journal.commit,
      parent: journal.input.expectedHead,
      remainingDirtyRefs: await this.dependencies.remaining(),
    };
    await this.saveJournal({ ...journal, result });
    return result;
  }

  private async saveJournal(journal: Journal) {
    const temporary = `${this.journalPath()}.${randomUUID()}.tmp`;
    await durableCreate(temporary, Buffer.from(JSON.stringify(journal)));
    await rename(temporary, this.journalPath());
    await syncDirectory(path.dirname(this.journalPath()));
  }

  private privateLockPath() {
    return `${this.dependencies.stagingIndexPath}.owned-lock`;
  }

  private async removePrivateLock(expectedIdentity: string) {
    const info = await lstat(this.privateLockPath()).catch(missing);
    if (info && identity(info) === expectedIdentity) await unlink(this.privateLockPath());
  }

  private journalPath() {
    return `${this.dependencies.stagingIndexPath}.commit.json`;
  }

  private async readJournal(): Promise<Journal | null> {
    const bytes = await safeRead(this.journalPath()).catch(missing);
    if (!bytes) return null;
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Journal;
    if (
      value.version !== 1 ||
      value.nextIndexPath !== `${this.dependencies.stagingIndexPath}.owner-next` ||
      (value.phase !== "preparing" && value.phase !== "prepared") ||
      (value.phase === "prepared" && !/^[a-f0-9]{40,64}$/.test(value.commit))
    )
      throw new Error("WORKSPACE_COMMIT_JOURNAL_INVALID");
    return value;
  }

  private async removeOwnedLock(expectedIdentity: string) {
    const lockPath = `${this.dependencies.indexPath}.lock`;
    const info = await lstat(lockPath).catch(missing);
    if (info && identity(info) === expectedIdentity) await unlink(lockPath);
  }
}

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function identity(info: { readonly dev: number | bigint; readonly ino: number | bigint }) {
  return `${info.dev}:${info.ino}`;
}
function missing(error: unknown): undefined {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    return undefined;
  throw error;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
async function safeRead(filename: string): Promise<Uint8Array> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("WORKSPACE_INDEX_OBJECT_UNSAFE");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function durableCreate(filename: string, bytes: Uint8Array) {
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
async function syncFile(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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
