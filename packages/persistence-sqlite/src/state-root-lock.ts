import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const SQLITE_PERSISTENCE_ERROR_CODES = Object.freeze({
  STATE_ROOT_LOCKED: "SQLITE_STATE_ROOT_LOCKED",
  STATE_ROOT_LOCK_CORRUPT: "SQLITE_STATE_ROOT_LOCK_CORRUPT",
  WORKER_EXITED: "SQLITE_WORKER_EXITED",
  WORKER_OPERATION_FAILED: "SQLITE_WORKER_OPERATION_FAILED",
  REPOSITORY_CLOSED: "SQLITE_REPOSITORY_CLOSED",
} as const);

export type SqlitePersistenceErrorCode =
  (typeof SQLITE_PERSISTENCE_ERROR_CODES)[keyof typeof SQLITE_PERSISTENCE_ERROR_CODES];

export class SqlitePersistenceError extends Error {
  readonly code: SqlitePersistenceErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: SqlitePersistenceErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "SqlitePersistenceError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

interface LockOwner {
  readonly schemaVersion: 1;
  readonly host: string;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseOwner(content: string): LockOwner {
  let candidate: Partial<LockOwner>;
  try {
    candidate = JSON.parse(content) as Partial<LockOwner>;
  } catch {
    throw new SqlitePersistenceError(
      SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCK_CORRUPT,
      "The state-root lock owner record is not valid JSON",
    );
  }
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.host !== "string" ||
    typeof candidate.pid !== "number" ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.token !== "string" ||
    typeof candidate.acquiredAt !== "string"
  ) {
    throw new SqlitePersistenceError(
      SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCK_CORRUPT,
      "The state-root lock owner record is invalid",
    );
  }
  return candidate as LockOwner;
}

export class StateRootLock {
  readonly stateRoot: string;
  readonly lockPath: string;
  private readonly owner: LockOwner;
  private released = false;

  constructor(stateRoot: string, lockPath: string, owner: LockOwner) {
    this.stateRoot = stateRoot;
    this.lockPath = lockPath;
    this.owner = owner;
  }

  async release(): Promise<void> {
    if (this.released) return;
    const current = parseOwner(await readFile(path.join(this.lockPath, "owner.json"), "utf8"));
    if (current.token !== this.owner.token) {
      throw new SqlitePersistenceError(
        SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCKED,
        "The state-root lock is now owned by another process",
        { ownerPid: String(current.pid), ownerHost: current.host },
      );
    }
    await rm(this.lockPath, { recursive: true });
    this.released = true;
  }
}

export async function acquireStateRootLock(stateRootInput: string): Promise<StateRootLock> {
  const stateRoot = path.resolve(stateRootInput);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateRoot, ".himawari-state-root.lock");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    const candidatePath = path.join(stateRoot, `.himawari-lock-candidate-${process.pid}-${token}`);
    const owner: LockOwner = Object.freeze({
      schemaVersion: 1,
      host: hostname(),
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    });
    await mkdir(candidatePath, { mode: 0o700 });
    try {
      await writeFile(path.join(candidatePath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
      });
      await rename(candidatePath, lockPath);
      return new StateRootLock(stateRoot, lockPath, owner);
    } catch (error) {
      await rm(candidatePath, { recursive: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }

    let current: LockOwner;
    try {
      current = parseOwner(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (current.host !== hostname() || isProcessAlive(current.pid)) {
      throw new SqlitePersistenceError(
        SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCKED,
        "The state root is already owned by a live process",
        { ownerPid: String(current.pid), ownerHost: current.host },
      );
    }

    const stalePath = path.join(stateRoot, `.himawari-stale-lock-${current.token}`);
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  throw new SqlitePersistenceError(
    SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCKED,
    "The state-root lock changed repeatedly during acquisition",
  );
}
