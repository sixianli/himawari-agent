import { describe, expect, it } from "vitest";
import {
  DELIVERY_TIMING_DEFAULTS,
  type PerceptionRecord,
  type PerceptionStorePort,
} from "@himawari-agent/application";
import { createDeliveryTimingSource } from "../src/production-delivery-timing.js";

const NOW = 10_000_000;

function motion(index: number, activity: string): PerceptionRecord {
  return {
    id: `m-${String(index).padStart(5, "0")}`,
    deviceId: "d",
    type: "motion.activity",
    origin: "device",
    captureSource: "system_api",
    occurredAtMs: NOW - 100_000 + index,
    receivedAtMs: NOW - 100_000 + index,
    occurredAtDevice: "",
    localDay: "",
    confidence: 900,
    speakerKind: null,
    speakerRef: null,
    episodeId: null,
    contentRef: null,
    dataClassification: "private",
    evidence: { activity },
    status: "active",
  } as unknown as PerceptionRecord;
}

function pagedStore(records: readonly PerceptionRecord[]): PerceptionStorePort {
  return {
    async listRecordsBetween(input: {
      types: readonly string[] | null;
      after: { atMs: number; id: string } | null;
      limit: number;
    }) {
      const matching = records.filter(
        (record) =>
          input.types?.includes(record.type) === true &&
          (input.after === null ||
            record.occurredAtMs > input.after.atMs ||
            (record.occurredAtMs === input.after.atMs && record.id > input.after.id)),
      );
      return { records: matching.slice(0, input.limit), total: matching.length };
    },
  } as unknown as PerceptionStorePort;
}

async function asked(records: readonly PerceptionRecord[]) {
  const seen: unknown[] = [];
  const source = createDeliveryTimingSource({
    model: {
      estimateMicros: () => 1,
      probability: async (question: unknown) => {
        seen.push(question);
        return 0.9;
      },
    } as never,
    configuration: DELIVERY_TIMING_DEFAULTS,
    store: pagedStore(records),
    scope: { ownerId: "o", agentId: "a" } as never,
    reserve: async () => true,
    now: () => NOW,
  });
  await source.judge("scheduled_reminder", NOW);
  return JSON.stringify(seen);
}

describe("delivery timing source reads", () => {
  it("uses the newest motion record when the window holds more than one page", async () => {
    const records = [
      ...Array.from({ length: 600 }, (_, index) => motion(index, "driving")),
      motion(600, "stationary"),
    ];
    const question = await asked(records);
    expect(question).toContain("stationary");
    expect(question).not.toContain("driving");
  });

  it("REVERSE: still sees an older busy record when it is the newest one", async () => {
    const question = await asked(
      Array.from({ length: 600 }, (_, index) => motion(index, "driving")),
    );
    expect(question).toContain("driving");
  });
});
