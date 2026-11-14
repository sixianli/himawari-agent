import path from "node:path";
import { DEFAULT_SEARCH_ASK, perceptionSearchEvidenceText } from "@himawari-agent/application";
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
import { ingest, perceptionScope, utterance, visit } from "../fixtures/perception-test-client.ts";

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
            const spoken =
              record.contentRef === null ? undefined : await h.readText(record.contentRef);
            const written = perceptionSearchEvidenceText(record.type, record.evidence);
            const text =
              [spoken ?? "", written].filter((part) => part !== "").join(" · ") || undefined;
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

  it("finds a record by the place name in its evidence and answers with that name", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const stop = visit(h, -5);
    await ingest(h, client, [stop, utterance(h, "今天下午开会讨论预算", { seconds: -6 })]);

    const found = await ask(h, "Tokyo Station");
    expect(found).toMatchObject({ state: "answered", answer: "Tokyo Station" });
    expect(found.basis[0]).toMatchObject({ kind: "perception", recordId: stop.id });
    expect(await ask(h, "Osaka Castle")).toMatchObject({ state: "not_found", basis: [] });
  });

  it("rebuilds records whose index was built with another version", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const spoken = utterance(h, "我对花生过敏", { seconds: -8 });
    const stop = visit(h, -7);
    const third = utterance(h, "周五要去京都出差", { seconds: -6 });
    await ingest(h, client, [spoken, stop, third]);
    expect((await ask(h, "我对什么过敏")).state).toBe("answered");

    const store = h.repository.perception();
    for (const id of [spoken.id, stop.id, third.id])
      await store.replaceSearchTerms({
        ...perceptionScope,
        recordId: id,
        version: "old",
        terms: [],
      });
    expect(await ask(h, "我对什么过敏")).toMatchObject({ state: "not_found" });
    expect(
      await store.listStaleSearchRecords({
        ...perceptionScope,
        version: "perception-search-test:rules:2000",
        limit: 10,
      }),
    ).toHaveLength(3);

    expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(3);
    expect((await ask(h, "我对什么过敏")).state).toBe("answered");
    expect((await ask(h, "Tokyo Station")).state).toBe("answered");
    expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(0);
  });

  it("finds a record with transcript text by a window title that is not in the text", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const screen = {
      id: `perception:${"c".repeat(32)}`,
      type: "screen.text",
      captureSource: "system_api",
      occurredAt: new Date(Date.parse(h.clock.now()) - 5000).toISOString(),
      confidence: 900,
      text: "季度预算表格需要确认",
      evidence: { appName: "Sheets", windowTitle: "Quarterly Roadmap" },
    };
    await ingest(h, client, [screen]);
    const found = await ask(h, "Quarterly Roadmap");
    expect(found).toMatchObject({ state: "answered" });
    expect(found.basis[0]).toMatchObject({ kind: "perception", recordId: screen.id });
    expect(await ask(h, "Weekly Standup")).toMatchObject({ state: "not_found", basis: [] });
  });

  it("leaves records the rebuild skipped stale for the next attempt", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const spoken = utterance(h, "我对花生过敏", { seconds: -8 });
    await ingest(h, client, [spoken]);
    const store = h.repository.perception();
    const stale = await store.listStaleSearchRecords({
      ...perceptionScope,
      version: "another-version",
      limit: 10,
    });
    expect(stale).toHaveLength(1);
    expect(
      await store.listStaleSearchRecords({
        ...perceptionScope,
        version: "another-version",
        limit: 10,
        excludeRecordIds: [spoken.id],
      }),
    ).toHaveLength(0);
  });

  it("rebuilds stale records on the first search without an explicit rebuild", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const spoken = utterance(h, "我对花生过敏", { seconds: -8 });
    await ingest(h, client, [spoken]);
    await h.repository.perception().replaceSearchTerms({
      ...perceptionScope,
      recordId: spoken.id,
      version: "old",
      terms: [],
    });
    expect(indexRows(h, spoken.id)).toBe(0);
    expect(await ask(h, "我对什么过敏")).toMatchObject({ state: "answered" });
    expect(indexRows(h, spoken.id)).toBeGreaterThan(0);
  });

  it("caps the stored terms of one record at the configured limit", async () => {
    const h = await harness({ indexTermLimit: 6 });
    const client = await pairAndConfirm(h);
    const long = utterance(h, "今天下午开会讨论预算和下个季度的出差安排以及人员调整", {
      seconds: -8,
    });
    await ingest(h, client, [long]);
    expect(indexRows(h, long.id)).toBe(6);
    await h.repository.perception().replaceSearchTerms({
      ...perceptionScope,
      recordId: long.id,
      version: "old",
      terms: [],
    });
    expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(1);
    expect(indexRows(h, long.id)).toBe(6);
  });

  it.each(["throw", "undefined"] as const)(
    "leaves a record stale when reading its text %s during rebuild",
    async (mode) => {
      const failing = { on: false };
      const h = await harness({
        indexReadText: async (ref, read) => {
          const text = await read(ref);
          if (failing.on && text?.includes("花生")) {
            if (mode === "throw") throw new Error("READ_FAILED");
            return undefined;
          }
          return text;
        },
      });
      const client = await pairAndConfirm(h);
      const bad = utterance(h, "我对花生过敏", { seconds: -8 });
      const good = utterance(h, "周五要去京都出差", { seconds: -6 });
      await ingest(h, client, [bad, good]);
      for (const id of [bad.id, good.id])
        await h.repository.perception().replaceSearchTerms({
          ...perceptionScope,
          recordId: id,
          version: "old",
          terms: [],
        });
      failing.on = true;
      expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(1);
      expect(indexRows(h, good.id)).toBeGreaterThan(0);
      expect(indexRows(h, bad.id)).toBe(0);
      failing.on = false;
      expect(await h.perception.rebuildSearchIndex(perceptionScope)).toBe(1);
      expect(indexRows(h, bad.id)).toBeGreaterThan(0);
    },
  );
});
