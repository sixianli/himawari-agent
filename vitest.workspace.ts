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
    ],
  },
});
