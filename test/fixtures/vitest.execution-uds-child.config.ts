import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/execution-uds-child.test.ts"],
    name: "execution-uds-child-fixture",
    pool: "threads",
    maxWorkers: 1,
  },
});
