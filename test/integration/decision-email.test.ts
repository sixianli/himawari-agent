import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProactiveSeal, type MuseIntakeItemWrite } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type GatewayV2Query,
  GMAIL_MESSAGE_ID_PATTERN,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionObservation } from "../../apps/agent-service/src/production-observation.ts";
import { fixture as contractFixture } from "../../packages/gateway-contracts/test/gateway-v2.fixture.ts";
import { GMAIL_MESSAGE_ID } from "../../packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts";

const OWNER_ID = createOwnerId("owner-email");
const OTHER_OWNER_ID = createOwnerId("owner-other");
const AGENT_ID = createAgentId("agent-email");
const OTHER_AGENT_ID = createAgentId("agent-other");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const AT = "2026-10-29T03:00:00.000Z";
const LONG_ID = `_${"a".repeat(255)}`;

interface Mail {
  readonly key: string;
  readonly gmailId: string;
  readonly processed: boolean;
  readonly outcome: "act" | "know" | "check" | "ignore" | "skipped";
  readonly skipReason?: "category";
  readonly rating: "useful" | "unneeded" | "missed" | null;
  readonly inputs: Record<string, unknown>;
  readonly muse: "none" | "reminded" | "withheld";
}

const MAILS: readonly Mail[] = [
  {
    key: "both",
    gmailId: "mail-both",
    processed: true,
    outcome: "act",
    rating: "useful",
    inputs: {
      ruleIds: ["floor.money"],
      floorHits: {
        "mail-both": ["floor.money", "floor.money", "rule\nwith\tcontrol"],
        "other-mail": ["floor.other"],
      },
      memoryByMail: { "mail-both": ["memory-b", "memory-a", "_memory-c"] },
      relatedByMail: { "mail-both": ["thread-x", "thread-y"] },
    },
    muse: "reminded",
  },
  {
    key: "muse-only",
    gmailId: "mail-muse-only",
    processed: true,
    outcome: "ignore",
    rating: "missed",
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
    muse: "reminded",
  },
  {
    key: "himawari-only",
    gmailId: "mail-himawari-only",
    processed: true,
    outcome: "check",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
    muse: "none",
  },
  {
    key: "legacy",
    gmailId: "mail-legacy",
    processed: true,
    outcome: "know",
    rating: null,
    inputs: {},
    muse: "none",
  },
  {
    key: "skipped",
    gmailId: "mail-skipped",
    processed: true,
    outcome: "skipped",
    skipReason: "category",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
    muse: "none",
  },
  {
    key: "long",
    gmailId: LONG_ID,
    processed: true,
    outcome: "act",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
    muse: "none",
  },
  {
    key: "withheld",
    gmailId: "mail-withheld",
    processed: true,
    outcome: "act",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
    muse: "withheld",
  },
  {
    key: "muse-no-record",
    gmailId: "mail-muse-no-record",
    processed: false,
    outcome: "ignore",
    rating: null,
    inputs: {},
    muse: "reminded",
  },
];

function intakeItem(
  mail: Mail,
  titleRef: string,
  textRef: string,
  withheld: boolean,
): MuseIntakeItemWrite {
  return {
    kind: "proactive",
    naturalKey: mail.key,
    state: "delivered",
    reasonCode: null,
    decision: "send",
    reasonEnum: "changed",
    priority: "regular",
    occurredAt: AT,
    scheduledFor: null,
    startedAt: null,
    preparedAt: AT,
    handoffAcceptedAt: AT,
    eventAt: AT,
    titleRef,
    textRef,
    textWithheld: withheld,
    options: [],
    gmailMessageId: mail.gmailId,
    sources: { occurred_at: "system_record", text: "chat_record" },
    contentDigest: `digest-${mail.key}`,
  };
}

