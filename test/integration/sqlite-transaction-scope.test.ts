import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApplicationPortError, type MemoryCaptureBacklogPort } from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId, createThreadId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteExecutionContext } from "../../packages/persistence-sqlite/src/sqlite-execution-context.ts";
import { SqliteDurableOperations } from "../../packages/persistence-sqlite/src/sqlite-durable-operations.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-scope");
const AGENT_ID = createAgentId("agent-scope");
const THREAD_ID = createThreadId("thread-scope");
const T0 = "2026-11-11T00:00:00.000Z";
const roots: string[] = [];
const repositories: SqliteProductStateRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepare(timeoutMs?: number) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-transaction-scope-"));
  roots.push(stateRoot);
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => T0,
    ...(timeoutMs === undefined ? {} : { transactionScopeTimeoutMs: timeoutMs }),
  });
  repositories.push(repository);
  const backlog = repository.memoryCaptureBacklog();
  const enqueue = (backlogPort: MemoryCaptureBacklogPort, generationId: string) =>
    backlogPort.enqueue({
      generationId,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      sourceRunId: createRunId(`run-${generationId}`),
      lastErrorCode: "SCOPE_TEST",
      createdAt: T0,
    });
  return { repository, backlog, unitOfWork: repository.unitOfWork(), enqueue };
}

