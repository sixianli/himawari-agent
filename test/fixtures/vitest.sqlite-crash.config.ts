import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/sqlite-transaction-child.test.ts"],
    name: "sqlite-crash-fixture",
  },
});
