import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";

const FORBIDDEN = [
  { pattern: /\battach\b/i, label: "ATTACH" },
  { pattern: /\bvacuum\b/i, label: "VACUUM" },
  { pattern: /\bload_extension\b/i, label: "load_extension" },
  { pattern: /\bwritable_schema\b/i, label: "writable_schema" },
];

function withoutComments(sql) {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === close) {
          if (close !== "]" && sql[end + 1] === close) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      output += sql.slice(index, end + 1);
      index = end + 1;
    } else if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      output += " ";
      index = end === -1 ? sql.length : end;
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      output += " ";
      index = end === -1 ? sql.length : end + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function forbiddenOutsideLiterals(sql) {
  const stripped = withoutComments(sql).replace(/'(?:[^']|'')*'/g, "''");
  return FORBIDDEN.filter(({ pattern }) => pattern.test(stripped)).map(({ label }) => label);
}

function literals(sql) {
  return new Set([...String(sql ?? "").matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]));
}

function tableRows(database) {
  const rows = new Map();
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    rows.set(
      name,
      database
        .prepare(`SELECT * FROM ${quoted}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    );
  }
  return rows;
}

export const TIMESTAMP_FILE = /^(\d{14})_([a-z][a-z0-9_]*)\.sql$/;
export const LEGACY_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
export const META_FILE = /^(\d{14})_([a-z][a-z0-9_]*)\.meta\.json$/;

function snapshot(database) {
  const rows = database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all();
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.type}:${row.name}`, normalize(row.sql));
  }
  return map;
}

function normalize(sql) {
  return String(sql ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function diffSnapshots(before, after) {
  const created = [];
  const altered = [];
  const dropped = [];
  for (const [key, sql] of after) {
    if (!before.has(key)) created.push(key);
    else if (before.get(key) !== sql) altered.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) dropped.push(key);
  }
  return { created, altered, dropped };
}

function schemaDump(database, tables = []) {
  const structure = [...snapshot(database)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rows = tableRows(database);
  const data = [...tables].sort().map((name) => [name, rows.get(name) ?? []]);
  return JSON.stringify([structure, data]);
}

function writtenTables(before, after, created) {
  const written = new Set(created);
  for (const [name, rows] of after) {
    const previous = before.get(name);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(rows)) written.add(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) written.add(name);
  }
  return written;
}

function integrityProblems(database, label) {
  const problems = [];
  const integrity = database.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") problems.push(`INTEGRITY_FAILS ${label}: ${integrity}`);
  const violations = database.pragma("foreign_key_check");
  if (violations.length > 0)
    problems.push(`FOREIGN_KEY_VIOLATION ${label}: ${violations.length} rows`);
  return problems;
}

function open() {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = ON");
  return database;
}

function applyAll(database, entries) {
  for (const entry of entries) database.exec(entry.sql);
}

function cloneFrom(entries) {
  const database = open();
  applyAll(database, entries);
  return database;
}

function tableOf(key) {
  return key.slice(key.indexOf(":") + 1);
}

export function analyzeMigrations({ base, added, meta = {} }) {
  const problems = [];
  const ids = new Set();
  for (const entry of added) {
    if (ids.has(entry.id)) problems.push(`DUPLICATE_ID ${entry.id}`);
    ids.add(entry.id);
    for (const label of forbiddenOutsideLiterals(entry.sql))
      problems.push(`FORBIDDEN_STATEMENT ${entry.file} uses ${label}`);
  }
  const baseIds = new Set(base.map((entry) => entry.id));
  for (const entry of added) {
    if (baseIds.has(entry.id)) problems.push(`DUPLICATE_ID ${entry.id} already exists in base`);
  }
  if (problems.length > 0) return problems;

  let baseline;
  try {
    baseline = cloneFrom(base);
  } catch (error) {
    return [`BASE_DOES_NOT_APPLY ${error.message}`];
  }
  const baseSnapshot = snapshot(baseline);
  baseline.close();

  const touched = new Map();
  const written = new Map();
  for (const entry of added) {
    const database = cloneFrom(base);
    const rowsBefore = tableRows(database);
    const sqlBefore = new Map(
      database
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => [`${row.type}:${row.name}`, row.sql]),
    );
    try {
      database.exec(entry.sql);
    } catch (error) {
      problems.push(`MIGRATION_FAILS ${entry.file}: ${error.message}`);
      database.close();
      continue;
    }
    const diff = diffSnapshots(baseSnapshot, snapshot(database));
    const rowsAfter = tableRows(database);
    const sqlAfter = new Map(
      database
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => [`${row.type}:${row.name}`, row.sql]),
    );
    database.close();
    const declared = new Set(meta[entry.id]?.alters ?? []);
    const declaredRemovals = new Set(meta[entry.id]?.removes ?? []);
    const changedExisting = new Set([...diff.altered, ...diff.dropped].map(tableOf));
    for (const [name, before] of rowsBefore) {
      const after = rowsAfter.get(name);
      if (after) {
        const kept = new Set(after);
        if (before.some((row) => !kept.has(row))) changedExisting.add(name);
      }
    }
    for (const name of changedExisting) {
      if (!declared.has(name)) {
        problems.push(
          `UNDECLARED_ALTERATION ${entry.file} changes existing object ${name}; add it to alters in ${entry.id}_${entry.name ?? ""}.meta.json`,
        );
      }
    }
    for (const name of declared) {
      if (!changedExisting.has(name)) {
        problems.push(
          `DECLARED_BUT_UNCHANGED ${entry.file} declares ${name} but does not change it`,
        );
      }
    }
    for (const [key, beforeSql] of sqlBefore) {
      const lost = [...literals(beforeSql)].filter(
        (value) => !literals(sqlAfter.get(key)).has(value),
      );
      for (const value of lost) {
        if (!declaredRemovals.has(value)) {
          problems.push(
            `UNDECLARED_REMOVAL ${entry.file} drops the value '${value}' from ${tableOf(key)}; add it to removes in ${entry.id}_${entry.name ?? ""}.meta.json`,
          );
        }
      }
    }
    const createdTables = diff.created.filter((key) => key.startsWith("table:")).map(tableOf);
    written.set(entry.id, writtenTables(rowsBefore, rowsAfter, createdTables));
    touched.set(entry.id, new Set([...diff.created.map(tableOf), ...changedExisting]));
  }
  if (problems.length > 0) return problems;

  const sorted = [...added].sort((left, right) => (left.id < right.id ? -1 : 1));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i];
      const right = sorted[j];
      const shared = [...touched.get(left.id)].filter((name) => touched.get(right.id).has(name));
      if (shared.length > 0) {
        problems.push(`CONFLICT ${left.file} and ${right.file} both touch ${shared.join(", ")}`);
        continue;
      }
      let forward;
      let reverse;
      try {
        forward = cloneFrom([...base, left, right]);
        reverse = cloneFrom([...base, right, left]);
      } catch (error) {
        problems.push(
          `ORDER_DEPENDENT ${left.file} and ${right.file} fail in one order: ${error.message}`,
        );
        forward?.close();
        continue;
      }
      const compared = new Set([...written.get(left.id), ...written.get(right.id)]);
      if (schemaDump(forward, compared) !== schemaDump(reverse, compared)) {
        problems.push(
          `ORDER_DEPENDENT ${left.file} and ${right.file} produce different schemas or data`,
        );
      }
      forward.close();
      reverse.close();
    }
  }
  try {
    const production = cloneFrom([...base, ...sorted]);
    const fresh = cloneFrom(
      [...base, ...sorted].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    );
    const everything = new Set([...written.values()].flatMap((names) => [...names]));
    if (schemaDump(production, everything) !== schemaDump(fresh, everything)) {
      problems.push(
        "ORDER_DEPENDENT a fresh database (by id) differs from the production order (applied after the existing ones)",
      );
    }
    problems.push(...integrityProblems(production, "production order"));
    production.close();
    fresh.close();
  } catch (error) {
    problems.push(`FULL_REPLAY_FAILS ${error.message}`);
  }
  return problems;
}

