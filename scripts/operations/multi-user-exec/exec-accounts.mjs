#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountName,
  addSlot,
  directoryPlan,
  emptyLedger,
  parseExecConfig,
  parseLedger,
  personPaths,
  removeSlot,
  renderUnits,
  serviceName,
  socketName,
} from "./plan.mjs";

const UNIT_PREFIX = "himawari-exec";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    slot: undefined,
    config: "/etc/himawari/exec.json",
    ledger: "/etc/himawari/exec-slots.json",
    units: "/etc/systemd/system",
    backups: "/var/backups/himawari-exec",
    systemd: true,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const take = () => {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`EXEC_ARG_REQUIRED ${key}`);
      index += 1;
      return value;
    };
    if (key === "--config") options.config = take();
    else if (key === "--ledger") options.ledger = take();
    else if (key === "--units") options.units = take();
    else if (key === "--backups") options.backups = take();
    else if (key === "--without-systemd") options.systemd = false;
    else if (!key.startsWith("--") && options.slot === undefined) options.slot = key;
    else throw new Error(`EXEC_ARG_UNKNOWN ${key}`);
  }
  if (!["plan", "add", "apply", "remove", "status"].includes(command))
    throw new Error("EXEC_COMMAND_UNKNOWN");
  if (["add", "remove"].includes(command) !== (options.slot !== undefined))
    throw new Error("EXEC_SLOT_ARGUMENT");
  return options;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readLedger(file) {
  return existsSync(file) ? parseLedger(readJson(file)) : emptyLedger();
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function quiet(command, args) {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(file, content, mode) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode, flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

function ids(name) {
  return {
    uid: Number(run("id", ["-u", name]).trim()),
    gid: Number(run("getent", ["group", name]).split(":")[2]),
  };
}

function groupId(name) {
  return Number(run("getent", ["group", name]).split(":")[2]);
}

function ensureGroup(config) {
  if (!quiet("getent", ["group", config.peopleGroup]))
    run("groupadd", ["--system", config.peopleGroup]);
  const members = run("id", ["-nG", config.serviceAccount]).trim().split(/\s+/);
  if (!members.includes(config.peopleGroup))
    run("usermod", ["--append", "--groups", config.peopleGroup, config.serviceAccount]);
}

function ensureAccount(entry) {
  const name = accountName(entry.slot);
  if (quiet("id", [name])) {
    if (ids(name).uid !== entry.uid) throw new Error(`EXEC_ACCOUNT_UID_MISMATCH ${name}`);
  } else {
    run("useradd", [
      "--uid",
      String(entry.uid),
      "--user-group",
      "--no-create-home",
      "--home-dir",
      "/nonexistent",
      "--shell",
      "/usr/sbin/nologin",
      name,
    ]);
  }
  const groups = run("id", ["-nG", name]).trim().split(/\s+/);
  if (groups.length !== 1 || groups[0] !== name)
    throw new Error(`EXEC_ACCOUNT_EXTRA_GROUPS ${name} ${groups.join(",")}`);
}

function ensureDirectory(entry) {
  if (existsSync(entry.path)) {
    if (lstatSync(entry.path).isSymbolicLink() || !lstatSync(entry.path).isDirectory())
      throw new Error(`EXEC_DIRECTORY_NOT_PLAIN ${entry.path}`);
  } else {
    mkdirSync(entry.path, { mode: 0o700 });
  }
  const uid = entry.owner === "root" ? 0 : ids(entry.owner).uid;
  const gid = entry.group === "root" ? 0 : groupId(entry.group);
  chownSync(entry.path, uid, gid);
  chmodSync(entry.path, Number.parseInt(entry.mode, 8));
}

function ownedUnits(directory) {
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith(UNIT_PREFIX))
    : [];
}

function backupUnits(options) {
  const target = path.join(
    options.backups,
    new Date().toISOString().replaceAll(":", "").replace(/\..*/, ""),
  );
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ownedUnits(options.units))
    copyFileSync(path.join(options.units, name), path.join(target, name));
  if (existsSync(options.ledger))
    copyFileSync(options.ledger, path.join(target, "exec-slots.json"));
  return target;
}

function restoreUnits(options, backup) {
  for (const name of ownedUnits(options.units)) rmSync(path.join(options.units, name));
  for (const name of readdirSync(backup).filter((item) => item.startsWith(UNIT_PREFIX)))
    copyFileSync(path.join(backup, name), path.join(options.units, name));
  if (options.systemd) quiet("systemctl", ["daemon-reload"]);
}

function apply(options, config, ledger, previous) {
  const backup = backupUnits(options);
  try {
    ensureGroup(config);
    for (const entry of ledger.slots) if (entry.state === "active") ensureAccount(entry);
    for (const entry of directoryPlan(config, ledger)) ensureDirectory(entry);
    const units = renderUnits(config, ledger);
    for (const name of ownedUnits(options.units))
      if (!units.has(name)) rmSync(path.join(options.units, name));
    for (const [name, content] of units)
      atomicWrite(path.join(options.units, name), content, 0o644);
    if (options.systemd) {
      run("systemd-analyze", [
        "verify",
        ...[...units.keys()].map((name) => path.join(options.units, name)),
      ]);
      run("systemctl", ["daemon-reload"]);
      for (const entry of ledger.slots)
        if (entry.state === "active") run("systemctl", ["enable", "--now", socketName(entry.slot)]);
    }
    atomicWrite(options.ledger, `${JSON.stringify(ledger, null, 2)}\n`, 0o600);
  } catch (error) {
    restoreUnits(options, backup);
    if (previous) atomicWrite(options.ledger, `${JSON.stringify(previous, null, 2)}\n`, 0o600);
    throw error;
  }
}

function remove(options, config, ledger, slot) {
  const next = removeSlot(ledger, slot);
  if (options.systemd) {
    quiet("systemctl", ["disable", "--now", socketName(slot)]);
    quiet("systemctl", ["stop", serviceName(slot)]);
  }
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..*/, "");
  const paths = personPaths(config, slot);
  for (const directory of [paths.privateRoot, paths.workspace])
    if (existsSync(directory) && !lstatSync(directory).isSymbolicLink()) {
      renameSync(directory, `${directory}.removed-${stamp}`);
      chownSync(`${directory}.removed-${stamp}`, 0, 0);
      chmodSync(`${directory}.removed-${stamp}`, 0o700);
    }
  quiet("usermod", ["--lock", "--expiredate", "1", accountName(slot)]);
  apply(options, config, next, ledger);
}

function status(options, config, ledger) {
  return ledger.slots.map((entry) => ({
    slot: entry.slot,
    uid: entry.uid,
    state: entry.state,
    ...personPaths(config, entry.slot),
    socketActive:
      entry.state === "active" && options.systemd
        ? quiet("systemctl", ["is-active", "--quiet", socketName(entry.slot)])
        : null,
  }));
}

export function main(argv) {
  const options = parseArgs(argv);
  const config = parseExecConfig(readJson(options.config));
  const ledger = readLedger(options.ledger);
  if (options.command === "plan")
    return {
      units: Object.fromEntries(renderUnits(config, ledger)),
      directories: directoryPlan(config, ledger),
    };
  if (options.command === "status") return status(options, config, ledger);
  if (typeof process.getuid === "function" && process.getuid() !== 0)
    throw new Error("EXEC_ROOT_REQUIRED");
  if (options.command === "add")
    apply(options, config, addSlot(ledger, config, options.slot), ledger);
  else if (options.command === "apply") apply(options, config, ledger, ledger);
  else remove(options, config, ledger, options.slot);
  return status(options, config, readLedger(options.ledger));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
