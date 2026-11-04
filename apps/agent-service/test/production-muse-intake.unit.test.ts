import { describe, expect, it } from "vitest";
import { parseMuseBatch } from "../src/production-muse-intake.ts";

const field = (value: unknown, source = "system_record") => ({ value, source });

function item(overrides: Record<string, unknown> = {}) {
  return {
    type: "muse_proactive_item",
    submission_id: field("sub-1"),
    queue_state: field("delivered"),
    outcome_recorded_at_utc: field("2026-11-01T08:20:08.2000000Z"),
    ...overrides,
  };
}

function batch(items: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    sender_id: "muse",
    batch_seq: 3,
    sent_at_utc: "2026-11-01T09:00:00Z",
    items,
    ...overrides,
  };
}

describe("parseMuseBatch", () => {
  it("normalizes times to milliseconds and keeps each field's source label", () => {
    const parsed = parseMuseBatch(batch([item()]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.batch.sentAt).toBe("2026-11-01T09:00:00.000Z");
    expect(parsed.batch.drafts[0]?.write).toMatchObject({
      naturalKey: "sub-1",
      state: "delivered",
      occurredAt: "2026-11-01T08:20:08.200Z",
      sources: { natural_key: "system_record", queue_state: "system_record" },
    });
  });

  it("accepts a bare value as an unknown source and treats a null value as absent", () => {
    const parsed = parseMuseBatch(
      batch([item({ priority: "high", reason_enum: { value: null, source: "not_recorded" } })]),
    );
    expect(parsed.ok && parsed.batch.drafts[0]?.write.sources["priority"]).toBe("unknown");
    expect(parsed.ok && parsed.batch.drafts[0]?.write.reasonEnum).toBeNull();
  });

  it("rejects an envelope with the wrong sender, sequence, time or item list", () => {
    for (const [overrides, name] of [
      [{ sender_id: "other" }, "sender_id"],
      [{ batch_seq: 0 }, "batch_seq"],
      [{ batch_seq: 1.5 }, "batch_seq"],
      [{ sent_at_utc: "2026-11-01 09:00" }, "sent_at_utc"],
      [{ items: "no" }, "items"],
      [{ items: Array.from({ length: 101 }, () => item()) }, "items"],
    ] as const) {
      expect(parseMuseBatch(batch([], overrides))).toEqual({ ok: false, field: name });
    }
    expect(parseMuseBatch("text")).toEqual({ ok: false, field: "body" });
  });

  it("rejects single items for unknown types, states, sources, times and missing required fields", () => {
    const parsed = parseMuseBatch(
      batch([
        item({ queue_state: field("exploded") }),
        item({ queue_state: field("delivered", "made_up") }),
        item({ outcome_recorded_at_utc: field("2026-11-01") }),
        item({ outcome_recorded_at_utc: undefined }),
        item({ submission_id: undefined }),
        item({ queue_state: field("suppressed") }),
        item({ options_offered: field(["a", 3]) }),
        item({ submission_id: field("has space") }),
        { type: "muse_other" },
        "text",
      ]),
    );
    expect(parsed.ok && parsed.batch.drafts).toHaveLength(0);
    expect(parsed.ok && parsed.batch.rejectedCount).toBe(10);
  });

  it("requires a reason code for suppressed items and accepts it", () => {
    const parsed = parseMuseBatch(
      batch([
        item({
          queue_state: field("suppressed"),
          reason_code: field("revalidation_declined"),
          decision: field(null),
        }),
      ]),
    );
    expect(parsed.ok && parsed.batch.drafts[0]?.write).toMatchObject({
      state: "suppressed",
      reasonCode: "revalidation_declined",
      decision: null,
    });
  });

  it("counts fields outside the allow-list and never carries them into the draft", () => {
    const parsed = parseMuseBatch(
      batch([item({ layer_1_trigger_definition: field("task body"), health: "x" })], {
        extra: 1,
      }),
    );
    expect(parsed.ok && parsed.batch.droppedFieldCount).toBe(3);
    expect(JSON.stringify(parsed)).not.toContain("task body");
  });

  it("gives the same digest for the same content and a different one when the text changes", () => {
    const digest = (text: string) => {
      const parsed = parseMuseBatch(batch([item({ delivered_text: field(text, "chat_record") })]));
      return parsed.ok ? parsed.batch.drafts[0]?.write.contentDigest : undefined;
    };
    expect(digest("a")).toBe(digest("a"));
    expect(digest("a")).not.toBe(digest("b"));
  });

  it("stores a scheduled run with status mapped to its state and the job id as the title", () => {
    const parsed = parseMuseBatch(
      batch([
        {
          type: "muse_scheduled_run",
          run_id: field("run-1"),
          job_id: field("nightly"),
          status: field("failed"),
          finished_at_utc: field("2026-10-31T12:55:58Z"),
          attempt: field(1),
        },
      ]),
    );
    expect(parsed.ok && parsed.batch.drafts[0]).toMatchObject({
      title: "nightly",
      write: { kind: "scheduled", state: "failed", naturalKey: "run-1" },
    });
  });
});
