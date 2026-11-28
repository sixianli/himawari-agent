import { describe, expect, it } from "vitest";
import type { GovernedActionIntent } from "../src/ports/authorization.ts";
import {
  type CapabilityAuthorizationFacts,
  capabilityDenial,
} from "../src/services/action-policy-service.ts";

const facts: CapabilityAuthorizationFacts = {
  lifecycle: "active",
  manifest: {
    version: "1.0.0",
    operations: ["web_search"],
    health: { status: "healthy", checkedAt: null },
    scopes: { dataClassifications: ["public", "private"] },
  },
};

function intent(dataClassification: GovernedActionIntent["dataClassification"]) {
  return { capabilityVersion: "1.0.0", operation: "web_search", dataClassification } as never;
}

describe("[I-129] a tool's old data scope only keeps passwords and keys out", () => {
  it("lets a conversation that mentioned health use a tool installed for private data", () => {
    expect(capabilityDenial(facts, intent("sensitive"))).toBeNull();
    expect(capabilityDenial(facts, intent("private"))).toBeNull();
  });

  it("still refuses passwords and keys the tool never declared", () => {
    expect(capabilityDenial(facts, intent("restricted"))).toBe("data_scope_not_declared");
  });
});
