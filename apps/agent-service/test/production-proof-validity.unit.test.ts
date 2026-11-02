import { describe, expect, it } from "vitest";
import {
  LIVE_PROOF_VALIDITY_MS,
  proofValidUntil,
  RETAINED_RELEASE_PROOF_VALIDITY_MS,
} from "../src/production-proof-validity.js";

const checkedAt = "2026-11-01T06:56:23.000Z";

describe("proofValidUntil", () => {
  it("keeps a live observation valid for one second", () => {
    expect(Date.parse(proofValidUntil(checkedAt, false)) - Date.parse(checkedAt)).toBe(
      LIVE_PROOF_VALIDITY_MS,
    );
  });
  it("keeps a proof built from an accepted release receipt valid long enough to survive a slow database", () => {
    const validity = Date.parse(proofValidUntil(checkedAt, true)) - Date.parse(checkedAt);
    expect(validity).toBe(RETAINED_RELEASE_PROOF_VALIDITY_MS);
    expect(validity).toBeGreaterThanOrEqual(10_000);
  });
});
