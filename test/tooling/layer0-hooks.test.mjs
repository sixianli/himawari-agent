import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  write(root, "scripts/check-lint.mjs", "console.error('LINT_STUB_RAN');\nprocess.exit(0);\n");
  write(
    root,
    "scripts/scan-machine-secrets.mjs",
    "console.error('SECRETS_STUB_RAN');\nprocess.exit(0);\n",
  );
  write(
    root,
    "scripts/check-repo-hygiene.mjs",
    "console.error('HYGIENE_STUB_RAN');\nprocess.exit(0);\n",
  );
  write(
    root,
    "scripts/check-conflict-markers.mjs",
    "console.error('MARKERS_STUB_RAN');\nprocess.exit(0);\n",
  );
  write(
    root,
    "scripts/check-incident-gates.mjs",
    "console.error('INCIDENT_STUB_RAN');\nprocess.exit(0);\n",
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
    expect(pushed.stderr).toContain("LINT_STUB_RAN");
    expect(pushed.stderr).toContain("SECRETS_STUB_RAN");
  });

  it("runs the same format, lint and secret checks at push as the npm scripts", () => {
    const scripts = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ).scripts;
    expect(scripts["format:check"]).toBe("node scripts/check-format.mjs");
    expect(scripts.lint).toBe("node scripts/check-lint.mjs");
    expect(scripts["check:secrets"]).toBe("node scripts/scan-machine-secrets.mjs");
    expect(scripts["check:conflict-markers"]).toContain("node scripts/check-conflict-markers.mjs");
  });

  const biomeRoot = (script, entry) => {
    const root = mkdtempSync(path.join(tmpdir(), "biome-check-"));
    roots.push(root);
    mkdirSync(path.join(root, "scripts"));
    cpSync(path.join(repositoryRoot, script), path.join(root, script));
    if (entry) write(root, "node_modules/@biomejs/biome/bin/biome", entry);
    return root;
  };
  const runBiomeCheck = (root, script) =>
    spawnSync(process.execPath, [path.join(root, script)], { encoding: "utf8" });

  for (const [script, args, unavailable] of [
    ["scripts/check-format.mjs", "format .", "FORMAT_CHECK_UNAVAILABLE"],
    [
      "scripts/check-lint.mjs",
      "lint --error-on-warnings --diagnostic-level=warn .",
      "LINT_CHECK_UNAVAILABLE",
    ],
  ]) {
    it(`${script} runs the installed biome on the whole repository and passes its exit code on`, () => {
      const passing = biomeRoot(
        script,
        "require('node:fs').writeFileSync('args.txt', process.argv.slice(2).join(' '));\n",
      );
      expect(runBiomeCheck(passing, script).status).toBe(0);
      expect(readFileSync(path.join(passing, "args.txt"), "utf8")).toBe(args);
      const failing = biomeRoot(script, "process.exit(3);\n");
      expect(runBiomeCheck(failing, script).status).toBe(3);
    });

    it(`${script} refuses when biome is not installed`, () => {
      const run = runBiomeCheck(biomeRoot(script, null), script);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(unavailable);
    });
  }

  it("formats hand-kept eval data but not the JSON the eval scripts write", () => {
    const root = mkdtempSync(path.join(tmpdir(), "format-evals-"));
    roots.push(root);
    cpSync(path.join(repositoryRoot, "biome.json"), path.join(root, "biome.json"));
    const loose = '{"a":[1,\n2]}\n';
    write(root, "evals/owner-rule/result.json", loose);
    write(root, "evals/memory-capture/partial-A-0.json", loose);
    write(root, "evals/memory-capture/2026-11-11T02-36-25-792Z.json", loose);
    const biome = path.join(repositoryRoot, "node_modules/@biomejs/biome/bin/biome");
    const generated = spawnSync(process.execPath, [biome, "format", "."], {
      cwd: root,
      encoding: "utf8",
    });
    expect(generated.status).toBe(0);
    write(root, "evals/memory-retrieval/dataset.json", loose);
    const kept = spawnSync(process.execPath, [biome, "format", "."], {
      cwd: root,
      encoding: "utf8",
    });
    expect(kept.status).not.toBe(0);
  });

  for (const [script, code] of [
    ["scripts/check-format.mjs", "PUSH_FORMAT_CHECK_FAILED"],
    ["scripts/check-lint.mjs", "PUSH_LINT_CHECK_FAILED"],
    ["scripts/scan-machine-secrets.mjs", "PUSH_SECRET_SCAN_FAILED"],
    ["scripts/check-conflict-markers.mjs", "PUSH_CONFLICT_MARKERS_FAILED"],
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
