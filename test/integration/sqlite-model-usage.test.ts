import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelUsageObservation } from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  MINIMUM_CACHEABLE_INPUT_TOKENS,
  MINIMUM_REPORTED_REQUESTS,
  renderTable,
  summarize,
} from "../../scripts/operations/cache-hit-report.mjs";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-model-usage");
const AGENT_ID = createAgentId("agent-model-usage");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-10-30T01:00:00.000Z";

function observation(
  invocationId: string,
  overrides: Partial<ModelUsageObservation> = {},
): ModelUsageObservation {
  return {
    ...scope,
    runId: createRunId(`run-${invocationId}`),
    invocationId,
    purpose: "chat",
    source: "agent-stream",
    provider: "magpie",
    model: "himawari-main",
    inputTokens: 4000,
    outputTokens: 100,
    cacheReadTokens: 3000,
    cacheWriteTokens: 0,
    cacheReported: true,
    occurredAt: T0,
    ...overrides,
  };
}

describe("[MU-1] model usage observations", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function open() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-model-usage-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    return { databasePath, repository, store: repository.modelUsage() };
  }

  function report(databasePath: string, options?: Parameters<typeof summarize>[1]) {
    const database = new Database(databasePath, { readonly: true });
    try {
      return summarize(database, options);
    } finally {
      database.close();
    }
  }

  it("[MU-1] computes the hit rate from reported requests only and keeps unreported ones out of it", async () => {
    const { databasePath, repository, store } = await open();
    try {
      for (let index = 0; index < MINIMUM_REPORTED_REQUESTS; index += 1)
        await store.record(observation(`reported-${index}`));
      await store.record(
        observation("unreported", {
          cacheReported: false,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      );
      await store.record(observation("reported-zero", { cacheReadTokens: 0 }));
      await repository.close();
      const [row] = report(databasePath);
      expect(row).toMatchObject({
        group: "chat",
        requests: 7,
        reported: 6,
        unreported: 1,
        measured: 6,
      });
      expect(row?.hitRate).toBeCloseTo(15000 / 24000, 10);
    } finally {
      await repository.close().catch(() => undefined);
    }
  });

  it("[MU-1] shows no percentage below the sample threshold and counts too-short requests separately", async () => {
    const { databasePath, repository, store } = await open();
    try {
      for (let index = 0; index < MINIMUM_REPORTED_REQUESTS - 1; index += 1)
        await store.record(observation(`few-${index}`));
      await store.record(
        observation("short", {
          inputTokens: MINIMUM_CACHEABLE_INPUT_TOKENS - 1,
          cacheReadTokens: 0,
        }),
      );
      await repository.close();
      const [row] = report(databasePath);
      expect(row).toMatchObject({ requests: 5, measured: 4, tooShort: 1, hitRate: null });
      expect(renderTable(row === undefined ? [] : [row])).toContain("样本不足(4)");
    } finally {
      await repository.close().catch(() => undefined);
    }
  });

  it("[MU-1] separates follow-up requests inside one run and groups by purpose, model and Tokyo day", async () => {
    const { databasePath, repository, store } = await open();
    try {
      const run = createRunId("run-shared");
      for (let index = 0; index < MINIMUM_REPORTED_REQUESTS + 1; index += 1)
        await store.record(
          observation(`step-${index}`, {
            runId: run,
            cacheReadTokens: index === 0 ? 0 : 3500,
            occurredAt: `2026-10-30T01:00:0${index}.000Z`,
          }),
        );
      await store.record(
        observation("title", {
          purpose: "thread-title",
          source: "model-port",
          model: "title-model",
          occurredAt: "2026-10-30T16:30:00.000Z",
        }),
      );
      await repository.close();
      const byPurpose = report(databasePath);
      expect(byPurpose.map((row) => row.group)).toEqual(["chat", "thread-title"]);
      const chat = byPurpose[0];
      expect(chat?.followUps).toBe(MINIMUM_REPORTED_REQUESTS);
      expect(chat?.followUpHitRate).toBeCloseTo(3500 / 4000, 10);
      expect(chat?.hitRate).toBeCloseTo((3500 * MINIMUM_REPORTED_REQUESTS) / (4000 * 6), 10);
      expect(report(databasePath, { grouping: "model" }).map((row) => row.group)).toEqual([
        "himawari-main",
        "title-model",
      ]);
      expect(report(databasePath, { grouping: "day" }).map((row) => row.group)).toEqual([
        "2026-10-30",
        "2026-10-31",
      ]);
      expect(report(databasePath, { since: "2026-10-30T16:00:00.000Z" })).toHaveLength(1);
    } finally {
      await repository.close().catch(() => undefined);
    }
  });

  it("[MU-1] records one row per invocation and refuses observations that contradict themselves", async () => {
    const { databasePath, repository, store } = await open();
    try {
      await store.record(observation("once"));
      await store.record(observation("once", { cacheReadTokens: 1 }));
      await expect(
        store.record(observation("too-many", { cacheReadTokens: 4001 })),
      ).rejects.toThrow();
      await expect(
        store.record(observation("fabricated", { cacheReported: false, cacheReadTokens: 10 })),
      ).rejects.toThrow();
      await expect(
        store.record(observation("bad-purpose", { purpose: "guess" as never })),
      ).rejects.toThrow();
      await expect(
        store.record(observation("bad-time", { occurredAt: "yesterday" })),
      ).rejects.toThrow();
      await repository.close();
      const [row] = report(databasePath);
      expect(row).toMatchObject({ requests: 1, reported: 1 });
    } finally {
      await repository.close().catch(() => undefined);
    }
  });
});
