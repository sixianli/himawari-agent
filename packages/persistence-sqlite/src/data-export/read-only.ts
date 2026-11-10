import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export function openReadOnlyDatabase(databasePath: string): InstanceType<typeof BetterSqlite3> {
  const database = new BetterSqlite3(path.resolve(databasePath), {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma("busy_timeout = 5000");
  return database;
}
