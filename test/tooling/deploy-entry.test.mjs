import { spawnSync } from "node:child_process";
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
  mkdirSync(path.join(repo, "scripts/delivery-mode/hermes"), { recursive: true });
  writeFileSync(
    path.join(repo, "scripts/delivery-mode/hermes/install-dependencies-if-changed.sh"),
    '#!/bin/bash\necho "dependencies=stub"\n',
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

function runEntry(request, repo, tools = fakeTools()) {
  return spawnSync("bash", [entry], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SSH_ORIGINAL_COMMAND: request,
      HIMAWARI_DEPLOY_BASE: temporary(),
      HIMAWARI_DEPLOY_REPO_URL: repo,
      HIMAWARI_DEPLOY_TOOLS: tools,
    },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
    ]) {
      const child = runEntry(request, repo);
      expect(child.status).toBe(64);
      expect(child.stderr).toContain("REQUEST_INVALID");
    }
  });

  it("refuses a commit that exists in the repository but is not on main", () => {
    const { repo, side } = source();
    const child = runEntry(`deploy ${side} - 0`, repo);
    expect(child.status).toBe(65);
    expect(child.stderr).toContain("COMMIT_NOT_ON_MAIN");
  });

  it("stops before building when the build account has no node tools", () => {
    const { repo, main } = source();
    const child = runEntry(`deploy ${main} - 0`, repo, path.join(temporary(), "none"));
    expect(child.status).toBe(70);
    expect(child.stderr).toContain("TOOLS_MISSING");
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
