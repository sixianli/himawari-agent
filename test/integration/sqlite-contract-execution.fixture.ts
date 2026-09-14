import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, beforeEach, vi } from "vitest";
import { SqliteDurableOperations } from "../../packages/persistence-sqlite/src/sqlite-durable-operations.ts";
import { SqliteExecutionContext } from "../../packages/persistence-sqlite/src/sqlite-execution-context.ts";

/** Component contracts use real SQL and production operations; Worker transport
 * and host disk/crash qualification remain covered by the separate worker mode. */
export function useSqliteContractExecution(execution: "worker" | "direct") {
  beforeEach(() => {
    if (execution !== "direct") return;
    const startWorker = SqliteExecutionContext.start.bind(SqliteExecutionContext);
    vi.spyOn(SqliteExecutionContext, "start").mockImplementation(async (configuration) => {
      if (configuration.qualification || configuration.minimumFreeBytes !== 0) {
        throw new Error("Direct SQL contracts do not model Worker or disk qualifications");
      }
      const database = openQualifiedDatabase(configuration.databasePath);
      // The legacy state/authority dispatcher is owned by sqlite-worker itself.
      // Reuse that real dispatcher when a durable contract also needs it; never
      // emulate its SQL or translate an unknown-operation failure into success.
      let worker: Promise<SqliteExecutionContext> | undefined;
      const workerOwned = new Set([
        "readScopedState",
        "read",
        "listPending",
        "markPublished",
        "findCommandResult",
        "findCommandCommit",
        "commit",
        "authority.claim",
        "authority.current",
        "authority.renew",
        "authority.release",
        "deployment.read",
        "deployment.save",
        "deployment.assertCurrent",
        "status",
        "checkpoint",
      ]);
      const operations = new SqliteDurableOperations(
        database,
        (code, message, details) => {
          throw new ApplicationPortError(code as PortErrorCode, message, details);
        },
        () => undefined,
      );
      return {
        async request(operation: string, payload: unknown) {
          if (workerOwned.has(operation)) {
            worker ??= startWorker(configuration);
            return (await worker).request(operation, payload);
          }
          if (operation === "recovery.run") {
            const input = payload as {
              scope: Parameters<SqliteDurableOperations["recoverStartupWithAuthority"]>[0];
              now: string;
            };
            return operations.recoverStartupWithAuthority(input.scope, input.now);
          }
          return operations.execute(operation, payload);
        },
        async close() {
          try {
            database.close();
          } finally {
            await (await worker)?.close();
          }
        },
      } as unknown as SqliteExecutionContext;
    });
  });
  afterEach(() => vi.restoreAllMocks());
}
