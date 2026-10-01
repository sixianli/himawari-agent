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
  integration: "test/integration/example.test.ts",
  e2e: "test/e2e/example.test.ts",
  "pi-compat": "packages/runtime-pi/example.compat.test.ts",
};
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
  it.each([undefined, "30000", "00030"])(
    "passes the original value %j to test children",
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
      for (const file of Object.values(files)) put(root, file, "export {};\n");
      put(
        root,
        "node_modules/vitest/vitest.mjs",
        `
      import { writeFileSync } from 'node:fs';
      import path from 'node:path';
      const id = process.argv[process.argv.indexOf('--project') + 1];
      const files = ${JSON.stringify(files)};
      writeFileSync(path.resolve(id + '-environment.json'), JSON.stringify({
        timeout: process.env.HIMAWARI_TEST_TIMEOUT_MS ?? null,
        unrelated: process.env.HIMAWARI_TEST_UNRELATED_ENV ?? null,
      }));
      const report = { success: true, testResults: [{
        name: path.resolve(files[id]), assertionResults: [{ status: 'passed' }],
      }] };
      const output = process.argv.find(arg => arg.startsWith('--outputFile.json=')).split('=')[1];
      writeFileSync(output, JSON.stringify(report));
      const junit = process.argv.find(arg => arg.startsWith('--outputFile.junit=')).split('=')[1];
      writeFileSync(junit, '<testsuites/>');
    `,
      );
      const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("add", ".");
      git("commit", "-qm", "fixture");
      const result = await runCheck({
        root,
        context: createContext({ root }),
        checkId: "test",
        matrixKey: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
        output: ".ci-output/test",
        toolsDirectory: root,
        artifact: path.join(root, "runtime.tar.gz"),
        hosted: false,
      });
      expect(result.status).toBe("passed");
      expect(result.projects.map(({ id }) => id)).toEqual(Object.keys(files));
      for (const id of Object.keys(files)) {
        expect(JSON.parse(readFileSync(path.join(root, `${id}-environment.json`), "utf8"))).toEqual(
          {
            timeout: value ?? null,
            unrelated: null,
          },
        );
      }
    },
  );
});
