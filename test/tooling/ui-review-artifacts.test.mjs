import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repositoryRoot, "scripts/ui-review-artifacts.mjs");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function clone(remote, name, root) {
  const path = join(root, name);
  git(root, "clone", "-q", remote, path);
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "user.name", "test");
  return path;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ui-review-artifacts-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const mac = clone(remote, "mac", root);
  writeFileSync(join(mac, "README.md"), "hi\n");
  git(mac, "add", "-A");
  git(mac, "commit", "-q", "-m", "base");
  git(mac, "push", "-q", "origin", "main");
  const shots = join(root, "shots");
  mkdirSync(shots);
  writeFileSync(join(shots, "01-today-light.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  writeFileSync(join(shots, "motion-shimmer-dark.mp4"), "mp4");
  return { root, remote, mac, shots };
}

function run(cwd, ...args) {
  const child = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

describe("ui-review artifacts (ADR 0276)", () => {
  it("hands a batch from the Mac clone to a cloud clone without putting it on any branch", () => {
    const { root, remote, mac, shots } = setup();
    const published = run(mac, "publish", "--pr", "564", "--batch", "b1", "--dir", shots);
    expect(published.status, published.output).toBe(0);
    expect(published.output).toContain("UI_REVIEW_ARTIFACT_PUBLISH_DONE");
    expect(git(mac, "status", "--porcelain")).toBe("");
    expect(git(mac, "for-each-ref", "refs/heads", "refs/remotes")).not.toContain(
      "review-artifacts",
    );

    const cloud = clone(remote, "cloud", root);
    expect(git(cloud, "for-each-ref")).not.toContain("review-artifacts");
    expect(git(cloud, "log", "--all", "--format=%s")).not.toContain("ui-review artifacts");
    expect(run(cloud, "list", "--pr", "564").output.trim()).toBe("refs/review-artifacts/pr-564/b1");

    const out = join(root, "received");
    const fetched = run(cloud, "fetch", "--pr", "564", "--batch", "b1", "--out", out);
    expect(fetched.status, fetched.output).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["01-today-light.png", "motion-shimmer-dark.mp4"]);
    expect(readFileSync(join(out, "01-today-light.png"))).toEqual(
      readFileSync(join(shots, "01-today-light.png")),
    );
    expect(git(cloud, "for-each-ref")).not.toContain("ui-review-fetch");

    expect(run(mac, "delete", "--pr", "564", "--batch", "b1").status).toBe(0);
    expect(run(cloud, "list", "--pr", "564").output.trim()).toBe("");
  });

  it("refuses files other than png and mp4, and bad pr or batch names", () => {
    const { root, mac, shots } = setup();
    writeFileSync(join(shots, "notes.txt"), "x");
    expect(run(mac, "publish", "--pr", "1", "--batch", "b1", "--dir", shots).output).toContain(
      "UI_REVIEW_ARTIFACT_FILE_REJECTED notes.txt",
    );
    rmSync(join(shots, "notes.txt"));
    writeFileSync(join(root, "secret"), "not a screenshot");
    symlinkSync(join(root, "secret"), join(shots, "secret.png"));
    expect(run(mac, "publish", "--pr", "1", "--batch", "b1", "--dir", shots).output).toContain(
      "UI_REVIEW_ARTIFACT_SYMLINK_REJECTED secret.png",
    );
    rmSync(join(shots, "secret.png"));
    expect(run(mac, "publish", "--pr", "1", "--batch", "../main", "--dir", shots).output).toContain(
      "UI_REVIEW_ARTIFACT_BATCH_INVALID",
    );
    expect(run(mac, "publish", "--pr", "0", "--batch", "b1", "--dir", shots).output).toContain(
      "UI_REVIEW_ARTIFACT_PR_INVALID",
    );
  });

  it("refuses a batch whose file no longer matches its manifest", () => {
    const { root, remote, mac } = setup();
    const scratch = join(root, "forge");
    git(root, "clone", "-q", remote, scratch);
    git(scratch, "config", "user.email", "test@example.invalid");
    git(scratch, "config", "user.name", "test");
    git(scratch, "checkout", "-q", "--orphan", "forge");
    git(scratch, "rm", "-q", "-rf", ".");
    writeFileSync(join(scratch, "a.png"), "good");
    writeFileSync(join(scratch, "b.png"), "changed");
    writeFileSync(
      join(scratch, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        pr: 7,
        batch: "b1",
        files: [
          {
            path: "a.png",
            bytes: 4,
            sha256: createHash("sha256").update("good").digest("hex"),
          },
          { path: "b.png", bytes: 3, sha256: "0".repeat(64) },
        ],
      }),
    );
    git(scratch, "add", "-A");
    git(scratch, "commit", "-q", "-m", "forged");
    git(scratch, "push", "-q", "origin", "HEAD:refs/review-artifacts/pr-7/b1");
    const out = join(root, "received");
    const result = run(mac, "fetch", "--pr", "7", "--batch", "b1", "--out", out);
    expect(result.status).toBe(1);
    expect(result.output).toContain("UI_REVIEW_MANIFEST_MISMATCH b.png");
    expect(readdirSync(out)).toEqual([]);
    expect(git(mac, "for-each-ref")).not.toContain("ui-review-fetch");
  });
});
