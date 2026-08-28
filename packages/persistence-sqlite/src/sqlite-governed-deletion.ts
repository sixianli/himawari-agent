import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import BetterSqlite3 from "better-sqlite3";
import { acquireStateRootLock } from "./state-root-lock.js";

const TRASH_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export const GOVERNED_DELETION_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "GOVERNED_DELETION_INVALID_INPUT",
  TARGET_NOT_STOPPED: "GOVERNED_DELETION_TARGET_NOT_STOPPED",
  NOT_FOUND: "GOVERNED_DELETION_NOT_FOUND",
  CONFLICT: "GOVERNED_DELETION_CONFLICT",
  PROVIDER_CLEANUP_REQUIRED: "GOVERNED_DELETION_PROVIDER_CLEANUP_REQUIRED",
  TARGET_FAILED: "GOVERNED_DELETION_TARGET_FAILED",
} as const);

export type GovernedDeletionErrorCode =
  (typeof GOVERNED_DELETION_ERROR_CODES)[keyof typeof GOVERNED_DELETION_ERROR_CODES];

export class GovernedDeletionError extends Error {
  readonly code: GovernedDeletionErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: GovernedDeletionErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "GovernedDeletionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export type GovernedDeletionObjectType = "thread" | "run" | "task" | "memory" | "payload";
export type TrashableDeletionObjectType = "thread" | "task" | "memory";
export type GovernedDeletionTarget =
  | "product"
  | "payload"
  | "trace"
  | "inbox"
  | "search"
  | "cache"
  | "archive";
export type GovernedDeletionTargetStatus = "pending" | "retained" | "verified" | "failed";

export interface GovernedDeletionTargetState {
  readonly status: GovernedDeletionTargetStatus;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly verifiedAt: string | null;
}

export interface GovernedDeletionReport {
  readonly deletionId: string;
  readonly objectType: GovernedDeletionObjectType;
  readonly objectId: string;
  readonly lifecycle: "active" | "trashed" | "deletion_pending" | "deleted_verified";
  readonly purgeDeadlineAt: string;
  readonly targets: Readonly<Record<GovernedDeletionTarget, GovernedDeletionTargetState>>;
  readonly payloadFileCount: number;
  readonly externalEffectTombstoneCount: number;
  readonly associatedTaskIds: readonly string[];
  readonly pausedTaskIds: readonly string[];
  readonly priorProductStatus: string | null;
  readonly updatedAt: string;
}

interface StoredDeletionRecord extends GovernedDeletionReport {
  readonly pendingPayloadFiles: readonly string[];
}

interface PayloadCandidate {
  readonly ref: string;
  readonly storageKind: "sqlite_blob" | "ciphertext_file";
  readonly ciphertextPath: string | null;
}

interface CoreDeletionResult {
  readonly pendingPayloadFiles: readonly string[];
  readonly externalEffectTombstoneCount: number;
}

export interface SqliteGovernedDeletionAdapterOptions {
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly searchRoot?: string;
  readonly cacheRoot?: string;
  readonly archiveRoot?: string;
  readonly now?: () => string;
  readonly fault?: (target: GovernedDeletionTarget) => void | Promise<void>;
}

const TARGETS: readonly GovernedDeletionTarget[] = [
  "product",
  "payload",
  "trace",
  "inbox",
  "search",
  "cache",
  "archive",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new GovernedDeletionError(
      GOVERNED_DELETION_ERROR_CODES.INVALID_INPUT,
      `Governed deletion ${label} is invalid`,
    );
  }
  return value;
}

function deletionId(objectType: GovernedDeletionObjectType, objectId: string): string {
  return `deletion-${objectType}-${sha256(objectId).slice(0, 24)}`;
}

function targetState(
  status: GovernedDeletionTargetStatus,
  attempts = 0,
  errorCode: string | null = null,
  verifiedAt: string | null = null,
): GovernedDeletionTargetState {
  return Object.freeze({ status, attempts, errorCode, verifiedAt });
}

function initialTargets(mode: "trash" | "delete"): GovernedDeletionReport["targets"] {
  return Object.freeze({
    product: targetState("verified"),
    payload: targetState(mode === "trash" ? "retained" : "pending"),
    trace: targetState(mode === "trash" ? "retained" : "pending"),
    inbox: targetState(mode === "trash" ? "retained" : "pending"),
    search: targetState("pending"),
    cache: targetState("pending"),
    archive: targetState(mode === "trash" ? "retained" : "pending"),
  });
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("Unsafe SQLite identifier");
  return `"${value}"`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function unique(values: readonly (string | null | undefined)[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value): value is string => Boolean(value)))]);
}

export function managedDeletionArtifactPath(
  root: string,
  target: "search" | "cache" | "archive",
  objectType: GovernedDeletionObjectType,
  objectId: string,
): string {
  if (!path.isAbsolute(root)) {
    throw new GovernedDeletionError(
      GOVERNED_DELETION_ERROR_CODES.INVALID_INPUT,
      "Managed deletion artifact root must be absolute",
    );
  }
  safeIdentity(objectId, "object ID");
  return path.join(path.resolve(root), target, objectType, `${sha256(objectId)}.artifact`);
}

