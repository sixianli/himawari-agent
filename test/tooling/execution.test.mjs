import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";
import { parseVitestReport } from "../../scripts/ci/test.mjs";
import { installNodeRuntime } from "../../scripts/install-node-runtime.mjs";

const report = () => ({
  success: true,
  testResults: [
    { name: "case.test.ts", assertionResults: [{ status: "passed" }, { status: "passed" }] },
  ],
});
describe("explicit main-project execution", () => {
  it("installed launchers do not load undeclared source dependencies through NODE_PATH", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "himawari-source-isolation-"));
    try {
      const source = path.join(temporary, "source/runtime");
      await mkdir(source, { recursive: true });
      const entrypoints = {
        himawari: "main.js",
        agentService: "main.js",
        executionWorker: "main.js",
      };
      await writeFile(path.join(source, "runtime-manifest.json"), JSON.stringify({ entrypoints }));
      await writeFile(path.join(source, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        path.join(source, "main.js"),
        "import {createRequire} from 'node:module'; createRequire(import.meta.url)('source-only-fixture');",
      );
      const developmentModules = path.join(temporary, "source/node_modules/source-only-fixture");
      await mkdir(developmentModules, { recursive: true });
      await writeFile(path.join(developmentModules, "index.js"), "module.exports = true;");
      const prefix = path.join(temporary, "isolated/prefix");
      await installNodeRuntime({ prefix, source });
      const result = spawnSync(path.join(prefix, "bin/himawari"), [], {
        cwd: prefix,
        env: { ...process.env, NODE_PATH: path.join(temporary, "source/node_modules") },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MODULE_NOT_FOUND");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("derives counts from actual assertion records", () => {
    expect(parseVitestReport(report())).toEqual({
      files: 1,
      executed: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
  });
  it.each([
    [
      "empty project",
      (value) => {
        value.testResults = [];
      },
    ],
    [
      "empty file",
      (value) => {
        value.testResults[0].assertionResults = [];
      },
    ],
    [
      "skipped success",
      (value) => {
        value.testResults[0].assertionResults[0].status = "pending";
      },
    ],
    [
      "failed success",
      (value) => {
        value.testResults[0].assertionResults[0].status = "failed";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = report();
    mutate(value);
    expect(() => parseVitestReport(value)).toThrow();
  });
  it("preserves failed assertion counts", () => {
    const value = report();
    value.success = false;
    value.testResults[0].assertionResults[0].status = "failed";
    expect(parseVitestReport(value).failed).toBe(1);
  });
  it("installation tests consume an explicit artifact without building", () => {
    const source = readFileSync(
      path.join(repositoryRoot, "test/integration/installable-node-services.test.ts"),
      "utf8",
    );
    expect(source).not.toContain('"build:node"');
    expect(source).toContain("HIMAWARI_TEST_ARTIFACT");
    expect(source).toContain("--artifact");
  });
});
