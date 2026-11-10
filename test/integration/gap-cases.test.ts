import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProactiveSeal, type MuseIntakeItemWrite } from "@himawari-agent/application";
import { summarizeGap } from "@himawari-agent/calibration";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import type { GatewayV2Command } from "@himawari-agent/gateway-contracts";
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
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildGapCases, gapCaseId } from "../../apps/agent-service/src/production-gap-cases.ts";
import {
  GAP_EXPORT_PATH,
  gapBacklogPrefill,
  maskForExport,
  ProductionGapExport,
  registerGapExportRoute,
} from "../../apps/agent-service/src/production-gap-export.ts";
import { ProductionObservation } from "../../apps/agent-service/src/production-observation.ts";
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
    key: "secret-title",
    gmailId: "mail-5",
    outcome: "ignore",
    rating: "missed",
    timingOk: true,
    contentOk: true,
    inputs: { memoryRecall: "ok", memoryByMail: { "mail-5": ["m"] }, relatedRead: "ok" },
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

const CARD_PREFIX = 285;
const LONG_CARD_MAIL: Mail = {
  key: "long-card",
  gmailId: "mail-6",
  outcome: "ignore",
  rating: "missed",
  timingOk: true,
  contentOk: true,
  inputs: { memoryRecall: "ok", memoryByMail: { "mail-6": ["m"] }, relatedRead: "ok" },
};

