import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/fixtures/durable-phase-child.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    pool: "threads",
  },
});
