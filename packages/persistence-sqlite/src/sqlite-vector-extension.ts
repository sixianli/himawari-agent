import type Database from "better-sqlite3";
import { load } from "sqlite-vec";
import type { SqliteVectorEngine } from "./sqlite-memory-operations.js";

export function loadVectorExtension(database: Database.Database): SqliteVectorEngine {
  try {
    load(database);
    database.prepare("SELECT vec_version()").pluck().get();
    return "sqlite-vec";
  } catch {
    return "javascript";
  }
}
