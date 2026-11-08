import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MuseIntakeItemWrite } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../scripts/calibration-report/report.mjs";

const OWNER_ID = createOwnerId("owner-muse");
const AGENT_ID = createAgentId("agent-muse");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = new Date("2026-11-02T03:00:00.000Z");
const IN_WINDOW = "2026-10-29T03:00:00.000Z";
const GMAIL_ID = "1a1b53d1b88e9acc";

function item(naturalKey: string, gmailMessageId: string | null): MuseIntakeItemWrite {
  return {
    kind: "proactive",
    naturalKey,
    state: "delivered",
    reasonCode: null,
    decision: "send",
    reasonEnum: "changed",
    priority: "regular",
    occurredAt: IN_WINDOW,
    scheduledFor: null,
    startedAt: null,
    preparedAt: IN_WINDOW,
    handoffAcceptedAt: IN_WINDOW,
    eventAt: IN_WINDOW,
    titleRef: `title-${naturalKey}`,
    textRef: `text-${naturalKey}`,
    textWithheld: false,
    options: ["ok"],
    gmailMessageId,
    sources: { occurred_at: "system_record", text: "chat_record" },
    contentDigest: `digest-${naturalKey}`,
  };
}

describe("[P0-9] Muse items paired by Gmail message id in the calibration report", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-muse-pairing-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const key of ["with-id", "without-id"])
      for (const prefix of ["title", "text"])
        insertPayload.run(
          `${prefix}-${key}`,
          OWNER_ID,
          AGENT_ID,
          `sha256:${prefix}-${key}`,
          IN_WINDOW,
        );
    database
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, reason_code, inputs,
          cost_micros, duration_ms
        ) VALUES ('gmail-check', ?, ?, 'proactive', 'gmail', ?, '{}', 'pushed', 'fixture', '{}', 0, 0)`,
      )
      .run(OWNER_ID, AGENT_ID, IN_WINDOW);
    database
      .prepare(
        `INSERT INTO proactive_processed_messages (
          owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, processed_at,
          owner_rating
        ) VALUES (?, ?, 'gmail', ?, 'thread-1', 'gmail-check', 'act', ?, 'useful')`,
      )
      .run(OWNER_ID, AGENT_ID, GMAIL_ID, IN_WINDOW);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => IN_WINDOW,
    });
    return { stateRoot, databasePath, repository };
  }

  it("puts the item that names a Gmail message into that mail's bucket, counts the other as unpaired, and shows the pairing rate", async () => {
    const { stateRoot, databasePath, repository } = await fixture();
    try {
      const intake = repository.museIntake();
      const outcome = await intake.ingestBatch({
        ...scope,
        batchId: "batch-1",
        senderId: "muse",
        batchSeq: 1,
        sentAt: IN_WINDOW,
        receivedAt: IN_WINDOW,
        rejectedCount: 0,
        droppedFieldCount: 0,
        items: [item("with-id", GMAIL_ID), item("without-id", null)],
      });
      expect(outcome).toMatchObject({ status: "accepted", accepted: 2 });
      for (const naturalKey of ["with-id", "without-id"])
        await intake.rate({
          ...scope,
          kind: "proactive",
          naturalKey,
          timingOk: true,
          contentOk: true,
          entryId: `rating-${naturalKey}`,
          now: IN_WINDOW,
        });
    } finally {
      await repository.close();
    }

    const chunks: string[] = [];
    const result = run(
      [`--db=${databasePath}`, "--end=2026-11-02", "--min-samples=1", "--no-record"],
      { now: NOW, output: { write: (chunk: string) => chunks.push(chunk) > 0 }, root: stateRoot },
    );
    expect(result.muse).toMatchObject({
      entries: 2,
      reminded: 2,
      unpaired: 1,
      pairedMails: 1,
      buckets: { both: 1, museOnly: 0, himawariOnly: 0, noHimawariRecord: 0 },
      himawariRatingsOnPairedMails: { useful: 1, unneeded: 0, missed: 0, unrated: 0 },
    });
    expect(chunks.join("")).toContain("配对率（条目里写明了对应邮件的占比）：50.0%（1/2，");
  });
});
