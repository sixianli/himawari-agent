#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD_LITERAL = "__PKT_OLD_PREFIX__";
const NEW_LITERAL = "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__";
const RUNTIME_SUFFIX = "/lib/himawari-agent";
const DRIVER_MARKER = "/node_modules/better-sqlite3";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (filename) => sha256(readFileSync(filename));
const sidecarsAbsent = (filename) => !existsSync(`${filename}-wal`) && !existsSync(`${filename}-shm`);

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(typeof key === "string" && key.startsWith("--") && typeof value === "string" && value.length > 0, "SINGLE_SQLITE_DRIVER_ARGUMENT_INVALID");
    options[key.slice(2)] = value;
  }
  for (const name of ["old-runtime", "new-runtime", "scratch", "output"]) {
    assert(typeof options[name] === "string" && path.isAbsolute(options[name]) && path.resolve(options[name]) === options[name], "SINGLE_SQLITE_DRIVER_PATH_INVALID");
  }
  return options;
}

const OPEN_ORDER_SOURCE = `import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const config = JSON.parse(process.argv[2]);
const common = await import(pathToFileURL(config.common).href);
const results = [];
for (const step of config.steps) {
  try {
    const database = common.openRecoveryReadonly(step.prefix, step.filename, process.getuid());
    database.prepare("SELECT count(*) AS count FROM sqlite_master").all();
    database.close();
    results.push({ prefix: step.prefix, filename: step.filename, opened: true, error: null });
  } catch (error) {
    results.push({ prefix: step.prefix, filename: step.filename, opened: false, error: { name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error) } });
  }
}
const require = createRequire(import.meta.url);
const cache = Object.keys(require.cache).filter((key) => key.includes("better-sqlite3"));
console.log(JSON.stringify({ results, cache }));
`;

const CREATE_DATABASES_SOURCE = `import { createRequire } from "node:module";
const config = JSON.parse(process.argv[2]);
const require = createRequire(config.runtime + "/package.json");
const Database = require(config.runtime + "/node_modules/better-sqlite3");
for (const filename of config.files) {
  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.exec("CREATE TABLE driver_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  database.prepare("INSERT INTO driver_probe (note) VALUES (?)").run("single-driver");
  database.close();
}
console.log(JSON.stringify({ created: config.files }));
`;

const CONTROL_CONFLICT_SOURCE = `process.env.SQLITE_USE_URI = "1";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const config = JSON.parse(process.argv[2]);
function open(runtime) {
  const require = createRequire(runtime + "/package.json");
  const Database = require(runtime + "/node_modules/better-sqlite3");
  return new Database(pathToFileURL(config.filename).href + "?mode=ro&immutable=1", { readonly: true, fileMustExist: true });
}
const results = [];
for (const runtime of config.runtimes) {
  try {
    const database = open(runtime);
    database.prepare("SELECT count(*) AS count FROM sqlite_master").all();
    database.close();
    results.push({ runtime, opened: true, error: null });
  } catch (error) {
    results.push({ runtime, opened: false, error: { name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error) } });
  }
}
console.log(JSON.stringify({ results }));
`;

function runHelper(script, config, env) {
  const completed = spawnSync(process.execPath, [script, JSON.stringify(config)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env ?? process.env });
  const stdout = completed.stdout ?? "";
  const stderr = completed.stderr ?? "";
  let parsed = null;
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") {
        parsed = value;
        break;
      }
    } catch {
      continue;
    }
  }
  return { status: completed.status, signal: completed.signal, stdout, stderr, parsed };
}

function driverRoots(cache) {
  const roots = new Set();
  for (const key of cache) {
    const index = key.indexOf(DRIVER_MARKER);
    if (index > 0) roots.add(key.slice(0, index));
  }
  return [...roots].sort();
}

