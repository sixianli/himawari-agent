import {
  acquireStateRootLock,
  SQLITE_PERSISTENCE_ERROR_CODES,
  SqlitePersistenceError,
  type StateRootLock,
} from "@himawari-agent/persistence-sqlite";

const TARGET_NOT_STOPPED = "ADMIN_TARGET_NOT_STOPPED";

export async function lockStoppedTarget(stateRoot: string): Promise<StateRootLock> {
  try {
    return await acquireStateRootLock(stateRoot);
  } catch (error) {
    if (
      error instanceof SqlitePersistenceError &&
      error.code === SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCKED
    )
      throw new Error(TARGET_NOT_STOPPED);
    throw error;
  }
}
