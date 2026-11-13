import { describe, expect, it } from "vitest";
import {
  memoryClassificationFailureCode,
  ProductionMemoryClassifier,
} from "../src/production-memory-classification.js";

function harness(input: { dailyLimitMicros: number; batchCharacters: number; now?: string[] }) {
  const prompts: string[] = [];
  const failures: unknown[] = [];
  const times = input.now ?? [];
  const classifier = new ProductionMemoryClassifier({
    model: {
      estimateMicros: () => 100,
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        const items = (
          JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as {
            items: { id: string }[];
          }
        ).items.map(({ id }) => ({
          id,
          category: "preference",
          classification: "private",
          topic: null,
        }));
        return { output: JSON.stringify({ items }), costMicros: 40 };
      },
    },
    dailyLimitMicros: input.dailyLimitMicros,
    batchCharacters: input.batchCharacters,
    outputTokensPerItem: 60,
    timeZone: "Asia/Tokyo",
    now: () => times.shift() ?? "2026-11-13T03:00:00.000Z",
    newId: () => "classify",
    onFailure: (error) => failures.push(error),
  });
  return { classifier, prompts, failures };
}

describe("[T5] memory classifier", () => {
  it("splits a large import into batches by text length, not by a fixed count", async () => {
    const { classifier, prompts } = harness({ dailyLimitMicros: 10_000, batchCharacters: 10 });
    const results = await classifier.classify(["一二三四五六", "七八九十一二", "三四"]);
    expect(prompts).toHaveLength(2);
    expect(results.map(({ failed }) => failed)).toEqual([false, false, false]);
  });

  it("stops asking the model once today's limit is spent and marks the rest sensitive, then starts again the next day", async () => {
    const { classifier, prompts, failures } = harness({
      dailyLimitMicros: 120,
      batchCharacters: 6000,
      now: [
        "2026-11-13T03:00:00.000Z",
        "2026-11-13T03:00:00.000Z",
        "2026-11-13T04:00:00.000Z",
        "2026-11-13T04:00:00.000Z",
        "2026-11-13T16:00:00.000Z",
        "2026-11-13T16:00:00.000Z",
      ],
    });
    expect((await classifier.classify(["我喜欢跑步"]))[0]?.failed).toBe(false);
    const blocked = await classifier.classify(["我喜欢游泳"]);
    expect(blocked[0]).toEqual({
      category: "other",
      classification: "sensitive",
      topic: "other",
      failed: true,
    });
    expect(prompts).toHaveLength(1);
    expect(failures.map(memoryClassificationFailureCode)).toEqual([
      "MEMORY_CLASSIFICATION_DAILY_LIMIT",
    ]);
    expect((await classifier.classify(["我喜欢爬山"]))[0]?.failed).toBe(false);
    expect(prompts).toHaveLength(2);
  });

  it("never puts model output into the failure code it logs", () => {
    let parseError: unknown;
    try {
      JSON.parse("{主人的秘密");
    } catch (error) {
      parseError = error;
    }
    expect(memoryClassificationFailureCode(parseError)).toBe("SyntaxError");
    expect(memoryClassificationFailureCode(new Error("MODEL_NOT_COMPLETED"))).toBe(
      "MODEL_NOT_COMPLETED",
    );
  });
});