let outputDirectory = null;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  outputDirectory = options.output;
  assert(statSync(options.output).isDirectory() && readdirSync(options.output).length === 0, "SINGLE_SQLITE_DRIVER_OUTPUT_NOT_EMPTY");
  const oldRuntime = options["old-runtime"];
  const newRuntime = options["new-runtime"];
  const scratch = options.scratch;
  const copy = scratch;

  assert(oldRuntime.endsWith(RUNTIME_SUFFIX) && newRuntime.endsWith(RUNTIME_SUFFIX), "SINGLE_SQLITE_DRIVER_RUNTIME_SUFFIX_INVALID");
  const oldPrefix = oldRuntime.slice(0, -RUNTIME_SUFFIX.length);
  const newPrefix = newRuntime.slice(0, -RUNTIME_SUFFIX.length);

  const assertions = [];
  const check = (name, condition, detail) => {
    assertions.push({ name, passed: Boolean(condition), detail });
    return Boolean(condition);
  };

  const runtimeInfo = (label, runtime) => {
    const addon = `${runtime}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
    assert(existsSync(addon), "SINGLE_SQLITE_DRIVER_ADDON_MISSING");
    return { label, runtime, addon, addonRealpath: realpathSync(addon), addonSha256: sha256File(addon) };
  };
  const oldInfo = runtimeInfo("old", oldRuntime);
  const newInfo = runtimeInfo("new", newRuntime);
  check("runtimes_are_distinct_driver_copies", oldInfo.addonRealpath !== newInfo.addonRealpath, { old: oldInfo.addonRealpath, new: newInfo.addonRealpath });

  const copied = [];
  let maintenanceCommon = { old: 0, new: 0 };
  for (const directory of ["maintenance", "s0-db"]) {
    const sourceDirectory = path.join(packageRoot, directory);
    const targetDirectory = path.join(copy, "adapted-packet", directory);
    mkdirSync(targetDirectory, { recursive: true });
    for (const name of readdirSync(sourceDirectory).sort()) {
      if (!name.endsWith(".mjs") || name.startsWith("verify-")) continue;
      const source = readFileSync(path.join(sourceDirectory, name), "utf8");
      const oldCount = source.split(OLD_LITERAL).length - 1;
      const newCount = source.split(NEW_LITERAL).length - 1;
      const replaced = source.split(OLD_LITERAL).join(oldPrefix).split(NEW_LITERAL).join(newPrefix);
      if (directory === "maintenance" && name === "maintenance-common.mjs") maintenanceCommon = { old: oldCount, new: newCount };
      writeFileSync(path.join(targetDirectory, name), replaced, { mode: 0o600 });
      copied.push({ path: `${directory}/${name}`, oldReplacements: oldCount, newReplacements: newCount });
    }
  }
  const commonPath = path.join(copy, "adapted-packet", "maintenance", "maintenance-common.mjs");
  check("maintenance_common_replaces_both_prefixes", maintenanceCommon.old >= 1 && maintenanceCommon.new >= 1, maintenanceCommon);
  const adaptedText = readFileSync(commonPath, "utf8");
  check("adapted_common_has_no_default_prefixes", !adaptedText.includes(OLD_LITERAL) && !adaptedText.includes(NEW_LITERAL), { common: commonPath });

  const helperDirectory = path.join(copy, "helpers");
  mkdirSync(helperDirectory, { recursive: true });
  const openOrderHelper = path.join(helperDirectory, "open-order.mjs");
  const createDatabasesHelper = path.join(helperDirectory, "create-databases.mjs");
  const controlConflictHelper = path.join(helperDirectory, "control-conflict.mjs");
  writeFileSync(openOrderHelper, OPEN_ORDER_SOURCE, { mode: 0o600 });
  writeFileSync(createDatabasesHelper, CREATE_DATABASES_SOURCE, { mode: 0o600 });
  writeFileSync(controlConflictHelper, CONTROL_CONFLICT_SOURCE, { mode: 0o600 });

  const databaseDirectory = path.join(copy, "db");
  mkdirSync(databaseDirectory, { recursive: true });
  const mainDatabase = path.join(databaseDirectory, "main.sqlite");
  const copyDatabase = path.join(databaseDirectory, "copy.sqlite");
  const created = runHelper(createDatabasesHelper, { runtime: oldRuntime, files: [mainDatabase, copyDatabase] });
  assert(created.status === 0 && created.parsed?.created?.length === 2, "SINGLE_SQLITE_DRIVER_DATABASE_CREATION_FAILED");
  const header = (filename) => {
    const bytes = readFileSync(filename);
    return { bytes: bytes.length, formatWrite: bytes[18], formatRead: bytes[19] };
  };
  const databases = {
    oldDriver: oldRuntime,
    main: { path: mainDatabase, sha256: sha256File(mainDatabase), header: header(mainDatabase), sidecarsAbsent: sidecarsAbsent(mainDatabase) },
    copy: { path: copyDatabase, sha256: sha256File(copyDatabase), header: header(copyDatabase), sidecarsAbsent: sidecarsAbsent(copyDatabase) },
  };
  for (const label of ["main", "copy"]) {
    check(`database_${label}_is_wal_format`, databases[label].header.formatWrite === 2 && databases[label].header.formatRead === 2, databases[label].header);
    check(`database_${label}_has_no_sidecars`, databases[label].sidecarsAbsent, { path: databases[label].path });
  }

  const orderSteps = {
    "s3-then-s7-order": [
      { prefix: oldPrefix, filename: copyDatabase },
      { prefix: newPrefix, filename: mainDatabase },
    ],
    "reverse-order": [
      { prefix: newPrefix, filename: mainDatabase },
      { prefix: oldPrefix, filename: copyDatabase },
    ],
    "old-only": [
      { prefix: oldPrefix, filename: mainDatabase },
      { prefix: oldPrefix, filename: copyDatabase },
    ],
    "new-only": [
      { prefix: newPrefix, filename: mainDatabase },
      { prefix: newPrefix, filename: copyDatabase },
    ],
  };
  const orders = {};
  for (const [name, steps] of Object.entries(orderSteps)) {
    const run = runHelper(openOrderHelper, { common: commonPath, steps });
    const results = run.parsed?.results ?? null;
    const cache = run.parsed?.cache ?? [];
    const roots = driverRoots(cache);
    const entry = { steps: steps.map((step) => ({ prefix: step.prefix, filename: path.basename(step.filename) })), status: run.status, signal: run.signal, results, driverRoots: roots, stderr: run.stderr };
    orders[name] = entry;
    check(`order_${name}_ran_in_own_process`, run.status === 0 && Array.isArray(results) && results.length === steps.length, { status: run.status, signal: run.signal, stderr: run.stderr.slice(0, 2000) });
    check(`order_${name}_every_open_succeeded`, Array.isArray(results) && results.length === steps.length && results.every((row) => row.opened === true), results);
    check(`order_${name}_loads_one_driver`, roots.length === 1, { driverRoots: roots });
  }

  const control = runHelper(controlConflictHelper, { runtimes: [oldRuntime, newRuntime], filename: mainDatabase }, { ...process.env, SQLITE_USE_URI: "1" });
  const controlResults = control.parsed?.results ?? null;
  const controlEntry = { status: control.status, signal: control.signal, results: controlResults, stderr: control.stderr };
  check("control_first_driver_opens", Array.isArray(controlResults) && controlResults.length === 2 && controlResults[0].opened === true, controlResults);
  check("control_second_driver_conflicts", Array.isArray(controlResults) && controlResults.length === 2 && controlResults[1].opened === false && controlResults[1].error?.code === "SQLITE_CANTOPEN", controlResults);

  const finalSidecars = { main: sidecarsAbsent(mainDatabase), copy: sidecarsAbsent(copyDatabase) };
  check("databases_have_no_sidecars_after_all_opens", finalSidecars.main && finalSidecars.copy, finalSidecars);

  const passed = assertions.every((row) => row.passed);
  return {
    schemaVersion: "himawari.__PKT_LABEL__-single-sqlite-driver.v1",
    checkedAt: new Date().toISOString(),
    hostname: hostname(),
    passed,
    runtimes: { old: oldInfo, new: newInfo },
    adaptation: { oldLiteral: OLD_LITERAL, newLiteral: NEW_LITERAL, oldPrefix, newPrefix, copied },
    databases,
    orders,
    control: controlEntry,
    assertions,
    failedAssertions: assertions.filter((row) => !row.passed).map((row) => row.name),
  };
}

main().then((report) => {
  writeFileSync(path.join(outputDirectory, "single-sqlite-driver-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, assertions: report.assertions.length, failed: report.failedAssertions }));
  process.exitCode = report.passed ? 0 : 1;
}).catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exitCode = 1;
});