describe("[P1-5] one mail's decision trace", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-email-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    for (const [owner, agent] of [
      [OWNER_ID, AGENT_ID],
      [OTHER_OWNER_ID, OTHER_AGENT_ID],
    ] as const) {
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(owner);
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(agent, owner);
    }
    for (const mail of MAILS.filter((entry) => entry.processed)) {
      const decisionId = `decision-${mail.key}`;
      database
        .prepare(
          `INSERT INTO decision_ledger (
            id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, reason_code,
            inputs, cost_micros, duration_ms
          ) VALUES (?, ?, ?, 'proactive', 'gmail', ?, '{}', 'pushed', 'fixture', ?, 0, 0)`,
        )
        .run(decisionId, OWNER_ID, AGENT_ID, AT, JSON.stringify(mail.inputs));
      database
        .prepare(
          `INSERT INTO proactive_processed_messages (
            owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason,
            processed_at, owner_rating
          ) VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          OWNER_ID,
          AGENT_ID,
          mail.gmailId,
          `thread-${mail.key}`,
          decisionId,
          mail.outcome,
          mail.skipReason ?? null,
          AT,
          mail.rating,
        );
    }
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => AT,
    });
    const seal = createProactiveSeal({
      payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: new DeterministicPayloadProtector(),
      ids: new DeterministicIdGenerator(),
    });
    const intake = repository.museIntake();
    let seq = 0;
    for (const mail of MAILS.filter((entry) => entry.muse !== "none")) {
      seq += 1;
      const titleRef = await seal.seal({ ...scope, text: `Muse title ${mail.key}`, at: AT });
      const textRef = await seal.seal({ ...scope, text: `Muse text ${mail.key}`, at: AT });
      await intake.ingestBatch({
        ...scope,
        batchId: `batch-${seq}`,
        senderId: "muse",
        batchSeq: seq,
        sentAt: AT,
        receivedAt: AT,
        rejectedCount: 0,
        droppedFieldCount: 0,
        items: [intakeItem(mail, titleRef, textRef, mail.muse === "withheld")],
      });
      await intake.rate({
        ...scope,
        kind: "proactive",
        naturalKey: mail.key,
        timingOk: true,
        contentOk: true,
        entryId: `rating-${mail.key}`,
        now: AT,
      });
    }
    const observation = (own: typeof scope = scope) =>
      new ProductionObservation({
        scope: own,
        observation: repository.ledgerObservation(),
        ledger: repository.decisionLedger(),
        seal,
        clock: new ManualClock(AT),
        schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
        serviceRevision: "test",
      });
    return { repository, observation, seal, intake };
  }

  const query = (messageId: string) =>
    contractFixture("query", "decision.email.read", { messageId }) as unknown as GatewayV2Query;

  async function read(
    h: Awaited<ReturnType<typeof fixture>>,
    messageId: string,
    own: typeof scope = scope,
  ) {
    const snapshot = await h.observation(own).query(query(messageId));
    if (snapshot.type !== "decision.email.snapshot") throw new Error("snapshot");
    return snapshot.payload;
  }

  it("resolves a Gmail mail id to its judgment, rules, memories and the Muse entry", async () => {
    const h = await fixture();
    try {
      const payload = await read(h, "mail-both");
      expect(payload.mail).toMatchObject({
        decisionId: "decision-both",
        threadId: "thread-both",
        outcome: "act",
        skipReason: null,
        rating: "useful",
        ruleIds: ["floor.money", "rule with control"],
        memoryIds: ["_memory-c", "memory-a", "memory-b"],
        relatedMessages: 2,
      });
      expect(payload.muse.entries).toHaveLength(1);
      expect(payload.muse.entries[0]).toMatchObject({
        reminded: true,
        kind: "proactive",
        title: "Muse title both",
        text: "Muse text both",
        textWithheld: false,
        timingOk: true,
        contentOk: true,
      });
      expect(payload.comparison).toBe("both");
    } finally {
      await h.repository.close();
    }
  });

  it("[negative] reports truncation only when there are more than 20 Muse entries", async () => {
    const h = await fixture();
    try {
      let sequence = 100;
      const ingest = async (count: number, gmailId: string) => {
        for (let index = 0; index < count; index += 1) {
          const mail = { ...MAILS[0], key: `${gmailId}-${index}`, gmailId } as Mail;
          const titleRef = await h.seal.seal({ ...scope, text: `title ${index}`, at: AT });
          const textRef = await h.seal.seal({ ...scope, text: `text ${index}`, at: AT });
          await h.intake.ingestBatch({
            ...scope,
            batchId: `batch-${gmailId}-${index}`,
            senderId: "muse",
            batchSeq: sequence + index,
            sentAt: AT,
            receivedAt: AT,
            rejectedCount: 0,
            droppedFieldCount: 0,
            items: [intakeItem(mail, titleRef, textRef, false)],
          });
          await h.intake.rate({
            ...scope,
            kind: "proactive",
            naturalKey: mail.key,
            timingOk: true,
            contentOk: true,
            entryId: `rating-${mail.key}`,
            now: AT,
          });
        }
      };
      await ingest(20, "mail-twenty");
      sequence += 100;
      await ingest(21, "mail-twentyone");
      const twenty = await read(h, "mail-twenty");
      expect(twenty.muse.entries).toHaveLength(20);
      expect(twenty.muse.truncated).toBe(false);
      const over = await read(h, "mail-twentyone");
      expect(over.muse.entries).toHaveLength(20);
      expect(over.muse.truncated).toBe(true);
    } finally {
      await h.repository.close();
    }
  });

  it("[negative] judges the comparison from every Muse entry, not only the 20 shown", async () => {
    const h = await fixture();
    try {
      const contentRef = await h.seal.seal({ ...scope, text: "late", at: AT });
      const write = (index: number) => {
        const base = {
          id: `late-${index}`,
          ...scope,
          museAt: `2026-10-29T03:${String(index).padStart(2, "0")}:00.000Z`,
          noteRef: null,
          pairedDecisionId: null,
          pairedMessageId: "mail-himawari-only",
          recordedAt: AT,
        };
        return h.repository
          .decisionLedger()
          .recordMuse(
            index === 20
              ? { ...base, museReminded: true, timingOk: true, contentOk: true, contentRef }
              : { ...base, museReminded: false },
          );
      };
      for (let index = 0; index < 21; index += 1) await write(index);
      const payload = await read(h, "mail-himawari-only");
      expect(payload.muse.entries).toHaveLength(20);
      expect(payload.muse.truncated).toBe(true);
      expect(payload.comparison).toBe("both");
    } finally {
      await h.repository.close();
    }
  });

  it("uses the same comparison words as the weekly report buckets", async () => {
    const h = await fixture();
    try {
      expect((await read(h, "mail-muse-only")).comparison).toBe("museOnly");
      expect((await read(h, "mail-himawari-only")).comparison).toBe("noMuseEntry");
      expect((await read(h, "mail-skipped")).comparison).toBe("noMuseEntry");
      expect((await read(h, "mail-muse-no-record")).comparison).toBe("noHimawariRecord");
    } finally {
      await h.repository.close();
    }
  });

  it("shows a skipped mail with its reason and a record without inputs as not recorded", async () => {
    const h = await fixture();
    try {
      const skipped = await read(h, "mail-skipped");
      expect(skipped.mail).toMatchObject({ outcome: "skipped", skipReason: "category" });
      const legacy = await read(h, "mail-legacy");
      expect(legacy.mail).toMatchObject({
        ruleIds: null,
        memoryIds: null,
        relatedMessages: null,
      });
    } finally {
      await h.repository.close();
    }
  });

  it("[negative] an unknown mail id, another owner's mail and a withheld Muse text show nothing", async () => {
    const h = await fixture();
    try {
      const unknown = await read(h, "mail-does-not-exist");
      expect(unknown.mail).toBeNull();
      expect(unknown.muse.entries).toEqual([]);
      expect(unknown.comparison).toBe("noHimawariRecord");
      const foreign = await read(h, "mail-both", {
        ownerId: OTHER_OWNER_ID,
        agentId: OTHER_AGENT_ID,
      });
      expect(foreign.mail).toBeNull();
      expect(foreign.muse.entries).toEqual([]);
      const withheld = await read(h, "mail-withheld");
      expect(withheld.muse.entries[0]).toMatchObject({
        title: null,
        text: null,
        textWithheld: true,
      });
      expect(JSON.stringify(withheld)).not.toContain("Muse text withheld");
    } finally {
      await h.repository.close();
    }
  });

  it("[negative] the contract and the storage layer accept exactly the same mail ids", () => {
    expect(GMAIL_MESSAGE_ID_PATTERN.source).toBe(GMAIL_MESSAGE_ID.source);
    expect(GMAIL_MESSAGE_ID_PATTERN.flags).toBe(GMAIL_MESSAGE_ID.flags);
  });

  it("accepts a 256 character mail id that starts with an underscore, and rejects 257", async () => {
    const h = await fixture();
    try {
      expect((await read(h, LONG_ID)).mail?.decisionId).toBe("decision-long");
      expect(() => gatewayV2MessageSchema.parse(query(LONG_ID))).not.toThrow();
      expect(() => gatewayV2MessageSchema.parse(query(`${LONG_ID}a`))).toThrow();
      expect(() => gatewayV2MessageSchema.parse(query("mail id with space"))).toThrow();
    } finally {
      await h.repository.close();
    }
  });
});
