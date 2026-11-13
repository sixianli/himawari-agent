#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountName,
  addSlot,
  directoryPlan,
  emptyLedger,
  knownUnitNames,
  parseExecConfig,
  parseLedger,
  personPaths,
  removeSlot,
  renderTmpfiles,
  renderUnits,
  serviceName,
  socketName,
} from "./plan.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    slot: undefined,
    config: "/etc/himawari/exec.json",
    ledger: "/etc/himawari/exec-slots.json",
    units: "/etc/systemd/system",
    backups: "/var/backups/himawari-exec",
    tmpfiles: "/etc/tmpfiles.d/himawari-exec.conf",
    init: false,
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
    else if (key === "--tmpfiles") options.tmpfiles = take();
    else if (key === "--init") options.init = true;
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

const OWN_UNIT = /^himawari-exec(\.slice|-[a-z][a-z0-9]{5}\.(slice|socket|service))$/;

function refuseInitOverResidue(options, config) {
  const residue = [
    ...[config.privateRoots, config.workspaceRoots].flatMap((root) =>
      existsSync(root) ? readdirSync(root).map((name) => path.join(root, name)) : [],
    ),
    ...(existsSync(options.units)
      ? readdirSync(options.units)
          .filter((name) => OWN_UNIT.test(name))
          .map((name) => path.join(options.units, name))
      : []),
    ...run("getent", ["passwd"])
      .split("\n")
      .map((line) => line.split(":")[0])
      .filter((name) => /^hx-[a-z][a-z0-9]{5}$/.test(name)),
  ];
  if (residue.length > 0) throw new Error(`EXEC_INIT_OVER_EXISTING ${residue[0]}`);
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lock, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      return descriptor;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(lock, "utf8"), 10);
      let alive = true;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (killError) {
          alive = killError?.code !== "ESRCH";
        }
      } else {
        alive = Date.now() - statSync(lock).mtimeMs < 10_000;
      }
      if (alive) throw new Error(`EXEC_LOCKED ${lock} held by pid ${owner}`);
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`EXEC_LOCKED ${lock}`);
}

function readLedger(file, allowMissing) {
  if (existsSync(file)) return parseLedger(readJson(file));
  if (!allowMissing) throw new Error(`EXEC_LEDGER_MISSING ${file}`);
  return emptyLedger();
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

function setOwnerAndMode(directory, uid, gid, mode) {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fchownSync(descriptor, uid, gid);
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
}

function ensureGroup(config) {
  if (!quiet("getent", ["group", config.serviceAccount]))
    throw new Error(`EXEC_SERVICE_GROUP_MISSING ${config.serviceAccount}`);
  if (!quiet("getent", ["group", config.peopleGroup]))
    run("groupadd", ["--system", config.peopleGroup]);
  const groupMembers = run("getent", ["group", config.peopleGroup])
    .trim()
    .split(":")[3]
    .split(",")
    .filter((name) => name !== "");
  const stranger = groupMembers.find((name) => name !== config.serviceAccount);
  if (stranger !== undefined) throw new Error(`EXEC_PEOPLE_GROUP_SHARED ${stranger}`);
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
  setOwnerAndMode(entry.path, uid, gid, Number.parseInt(entry.mode, 8));
}

function presentUnits(directory, known) {
  return existsSync(directory) ? readdirSync(directory).filter((name) => known.has(name)) : [];
}

function backupUnits(options, known) {
  const target = path.join(
    options.backups,
    `${new Date().toISOString().replaceAll(":", "").replace(/\..*/, "")}-${process.pid}`,
  );
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of presentUnits(options.units, known))
    copyFileSync(path.join(options.units, name), path.join(target, name));
  return target;
}

function restoreUnits(options, known, backup) {
  for (const name of presentUnits(options.units, known)) rmSync(path.join(options.units, name));
  for (const name of readdirSync(backup))
    copyFileSync(path.join(backup, name), path.join(options.units, name));
  if (options.systemd) quiet("systemctl", ["daemon-reload"]);
}

function checkGatewayFiles(config) {
  for (const [file, executable] of [
    [config.gateway.node, true],
    [config.gateway.entry, false],
  ]) {
    const metadata = lstatSync(file);
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o004) === 0 ||
      (executable && (metadata.mode & 0o001) === 0)
    )
      throw new Error(`EXEC_GATEWAY_FILE_UNSAFE ${file}`);
  }
}

