import { describe, expect, it } from "vitest";
import { highestClassification, isModelVisible } from "../src/services/model-visibility.ts";

describe("[RULE-memory-visible] model visibility", () => {
  it("lets the model see everything up to sensitive and never restricted", () => {
    expect(["public", "private", "sensitive", "restricted"].filter(isModelVisible)).toEqual([
      "public",
      "private",
      "sensitive",
    ]);
  });

  it("takes the highest classification and refuses an unknown one instead of treating it as low", () => {
    expect(highestClassification("private", ["public", "sensitive"])).toBe("sensitive");
    expect(highestClassification("private", [])).toBe("private");
    expect(() => highestClassification("private", ["secret" as never])).toThrow(
      "DATA_CLASSIFICATION_UNKNOWN",
    );
    expect(() => highestClassification(undefined as never, [])).toThrow(
      "DATA_CLASSIFICATION_UNKNOWN",
    );
  });
});
