import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: "node",
          include: ["apps/**/*.unit.test.ts", "packages/**/*.unit.test.ts"],
          name: "unit",
        },
      },
      {
        test: {
          environment: "node",
          include: ["apps/**/*.contract.test.ts", "packages/**/*.contract.test.ts"],
          name: "contracts",
        },
      },
      {
        test: {
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
          name: "integration",
        },
      },
      {
        test: {
          environment: "node",
          include: ["test/e2e/**/*.test.ts"],
          name: "e2e",
        },
      },
      {
        test: {
          environment: "node",
          include: ["packages/runtime-pi/**/*.compat.test.ts"],
          name: "pi-compat",
        },
      },
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
