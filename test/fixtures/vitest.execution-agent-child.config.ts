import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/execution-agent-child.test.ts"],
    name: "execution-agent-child-fixture",
    pool: "threads",
    maxWorkers: 1,
  },
});