export function compareOrders({ entries, appliedIds }) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unknown = appliedIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) return [`APPLIED_ID_NOT_IN_COMMIT ${unknown.slice(0, 3).join(", ")}`];
  const applied = appliedIds.map((id) => byId.get(id));
  const appliedSet = new Set(appliedIds);
  const pending = entries
    .filter((entry) => !appliedSet.has(entry.id))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const fresh = [...entries].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const problems = [];
  try {
    const before = cloneFrom(applied);
    const beforeRows = tableRows(before);
    const production = cloneFrom([...applied, ...pending]);
    const afterRows = tableRows(production);
    const created = [...afterRows.keys()].filter((name) => !beforeRows.has(name));
    const compared = writtenTables(beforeRows, afterRows, created);
    const reference = cloneFrom(fresh);
    if (schemaDump(production, compared) !== schemaDump(reference, compared)) {
      problems.push(
        "ORDER_DEPENDENT the production order (existing first, then the pending ones) differs from a fresh database",
      );
    }
    problems.push(...integrityProblems(production, "production order"));
    before.close();
    production.close();
    reference.close();
  } catch (error) {
    problems.push(`FULL_REPLAY_FAILS ${error.message}`);
  }
  return problems;
}

export function replayAll(entries) {
  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`DUPLICATE_ID ${entry.id}`);
    seen.add(entry.id);
    for (const label of forbiddenOutsideLiterals(entry.sql))
      problems.push(`FORBIDDEN_STATEMENT ${entry.file} uses ${label}`);
  }
  if (problems.length > 0) return problems;
  try {
    cloneFrom(entries).close();
  } catch (error) {
    problems.push(`FULL_REPLAY_FAILS ${error.message}`);
  }
  return problems;
}

export function checkAgainstApplied({ entries, applied, meta = {} }) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const problems = [];
  for (const { id, digest } of applied) {
    const entry = byId.get(id);
    if (!entry) {
      problems.push(`APPLIED_ID_NOT_IN_COMMIT ${id}`);
      continue;
    }
    if (digest && createHash("sha256").update(entry.sql).digest("hex") !== digest) {
      problems.push(
        `APPLIED_MIGRATION_CHANGED ${entry.file} differs from what the production database applied`,
      );
    }
  }
  if (problems.length > 0) return problems;
  const appliedIds = applied.map((item) => item.id);
  const appliedSet = new Set(appliedIds);
  problems.push(...compareOrders({ entries, appliedIds }));
  const pending = entries
    .filter((entry) => !appliedSet.has(entry.id))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const isLegacy = (entry) => /^\d{4}$/.test(entry.id);
  const base = [...appliedIds.map((id) => byId.get(id)), ...pending.filter(isLegacy)];
  const added = pending.filter((entry) => !isLegacy(entry));
  problems.push(...analyzeMigrations({ base, added, meta }));
  return problems;
}
