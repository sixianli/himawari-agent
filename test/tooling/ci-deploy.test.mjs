import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const source = path.resolve(import.meta.dirname, "../../scripts/delivery-mode");
const backupSource = path.resolve(import.meta.dirname, "../../scripts/operations/backup");
const directories = [];

function git(repo, ...args) {
  const child = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  expect(child.status).toBe(0);
  return child.stdout.trim();
}

function commitFile(repo, file, content) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    file + content.length,
  );
  return git(repo, "rev-parse", "HEAD");
}

function workspace() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "ci-deploy-"));
  directories.push(`${repo}-fake-ssh.sh`, `${repo}-lost-ssh.sh`);
  directories.push(repo);
  git(repo, "init", "-q");
  mkdirSync(path.join(repo, "scripts/delivery-mode/instances"), { recursive: true });
  for (const file of [
    "ci-deploy.sh",
    "host-system.py",
    "deploy-preflight.py",
    "document-python-requirements.txt",
    "sandbox-command-links.py",
    "embedding-artifact-check.py",
    "deploy-target-paths.py",
  ])
    cpSync(path.join(source, file), path.join(repo, "scripts/delivery-mode", file));
  cpSync(
    path.join(source, "instances/andy-production.json"),
    path.join(repo, "scripts/delivery-mode/instances/andy-production.json"),
  );
  mkdirSync(path.join(repo, "scripts/operations/backup"), { recursive: true });
  cpSync(
    path.join(backupSource, "himawari-backup.py"),
    path.join(repo, "scripts/operations/backup/himawari-backup.py"),
  );
  const first = commitFile(repo, "src/app.ts", "one");
  const fakeSsh = `${repo}-fake-ssh.sh`;
  directories.push(`${repo}-remote.log`, `${repo}-refreshed.py`, `${repo}-host-system.py`);
  writeFileSync(
    fakeSsh,
    [
      "#!/bin/bash",
      "for command; do :; done",
      '[ -n "$FAKE_BACKUP_INSTALLED" ] || FAKE_BACKUP_INSTALLED=1',
      '[ -n "$FAKE_BACKUP_EXIT" ] || FAKE_BACKUP_EXIT=0',
      '[ -n "$FAKE_HOST_SYSTEM_EXIT" ] || FAKE_HOST_SYSTEM_EXIT=0',
      '[ -n "$FAKE_HEARTBEAT_INSTALLED" ] || FAKE_HEARTBEAT_INSTALLED=1',
      '[ -n "$FAKE_HEARTBEAT_EXIT" ] || FAKE_HEARTBEAT_EXIT=0',
      `echo "$command" >> ${repo}-remote.log`,
      'case "$command" in',
      '  "test -f /etc/himawari-backup/settings.json") exit "$FAKE_BACKUP_INSTALLED" ;;',
      `  *himawari-backup.new*) cat > ${repo}-refreshed.py; exit 0 ;;`,
      '  *"himawari-backup run"*) exit "$FAKE_BACKUP_EXIT" ;;',
      '  "test -f /etc/himawari-heartbeat/healthcheck-url") exit "$FAKE_HEARTBEAT_INSTALLED" ;;',
      '  *install-heartbeat.sh*) exit "$FAKE_HEARTBEAT_EXIT" ;;',
      `  "/usr/bin/python3 -I -") cat > ${repo}-host-system.py; exit "$FAKE_HOST_SYSTEM_EXIT" ;;`,
      "esac",
      `echo /opt/himawari/releases/2026-11-25-${first.slice(0, 8)}`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeSsh, 0o755);
  return { repo, first, fakeSsh };
}

