import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-rule-book");
const AGENT_ID = createAgentId("agent-rule-book");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-11-10T00:00:00.000Z";
const T1 = "2026-11-10T01:00:00.000Z";
const T2 = "2026-11-10T02:00:00.000Z";
const NIGHT = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }];

describe("rule book in the product store", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const repositories: SqliteProductStateRepository[] = [];
  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function open() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-rule-book-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
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
    repositories.push(repository);
    return { stateRoot, store: repository.proactive() };
  }

  interface HistoryRow {
    readonly ruleId: string;
    readonly revision: number;
    readonly parameters: string;
    readonly changedAt: string;
  }

  function history(stateRoot: string): HistoryRow[] {
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    try {
      return database
        .prepare(
          "SELECT rule_id AS ruleId, revision, parameters, changed_at AS changedAt FROM rule_book_history ORDER BY changed_at, rule_id",
        )
        .all() as HistoryRow[];
    } finally {
      database.close();
    }
  }

  it("[HR-1] reads the built-in quiet hours and no senders before anything is saved", async () => {
    const { store } = await open();
    expect(await store.readSettings(scope)).toEqual({
      enabled: false,
      quietHours: NIGHT,
      quietHoursRevision: 0,
      importantSenders: [],
      importantSendersRevision: 0,
      updatedAt: null,
    });
  });

  it("[HR-1] refuses a sender with a lone surrogate that no rule expression could carry", async () => {
    const { store } = await open();
    await expect(
      store.writeSettings({
        ...scope,
        enabled: true,
        quietHours: NIGHT,
        importantSenders: ["\ud800@example.com"],
        now: T0,
      }),
    ).rejects.toThrow();
    expect((await store.readSettings(scope)).importantSenders).toEqual([]);
  });

  it("[HR-1] raises a rule's revision and records its history only when its value changes", async () => {
    const { stateRoot, store } = await open();
    await store.writeSettings({
      ...scope,
      enabled: true,
      quietHours: NIGHT,
      importantSenders: ["bank.example"],
      now: T0,
    });
    expect(await store.readSettings(scope)).toMatchObject({
      enabled: true,
      quietHoursRevision: 1,
      importantSenders: ["bank.example"],
      importantSendersRevision: 1,
      updatedAt: T0,
    });
    await store.writeSettings({
      ...scope,
      enabled: false,
      quietHours: NIGHT,
      importantSenders: ["bank.example", "a@b.com"],
      now: T1,
    });
    await store.writeSettings({
      ...scope,
      enabled: false,
      quietHours: [{ days: [6, 0], start: "22:00", end: "08:00" }],
      importantSenders: ["bank.example", "a@b.com"],
      now: T2,
    });
    expect(await store.readSettings(scope)).toEqual({
      enabled: false,
      quietHours: [{ days: [0, 6], start: "22:00", end: "08:00" }],
      quietHoursRevision: 2,
      importantSenders: ["bank.example", "a@b.com"],
      importantSendersRevision: 2,
      updatedAt: T2,
    });
    expect(
      history(stateRoot).map(({ ruleId, revision, changedAt }) => [ruleId, revision, changedAt]),
    ).toEqual([
      ["floor_important_sender", 1, T0],
      ["quiet_hours", 1, T0],
      ["floor_important_sender", 2, T1],
      ["quiet_hours", 2, T2],
    ]);
  });

  it("[HR-1] refuses settings the store cannot keep and leaves the rule book as it was", async () => {
    const { stateRoot, store } = await open();
    await store.writeSettings({
      ...scope,
      enabled: true,
      quietHours: NIGHT,
      importantSenders: [],
      now: T0,
    });
    await expect(
      store.writeSettings({
        ...scope,
        enabled: true,
        quietHours: [{ days: [0], start: "07:00", end: "07:00" }],
        importantSenders: ["x.example"],
        now: T1,
      }),
    ).rejects.toThrow();
    expect(await store.readSettings(scope)).toMatchObject({
      quietHours: NIGHT,
      importantSenders: [],
      importantSendersRevision: 1,
    });
    expect(history(stateRoot)).toHaveLength(2);
  });
});
