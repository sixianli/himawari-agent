#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "exec-accounts.mjs");
const deadline = setTimeout(() => {
  process.stderr.write("QUALIFY_TIMEOUT\n");
  cleanup();
  process.exit(1);
}, 60_000);

if (process.getuid?.() !== 0) {
  process.stderr.write("QUALIFY_ROOT_REQUIRED\n");
  process.exit(2);
}

const tag = randomBytes(3).toString("hex");
const base = mkdtempSync("/tmp/q");
const serviceAccount = `hxq${tag}s`;
const peopleGroup = `hxq${tag}p`;
const slots = [`qa${tag.slice(0, 4)}`, `qb${tag.slice(0, 4)}`];
const files = {
  config: path.join(base, "exec.json"),
  ledger: path.join(base, "slots.json"),
  units: path.join(base, "units"),
  backups: path.join(base, "backups"),
  tmpfiles: path.join(base, "himawari-exec.conf"),
};

function sh(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function freeUidRange() {
  for (let first = 64000; first < 65000; first += 10) {
    const taken = Array.from({ length: 10 }, (_, offset) => first + offset).some(
      (uid) => spawnSync("getent", ["passwd", String(uid)]).status === 0,
    );
    if (!taken) return { first, last: first + 9 };
  }
  throw new Error("QUALIFY_NO_FREE_UIDS");
}

function cleanup() {
  for (const slot of slots) spawnSync("userdel", [`hx-${slot}`]);
  spawnSync("userdel", [serviceAccount]);
  spawnSync("groupdel", [peopleGroup]);
  for (const slot of slots) spawnSync("groupdel", [`hx-${slot}`]);
  rmSync(base, { recursive: true, force: true });
}

function exec(...args) {
  return JSON.parse(
    sh(process.execPath, [
      cli,
      ...args,
      "--config",
      files.config,
      "--ledger",
      files.ledger,
      "--units",
      files.units,
      "--backups",
      files.backups,
      "--tmpfiles",
      files.tmpfiles,
      "--without-systemd",
    ]),
  );
}

function as(account, script, groups = "clear") {
  const result = spawnSync(
    "setpriv",
    [
      `--reuid=${account}`,
      `--regid=${account}`,
      groups === "clear" ? "--clear-groups" : "--init-groups",
      "sh",
      "-c",
      `umask 0007; ${script}`,
    ],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

function expectTrue(condition, code) {
  if (!condition) throw new Error(code);
}

try {
  chmodSync(base, 0o755);
  mkdirSync(files.units);
  sh("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", serviceAccount]);
  writeFileSync(
    files.config,
    JSON.stringify({
      privateRoots: path.join(base, "j"),
      workspaceRoots: path.join(base, "w"),
      socketDirectory: path.join(base, "s"),
      serviceAccount,
      peopleGroup,
      uids: freeUidRange(),
      gateway: {
        node: process.execPath,
        entry: path.resolve(here, "../../../packages/runtime-sandbox/src/job-host-gateway-main.ts"),
        idleExitMs: 1,
      },
      allPeople: { MemoryMax: "2G", MemoryHigh: "1G", CPUQuota: "100%", TasksMax: "10" },
      person: {
        MemoryMax: "1G",
        MemoryHigh: "1G",
        CPUQuota: "50%",
        TasksMax: "5",
        LimitNOFILE: "64",
      },
      people: {},
    }),
  );
  let refused = false;
  try {
    exec("add", slots[0]);
  } catch {
    refused = true;
  }
  expectTrue(refused && !existsSync(files.ledger), "MISSING_LEDGER_ACCEPTED");
  exec("add", slots[0], "--init");
  exec("add", slots[1]);
  const [a, b] = slots;
  const foreign = path.join(files.units, "himawari-exec-zzzzzz.service");
  writeFileSync(foreign, "[Service]\n");
  const unitText = readFileSync(path.join(files.units, `himawari-exec-${a}.service`), "utf8");
  exec("apply");
  exec("apply");
  expectTrue(existsSync(foreign), "FOREIGN_UNIT_DELETED");
  expectTrue(
    readFileSync(path.join(files.units, `himawari-exec-${a}.service`), "utf8") === unitText,
    "APPLY_NOT_IDEMPOTENT",
  );
  rmSync(foreign);
  const ledgerText = readFileSync(files.ledger, "utf8");
  rmSync(files.ledger);
  let reinit = false;
  try {
    exec("add", slots[0], "--init");
  } catch {
    reinit = true;
  }
  expectTrue(reinit && !existsSync(files.ledger), "INIT_OVER_EXISTING_ACCEPTED");
  writeFileSync(files.ledger, ledgerText, { mode: 0o600 });
  const work = (slot) => path.join(base, "w", slot);
  const priv = (slot) => path.join(base, "j", slot);
  expectTrue(
    as(`hx-${a}`, `echo a > ${work(a)}/file && echo a > ${priv(a)}/file`),
    "OWN_WRITE_DENIED",
  );
  expectTrue(
    as(`hx-${b}`, `echo b > ${work(b)}/file && echo b > ${priv(b)}/file`),
    "OWN_WRITE_DENIED",
  );
  expectTrue(!as(`hx-${a}`, `ls ${work(b)}`), "OTHER_WORKSPACE_LISTED");
  expectTrue(!as(`hx-${a}`, `cat ${work(b)}/file`), "OTHER_WORKSPACE_READ");
  expectTrue(!as(`hx-${a}`, `cat ${priv(b)}/file`), "OTHER_PRIVATE_READ");
  expectTrue(!as(`hx-${a}`, `echo x > ${work(b)}/intruder`), "OTHER_WORKSPACE_WRITTEN");
  expectTrue(
    as(serviceAccount, `cat ${work(a)}/file && echo s >> ${work(a)}/file`, "init"),
    "SERVICE_WORKSPACE_DENIED",
  );
  expectTrue(!as(serviceAccount, `cat ${priv(a)}/file`, "init"), "SERVICE_PRIVATE_READ");
  expectTrue(!as(serviceAccount, `ls ${priv(a)}`, "init"), "SERVICE_PRIVATE_LISTED");
  expectTrue(!as(`hx-${a}`, `ls ${priv(b)}`), "OTHER_PRIVATE_LISTED");
  expectTrue(!as(serviceAccount, `cat ${work(a)}/file`), "WORKSPACE_OPEN_WITHOUT_GROUP");
  expectTrue(
    (statSync(path.join(work(a), "file")).mode & 0o777) === 0o660 &&
      statSync(path.join(work(a), "file")).gid ===
        Number(sh("getent", ["group", peopleGroup]).split(":")[2]),
    "WORKSPACE_FILE_NOT_SHARED",
  );
  expectTrue(sh("id", ["-nG", `hx-${a}`]).trim() === `hx-${a}`, "EXTRA_GROUPS");
  expectTrue(existsSync(path.join(files.units, `himawari-exec-${a}.service`)), "UNIT_MISSING");
  exec("remove", b);
  expectTrue(!existsSync(work(b)) && !existsSync(priv(b)), "REMOVED_DIRECTORY_KEPT");
  expectTrue(
    readdirSync(path.join(base, "w")).some((name) => name.startsWith(`${b}.removed-`)),
    "REMOVED_DIRECTORY_DELETED",
  );
  expectTrue(
    !as(`hx-${b}`, `ls ${path.join(base, "w")}/${b}.removed-*`),
    "REMOVED_DIRECTORY_REACHABLE",
  );
  expectTrue(
    !existsSync(path.join(files.units, `himawari-exec-${b}.service`)),
    "REMOVED_UNIT_KEPT",
  );
  exec("apply");
  expectTrue(
    !existsSync(path.join(files.units, `himawari-exec-${b}.service`)) &&
      readdirSync(path.join(base, "w")).filter((name) => name.startsWith(`${b}.removed-`))
        .length === 1,
    "APPLY_AFTER_REMOVE_CHANGED",
  );
  const status = exec("status");
  expectTrue(
    status.find((entry) => entry.slot === b)?.state === "removed" &&
      status.find((entry) => entry.slot === a)?.state === "active",
    "STATUS_WRONG",
  );
  process.stdout.write(`${JSON.stringify({ status: "passed", slots })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  cleanup();
}
