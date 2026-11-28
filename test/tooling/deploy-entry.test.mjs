import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entry = path.resolve(
  import.meta.dirname,
  "../../scripts/install/deploy-entry/himawari-deploy-entry",
);
const shim = path.resolve(import.meta.dirname, "../../scripts/install/deploy-entry/shim");
const directories = [];

function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deploy-entry-"));
  directories.push(directory);
  return directory;
}

function git(repo, ...args) {
  const child = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  return child.stdout.trim();
}

function source() {
  const repo = temporary();
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(path.join(repo, "scripts/delivery-mode"), { recursive: true });
  writeFileSync(
    path.join(repo, "scripts/delivery-mode/ci-deploy.sh"),
    '#!/bin/bash\necho "STUB commit=$HIMAWARI_DEPLOY_COMMIT since=$HIMAWARI_DEPLOY_SINCE force=$HIMAWARI_DEPLOY_FORCE host=$HIMAWARI_PACKET_HOST path=$PATH"\n',
  );
  writeFileSync(
    path.join(repo, "scripts/delivery-mode/shadow-rehearsal.sh"),
    '#!/bin/bash\necho "SHADOW_STUB args=$*"\n',
  );
  mkdirSync(path.join(repo, "scripts/delivery-mode/hermes"), { recursive: true });
  writeFileSync(
    path.join(repo, "scripts/delivery-mode/hermes/install-dependencies-if-changed.sh"),
    '#!/bin/bash\nmkdir "$3" || exit 5\n[[ -f node_modules/kept ]] && echo "dependencies=kept"\nmkdir -p node_modules .ci-output && touch node_modules/kept .ci-output/marker\necho "dependencies=stub evidence=$3"\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main");
  const main = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(path.join(repo, "side.txt"), "side");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "side");
  const side = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  return { repo, main, side };
}

function fakeTools() {
  const tools = temporary();
  mkdirSync(path.join(tools, "bin"));
  symlinkSync(process.execPath, path.join(tools, "bin/node"));
  return tools;
}

function runEntry(request, repo, tools = fakeTools(), base = temporary(), extra = {}) {
  return spawnSync("bash", [entry], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SSH_ORIGINAL_COMMAND: request,
      HIMAWARI_DEPLOY_BASE: base,
      HIMAWARI_DEPLOY_REPO_URL: repo,
      HIMAWARI_DEPLOY_TOOLS: tools,
      ...extra,
    },
  });
}

function holdLock(base, { detached }) {
  const lock = path.join(base, "deploy.lock");
  const ready = path.join(base, "holder.ready");
  const pidFile = path.join(base, "holder.pid");
  const script = `exec 9> ${JSON.stringify(lock)}; flock -n 9 || exit 3; echo $$ > ${JSON.stringify(pidFile)}; touch ${JSON.stringify(ready)}; exec sleep 60`;
  const child = detached
    ? spawn("setsid", ["-f", "bash", "-c", script], { stdio: "ignore" })
    : spawn("bash", ["-c", script], { stdio: "ignore" });
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      readFileSync(ready);
      break;
    } catch {
      spawnSync("sleep", ["0.1"]);
    }
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  directories.push({
    kill: () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    },
  });
  return { child, pid };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (typeof directory === "string") rmSync(directory, { recursive: true, force: true });
    else directory.kill();
  }
});

