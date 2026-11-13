import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { joinDraft, splitDraft } from "../../apps/control-center/src/draft-attachments.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../clients/apple/Tests/HimawariCoreTests/Fixtures/attachment-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  vectors: { text: string; files: Parameters<typeof joinDraft>[1]; joined: string }[];
};

describe("the Swift attachment fixture still matches the web draft format", () => {
  it("has vectors", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  it.each(fixture.vectors.map((vector, index) => [index, vector] as const))(
    "vector %i joins to the stored text and splits back",
    (_index, vector) => {
      expect(joinDraft(vector.text, vector.files)).toBe(vector.joined);
      const back = splitDraft(vector.joined);
      expect(back.text).toBe(vector.text);
      expect(back.files.length).toBe(vector.files.length);
    },
  );
});