function titleFor(mail: Mail): string {
  if (mail.key === "secret-title") return "密码：hunter22222 到期";
  if (mail.key === "long-card")
    return `${"甲".repeat(CARD_PREFIX)}银行卡号 4111 1111 1111 1111 请核对`;
  return `Muse title ${mail.key}`;
}

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

  async function fixture(mails: readonly Mail[] = MAILS) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-gap-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const mail of mails) {
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
    for (const mail of mails) {
      seq += 1;
      const titleRef = await seal.seal({
        ...scope,
        text: titleFor(mail),
        at: IN_WINDOW,
      });
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
        "密码：hunter22222 到期",
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

  async function wired(mails: readonly Mail[] = MAILS) {
    const base = await fixture(mails);
    const clock = new ManualClock("2026-11-02T03:00:00.000Z");
    const marks = base.repository.gapCaseMarks();
    const observation = new ProductionObservation({
      scope,
      observation: base.repository.ledgerObservation(),
      ledger: base.repository.decisionLedger(),
      marks,
      seal: base.seal,
      clock,
      schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
      serviceRevision: "test",
    });
    const mark = (caseId: string, marked: boolean) =>
      observation.execute({
        type: "proactive.gapcase.mark",
        payload: { caseId, endDay: "2026-11-03", marked },
      } as unknown as GatewayV2Command);
    const secret = "gap-export-secret-0123456789abcdef0123456789";
    const gapExport = new ProductionGapExport({
      scope,
      marks,
      seal: base.seal,
      clock,
      secret,
    });
    const app = Fastify();
    registerGapExportRoute(app, gapExport);
    const cases = async () => {
      const candidates = await base.repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      return buildGapCases({ scope, candidates, seal: base.seal });
    };
    return { ...base, mark, app, secret, cases, marks };
  }

  it("marks a case, shows it in the export with prefilled Backlog fields and a stable id, and removes it when unmarked", async () => {
    const h = await wired();
    try {
      const [first] = await h.cases();
      if (!first) throw new Error("no case");
      const auth = { authorization: `Bearer ${h.secret}` };
      const empty = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers: auth });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().cases).toEqual([]);
      expect(await h.mark(first.id, true)).toMatchObject({ replayed: false });
      expect(await h.mark(first.id, true)).toMatchObject({ replayed: true });
      const listed = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers: auth });
      const body = listed.json();
      expect(body.schema).toBe("himawari-gap-cases.v1");
      expect(body.cases).toHaveLength(1);
      expect(body.cases[0]).toMatchObject({ id: first.id, attribution: first.attribution });
      expect(body.cases[0].prefill.title).toContain("Muse title");
      expect(body.cases[0].prefill.summary).toContain("归因");
      expect(body.cases[0].prefill.origin).toContain(first.id);
      expect(body.cases[0].prefill.origin).toContain("至 2026-11-02）");
      expect(Object.keys(body.cases[0].prefill).sort()).toEqual([
        "origin",
        "summary",
        "title",
        "why",
      ]);
      expect((await h.cases()).map((entry) => entry.id)).toContain(first.id);
      const [markedRow] = await h.marks.list(scope);
      const snapshotRef = markedRow?.snapshotRef ?? "";
      expect(await h.repository.payloadStore(OWNER_ID, AGENT_ID).get(snapshotRef)).toBeDefined();
      await h.mark(first.id, false);
      expect(await h.repository.payloadStore(OWNER_ID, AGENT_ID).get(snapshotRef)).toBeUndefined();
      const after = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers: auth });
      expect(after.json().cases).toEqual([]);
      expect(await h.marks.list(scope)).toEqual([]);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] refuses an export request without the right token and cannot mark a case that does not exist", async () => {
    const h = await wired();
    try {
      for (const headers of [
        {},
        { authorization: "Bearer wrong" },
        { authorization: `Basic ${h.secret}` },
      ]) {
        const response = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers });
        expect(response.statusCode).toBe(401);
        expect(response.body).toBe("");
      }
      await expect(h.mark("gap_00000000000000000000", true)).rejects.toThrow("GAP_CASE_NOT_FOUND");
      expect(await h.marks.list(scope)).toEqual([]);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("masks passwords in the exported text while the owner's own page still shows the case", async () => {
    const h = await wired();
    try {
      const secretCase = (await h.cases()).find((entry) =>
        entry.museTitle?.includes("hunter22222"),
      );
      if (!secretCase) throw new Error("no secret case");
      await h.mark(secretCase.id, true);
      const auth = { authorization: `Bearer ${h.secret}` };
      const response = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers: auth });
      expect(response.body).not.toContain("hunter22222");
      expect(response.json().cases).toHaveLength(1);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("keeps the case id when the owner rates the same Muse entry again", async () => {
    const h = await wired();
    try {
      const before = (await h.cases()).map((entry) => entry.id).sort();
      const target = MAILS[0];
      if (!target) throw new Error("no mail");
      await h.repository.museIntake().rate({
        ...scope,
        kind: "proactive",
        naturalKey: target.key,
        timingOk: true,
        contentOk: true,
        entryId: "rating-again",
        now: IN_WINDOW,
      });
      expect((await h.cases()).map((entry) => entry.id).sort()).toEqual(before);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] gives a case no mail id when the paired id is not a Gmail message id", async () => {
    const h = await wired();
    try {
      const candidates = await h.repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      const first = candidates.find((candidate) => candidate.pairedMessageId === "mail-1");
      if (!first) throw new Error("no candidate");
      const built = await buildGapCases({
        scope,
        candidates: [{ ...first, pairedMessageId: "not a gmail id!" }, ...candidates],
        seal: h.seal,
      });
      expect(
        built.find((entry) => entry.id === gapCaseId("not a gmail id!"))?.messageId,
      ).toBeNull();
      expect(built.find((entry) => entry.id === gapCaseId("mail-1"))?.messageId).toBe("mail-1");
    } finally {
      await h.repository.close();
    }
  });

  it("[negative] turns several Muse entries about one mail into one case, and keeps long emoji text inside the contract length", async () => {
    const h = await wired();
    try {
      const candidates = await h.repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      const first = candidates.find((candidate) => candidate.pairedMessageId === "mail-1");
      if (!first) throw new Error("no candidate");
      const emojiRef = await h.seal.seal({ ...scope, text: "😀".repeat(400), at: IN_WINDOW });
      const duplicated = [
        { ...first, entryId: "another-entry", museTitleRef: emojiRef, museTextRef: emojiRef },
        ...candidates,
      ];
      const built = await buildGapCases({ scope, candidates: duplicated, seal: h.seal });
      expect(built.filter((entry) => entry.id === gapCaseId("mail-1"))).toHaveLength(1);
      expect(new Set(built.map((entry) => entry.id)).size).toBe(built.length);
      for (const entry of built) {
        expect(entry.museTitle?.length ?? 0).toBeLessThanOrEqual(300);
        expect(entry.museText?.length ?? 0).toBeLessThanOrEqual(500);
      }
      expect(built.some((entry) => entry.museTitle?.startsWith("😀"))).toBe(true);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("removes marked cases and their snapshots when the owner clears the Muse data", async () => {
    const h = await wired();
    try {
      const [first] = await h.cases();
      if (!first) throw new Error("no case");
      await h.mark(first.id, true);
      const [row] = await h.marks.list(scope);
      expect(row).toBeDefined();
      await h.repository.museIntake().clearAll(scope);
      expect(await h.marks.list(scope)).toEqual([]);
      expect(await h.repository.payloadStore(OWNER_ID, AGENT_ID).get(row?.snapshotRef ?? "")).toBe(
        undefined,
      );
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] one unreadable Muse payload leaves the page and the other cases working", async () => {
    const h = await wired();
    try {
      const candidates = await h.repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      const victim = candidates.find((candidate) => candidate.pairedMessageId === "mail-1");
      if (!victim?.museTitleRef) throw new Error("no victim");
      const brokenRef = victim.museTitleRef;
      const flaky = {
        ...h.seal,
        open: async (input: { ref: string } & typeof scope) => {
          if (input.ref === brokenRef) throw new Error("cannot decrypt");
          return h.seal.open(input);
        },
      } as typeof h.seal;
      const built = await buildGapCases({ scope, candidates, seal: flaky });
      expect(built).toHaveLength(3);
      expect(built.find((entry) => entry.id === gapCaseId("mail-1"))?.museTitle).toBeNull();
      expect(built.filter((entry) => entry.museTitle !== null)).toHaveLength(2);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] masks a password even when the cut would have split it", () => {
    const filler = "甲".repeat(100);
    const prefill = gapBacklogPrefill({
      id: "gap_aaaaaaaaaaaaaaaaaaaa",
      museAt: IN_WINDOW,
      museTitle: `${filler}密码：hunter22222`,
      museText: null,
      museTextWithheld: false,
      himawariOutcome: "ignore",
      himawariReasonCode: "fixture",
      himawariReason: null,
      ownerRating: "missed",
      attribution: "wrongJudgment",
      memoryHits: 0,
      relatedMessages: 0,
      decidedAt: IN_WINDOW,
      weekStart: START,
      weekEnd: END,
    });
    expect(prefill.title).not.toContain("hunter2");
    expect(prefill.summary).not.toContain("hunter22222");
  });

  it("deletes the snapshot together with the mark row when unmarking, with no later release needed", async () => {
    const h = await wired();
    try {
      const [first] = await h.cases();
      if (!first) throw new Error("no case");
      await h.mark(first.id, true);
      const [row] = await h.marks.list(scope);
      const ref = row?.snapshotRef ?? "";
      expect(await h.repository.payloadStore(OWNER_ID, AGENT_ID).get(ref)).toBeDefined();
      expect(await h.marks.unmark({ ...scope, caseId: first.id })).toBe(ref);
      expect(await h.repository.payloadStore(OWNER_ID, AGENT_ID).get(ref)).toBeUndefined();
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] masks a card number before the text is cut, so a cut cannot leave a readable half", async () => {
    const h = await wired();
    try {
      const candidates = await h.repository
        .decisionLedger()
        .readGapCandidates({ ...scope, start: START, end: END });
      const first = candidates.find((candidate) => candidate.pairedMessageId === "mail-1");
      if (!first) throw new Error("no candidate");
      const text = `${"甲".repeat(285)}银行卡号 4111 1111 1111 1111 请核对`;
      const ref = await h.seal.seal({ ...scope, text, at: IN_WINDOW });
      const input = [{ ...first, museTitleRef: ref }];
      const plain = await buildGapCases({ scope, candidates: input, seal: h.seal });
      const masked = await buildGapCases({
        scope,
        candidates: input,
        seal: h.seal,
        mask: maskForExport,
      });
      expect(plain[0]?.museTitle).toContain("4111");
      expect(masked[0]?.museTitle ?? "").not.toMatch(/4111|(?:\d[ -]?){13,}/u);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] the stored snapshot of a marked case never keeps a readable piece of a card number cut by the length limit", async () => {
    const h = await wired([...MAILS, LONG_CARD_MAIL]);
    try {
      const long = (await h.cases()).find((entry) => entry.museTitle?.startsWith("甲"));
      if (!long) throw new Error("no long case");
      expect(long.museTitle).toContain("4111");
      await h.mark(long.id, true);
      const [row] = await h.marks.list(scope);
      const stored = await h.seal.open({ ...scope, ref: row?.snapshotRef ?? "" });
      expect(stored).toBeDefined();
      expect(stored).not.toMatch(/4111|(?:\d[ -]?){13,}/u);
      const exported = await h.app.inject({
        method: "GET",
        url: GAP_EXPORT_PATH,
        headers: { authorization: `Bearer ${h.secret}` },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json().cases.map((entry: { id: string }) => entry.id)).toEqual([long.id]);
      expect(exported.body).not.toMatch(/4111|(?:\d[ -]?){13,}/u);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] answers 500 with an empty body when every snapshot is unreadable, and skips a snapshot whose id does not match its mark", async () => {
    const h = await wired();
    try {
      const auth = { authorization: `Bearer ${h.secret}` };
      const refOf = (text: string) => h.seal.seal({ ...scope, text, at: IN_WINDOW });
      await h.marks.mark({
        ...scope,
        caseId: "gap_aaaaaaaaaaaaaaaaaaaa",
        snapshotRef: await refOf("{not json"),
        at: IN_WINDOW,
      });
      const broken = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers: auth });
      expect(broken.statusCode).toBe(500);
      expect(broken.body).toBe("");
      const [first] = await h.cases();
      if (!first) throw new Error("no case");
      await h.mark(first.id, true);
      const [good] = (await h.marks.list(scope)).filter((row) => row.caseId === first.id);
      const goodText = await h.seal.open({ ...scope, ref: good?.snapshotRef ?? "" });
      await h.marks.mark({
        ...scope,
        caseId: "gap_bbbbbbbbbbbbbbbbbbbb",
        snapshotRef: await refOf(goodText ?? ""),
        at: IN_WINDOW,
      });
      const mixed = await h.app.inject({ method: "GET", url: GAP_EXPORT_PATH, headers: auth });
      expect(mixed.statusCode).toBe(200);
      expect(mixed.json().cases.map((entry: { id: string }) => entry.id)).toEqual([first.id]);
      expect(mixed.json().skipped).toBe(2);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
  });

  it("[negative] skips a damaged snapshot instead of failing the whole export", async () => {
    const h = await wired();
    try {
      const [first] = await h.cases();
      if (!first) throw new Error("no case");
      await h.mark(first.id, true);
      for (const [index, text] of [
        "{not json",
        "null",
        '{"id":"x","museAt":"2026-10-29T03:00:00.000Z"}',
      ].entries()) {
        const damagedRef = await h.seal.seal({ ...scope, text, at: IN_WINDOW });
        await h.marks.mark({
          ...scope,
          caseId: `gap_${String(index).repeat(20)}`,
          snapshotRef: damagedRef,
          at: IN_WINDOW,
        });
      }
      const response = await h.app.inject({
        method: "GET",
        url: GAP_EXPORT_PATH,
        headers: { authorization: `Bearer ${h.secret}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().cases.map((entry: { id: string }) => entry.id)).toEqual([first.id]);
      expect(response.json().skipped).toBe(3);
    } finally {
      await h.app.close();
      await h.repository.close();
    }
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
