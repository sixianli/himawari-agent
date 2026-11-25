import { createHash } from "node:crypto";
import type {
  ResultEntryRecord,
  ResultGoneReason,
  ResultNoticeRecord,
  ResultRecordOutcome,
  ResultWaitOutcome,
  SubthreadRecord,
  SubthreadStorePort,
  ThreadTaskChangeOutcome,
  ThreadTaskChangeRecord,
  ThreadTaskRecord,
  ThreadTaskWrite,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof SubthreadStorePort> = Parameters<SubthreadStorePort[TName]>[0];

const MAX_TASKS = 200;
const TASK_STATUSES: readonly string[] = ["pending", "in_progress", "completed", "deleted"];
const MAX_CHANGES = 500;

const subthreadColumns = `thread_id AS threadId, parent_thread_id AS parentThreadId, matter,
  open_key AS openKey, opened_by_run_id AS openedByRunId, brief_ref AS briefRef,
  result_ref AS resultRef, classification, status, stuck_at AS stuckAt,
  created_at AS createdAt, updated_at AS updatedAt`;

const entryColumns = `e.writer_thread_id AS writerThreadId, e.name, e.version,
  e.summary_ref AS summaryRef, e.body_ref AS bodyRef, e.classification,
  e.external_content AS externalContent, e.created_at AS createdAt`;

const noticeColumns = `id, receiver_thread_id AS receiverThreadId, kind,
  writer_thread_id AS writerThreadId, name, version, reason,
  external_content AS externalContent, created_at AS createdAt`;

type EntryRow = Omit<ResultEntryRecord, "externalContent"> & { readonly externalContent: number };
type NoticeRow = Omit<ResultNoticeRecord, "externalContent"> & {
  readonly externalContent: number;
};

function entry(row: EntryRow): ResultEntryRecord {
  return Object.freeze({ ...row, externalContent: row.externalContent === 1 });
}

function noticeId(parts: readonly unknown[]): string {
  return `notice:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 48)}`;
}

const taskColumns = `thread_id AS threadId, task_number AS number, status,
  blocked_by AS blockedBy, assignee_thread_id AS assigneeThreadId, content_ref AS contentRef,
  classification, revision, created_at AS createdAt, updated_at AS updatedAt`;

type TaskRow = Omit<ThreadTaskRecord, "blockedBy"> & { readonly blockedBy: string };

function task(row: TaskRow): ThreadTaskRecord {
  return Object.freeze({
    ...row,
    blockedBy: Object.freeze(JSON.parse(row.blockedBy) as number[]),
  });
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function numbers(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TASKS &&
    value.every((item) => Number.isSafeInteger(item) && item >= 1) &&
    new Set(value).size === value.length
  );
}

export class SqliteSubthreadOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "subthread.open":
        return this.open(payload as Input<"open">);
      case "subthread.read":
        return this.read(payload as Input<"read">);
      case "subthread.readByOpenKey":
        return this.readByOpenKey(payload as Input<"readByOpenKey">);
      case "subthread.list":
        return this.list(payload as Input<"list">);
      case "subthread.settle":
        return this.settle(payload as Input<"settle">);
      case "subthread.createTask":
        return this.createTask(payload as Input<"createTask">);
      case "subthread.updateTask":
        return this.updateTask(payload as Input<"updateTask">);
      case "subthread.listTasks":
        return this.listTasks(payload as Input<"listTasks">);
      case "subthread.listTaskChanges":
        return this.listTaskChanges(payload as Input<"listTaskChanges">);
      case "subthread.markStuck":
        return this.markStuck(payload as Input<"markStuck">);
      case "subthread.recordResult":
        return this.recordResult(payload as Input<"recordResult">);
      case "subthread.listResults":
        return this.listResults(payload as Input<"listResults">);
      case "subthread.readResult":
        return this.readResult(payload as Input<"readResult">);
      case "subthread.waitResult":
        return this.waitResult(payload as Input<"waitResult">);
      case "subthread.listResultNotices":
        return this.listResultNotices(payload as Input<"listResultNotices">);
      case "subthread.deleteResultNotice":
        return this.deleteResultNotice(payload as Input<"deleteResultNotice">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown subthread operation ${operation}`);
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private open(input: Input<"open">) {
    if (
      !text(input.threadId, 256) ||
      !text(input.parentThreadId, 256) ||
      !text(input.matter, 128) ||
      !text(input.openKey, 128) ||
      !text(input.openedByRunId, 256) ||
      !text(input.briefRef, 256) ||
      !text(input.classification, 32) ||
      !validTime(input.now)
    )
      this.invalid("Subthread is invalid");
    this.assertDiskHeadroom();
    return this.database.transaction(() => {
      const existing = this.readByOpenKey(input);
      if (existing) {
        if (
          existing.threadId !== input.threadId ||
          existing.parentThreadId !== input.parentThreadId
        )
          return this.fail("PORT_CONFLICT", "SUBTHREAD_OPEN_KEY_REUSED");
        return Object.freeze({ subthread: existing, created: false });
      }
      this.database
        .prepare(
          `INSERT INTO subthreads (
            thread_id, owner_id, agent_id, parent_thread_id, matter, open_key, opened_by_run_id,
            brief_ref, result_ref, classification, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', ?, ?)`,
        )
        .run(
          input.threadId,
          input.ownerId,
          input.agentId,
          input.parentThreadId,
          input.matter,
          input.openKey,
          input.openedByRunId,
          input.briefRef,
          input.classification,
          input.now,
          input.now,
        );
      const created = this.read(input);
      if (!created) return this.fail("PORT_CONFLICT", "SUBTHREAD_MISSING");
      return Object.freeze({ subthread: created, created: true });
    })();
  }

  private read(input: Input<"read">): SubthreadRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${subthreadColumns} FROM subthreads
         WHERE owner_id = ? AND agent_id = ? AND thread_id = ?`,
      )
      .get(input.ownerId, input.agentId, input.threadId) as SubthreadRecord | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private readByOpenKey(input: Input<"readByOpenKey">): SubthreadRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${subthreadColumns} FROM subthreads
         WHERE owner_id = ? AND agent_id = ? AND open_key = ?`,
      )
      .get(input.ownerId, input.agentId, input.openKey) as SubthreadRecord | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private list(input: Input<"list">): readonly SubthreadRecord[] {
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT ${subthreadColumns} FROM subthreads
             WHERE owner_id = ? AND agent_id = ? AND parent_thread_id = ?
             ORDER BY created_at, thread_id`,
          )
          .all(input.ownerId, input.agentId, input.parentThreadId) as SubthreadRecord[]
      ).map((row) => Object.freeze({ ...row })),
    );
  }

  private settle(input: Input<"settle">): SubthreadRecord | undefined {
    if (
      (input.to !== "returned" && input.to !== "stopped") ||
      (input.resultRef !== null && !text(input.resultRef, 256)) ||
      !validTime(input.now)
    )
      this.invalid("Subthread settlement is invalid");
    return this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE subthreads SET status = ?, result_ref = COALESCE(?, result_ref), updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND status = 'open'`,
        )
        .run(input.to, input.resultRef, input.now, input.ownerId, input.agentId, input.threadId);
      const settled = this.read(input);
      if (settled && settled.status !== "open")
        this.releaseWaits(input, input.threadId, settled.status as ResultGoneReason, input.now);
      return settled;
    })();
  }

  private releaseWaits(
    scope: { readonly ownerId: string; readonly agentId: string },
    writerThreadId: string,
    reason: ResultGoneReason,
    now: string,
  ): void {
    const waits = this.database
      .prepare(
        `SELECT id, waiter_thread_id AS waiterThreadId, name FROM result_board_waits
         WHERE owner_id = ? AND agent_id = ? AND writer_thread_id = ?
         ORDER BY created_at, id`,
      )
      .all(scope.ownerId, scope.agentId, writerThreadId) as {
      id: string;
      waiterThreadId: string;
      name: string;
    }[];
    for (const wait of waits) {
      this.notice(scope, {
        id: noticeId(["gone", wait.id, reason]),
        receiverThreadId: wait.waiterThreadId,
        kind: "gone",
        writerThreadId,
        name: wait.name,
        version: null,
        reason,
        externalContent: false,
        now,
      });
      this.database.prepare("DELETE FROM result_board_waits WHERE id = ?").run(wait.id);
    }
  }

  private notice(
    scope: { readonly ownerId: string; readonly agentId: string },
    notice: {
      readonly id: string;
      readonly receiverThreadId: string;
      readonly kind: ResultNoticeRecord["kind"];
      readonly writerThreadId: string;
      readonly name: string;
      readonly version: number | null;
      readonly reason: ResultGoneReason | null;
      readonly externalContent: boolean;
      readonly now: string;
    },
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO result_board_notices (
          id, owner_id, agent_id, receiver_thread_id, kind, writer_thread_id, name, version,
          reason, external_content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        notice.id,
        scope.ownerId,
        scope.agentId,
        notice.receiverThreadId,
        notice.kind,
        notice.writerThreadId,
        notice.name,
        notice.version,
        notice.reason,
        notice.externalContent ? 1 : 0,
        notice.now,
      );
  }

  private markStuck(input: Input<"markStuck">): SubthreadRecord | undefined {
    if (!text(input.threadId, 256) || typeof input.stuck !== "boolean" || !validTime(input.now))
      this.invalid("Subthread stuck mark is invalid");
    return this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE subthreads SET stuck_at = ?, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND status = 'open'`,
        )
        .run(
          input.stuck ? input.now : null,
          input.now,
          input.ownerId,
          input.agentId,
          input.threadId,
        );
      if (input.stuck) this.releaseWaits(input, input.threadId, "stuck", input.now);
      return this.read(input);
    })();
  }

  private latest(writerThreadId: string, name: string): ResultEntryRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${entryColumns} FROM result_board_entries e
         WHERE e.writer_thread_id = ? AND e.name = ?
         ORDER BY e.version DESC LIMIT 1`,
      )
      .get(writerThreadId, name) as EntryRow | undefined;
    return row ? entry(row) : undefined;
  }

  private recordResult(input: Input<"recordResult">): ResultRecordOutcome {
    if (
      !text(input.writerThreadId, 256) ||
      !text(input.name, 128) ||
      !text(input.summaryRef, 256) ||
      !text(input.bodyRef, 256) ||
      !text(input.classification, 32) ||
      typeof input.externalContent !== "boolean" ||
      !Number.isSafeInteger(input.maxNames) ||
      input.maxNames < 1 ||
      !Number.isSafeInteger(input.maxVersions) ||
      input.maxVersions < 1 ||
      !validTime(input.now)
    )
      this.invalid("Result entry is invalid");
    this.assertDiskHeadroom();
    return this.database.transaction((): ResultRecordOutcome => {
      const writer = this.read({ ...input, threadId: input.writerThreadId });
      if (!writer || writer.status !== "open") return { outcome: "closed" };
      const previous = this.latest(input.writerThreadId, input.name);
      if (previous && previous.version >= input.maxVersions)
        return { outcome: "too_many_versions" };
      if (!previous) {
        const names = this.database
          .prepare(
            `SELECT count(DISTINCT e.writer_thread_id || char(0) || e.name) AS count
             FROM result_board_entries e JOIN subthreads s ON s.thread_id = e.writer_thread_id
             WHERE s.owner_id = ? AND s.agent_id = ? AND s.parent_thread_id = ? AND s.matter = ?`,
          )
          .get(input.ownerId, input.agentId, writer.parentThreadId, writer.matter) as {
          count: number;
        };
        if (names.count >= input.maxNames) return { outcome: "too_many_names" };
      }
      const version = (previous?.version ?? 0) + 1;
      this.database
        .prepare(
          `INSERT INTO result_board_entries (
            owner_id, agent_id, writer_thread_id, name, version, summary_ref, body_ref,
            classification, external_content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.writerThreadId,
          input.name,
          version,
          input.summaryRef,
          input.bodyRef,
          input.classification,
          input.externalContent ? 1 : 0,
          input.now,
        );
      const waits = this.database
        .prepare(
          `SELECT id, waiter_thread_id AS waiterThreadId FROM result_board_waits
           WHERE owner_id = ? AND agent_id = ? AND writer_thread_id = ? AND name = ?
           ORDER BY created_at, id`,
        )
        .all(input.ownerId, input.agentId, input.writerThreadId, input.name) as {
        id: string;
        waiterThreadId: string;
      }[];
      for (const wait of waits) {
        this.notice(input, {
          id: noticeId(["ready", wait.id]),
          receiverThreadId: wait.waiterThreadId,
          kind: "ready",
          writerThreadId: input.writerThreadId,
          name: input.name,
          version,
          reason: null,
          externalContent: input.externalContent,
          now: input.now,
        });
        this.database.prepare("DELETE FROM result_board_waits WHERE id = ?").run(wait.id);
      }
      const readers = this.database
        .prepare(
          `SELECT reader_thread_id AS readerThreadId FROM result_board_reads
           WHERE owner_id = ? AND agent_id = ? AND writer_thread_id = ? AND name = ?
             AND version < ? AND reader_thread_id <> ?
           ORDER BY reader_thread_id`,
        )
        .all(
          input.ownerId,
          input.agentId,
          input.writerThreadId,
          input.name,
          version,
          input.writerThreadId,
        ) as { readerThreadId: string }[];
      for (const reader of readers)
        this.notice(input, {
          id: noticeId([
            "changed",
            input.writerThreadId,
            input.name,
            version,
            reader.readerThreadId,
          ]),
          receiverThreadId: reader.readerThreadId,
          kind: "changed",
          writerThreadId: input.writerThreadId,
          name: input.name,
          version,
          reason: null,
          externalContent: input.externalContent,
          now: input.now,
        });
      const recorded = this.latest(input.writerThreadId, input.name);
      if (!recorded) return this.fail("PORT_CONFLICT", "RESULT_ENTRY_MISSING");
      return { outcome: "recorded", entry: recorded };
    })();
  }

  private listResults(input: Input<"listResults">): readonly ResultEntryRecord[] {
    if (
      !text(input.parentThreadId, 256) ||
      !text(input.matter, 128) ||
      (input.writerThreadId !== null && !text(input.writerThreadId, 256))
    )
      this.invalid("Result board query is invalid");
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT ${entryColumns} FROM result_board_entries e
             JOIN subthreads s ON s.thread_id = e.writer_thread_id
             WHERE s.owner_id = ? AND s.agent_id = ? AND s.parent_thread_id = ? AND s.matter = ?
               AND (? IS NULL OR e.writer_thread_id = ?)
               AND e.version = (
                 SELECT max(l.version) FROM result_board_entries l
                 WHERE l.writer_thread_id = e.writer_thread_id AND l.name = e.name
               )
             ORDER BY s.created_at, s.thread_id, e.name`,
          )
          .all(
            input.ownerId,
            input.agentId,
            input.parentThreadId,
            input.matter,
            input.writerThreadId,
            input.writerThreadId,
          ) as EntryRow[]
      ).map(entry),
    );
  }

  private readResult(input: Input<"readResult">): ResultEntryRecord | undefined {
    if (
      !text(input.readerThreadId, 256) ||
      !text(input.writerThreadId, 256) ||
      !text(input.name, 128) ||
      !validTime(input.now)
    )
      this.invalid("Result read is invalid");
    return this.database.transaction(() => {
      const found = this.latest(input.writerThreadId, input.name);
      if (!found) return undefined;
      this.database
        .prepare(
          `INSERT INTO result_board_reads (
            owner_id, agent_id, reader_thread_id, writer_thread_id, name, version, read_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (reader_thread_id, writer_thread_id, name)
          DO UPDATE SET version = excluded.version, read_at = excluded.read_at`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.readerThreadId,
          input.writerThreadId,
          input.name,
          found.version,
          input.now,
        );
      return found;
    })();
  }

  private waitResult(input: Input<"waitResult">): ResultWaitOutcome {
    if (
      !text(input.waitId, 128) ||
      !text(input.waiterThreadId, 256) ||
      !text(input.writerThreadId, 256) ||
      !text(input.name, 128) ||
      !validTime(input.now)
    )
      this.invalid("Result wait is invalid");
    return this.database.transaction((): ResultWaitOutcome => {
      const waiter = this.read({ ...input, threadId: input.waiterThreadId });
      const writer = this.read({ ...input, threadId: input.writerThreadId });
      if (
        !waiter ||
        !writer ||
        waiter.threadId === writer.threadId ||
        waiter.parentThreadId !== writer.parentThreadId ||
        waiter.matter !== writer.matter
      )
        return { outcome: "other_matter" };
      const found = this.latest(input.writerThreadId, input.name);
      if (found) return { outcome: "available", version: found.version };
      if (writer.status !== "open")
        return { outcome: "gone", reason: writer.status as ResultGoneReason };
      if (writer.stuckAt !== null) return { outcome: "gone", reason: "stuck" };
      const existing = this.database
        .prepare(
          `SELECT id FROM result_board_waits
           WHERE waiter_thread_id = ? AND writer_thread_id = ? AND name = ?`,
        )
        .get(input.waiterThreadId, input.writerThreadId, input.name);
      if (existing) return { outcome: "waiting" };
      const reaches = this.database
        .prepare(
          `WITH RECURSIVE reach(thread_id) AS (
             SELECT ?
             UNION
             SELECT w.writer_thread_id FROM result_board_waits w
             JOIN reach r ON w.waiter_thread_id = r.thread_id
           )
           SELECT 1 FROM reach WHERE thread_id = ? LIMIT 1`,
        )
        .get(input.writerThreadId, input.waiterThreadId);
      if (reaches) return { outcome: "cycle" };
      this.database
        .prepare(
          `INSERT INTO result_board_waits (
            id, owner_id, agent_id, waiter_thread_id, writer_thread_id, name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.waitId,
          input.ownerId,
          input.agentId,
          input.waiterThreadId,
          input.writerThreadId,
          input.name,
          input.now,
        );
      return { outcome: "waiting" };
    })();
  }

  private listResultNotices(input: Input<"listResultNotices">): readonly ResultNoticeRecord[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.invalid("Result notice query is invalid");
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT ${noticeColumns} FROM result_board_notices
             WHERE owner_id = ? AND agent_id = ?
             ORDER BY created_at, id LIMIT ?`,
          )
          .all(input.ownerId, input.agentId, input.limit) as NoticeRow[]
      ).map((row) => Object.freeze({ ...row, externalContent: row.externalContent === 1 })),
    );
  }

  private deleteResultNotice(input: Input<"deleteResultNotice">): void {
    if (!text(input.id, 128)) this.invalid("Result notice is invalid");
    this.database
      .prepare("DELETE FROM result_board_notices WHERE owner_id = ? AND agent_id = ? AND id = ?")
      .run(input.ownerId, input.agentId, input.id);
  }

  private validTask(write: ThreadTaskWrite): void {
    if (
      !TASK_STATUSES.includes(write.status) ||
      !numbers(write.blockedBy) ||
      (write.assigneeThreadId !== null && !text(write.assigneeThreadId, 256)) ||
      !text(write.contentRef, 256) ||
      !text(write.classification, 32)
    )
      this.invalid("Thread task is invalid");
  }

  private tasks(scope: Input<"listTasks">): ThreadTaskRecord[] {
    return (
      this.database
        .prepare(
          `SELECT ${taskColumns} FROM thread_tasks
           WHERE owner_id = ? AND agent_id = ? AND thread_id = ? ORDER BY task_number`,
        )
        .all(scope.ownerId, scope.agentId, scope.threadId) as TaskRow[]
    ).map(task);
  }

  private dependencyProblem(
    tasks: readonly ThreadTaskRecord[],
    edges: ReadonlyMap<number, readonly number[]>,
  ): "unknown_dependency" | "cycle" | undefined {
    const known = new Set(tasks.map((item) => item.number));
    for (const [number, blockers] of edges)
      if (!known.has(number) || blockers.some((blocker) => !known.has(blocker)))
        return "unknown_dependency";
    const visiting = new Set<number>();
    const done = new Set<number>();
    const visit = (number: number): boolean => {
      if (done.has(number)) return false;
      if (visiting.has(number)) return true;
      visiting.add(number);
      for (const blocker of edges.get(number) ?? []) if (visit(blocker)) return true;
      visiting.delete(number);
      done.add(number);
      return false;
    };
    for (const number of edges.keys()) if (visit(number)) return "cycle";
    return undefined;
  }

  private writeChange(
    input: { readonly ownerId: string; readonly agentId: string; readonly threadId: string },
    number: number,
    revision: number,
    write: ThreadTaskWrite,
    runId: string | null,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO thread_task_changes (
          owner_id, agent_id, thread_id, task_number, revision, run_id, content_ref,
          classification, changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerId,
        input.agentId,
        input.threadId,
        number,
        revision,
        runId,
        write.contentRef,
        write.classification,
        now,
      );
  }

  private createTask(input: Input<"createTask">): ThreadTaskChangeOutcome {
    this.validTask(input.task);
    if (!text(input.threadId, 256) || !validTime(input.now)) this.invalid("Thread task is invalid");
    this.assertDiskHeadroom();
    return this.database.transaction((): ThreadTaskChangeOutcome => {
      const tasks = this.tasks(input);
      if (tasks.length >= MAX_TASKS) return this.fail("PORT_CONFLICT", "THREAD_TASKS_FULL");
      const number = (tasks.at(-1)?.number ?? 0) + 1;
      const edges = new Map(tasks.map((item) => [item.number, item.blockedBy] as const));
      edges.set(number, input.task.blockedBy);
      const problem = this.dependencyProblem([...tasks, { number } as ThreadTaskRecord], edges);
      if (problem) return Object.freeze({ outcome: problem });
      this.database
        .prepare(
          `INSERT INTO thread_tasks (
            owner_id, agent_id, thread_id, task_number, status, blocked_by, assignee_thread_id,
            content_ref, classification, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.threadId,
          number,
          input.task.status,
          JSON.stringify(input.task.blockedBy),
          input.task.assigneeThreadId,
          input.task.contentRef,
          input.task.classification,
          input.now,
          input.now,
        );
      this.writeChange(input, number, 1, input.task, input.runId, input.now);
      const created = this.tasks(input).find((item) => item.number === number);
      if (!created) return this.fail("PORT_CONFLICT", "THREAD_TASK_MISSING");
      return Object.freeze({ outcome: "changed", task: created });
    })();
  }

  private updateTask(input: Input<"updateTask">): ThreadTaskChangeOutcome {
    this.validTask(input.task);
    if (
      !text(input.threadId, 256) ||
      !Number.isSafeInteger(input.number) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      !numbers(input.blocks) ||
      !validTime(input.now)
    )
      this.invalid("Thread task change is invalid");
    this.assertDiskHeadroom();
    return this.database.transaction((): ThreadTaskChangeOutcome => {
      const tasks = this.tasks(input);
      const current = tasks.find((item) => item.number === input.number);
      if (!current) return Object.freeze({ outcome: "missing" });
      if (current.revision !== input.expectedRevision)
        return Object.freeze({ outcome: "stale", task: current });
      const edges = new Map<number, number[]>(
        tasks.map((item) => [item.number, [...item.blockedBy]]),
      );
      edges.set(input.number, [...input.task.blockedBy]);
      for (const blocked of input.blocks) {
        const list = edges.get(blocked);
        if (!list) return Object.freeze({ outcome: "unknown_dependency" });
        if (!list.includes(input.number)) list.push(input.number);
      }
      const problem = this.dependencyProblem(tasks, edges);
      if (problem) return Object.freeze({ outcome: problem });
      const revision = current.revision + 1;
      this.database
        .prepare(
          `UPDATE thread_tasks SET status = ?, blocked_by = ?, assignee_thread_id = ?,
             content_ref = ?, classification = ?, revision = ?, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND task_number = ?`,
        )
        .run(
          input.task.status,
          JSON.stringify(input.task.blockedBy),
          input.task.assigneeThreadId,
          input.task.contentRef,
          input.task.classification,
          revision,
          input.now,
          input.ownerId,
          input.agentId,
          input.threadId,
          input.number,
        );
      this.writeChange(input, input.number, revision, input.task, input.runId, input.now);
      for (const blocked of input.blocks) {
        const other = tasks.find((item) => item.number === blocked);
        if (!other || other.blockedBy.includes(input.number)) continue;
        this.database
          .prepare(
            `UPDATE thread_tasks SET blocked_by = ?, updated_at = ?
             WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND task_number = ?`,
          )
          .run(
            JSON.stringify([...other.blockedBy, input.number]),
            input.now,
            input.ownerId,
            input.agentId,
            input.threadId,
            blocked,
          );
      }
      const updated = this.tasks(input).find((item) => item.number === input.number);
      if (!updated) return this.fail("PORT_CONFLICT", "THREAD_TASK_MISSING");
      return Object.freeze({ outcome: "changed", task: updated });
    })();
  }

  private listTasks(input: Input<"listTasks">): readonly ThreadTaskRecord[] {
    return Object.freeze(this.tasks(input));
  }

  private listTaskChanges(input: Input<"listTaskChanges">): readonly ThreadTaskChangeRecord[] {
    const limit =
      Number.isSafeInteger(input.limit) && input.limit >= 1
        ? Math.min(input.limit, MAX_CHANGES)
        : this.invalid("Thread task change limit is invalid");
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT thread_id AS threadId, task_number AS number, revision, run_id AS runId,
               content_ref AS contentRef, classification, changed_at AS changedAt
             FROM (
               SELECT * FROM thread_task_changes
               WHERE owner_id = ? AND agent_id = ? AND thread_id = ?
               ORDER BY changed_at DESC, task_number DESC, revision DESC LIMIT ?
             ) ORDER BY changed_at, task_number, revision`,
          )
          .all(input.ownerId, input.agentId, input.threadId, limit) as ThreadTaskChangeRecord[]
      ).map((row) => Object.freeze({ ...row })),
    );
  }
}
