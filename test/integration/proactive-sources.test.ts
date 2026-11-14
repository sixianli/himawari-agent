import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProactiveSeal,
  defineProactiveSources,
  type FlatMailReader,
  GMAIL_SOURCE,
  limitedSourceReader,
  type ModelDescriptor,
  type ModelInvocationEvent,
  mailReader,
  PROACTIVE_SOURCES,
  type ProactiveMail,
  type ProactiveMailExtra,
  ProactiveMailCheckService,
  type ProactiveObservation,
  type ProactiveSource,
  type ProactiveSourceDefinition,
  type ProactiveSourceLimitHit,
  type ProactiveSourceRegistry,
  proactiveSourceDefinitionProblems,
  readProactiveOverview,
  recordProactiveProgramEntry,
} from "@himawari-agent/application";
import { CALIBRATION_GROUPS, CALIBRATION_MAIL_SOURCE } from "@himawari-agent/calibration";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  buildPortableExport,
  DataExportError,
  importPortableExport,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { DeterministicIdGenerator, ManualClock, ScriptedModelPort } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createProactivePushSource } from "../../apps/agent-service/src/production-proactive.ts";
import { newProtector, openSide } from "./data-export-fixture.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-proactive-sources");
const AGENT_ID = createAgentId("agent-proactive-sources");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const TIME_ZONE = "Asia/Tokyo";
const NOV_4_10AM_JST = "2026-11-04T01:00:00.000Z";
const MODEL_REF = "proactive-sources-model";
const PASSPHRASE = "测试口令-correct horse battery staple";

const descriptor: ModelDescriptor = {
  ref: MODEL_REF,
  provider: "deterministic",
  model: MODEL_REF,
  version: "1.0.0",
  routingClass: "primary",
  priority: 10,
  disclosure: "trusted_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: null,
};

const NOTES_SOURCE = Object.freeze({ ...GMAIL_SOURCE, name: "test_notes", trust: "owner" });
const FEED_SOURCE = Object.freeze({
  ...GMAIL_SOURCE,
  name: "test_feed",
  intake: "written_by_program",
  trust: "owner",
  latestDeliveryMs: 86_400_000,
});
const mailDefinitions = new Map<string, ProactiveSourceDefinition<string, ProactiveMailExtra>>([
  [GMAIL_SOURCE.name, GMAIL_SOURCE],
  [NOTES_SOURCE.name, NOTES_SOURCE],
]);
const NOTES = NOTES_SOURCE.name as ProactiveSource;
const FEED = FEED_SOURCE.name as ProactiveSource;
const fakeDefinitions = [GMAIL_SOURCE, NOTES_SOURCE, FEED_SOURCE] as unknown as readonly [
  ProactiveSourceDefinition<string, never>,
];
const registry = defineProactiveSources(
  fakeDefinitions,
) as unknown as ProactiveSourceRegistry<ProactiveSource>;

function mail(
  source: ProactiveSource,
  messageId: string,
  overrides: Partial<ProactiveMail> = {},
): ProactiveMail {
  return {
    source,
    messageId,
    threadId: `thread-${messageId}`,
    from: "Friend <friend@gmail.com>",
    fromAddress: "friend@gmail.com",
    subject: "週末どうする？",
    snippet: "土曜日に会える？",
    link: `https://mail.google.com/mail/u/0/#all/${messageId}`,
    receivedAt: "2026-11-04T00:30:00.000Z",
    categories: [],
    sentByOwner: false,
    body: null,
    bodyTruncated: false,
    bodyUnavailable: false,
    attachments: [],
    ...overrides,
  };
}

