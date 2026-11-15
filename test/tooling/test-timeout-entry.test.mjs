import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../scripts/ci/platforms.mjs", async (original) =>
  (await import("./artifact-host.mjs")).artifactCapablePlatforms(await original()),
);
vi.mock("../../scripts/ci/install-tools.mjs", async (original) => ({
  ...(await original()),
  verifyInstalledTools: async ({ directory }) => ({
    node: process.versions.node,
    executables: {
      node: process.execPath,
      npmCli: path.join(directory, "npm.mjs"),
    },
  }),
}));
vi.mock("../../scripts/ci/verify-artifact.mjs", async (original) => ({
  ...(await original()),
  verifyArtifact: async ({ archive }) => ({
    sha256: sha256(readFileSync(archive)),
    manifest: { platform: { os: process.platform } },
  }),
}));

import { createContext } from "../../scripts/ci/context.mjs";
import { repositoryRoot, sha256 } from "../../scripts/ci/contracts.mjs";
import { runCheck } from "../../scripts/ci/run.mjs";

const roots = [];
const files = {
  unit: "packages/example/example.unit.test.ts",
  contracts: "packages/example/example.contract.test.ts",
  tooling: "test/tooling/example.test.mjs",
  integration: "test/integration/example.test.ts",
  e2e: "test/e2e/example.test.ts",
  "pi-compat": "packages/runtime-pi/example.compat.test.ts",
};
const secondIntegrationFile = "test/integration/second.test.ts";
const put = (root, filename, content) => {
  const target = path.join(root, filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("test runner timeout environment", () => {
  it("keeps the real process architecture so native packages load their own binding", () => {
    const real = execFileSync(process.execPath, ["-p", "process.arch"], {
      encoding: "utf8",
    }).trim();
    expect(process.arch).toBe(real);
  });

  it.each([undefined, "30000", "00030", "", "0", "invalid"])(
    "[R2-E3] excludes retired timeout and unrelated variables from test children for %j",
    async (value) => {
      vi.stubEnv("HIMAWARI_TEST_TIMEOUT_MS", value);
      vi.stubEnv("HIMAWARI_TEST_UNRELATED_ENV", "must-not-leak");
      const root = mkdtempSync(path.join(os.tmpdir(), "timeout-entry-"));
      roots.push(root);
      for (const file of [
        "ci/policy.json",
        "ci/coverage-policy.json",
        "ci/toolchain-lock.json",
        "scripts/ci/test-concurrency.mjs",
        "vitest.workspace.ts",
        "node_modules/vitest/package.json",
      ]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
      }
      symlinkSync(
        path.join(repositoryRoot, "node_modules/vitest/dist"),
        path.join(root, "node_modules/vitest/dist"),
      );
      put(root, "package.json", '{"type":"module"}');
      put(root, "npm.mjs", "process.stdout.write('11.8.0')");
      put(root, "runtime.tar.gz", "immutable transport fixture");
      put(
        root,
        "scripts/ci/check-coverage.mjs",
        `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[process.argv.indexOf('--output') + 1], '{}');
    `,
      );
      for (const file of [...Object.values(files), secondIntegrationFile])
        put(root, file, "export {};\n");
      put(
        root,
        "node_modules/vitest/vitest.mjs",
        `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      const files = ${JSON.stringify(files)};
      const ids = process.argv.flatMap((arg, index) =>
        process.argv[index - 1] === '--project' ? [arg] : []);
      for (const id of ids)
        writeFileSync(path.resolve(id + '-environment.json'), JSON.stringify({
          timeout: process.env.HIMAWARI_TEST_TIMEOUT_MS ?? null,
          unrelated: process.env.HIMAWARI_TEST_UNRELATED_ENV ?? null,
        }));
      const named = process.argv.filter((arg) => arg.startsWith('test/') || arg.startsWith('packages/'));
      const report = { success: true, testResults: ids.flatMap((id) =>
        (named.length ? named : [files[id]]).map((file) => ({
          name: path.resolve(file), assertionResults: [{ status: 'passed' }],
        }))) };
      const option = (prefix) => process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
      writeFileSync(option('--outputFile.json=') ?? option('--outputFile='), JSON.stringify(report));
      const junit = option('--outputFile.junit=');
      if (junit) writeFileSync(junit, '<testsuites/>');
      if (process.argv.includes('--coverage')) {
        const directory = process.argv[process.argv.indexOf('--coverage.reportsDirectory') + 1];
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, 'coverage-final.json'), '{}');
        writeFileSync(path.join(directory, 'lcov.info'), 'TN:fixture');
      }
    `,
      );
      const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("add", ".");
      git("commit", "-qm", "fixture");
      const projects = [];
      for (const matrixKey of ["integration-1", "integration-2", "others"]) {
        const result = await runCheck({
          root,
          context: createContext({ root }),
          checkId: "tests",
          matrixKey,
          output: `.ci-output/tests-${matrixKey}`,
          toolsDirectory: root,
          artifact: path.join(root, "runtime.tar.gz"),
          hosted: false,
        });
        expect(
          result.status,
          readFileSync(path.join(root, `.ci-output/tests-${matrixKey}/details.json`), "utf8"),
        ).toBe("passed");
        projects.push(...result.projects.map(({ id }) => id));
      }
      const tested = Object.keys(files).filter((id) => id !== "tooling");
      expect([...new Set(projects)].sort()).toEqual([...tested].sort());
      for (const id of tested) {
        expect(JSON.parse(readFileSync(path.join(root, `${id}-environment.json`), "utf8"))).toEqual(
          {
            timeout: null,
            unrelated: null,
          },
        );
      }
    },
  );
});
