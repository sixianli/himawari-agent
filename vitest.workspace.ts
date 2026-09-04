import { defineConfig } from "vitest/config";
import coveragePolicy from "./ci/coverage-policy.json" with { type: "json" };
import policy from "./ci/policy.json" with { type: "json" };

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
      ...policy.testProjects.map(({ id, include, exclude, fileParallelism }) => ({
        test: {
          name: id,
          environment: "node",
          include,
          exclude,
          fileParallelism,
          retry: 0,
          ...(id === "tooling" ? { env: toolingEnvironment } : {}),
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
    ],
  },
});
