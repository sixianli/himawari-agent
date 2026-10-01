import { defineConfig } from "vitest/config";
import coveragePolicy from "./ci/coverage-policy.json" with { type: "json" };
import policy from "./ci/policy.json" with { type: "json" };
import { testWorkerCount } from "./scripts/ci/test-concurrency.mjs";

const configuredTimeout = process.env["HIMAWARI_TEST_TIMEOUT_MS"];
const defaultTestTimeout = configuredTimeout === undefined ? undefined : Number(configuredTimeout);
if (
  configuredTimeout !== undefined &&
  (!/^\d+$/u.test(configuredTimeout) ||
    !Number.isSafeInteger(defaultTestTimeout) ||
    (defaultTestTimeout ?? 0) <= 0)
) {
  throw new Error("HIMAWARI_TEST_TIMEOUT_MS must be a positive safe integer");
}

// Tooling owns synthetic Git repositories; hosted cases supply their own GitHub identity.
const toolingEnvironment = {
  ...Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => name.startsWith("GITHUB_"))
      .map((name) => [name, ""]),
  ),
  GITHUB_ACTIONS: "false",
};

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    retry: 0,
    coverage: {
      provider: "v8",
      include: coveragePolicy.include,
      exclude: coveragePolicy.exclude,
      reporter: ["json", "lcov", "text-summary"],
      reportsDirectory: ".ci-output/coverage",
      reportOnFailure: true,
    },
    projects: [
      ...policy.testProjects.map((project) => ({
        test: {
          name: project.id,
          environment: "node",
          include: project.include,
          exclude: project.exclude,
          fileParallelism: project.fileParallelism,
          retry: 0,
          // Durable integration cases start workers and use real filesystem/UDS I/O.
          // Their harness deadline is separate from asserted product deadlines.
          ...(project.id === "integration"
            ? {
                testTimeout: 30_000,
                maxWorkers: testWorkerCount(project),
                isolate: true,
                sequence: { groupOrder: 1 },
              }
            : {}),
          ...(project.id === "tooling" ? { env: toolingEnvironment } : {}),
        },
      })),
      ...policy.registeredTests
        .filter(({ kind }) => kind === "qualification")
        .map(({ path, project }) => ({
          test: {
            name: project,
            environment: "node",
            include: [path],
            fileParallelism: false,
            retry: 0,
          },
        })),
      {
        test: {
          environment: "node",
          include: ["apps/control-center/**/*.unit.test.ts"],
          name: "browser",
        },
      },
      {
        test: {
          environment: "node",
          include: ["apps/admin-cli/**/*.unit.test.ts"],
          name: "admin-cli",
        },
      },
      {
        test: {
          environment: "node",
          include: [
            "apps/agent-service/**/*.{unit,contract}.test.ts",
            "apps/execution-worker/**/*.{unit,contract}.test.ts",
          ],
          name: "node-services",
        },
      },
      {
        test: {
          environment: "node",
          include: [
            "packages/persistence-sqlite/**/*.unit.test.ts",
            "packages/memory-mem0/**/*.unit.test.ts",
            "packages/integration-github/**/*.unit.test.ts",
          ],
          name: "workspace-scaffolds",
        },
      },
    ].map((project) => ({
      ...project,
      test: {
        ...project.test,
        ...(defaultTestTimeout !== undefined && !("testTimeout" in project.test)
          ? { testTimeout: defaultTestTimeout }
          : {}),
      },
    })),
  },
});
