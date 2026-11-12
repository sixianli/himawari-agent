import { describe, expect, it } from "vitest";
import {
  localToInstant,
  parseRuleScope,
  type RuleScopeVerifier,
  reconcileScope,
  scopeContext,
} from "../src/production-rule-scope.js";

const NOW = "2026-11-11T14:00:00.000Z";
const TOKYO = "Asia/Tokyo";
const VERIFIER: RuleScopeVerifier = { verify: async () => undefined };
const UNTIL = { kind: "until", expiresAt: "2026-11-11T22:00:00.000Z" } as const;
const base = {
  inferred: false,
  ownerSaid: true,
  verifier: VERIFIER,
  now: NOW,
  maxDays: 366,
};

describe("[RS-1] rule scope", () => {
  it("converts the owner's local time and rejects impossible ones", () => {
    expect(localToInstant("2026-11-12T07:00", TOKYO)).toBe("2026-11-11T22:00:00.000Z");
    expect(localToInstant("2026-02-30T07:00", TOKYO)).toBeUndefined();
    expect(localToInstant("2026-11-12T24:00", TOKYO)).toBeUndefined();
    expect(localToInstant("2026-11-12 07:00", TOKYO)).toBeUndefined();
  });

  it("parses scope with the cap and defaults to standing when absent", () => {
    const input = { now: NOW, timeZone: TOKYO, maxDays: 366 };
    expect(parseRuleScope(undefined, input)).toEqual({ kind: "standing" });
    expect(parseRuleScope({ kind: "until", until: "2026-11-12T07:00" }, input)).toEqual(UNTIL);
    expect(parseRuleScope({ kind: "until", until: "2026-11-11T20:00" }, input)).toBeUndefined();
    expect(parseRuleScope({ kind: "until", until: "2028-01-01T07:00" }, input)).toBeUndefined();
    expect(parseRuleScope({ kind: "until" }, input)).toBeUndefined();
    expect(parseRuleScope({ kind: "standing", until: "2026-11-12T07:00" }, input)).toBeUndefined();
    expect(parseRuleScope("standing", input)).toBeUndefined();
  });

  it("follows the decision table", () => {
    const standing = { kind: "standing" } as const;
    const verdict = (scope: string, until: string | null = null) =>
      ({ scope, until, evidence: null }) as never;
    expect(reconcileScope({ ...base, main: standing, verdict: verdict("standing") })).toEqual({
      kind: "activate",
      expiresAt: null,
    });
    expect(
      reconcileScope({
        ...base,
        main: UNTIL,
        verdict: verdict("until", "2026-11-11T22:30:00.000Z"),
      }),
    ).toEqual({ kind: "activate", expiresAt: "2026-11-11T22:00:00.000Z" });
    expect(
      reconcileScope({
        ...base,
        main: UNTIL,
        verdict: verdict("until", "2026-11-11T21:30:00.000Z"),
      }),
    ).toEqual({ kind: "activate", expiresAt: "2026-11-11T21:30:00.000Z" });
    expect(reconcileScope({ ...base, main: UNTIL, verdict: verdict("until") })).toEqual({
      kind: "activate",
      expiresAt: "2026-11-11T22:00:00.000Z",
    });
    expect(
      reconcileScope({
        ...base,
        main: UNTIL,
        verdict: verdict("until", "2026-11-12T01:00:00.000Z"),
      }),
    ).toEqual({ kind: "ask", reason: "mismatch" });
    expect(reconcileScope({ ...base, main: UNTIL, verdict: verdict("standing") })).toEqual({
      kind: "ask",
      reason: "mismatch",
    });
    expect(reconcileScope({ ...base, main: standing, verdict: verdict("until") })).toEqual({
      kind: "ask",
      reason: "mismatch",
    });
    expect(reconcileScope({ ...base, main: standing, verdict: verdict("this_item") })).toEqual({
      kind: "ask",
      reason: "this_item",
    });
    expect(reconcileScope({ ...base, main: standing, verdict: verdict("unclear") })).toEqual({
      kind: "ask",
      reason: "unclear",
    });
    expect(
      reconcileScope({
        ...base,
        main: UNTIL,
        verdict: verdict("until", "2026-11-11T13:00:00.000Z"),
      }),
    ).toEqual({ kind: "propose", expiresAt: "2026-11-11T22:00:00.000Z" });
    expect(reconcileScope({ ...base, main: standing, verdict: undefined })).toEqual({
      kind: "propose",
      expiresAt: null,
    });
  });

  it("never lets a second reader or a missing one turn an inferred or unsaid rule into a live one", () => {
    const standing = { kind: "standing" } as const;
    const agree = { scope: "standing", until: null, evidence: "夜里" } as const;
    expect(reconcileScope({ ...base, main: standing, inferred: true, verdict: agree })).toEqual({
      kind: "propose",
      expiresAt: null,
    });
    expect(reconcileScope({ ...base, main: standing, ownerSaid: false, verdict: agree })).toEqual({
      kind: "propose",
      expiresAt: null,
    });
    expect(
      reconcileScope({ ...base, main: UNTIL, verifier: undefined, verdict: undefined }),
    ).toEqual({ kind: "activate", expiresAt: "2026-11-11T22:00:00.000Z" });
  });

  it("trims the context around the quote", () => {
    const long = `${"甲".repeat(5000)}夜里别提醒我${"乙".repeat(5000)}`;
    const context = scopeContext(long, "夜里别提醒我");
    expect(context).toContain("夜里别提醒我");
    expect(Array.from(context).length).toBeLessThanOrEqual(4006);
    expect(scopeContext("短", "短")).toBe("短");
  });
});
