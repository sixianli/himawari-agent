import { describe, expect, it } from "vitest";
import { PiToolProgressGuard } from "../src/pi-tool-progress-guard.js";

describe("provider-independent tool progress guard", () => {
  it("recognizes reordered JSON arguments without retaining tool data", () => {
    const guard = new PiToolProgressGuard();
    for (let i = 0; i < 3; i++)
      guard.observe("read", { path: "private-file", offset: 1 }, "private output", false);
    expect(guard.blocked).toBe(false);
    guard.observe("read", { offset: 1, path: "private-file" }, "private output", false);
    expect(guard.blocked).toBe(true);
    expect(JSON.stringify(guard.snapshot())).not.toContain("private");
  });
  it.each([2, 4])("detects a rotating %i-call loop despite changing output", (count) => {
    const guard = new PiToolProgressGuard();
    const limit = count === 2 ? 12 : 16;
    for (let i = 0; i < limit - 1; i++)
      guard.observe(`tool-${i % count}`, { path: "same" }, `timestamp-${i}`, false);
    expect(guard.blocked).toBe(false);
    guard.observe(`tool-${(limit - 1) % count}`, { path: "same" }, "last timestamp", false);
    expect(guard.blocked).toBe(true);
  });
  it("allows a batch that makes progress and starts new Runs with fresh state", () => {
    const guard = new PiToolProgressGuard();
    for (let i = 0; i < 100; i++)
      guard.observe("read", { path: `file-${i}` }, "same content", false);
    expect(guard.blocked).toBe(false);
    expect(guard.snapshot().recent).toHaveLength(16);
    const fresh = new PiToolProgressGuard();
    fresh.observe("read", { path: "file-99" }, "same content", false);
    expect(fresh.blocked).toBe(false);
  });
  it("restores approval state without sharing mutable arrays", () => {
    const guard = new PiToolProgressGuard();
    for (let i = 0; i < 3; i++) guard.observe("read", {}, "same", false);
    const saved = guard.snapshot();
    const resumed = new PiToolProgressGuard(saved);
    resumed.observe("read", {}, "same", false);
    expect(resumed.blocked).toBe(true);
    expect(guard.blocked).toBe(false);
    expect(saved.recent).toHaveLength(3);
    expect(() => new PiToolProgressGuard({ ...saved, recent: ["untrusted"] })).toThrow(
      "PI_TOOL_PROGRESS_STATE_INVALID",
    );
  });
});
