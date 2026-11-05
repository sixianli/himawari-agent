import { describe, expect, it } from "vitest";
import {
  type ModelEgressContext,
  type SensitiveInterceptionRecordInput,
  SensitiveInterceptionRecorder,
  type SensitiveInterceptionStorePort,
} from "../src/index.js";

const context = {
  ownerId: "owner-1",
  agentId: "agent-1",
  threadId: "thread-1",
  source: "chat",
  purpose: "chat",
} as unknown as ModelEgressContext;

const sighting = (fingerprint: string) =>
  Object.freeze({
    part: "owner_message" as const,
    category: "password" as const,
    ruleId: "password-keyword" as const,
    fingerprint,
  });

function store(fail = false) {
  const writes: SensitiveInterceptionRecordInput[] = [];
  const port: SensitiveInterceptionStorePort = {
    record: async (input) => {
      if (fail) throw new Error("database unavailable");
      writes.push(input);
      return { recorded: input.observations.length, skipped: 0 };
    },
    list: async () => ({ items: [], next: null }),
    clear: async () => ({ cleared: 0 }),
  };
  return { writes, port };
}

describe("sensitive interception recorder", () => {
  it("returns at once and writes each owner and agent's sightings together on flush", async () => {
    const { writes, port } = store();
    const times = ["2026-11-05T01:00:00.000Z", "2026-11-05T01:00:00.100Z"];
    const recorder = new SensitiveInterceptionRecorder({
      store: port,
      now: () => times.shift() ?? "",
    });
    recorder.reportEgress(context, [sighting("a".repeat(32))]);
    recorder.reportEgress(context, [sighting("a".repeat(32)), sighting("b".repeat(32))]);
    expect(writes).toEqual([]);
    await recorder.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.now).toBe("2026-11-05T01:00:00.100Z");
    expect(writes[0]?.observations).toEqual([
      expect.objectContaining({ fingerprint: "a".repeat(32), outcome: "masked", occurrences: 1 }),
      expect.objectContaining({ fingerprint: "a".repeat(32) }),
      expect.objectContaining({
        fingerprint: "b".repeat(32),
        threadId: "thread-1",
        source: "chat",
      }),
    ]);
  });

  it("drops the oldest sightings beyond the queue limit and says how many", async () => {
    const { writes, port } = store();
    const dropped: number[] = [];
    const recorder = new SensitiveInterceptionRecorder({
      store: port,
      now: () => "2026-11-05T01:00:00.000Z",
      queueLimit: 2,
      onDropped: (count) => dropped.push(count),
    });
    recorder.reportEgress(
      context,
      ["1", "2", "3"].map((digit) => sighting(digit.repeat(16))),
    );
    await recorder.flush();
    expect(dropped).toEqual([1]);
    expect(recorder.dropped).toBe(1);
    expect(writes[0]?.observations.map(({ fingerprint }) => fingerprint[0])).toEqual(["2", "3"]);
  });

  it("never throws to the caller when the clock, the database or the failure listener fails", async () => {
    const failures: unknown[] = [];
    const broken = new SensitiveInterceptionRecorder({
      store: store(true).port,
      now: () => "2026-11-05T01:00:00.000Z",
      onWriteFailed: (error) => {
        failures.push(error);
        throw new Error("listener failed");
      },
    });
    expect(() => broken.reportEgress(context, [sighting("a".repeat(32))])).not.toThrow();
    await expect(broken.flush()).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
    const noClock = new SensitiveInterceptionRecorder({
      store: store().port,
      now: () => {
        throw new Error("clock failed");
      },
    });
    expect(() => noClock.reportEgress(context, [sighting("a".repeat(32))])).not.toThrow();
  });

  it("records a memory left unsaved because of a secret, once per kind, without its text", async () => {
    const { writes, port } = store();
    const recorder = new SensitiveInterceptionRecorder({
      store: port,
      now: () => "2026-11-05T01:00:00.000Z",
    });
    const record = {
      ownerId: "owner-1",
      agentId: "agent-1",
      threadId: "thread-1",
      sourceRef: "payload-1",
      generationId: "memory-capture:run-1",
      policyVersion: "v1",
      modelDescriptorRef: "m",
      candidateOrdinal: 2,
      classification: "private",
      outcome: "candidate_secret_excluded",
      secretFindings: [
        { ruleId: "password", count: 1 },
        { ruleId: "openai-api-key", count: 1 },
        { ruleId: "unknown-rule", count: 1 },
      ],
      occurredAt: "2026-11-05T01:00:00.000Z",
    } as unknown as Parameters<typeof recorder.reportMemoryAudit>[0];
    recorder.reportMemoryAudit(record);
    recorder.reportMemoryAudit({ ...record, outcome: "auto_committed" });
    recorder.reportMemoryAudit(record);
    await recorder.flush();
    const observations = writes.flatMap((write) => write.observations);
    expect(
      observations.map(({ part, category, outcome, source }) => [part, category, outcome, source]),
    ).toEqual([
      ["memory_candidate", "password", "not_saved", "memory_capture"],
      ["memory_candidate", "machine-secret", "not_saved", "memory_capture"],
      ["memory_candidate", "password", "not_saved", "memory_capture"],
      ["memory_candidate", "machine-secret", "not_saved", "memory_capture"],
    ]);
    expect(observations[0]?.fingerprint).toBe(observations[2]?.fingerprint);
    expect(observations[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/u);
  });
});
