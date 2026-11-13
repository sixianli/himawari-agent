import { describe, expect, it } from "vitest";
import { analyzeMigrations } from "../../scripts/migration-conflicts/analyze.mjs";
import { nextMigrationId, validName } from "../../scripts/new-migration.mjs";

const base = [
  {
    id: "0001",
    file: "0001_start.sql",
    name: "start",
    sql: "CREATE TABLE ledger (id INTEGER PRIMARY KEY, kind TEXT NOT NULL); CREATE TABLE kinds (kind TEXT PRIMARY KEY);",
  },
];

function entry(id, name, sql) {
  return { id, name, file: `${id}_${name}.sql`, sql };
}

describe("migration conflict analysis", () => {
  it("accepts independent new tables in any order", () => {
    const added = [
      entry("20261114000001", "a_table", "CREATE TABLE a (id INTEGER PRIMARY KEY);"),
      entry("20261114000002", "b_table", "CREATE TABLE b (id INTEGER PRIMARY KEY);"),
    ];
    expect(analyzeMigrations({ base, added })).toEqual([]);
  });

  it("accepts two migrations that only add rows to a lookup table", () => {
    const added = [
      entry("20261114000001", "kind_a", "INSERT INTO kinds VALUES ('a');"),
      entry("20261114000002", "kind_b", "INSERT INTO kinds VALUES ('b');"),
    ];
    expect(analyzeMigrations({ base, added })).toEqual([]);
  });

  it("rejects two declared rebuilds of the same table", () => {
    const rebuild = (kind) =>
      `CREATE TABLE ledger_new (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('${kind}')));
       DROP TABLE ledger; ALTER TABLE ledger_new RENAME TO ledger;`;
    const added = [
      entry("20261114000001", "rebuild_a", rebuild("a")),
      entry("20261114000002", "rebuild_b", rebuild("b")),
    ];
    const meta = {
      20261114000001: { alters: ["ledger"] },
      20261114000002: { alters: ["ledger"] },
    };
    const problems = analyzeMigrations({ base, added, meta });
    expect(problems.some((line) => line.startsWith("CONFLICT") && line.includes("ledger"))).toBe(
      true,
    );
  });

  it("rejects altering an existing table without declaring it", () => {
    const added = [
      entry("20261114000001", "add_column", "ALTER TABLE ledger ADD COLUMN note TEXT;"),
    ];
    const problems = analyzeMigrations({ base, added });
    expect(problems[0]).toMatch(/^UNDECLARED_ALTERATION/);
  });

  it("accepts a declared alteration that no other migration touches", () => {
    const added = [
      entry("20261114000001", "add_column", "ALTER TABLE ledger ADD COLUMN note TEXT;"),
    ];
    expect(
      analyzeMigrations({ base, added, meta: { 20261114000001: { alters: ["ledger"] } } }),
    ).toEqual([]);
  });

  it("rejects two migrations that create the same table", () => {
    const added = [
      entry("20261114000001", "one", "CREATE TABLE twin (id INTEGER);"),
      entry("20261114000002", "two", "CREATE TABLE twin (id INTEGER, extra TEXT);"),
    ];
    expect(analyzeMigrations({ base, added }).some((line) => line.startsWith("CONFLICT"))).toBe(
      true,
    );
  });

  it("rejects duplicate ids and ids already in the base", () => {
    const added = [
      entry("20261114000001", "one", "CREATE TABLE one (id INTEGER);"),
      entry("20261114000001", "two", "CREATE TABLE two (id INTEGER);"),
    ];
    expect(analyzeMigrations({ base, added })[0]).toMatch(/^DUPLICATE_ID/);
    expect(analyzeMigrations({ base, added: [entry("0001", "again", "SELECT 1;")] })[0]).toMatch(
      /^DUPLICATE_ID/,
    );
  });

  it("rejects statements that escape the shadow database", () => {
    const added = [entry("20261114000001", "escape", "ATTACH DATABASE '/tmp/x.db' AS other;")];
    expect(analyzeMigrations({ base, added })[0]).toMatch(/^FORBIDDEN_STATEMENT/);
  });

  it("rejects a migration that fails to apply", () => {
    const added = [entry("20261114000001", "broken", "CREATE TABLE nope (")];
    expect(analyzeMigrations({ base, added })[0]).toMatch(/^MIGRATION_FAILS/);
  });

  it("rejects a migration that depends on another new migration", () => {
    const added = [
      entry("20261114000001", "make_table", "CREATE TABLE made (id INTEGER);"),
      entry("20261114000002", "use_table", "INSERT INTO made VALUES (1);"),
    ];
    expect(analyzeMigrations({ base, added })[0]).toMatch(/^MIGRATION_FAILS/);
  });
});

describe("migration generator", () => {
  it("builds a 14 digit id after the newest existing one", () => {
    const now = new Date("2026-11-14T01:02:03Z");
    expect(nextMigrationId([], now)).toBe("20261114010203");
    expect(nextMigrationId(["20261114010203_x.sql"], now)).toBe("20261114010204");
    expect(nextMigrationId(["0095_a.sql"], now)).toBe("20261114010203");
  });

  it("accepts only snake_case names", () => {
    expect(validName("web_push")).toBe(true);
    expect(validName("Web-Push")).toBe(false);
    expect(validName(undefined)).toBe(false);
  });
});
