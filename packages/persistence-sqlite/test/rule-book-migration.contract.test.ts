import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("rule book migration", () => {
  it("[HR-1] moves each owner's quiet hours and important senders into the rule book and keeps the switch", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-rule-book-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === "rule_book");
    expect(sequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, sequence));
    database.pragma("foreign_keys = OFF");
    const owners = [
      {
        owner: "owner-a",
        agent: "agent-a",
        enabled: 1,
        quiet: '[{"days":[0,6],"start":"22:00","end":"07:30"}]',
        senders: '["bank.example","a@b.com","会社.jp"]',
      },
      { owner: "owner-b", agent: "agent-b", enabled: 0, quiet: "[]", senders: "[]" },
    ];
    for (const { owner, agent, enabled, quiet, senders } of owners) {
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(owner);
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(agent, owner);
      database
        .prepare(
          "INSERT INTO proactive_settings (owner_id, agent_id, enabled, quiet_hours, important_senders, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(owner, agent, enabled, quiet, senders, T0);
    }
    database.pragma("foreign_keys = ON");
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    const settings = database
      .prepare(
        "SELECT owner_id AS ownerId, agent_id AS agentId, enabled, updated_at AS updatedAt FROM proactive_settings ORDER BY owner_id",
      )
      .all();
    expect(settings).toEqual([
      { ownerId: "owner-a", agentId: "agent-a", enabled: 1, updatedAt: T0 },
      { ownerId: "owner-b", agentId: "agent-b", enabled: 0, updatedAt: T0 },
    ]);
    const columns = database.pragma("table_info(proactive_settings)") as { name: string }[];
    expect(columns.map(({ name }) => name)).toEqual([
      "owner_id",
      "agent_id",
      "enabled",
      "updated_at",
    ]);

    const rules = database
      .prepare(
        "SELECT owner_id AS ownerId, rule_id AS ruleId, revision, parameters, status, source FROM rule_book_rules ORDER BY owner_id, rule_id",
      )
      .all() as {
      ownerId: string;
      ruleId: string;
      revision: number;
      parameters: string;
      status: string;
      source: string;
    }[];
    expect(
      rules.map(({ ownerId, ruleId, revision, status }) => [ownerId, ruleId, revision, status]),
    ).toEqual([
      ["owner-a", "floor_important_sender", 1, "active"],
      ["owner-a", "quiet_hours", 1, "active"],
      ["owner-b", "floor_important_sender", 1, "active"],
      ["owner-b", "quiet_hours", 1, "active"],
    ]);
    expect(rules.map(({ parameters }) => JSON.parse(parameters))).toEqual([
      { senders: ["bank.example", "a@b.com", "会社.jp"] },
      { periods: [{ days: [0, 6], start: "22:00", end: "07:30" }] },
      { senders: [] },
      { periods: [] },
    ]);
    expect(rules.every(({ source }) => source.length > 0)).toBe(true);
    const history = database
      .prepare(
        "SELECT owner_id AS ownerId, rule_id AS ruleId, revision, parameters FROM rule_book_history ORDER BY owner_id, rule_id, revision",
      )
      .all();
    expect(history).toEqual(
      rules.map(({ ownerId, ruleId, revision, parameters }) => ({
        ownerId,
        ruleId,
        revision,
        parameters,
      })),
    );
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

    expect(() =>
      database
        .prepare("UPDATE rule_book_history SET parameters = '{}' WHERE owner_id = 'owner-a'")
        .run(),
    ).toThrow(/RULE_BOOK_HISTORY_IMMUTABLE/u);
    expect(() =>
      database.prepare("DELETE FROM rule_book_history WHERE owner_id = 'owner-a'").run(),
    ).toThrow(/RULE_BOOK_HISTORY_IMMUTABLE/u);
    database
      .prepare(
        "UPDATE rule_book_rules SET revision = 2, parameters = '{\"senders\":[]}', updated_at = ? WHERE owner_id = 'owner-a' AND rule_id = 'floor_important_sender'",
      )
      .run(T1);
    expect(() =>
      database
        .prepare(
          "INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at) VALUES ('owner-a','agent-a','x',0,'{}','active','s',?)",
        )
        .run(T1),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          "INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at) VALUES ('owner-a','agent-a','y',1,'[]','active','s',?)",
        )
        .run(T1),
    ).toThrow();

    database.prepare("DELETE FROM owners WHERE id = 'owner-a'").run();
    expect(
      database
        .prepare("SELECT COUNT(*) FROM rule_book_rules WHERE owner_id = 'owner-a'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM rule_book_history WHERE owner_id = 'owner-a'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM rule_book_history WHERE owner_id = 'owner-b'")
        .pluck()
        .get(),
    ).toBe(2);
    database.close();
  });
});
