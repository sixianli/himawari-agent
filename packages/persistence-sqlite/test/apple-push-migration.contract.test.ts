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
const OWNER = "owner-apple-push-migration";
const AGENT = "agent-apple-push-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("apple push migration", () => {
  it("[IOS-4] keeps every web push attempt and feedback row, marks them as web push, and adds the Apple push tables", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-apple-push-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === "apple_push");
    expect(sequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, sequence));
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT, OWNER);
    const insertOutbox = database.prepare(
      `INSERT INTO web_push_outbox (
        owner_id, agent_id, source_key, kind, source_ref, thread_id, created_at, expires_at
      ) VALUES (?, ?, ?, 'reminder', ?, NULL, ?, ?)`,
    );
    insertOutbox.run(OWNER, AGENT, "reminder:r1", "r1", T0, T1);
    insertOutbox.run(OWNER, AGENT, "reminder:r2", "r2", T0, T1);
    const insertAttempt = database.prepare(
      `INSERT INTO web_push_attempts (
        owner_id, agent_id, source_key, subscription_id, status, attempts, next_attempt_at,
        last_code, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAttempt.run(OWNER, AGENT, "reminder:r1", "sub-1", "sent", 1, null, null, T0);
    insertAttempt.run(OWNER, AGENT, "reminder:r1", "sub-2", "pending", 2, T1, "PUSH_503", T0);
    insertAttempt.run(OWNER, AGENT, "reminder:r2", "sub-1", "gone", 1, null, "PUSH_410", T0);
    database
      .prepare(
        `INSERT INTO web_push_feedback (
          owner_id, agent_id, source_key, tag, kind, source_ref, thread_id, channel,
          first_sent_at, devices, opened_at, dismissed_at, updated_at
        ) VALUES (?, ?, 'reminder:r1', 'tag-r1', 'reminder', 'r1', NULL, 'web_push', ?, 2, ?, NULL, ?)`,
      )
      .run(OWNER, AGENT, T0, T1, T1);
    const attemptsBefore = database
      .prepare(
        `SELECT owner_id, agent_id, source_key, subscription_id, status, attempts,
           next_attempt_at, last_code, updated_at
         FROM web_push_attempts ORDER BY source_key, subscription_id`,
      )
      .all();
    const feedbackBefore = database.prepare("SELECT * FROM web_push_feedback").all();
    expect(() =>
      database
        .prepare("UPDATE web_push_feedback SET channel = 'apns' WHERE source_key = 'reminder:r1'")
        .run(),
    ).toThrow();

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations.slice(0, sequence + 1), { snapshot });

    expect(
      database
        .prepare(
          `SELECT owner_id, agent_id, source_key, subscription_id, status, attempts,
             next_attempt_at, last_code, updated_at
           FROM web_push_attempts ORDER BY source_key, subscription_id`,
        )
        .all(),
    ).toEqual(attemptsBefore);
    expect(
      database
        .prepare("SELECT DISTINCT channel, push_type AS pushType FROM web_push_attempts")
        .all(),
    ).toEqual([{ channel: "web_push", pushType: null }]);
    expect(database.prepare("SELECT * FROM web_push_feedback").all()).toEqual(feedbackBefore);
    expect(database.prepare("SELECT DISTINCT channel FROM web_push_outbox").pluck().all()).toEqual([
      null,
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'web_push_feedback' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual(["web_push_feedback_sent_index", "web_push_feedback_tag_index"]);
    expect(database.pragma("foreign_key_check")).toEqual([]);

    database
      .prepare("UPDATE web_push_feedback SET channel = 'apns' WHERE source_key = 'reminder:r1'")
      .run();
    expect(() =>
      insertAttempt.run(OWNER, AGENT, "reminder:r2", "sub-2", "sent", 1, null, null, T0),
    ).toThrow();
    database
      .prepare(
        `INSERT INTO web_push_attempts (
          owner_id, agent_id, source_key, channel, push_type, subscription_id, status, attempts,
          next_attempt_at, last_code, updated_at
        ) VALUES (?, ?, 'reminder:r2', 'apns', 'alert', 'sub-1', 'sent', 1, NULL, NULL, ?)`,
      )
      .run(OWNER, AGENT, T0);
    expect(() =>
      database
        .prepare(
          `INSERT INTO web_push_attempts (
            owner_id, agent_id, source_key, channel, push_type, subscription_id, status, attempts,
            next_attempt_at, last_code, updated_at
          ) VALUES (?, ?, 'reminder:r2', 'apns', NULL, 'sub-9', 'sent', 1, NULL, NULL, ?)`,
        )
        .run(OWNER, AGENT, T0),
    ).toThrow();
    expect(() =>
      database
        .prepare("UPDATE web_push_outbox SET channel = 'sms' WHERE source_key = 'reminder:r1'")
        .run(),
    ).toThrow();
    database.prepare("DELETE FROM web_push_outbox WHERE source_key = 'reminder:r2'").run();
    expect(
      database
        .prepare("SELECT count(*) FROM web_push_attempts WHERE source_key = 'reminder:r2'")
        .pluck()
        .get(),
    ).toBe(0);
    for (const table of ["apns_registrations", "notification_action_tokens"])
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    expect(
      database
        .prepare(
          "SELECT count(*) FROM pragma_table_info('paired_devices') WHERE name = 'companion_of'",
        )
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });
});