describe("[iOS-7] proactive source registry", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const repositories: SqliteProductStateRepository[] = [];
  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function harness(options: { registered?: boolean } = {}) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-proactive-sources-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOV_4_10AM_JST);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
      ...(options.registered === false
        ? {}
        : {
            proactiveSources: registry.definitions.map(({ name, safetyLimits }) => ({
              name,
              safetyLimits,
            })),
          }),
    });
    repositories.push(repository);
    const store = repository.proactive();
    const ids = new DeterministicIdGenerator();
    const protector = newProtector();
    const payloadStore = repository.payloadStore(OWNER_ID, AGENT_ID);
    const seal = createProactiveSeal({ payloads: payloadStore, protector, ids });
    const writePayload = async (ref: string, content: string) => {
      await payloadStore.put(
        await protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(content),
          createdAt: clock.now(),
        }),
      );
    };
    const readPayload = async (ref: string) => {
      const payload = await payloadStore.get(ref);
      if (!payload) return "";
      return new TextDecoder().decode(await protector.unprotect({ ...scope, payload }));
    };
    await store.writeSettings({
      ...scope,
      enabled: true,
      quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
      importantSenders: [],
      now: clock.now(),
    });
    const connect = async (source: ProactiveSource) =>
      store.saveConnection({
        ...scope,
        connection: {
          source,
          accountRef: await seal.seal({ ...scope, text: "andy@example.com", at: clock.now() }),
          tokenRef: await seal.seal({ ...scope, text: "refresh-token", at: clock.now() }),
          cursor: "cursor-1",
          status: "connected",
          connectedAt: clock.now(),
          updatedAt: clock.now(),
        },
      });
    const prompts: string[] = [];
    const outputs = new Map<string, string>();
    const written = new Set<string>();
    const queued: ScriptedModelPort[] = [];
    let scripted = new ScriptedModelPort([descriptor], []);
    const script = (
      entries: readonly {
        id: string;
        result: "act" | "know" | "check" | "ignore";
        todo?: string;
      }[],
    ) => {
      const ref = `output-${outputs.size + 1}`;
      outputs.set(
        ref,
        JSON.stringify({
          items: entries.map((entry) => ({
            confidence: "sure",
            todo: "",
            priority: entry.result === "act" ? "high" : null,
            dueAt: entry.result === "act" ? "2026-11-05T23:59:00+09:00" : null,
            reason: "",
            ...entry,
          })),
        }),
      );
      const events: ModelInvocationEvent[] = [
        { type: "model.started", invocationId: "scripted", occurredAt: clock.now() },
        {
          type: "model.output",
          invocationId: "scripted",
          sequence: 1,
          payloadRef: ref,
          occurredAt: clock.now(),
        },
        {
          type: "model.completed",
          invocationId: "scripted",
          inputTokens: 100,
          outputTokens: 50,
          costMicros: 300,
          latencyMs: 10,
          occurredAt: clock.now(),
        },
      ];
      scripted = new ScriptedModelPort([descriptor], events);
      queued.push(scripted);
    };
    const checker = (
      source: ProactiveSource,
      extra: {
        observations?: ProactiveObservation[];
        limits?: ProactiveSourceLimitHit[];
        receive?: () => Promise<void>;
        perCheckMs?: number;
      } = {},
    ) => {
      const reader: FlatMailReader & { items: ProactiveMail[]; nextCursor: string | null } = {
        source,
        items: [],
        nextCursor: "cursor-2",
        related: undefined,
        async fetch() {
          return { kind: "items" as const, items: reader.items, cursor: reader.nextCursor };
        },
      };
      const definition = mailDefinitions.get(source);
      if (definition === undefined) throw new Error("source is not in the test registry");
      const observations = extra.observations;
      const limits = extra.limits;
      const service = new ProactiveMailCheckService({
        scope,
        store,
        seal,
        reader: limitedSourceReader({
          reader: mailReader(reader),
          scope,
          store,
          clock,
          timeZone: TIME_ZONE,
          ...(limits ? { onLimit: (hit: ProactiveSourceLimitHit) => limits.push(hit) } : {}),
        }),
        definition,
        ...(extra.receive ? { observations: { receive: extra.receive } } : {}),
        ...(observations
          ? {
              observations: {
                receive: async (received) => {
                  observations.push(...received);
                },
              },
            }
          : {}),
        model: {
          get model() {
            return queued.shift() ?? scripted;
          },
          modelRef: MODEL_REF,
          allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
          async prepare({ invocationId, prompt }) {
            prompts.push(prompt);
            const inputRef = `input-${invocationId}`;
            await writePayload(inputRef, prompt);
            for (const [ref, content] of outputs)
              if (!written.has(ref)) {
                await writePayload(ref, content);
                written.add(ref);
              }
            return {
              runId: `proactive:${invocationId}` as never,
              inputRef,
              allowedDisclosureRef: "proactive-sources",
              secretHandleRefs: [],
              release: async () => undefined,
            };
          },
          readOutput: readPayload,
          release: async (refs) => {
            for (const ref of refs) await payloadStore.delete(ref);
          },
        },
        limits: {
          perCheckMs: extra.perCheckMs ?? 180_000,
          dailyCostMicros: 1_000_000,
          estimateCostMicros: () => 100,
        },
        timeZone: TIME_ZONE,
        clock,
        ids,
      });
      return { reader, service };
    };
    const overview = (source: ProactiveSource) =>
      readProactiveOverview({
        scope,
        source,
        store,
        seal,
        timeZone: TIME_ZONE,
        dailyCostMicros: 1_000_000,
        now: clock.now(),
        feedback: async () => [],
      });
    const query = (sql: string, ...parameters: unknown[]) => {
      const opened = openQualifiedDatabase(databasePath);
      try {
        return opened.prepare(sql).all(...parameters) as Record<string, unknown>[];
      } finally {
        opened.close();
      }
    };
    const exec = (sql: string) => {
      const opened = openQualifiedDatabase(databasePath);
      try {
        opened.exec(sql);
      } finally {
        opened.close();
      }
    };
    const entry = (
      input: Parameters<typeof recordProactiveProgramEntry>[1],
      through: typeof store = store,
    ) =>
      recordProactiveProgramEntry(
        { scope, store: through, seal, clock, ids, timeZone: TIME_ZONE, registry },
        input,
      );
    const exported = async () => {
      const opened = openQualifiedDatabase(databasePath);
      try {
        return await buildPortableExport({
          database: opened,
          scope,
          migrationSequence: (await loadBundledMigrations()).length,
          protector,
          policy: createDataExportTextPolicy(),
          now: () => clock.now(),
          sealPassphrase: PASSPHRASE,
          withEvidence: true,
        });
      } finally {
        opened.close();
      }
    };
    return {
      clock,
      store,
      seal,
      connect,
      script,
      checker,
      overview,
      query,
      exec,
      entry,
      exported,
      prompts,
      pushes: createProactivePushSource({ scope, store, seal }),
    };
  }

  it("[iOS-7] registers Gmail alone, with every pipeline fact filled in", () => {
    expect(PROACTIVE_SOURCES.names).toEqual(["gmail"]);
    for (const definition of PROACTIVE_SOURCES.definitions)
      expect(proactiveSourceDefinitionProblems(definition)).toEqual([]);
    expect(PROACTIVE_SOURCES.get("gmail")).toMatchObject({
      intake: "reader",
      trust: "external",
      latestDeliveryMs: null,
    });
    expect(PROACTIVE_SOURCES.has("test_notes")).toBe(false);
  });

  it("[iOS-7] calibration reads the registered Gmail source name and knows every registered evaluation group", () => {
    expect(CALIBRATION_MAIL_SOURCE).toBe(GMAIL_SOURCE.name);
    for (const definition of PROACTIVE_SOURCES.definitions)
      for (const group of definition.evaluation.calibrationGroups)
        expect(CALIBRATION_GROUPS).toContain(group);
  });

  it("[iOS-7][reverse] refuses a source without a trust mark, with a bad name, or registered twice", () => {
    const { trust: _trust, ...withoutTrust } = NOTES_SOURCE;
    expect(proactiveSourceDefinitionProblems(withoutTrust)).toEqual(["trust"]);
    expect(() => defineProactiveSources([withoutTrust as never])).toThrow(
      /PROACTIVE_SOURCE_INVALID test_notes: trust/u,
    );
    expect(() => defineProactiveSources([{ ...NOTES_SOURCE, name: "Bad Name" } as never])).toThrow(
      /PROACTIVE_SOURCE_INVALID Bad Name: name/u,
    );
    expect(() => defineProactiveSources([NOTES_SOURCE as never, NOTES_SOURCE as never])).toThrow(
      /PROACTIVE_SOURCE_DUPLICATE test_notes/u,
    );
    expect(
      proactiveSourceDefinitionProblems({
        ...NOTES_SOURCE,
        safetyLimits: {
          ...NOTES_SOURCE.safetyLimits,
          perCheck: { defaultLimit: 500, minimum: 1, maximum: 501 },
        },
      }),
    ).toEqual(["safetyLimits.perCheck"]);
    expect(
      proactiveSourceDefinitionProblems({
        ...NOTES_SOURCE,
        safetyLimits: { ...NOTES_SOURCE.safetyLimits, perDay: undefined },
        evaluation: { calibrationGroups: [] },
      }),
    ).toEqual(["safetyLimits.perDay", "evaluation"]);
  });

  it("[iOS-7] a newly registered source goes through the same judging and storage, reminders, delivery and rating", async () => {
    const h = await harness();
    await h.connect(NOTES);
    await h.connect("gmail");
    const observations: ProactiveObservation[] = [];
    const notes = h.checker(NOTES, { observations });
    notes.reader.items = [mail(NOTES, "note-1", { subject: "牙医", snippet: "明天十点看牙" })];
    h.script([{ id: "note-1", result: "act", todo: "明天十点看牙" }]);
    const decision = await notes.service.run();
    expect(decision).toMatchObject({ scenario: "test_notes", verdict: "pushed" });
    const gmail = h.checker("gmail");
    gmail.reader.items = [mail("gmail", "mail-1")];
    h.script([{ id: "mail-1", result: "act", todo: "回复周末安排" }]);
    expect(await gmail.service.run()).toMatchObject({ scenario: "gmail", verdict: "pushed" });

    const overview = await h.overview(NOTES);
    expect(overview.source).toBe("test_notes");
    expect(overview.insights.map(({ summary }) => summary)).toContain("明天十点看牙");
    const ready = await h.pushes.listReady(h.clock.now());
    expect(ready.length).toBeGreaterThan(0);
    const contents = await Promise.all(ready.map(({ id }) => h.pushes.content(id)));
    expect(contents.map((content) => content?.text)).toContain("明天十点看牙");

    const insight = overview.insights.find(({ summary }) => summary === "明天十点看牙");
    expect(
      await h.store.updateInsight({
        ...scope,
        insightId: insight?.id ?? "",
        rating: "useful",
        now: h.clock.now(),
      }),
    ).toBe(true);
    expect(
      await h.store.rateProcessed({
        ...scope,
        source: NOTES,
        messageId: "note-1",
        rating: "useful",
        now: h.clock.now(),
      }),
    ).toBe(true);

    expect(observations).toEqual([
      expect.objectContaining({
        source: "test_notes",
        sourceId: "thread-note-1",
        sourceVersion: "note-1",
        trust: "owner",
        provenance: {
          kind: "mail",
          author: "friend@gmail.com",
          occurredAt: "2026-11-04T00:30:00.000Z",
        },
        what: "明天十点看牙",
        decisionId: decision?.id,
        insightId: insight?.id,
      }),
    ]);
    expect(
      h.query(
        "SELECT source, owner_rating FROM source_insights WHERE owner_id = ? ORDER BY source",
        OWNER_ID,
      ),
    ).toEqual([
      { source: "gmail", owner_rating: null },
      { source: "test_notes", owner_rating: "useful" },
    ]);
    expect(
      h.query(
        "SELECT source, message_id, owner_rating FROM proactive_processed_messages ORDER BY source",
      ),
    ).toEqual([
      { source: "gmail", message_id: "mail-1", owner_rating: null },
      { source: "test_notes", message_id: "note-1", owner_rating: "useful" },
    ]);
    expect(
      h
        .query(
          "SELECT scenario, inputs FROM decision_ledger WHERE kind = 'proactive' ORDER BY scenario",
        )
        .map((row) => ({
          scenario: row["scenario"],
          observations: (JSON.parse(String(row["inputs"])) as Record<string, unknown>)[
            "observations"
          ],
        })),
    ).toEqual([
      { scenario: "gmail", observations: { handedOff: 1, sink: "not_connected" } },
      { scenario: "test_notes", observations: { handedOff: 1, sink: "port" } },
    ]);
  });

  it("[iOS-7][reverse] hands nothing to the proposal entry when nothing is worth a reminder", async () => {
    const h = await harness();
    await h.connect("gmail");
    const observations: ProactiveObservation[] = [];
    const gmail = h.checker("gmail", { observations });
    gmail.reader.items = [mail("gmail", "mail-1"), mail("gmail", "mail-2")];
    h.script([
      { id: "mail-1", result: "ignore" },
      { id: "mail-2", result: "know", todo: "朋友问周末安排" },
    ]);
    await gmail.service.run();
    expect(observations).toEqual([]);
    expect(
      h
        .query("SELECT inputs FROM decision_ledger WHERE kind = 'proactive'")
        .map(
          (row) => (JSON.parse(String(row["inputs"])) as Record<string, unknown>)["observations"],
        ),
    ).toEqual([{ handedOff: 0, sink: "port" }]);
  });

  it("[iOS-7][reverse] a proposal entry that fails or never answers does not hold up the check", async () => {
    const h = await harness();
    await h.connect("gmail");
    for (const [id, receive] of [
      [
        "mail-0",
        () => {
          throw new Error("RECEIVER_BROKEN");
        },
      ],
      ["mail-1", () => Promise.reject(new Error("RECEIVER_DOWN"))],
      ["mail-2", () => new Promise<void>(() => undefined)],
    ] as const) {
      const gmail = h.checker("gmail", { receive, perCheckMs: 600_000 });
      gmail.reader.items = [mail("gmail", id)];
      h.script([{ id, result: "act", todo: "回复周末安排" }]);
      expect(await gmail.service.run()).toMatchObject({ verdict: "pushed" });
    }
    expect(
      h.query("SELECT message_id FROM proactive_processed_messages ORDER BY message_id"),
    ).toEqual([{ message_id: "mail-0" }, { message_id: "mail-1" }, { message_id: "mail-2" }]);
  });

  it("[iOS-7][reverse] the database refuses a source name that is not registered", async () => {
    const h = await harness({ registered: false });
    await expect(h.connect(NOTES)).rejects.toThrow(/not registered/u);
    await expect(
      h.store.writeSourceSettings({
        ...scope,
        source: NOTES,
        enabled: true,
        perDay: 10,
        perCheck: 5,
        changeId: "change-1",
        now: h.clock.now(),
      }),
    ).rejects.toThrow(/not registered/u);
    await expect(
      h.store.unprocessed({ ...scope, source: NOTES, messageIds: ["note-1"] }),
    ).rejects.toThrow(/not registered/u);
    await h.connect("gmail");
    expect(h.query("SELECT source FROM proactive_connections")).toEqual([{ source: "gmail" }]);
    expect((await h.store.listSourceSettings(scope)).map(({ source }) => source)).toEqual([
      "gmail",
    ]);
  });

  it("[iOS-7] each source has its own switch and caps, defaults come from the registry, and a cap holds items back without dropping them", async () => {
    const h = await harness();
    expect(await h.store.listSourceSettings(scope)).toEqual([
      { source: "gmail", enabled: true, perDay: 5_000, perCheck: 500, updatedAt: null },
      { source: "test_notes", enabled: true, perDay: 5_000, perCheck: 500, updatedAt: null },
      { source: "test_feed", enabled: true, perDay: 5_000, perCheck: 500, updatedAt: null },
    ]);
    await h.connect(NOTES);
    await h.store.writeSourceSettings({
      ...scope,
      source: NOTES,
      enabled: true,
      perDay: 3,
      perCheck: 2,
      changeId: "change-1",
      now: h.clock.now(),
    });
    await expect(
      h.store.writeSourceSettings({
        ...scope,
        source: NOTES,
        enabled: true,
        perDay: 0,
        perCheck: 2,
        changeId: "change-2",
        now: h.clock.now(),
      }),
    ).rejects.toThrow(/settings are invalid/u);
    const limits: ProactiveSourceLimitHit[] = [];
    const notes = h.checker(NOTES, { limits });
    notes.reader.items = ["a", "b", "c", "d", "e"].map((id) => mail(NOTES, id));
    const judged = async () =>
      h
        .query("SELECT message_id FROM proactive_processed_messages ORDER BY message_id")
        .map((row) => row["message_id"]);
    h.script(["a", "b"].map((id) => ({ id, result: "ignore" as const })));
    await notes.service.run();
    expect(await judged()).toEqual(["a", "b"]);
    expect(limits).toEqual([{ source: "test_notes", kind: "per_check", limit: 2, heldBack: 3 }]);
    expect((await h.store.readConnection({ ...scope, source: NOTES }))?.cursor).toBe("cursor-1");

    h.script([{ id: "c", result: "ignore" }]);
    await notes.service.run();
    expect(await judged()).toEqual(["a", "b", "c"]);
    expect(limits[1]).toEqual({ source: "test_notes", kind: "per_day", limit: 3, heldBack: 2 });

    h.clock.set("2026-11-05T01:00:00.000Z");
    h.script(["d", "e"].map((id) => ({ id, result: "ignore" as const })));
    await notes.service.run();
    expect(await judged()).toEqual(["a", "b", "c", "d", "e"]);
    expect(limits).toHaveLength(2);
    expect((await h.store.readConnection({ ...scope, source: NOTES }))?.cursor).toBe("cursor-2");
    expect((await h.store.listSourceSettings(scope))[0]).toMatchObject({
      source: "gmail",
      perDay: 5_000,
      perCheck: 500,
    });
  });

  it("[iOS-7] a source written by another program delivers one entry at once and one at its set time, and both can be rated", async () => {
    const h = await harness();
    const base = {
      source: FEED,
      reason: "",
      link: "",
      result: "act" as const,
      priority: null,
      dueAt: null,
    };
    const now = await h.entry({
      ...base,
      entryId: "feed-now",
      summary: "快递到了",
      deliverAt: null,
    });
    expect(now).toMatchObject({
      kind: "recorded",
      decision: { scenario: "test_feed", verdict: "pushed", reasonCode: "PROGRAM_ENTRY" },
    });
    const later = await h.entry({
      ...base,
      entryId: "feed-later",
      summary: "下午三点提醒开会",
      deliverAt: "2026-11-04T06:00:00.000Z",
    });
    expect(later).toMatchObject({
      kind: "recorded",
      decision: { verdict: "deferred", reasonCode: "DELIVER_AT" },
    });

    const overview = await h.overview(FEED);
    expect(overview.insights.map(({ summary }) => summary).sort()).toEqual(
      ["下午三点提醒开会", "快递到了"].sort(),
    );
    const readyNow = await h.pushes.listReady(h.clock.now());
    expect(readyNow).toHaveLength(1);
    expect(await h.pushes.content(readyNow[0]?.id ?? "")).toMatchObject({ text: "快递到了" });
    await h.pushes.markEnqueued(readyNow[0]?.id ?? "", h.clock.now());
    expect(await h.pushes.listReady("2026-11-04T05:59:59.000Z")).toEqual([]);
    const readyLater = await h.pushes.listReady("2026-11-04T06:00:00.000Z");
    expect(readyLater).toHaveLength(1);
    expect(await h.pushes.content(readyLater[0]?.id ?? "")).toMatchObject({
      text: "下午三点提醒开会",
    });

    if (now.kind !== "recorded" || later.kind !== "recorded") throw new Error("not recorded");
    expect(
      await h.store.updateInsight({
        ...scope,
        insightId: later.insightId,
        rating: "unneeded",
        now: h.clock.now(),
      }),
    ).toBe(true);
    expect(
      await h.store.rateDecision({
        ...scope,
        decisionId: now.decision.id,
        rating: "useful",
        now: h.clock.now(),
      }),
    ).toBe(true);
    expect(
      h.query("SELECT thread_id, owner_rating FROM source_insights ORDER BY thread_id"),
    ).toEqual([
      { thread_id: "feed-later", owner_rating: "unneeded" },
      { thread_id: "feed-now", owner_rating: null },
    ]);
    expect(h.prompts).toEqual([]);
  });

  it("[iOS-7][reverse] a program entry is not recorded twice, past the daily cap, with its source off, or for a source that has a reader", async () => {
    const h = await harness();
    const base = {
      reason: "",
      link: "",
      result: "act" as const,
      priority: null,
      dueAt: null,
      deliverAt: null,
    };
    const feed = (entryId: string) => h.entry({ ...base, source: FEED, entryId, summary: entryId });
    expect((await feed("one")).kind).toBe("recorded");
    expect(await feed("one")).toEqual({ kind: "not_recorded", reason: "already_recorded" });
    expect(await h.entry({ ...base, source: NOTES, entryId: "x", summary: "x" })).toEqual({
      kind: "not_recorded",
      reason: "source_has_reader",
    });
    expect(
      await h.entry({ ...base, source: "nowhere" as ProactiveSource, entryId: "x", summary: "x" }),
    ).toEqual({ kind: "not_recorded", reason: "source_not_registered" });
    for (const invalid of [
      { result: "know", priority: null },
      { result: "act", priority: "low" },
      { result: "act", priority: null, summary: " " },
      { result: "act", priority: null, summary: "x".repeat(2_001) },
      { result: "act", priority: null, reason: "x".repeat(2_001) },
      { result: "act", priority: null, link: "x".repeat(2_001) },
      { result: "act", priority: null, dueAt: "tomorrow" },
      { result: "act", priority: null, deliverAt: "9999" },
      { result: "act", priority: null, deliverAt: "2026-11-04T15:00:00+09:00" },
      { result: "act", priority: null, dueAt: `2026-11-04T15:00:00.000Z${" ".repeat(100)}` },
      { result: "act", priority: null, link: "javascript:alert(1)" },
      { result: "act", priority: null, link: "data:text/html,x" },
      { result: "act", priority: null, link: "http://example.com/a" },
      { result: "act", priority: null, link: "not a link" },
    ])
      expect(
        await h.entry({ ...base, source: FEED, entryId: "bad", summary: "x", ...invalid } as never),
      ).toEqual({ kind: "not_recorded", reason: "entry_invalid" });
    expect(await h.entry(null as never)).toEqual({ kind: "not_recorded", reason: "entry_invalid" });
    expect(
      (
        await h.entry({
          ...base,
          source: FEED,
          entryId: "linked",
          summary: "linked",
          link: "https://example.com/a",
        })
      ).kind,
    ).toBe("recorded");
    const settings = { ...scope, source: FEED, perCheck: 5, now: h.clock.now() };
    await h.store.writeSourceSettings({ ...settings, changeId: "c0", enabled: true, perDay: 50 });
    const loweredMidway = {
      ...h.store,
      processedSince: async (input: Parameters<typeof h.store.processedSince>[0]) => {
        const used = await h.store.processedSince(input);
        await h.store.writeSourceSettings({
          ...settings,
          changeId: "c-midway",
          enabled: true,
          perDay: 2,
        });
        return used;
      },
    };
    expect(
      await h.entry({ ...base, source: FEED, entryId: "midway", summary: "midway" }, loweredMidway),
    ).toEqual({ kind: "not_recorded", reason: "daily_limit" });
    await h.store.writeSourceSettings({ ...settings, changeId: "c1", enabled: true, perDay: 1 });
    expect(await feed("two")).toEqual({ kind: "not_recorded", reason: "daily_limit" });
    await h.store.writeSourceSettings({ ...settings, changeId: "c2", enabled: false, perDay: 50 });
    expect(await feed("two")).toEqual({ kind: "not_recorded", reason: "source_off" });
    await h.store.writeSourceSettings({ ...settings, changeId: "c3", enabled: true, perDay: 50 });
    await h.store.writeSettings({
      ...scope,
      enabled: false,
      quietHours: [],
      importantSenders: [],
      now: h.clock.now(),
    });
    expect(await feed("two")).toEqual({ kind: "not_recorded", reason: "proactive_off" });
    expect(
      h.query("SELECT message_id FROM proactive_processed_messages ORDER BY message_id"),
    ).toEqual([{ message_id: "linked" }, { message_id: "one" }]);
  });

  it("[iOS-7][reverse] two writers racing on one entry, or on the last slot of the day, record it once", async () => {
    const h = await harness();
    const base = {
      source: FEED,
      reason: "",
      link: "",
      result: "act" as const,
      priority: null,
      dueAt: null,
      deliverAt: null,
    };
    const same = await Promise.all(
      [1, 2, 3].map(() => h.entry({ ...base, entryId: "race", summary: "快递到了" })),
    );
    expect(same.filter(({ kind }) => kind === "recorded")).toHaveLength(1);
    expect(same.filter((outcome) => outcome.kind === "not_recorded")).toEqual([
      { kind: "not_recorded", reason: "already_recorded" },
      { kind: "not_recorded", reason: "already_recorded" },
    ]);
    await h.store.writeSourceSettings({
      ...scope,
      source: FEED,
      enabled: true,
      perDay: 2,
      perCheck: 5,
      changeId: "race-cap",
      now: h.clock.now(),
    });
    const last = await Promise.all(
      ["a", "b", "c"].map((entryId) => h.entry({ ...base, entryId, summary: entryId })),
    );
    expect(last.filter(({ kind }) => kind === "recorded")).toHaveLength(1);
    expect(last.filter((outcome) => outcome.kind === "not_recorded")).toEqual([
      { kind: "not_recorded", reason: "daily_limit" },
      { kind: "not_recorded", reason: "daily_limit" },
    ]);
    expect(h.query("SELECT COUNT(*) AS total FROM proactive_processed_messages")).toEqual([
      { total: 2 },
    ]);
    expect(
      h.query("SELECT COUNT(*) AS total FROM decision_ledger WHERE kind = 'proactive'"),
    ).toEqual([{ total: 2 }]);
    expect(h.query("SELECT COUNT(*) AS total FROM source_insights")).toEqual([{ total: 2 }]);
  });

  it("[iOS-7][reverse] a cap change whose decision record cannot be written changes nothing", async () => {
    const h = await harness();
    const change = (changeId: string, perDay: number) =>
      h.store.writeSourceSettings({
        ...scope,
        source: NOTES,
        enabled: false,
        perDay,
        perCheck: 5,
        changeId,
        now: h.clock.now(),
      });
    await expect(change("x".repeat(101), 10)).rejects.toThrow(/settings are invalid/u);
    h.exec(
      `CREATE TRIGGER refuse_limit_change BEFORE INSERT ON decision_ledger
       WHEN NEW.kind = 'limit_change'
       BEGIN SELECT RAISE(ABORT, 'LIMIT_CHANGE_REFUSED'); END`,
    );
    await expect(change("change-1", 10)).rejects.toThrow();
    expect(h.query("SELECT COUNT(*) AS total FROM proactive_source_settings")).toEqual([
      { total: 0 },
    ]);
    h.exec("DROP TRIGGER refuse_limit_change");
    await change("change-1", 10);
    expect(h.query("SELECT enabled, per_day FROM proactive_source_settings")).toEqual([
      { enabled: 0, per_day: 10 },
    ]);
    expect(
      h.query("SELECT id FROM decision_ledger WHERE kind = 'limit_change' ORDER BY id"),
    ).toEqual([{ id: "change-1:perCheck" }, { id: "change-1:perDay" }]);
  });

  it("[iOS-7][reverse] clearing the records of one source, or disconnecting it, leaves the other source alone", async () => {
    const h = await harness();
    const seed = async () => {
      for (const [source, id] of [
        ["gmail", `mail-${h.clock.now()}`],
        [NOTES, `note-${h.clock.now()}`],
      ] as const) {
        if ((await h.store.readConnection({ ...scope, source })) === undefined)
          await h.connect(source);
        const check = h.checker(source);
        check.reader.items = [mail(source, id)];
        h.script([{ id, result: "act", todo: "回复周末安排" }]);
        expect(await check.service.run()).toMatchObject({ scenario: source, verdict: "pushed" });
        h.exec(
          `INSERT OR REPLACE INTO proactive_push_backoff (owner_id, agent_id, source, class_key, stage,
             since_at, ignored_count, updated_at)
           VALUES ('${OWNER_ID}', '${AGENT_ID}', '${source}', 'due:example.com', 1, '${h.clock.now()}', 3, '${h.clock.now()}')`,
        );
      }
    };
    const left = (table: string, column = "source", where = "") =>
      h
        .query(`SELECT ${column} AS source FROM ${table} ${where} ORDER BY 1`)
        .map((row) => row["source"]);
    const everywhere = () => ({
      insights: left("source_insights"),
      processed: left("proactive_processed_messages"),
      backoff: left("proactive_push_backoff"),
      decisions: left("decision_ledger", "scenario", "WHERE kind = 'proactive'"),
      connections: left("proactive_connections"),
      pushes: h.query("SELECT COUNT(*) AS total FROM proactive_pushes")[0]?.["total"],
    });
    const both = ["gmail", "test_notes"];
    await seed();
    expect(await everywhere()).toEqual({
      insights: both,
      processed: both,
      backoff: both,
      decisions: both,
      connections: both,
      pushes: 2,
    });

    await h.store.clearRecords({ ...scope, source: NOTES });
    expect(await everywhere()).toEqual({
      insights: ["gmail"],
      processed: ["gmail"],
      backoff: ["gmail"],
      decisions: ["gmail"],
      connections: both,
      pushes: 1,
    });

    h.clock.advance(60_000);
    await seed();
    await h.store.removeSource({ ...scope, source: NOTES });
    const after = await everywhere();
    expect(after).toMatchObject({
      insights: ["gmail", "gmail"],
      processed: ["gmail", "gmail"],
      backoff: ["gmail"],
      connections: ["gmail"],
    });
    expect(after.decisions.filter((source) => source === "gmail")).toHaveLength(2);
    await expect(
      h.store.clearRecords({ ...scope, source: "nowhere" as ProactiveSource }),
    ).rejects.toThrow(/not registered/u);
  });

  it("[iOS-7] entries of newly registered sources survive export and import, and an unregistered name is refused on import", async () => {
    const h = await harness();
    await h.connect(NOTES);
    const notes = h.checker(NOTES);
    notes.reader.items = [mail(NOTES, "note-1")];
    h.script([{ id: "note-1", result: "act", todo: "明天十点看牙" }]);
    await notes.service.run();
    const base = { source: FEED, reason: "", link: "", result: "act" as const, priority: null };
    await h.entry({
      ...base,
      entryId: "feed-now",
      summary: "快递到了",
      dueAt: null,
      deliverAt: null,
    });
    await h.entry({
      ...base,
      entryId: "feed-later",
      summary: "下午三点提醒开会",
      dueAt: null,
      deliverAt: "2026-11-04T06:00:00.000Z",
    });
    const { files } = await h.exported();
    const target = await openSide("proactive-sources-target");
    directories.push(target.directory);
    const options = {
      database: target.database,
      scope: { ownerId: target.ownerId, agentId: target.agentId },
      migrationSequence: target.migrationSequence,
      protector: target.protector,
      now: () => h.clock.now(),
      passphrase: PASSPHRASE,
    };
    const refused = await importPortableExport(files, options).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DataExportError);
    expect((refused as DataExportError).code).toBe("DATA_IMPORT_LINE_INVALID");
    expect(target.database.prepare("SELECT COUNT(*) FROM decision_ledger").pluck().get()).toBe(0);

    await importPortableExport(files, { ...options, proactiveSources: registry.names });
    const column = (sql: string) => target.database.prepare(sql).pluck().all();
    expect(
      column(
        "SELECT scenario FROM decision_ledger WHERE kind = 'proactive' ORDER BY checked_at, id",
      ),
    ).toEqual(expect.arrayContaining(["test_notes", "test_feed", "test_feed"]));
    expect(column("SELECT thread_id FROM source_insights ORDER BY thread_id")).toEqual([
      "feed-later",
      "feed-now",
      "thread-note-1",
    ]);
    expect(column("SELECT source FROM proactive_processed_messages ORDER BY message_id")).toEqual([
      "test_feed",
      "test_feed",
      "test_notes",
    ]);
    target.database.close();
  });
});
