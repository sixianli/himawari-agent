import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";
import { relativeModuleClosure } from "../../scripts/ci/source-inputs.mjs";
import { sourceTreeDigest } from "../../scripts/ci/verify-artifact.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-build-inputs-"));
  directories.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
describe("transitive build inputs", () => {
  it("binds helper contents, file modes and policy data while excluding unrelated executors", async () => {
    const root = await fixture({
      "scripts/ci/build.mjs": "import './execute.mjs';",
      "scripts/ci/execute.mjs": "export const value=1;",
      "scripts/ci/artifact-archive.py": "# fixture",
      "scripts/package-node-runtime.mjs": "export {};",
      "scripts/generate-artifact-manifest.mjs": "export {};",
      "scripts/check-control-center-build.mjs": "export {};",
      "ci/policy.schema.json": "{}",
      "scripts/ci/unrelated.mjs": "export {};",
    });
    execFileSync("git", ["init", "--quiet", root]);
    const before = await sourceTreeDigest(root);
    await writeFile(path.join(root, "scripts/ci/unrelated.mjs"), "export const ignored = 1;");
    expect(await sourceTreeDigest(root)).toBe(before);
    await writeFile(path.join(root, "scripts/ci/execute.mjs"), "export const value=2;");
    const helperChanged = await sourceTreeDigest(root);
    expect(helperChanged).not.toBe(before);
    await chmod(path.join(root, "scripts/ci/execute.mjs"), 0o755);
    const modeChanged = await sourceTreeDigest(root);
    expect(modeChanged).not.toBe(helperChanged);
    await writeFile(path.join(root, "ci/policy.schema.json"), '{"changed":true}');
    expect(await sourceTreeDigest(root)).not.toBe(modeChanged);
  });
  it("tracks current worktree deletions and restoration without hiding missing imports", async () => {
    const root = await fixture({
      "scripts/ci/build.mjs": "import './execute.mjs';",
      "scripts/ci/execute.mjs": "export const value=1;",
      "scripts/ci/artifact-archive.py": "# fixture",
      "scripts/package-node-runtime.mjs": "export {};",
      "scripts/generate-artifact-manifest.mjs": "export {};",
      "scripts/check-control-center-build.mjs": "export {};",
      "ci/policy.schema.json": "{}",
      "apps/agent-service/src/removed-before-build.mjs": "export const value=1;",
    });
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["add", "--all"], { cwd: root });
    const before = await sourceTreeDigest(root);

    const trackedPath = path.join(root, "apps/agent-service/src/removed-before-build.mjs");
    await rm(trackedPath);
    const deleted = await sourceTreeDigest(root);
    expect(deleted).not.toBe(before);
    execFileSync("git", ["add", "--all"], { cwd: root });
    expect(await sourceTreeDigest(root)).toBe(deleted);

    await writeFile(trackedPath, "export const value=1;");
    expect(await sourceTreeDigest(root)).toBe(before);
    execFileSync("git", ["add", "--all"], { cwd: root });
    expect(await sourceTreeDigest(root)).toBe(before);

    const addedPath = path.join(root, "apps/agent-service/src/added-after-build.mjs");
    await writeFile(addedPath, "export {};\n");
    const added = await sourceTreeDigest(root);
    expect(added).not.toBe(before);
    execFileSync("git", ["add", "--all"], { cwd: root });
    expect(await sourceTreeDigest(root)).toBe(added);
    await rm(addedPath);
    expect(await sourceTreeDigest(root)).toBe(before);
    execFileSync("git", ["add", "--all"], { cwd: root });
    expect(await sourceTreeDigest(root)).toBe(before);

    await rm(path.join(root, "scripts/ci/execute.mjs"));
    await expect(sourceTreeDigest(root)).rejects.toThrow(/ENOENT/u);
  });
  it("follows static, reexport, JSON and dynamic relative imports through cycles", async () => {
    const root = await fixture({
      "build.mjs":
        "import './lib/helper.mjs'; import node from 'node:fs'; const example = `import './not-real.mjs'`;",
      "lib/helper.mjs": "export * from '../leaf.mjs'; import '../data.json' with {type:'json'};",
      "leaf.mjs": "import('./build.mjs'); import(`./dynamic.mjs`);",
      "dynamic.mjs": "export const value=1;",
      "data.json": "{}",
      "unrelated.mjs": "not a build input",
    });
    expect(await relativeModuleClosure(root, ["build.mjs"])).toEqual([
      "build.mjs",
      "data.json",
      "dynamic.mjs",
      "leaf.mjs",
      "lib/helper.mjs",
    ]);
  });
  it("includes actual execute, redaction, context, contracts and policy code, excluding unrelated gate execution", async () => {
    const files = await relativeModuleClosure(repositoryRoot, ["scripts/ci/build.mjs"]);
    for (const name of [
      "execute",
      "security-redaction",
      "context",
      "contracts",
      "check-policy",
      "artifact-files",
      "verify-artifact",
    ])
      expect(files).toContain(`scripts/ci/${name}.mjs`);
    for (const name of ["run", "coverage", "test", "browser", "security"])
      expect(files).not.toContain(`scripts/ci/${name}.mjs`);
  });
  it("fails on missing imported modules", async () => {
    const root = await fixture({ "build.mjs": "import './missing.mjs';" });
    await expect(relativeModuleClosure(root, ["build.mjs"])).rejects.toThrow(/ENOENT/u);
  });
  it("rejects lexical escape and symlink imports outside the checkout", async () => {
    const root = await fixture({ "build.mjs": "import '../outside.mjs';" });
    await expect(relativeModuleClosure(root, ["build.mjs"])).rejects.toThrow(
      "BUILD_IMPORT_ESCAPES_ROOT",
    );
    const outside = await fixture({ "outside.mjs": "export {};" });
    await writeFile(path.join(root, "build.mjs"), "import './linked.mjs';");
    await symlink(path.join(outside, "outside.mjs"), path.join(root, "linked.mjs"));
    await expect(relativeModuleClosure(root, ["build.mjs"])).rejects.toThrow(
      "BUILD_IMPORT_ESCAPES_ROOT",
    );
  });
});
