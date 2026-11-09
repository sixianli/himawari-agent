import { describe, expect, it } from "vitest";
import {
  DECISION_RULE_CATALOG,
  decisionRuleDefinition,
  FLOOR_RULE_IDS,
} from "../src/services/proactive-rules.js";

describe("decision rule catalog", () => {
  it("[P1-3] lists exactly the floor rules the check can write into a decision record, each with an origin and a document", () => {
    expect(Object.keys(DECISION_RULE_CATALOG).sort()).toEqual(Object.values(FLOOR_RULE_IDS).sort());
    for (const definition of Object.values(DECISION_RULE_CATALOG)) {
      expect(["owner_setting", "built_in"]).toContain(definition.origin);
      expect(definition.document.length).toBeGreaterThan(0);
    }
  });

  it("[P1-3] knows only registered rule ids and does not treat object prototype names or reason codes as rules", () => {
    expect(decisionRuleDefinition(FLOOR_RULE_IDS.importantSender)).toMatchObject({
      origin: "owner_setting",
    });
    for (const unknown of [
      "constructor",
      "toString",
      "__proto__",
      "confidence_below_threshold",
      "",
    ])
      expect(decisionRuleDefinition(unknown)).toBeUndefined();
  });
});
