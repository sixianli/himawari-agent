import path from "node:path";
import { DEFAULT_SEARCH_ASK } from "@himawari-agent/application";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionSearchControl } from "../../apps/agent-service/src/production-search.ts";
import {
  agentId,
  type Harness,
  harness,
  ownerId,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { ingest, perceptionScope, utterance } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function indexRows(h: Harness, recordId: string): number {
  const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
  try {
    return (
      database
        .prepare("SELECT COUNT(*) AS n FROM perception_search_terms WHERE record_id = ?")
        .get(recordId) as { n: number }
    ).n;
  } finally {
    database.close();
  }
}

function control(h: Harness) {
  return new ProductionSearchControl({
    ownerId,
    agentId,
    settings: DEFAULT_SEARCH_ASK,
    provider: { search: async () => [] },
    state: { readMany: async () => [], listActive: async () => [] },
    perception: {
      search: async ({ query, limit }) => {
        const records = await h.perception.search({ scope: perceptionScope, query, limit });
        const rows = await Promise.all(
          records.map(async (record) => {
            const text =
              record.contentRef === null ? undefined : await h.readText(record.contentRef);
            return text === undefined
              ? []
              : [
                  {
                    recordId: record.id,
                    origin: record.origin,
                    occurredAt: new Date(record.occurredAtMs).toISOString(),
                    dataClassification: record.dataClassification,
                    text,
                  },
                ];
          }),
        );
        return rows.flat();
      },
    },
    readText: async () => undefined,
    clock: { now: () => h.clock.now() },
  });
}

async function ask(h: Harness, query: string) {
  const snapshot = await control(h).query({
    schemaVersion: "gateway.v2",
    kind: "query",
    type: "search.ask.read",
    messageId: "message-1",
    correlationId: "message-1",
    causationId: null,
    payload: { query, locale: "zh-CN" },
  } as never);
  if (snapshot.type !== "search.ask.snapshot") throw new Error(snapshot.type);
  return snapshot.payload;
}

describe("perception literal search", () => {
  it("finds a spoken sentence by its words and stops finding it after deletion", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const spoken = utterance(h, "我对花生过敏", { seconds: -8 });
    await ingest(h, client, [spoken, utterance(h, "今天下午开会讨论预算", { seconds: -6 })]);

    expect(indexRows(h, spoken.id)).toBeGreaterThan(0);

    const found = await ask(h, "我对什么过敏");
    expect(found.state).toBe("answered");
    expect(found.basis[0]).toMatchObject({ kind: "perception", recordId: spoken.id });
    expect(found.basis[0]?.label).toMatch(/你说的|周围听到的/);

    expect(await ask(h, "明天的天气如何")).toMatchObject({ state: "not_found", basis: [] });

    const deleted = await h.repository
      .perception()
      .setRecordStatus({ ...perceptionScope, recordId: spoken.id, status: "deleted" });
    expect(deleted).toBe(true);
    expect(indexRows(h, spoken.id)).toBe(0);
    expect(await ask(h, "我对什么过敏")).toMatchObject({ state: "not_found", basis: [] });
  });
});
