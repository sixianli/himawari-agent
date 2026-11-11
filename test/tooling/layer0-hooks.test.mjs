import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLayer0Hooks, HOOKS_PATH } from "../../scripts/check-layer0-hooks.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
const git = (cwd, ...args) =>
  execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
const tryGit = (cwd, ...args) =>
  spawnSync("git", [...identity, ...args], { cwd, encoding: "utf8" });

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "layer0-hooks-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  cpSync(path.join(repositoryRoot, "scripts/git-hooks"), path.join(root, "scripts/git-hooks"), {
    recursive: true,
  });
  cpSync(
    path.join(repositoryRoot, "scripts/layer0-tests"),
    path.join(root, "scripts/layer0-tests"),
    { recursive: true },
  );
  cpSync(
    path.join(repositoryRoot, "scripts/delivery-mode"),
    path.join(root, "scripts/delivery-mode"),
    { recursive: true },
  );
  write(
    root,
    "scripts/check-boundaries.mjs",
    "console.error('BOUNDARY_STUB_RAN');\nprocess.exit(0);\n",
  );
  write(root, "scripts/check-format.mjs", "console.error('FORMAT_STUB_RAN');\nprocess.exit(0);\n");
  write(
    root,
    "scripts/scan-machine-secrets.mjs",
    "console.error('SECRETS_STUB_RAN');\nprocess.exit(0);\n",
  );
  write(root, "DELIVERY_MODE", "fast\n");
  write(
    root,
    "ci/policy.json",
    JSON.stringify({ testProjects: [{ id: "unit", include: ["packages/*/test/**/*.test.ts"] }] }),
  );
  write(root, "packages/a/package.json", JSON.stringify({ name: "@fixture/a" }));
  write(root, "packages/a/src/value.ts", "export const value = 1;\n");
  write(
    root,
    "packages/a/test/value.unit.test.ts",
    'import { value } from "../src/value.js";\nvoid value;\n',
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "base");
  expect(ensureLayer0Hooks({ cwd: root })).toEqual({ status: "set", hooksPath: HOOKS_PATH });
  write(root, "packages/a/src/value.ts", "export const value = 2;\n");
  git(root, "add", "-A");
  return root;
}

function publishBase(root) {
  const remote = mkdtempSync(path.join(tmpdir(), "layer0-remote-"));
  roots.push(remote);
  git(remote, "init", "-q", "--bare");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "--no-verify", "origin", "HEAD~1:refs/heads/main");
}

const head = (root) => git(root, "rev-parse", "HEAD").trim();

describe("Layer 0 hooks from the repository", () => {
  it("refuses a product change without the related test even in fast mode", () => {
    const root = fixture();
    const before = head(root);
    const refused = tryGit(root, "commit", "-q", "-m", "change value");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("L0_RELATED_TESTS_UNDECLARED");
    expect(refused.stderr).toContain("packages/a/test/value.unit.test.ts");
    expect(head(root)).toBe(before);
    const omitted = tryGit(root, "commit", "-q", "-m", "change value\n\nLayer-0-tests: none");
    expect(omitted.stderr).toContain("L0_RELATED_TESTS_OMITTED");
    expect(head(root)).toBe(before);
  });

  it("accepts the commit once the related test is declared", () => {
    const root = fixture();
    const accepted = tryGit(
      root,
      "commit",
      "-q",
      "-m",
      "change value\n\nLayer-0-tests: packages/a/test/value.unit.test.ts",
    );
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toContain("L0_RELATED_TESTS_OK");
  });

  it("refuses at push a commit that skipped the commit-msg hook", () => {
    const root = fixture();
    git(root, "commit", "-q", "--no-verify", "-m", "change value");
    const remote = mkdtempSync(path.join(tmpdir(), "layer0-remote-"));
    roots.push(remote);
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    const pushed = tryGit(root, "push", "-q", "origin", "main");
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("L0_RELATED_TESTS_UNDECLARED");
  });

  const commitChange = (root) =>
    git(
      root,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "change value\n\nLayer-0-tests: packages/a/test/value.unit.test.ts",
    );

  it("refuses at push when the workspace boundary check fails", () => {
    const root = fixture();
    write(
      root,
      "scripts/check-boundaries.mjs",
      "console.error('escapes workspace');\nprocess.exit(1);\n",
    );
    git(root, "add", "-A");
    commitChange(root);
    publishBase(root);
    const pushed = tryGit(root, "push", "-q", "origin", "main");
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("PUSH_BOUNDARY_CHECK_FAILED");
  });

  it("pushes when the workspace boundary check passes, and runs it", () => {
    const root = fixture();
    commitChange(root);
    publishBase(root);
    const pushed = tryGit(root, "push", "-q", "origin", "main");
    expect(pushed.status).toBe(0);
    expect(pushed.stderr).toContain("BOUNDARY_STUB_RAN");
    expect(pushed.stderr).toContain("FORMAT_STUB_RAN");
    expect(pushed.stderr).toContain("SECRETS_STUB_RAN");
  });

  for (const [script, code] of [
    ["scripts/check-format.mjs", "PUSH_FORMAT_CHECK_FAILED"],
    ["scripts/scan-machine-secrets.mjs", "PUSH_SECRET_SCAN_FAILED"],
  ]) {
    it(`refuses at push when ${script} fails or is missing`, () => {
      const failing = fixture();
      write(failing, script, "console.error('found a problem');\nprocess.exit(1);\n");
      git(failing, "add", "-A");
      commitChange(failing);
      publishBase(failing);
      const refused = tryGit(failing, "push", "-q", "origin", "main");
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(code);
      const missing = fixture();
      git(missing, "rm", "-q", "-f", script);
      commitChange(missing);
      publishBase(missing);
      const absent = tryGit(missing, "push", "-q", "origin", "main");
      expect(absent.status).not.toBe(0);
      expect(absent.stderr).toContain(code);
    });
  }

  it("refuses at push when the boundary check script is missing", () => {
    const root = fixture();
    git(root, "rm", "-q", "-f", "scripts/check-boundaries.mjs");
    commitChange(root);
    publishBase(root);
    const pushed = tryGit(root, "push", "-q", "origin", "main");
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("PUSH_BOUNDARY_CHECK_FAILED");
  });

  it("keeps an existing hooks path instead of overwriting it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "layer0-conflict-"));
    roots.push(root);
    git(root, "init", "-q");
    git(root, "config", "core.hooksPath", "elsewhere");
    expect(ensureLayer0Hooks({ cwd: root })).toEqual({
      status: "conflict",
      hooksPath: "elsewhere",
    });
  });
});
