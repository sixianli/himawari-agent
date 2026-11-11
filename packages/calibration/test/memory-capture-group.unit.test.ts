import { describe, expect, it } from "vitest";
import { calibrationGroup, ratingLabel } from "../src/index.ts";

const row = (outcome: string | null) => ({
  kind: "memory_candidate",
  outcome,
  ownerRating: null,
  delivered: false,
});

describe("[P3-5] failed memory capture in the weekly check", () => {
  it.each(["capture_retrying", "capture_queued", "capture_gave_up"])(
    "puts %s in its own group instead of waiting for approval",
    (outcome) => {
      expect(calibrationGroup(row(outcome))).toBe("memory_capture_failed");
    },
  );

  it("[negative] leaves kept, skipped and pending memories where they were", () => {
    expect(calibrationGroup(row("kept"))).toBe("memory_kept");
    expect(calibrationGroup(row("discarded"))).toBe("memory_skipped");
    expect(calibrationGroup(row("pending_approval"))).toBe("memory_pending");
  });

  it("asks whether something worth keeping was lost, not whether the failure was useful", () => {
    expect(ratingLabel("memory_capture_failed", "useful")).toBe("没漏掉什么");
    expect(ratingLabel("memory_capture_failed", "missed")).toBe("漏了该记的");
    expect(ratingLabel("memory_capture_failed", "unneeded")).toBeNull();
  });
});
