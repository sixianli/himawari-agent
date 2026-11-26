import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(
  import.meta.dirname,
  "../../scripts/delivery-mode/hermes/install-dependencies-if-changed.sh",
);
const directories = [];

function checkout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "install-if-changed-"));
  directories.push(root);
  const source = path.join(root, "source");
  mkdirSync(path.join(source, "scripts/ci"), { recursive: true });
  writeFileSync(path.join(source, "package-lock.json"), "{}");
  writeFileSync(
    path.join(source, "scripts/ci/install-dependencies.mjs"),
    'import { mkdirSync } from "node:fs";\nconst evidence = process.argv[process.argv.indexOf("--evidence") + 1];\nmkdirSync(evidence);\n',
  );
  return { root, source };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("install-dependencies-if-changed.sh", () => {
  it("installs again for the same commit when an earlier attempt left its evidence behind", () => {
    const { root, source } = checkout();
    const evidence = path.join(root, "evidence/dependencies-abc");
    mkdirSync(path.dirname(evidence));
    const run = () =>
      spawnSync("bash", [script, source, root, evidence], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    const first = run();
    expect(first.status).toBe(0);
    rmSync(path.join(source, ".ci-output"), { recursive: true, force: true });
    const second = run();
    expect(second.stderr).toBe("");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("dependencies=reinstalled");
  });
});