describe.each(["worker", "direct"] as const)(
  "[P3-5] transaction scope on real SQLite through %s",
  (execution) => {
    useSqliteContractExecution(execution);

    it("commits every write of the scope together, lets the scope read its own writes, and hides them from outside readers until commit", async () => {
      const { backlog, unitOfWork, enqueue } = await prepare();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seenInside: boolean[] = [];
      const scoped = unitOfWork.run(async () => {
        await enqueue(backlog, "a");
        seenInside.push(await backlog.has("a"));
        await gate;
        await enqueue(backlog, "b");
      });
      await pause(50);
      expect(await backlog.has("a")).toBe(false);
      let outsideWriteDone = false;
      const outsideWrite = enqueue(backlog, "c").then(() => {
        outsideWriteDone = true;
      });
      await pause(50);
      expect(outsideWriteDone).toBe(false);
      release();
      await scoped;
      await outsideWrite;
      expect(seenInside).toEqual([true]);
      expect(await Promise.all(["a", "b", "c"].map((id) => backlog.has(id)))).toEqual([
        true,
        true,
        true,
      ]);
    });

    it("lets a scope in progress finish and commit before closing the repository", async () => {
      const { repository, backlog, unitOfWork, enqueue } = await prepare();
      const scoped = unitOfWork.run(async () => {
        await enqueue(backlog, "a");
        await pause(150);
        await enqueue(backlog, "b");
      });
      await pause(50);
      const closing = repository.close();
      await expect(scoped).resolves.toBeUndefined();
      await closing;
    });

    it("rolls every write of the scope back when it throws, and the next write is not affected", async () => {
      const { backlog, unitOfWork, enqueue } = await prepare();
      await expect(
        unitOfWork.run(async () => {
          await enqueue(backlog, "a");
          await enqueue(backlog, "b");
          throw new Error("SCOPE_BOOM");
        }),
      ).rejects.toThrow("SCOPE_BOOM");
      expect(await backlog.has("a")).toBe(false);
      expect(await backlog.has("b")).toBe(false);
      await enqueue(backlog, "c");
      expect(await backlog.has("c")).toBe(true);
    });

    it("rolls the scope back on a real database failure in the middle of it", async () => {
      const { backlog, unitOfWork, enqueue } = await prepare();
      await expect(
        unitOfWork.run(async () => {
          await enqueue(backlog, "a");
          await backlog.enqueue({
            generationId: "b",
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            threadId: createThreadId("thread-that-does-not-exist"),
            sourceRunId: createRunId("run-b"),
            lastErrorCode: "SCOPE_TEST",
            createdAt: T0,
          });
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
      expect(await backlog.has("a")).toBe(false);
    });

    it("joins a scope opened inside another scope instead of committing early", async () => {
      const { backlog, unitOfWork, enqueue } = await prepare();
      await expect(
        unitOfWork.run(async () => {
          await unitOfWork.run(() => enqueue(backlog, "inner"));
          throw new Error("OUTER_FAILS");
        }),
      ).rejects.toThrow("OUTER_FAILS");
      expect(await backlog.has("inner")).toBe(false);
    });

    it("rolls back on timeout, refuses the late writes of the still-running work, and frees the write lane", async () => {
      const { backlog, unitOfWork, enqueue } = await prepare(300);
      let lateWrite: unknown;
      const started = Date.now();
      await expect(
        unitOfWork.run(async () => {
          await enqueue(backlog, "a");
          await pause(700);
          lateWrite = await enqueue(backlog, "late").catch((error: unknown) => error);
        }),
      ).rejects.toMatchObject({ details: { reason: "TRANSACTION_SCOPE_TIMEOUT" } });
      expect(Date.now() - started).toBeLessThan(650);
      await enqueue(backlog, "after");
      await pause(600);
      expect(lateWrite).toBeInstanceOf(ApplicationPortError);
      expect(lateWrite).toMatchObject({ details: { reason: "TRANSACTION_SCOPE_ENDED" } });
      expect(await Promise.all(["a", "late", "after"].map((id) => backlog.has(id)))).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("refuses a write that continues from inside a scope after the scope has ended", async () => {
      const { backlog, unitOfWork, enqueue } = await prepare();
      let late: Promise<unknown> = Promise.resolve();
      await unitOfWork.run(async () => {
        await enqueue(backlog, "a");
        late = pause(100).then(() => enqueue(backlog, "late").catch((error: unknown) => error));
      });
      expect(await late).toMatchObject({ details: { reason: "TRANSACTION_SCOPE_ENDED" } });
      expect(await backlog.has("late")).toBe(false);
      expect(await backlog.has("a")).toBe(true);
    });
  },
);

describe("[P3-5] transaction scope timeout option", () => {
  it("refuses an invalid timeout before any database worker is started", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-transaction-option-"));
    roots.push(stateRoot);
    const start = vi.spyOn(SqliteExecutionContext, "start");
    await expect(
      SqliteProductStateRepository.open({
        stateRoot,
        minimumFreeBytes: 0,
        now: () => T0,
        transactionScopeTimeoutMs: 0,
      }),
    ).rejects.toBeDefined();
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });
});

describe("[P3-5] transaction scope when the database worker is lost", () => {
  useSqliteContractExecution("worker");

  it("refuses later writes with an error instead of leaving them waiting forever", async () => {
    const { repository, backlog, unitOfWork, enqueue } = await prepare();
    const lost = unitOfWork.run(async () => {
      await enqueue(backlog, "a");
      await (repository as unknown as { context: { close(): Promise<void> } }).context.close();
    });
    await expect(lost).rejects.toBeDefined();
    const outcome = await Promise.race([
      enqueue(backlog, "b").then(
        () => "written",
        (error: unknown) => error,
      ),
      pause(1500).then(() => "waiting"),
    ]);
    expect(outcome).toMatchObject({ details: { reason: "TRANSACTION_ROLLBACK_UNCONFIRMED" } });
  });
});

describe("[P3-5] transaction scope when SQLite rolls the transaction back by itself", () => {
  it("refuses every later operation without running it, and refuses to commit", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-transaction-abort-"));
    roots.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'open', ?, ?)`,
      )
      .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
    const operations = new SqliteDurableOperations(
      database,
      (code, message, details) => {
        throw new ApplicationPortError(code as never, message, details);
      },
      () => undefined,
    );
    const entry = {
      generationId: "a",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      sourceRunId: createRunId("run-a"),
      lastErrorCode: "SCOPE_TEST",
      createdAt: T0,
    };
    operations.execute("transaction.begin", {});
    operations.execute("memoryCaptureBacklog.enqueue", { entry });
    database.exec("ROLLBACK");
    expect(() =>
      operations.execute("memoryCaptureBacklog.enqueue", {
        entry: { ...entry, generationId: "b" },
      }),
    ).toThrowError(expect.objectContaining({ details: { reason: "TRANSACTION_ABORTED" } }));
    expect(database.prepare("SELECT count(*) AS n FROM memory_capture_backlog").get()).toEqual({
      n: 0,
    });
    expect(() =>
      operations.execute("memoryCaptureBacklog.enqueue", {
        entry: { ...entry, generationId: "c" },
      }),
    ).toThrowError(expect.objectContaining({ details: { reason: "TRANSACTION_ABORTED" } }));
    expect(database.prepare("SELECT count(*) AS n FROM memory_capture_backlog").get()).toEqual({
      n: 0,
    });
    operations.execute("transaction.rollback", {});
    operations.execute("transaction.begin", {});
    database.exec("ROLLBACK");
    expect(() => operations.execute("transaction.commit", {})).toThrowError(
      expect.objectContaining({ details: { reason: "TRANSACTION_ABORTED" } }),
    );
    database.close();
  });
});
