import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../scripts/check-repo-hygiene.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repositoryRoot, "scripts/check-repo-hygiene.mjs");
const realConfig = readFileSync(join(repositoryRoot, "scripts/repo-hygiene/config.json"), "utf8");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function repository({
  config = realConfig,
  gitignore = ".claude/worktrees/\n.agents/local/\n.cb-delegate/\n",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "repo-hygiene-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  put(root, "scripts/repo-hygiene/config.json", config);
  put(root, ".gitignore", gitignore);
  put(root, "README.md", "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "branch", "base");
  git(root, "checkout", "-q", "-b", "work");
  return root;
}

function commit(root, files) {
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  git(root, "add", "-A", "-f");
  git(root, "commit", "-q", "-m", "change");
}

function run(root, env = {}) {
  const child = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HIMAWARI_REPO_HYGIENE_BASE: "base", ...env },
  });
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

function bytes(count) {
  return Buffer.alloc(count, 1);
}

const oneKbConfig = JSON.stringify({
  ...JSON.parse(realConfig),
  maxFileBytes: 1000,
  maxChangeBytes: 2500,
});

describe("repo hygiene check (ADR 0276)", () => {
  it("passes an ordinary change", () => {
    const root = repository({ config: oneKbConfig });
    commit(root, { "src/a.ts": "export const a = 1;\n" });
    const result = run(root);
    expect(result.output).toContain("REPO_HYGIENE_PASSED");
    expect(result.status).toBe(0);
  });

  it("fails a new file over the size limit and passes once it is removed", () => {
    const root = repository({ config: oneKbConfig });
    commit(root, { "assets/big.bin": bytes(1001), "assets/ok.bin": bytes(1000) });
    const failed = run(root);
    expect(failed.status).toBe(1);
    expect(failed.output).toContain(
      "REPO_HYGIENE_FILE_TOO_LARGE assets/big.bin bytes=1001 limit=1000",
    );
    expect(failed.output).not.toContain("assets/ok.bin");
    git(root, "rm", "-q", "assets/big.bin");
    git(root, "commit", "-q", "-m", "remove");
    expect(run(root).status).toBe(0);
  });

  it("fails when many small files add up past the change limit", () => {
    const root = repository({ config: oneKbConfig });
    commit(root, { "a.bin": bytes(900), "b.bin": bytes(900), "c.bin": bytes(900) });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("REPO_HYGIENE_CHANGE_TOO_LARGE bytes=2700 limit=2500");
  });

  it("lets registered large paths through and leaves them out of the change total", () => {
    const root = repository({ config: oneKbConfig });
    commit(root, {
      "clients/apple/Tests/Snapshots/iPhone-390/a-light.png": bytes(5000),
      "package-lock.json": bytes(3000),
    });
    expect(run(root).status).toBe(0);
  });

  it("does not count a pure rename of an existing large file", () => {
    const root = repository({ config: oneKbConfig });
    git(root, "checkout", "-q", "main");
    commit(root, { "old/big.bin": bytes(4000) });
    git(root, "branch", "-f", "base");
    git(root, "checkout", "-q", "work");
    git(root, "reset", "-q", "--hard", "main");
    mkdirSync(join(root, "new"));
    git(root, "mv", "old/big.bin", "new/big.bin");
    git(root, "commit", "-q", "-m", "rename");
    expect(run(root).status).toBe(0);
  });

  it("fails force-added screenshots and recordings even though .gitignore lists them", () => {
    const root = repository({
      gitignore:
        ".claude/worktrees/\n.agents/local/\n.cb-delegate/\nclients/apple/ui-review/latest/\n*.mp4\n",
    });
    commit(root, {
      "clients/apple/ui-review/latest/01-today-light.png": "png",
      "docs/demo.mp4": "mp4",
    });
    const failed = run(root);
    expect(failed.status).toBe(1);
    expect(failed.output).toContain(
      "REPO_HYGIENE_TRACKED_GENERATED clients/apple/ui-review/latest/01-today-light.png",
    );
    expect(failed.output).toContain("REPO_HYGIENE_TRACKED_GENERATED docs/demo.mp4 (.mp4)");
    git(root, "rm", "-q", "-r", "--cached", "clients/apple/ui-review/latest", "docs/demo.mp4");
    git(root, "commit", "-q", "-m", "untrack");
    expect(run(root).status).toBe(0);
  });

  it("fails when a worktree directory is not ignored", () => {
    const root = repository({ gitignore: ".agents/local/\n.cb-delegate/\n" });
    commit(root, { "src/a.ts": "1\n" });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("REPO_HYGIENE_LOCAL_DIR_NOT_IGNORED .claude/worktrees/");
  });

  it("fails when the base cannot be found instead of skipping the check", () => {
    const root = repository();
    const result = run(root, { HIMAWARI_REPO_HYGIENE_BASE: "no-such-ref" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("REPO_HYGIENE_BASE_MISSING no-such-ref");
  });

  it("rejects a config with a wildcard path, a missing reason or a zero limit", () => {
    const base = JSON.parse(realConfig);
    expect(() =>
      parseConfig(JSON.stringify({ ...base, allowedLarge: [{ path: "clients/**", reason: "x" }] })),
    ).toThrow("REPO_HYGIENE_CONFIG_INVALID allowedLarge");
    expect(() =>
      parseConfig(JSON.stringify({ ...base, allowedLarge: [{ path: "docs/", reason: " " }] })),
    ).toThrow("REPO_HYGIENE_CONFIG_INVALID allowedLarge");
    expect(() => parseConfig(JSON.stringify({ ...base, maxFileBytes: 0 }))).toThrow(
      "REPO_HYGIENE_CONFIG_INVALID maxFileBytes",
    );
    expect(() => parseConfig(realConfig)).not.toThrow();
  });
});
