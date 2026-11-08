import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProactiveSeal, type MuseIntakeItemWrite } from "@himawari-agent/application";
import { summarizeGap } from "@himawari-agent/calibration";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { DeterministicIdGenerator, DeterministicPayloadProtector } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildGapCases } from "../../apps/agent-service/src/production-gap-cases.ts";
import { run } from "../../scripts/calibration-report/report.mjs";

const OWNER_ID = createOwnerId("owner-gap");
const AGENT_ID = createAgentId("agent-gap");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = new Date("2026-11-02T03:00:00.000Z");
const IN_WINDOW = "2026-10-29T03:00:00.000Z";
const START = "2026-10-26T15:00:00.000Z";
const END = "2026-11-02T15:00:00.000Z";

type Mail = {
  readonly key: string;
  readonly gmailId: string;
  readonly outcome: "act" | "ignore";
  readonly rating: "useful" | "unneeded" | "missed" | null;
  readonly timingOk: boolean;
  readonly contentOk: boolean;
  readonly inputs: Record<string, unknown>;
};

const MAILS: readonly Mail[] = [
  {
    key: "missed-not-remembered",
    gmailId: "mail-1",
    outcome: "ignore",
    rating: "missed",
    timingOk: true,
    contentOk: true,
    inputs: { memoryRecall: "ok", memoryByMail: { "mail-1": [] }, relatedRead: "ok" },
  },
  {
    key: "muse-right-not-read",
    gmailId: "mail-2",
    outcome: "ignore",
    rating: null,
    timingOk: true,
    contentOk: true,
    inputs: { memoryRecall: "ok", memoryByMail: { "mail-2": ["m"] }, relatedRead: "partial" },
  },
  {
    key: "both-reminded",
    gmailId: "mail-3",
    outcome: "act",
    rating: "useful",
    timingOk: true,
    contentOk: true,
    inputs: { memoryRecall: "ok", memoryByMail: {}, relatedRead: "ok" },
  },
  {
    key: "muse-wrong",
    gmailId: "mail-4",
    outcome: "ignore",
    rating: "useful",
    timingOk: false,
    contentOk: true,
    inputs: { memoryRecall: "ok", memoryByMail: {}, relatedRead: "ok" },
  },
];

function item(mail: Mail, titleRef: string, textRef: string): MuseIntakeItemWrite {
  return {
    kind: "proactive",
    naturalKey: mail.key,
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
    titleRef,
    textRef,
    textWithheld: false,
    options: [],
    gmailMessageId: mail.gmailId,
    sources: { occurred_at: "system_record", text: "chat_record" },
    contentDigest: `digest-${mail.key}`,
  };
}

