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

it("bounds file conflicts across changing content, intervening reads, and approval restoration", () => {
  let guard = new PiToolProgressGuard();
  for (let i = 0; i < 4; i++) {
    guard.observe("write", { path: "note", content: i }, "conflict", true, "FILE_VERSION_CONFLICT");
    guard.observe("read", { path: "note", offset: i }, `latest ${i}`, false);
    guard = new PiToolProgressGuard(guard.snapshot());
    expect(guard.blocked).toBe(i === 3);
  }
});

it("[ADR-0257] stops after the configured refusals in a row or in total, and keeps the count across approval restoration", () => {
  const limits = { consecutive: 3, total: 5 };
  let guard = new PiToolProgressGuard(undefined, limits);
  for (let i = 0; i < 2; i++)
    guard.observe("reminder_set", { text: `a${i}` }, "refused", true, "action_rule_refused", true);
  guard = new PiToolProgressGuard(guard.snapshot(), limits);
  expect(guard.blocked).toBe(false);
  guard.observe("reminder_set", { text: "a2" }, "refused", true, "action_rule_refused", true);
  expect(guard.blocked).toBe(true);

  const total = new PiToolProgressGuard(undefined, limits);
  for (let i = 0; i < 4; i++) {
    total.observe("rule_set", { text: `r${i}` }, "refused", true, undefined, true);
    total.observe("read", { path: `file-${i}` }, `content ${i}`, false);
  }
  expect(total.blocked).toBe(false);
  total.observe("rule_set", { text: "r4" }, "refused", true, undefined, true);
  expect(total.blocked).toBe(true);

  const untouched = new PiToolProgressGuard(undefined, limits);
  for (let i = 0; i < 10; i++)
    untouched.observe("read", { path: `file-${i}` }, "failed", true, "FILE_NOT_FOUND");
  expect(untouched.blocked).toBe(false);
  expect(() => new PiToolProgressGuard(undefined, { consecutive: 0, total: 5 })).toThrow(
    "PI_TOOL_REFUSAL_LIMITS_INVALID",
  );
  expect(() => new PiToolProgressGuard({ ...untouched.snapshot(), refusals: -1 }, limits)).toThrow(
    "PI_TOOL_PROGRESS_STATE_INVALID",
  );
});
