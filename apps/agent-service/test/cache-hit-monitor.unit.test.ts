import type {
  ModelUsageObservation,
  ModelUsageStorePort,
} from "@himawari-agent/application/model-usage";
import { describe, expect, it } from "vitest";
import { type LowFollowUpCacheHit, monitorFollowUpCacheHits } from "../src/cache-hit-monitor.js";

function observation(overrides: Partial<ModelUsageObservation> = {}): ModelUsageObservation {
  return {
    ownerId: "owner",
    agentId: "agent",
    runId: "run-2",
    invocationId: "invocation-1",
    purpose: "chat",
    source: "agent-stream",
    provider: "magpie",
    model: "group/himawari-main",
    inputTokens: 14756,
    outputTokens: 120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheReported: true,
    occurredAt: "2026-11-02T00:44:00.000Z",
    ...overrides,
  } as unknown as ModelUsageObservation;
}

function monitored(followUp: boolean, withLookup = true) {
  const recorded: ModelUsageObservation[] = [];
  const reports: LowFollowUpCacheHit[] = [];
  const store: ModelUsageStorePort = {
    record: async (value) => {
      recorded.push(value);
    },
    ...(withLookup ? { isFollowUpTurn: async () => followUp } : {}),
  };
  return { store: monitorFollowUpCacheHits(store, (hit) => reports.push(hit)), recorded, reports };
}

describe("[I-66] follow-up turn cache hit monitor", () => {
  it("[I-66] reports a follow-up turn request whose hit rate is below the floor, and still records it", async () => {
    const { store, recorded, reports } = monitored(true);
    await store.record(observation());
    expect(recorded).toHaveLength(1);
    expect(reports).toEqual([
      expect.objectContaining({
        runId: "run-2",
        inputTokens: 14756,
        cacheReadTokens: 0,
        hitRate: 0,
        floor: 0.5,
      }),
    ]);
  });

  it("[I-66] stays silent for a healthy hit rate, the first turn, unreported cache, short input and other purposes", async () => {
    const healthy = monitored(true);
    await healthy.store.record(observation({ cacheReadTokens: 12000 }));
    const firstTurn = monitored(false);
    await firstTurn.store.record(observation());
    const unreported = monitored(true);
    await unreported.store.record(observation({ cacheReported: false }));
    const short = monitored(true);
    await short.store.record(observation({ inputTokens: 900 }));
    const title = monitored(true);
    await title.store.record(observation({ purpose: "thread-title" }));
    const noLookup = monitored(true, false);
    await noLookup.store.record(observation());
    for (const run of [healthy, firstTurn, unreported, short, title, noLookup])
      expect(run.reports).toEqual([]);
    expect(noLookup.recorded).toHaveLength(1);
  });

  it("[I-66] never fails the recording when the turn lookup throws", async () => {
    const reports: LowFollowUpCacheHit[] = [];
    const store = monitorFollowUpCacheHits(
      {
        record: async () => undefined,
        isFollowUpTurn: async () => {
          throw new Error("lookup failed");
        },
      },
      (hit) => reports.push(hit),
    );
    await expect(store.record(observation())).resolves.toBeUndefined();
    expect(reports).toEqual([]);
  });
});
