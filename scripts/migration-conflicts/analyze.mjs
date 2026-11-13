import BetterSqlite3 from "better-sqlite3";

const FORBIDDEN = [
  { pattern: /\battach\b/i, label: "ATTACH" },
  { pattern: /\bvacuum\b/i, label: "VACUUM" },
  { pattern: /\bload_extension\b/i, label: "load_extension" },
  { pattern: /\bwritable_schema\b/i, label: "writable_schema" },
];

function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
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
      new Set(
        database
          .prepare(`SELECT * FROM ${quoted}`)
          .all()
          .map((row) => JSON.stringify(row)),
      ),
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

function schemaDump(database) {
  return [...snapshot(database)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function open() {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys = OFF");
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
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(withoutComments(entry.sql)))
        problems.push(`FORBIDDEN_STATEMENT ${entry.file} uses ${label}`);
    }
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
      if (after && [...before].some((row) => !after.has(row))) changedExisting.add(name);
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
      if (JSON.stringify(schemaDump(forward)) !== JSON.stringify(schemaDump(reverse))) {
        problems.push(`ORDER_DEPENDENT ${left.file} and ${right.file} produce different schemas`);
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
    if (JSON.stringify(schemaDump(production)) !== JSON.stringify(schemaDump(fresh))) {
      problems.push(
        "ORDER_DEPENDENT a fresh database (by id) differs from the production order (applied after the existing ones)",
      );
    }
    production.close();
    fresh.close();
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
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(withoutComments(entry.sql)))
        problems.push(`FORBIDDEN_STATEMENT ${entry.file} uses ${label}`);
    }
  }
  if (problems.length > 0) return problems;
  try {
    cloneFrom(entries).close();
  } catch (error) {
    problems.push(`FULL_REPLAY_FAILS ${error.message}`);
  }
  return problems;
}
