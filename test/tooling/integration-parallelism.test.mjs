import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validatePolicy, validateVitestProjects } from "../../scripts/ci/check-policy.mjs";
import configuration from "../../vitest.workspace.ts";

const policy = JSON.parse(readFileSync(new URL("../../ci/policy.json", import.meta.url)));
const workerLimits = { maximum: 4, cpusPerWorker: 2, memoryMiBPerWorker: 2048 };
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const candidate = () => {
  const value = structuredClone(policy);
  Object.assign(
    value.testProjects.find((project) => project.id === "integration"),
    {
      fileParallelism: true,
      workerLimits,
    },
  );
  return value;
};

describe("bounded integration scheduling", () => {
  it("runs mixed projects through the real Vitest scheduler with different worker budgets", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hma-test-scheduling-"));
    directories.push(directory);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const projects = ["unit", "integration"].map((name) => {
      const filename = path.join(directory, `${name}.test.mjs`);
      writeFileSync(filename, `it("executes ${name}", () => expect(2 + 2).toBe(4));\n`);
      const original = configuration.test.projects.find((project) => project.test.name === name);
      return {
        test: {
          ...original.test,
          globals: true,
          include: [filename],
          exclude: [],
          ...(name === "integration" ? { maxWorkers: 2 } : {}),
        },
      };
    });
    const config = path.join(directory, "vitest.config.mjs");
    const report = path.join(directory, "tests.json");
    writeFileSync(config, `export default ${JSON.stringify({ root, test: { projects } })};\n`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        config,
        "--project",
        "unit",
        "--project",
        "integration",
        "--maxWorkers",
        "1",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const actual = JSON.parse(readFileSync(report, "utf8"));
    expect(actual.testResults).toHaveLength(2);
    expect(
      actual.testResults.flatMap((file) => file.assertionResults.map((test) => test.status)),
    ).toEqual(["passed", "passed"]);
  });

  it("rejects integration scheduling in the group used by other worker budgets", () => {
    const changed = structuredClone(configuration);
    changed.test.projects.find((project) => project.test.name === "integration").test.sequence = {
      groupOrder: 0,
    };
    expect(() => validateVitestProjects(policy, changed)).toThrow(/group/i);
  });

  it("rejects other projects entering the integration scheduling group", () => {
    const changed = structuredClone(configuration);
    changed.test.projects.find((project) => project.test.name === "unit").test.sequence = {
      groupOrder: 1,
    };
    expect(() => validateVitestProjects(policy, changed)).toThrow(/group/i);
  });

  it("accepts parallel files only with a finite resource budget", () => {
    expect(validatePolicy(candidate())).toBeTruthy();
  });

  it.each([
    ["missing limits", undefined],
    ["zero workers", { ...workerLimits, maximum: 0 }],
    ["fractional workers", { ...workerLimits, maximum: 1.5 }],
    ["zero CPU budget", { ...workerLimits, cpusPerWorker: 0 }],
    ["zero memory budget", { ...workerLimits, memoryMiBPerWorker: 0 }],
    ["unknown limit", { ...workerLimits, ignored: 1 }],
  ])("rejects %s", (_name, limits) => {
    const value = candidate();
    const integration = value.testProjects.find((project) => project.id === "integration");
    if (limits) integration.workerLimits = limits;
    else delete integration.workerLimits;
    expect(() => validatePolicy(value)).toThrow();
  });

  it.each([
    [1, 8, 1],
    [2, 8, 1],
    [4, 16, 2],
    [8, 8, 4],
    [32, 64, 4],
    [8, 4, 2],
    [8, 1, 1],
  ])("uses %i CPUs and %i GiB to select %i workers", async (availableCpus, gib, expected) => {
    const { testWorkerCount } = await import("../../scripts/ci/test-concurrency.mjs");
    expect(
      testWorkerCount(
        { fileParallelism: true, workerLimits },
        {
          availableCpus,
          memoryBytes: gib * 1024 ** 3,
        },
      ),
    ).toBe(expected);
  });

  it("keeps serial projects and projects without a budget at one worker", async () => {
    const { testWorkerCount } = await import("../../scripts/ci/test-concurrency.mjs");
    expect(testWorkerCount({ fileParallelism: false, workerLimits })).toBe(1);
    expect(testWorkerCount({ fileParallelism: true })).toBe(1);
  });

  it("rejects a runtime worker count that differs from policy", () => {
    const changed = structuredClone(configuration);
    changed.test.projects.find((project) => project.test.name === "integration").test.maxWorkers =
      99;
    expect(() => validateVitestProjects(policy, changed)).toThrow(/worker/i);
  });

  it("rejects shared module state between parallel integration files", () => {
    const changed = structuredClone(configuration);
    changed.test.projects.find((project) => project.test.name === "integration").test.isolate =
      false;
    expect(() => validateVitestProjects(policy, changed)).toThrow(/isolat/i);
  });
});
