import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const source = path.resolve(import.meta.dirname, "../../scripts/delivery-mode");
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
  cpSync(path.join(source, "ci-deploy.sh"), path.join(repo, "scripts/delivery-mode/ci-deploy.sh"));
  cpSync(
    path.join(source, "instances/andy-production.json"),
    path.join(repo, "scripts/delivery-mode/instances/andy-production.json"),
  );
  const first = commitFile(repo, "src/app.ts", "one");
  const fakeSsh = `${repo}-fake-ssh.sh`;
  writeFileSync(
    fakeSsh,
    `#!/bin/bash\necho /opt/himawari/releases/2026-11-25-${first.slice(0, 8)}\n`,
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
