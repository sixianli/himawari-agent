import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { type GatewayV2Query, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionObservation } from "../../apps/agent-service/src/production-observation.ts";
import { fixture as contractFixture } from "../../packages/gateway-contracts/test/gateway-v2.fixture.ts";

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
      ruleHits: {
        "mail-both": ["suppress_small_amount@3"],
        "other-mail": ["suppress_other@1"],
      },
      memoryByMail: { "mail-both": ["memory-b", "memory-a", "_memory-c", "memory\nctl"] },
      relatedByMail: { "mail-both": ["thread-x", "thread-y"] },
    },
  },

  {
    key: "himawari-only",
    gmailId: "mail-himawari-only",
    processed: true,
    outcome: "check",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
  },
  {
    key: "prototype-key",
    gmailId: "__proto__",
    processed: true,
    outcome: "know",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
  },
  {
    key: "legacy",
    gmailId: "mail-legacy",
    processed: true,
    outcome: "know",
    rating: null,
    inputs: {},
  },
  {
    key: "skipped",
    gmailId: "mail-skipped",
    processed: true,
    outcome: "skipped",
    skipReason: "category",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
  },
  {
    key: "long",
    gmailId: LONG_ID,
    processed: true,
    outcome: "act",
    rating: null,
    inputs: { floorHits: {}, memoryByMail: {}, relatedByMail: {} },
  },
];

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
    const observation = (own: typeof scope = scope) =>
      new ProductionObservation({
        scope: own,
        observation: repository.ledgerObservation(),
        ledger: repository.decisionLedger(),
        clock: new ManualClock(AT),
        schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
        serviceRevision: "test",
      });
    return { repository, observation };
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

  it("resolves a Gmail mail id to its judgment, rules and memories", async () => {
    const h = await fixture();
    try {
      const payload = await read(h, "mail-both");
      expect(payload.mail).toMatchObject({
        decisionId: "decision-both",
        threadId: "thread-both",
        outcome: "act",
        skipReason: null,
        rating: "useful",
        ruleIds: ["floor.money", "rule with control", "suppress_small_amount"],
        memoryIds: ["_memory-c", "memory ctl", "memory-a", "memory-b"],
        relatedMessages: 2,
      });
    } finally {
      await h.repository.close();
    }
  });

  it("[negative] treats a mail id like __proto__ as having no recorded rules", async () => {
    const h = await fixture();
    try {
      const payload = await read(h, "__proto__");
      expect(payload.mail).toMatchObject({ ruleIds: [], memoryIds: [], relatedMessages: 0 });
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

  it("[negative] an unknown mail id and another owner's mail show nothing", async () => {
    const h = await fixture();
    try {
      const unknown = await read(h, "mail-does-not-exist");
      expect(unknown.mail).toBeNull();
      expect(unknown).not.toHaveProperty("muse");
      const foreign = await read(h, "mail-both", {
        ownerId: OTHER_OWNER_ID,
        agentId: OTHER_AGENT_ID,
      });
      expect(foreign.mail).toBeNull();
    } finally {
      await h.repository.close();
    }
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
