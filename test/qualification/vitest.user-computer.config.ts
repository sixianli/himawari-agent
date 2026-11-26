import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "qualification-user-computer",
    environment: "node",
    include: ["test/qualification/user-computer-qualification.ts"],
    fileParallelism: false,
    allowOnly: false,
    passWithNoTests: false,
    retry: 0,
  },
});
