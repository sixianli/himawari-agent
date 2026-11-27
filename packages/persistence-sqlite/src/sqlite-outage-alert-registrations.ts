import path from "node:path";
import type { ApplePushRegistration, PairedDeviceScope } from "@himawari-agent/application";
import BetterSqlite3 from "better-sqlite3";
import { SqliteApplePushOperations } from "./sqlite-apple-push-operations.js";

const BUSY_TIMEOUT_MS = 5_000;

export function readActiveAlertRegistrations(
  databasePath: string,
  scope: PairedDeviceScope,
): readonly ApplePushRegistration[] {
  const database = new BetterSqlite3(path.resolve(databasePath), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const operations = new SqliteApplePushOperations(
      database,
      (code, message) => {
        throw Object.assign(new Error(message), { code });
      },
      () => undefined,
    );
    return operations.execute("applePush.listRegistrations", {
      ...scope,
      pushType: "alert",
    }) as readonly ApplePushRegistration[];
  } finally {
    database.close();
  }
}