describe("himawari-deploy-entry", () => {
  it("accepts only the one deploy request shape", () => {
    const { repo, main } = source();
    for (const request of [
      "",
      "ls",
      `deploy ${main}; id - 0`,
      `deploy ${main} - 2`,
      `deploy ${main.toUpperCase()} - 0`,
      `rehearse ${main}`,
      `rehearse ${main} full`,
      `rehearse ${main} boot; id`,
    ]) {
      const child = runEntry(request, repo);
      expect(child.status).toBe(64);
      expect(child.stderr).toContain("REQUEST_INVALID");
    }
  });

  it("runs the production ops script from main without touching the deploy checkout", () => {
    const { repo } = source();
    mkdirSync(path.join(repo, "scripts/operations"), { recursive: true });
    writeFileSync(
      path.join(repo, "scripts/operations/production-ops.sh"),
      '#!/bin/bash\necho "OPS_STUB action=$1 key=$(head -c 4 "$HIMAWARI_OPS_PUBLIC_KEY") lock=$HIMAWARI_OPS_LOCK"\n',
    );
    writeFileSync(path.join(repo, "scripts/operations/production-ops.pub.pem"), "KEY!");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ops");
    const base = temporary();
    const child = runEntry("ops diagnose", repo, fakeTools(), base);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("OPS_STUB action=diagnose key=KEY!");
    expect(child.stdout).toContain(`lock=${path.join(base, "deploy.lock")}`);
    expect(spawnSync("test", ["-e", path.join(base, "checkout")]).status).not.toBe(0);
    const passed = runEntry("ops allow-sensitive", repo, fakeTools(), base);
    expect(passed.stdout).toContain("OPS_STUB action=allow-sensitive");
    for (const request of ["ops", "ops Stop", "ops diagnose; id", "ops restart now", "ops ../x"]) {
      const refused = runEntry(request, repo);
      expect(refused.status).toBe(64);
      expect(refused.stderr).toContain("REQUEST_INVALID");
    }
  });

  it("[I-120] a boot rehearsal checks out the main commit and only starts the old release in the shadow machine", () => {
    const { repo, main, side } = source();
    const child = runEntry(`rehearse ${main} boot`, repo, path.join(temporary(), "none"));
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("SHADOW_STUB args=--boot-only");
    expect(child.stdout).not.toContain("STUB commit=");
    expect(child.stdout).not.toContain("dependencies=");
    const refused = runEntry(`rehearse ${side} boot`, repo);
    expect(refused.status).toBe(65);
    expect(refused.stderr).toContain("COMMIT_NOT_ON_MAIN");
  });

  it("refuses a commit that exists in the repository but is not on main", () => {
    const { repo, side } = source();
    const child = runEntry(`deploy ${side} - 0`, repo);
    expect(child.status).toBe(65);
    expect(child.stderr).toContain("COMMIT_NOT_ON_MAIN");
  });

  it("deploys the same commit again after an earlier attempt and keeps installed dependencies", () => {
    const { repo, main } = source();
    const tools = fakeTools();
    const base = temporary();
    const first = runEntry(`deploy ${main} - 1`, repo, tools, base);
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain("dependencies=kept");
    const second = runEntry(`deploy ${main} - 1`, repo, tools, base);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("dependencies=kept");
    const evidence = (output) => output.match(/evidence=(\S+)/)[1];
    expect(evidence(second.stdout)).not.toBe(evidence(first.stdout));
  });

  it("stops before building when the build account has no node tools", () => {
    const { repo, main } = source();
    const child = runEntry(`deploy ${main} - 0`, repo, path.join(temporary(), "none"));
    expect(child.status).toBe(70);
    expect(child.stderr).toContain("TOOLS_MISSING");
  });

  it("[I-120] refuses while the deploy holding the lock is still in a connected session", () => {
    const { repo, main } = source();
    const base = temporary();
    const { pid } = holdLock(base, { detached: false });
    const child = runEntry(`deploy ${main} - 1`, repo, fakeTools(), base, {
      HIMAWARI_DEPLOY_SESSION_COMMAND: "node",
    });
    expect(child.status).toBe(75);
    expect(child.stderr).toContain(`ALREADY_RUNNING`);
    expect(child.stderr).toContain(`pid ${pid} is still in a connected session`);
    expect(alive(pid)).toBe(true);
  });

  it("[I-120] stops what a cut-off deploy left holding the lock and goes on", () => {
    const { repo, main } = source();
    const base = temporary();
    const { pid } = holdLock(base, { detached: true });
    const child = runEntry(`deploy ${main} - 1`, repo, fakeTools(), base, {
      HIMAWARI_DEPLOY_SESSION_COMMAND: "node",
    });
    expect(child.stdout).toContain(`DEPLOY_ENTRY_ORPHAN_CLEARED pids=${pid}`);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(`STUB commit=${main}`);
    expect(alive(pid)).toBe(false);
  });

  it("checks out a main commit and runs its own ci-deploy.sh against the local machine", () => {
    const { repo, main } = source();
    const child = runEntry(`deploy ${main} - 1`, repo);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(`STUB commit=${main} since= force=1 host=127.0.0.1`);
    expect(child.stdout).toContain(shim);
  });
});

describe("local ssh and scp shims", () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };

  it("runs the remote command locally and passes standard input through", () => {
    const child = spawnSync(
      path.join(shim, "ssh"),
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "root@127.0.0.1", "cat && echo done"],
      { input: "hello\n", encoding: "utf8", env },
    );
    expect(child.stdout).toBe("hello\ndone\n");
  });

  it("copies a file to the destination path", () => {
    const directory = temporary();
    const from = path.join(directory, "from.txt");
    const to = path.join(directory, "to file.txt");
    writeFileSync(from, "payload");
    const child = spawnSync(
      path.join(shim, "scp"),
      ["-q", "-o", "BatchMode=yes", from, `root@127.0.0.1:${to}`],
      { encoding: "utf8", env },
    );
    expect(child.status).toBe(0);
    expect(readFileSync(to, "utf8")).toBe("payload");
    chmodSync(from, 0o600);
  });

  it("refuses an account name that is not a plain login", () => {
    const child = spawnSync(path.join(shim, "ssh"), ["a;b@127.0.0.1", "id"], {
      encoding: "utf8",
      env,
    });
    expect(child.status).toBe(255);
  });
});