describe("[PA-4] Muse gap cases", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-gap-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const mail of MAILS) {
      const decisionId = `decision-${mail.key}`;
      database
        .prepare(
          `INSERT INTO decision_ledger (
            id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, reason_code,
            inputs, cost_micros, duration_ms
          ) VALUES (?, ?, ?, 'proactive', 'gmail', ?, '{}', 'pushed', 'fixture', ?, 0, 0)`,
        )
        .run(decisionId, OWNER_ID, AGENT_ID, IN_WINDOW, JSON.stringify(mail.inputs));
      database
        .prepare(
          `INSERT INTO proactive_processed_messages (
            owner_id, agent_id, source, message_id, thread_id, decision_id, outcome,
            processed_at, owner_rating
          ) VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          OWNER_ID,
          AGENT_ID,
          mail.gmailId,
          `thread-${mail.key}`,
          decisionId,
          mail.outcome,
          IN_WINDOW,
          mail.rating,
        );
    }
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => IN_WINDOW,
    });
    const seal = createProactiveSeal({
      payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: new DeterministicPayloadProtector(),
      ids: new DeterministicIdGenerator(),
    });
    const intake = repository.museIntake();
    let seq = 0;
    for (const mail of MAILS) {
      seq += 1;
      const titleRef = await seal.seal({ ...scope, text: `Muse title ${mail.key}`, at: IN_WINDOW });
      const textRef = await seal.seal({ ...scope, text: `Muse text ${mail.key}`, at: IN_WINDOW });
      await intake.ingestBatch({
        ...scope,
        batchId: `batch-${seq}`,
        senderId: "muse",
        batchSeq: seq,
        sentAt: IN_WINDOW,
        receivedAt: IN_WINDOW,
        rejectedCount: 0,
        droppedFieldCount: 0,
        items: [item(mail, titleRef, textRef)],
      });
      await intake.rate({
        ...scope,
        kind: "proactive",
        naturalKey: mail.key,
        timingOk: mail.timingOk,
        contentOk: mail.contentOk,
        entryId: `rating-${mail.key}`,
        now: IN_WINDOW,
      });
    }
    return { stateRoot, databasePath, repository, seal };
  }

  it("lists only mails Muse got right and Himawari stayed silent on, with the reason for each", async () => {
    const { repository, seal } = await fixture();
    try {
      const candidates = await repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      expect(candidates).toHaveLength(MAILS.length);
      const cases = await buildGapCases({ scope, candidates, seal });
      expect(cases.map((entry) => entry.museTitle).sort()).toEqual([
        "Muse title missed-not-remembered",
        "Muse title muse-right-not-read",
      ]);
      const byTitle = new Map(cases.map((entry) => [entry.museTitle, entry]));
      expect(byTitle.get("Muse title missed-not-remembered")).toMatchObject({
        attribution: "notRemembered",
        museText: "Muse text missed-not-remembered",
        himawariOutcome: "ignore",
        ownerRating: "missed",
      });
      expect(byTitle.get("Muse title muse-right-not-read")?.attribution).toBe("notReadFully");
      for (const entry of cases) expect(entry.id).toMatch(/^gap_[0-9a-f]{20}$/u);
      expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
      const again = await buildGapCases({ scope, candidates, seal });
      expect(again.map((entry) => entry.id)).toEqual(cases.map((entry) => entry.id));
    } finally {
      await repository.close();
    }
  });

  it("[negative] gives no cases when the window holds none, and no text without a seal", async () => {
    const { repository, seal } = await fixture();
    try {
      const none = await repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: "2026-09-01T00:00:00.000Z", end: START });
      expect(none).toEqual([]);
      expect(await buildGapCases({ scope, candidates: none, seal })).toEqual([]);
      const candidates = await repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      const sealed = await buildGapCases({ scope, candidates, seal: undefined });
      expect(sealed.every((entry) => entry.museTitle === null && entry.museText === null)).toBe(
        true,
      );
    } finally {
      await repository.close();
    }
  });

  it("puts the gap lines into the Markdown report and says not enough samples instead of a verdict", async () => {
    const { stateRoot, databasePath, repository } = await fixture();
    await repository.close();
    const chunks: string[] = [];
    run([`--db=${databasePath}`, "--end=2026-11-02", "--no-record"], {
      now: NOW,
      output: { write: (chunk: string) => chunks.push(chunk) > 0 },
      root: stateRoot,
    });
    const report = chunks.join("");
    expect(report).toContain("## Muse 差距线");
    expect(report).toContain("样本不足");
    expect(report).not.toMatch(/追平|落后/u);
  });

  it("[negative] a decided line needs enough rated mails whose interval excludes zero", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      museReminded: true,
      timingOk: true,
      contentOk: true,
      pairedMessageId: `m${index}`,
    }));
    const judgments = new Map(
      entries.map((entry) => [
        entry.pairedMessageId,
        { outcome: "ignore", ownerRating: "missed" as const },
      ]),
    );
    const gap = summarizeGap(entries, judgments, 5);
    expect(gap.lines[0].verdict).toBe("decided");
    expect(gap.lines[1].verdict).toBe("insufficient");
  });
});