function run(repo, environment) {
  return spawnSync("bash", [path.join(repo, "scripts/delivery-mode/ci-deploy.sh")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ci-deploy.sh", () => {
  it("refuses without a host and with an unsafe host", () => {
    const { repo, first } = workspace();
    const none = run(repo, { HIMAWARI_DEPLOY_COMMIT: first });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("HOST_MISSING");
    const unsafe = run(repo, { HIMAWARI_PACKET_HOST: "a;b", HIMAWARI_DEPLOY_COMMIT: first });
    expect(unsafe.stderr).toContain("HOST_UNSAFE");
  });

  it("refuses a commit that is not the checkout", () => {
    const { repo, first } = workspace();
    commitFile(repo, "src/app.ts", "two");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_DEPLOY_COMMIT: first,
    });
    expect(child.stderr).toContain("CHECKOUT_MISMATCH");
  });

  it("skips when the running release is already this commit", () => {
    const { repo, first, fakeSsh } = workspace();
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: first,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("CI_DEPLOY_SKIPPED already-running");
  });

  it("[I-120] skips an older confirmed commit when production already runs a newer one", () => {
    const { repo, first, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "two");
    git(repo, "checkout", "-q", "--detach", first);
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: first,
      HIMAWARI_DEPLOY_SINCE: second,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("CI_DEPLOY_SKIPPED running-is-newer");
    expect(child.stdout).not.toContain("CI_DEPLOY_PREPARE");
  });

  it("[I-120] installs the deploy entry of the commit it runs so entry fixes reach the server", () => {
    const { repo, first, fakeSsh } = workspace();
    const entrySource = path.resolve(import.meta.dirname, "../../scripts/install/deploy-entry");
    cpSync(entrySource, path.join(repo, "scripts/install/deploy-entry"), { recursive: true });
    const library = mkdtempSync(path.join(os.tmpdir(), "entry-library-"));
    directories.push(library, `${library}.old`);
    writeFileSync(path.join(library, "himawari-deploy-entry"), "old entry\n");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: first,
      HIMAWARI_DEPLOY_ENTRY_LIBRARY: library,
    });
    expect(child.stdout).toContain(`CI_DEPLOY_ENTRY_UPDATED ${library} from ${first}`);
    expect(readFileSync(path.join(library, "himawari-deploy-entry"), "utf8")).toBe(
      readFileSync(path.join(entrySource, "himawari-deploy-entry"), "utf8"),
    );
    expect(statSync(path.join(library, "shim/ssh")).mode & 0o777).toBe(0o755);
    const again = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: first,
      HIMAWARI_DEPLOY_ENTRY_LIBRARY: library,
    });
    expect(again.stdout).not.toContain("CI_DEPLOY_ENTRY_UPDATED");
  });

  it("skips when only documents changed since the running release", () => {
    const { repo, first, fakeSsh } = workspace();
    const second = commitFile(repo, "docs/notes.md", "notes");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stdout).toContain(`CI_DEPLOY_RUNNING ${first}`);
    expect(child.stdout).toContain("CI_DEPLOY_SKIPPED no-deployable-files-changed");
    expect(child.status).toBe(0);
  });

  it("goes on to build a packet when program files changed", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stdout).toContain("CI_DEPLOY_PREPARE");
    expect(child.stderr).toContain("PREPARE_FAILED");
    expect(child.status).toBe(3);
  });

  it("[I-120] asks deploy.sh to rehearse the steps after the stop in the shadow machine before it stops production", () => {
    const { repo, fakeSsh } = workspace();
    const scripts = path.join(repo, "scripts/delivery-mode");
    const packet = path.join(repo, "built-packet");
    const seen = `${repo}-deploy-environment`;
    directories.push(seen);
    writeFileSync(
      path.join(scripts, "make-packet.py"),
      `import json\nprint("PACKET_READY " + json.dumps({"packet": ${JSON.stringify(packet)}}))\n`,
    );
    writeFileSync(
      path.join(scripts, "deploy.sh"),
      `echo "shadow=$HIMAWARI_DEPLOY_SHADOW_REHEARSAL packet=$1" > ${JSON.stringify(seen)}\necho "DEPLOY_STOPPED_AT SHADOW_REHEARSAL" >&2\nexit 10\n`,
    );
    mkdirSync(packet, { recursive: true });
    writeFileSync(path.join(packet, "keep"), "");
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(readFileSync(seen, "utf8")).toBe(`shadow=1 packet=${packet}\n`);
    expect(child.stderr).toContain("CI_DEPLOY_FAILED exit=10");
    expect(child.stdout).not.toContain("CI_DEPLOY_READBACK");
    expect(child.status).toBe(4);
  });

  it("warns and goes on when the backup is not installed yet", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stderr).toContain("CI_DEPLOY_BACKUP_NOT_INSTALLED");
    expect(child.stdout).toContain("CI_DEPLOY_PREPARE");
  });

  it("backs up before building a packet and refreshes the backup tool from the deployed commit", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
      FAKE_BACKUP_INSTALLED: "0",
    });
    const output = child.stdout;
    expect(output.indexOf("CI_DEPLOY_BACKUP_START")).toBeGreaterThan(-1);
    expect(output.indexOf("CI_DEPLOY_BACKUP_START")).toBeLessThan(
      output.indexOf("CI_DEPLOY_PREPARE"),
    );
    const log = readFileSync(`${repo}-remote.log`, "utf8");
    expect(log).toContain("himawari-backup run --reason pre-deploy");
    expect(readFileSync(`${repo}-refreshed.py`, "utf8")).toBe(
      readFileSync(path.join(backupSource, "himawari-backup.py"), "utf8"),
    );
  });

  it("deploys nothing when the backup before deploying fails", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
      FAKE_BACKUP_INSTALLED: "0",
      FAKE_BACKUP_EXIT: "1",
    });
    expect(child.status).toBe(6);
    expect(child.stderr).toContain("CI_DEPLOY_REFUSED BACKUP_FAILED");
    expect(child.stdout).not.toContain("CI_DEPLOY_PREPARE");
  });

  it("reinstalls the heartbeat with the outage push from the deployed commit before building", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
      FAKE_HEARTBEAT_INSTALLED: "0",
    });
    const output = child.stdout;
    expect(output.indexOf("CI_DEPLOY_HEARTBEAT_REFRESH")).toBeGreaterThan(-1);
    expect(output.indexOf("CI_DEPLOY_HEARTBEAT_REFRESH")).toBeLessThan(
      output.indexOf("CI_DEPLOY_PREPARE"),
    );
    expect(readFileSync(`${repo}-remote.log`, "utf8")).toContain(
      `bash '${repo}/scripts/operations/heartbeat/install-heartbeat.sh' install --keep-url --instance '${repo}/scripts/delivery-mode/instances/andy-production.json'`,
    );
  });

  it("deploys nothing when the heartbeat cannot be reinstalled, and only warns when it was never installed", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const failed = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
      FAKE_HEARTBEAT_INSTALLED: "0",
      FAKE_HEARTBEAT_EXIT: "2",
    });
    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain("CI_DEPLOY_REFUSED HEARTBEAT_REFRESH_FAILED");
    expect(failed.stdout).not.toContain("CI_DEPLOY_PREPARE");
    const missing = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(missing.stderr).toContain("CI_DEPLOY_HEARTBEAT_NOT_INSTALLED");
    expect(missing.stdout).toContain("CI_DEPLOY_PREPARE");
  });

  it("tightens the database file modes before building the packet", () => {
    const { repo, first } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const log = `${repo}-ssh-calls.log`;
    directories.push(log);
    const recorder = `${repo}-fake-ssh.sh`;
    writeFileSync(
      recorder,
      `#!/bin/bash\necho "$@" >> ${log}\ncat > /dev/null\necho /opt/himawari/releases/2026-11-25-${first.slice(0, 8)}\n`,
    );
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: recorder,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stdout).toContain("CI_DEPLOY_DB_PERMISSIONS");
    expect(child.stdout.indexOf("CI_DEPLOY_DB_PERMISSIONS")).toBeLessThan(
      child.stdout.indexOf("CI_DEPLOY_PREPARE"),
    );
    expect(readFileSync(log, "utf8")).toContain("chmod 600");
    expect(child.stdout.indexOf("CI_DEPLOY_NODE_OWNERSHIP")).toBeGreaterThan(-1);
    expect(child.stdout.indexOf("CI_DEPLOY_NODE_OWNERSHIP")).toBeLessThan(
      child.stdout.indexOf("CI_DEPLOY_PREPARE"),
    );
    expect(readFileSync(log, "utf8")).toContain("chown -R root:root /opt/himawari/node");
    expect(child.stdout.indexOf("CI_DEPLOY_BUILDER_HOME_OWNERSHIP")).toBeGreaterThan(-1);
    expect(child.stdout.indexOf("CI_DEPLOY_BUILDER_HOME_OWNERSHIP")).toBeLessThan(
      child.stdout.indexOf("CI_DEPLOY_PREPARE"),
    );
    expect(readFileSync(log, "utf8")).toContain("chown -R himawari-build:himawari-build");
  });

  it("installs the document tools and pins the next boot before building the packet", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stdout.indexOf("CI_DEPLOY_HOST_SYSTEM")).toBeGreaterThan(-1);
    expect(child.stdout.indexOf("CI_DEPLOY_HOST_SYSTEM")).toBeLessThan(
      child.stdout.indexOf("CI_DEPLOY_PREPARE"),
    );
    const program = readFileSync(`${repo}-host-system.py`, "utf8");
    expect(program).toContain("HOST_SYSTEM_OK");
    expect(program).toContain("weasyprint==70.0");
  });

  it("[I-120] clears what the last failed attempt left on the host before building the next packet", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const outputRoot = path.join(repo, ".ci-output/production");
    for (const name of ["2026-11-27-first-change-packet-06", "2026-11-27-first-change-packet-07"]) {
      mkdirSync(path.join(outputRoot, name, "inputs"), { recursive: true });
      writeFileSync(path.join(outputRoot, name, "inputs/bindings.json"), "{}");
      writeFileSync(path.join(outputRoot, name, "freeze-manifest.json"), "{}");
    }
    directories.push(`${repo}-cleanup.log`);
    writeFileSync(
      path.join(repo, "scripts/delivery-mode/release-cleanup.py"),
      `import sys\nopen(${JSON.stringify(`${repo}-cleanup.log`)}, "a").write(" ".join(sys.argv[1:]) + "\\n")\n`,
    );
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    const cleanup = child.stdout.indexOf("CI_DEPLOY_PREVIOUS_CLEANUP ");
    expect(cleanup).toBeGreaterThan(-1);
    const report = child.stdout.indexOf(
      `CI_DEPLOY_LAST_FAILURE_REPORT ${path.join(outputRoot, "2026-11-27-first-change-packet-07")}`,
    );
    expect(report).toBeGreaterThan(-1);
    expect(report).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(child.stdout.indexOf("CI_DEPLOY_PREPARE"));
    expect(readFileSync(`${repo}-cleanup.log`, "utf8")).toBe(
      `${path.join(outputRoot, "2026-11-27-first-change-packet-07")} apply\n`,
    );
  });

  it("skips the previous-attempt cleanup when no packet was built before", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stdout).not.toContain("CI_DEPLOY_PREVIOUS_CLEANUP");
    expect(child.stdout).toContain("CI_DEPLOY_PREPARE");
  });

  it("deploys nothing when the host system step fails", () => {
    const { repo, fakeSsh } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: fakeSsh,
      HIMAWARI_DEPLOY_COMMIT: second,
      FAKE_HOST_SYSTEM_EXIT: "1",
    });
    expect(child.status).toBe(3);
    expect(child.stderr).toContain("CI_DEPLOY_REFUSED HOST_SYSTEM_FAILED");
    expect(child.stdout).not.toContain("CI_DEPLOY_PREPARE");
  });

  it("refuses when the running release is not a known commit", () => {
    const { repo, first } = workspace();
    const second = commitFile(repo, "src/app.ts", "changed");
    const lost = `${repo}-lost-ssh.sh`;
    writeFileSync(lost, "#!/bin/bash\necho /opt/himawari/releases/2026-11-25-deadbeef\n");
    chmodSync(lost, 0o755);
    const child = run(repo, {
      HIMAWARI_PACKET_HOST: "198.51.100.9",
      HIMAWARI_PACKET_SSH: lost,
      HIMAWARI_DEPLOY_COMMIT: second,
    });
    expect(child.stderr).toContain("RUNNING_COMMIT_UNKNOWN");
    expect(first).not.toBe(second);
  });
});
