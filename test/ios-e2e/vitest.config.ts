import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/ios-e2e/serve.e2e.ts"],
    environment: "node",
    testTimeout: 0,
    hookTimeout: 120_000,
    fileParallelism: false,
    retry: 0,
  },
});