export class SqliteGovernedDeletionAdapter {
  readonly #options: Readonly<
    SqliteGovernedDeletionAdapterOptions & {
      stateRoot: string;
      databasePath: string;
      searchRoot: string;
      cacheRoot: string;
      archiveRoot: string;
    }
  >;
  readonly #now: () => string;

  constructor(options: SqliteGovernedDeletionAdapterOptions) {
    const stateRoot = path.resolve(options.stateRoot);
    const databasePath = path.resolve(options.databasePath);
    const searchRoot = path.resolve(options.searchRoot ?? path.join(stateRoot, "data"));
    const cacheRoot = path.resolve(options.cacheRoot ?? path.join(stateRoot, "cache"));
    const archiveRoot = path.resolve(options.archiveRoot ?? path.join(stateRoot, "data"));
    if (
      !path.isAbsolute(options.stateRoot) ||
      !path.isAbsolute(options.databasePath) ||
      databasePath !== path.join(stateRoot, "data", "product.sqlite") ||
      ![searchRoot, cacheRoot, archiveRoot].every(
        (root) => root === stateRoot || root.startsWith(`${stateRoot}${path.sep}`),
      )
    ) {
      throw new GovernedDeletionError(
        GOVERNED_DELETION_ERROR_CODES.INVALID_INPUT,
        "Governed deletion paths are outside the state root",
      );
    }
    this.#options = Object.freeze({
      ...options,
      stateRoot,
      databasePath,
      searchRoot,
      cacheRoot,
      archiveRoot,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  inspectThreadImpact(threadIdInput: string): Readonly<{
    associatedTaskIds: readonly string[];
    activeTaskIds: readonly string[];
  }> {
    const threadId = safeIdentity(threadIdInput, "thread ID");
    const database = this.#database(true);
    try {
      const thread = database
        .prepare("SELECT id FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(threadId, this.#options.ownerId, this.#options.agentId);
      if (!thread) this.#failNotFound("thread", threadId);
      const associatedTaskIds = this.#values(
        database,
        `SELECT id FROM scheduled_jobs
        WHERE thread_id = ? AND owner_id = ? AND agent_id = ? AND status != 'revoked'
        ORDER BY id`,
        [threadId, this.#options.ownerId, this.#options.agentId],
      );
      const activeTaskIds = this.#values(
        database,
        `SELECT id FROM scheduled_jobs
        WHERE thread_id = ? AND owner_id = ? AND agent_id = ? AND status = 'active'
        ORDER BY id`,
        [threadId, this.#options.ownerId, this.#options.agentId],
      );
      return Object.freeze({ associatedTaskIds, activeTaskIds });
    } finally {
      database.close();
    }
  }

  trashThread(threadId: string): Promise<GovernedDeletionReport> {
    return this.trashObject({ objectType: "thread", objectId: threadId });
  }

  async trashObject(input: {
    readonly objectType: TrashableDeletionObjectType;
    readonly objectId: string;
  }): Promise<GovernedDeletionReport> {
    const objectId = safeIdentity(input.objectId, "object ID");
    const lock = await this.#lock();
    try {
      const database = this.#database();
      try {
        const now = this.#now();
        const deadline = new Date(Date.parse(now) + TRASH_RETENTION_MILLISECONDS).toISOString();
        const report = database
          .transaction(() => {
            const table =
              input.objectType === "thread"
                ? "threads"
                : input.objectType === "task"
                  ? "scheduled_jobs"
                  : "memory_records";
            const row = database
              .prepare(
                `SELECT status FROM ${quoteIdentifier(table)}
                WHERE id = ? AND owner_id = ? AND agent_id = ?`,
              )
              .get(objectId, this.#options.ownerId, this.#options.agentId) as
              | { status: string }
              | undefined;
            if (!row) this.#failNotFound(input.objectType, objectId);
            const allowed =
              input.objectType === "thread"
                ? ["open", "trashed"]
                : input.objectType === "task"
                  ? ["active", "paused"]
                  : ["active", "archived", "trashed"];
            if (!allowed.includes(row.status)) {
              throw new GovernedDeletionError(
                GOVERNED_DELETION_ERROR_CODES.CONFLICT,
                `Governed deletion ${input.objectType} cannot enter Trash from ${row.status}`,
              );
            }
            const previous = this.#storedRecord(database, input.objectType, objectId);
            const associatedTaskIds =
              input.objectType === "thread"
                ? this.#values(
                    database,
                    `SELECT id FROM scheduled_jobs
                    WHERE thread_id = ? AND status != 'revoked' ORDER BY id`,
                    [objectId],
                  )
                : [];
            const activeTaskIds =
              input.objectType === "thread"
                ? this.#values(
                    database,
                    `SELECT id FROM scheduled_jobs
                    WHERE thread_id = ? AND status = 'active' ORDER BY id`,
                    [objectId],
                  )
                : [];
            if (activeTaskIds.length > 0) {
              throw new GovernedDeletionError(
                GOVERNED_DELETION_ERROR_CODES.CONFLICT,
                "Active tasks must be resolved before a Thread enters Trash",
                { objectId, activeTaskIds: activeTaskIds.join(",") },
              );
            }
            if (input.objectType === "thread") {
              database
                .prepare(
                  "UPDATE threads SET status = 'trashed', revision = revision + 1 WHERE id = ? AND status = 'open'",
                )
                .run(objectId);
            } else if (input.objectType === "task") {
              database
                .prepare(
                  "UPDATE scheduled_jobs SET status = 'paused', revision = revision + 1 WHERE id = ? AND status = 'active'",
                )
                .run(objectId);
            } else {
              database
                .prepare(
                  `UPDATE memory_records SET status = 'trashed', revision = revision + 1,
                    updated_at = ? WHERE id = ? AND status IN ('active', 'archived')`,
                )
                .run(now, objectId);
            }
            const next: StoredDeletionRecord = Object.freeze({
              deletionId: deletionId(input.objectType, objectId),
              objectType: input.objectType,
              objectId,
              lifecycle: "trashed",
              purgeDeadlineAt: previous?.purgeDeadlineAt ?? deadline,
              targets: initialTargets("trash"),
              payloadFileCount: 0,
              pendingPayloadFiles: Object.freeze([]),
              externalEffectTombstoneCount: 0,
              associatedTaskIds: previous?.associatedTaskIds ?? associatedTaskIds,
              pausedTaskIds: Object.freeze([]),
              priorProductStatus: previous?.priorProductStatus ?? row.status,
              updatedAt: now,
            });
            this.#upsertTombstone(database, next, "pending", null);
            return next;
          })
          .immediate();
        const targets = await this.#deleteDerivedArtifacts(report, ["search", "cache"]);
        const completed = Object.freeze({ ...report, targets, updatedAt: this.#now() });
        this.#upsertTombstone(
          database,
          completed,
          [targets.search, targets.cache].some(({ status }) => status === "failed")
            ? "incomplete"
            : "pending",
          null,
        );
        return this.#publicReport(completed);
      } finally {
        database.close();
      }
    } finally {
      await lock.release();
    }
  }

  restoreThread(threadId: string): Promise<GovernedDeletionReport> {
    return this.restoreObject({ objectType: "thread", objectId: threadId });
  }

  async restoreObject(input: {
    readonly objectType: TrashableDeletionObjectType;
    readonly objectId: string;
  }): Promise<GovernedDeletionReport> {
    const objectId = safeIdentity(input.objectId, "object ID");
    const lock = await this.#lock();
    try {
      const database = this.#database();
      try {
        const now = this.#now();
        const restored = database
          .transaction(() => {
            const current = this.#storedRecord(database, input.objectType, objectId);
            if (!current) this.#failNotFound(input.objectType, objectId);
            if (current.lifecycle !== "trashed") {
              throw new GovernedDeletionError(
                GOVERNED_DELETION_ERROR_CODES.CONFLICT,
                `Only a trashed ${input.objectType} may be restored`,
              );
            }
            if (Date.parse(current.purgeDeadlineAt) <= Date.parse(now)) {
              throw new GovernedDeletionError(
                GOVERNED_DELETION_ERROR_CODES.CONFLICT,
                `${input.objectType} Trash retention has expired`,
              );
            }
            if (input.objectType === "thread") {
              const row = database
                .prepare("SELECT status FROM threads WHERE id = ?")
                .pluck()
                .get(objectId);
              if (row !== "trashed") this.#failNotFound(input.objectType, objectId);
              database
                .prepare("UPDATE threads SET status = 'open', revision = revision + 1 WHERE id = ?")
                .run(objectId);
            } else if (input.objectType === "task") {
              const status = current.priorProductStatus === "active" ? "active" : "paused";
              database
                .prepare(
                  `UPDATE scheduled_jobs SET status = ?, revision = revision + 1
                  WHERE id = ? AND status = 'paused'`,
                )
                .run(status, objectId);
            } else {
              const status = current.priorProductStatus === "archived" ? "archived" : "active";
              database
                .prepare(
                  `UPDATE memory_records SET status = ?, revision = revision + 1,
                    updated_at = ? WHERE id = ? AND status = 'trashed'`,
                )
                .run(status, now, objectId);
            }
            database
              .prepare("DELETE FROM deletion_tombstones WHERE id = ?")
              .run(current.deletionId);
            return Object.freeze({
              ...current,
              lifecycle: "active" as const,
              targets: Object.freeze(
                Object.fromEntries(TARGETS.map((target) => [target, targetState("retained")])),
              ) as GovernedDeletionReport["targets"],
              updatedAt: now,
            });
          })
          .immediate();
        return this.#publicReport(restored);
      } finally {
        database.close();
      }
    } finally {
      await lock.release();
    }
  }

  async deleteImmediately(input: {
    readonly objectType: GovernedDeletionObjectType;
    readonly objectId: string;
  }): Promise<GovernedDeletionReport> {
    const objectId = safeIdentity(input.objectId, "object ID");
    const lock = await this.#lock();
    try {
      const database = this.#database();
      try {
        const now = this.#now();
        const previous = this.#storedRecord(database, input.objectType, objectId);
        if (input.objectType === "thread") {
          const activeTaskIds = this.#values(
            database,
            `SELECT id FROM scheduled_jobs WHERE thread_id = ? AND status = 'active' ORDER BY id`,
            [objectId],
          );
          if (activeTaskIds.length > 0) {
            throw new GovernedDeletionError(
              GOVERNED_DELETION_ERROR_CODES.CONFLICT,
              "Active tasks must be resolved before permanent Thread deletion",
              { objectId, activeTaskIds: activeTaskIds.join(",") },
            );
          }
        }
        const base: StoredDeletionRecord = previous
          ? Object.freeze({ ...previous, lifecycle: "deletion_pending", updatedAt: now })
          : Object.freeze({
              deletionId: deletionId(input.objectType, objectId),
              objectType: input.objectType,
              objectId,
              lifecycle: "deletion_pending",
              purgeDeadlineAt: now,
              targets: initialTargets("delete"),
              payloadFileCount: 0,
              pendingPayloadFiles: Object.freeze([]),
              externalEffectTombstoneCount: 0,
              associatedTaskIds:
                input.objectType === "thread"
                  ? this.#values(
                      database,
                      `SELECT id FROM scheduled_jobs
                      WHERE thread_id = ? AND status != 'revoked' ORDER BY id`,
                      [objectId],
                    )
                  : Object.freeze([]),
              pausedTaskIds: Object.freeze([]),
              priorProductStatus: null,
              updatedAt: now,
            });
        if (input.objectType === "memory") {
          const memory = database
            .prepare(
              `SELECT status, provider_record_id AS providerRecordId
              FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?`,
            )
            .get(objectId, this.#options.ownerId, this.#options.agentId) as
            | { status: string; providerRecordId: string | null }
            | undefined;
          if (memory && (memory.providerRecordId || memory.status === "deletion_pending")) {
            const pending = database
              .transaction(() => {
                database
                  .prepare(
                    `UPDATE memory_records SET status = 'deletion_pending', revision = revision + 1,
                      updated_at = ?
                    WHERE id = ? AND status NOT IN ('deletion_pending', 'deleted_verified')`,
                  )
                  .run(now, objectId);
                const record: StoredDeletionRecord = Object.freeze({
                  ...base,
                  targets: Object.freeze({
                    ...base.targets,
                    product: targetState(
                      "failed",
                      base.targets.product.attempts + 1,
                      GOVERNED_DELETION_ERROR_CODES.PROVIDER_CLEANUP_REQUIRED,
                    ),
                  }),
                });
                this.#upsertTombstone(database, record, "incomplete", null);
                return record;
              })
              .immediate();
            const afterArtifacts: StoredDeletionRecord = Object.freeze({
              ...pending,
              targets: await this.#deleteDerivedArtifacts(pending, ["search", "cache", "archive"]),
              updatedAt: this.#now(),
            });
            this.#upsertTombstone(database, afterArtifacts, "incomplete", null);
            return this.#publicReport(afterArtifacts);
          }
        }
        const prepared = database
          .transaction(() => {
            this.#upsertTombstone(database, base, "incomplete", null);
            const core = this.#deleteCore(
              database,
              input.objectType,
              objectId,
              previous !== undefined,
            );
            const next: StoredDeletionRecord = Object.freeze({
              ...base,
              targets: Object.freeze({
                ...base.targets,
                product: targetState("verified", base.targets.product.attempts + 1, null, now),
                trace: targetState("verified", base.targets.trace.attempts + 1, null, now),
                inbox: targetState("verified", base.targets.inbox.attempts + 1, null, now),
              }),
              pendingPayloadFiles: Object.freeze(
                unique([...base.pendingPayloadFiles, ...core.pendingPayloadFiles]),
              ),
              payloadFileCount: unique([...base.pendingPayloadFiles, ...core.pendingPayloadFiles])
                .length,
              externalEffectTombstoneCount:
                base.externalEffectTombstoneCount + core.externalEffectTombstoneCount,
              updatedAt: now,
            });
            this.#upsertTombstone(database, next, "incomplete", null);
            return next;
          })
          .immediate();

        const afterPayload = await this.#deletePayloadFiles(prepared);
        const afterArtifacts = Object.freeze({
          ...afterPayload,
          targets: await this.#deleteDerivedArtifacts(afterPayload, ["search", "cache", "archive"]),
          updatedAt: this.#now(),
        });
        const verified = TARGETS.every(
          (target) => afterArtifacts.targets[target].status === "verified",
        );
        const finalRecord: StoredDeletionRecord = Object.freeze({
          ...afterArtifacts,
          lifecycle: verified ? "deleted_verified" : "deletion_pending",
        });
        this.#upsertTombstone(
          database,
          finalRecord,
          verified ? "verified" : "incomplete",
          verified ? finalRecord.updatedAt : null,
        );
        return this.#publicReport(finalRecord);
      } finally {
        database.close();
      }
    } finally {
      await lock.release();
    }
  }

  async purgeExpiredTrash(asOf: string): Promise<readonly GovernedDeletionReport[]> {
    const cutoff = Date.parse(asOf);
    if (!Number.isFinite(cutoff)) {
      throw new GovernedDeletionError(
        GOVERNED_DELETION_ERROR_CODES.INVALID_INPUT,
        "Trash purge cutoff is invalid",
      );
    }
    const database = this.#database();
    let expired: Array<{ objectType: GovernedDeletionObjectType; objectId: string }>;
    try {
      expired = database
        .prepare(
          `SELECT object_type AS objectType, object_id AS objectId
          FROM deletion_tombstones
          WHERE status IN ('pending', 'incomplete') AND purge_deadline_at <= ?
          ORDER BY requested_at, id`,
        )
        .all(asOf) as Array<{
        objectType: GovernedDeletionObjectType;
        objectId: string;
      }>;
    } finally {
      database.close();
    }
    const reports: GovernedDeletionReport[] = [];
    for (const entry of expired) {
      if (!(["thread", "run", "task", "memory", "payload"] as const).includes(entry.objectType)) {
        continue;
      }
      reports.push(await this.deleteImmediately(entry));
    }
    return Object.freeze(reports);
  }

  inspect(
    objectType: GovernedDeletionObjectType,
    objectIdInput: string,
  ): GovernedDeletionReport | undefined {
    const objectId = safeIdentity(objectIdInput, "object ID");
    const database = this.#database(true);
    try {
      const record = this.#storedRecord(database, objectType, objectId);
      return record ? this.#publicReport(record) : undefined;
    } finally {
      database.close();
    }
  }

  #database(readonly = false): InstanceType<typeof BetterSqlite3> {
    const database = new BetterSqlite3(this.#options.databasePath, {
      readonly,
      fileMustExist: true,
    });
    database.pragma("foreign_keys = ON");
    return database;
  }

  async #lock() {
    return acquireStateRootLock(this.#options.stateRoot).catch(() => {
      throw new GovernedDeletionError(
        GOVERNED_DELETION_ERROR_CODES.TARGET_NOT_STOPPED,
        "Governed deletion requires stopped services and an exclusive state-root lock",
      );
    });
  }

  #failNotFound(objectType: GovernedDeletionObjectType, objectId: string): never {
    throw new GovernedDeletionError(
      GOVERNED_DELETION_ERROR_CODES.NOT_FOUND,
      `Governed deletion ${objectType} object does not exist`,
      { objectId },
    );
  }

  #storedRecord(
    database: InstanceType<typeof BetterSqlite3>,
    objectType: GovernedDeletionObjectType,
    objectId: string,
  ): StoredDeletionRecord | undefined {
    const row = database
      .prepare(
        `SELECT record_json AS recordJson FROM deletion_tombstones
        WHERE object_type = ? AND object_id = ?`,
      )
      .get(objectType, objectId) as { recordJson: string | null } | undefined;
    if (!row?.recordJson) return undefined;
    return JSON.parse(row.recordJson) as StoredDeletionRecord;
  }

  #upsertTombstone(
    database: InstanceType<typeof BetterSqlite3>,
    record: StoredDeletionRecord,
    status: "pending" | "incomplete" | "verified",
    verifiedAt: string | null,
  ): void {
    database
      .prepare(
        `INSERT INTO deletion_tombstones (
          id, owner_id, agent_id, object_type, object_id, status,
          requested_at, purge_deadline_at, verified_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_type, object_id) DO UPDATE SET
          status = excluded.status,
          purge_deadline_at = excluded.purge_deadline_at,
          verified_at = excluded.verified_at,
          record_json = excluded.record_json`,
      )
      .run(
        record.deletionId,
        this.#options.ownerId,
        this.#options.agentId,
        record.objectType,
        record.objectId,
        status,
        record.updatedAt,
        record.purgeDeadlineAt,
        verifiedAt,
        JSON.stringify(record),
      );
  }

  #deleteCore(
    database: InstanceType<typeof BetterSqlite3>,
    objectType: GovernedDeletionObjectType,
    objectId: string,
    retry: boolean,
  ): CoreDeletionResult {
    const payloadRefs: string[] = [];
    let objectRefs: readonly string[] = [objectId];
    if (objectType === "thread") {
      const thread = database
        .prepare("SELECT id FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(objectId, this.#options.ownerId, this.#options.agentId) as { id: string } | undefined;
      if (!thread && !retry) this.#failNotFound(objectType, objectId);
      if (thread) {
        const runIds = this.#values(database, "SELECT id FROM runs WHERE thread_id = ?", [
          objectId,
        ]);
        const triggerIds = unique([
          ...this.#values(database, `SELECT trigger_id FROM runs WHERE thread_id = ?`, [objectId]),
          ...this.#values(database, `SELECT id FROM triggers WHERE thread_id = ?`, [objectId]),
        ]);
        const messageIds = this.#values(
          database,
          "SELECT id FROM thread_messages WHERE thread_id = ?",
          [objectId],
        );
        objectRefs = unique([objectId, ...runIds, ...messageIds]);
        payloadRefs.push(...this.#threadPayloadRefs(database, objectId, runIds, triggerIds));
        const provenanceRefs = unique([objectId, ...runIds, ...messageIds]);
        if (provenanceRefs.length > 0) {
          database
            .prepare(
              `UPDATE memory_provenance SET source_deleted = 1
              WHERE source_id IN (${placeholders(provenanceRefs)})`,
            )
            .run(...provenanceRefs);
        }
        database
          .prepare("UPDATE memory_records SET source_thread_id = NULL WHERE source_thread_id = ?")
          .run(objectId);
        this.#detachThreadTasks(database, objectId);
        database.prepare("DELETE FROM runs WHERE thread_id = ?").run(objectId);
        if (triggerIds.length > 0) {
          database
            .prepare(`DELETE FROM triggers WHERE id IN (${placeholders(triggerIds)})`)
            .run(...triggerIds);
        }
        database.prepare("DELETE FROM threads WHERE id = ?").run(objectId);
      }
    } else if (objectType === "run") {
      const run = database
        .prepare(
          `SELECT id, trigger_id AS triggerId FROM runs
          WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(objectId, this.#options.ownerId, this.#options.agentId) as
        | { id: string; triggerId: string }
        | undefined;
      if (!run && !retry) this.#failNotFound(objectType, objectId);
      if (run) {
        payloadRefs.push(...this.#runPayloadRefs(database, [objectId], [run.triggerId]));
        database
          .prepare("UPDATE memory_provenance SET source_deleted = 1 WHERE source_id = ?")
          .run(objectId);
        database.prepare("DELETE FROM runs WHERE id = ?").run(objectId);
        database.prepare("DELETE FROM triggers WHERE id = ?").run(run.triggerId);
      }
    } else if (objectType === "task") {
      const job = database
        .prepare(
          `SELECT id, definition_ref AS definitionRef FROM scheduled_jobs
          WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(objectId, this.#options.ownerId, this.#options.agentId) as
        | { id: string; definitionRef: string }
        | undefined;
      if (!job && !retry) this.#failNotFound(objectType, objectId);
      if (job) {
        const runIds = this.#values(
          database,
          "SELECT run_id FROM job_occurrences WHERE job_id = ? AND run_id IS NOT NULL",
          [objectId],
        );
        const triggerIds =
          runIds.length === 0
            ? []
            : this.#values(
                database,
                `SELECT trigger_id FROM runs WHERE id IN (${placeholders(runIds)})`,
                runIds,
              );
        objectRefs = unique([objectId, ...runIds]);
        payloadRefs.push(job.definitionRef, ...this.#runPayloadRefs(database, runIds, triggerIds));
        if (runIds.length > 0) {
          database
            .prepare(
              `UPDATE memory_provenance SET source_deleted = 1
              WHERE source_id IN (${placeholders(runIds)})`,
            )
            .run(...runIds);
        }
        database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(objectId);
        if (runIds.length > 0) {
          database.prepare(`DELETE FROM runs WHERE id IN (${placeholders(runIds)})`).run(...runIds);
        }
        if (triggerIds.length > 0) {
          database
            .prepare(`DELETE FROM triggers WHERE id IN (${placeholders(triggerIds)})`)
            .run(...triggerIds);
        }
      }
    } else if (objectType === "memory") {
      const memory = database
        .prepare(
          `SELECT content_ref AS contentRef, status, provider_record_id AS providerRecordId
          FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(objectId, this.#options.ownerId, this.#options.agentId) as
        | { contentRef: string; status: string; providerRecordId: string | null }
        | undefined;
      if (!memory && !retry) this.#failNotFound(objectType, objectId);
      if (memory) {
        if (memory.providerRecordId || memory.status === "deletion_pending") {
          throw new GovernedDeletionError(
            GOVERNED_DELETION_ERROR_CODES.PROVIDER_CLEANUP_REQUIRED,
            "Memory provider cleanup must reach deleted_verified before product purge",
            { objectId },
          );
        }
        payloadRefs.push(memory.contentRef);
        database.prepare("DELETE FROM memory_records WHERE id = ?").run(objectId);
      }
    } else {
      const payload = database
        .prepare("SELECT ref FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
        .get(objectId, this.#options.ownerId, this.#options.agentId) as { ref: string } | undefined;
      if (!payload && !retry) this.#failNotFound(objectType, objectId);
      if (payload) {
        if (this.#payloadReferenced(database, payload.ref)) {
          throw new GovernedDeletionError(
            GOVERNED_DELETION_ERROR_CODES.CONFLICT,
            "A referenced Payload must be deleted through its owning product object",
            { objectId },
          );
        }
        payloadRefs.push(payload.ref);
      }
    }

    this.#removeProjectionRecords(database, objectRefs);
    const externalEffectTombstoneCount = this.#removeOutboxContent(database, unique(payloadRefs));
    const pendingPayloadFiles = this.#deleteUnreferencedPayloadRows(database, unique(payloadRefs));
    return Object.freeze({ pendingPayloadFiles, externalEffectTombstoneCount });
  }

  #threadPayloadRefs(
    database: InstanceType<typeof BetterSqlite3>,
    threadId: string,
    runIds: readonly string[],
    triggerIds: readonly string[],
  ): readonly string[] {
    const refs = [
      ...this.#values(
        database,
        "SELECT metadata_ref FROM threads WHERE id = ? AND metadata_ref IS NOT NULL",
        [threadId],
      ),
      ...this.#values(database, "SELECT content_ref FROM thread_messages WHERE thread_id = ?", [
        threadId,
      ]),
      ...this.#values(
        database,
        "SELECT summary_ref FROM thread_checkpoint_jobs WHERE thread_id = ? AND summary_ref IS NOT NULL",
        [threadId],
      ),
      ...this.#values(database, "SELECT content_ref FROM thread_summaries WHERE thread_id = ?", [
        threadId,
      ]),
      ...this.#values(
        database,
        "SELECT content_ref FROM thread_derivative_candidates WHERE generation_id IN (SELECT id FROM memory_generations WHERE thread_id = ?) AND content_ref IS NOT NULL",
        [threadId],
      ),
      ...this.#values(
        database,
        "SELECT output_ref FROM memory_generations WHERE thread_id = ? AND output_ref IS NOT NULL",
        [threadId],
      ),
      ...this.#values(
        database,
        "SELECT source_ref FROM memory_approval_requests WHERE thread_id = ?",
        [threadId],
      ),
    ];
    refs.push(...this.#runPayloadRefs(database, runIds, triggerIds));
    return unique(refs);
  }

  #detachThreadTasks(database: InstanceType<typeof BetterSqlite3>, threadId: string): void {
    const rows = database
      .prepare(
        `SELECT id, revision, record_json AS recordJson FROM scheduled_jobs
        WHERE thread_id = ? ORDER BY id`,
      )
      .all(threadId) as Array<{ id: string; revision: number; recordJson: string | null }>;
    const update = database.prepare(
      `UPDATE scheduled_jobs SET thread_id = NULL, revision = ?, record_json = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const record = row.recordJson
        ? ({
            ...(JSON.parse(row.recordJson) as Record<string, unknown>),
            revision: row.revision + 1,
            threadId: null,
          } as Record<string, unknown>)
        : null;
      update.run(row.revision + 1, record ? JSON.stringify(record) : null, row.id);
    }
  }

  #runPayloadRefs(
    database: InstanceType<typeof BetterSqlite3>,
    runIds: readonly string[],
    triggerIds: readonly string[],
  ): readonly string[] {
    const refs: string[] = [];
    if (triggerIds.length > 0) {
      refs.push(
        ...this.#values(
          database,
          `SELECT payload_ref FROM triggers WHERE id IN (${placeholders(triggerIds)})`,
          triggerIds,
        ),
      );
    }
    if (runIds.length === 0) return unique(refs);
    const bindings = [
      ["run_checkpoints", "checkpoint_ref"],
      ["approval_requests", "intent_ref"],
      ["trace_events", "payload_ref"],
      ["attention_decisions", "decision_ref"],
      ["inbox_deliveries", "result_ref"],
    ] as const;
    for (const [table, column] of bindings) {
      refs.push(
        ...this.#values(
          database,
          `SELECT ${quoteIdentifier(column)} FROM ${quoteIdentifier(table)}
          WHERE run_id IN (${placeholders(runIds)}) AND ${quoteIdentifier(column)} IS NOT NULL`,
          runIds,
        ),
      );
    }
    return unique(refs);
  }

  #removeProjectionRecords(
    database: InstanceType<typeof BetterSqlite3>,
    objectRefs: readonly string[],
  ): void {
    if (objectRefs.length === 0) return;
    database
      .prepare(
        `UPDATE audit_records SET detail_ref = NULL
        WHERE target_ref IN (${placeholders(objectRefs)})`,
      )
      .run(...objectRefs);
    for (const ref of objectRefs) {
      database
        .prepare(
          `DELETE FROM product_state_records
          WHERE key = ? OR key LIKE ? ESCAPE '\\'`,
        )
        .run(ref, `${ref.replaceAll("%", "\\%").replaceAll("_", "\\_")}:%`);
      database
        .prepare("DELETE FROM command_results WHERE state_key = ? OR state_key LIKE ? ESCAPE '\\'")
        .run(ref, `${ref.replaceAll("%", "\\%").replaceAll("_", "\\_")}:%`);
    }
  }

  #removeOutboxContent(
    database: InstanceType<typeof BetterSqlite3>,
    payloadRefs: readonly string[],
  ): number {
    if (payloadRefs.length === 0) return 0;
    const events = database
      .prepare(
        `SELECT id, topic, acknowledgement_ref AS acknowledgementRef,
          publication_state AS publicationState
        FROM reliable_events WHERE payload_ref IN (${placeholders(payloadRefs)})`,
      )
      .all(...payloadRefs) as Array<{
      id: string;
      topic: string;
      acknowledgementRef: string | null;
      publicationState: string;
    }>;
    for (const event of events) {
      const digest = sha256(
        JSON.stringify({
          eventId: event.id,
          topic: event.topic,
          acknowledgementRef: event.acknowledgementRef,
          publicationState: event.publicationState,
        }),
      );
      database
        .prepare(
          `INSERT OR IGNORE INTO audit_records (
            id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at
          ) VALUES (?, ?, ?, 'content.deleted_external_effect_tombstone', ?, 'completed', NULL, ?)`,
        )
        .run(
          `audit-deletion-${digest.slice(0, 24)}`,
          this.#options.ownerId,
          this.#options.agentId,
          `sha256:${digest}`,
          this.#now(),
        );
    }
    database
      .prepare(`DELETE FROM reliable_events WHERE payload_ref IN (${placeholders(payloadRefs)})`)
      .run(...payloadRefs);
    return events.length;
  }

  #deleteUnreferencedPayloadRows(
    database: InstanceType<typeof BetterSqlite3>,
    payloadRefs: readonly string[],
  ): readonly string[] {
    const files: string[] = [];
    for (const ref of payloadRefs) {
      const row = database
        .prepare(
          `SELECT ref, storage_kind AS storageKind, ciphertext_path AS ciphertextPath
          FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(ref, this.#options.ownerId, this.#options.agentId) as PayloadCandidate | undefined;
      if (!row || this.#payloadReferenced(database, ref)) continue;
      database.prepare("DELETE FROM payloads WHERE ref = ?").run(ref);
      if (row.storageKind === "ciphertext_file" && row.ciphertextPath) {
        files.push(this.#safePayloadFile(row.ciphertextPath));
      }
    }
    return unique(files);
  }

  #payloadReferenced(database: InstanceType<typeof BetterSqlite3>, payloadRef: string): boolean {
    const tables = database
      .prepare(
        "SELECT name FROM pragma_table_list WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const foreignKeys = database
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
        .all() as Array<{
        table: string;
        from: string;
      }>;
      for (const foreignKey of foreignKeys) {
        if (foreignKey.table !== "payloads") continue;
        const count = Number(
          database
            .prepare(
              `SELECT COUNT(*) FROM ${quoteIdentifier(name)}
              WHERE ${quoteIdentifier(foreignKey.from)} = ?`,
            )
            .pluck()
            .get(payloadRef),
        );
        if (count > 0) return true;
      }
    }
    return false;
  }

  #safePayloadFile(relativePath: string): string {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.split(path.sep).includes("..") ||
      relativePath.includes("\\")
    ) {
      throw new GovernedDeletionError(
        GOVERNED_DELETION_ERROR_CODES.TARGET_FAILED,
        "Payload ciphertext path escapes its managed root",
      );
    }
    const root = path.join(this.#options.stateRoot, "data", "payload-ciphertext");
    const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new GovernedDeletionError(
        GOVERNED_DELETION_ERROR_CODES.TARGET_FAILED,
        "Payload ciphertext path escapes its managed root",
      );
    }
    return target;
  }

  async #deletePayloadFiles(record: StoredDeletionRecord): Promise<StoredDeletionRecord> {
    const attempts = record.targets.payload.attempts + 1;
    try {
      await this.#options.fault?.("payload");
      for (const file of record.pendingPayloadFiles) {
        const info = await lstat(file).catch(() => undefined);
        if (info?.isDirectory()) {
          throw new GovernedDeletionError(
            GOVERNED_DELETION_ERROR_CODES.TARGET_FAILED,
            "Payload deletion target unexpectedly became a directory",
          );
        }
        await rm(file, { force: true });
        if (await lstat(file).catch(() => undefined)) throw new Error("payload-remains");
      }
      return Object.freeze({
        ...record,
        targets: Object.freeze({
          ...record.targets,
          payload: targetState("verified", attempts, null, this.#now()),
        }),
      });
    } catch (error) {
      return Object.freeze({
        ...record,
        targets: Object.freeze({
          ...record.targets,
          payload: targetState(
            "failed",
            attempts,
            error instanceof GovernedDeletionError ? error.code : "PAYLOAD_DELETE_FAILED",
          ),
        }),
      });
    }
  }

  async #deleteDerivedArtifacts(
    record: StoredDeletionRecord,
    targets: readonly ("search" | "cache" | "archive")[],
  ): Promise<GovernedDeletionReport["targets"]> {
    const next = { ...record.targets };
    for (const target of targets) {
      const attempts = next[target].attempts + 1;
      try {
        await this.#options.fault?.(target);
        const root =
          target === "search"
            ? this.#options.searchRoot
            : target === "cache"
              ? this.#options.cacheRoot
              : this.#options.archiveRoot;
        const artifact = managedDeletionArtifactPath(
          root,
          target,
          record.objectType,
          record.objectId,
        );
        const info = await lstat(artifact).catch(() => undefined);
        if (info?.isDirectory()) throw new Error("artifact-is-directory");
        await rm(artifact, { force: true });
        if (await lstat(artifact).catch(() => undefined)) throw new Error("artifact-remains");
        next[target] = targetState("verified", attempts, null, this.#now());
      } catch {
        next[target] = targetState("failed", attempts, "MANAGED_ARTIFACT_DELETE_FAILED");
      }
    }
    return Object.freeze(next);
  }

  #values(
    database: InstanceType<typeof BetterSqlite3>,
    sql: string,
    parameters: readonly unknown[],
  ): string[] {
    return database
      .prepare(sql)
      .pluck()
      .all(...parameters) as string[];
  }

  #publicReport(record: StoredDeletionRecord): GovernedDeletionReport {
    const { pendingPayloadFiles: _pendingPayloadFiles, ...report } = record;
    return Object.freeze({ ...report });
  }
}