function retire(options, config, slot) {
  if (options.systemd) {
    quiet("systemctl", ["disable", "--now", socketName(slot)]);
    quiet("systemctl", ["stop", serviceName(slot)]);
    for (const unit of [socketName(slot), serviceName(slot)])
      if (quiet("systemctl", ["is-active", "--quiet", unit]))
        throw new Error(`EXEC_UNIT_STILL_ACTIVE ${unit}`);
  }
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..*/, "");
  const paths = personPaths(config, slot);
  for (const directory of [paths.privateRoot, paths.workspace]) {
    if (!existsSync(directory)) continue;
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error(`EXEC_DIRECTORY_NOT_PLAIN ${directory}`);
    setOwnerAndMode(directory, 0, 0, 0o700);
    renameSync(directory, `${directory}.removed-${stamp}`);
  }
  if (quiet("id", [accountName(slot)]))
    run("usermod", ["--lock", "--expiredate", "1", accountName(slot)]);
}

function converge(options, config, ledger) {
  const known = knownUnitNames(ledger);
  const enabled = [];
  let backup;
  try {
    backup = backupUnits(options, known);
    for (const entry of ledger.slots)
      if (entry.state === "removed") retire(options, config, entry.slot);
    checkGatewayFiles(config);
    for (const entry of ledger.slots)
      if (
        entry.state === "active" &&
        (entry.uid < config.uids.first || entry.uid > config.uids.last)
      )
        throw new Error(`EXEC_LEDGER_UID_OUTSIDE_RANGE ${entry.slot}`);
    ensureGroup(config);
    for (const entry of ledger.slots) if (entry.state === "active") ensureAccount(entry);
    atomicWrite(options.tmpfiles, renderTmpfiles(config), 0o644);
    if (options.systemd) run("systemd-tmpfiles", ["--create", options.tmpfiles]);
    for (const entry of directoryPlan(config, ledger)) {
      ensureDirectory(entry);
      if (realpathSync(entry.path) !== entry.path)
        throw new Error(`EXEC_DIRECTORY_NOT_CANONICAL ${entry.path}`);
    }
    const units = renderUnits(config, ledger);
    for (const name of presentUnits(options.units, known))
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
        if (entry.state === "active") {
          run("systemctl", ["enable", "--now", socketName(entry.slot)]);
          enabled.push(entry.slot);
        }
    }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (options.systemd)
      for (const slot of enabled) quiet("systemctl", ["disable", "--now", socketName(slot)]);
    if (backup !== undefined) {
      try {
        restoreUnits(options, known, backup);
      } catch (restoreError) {
        message += `\nEXEC_RESTORE_FAILED ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
      }
    }
    throw new Error(
      `${message}\nEXEC_APPLY_INCOMPLETE the slot ledger is kept; fix the cause and run apply again`,
    );
  }
}

function status(options, config, ledger) {
  return ledger.slots.map((entry) => ({
    slot: entry.slot,
    uid: entry.uid,
    state: entry.state,
    ...personPaths(config, entry.slot),
    socketActive: options.systemd
      ? quiet("systemctl", ["is-active", "--quiet", socketName(entry.slot)])
      : null,
  }));
}

export function main(argv) {
  const options = parseArgs(argv);
  const config = parseExecConfig(readJson(options.config));
  const ledger = readLedger(
    options.ledger,
    ["plan", "status"].includes(options.command) || (options.command === "add" && options.init),
  );
  if (options.command === "plan")
    return {
      units: Object.fromEntries(renderUnits(config, ledger)),
      directories: directoryPlan(config, ledger),
    };
  if (options.command === "status") return status(options, config, ledger);
  if (typeof process.getuid === "function" && process.getuid() !== 0)
    throw new Error("EXEC_ROOT_REQUIRED");
  const lock = `${options.ledger}.lock`;
  const held = acquireLock(lock);
  try {
    const current = readLedger(options.ledger, options.command === "add" && options.init);
    if (options.command === "add" && options.init) {
      if (current.slots.length > 0) throw new Error("EXEC_INIT_LEDGER_NOT_EMPTY");
      refuseInitOverResidue(options, config);
    }
    const next =
      options.command === "add"
        ? addSlot(current, config, options.slot)
        : options.command === "remove"
          ? removeSlot(current, options.slot)
          : current;
    if (next !== current) atomicWrite(options.ledger, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    converge(options, config, next);
    return status(options, config, readLedger(options.ledger, false));
  } finally {
    rmSync(lock, { force: true });
    closeSync(held);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
