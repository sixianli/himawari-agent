import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "scripts/evals/memory-capture-live.eval.ts",
      "scripts/evals/memory-conversation-review-live.eval.ts",
      "scripts/evals/owner-rule-live.eval.ts",
      "scripts/evals/owner-intent-live.eval.ts",
      "scripts/evals/memory-time-scope-live.eval.ts",
      "scripts/evals/listening-addressee-live.eval.ts",
      "scripts/evals/delivery-timing-live.eval.ts",
    ],
    testTimeout: 3_600_000,
    fileParallelism: false,
    retry: 0,
  },
});
