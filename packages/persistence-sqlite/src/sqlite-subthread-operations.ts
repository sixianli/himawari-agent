import type {
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
  result_ref AS resultRef, classification, status, created_at AS createdAt,
  updated_at AS updatedAt`;

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
      return this.read(input);
    })();
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
