import { describe, expect, it } from "vitest";
import { checkClassificationGates } from "../../scripts/check-classification-gates.mjs";

const run = (sources, pending = []) =>
  checkClassificationGates({
    files: Object.keys(sources),
    read: (file) => sources[file],
    pending: { files: pending },
  });

describe("[I-129] only passwords and keys may be kept from a model", () => {
  it("refuses the model configuration check that froze the main conversation", () => {
    const errors = run({
      "packages/application/src/services/admission.ts":
        "if (!bound.descriptor.allowedDataClassifications.includes(dataClassification)) throw x;",
    });
    expect(errors).toEqual([
      expect.stringMatching(/^DESCRIPTOR_CLASSIFICATION_GATE .*admission\.ts:1 /),
    ]);
  });

  it("refuses an allow list without sensitive and a comparison with one level", () => {
    const errors = run({
      "apps/agent-service/src/search.ts":
        'const SEARCH_VISIBLE = Object.freeze(["public", "private"]);\nif (intent.dataClassification !== "private") return;\nif ("sensitive" === record.classification) hide();',
    });
    expect(errors.map((error) => error.split(" ")[0])).toEqual([
      "CLASSIFICATION_LEVEL_COMPARED",
      "CLASSIFICATION_LEVEL_COMPARED",
      "CLASSIFICATION_ALLOW_LIST",
    ]);
  });

  it("accepts the single password and key check", () => {
    expect(
      run({
        "apps/agent-service/src/fine.ts":
          'if (!isModelVisible(intent.dataClassification)) return;\nif (payload.dataClassification === "restricted") return;',
      }),
    ).toEqual([]);
  });

  it("lets a listed file keep its checks but not add one, and drops a stale listing", () => {
    const pending = [{ path: "apps/memory.ts", count: 1, reason: "PR 2" }];
    expect(
      run({ "apps/memory.ts": 'if (m.dataClassification === "sensitive") ask();' }, pending),
    ).toEqual([]);
    expect(
      run(
        {
          "apps/memory.ts":
            'if (a.dataClassification === "sensitive" || b.classification === "private") ask();',
        },
        pending,
      ),
    ).toEqual([expect.stringMatching(/^CLASSIFICATION_GATE_ADDED apps\/memory\.ts /)]);
    expect(run({ "apps/memory.ts": "clean();" }, pending)).toEqual([
      expect.stringMatching(/^CLASSIFICATION_PENDING_STALE apps\/memory\.ts /),
    ]);
  });
});
