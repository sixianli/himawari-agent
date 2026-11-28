import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classificationRank,
  type DataClassification,
  DEFAULT_MEMORY_ATTRIBUTES,
  DurableMemoryService,
  type MemoryCategory,
  OwnerProfileService,
  ruleBookFor,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type Embedder,
  HybridMemoryProvider,
  MemoryEpisodeService,
} from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_READ_PATH,
  MCP_READ_TOOL_CEILING_MISSING,
  MCP_READ_TOOLS,
  type McpReadSources,
  type McpReadToolEntry,
  ProductionMcpRead,
  registerMcpReadRoute,
} from "../../apps/agent-service/src/production-mcp-read.ts";
import { ProductionMemoryRecall } from "../../apps/agent-service/src/production-memory-recall.ts";
import { ProductionReminderWriter } from "../../apps/agent-service/src/production-reminder-writer.ts";
import { createMcpOAuth } from "../../apps/agent-service/test/fixtures/mcp-oauth.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-mcp-read");
const AGENT_ID = createAgentId("agent-mcp-read");
const THREAD_ID = createThreadId("thread-mcp-read");
const GENERATION_ID = createMemoryGenerationId("generation-mcp-read");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-11T03:00:00.000Z";
const SINCE = "1970-01-01T00:00:00.000Z";
const TIME_ZONE = "Asia/Tokyo";
const DENTIST = "明天上午十点去牙医复诊";
const WIFI = "家里 Wi-Fi 密码：Sunflower-8841";
const TRIP = "周六去京都看红叶";
const YESTERDAY = "昨天和主人商量了京都红叶行程，主人说民宿门禁密码：Maple-7712";
const OLDER = "三天前主人整理了书架";

const TOPICS = ["牙医", "Wi-Fi", "京都"];
const CONNECTION_ID = "conn-mcp-read";

const embedder: Embedder = {
  model: "fixture-embedding",
  dimensions: 4,
  async embedQuery(text: string) {
    return topicVector(text);
  },
  async embedDocument(text: string) {
    return topicVector(text);
  },
};

function topicVector(text: string): Float32Array {
  const hits = TOPICS.map((topic) => (text.includes(topic) ? 1 : 0));
  return new Float32Array([...hits, hits.some(Boolean) ? 0 : 1]);
}

type Era = "legacy" | "modern";

interface StartHere {
  readonly profile: {
    readonly version: string;
    readonly sections: readonly { readonly items: readonly string[] }[];
    readonly omitted?: string;
  };
  readonly rules: { readonly note: string; readonly items: readonly string[] };
  readonly today: { readonly today: string; readonly recentDays: readonly unknown[] };
}

describe("[P5-1] read-only MCP entry over HTTP", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    options: {
      readonly failRecall?: boolean;
      readonly failLedger?: boolean;
      readonly failSummaries?: boolean;
      readonly failReminders?: boolean;
      readonly loseTodaySummary?: boolean;
      readonly withoutSummaries?: boolean;
      readonly failTokens?: boolean;
      readonly readCeiling?: Exclude<DataClassification, "restricted">;
      readonly hookReadsPerMinute?: number;
      readonly sensitiveSummary?: boolean;
      readonly hiddenRules?: boolean;
      readonly failProfile?: boolean;
      readonly ruleBook?: McpReadSources["ruleBook"];
      readonly readTools?: readonly McpReadToolEntry[];
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-mcp-read-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'open', ?, ?)`,
      )
      .run(THREAD_ID, OWNER_ID, AGENT_ID, NOW, NOW);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-mcp', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, NOW);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-mcp', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    const insertRule = database.prepare(
      `INSERT INTO rule_book_rules (
        owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
        updated_at, review_after
      ) VALUES (?, ?, ?, 1, ?, ?, 'chat:thread-1', ?, ?, ?)`,
    );
    const ruleSources: [string, DataClassification][] = [];
    for (const [ruleId, status, updatedAt, parameters] of [
      [
        "owner:immigration",
        "active",
        "2026-11-11T02:00:00.000Z",
        {
          type: "mail_must_notify",
          summary: " 日本入管局相关的邮件一律提醒 ",
          params: { senderDomains: ["@ISA.go.jp "] },
        },
      ],
      [
        "owner:a-refund",
        "needs_review",
        "2026-11-10T00:00:00.000Z",
        {
          type: "mail_read_whole_thread",
          summary: "退款邮件先读完整串",
          params: { phrases: ["退款"] },
        },
      ],
      [
        "owner:retired",
        "retired",
        "2026-11-11T01:00:00.000Z",
        {
          type: "mail_must_notify",
          summary: "撤销了的规则",
          params: { senderDomains: ["old.example"] },
        },
      ],
      [
        "owner:unknown",
        "active",
        NOW,
        { type: "mail_unknown_kind", summary: "看不懂的规则", params: {} },
      ],
      [
        "owner:empty",
        "active",
        NOW,
        { type: "mail_must_notify", summary: "参数不全的规则", params: {} },
      ],
      ...(options.hiddenRules
        ? ([
            [
              "owner:clinic",
              "active",
              NOW,
              {
                type: "mail_must_notify",
                summary: "心理诊所的邮件一律提醒",
                params: { senderDomains: ["clinic.example"] },
              },
            ],
            [
              "owner:orphan",
              "active",
              NOW,
              {
                type: "mail_must_notify",
                summary: "找不到出处的规则",
                params: { senderDomains: ["orphan.example"] },
              },
            ],
          ] as const)
        : []),
    ] as const) {
      const sourceMemoryId = ruleId === "owner:orphan" ? null : `memory-source-${ruleId}`;
      if (sourceMemoryId)
        ruleSources.push([sourceMemoryId, ruleId === "owner:clinic" ? "sensitive" : "private"]);
      insertRule.run(
        OWNER_ID,
        AGENT_ID,
        ruleId,
        JSON.stringify(parameters),
        status,
        sourceMemoryId,
        updatedAt,
        status === "needs_review" ? updatedAt : null,
      );
    }
    database.close();
    const clock = new ManualClock(NOW);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const readText = async (ref: string) => {
      const payload = await payloads.get(ref);
      if (!payload) throw new Error("MEMORY_PAYLOAD_MISSING");
      return new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }));
    };
    const provider = new HybridMemoryProvider({
      index: repository.memoryIndex(),
      embedder,
      embeddableClassifications: ["public", "private", "sensitive"],
      minimumSimilarity: 0.45,
      now: () => clock.now(),
    });
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content: { readText },
      workerId: "mcp-read-worker",
      now: () => clock.now(),
    });
    const writer = new ProductionReminderWriter({
      configuration: scope,
      memory,
      state: repository.productMemoryState(),
      book: repository.memoryBook(),
      reminders: repository.memoryReminders(),
      payloads,
      protector: adapters.payloadProtector,
      clock,
      timeZone: TIME_ZONE,
    });
    await writer.create({ key: "dentist", text: DENTIST, due: "2026-11-12T10:00", repeat: "none" });
    const sensitiveReminder = async (key: string, text: string, due: string) => {
      const contentRef = `payload:reminder:${key}:saved-as-sensitive`;
      await payloads.put(
        await adapters.payloadProtector.protect({
          ...scope,
          ref: contentRef,
          contentType: "text/plain",
          dataClassification: "sensitive",
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.now(),
        }),
      );
      await writer.create({ key, contentRef, due, repeat: "none" });
    };
    await sensitiveReminder("wifi", WIFI, "2026-11-12T20:00");
    await writer.create({ key: "trip", text: TRIP, due: "2026-11-13T13:00", repeat: "none" });
    await memory.runProjectionBatch(10);
    const episodeStore = repository.memoryEpisodes();
    const seedSummary = async (
      id: string,
      day: string,
      text: string,
      sequence: number,
      classification: DataClassification = "private",
    ) => {
      const contentRef = `payload:episode:${id}` as Parameters<typeof payloads.get>[0];
      await payloads.put(
        await adapters.payloadProtector.protect({
          ...scope,
          ref: contentRef,
          contentType: "text/plain",
          dataClassification: classification,
          plaintext: new TextEncoder().encode(text),
          createdAt: NOW,
        }),
      );
      await episodeStore.upsert({
        id,
        ...scope,
        threadId: THREAD_ID,
        day,
        source: "day_summary",
        contentRef,
        dataClassification: classification,
        firstSequence: sequence,
        lastSequence: sequence,
        startedAt: `${day}T01:00:00.000Z`,
        endedAt: `${day}T02:00:00.000Z`,
        createdAt: NOW,
        terms: [],
        embedding: null,
      });
    };
    await seedSummary("episode-older", "2026-11-08", OLDER, 1);
    await seedSummary("episode-yesterday", "2026-11-10", YESTERDAY, 2);
    if (options.sensitiveSummary)
      await seedSummary(
        "episode-sensitive",
        "2026-11-11",
        "今天陪主人去医院复查慢性病",
        4,
        "sensitive",
      );
    if (options.loseTodaySummary) await seedSummary("episode-today-lost", "2026-11-11", "lost", 3);
    const episodes = new MemoryEpisodeService({
      store: episodeStore,
      threads: repository.threadRepository(),
      readText: async ({ ref }) => {
        if (ref === "payload:episode:episode-today-lost") throw new Error("SUMMARY_TEXT_GONE");
        return readText(ref);
      },
      storeText: async () => {
        throw new Error("SUMMARY_WRITE_NOT_EXPECTED");
      },
      embedder: null,
      now: () => clock.now(),
      timeZone: TIME_ZONE,
    });
    const recall = new ProductionMemoryRecall({
      ...scope,
      provider: {
        search: async (input) => {
          if (options.failRecall) throw new Error("VECTOR_INDEX_DOWN");
          return provider.search(input);
        },
      },
      state: repository.productMemoryState(),
      readText: async (record) => readText(record.contentRef),
      embedWithin: async () => {
        throw new Error("RUN_EMBEDDING_NOT_EXPECTED");
      },
      now: () => clock.now(),
      timeZone: TIME_ZONE,
    });
    const embeddingContexts: { deadlineAt: string; aborted: boolean }[] = [];
    const failures: unknown[] = [];
    const summaryFailures: unknown[] = [];
    const settingsStore = repository.proactive();
    const oauth = createMcpOAuth({
      scope,
      clock,
      store: repository.mcpOAuth(),
      connections: repository.mcpConnections(),
    });
    const mcp = new ProductionMcpRead({
      scope,
      clock,
      tokens: {
        resourceMetadataUrl: oauth.authorization.resourceMetadataUrl,
        verifyAccessToken: async (token) => {
          if (options.failTokens) throw new Error("TOKEN_STORE_DOWN");
          return oauth.authorization.verifyAccessToken(token);
        },
      },
      timeZone: TIME_ZONE,
      connections: repository.mcpConnections(),
      ...(options.hookReadsPerMinute ? { hookReadsPerMinute: options.hookReadsPerMinute } : {}),
      ...(options.readTools ? { readTools: options.readTools } : {}),
      requestTimeoutMs: 30_000,
      sources: {
        profile: (maxClassification) => {
          if (options.failProfile) throw new Error("PROFILE_STORE_DOWN");
          return new OwnerProfileService({
            state: repository.productMemoryState(),
            pins: repository.memoryBook(),
            readText: async (record) => readText(record.contentRef),
            storeText: async () => undefined,
            digest: (text) => createHash("sha256").update(text).digest("hex"),
            timeZone: TIME_ZONE,
          }).outline({ ...scope, maxClassification, now: clock.now() });
        },
        recall: (args, within, ceiling) => recall.recallOutsideRun(args, within, ceiling),
        embedOutsideRun: async (context, operation) => {
          embeddingContexts.push({
            deadlineAt: context.deadlineAt,
            aborted: context.signal.aborted,
          });
          context.costMicros += 7;
          return operation();
        },
        reminders: async (windowMs, ceiling) => {
          if (options.failReminders) throw new Error("REMINDER_STORE_DOWN");
          return writer.list(windowMs, ceiling);
        },
        settings: () => settingsStore.readSettings(scope),
        ...(options.ruleBook ? { ruleBook: options.ruleBook } : {}),
        ownerRules: () => repository.ownerRules().list({ ...scope, includeRetired: false }),
        memoryClassifications: async (memoryIds) =>
          new Map(
            (
              await repository.productMemoryState().readMany({
                ...scope,
                memoryIds: memoryIds.map((memoryId) => createMemoryId(memoryId)),
              })
            ).map((record) => [record.id as string, record.dataClassification]),
          ),
        ...(options.withoutSummaries
          ? {}
          : {
              summaries: async ({
                days,
                limit,
                maxClassification,
              }: {
                days: number;
                limit: number;
                maxClassification?: DataClassification;
              }) => {
                if (options.failSummaries) throw new Error("SUMMARY_STORE_DOWN");
                const found = await episodes.recent({
                  ...scope,
                  days,
                  limit,
                  allowedClassifications: (["public", "private", "sensitive"] as const).filter(
                    (classification) =>
                      maxClassification === undefined ||
                      classificationRank(classification) <= classificationRank(maxClassification),
                  ),
                });
                return {
                  partial: found.partial,
                  summaries: found.summaries.map(({ episode, text }) => ({
                    id: episode.id,
                    day: episode.day,
                    text,
                  })),
                };
              },
            }),
      },
      ledger: options.failLedger
        ? {
            append: async () => {
              throw new Error("LEDGER_WRITE_DOWN");
            },
          }
        : repository.decisionLedger(),
      onFailure: (error) => failures.push(error),
      onSummariesFailed: (error) => summaryFailures.push(error),
    });
    const connections = repository.mcpConnections();
    const createConnection = async (
      id: string,
      readCeiling: Exclude<DataClassification, "restricted"> = "private",
    ) => (await oauth.connect({ id, readCeiling, pushPolicy: "ask", write: false })).token;
    const token = await createConnection(CONNECTION_ID, options.readCeiling);
    const app = Fastify({ logger: false });
    registerMcpReadRoute(app, mcp);
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${MCP_READ_PATH}`;
    const url = new URL(base);
    const usage = async () =>
      connections.usage({ ...scope, fromDay: "2000-01-01", toDay: "2100-01-01" });
    const connect = async (era: Era, bearer: string = token) => {
      const client = new Client(
        { name: `mcp-read-test-${era}`, version: "1.0.0" },
        era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        }),
      );
      closers.push(() => client.close());
      return client;
    };
    const ledger = () =>
      repository
        .decisionLedger()
        .list({ ...scope, kind: "external_read", since: SINCE, limit: 100 });
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      return { result, text: content?.text ?? "" };
    };
    const recordFields = async (decisionId: string) =>
      (await repository.decisionLedger().read({ ...scope, decisionId }))?.inputFields ?? [];
    const seedProfile = async (
      id: string,
      category: MemoryCategory,
      importancePermille: number,
      text: string,
      classification: DataClassification = "private",
      status: "active" | "archived" = "active",
    ) => {
      const contentRef = `payload:profile:${id}` as Parameters<typeof payloads.get>[0];
      await payloads.put(
        await adapters.payloadProtector.protect({
          ...scope,
          ref: contentRef,
          contentType: "text/plain",
          dataClassification: classification,
          plaintext: new TextEncoder().encode(text),
          createdAt: NOW,
        }),
      );
      await repository.productMemoryState().save(
        {
          id: createMemoryId(id),
          ...scope,
          revision: 1,
          status,
          contentRef,
          dataClassification: classification,
          sourceThreadId: null,
          sourceRefs: [`message-${id}`],
          inference: false,
          confidencePermille: 950,
          policyVersion: "memory-capture:v2",
          providerRecordId: null,
          lastUsedAt: null,
          updatedAt: NOW,
          attributes: { ...DEFAULT_MEMORY_ATTRIBUTES, category, importancePermille, validTo: null },
        },
        null,
      );
    };
    for (const [sourceMemoryId, classification] of ruleSources)
      await seedProfile(
        sourceMemoryId,
        "rule",
        800,
        "主人定的规则原话",
        classification,
        "archived",
      );
    return {
      url,
      token,
      clock,
      createConnection,
      connections,
      usage,
      seedProfile,
      runProjection: () => memory.runProjectionBatch(20),
      connect,
      call,
      ledger,
      recordFields,
      embeddingContexts,
      failures,
      summaryFailures,
      writer,
      sensitiveReminder,
    };
  }

  it.each(["legacy", "modern"] as const)(
    "lists the read-only tools in a fixed order to a %s client",
    async (era) => {
      const f = await setup();
      const client = await f.connect(era);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual([
        "start_here",
        "find_memories",
        "today_context",
        "rule_book",
      ]);
      expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
    },
  );

  it.each(["legacy", "modern"] as const)(
    "finds the owner's memory through the existing recall, masks secrets and records an external read (%s)",
    async (era) => {
      const f = await setup({ readCeiling: "sensitive" });
      const client = await f.connect(era);
      const found = await f.call(client, "find_memories", { query: "牙医" });
      expect(found.result.isError).not.toBe(true);
      const output = JSON.parse(found.text) as { memories: { text: string }[] };
      expect(output.memories.map(({ text }) => text)).toContain(DENTIST);
      expect(f.embeddingContexts.length).toBeGreaterThan(0);
      expect(f.embeddingContexts.every(({ aborted }) => !aborted)).toBe(true);
      const wifi = await f.call(client, "find_memories", { query: "Wi-Fi" });
      const wifiOutput = JSON.parse(wifi.text) as { memories: { text: string }[] };
      expect(wifiOutput.memories.some(({ text }) => text.includes("家里 Wi-Fi 密码"))).toBe(true);
      expect(wifi.text).not.toContain("Sunflower-8841");
      const rows = await f.ledger();
      expect(rows).toHaveLength(2);
      const dentistRow = rows.find(({ inputs }) =>
        inputs.memoryIds.includes("memory:reminder:dentist"),
      );
      expect(dentistRow).toMatchObject({
        kind: "external_read",
        outcome: "read",
        reasonCode: "find_memories",
        subjectRef: `mcp-connection:${CONNECTION_ID}`,
      });
      expect(dentistRow?.costMicros).toBeGreaterThan(0);
      expect(await f.connections.read({ ...scope, id: CONNECTION_ID })).toMatchObject({
        reportedClient: era === "modern" ? "mcp-read-test-modern" : "node",
        lastSeenAt: NOW,
      });
    },
  );

  it("returns nothing for an unrelated question and still records the read", async () => {
    const f = await setup();
    const client = await f.connect("modern");
    const found = await f.call(client, "find_memories", { query: "量子色动力学" });
    const output = JSON.parse(found.text) as { memories: unknown[] };
    expect(output.memories).toEqual([]);
    const [row] = await f.ledger();
    expect(row?.inputs.memoryIds).toEqual([]);
    expect(row?.reasonCode).toBe("find_memories");
  });

  it("gives today's date and only the reminders due within 48 hours, with secrets masked", async () => {
    const f = await setup({ readCeiling: "sensitive" });
    const client = await f.connect("modern");
    const today = await f.call(client, "today_context");
    const output = JSON.parse(today.text) as {
      today: string;
      timeZone: string;
      reminders: { text: string }[];
    };
    expect(output.today).toBe("2026-11-11");
    expect(output.timeZone).toBe(TIME_ZONE);
    const texts = output.reminders.map(({ text }) => text);
    expect(texts).toContain(DENTIST);
    expect(texts).not.toContain(TRIP);
    expect(today.text).not.toContain("Sunflower-8841");
    const recentDays = (JSON.parse(today.text) as { recentDays: { day: string; text: string }[] })
      .recentDays;
    expect(recentDays.map(({ day }) => day)).toEqual(["2026-11-10"]);
    expect(recentDays[0]?.text).toContain("京都红叶行程");
    expect(today.text).not.toContain("Maple-7712");
    expect(today.text).not.toContain(OLDER);
    expect(today.text).not.toContain("recentDaysComplete");
    const [row] = await f.ledger();
    expect(row).toMatchObject({ reasonCode: "today_context", outcome: "read" });
    expect([...(row?.inputs.memoryIds ?? [])].sort()).toEqual([
      "memory:reminder:dentist",
      "memory:reminder:wifi",
    ]);
    expect(row?.inputs).toMatchObject({
      summaryInjected: true,
      summaryIds: ["episode-yesterday"],
      summaryDays: ["2026-11-10"],
      summaryCharacters: [...YESTERDAY].length,
      summaryRead: "ok",
      summaryGenerated: 0,
    });
  });

  it("still gives today's reminders when the summaries cannot be read, and records that", async () => {
    const f = await setup({ failSummaries: true });
    const client = await f.connect("modern");
    const today = await f.call(client, "today_context");
    expect(today.result.isError).not.toBe(true);
    const output = JSON.parse(today.text) as {
      reminders: { text: string }[];
      recentDays: unknown[];
      recentDaysComplete?: boolean;
    };
    expect(output.reminders.map(({ text }) => text)).toContain(DENTIST);
    expect(output.recentDays).toEqual([]);
    expect(output.recentDaysComplete).toBe(false);
    expect(today.text).not.toContain("SUMMARY_STORE_DOWN");
    expect(f.summaryFailures).toHaveLength(1);
    expect(f.failures).toEqual([]);
    const [row] = await f.ledger();
    expect(row?.reasonCode).toBe("today_context");
    expect(row?.inputs).toMatchObject({
      summaryInjected: false,
      summaryIds: [],
      summaryRead: "failed",
    });
  });

  it("marks the days incomplete when one summary's text is gone, and records it as partial", async () => {
    const f = await setup({ loseTodaySummary: true });
    const client = await f.connect("modern");
    const today = await f.call(client, "today_context");
    expect(today.result.isError).not.toBe(true);
    const output = JSON.parse(today.text) as {
      recentDays: { day: string; text: string }[];
      recentDaysComplete?: boolean;
    };
    expect(output.recentDays.map(({ day }) => day)).toEqual(["2026-11-10"]);
    expect(output.recentDaysComplete).toBe(false);
    expect(f.summaryFailures.map((error) => (error as Error).message)).toEqual([
      "MCP_READ_SUMMARIES_INCOMPLETE",
    ]);
    expect(f.failures).toEqual([]);
    const [row] = await f.ledger();
    expect(row?.inputs).toMatchObject({
      summaryInjected: true,
      summaryIds: ["episode-yesterday"],
      summaryDays: ["2026-11-10"],
      summaryRead: "partial",
    });
  });

  it("leaves the days out and records no summary inputs when summaries are not set up", async () => {
    const f = await setup({ withoutSummaries: true });
    const client = await f.connect("modern");
    const today = await f.call(client, "today_context");
    expect(today.result.isError).not.toBe(true);
    const output = JSON.parse(today.text) as Record<string, unknown>;
    expect(output).not.toHaveProperty("recentDays");
    expect(output).not.toHaveProperty("recentDaysComplete");
    expect(output["reminders"]).toBeDefined();
    const [row] = await f.ledger();
    expect(row?.reasonCode).toBe("today_context");
    expect(row?.inputs.summaryRead).toBe("off");
    const stored = await f.recordFields(row?.id ?? "");
    expect(stored.some((field) => field.startsWith("summary"))).toBe(false);
  });

  it("records the summaries as not tried when the reminders fail first", async () => {
    const f = await setup({ failReminders: true });
    const client = await f.connect("modern");
    const today = await f.call(client, "today_context");
    expect(today.result.isError).toBe(true);
    expect(today.text).not.toContain("REMINDER_STORE_DOWN");
    const [row] = await f.ledger();
    expect(row?.reasonCode).toBe("today_context_failed");
    expect(row?.inputs).toMatchObject({
      summaryInjected: false,
      summaryIds: [],
      summaryRead: "off",
    });
    expect(f.summaryFailures).toEqual([]);
  });

  it("lists the rule book with each rule's id, revision and origin but not its expression", async () => {
    const f = await setup();
    const client = await f.connect("legacy");
    const book = await f.call(client, "rule_book");
    const output = JSON.parse(book.text) as {
      rules: { id: string; revision: number; origin: string; expression?: string }[];
    };
    expect(output.rules.map(({ id }) => id)).toEqual([
      "floor_important_sender",
      "floor_public_domain",
      "floor_money_words",
      "quiet_hours",
      "owner:a-refund",
      "owner:empty",
      "owner:immigration",
      "owner:unknown",
    ]);
    expect(output.rules.find(({ id }) => id === "owner:immigration")).toMatchObject({
      origin: "owner_setting",
      type: "mail_must_notify",
      summary: "日本入管局相关的邮件一律提醒",
      enforced: true,
      gate: "mail_item",
      outcome: "require_notify",
      parameters: { senderDomains: ["isa.go.jp"], phrases: [] },
    });
    expect(output.rules.find(({ id }) => id === "owner:a-refund")).toMatchObject({
      status: "needs_review",
      enforced: true,
      outcome: "require_whole_thread",
      parameters: { phrases: ["退款"] },
    });
    const empty = output.rules.find(({ id }) => id === "owner:empty");
    expect(empty).toMatchObject({ enforced: false, type: "mail_must_notify" });
    expect(empty).not.toHaveProperty("parameters");
    const unknown = output.rules.find(({ id }) => id === "owner:unknown");
    expect(unknown).toMatchObject({ enforced: false, summary: "看不懂的规则" });
    expect(unknown).not.toHaveProperty("gate");
    expect(unknown).not.toHaveProperty("parameters");
    expect(output.rules.every((rule) => rule.expression === undefined)).toBe(true);
    expect(output.rules.find(({ id }) => id === "quiet_hours")).toHaveProperty("quietHours");
    const [row] = await f.ledger();
    expect(row).toMatchObject({ reasonCode: "rule_book", outcome: "read" });
  });

  const listToolsBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const postWith = (target: URL, authorization: string | null, body = listToolsBody) =>
    fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization === null ? {} : { authorization }),
      },
      body,
    });

  it("rejects requests without a valid access token, points to the sign-in details, and records nothing", async () => {
    const f = await setup();
    const bare = await postWith(f.url, null);
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe(
      [
        "Bearer",
        'resource_metadata="https://agent.example.test/.well-known/oauth-protected-resource/api/mcp/v1", scope="himawari:read himawari:write"',
      ].join(" "),
    );
    for (const authorization of [
      `Bearer ${"m".repeat(43)}`,
      `Bearer ${f.token}x`,
      `bearer ${f.token}`,
      `Basic ${f.token}`,
      f.token,
    ]) {
      const rejected = await postWith(f.url, authorization);
      expect(rejected.status).toBe(401);
      if (authorization.startsWith("Bearer "))
        expect(rejected.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    await expect(f.connect("legacy", "m".repeat(43))).rejects.toThrow();
    await expect(f.connect("modern", "m".repeat(43))).rejects.toThrow();
    expect(await f.ledger()).toEqual([]);
    expect(f.failures).toEqual([]);
  });

  it("turns a token away once it expires", async () => {
    const f = await setup();
    expect((await postWith(f.url, `Bearer ${f.token}`)).status).toBe(200);
    f.clock.advance(3_600_001);
    expect((await postWith(f.url, `Bearer ${f.token}`)).status).toBe(401);
  });

  it("answers 503, not 401, when the token store cannot be read, and limits it like a signed-in request", async () => {
    const f = await setup({ failTokens: true });
    for (let attempt = 0; attempt < 30; attempt += 1)
      expect((await postWith(f.url, `Bearer ${f.token}`)).status).toBe(503);
    expect((await postWith(f.url, `Bearer ${f.token}`)).status).toBe(429);
    expect(f.failures).toHaveLength(30);
  });

  it("answers 429 after 30 signed-in requests a minute, without using up the rejected-request allowance", async () => {
    const f = await setup();
    for (let attempt = 0; attempt < 30; attempt += 1)
      expect((await postWith(f.url, `Bearer ${f.token}`)).status).not.toBe(429);
    expect((await postWith(f.url, `Bearer ${f.token}`)).status).toBe(429);
    expect((await postWith(f.url, `Bearer ${"m".repeat(43)}`)).status).toBe(401);
  });

  it("answers 429 after 60 rejected tokens a minute and still serves a valid token", async () => {
    const f = await setup();
    const forged = `Bearer ${"m".repeat(43)}`;
    for (let attempt = 0; attempt < 60; attempt += 1)
      expect((await postWith(f.url, forged)).status).toBe(401);
    expect((await postWith(f.url, forged)).status).toBe(429);
    const modern = await f.connect("modern");
    expect((await modern.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("answers a failed read as a tool error and records it as failed", async () => {
    const f = await setup({ failRecall: true });
    const client = await f.connect("modern");
    const found = await f.call(client, "find_memories", { query: "牙医" });
    expect(found.result.isError).toBe(true);
    expect(found.text).not.toContain("VECTOR_INDEX_DOWN");
    const [row] = await f.ledger();
    expect(row).toMatchObject({ reasonCode: "find_memories_failed", outcome: "read" });
    expect(row?.costMicros).toBeGreaterThan(0);
    expect(f.failures.length).toBeGreaterThan(0);
  });

  it("[T6] tells the caller how to fix a date that is not on the calendar and records the read as failed", async () => {
    const f = await setup();
    const client = await f.connect("modern");
    const fixed = await f.call(client, "find_memories", {
      query: "牙医",
      from: "2026-02-30",
      to: "2026-03-02",
    });
    expect(fixed.result.isError).toBe(true);
    expect(fixed.text).toContain("MEMORY_RECALL_INPUT_INVALID");
    expect(fixed.text).toContain("改正后再查一次");
    expect((await f.ledger()).map(({ reasonCode, outcome }) => [reasonCode, outcome])).toEqual([
      ["find_memories_failed", "read"],
    ]);
    const history = await f.call(client, "find_memories", { query: "牙医", includeHistory: true });
    expect(history.result.isError).not.toBe(true);
    expect((await f.ledger()).map(({ reasonCode }) => reasonCode).sort()).toEqual([
      "find_memories",
      "find_memories_failed",
    ]);
  });

  it("withholds the result when the read cannot be recorded", async () => {
    const f = await setup({ failLedger: true });
    const client = await f.connect("modern");
    const found = await f.call(client, "today_context");
    expect(found.result.isError).toBe(true);
    expect(found.text).not.toContain("牙医");
    expect(found.text).not.toContain("LEDGER_WRITE_DOWN");
    expect(f.failures.length).toBeGreaterThan(0);
  });

  describe("[P5-B] every read tool honours the read ceiling", () => {
    const memoriesOf = (text: string) =>
      (JSON.parse(text) as { memories: { text: string }[] }).memories.map(({ text }) => text);

    it("find_memories leaves a sensitive memory out under the default ceiling and shows it when allowed", async () => {
      const closed = await setup();
      const closedClient = await closed.connect("modern");
      const hidden = await closed.call(closedClient, "find_memories", { query: "Wi-Fi" });
      expect(memoriesOf(hidden.text).some((text) => text.includes("家里 Wi-Fi 密码"))).toBe(false);
      const [closedRow] = await closed.ledger();
      expect(closedRow?.inputs.memoryIds).not.toContain("memory:reminder:wifi");
      const open = await setup({ readCeiling: "sensitive" });
      const openClient = await open.connect("modern");
      const shown = await open.call(openClient, "find_memories", { query: "Wi-Fi" });
      expect(memoriesOf(shown.text).some((text) => text.includes("家里 Wi-Fi 密码"))).toBe(true);
    });

    it("REVERSE: find_memories under a public ceiling gives none of the private memories", async () => {
      const f = await setup({ readCeiling: "public" });
      const client = await f.connect("modern");
      const found = await f.call(client, "find_memories", { query: "牙医" });
      expect(memoriesOf(found.text)).not.toContain(DENTIST);
    });

    it("today_context leaves sensitive reminders and day summaries out under the default ceiling", async () => {
      const closed = await setup({ sensitiveSummary: true });
      const closedClient = await closed.connect("modern");
      const hidden = await closed.call(closedClient, "today_context");
      expect(hidden.text).toContain("牙医");
      expect(hidden.text).not.toContain("Wi-Fi");
      expect(hidden.text).not.toContain("慢性病");
      const [row] = await closed.ledger();
      expect(row?.inputs.memoryIds).toEqual(["memory:reminder:dentist"]);
      const open = await setup({ sensitiveSummary: true, readCeiling: "sensitive" });
      const openClient = await open.connect("modern");
      const shown = await open.call(openClient, "today_context");
      expect(shown.text).toContain("Wi-Fi");
      expect(shown.text).toContain("慢性病");
    });

    it("rule_book hides rules whose source sentence is above the ceiling, and rules with no known source", async () => {
      const closed = await setup({ hiddenRules: true });
      const closedClient = await closed.connect("modern");
      const hidden = await closed.call(closedClient, "rule_book");
      expect(hidden.text).not.toContain("心理诊所");
      expect(hidden.text).not.toContain("找不到出处");
      expect(hidden.text).toContain("日本入管局");
      const open = await setup({ hiddenRules: true, readCeiling: "sensitive" });
      const openClient = await open.connect("modern");
      const shown = await open.call(openClient, "rule_book");
      expect(shown.text).toContain("心理诊所");
      expect(shown.text).not.toContain("找不到出处");
    });

    it("REVERSE: rule_book under a public ceiling gives no owner rules and no private rule parameters", async () => {
      const f = await setup({ readCeiling: "public" });
      const client = await f.connect("modern");
      const output = JSON.parse((await f.call(client, "rule_book")).text) as {
        rules: Record<string, unknown>[];
      };
      expect(output.rules.map(({ id }) => id)).toEqual([
        "floor_important_sender",
        "floor_public_domain",
        "floor_money_words",
        "quiet_hours",
      ]);
      expect(output.rules[0]).not.toHaveProperty("importantSenders");
      expect(output.rules[3]).not.toHaveProperty("quietHours");
    });

    it("start_here leaves rules from sensitive sentences out of the rule summaries under the default ceiling", async () => {
      const closed = await setup({ hiddenRules: true });
      const closedClient = await closed.connect("modern");
      const hidden = JSON.parse((await closed.call(closedClient, "start_here")).text) as StartHere;
      expect(hidden.rules.items).toEqual(["退款邮件先读完整串", "日本入管局相关的邮件一律提醒"]);
      const open = await setup({ hiddenRules: true, readCeiling: "sensitive" });
      const openClient = await open.connect("modern");
      const shown = JSON.parse((await open.call(openClient, "start_here")).text) as StartHere;
      expect(shown.rules.items).toContain("心理诊所的邮件一律提醒");
      expect(shown.rules.items).not.toContain("找不到出处的规则");
    });

    it("rule_book gives the parameters a built-in rule declares, only within the ceiling", async () => {
      const extra = {
        id: "floor_project_sender",
        revision: 2,
        gate: "mail_item" as const,
        expression: "false",
        outcome: "raise_floor" as const,
        origin: "owner_setting" as const,
        source: "测试用的内置规则",
        status: "active" as const,
        examples: [],
        sharedParameters: {
          classification: "private" as const,
          values: { projects: ["京都"], id: "spoofed", revision: 9 },
        },
      };
      const withRule: NonNullable<McpReadSources["ruleBook"]> = (settings) => [
        ...ruleBookFor(settings),
        extra,
      ];
      const f = await setup({ ruleBook: withRule });
      const client = await f.connect("modern");
      const output = JSON.parse((await f.call(client, "rule_book")).text) as {
        rules: Record<string, unknown>[];
      };
      expect(output.rules.find(({ id }) => id === "floor_project_sender")).toMatchObject({
        projects: ["京都"],
        revision: 2,
      });
      const closed = await setup({ ruleBook: withRule, readCeiling: "public" });
      const closedClient = await closed.connect("modern");
      const hidden = JSON.parse((await closed.call(closedClient, "rule_book")).text) as {
        rules: Record<string, unknown>[];
      };
      expect(hidden.rules.find(({ id }) => id === "floor_project_sender")).not.toHaveProperty(
        "projects",
      );
    });

    it("refuses to register a read tool that does not declare its read ceiling", async () => {
      const bare = {
        name: "peek",
        description: "看一眼",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: async () => ({ output: {}, memoryIds: [] }),
      } as unknown as McpReadToolEntry;
      await expect(setup({ readTools: [...MCP_READ_TOOLS, bare] })).rejects.toThrow(
        `${MCP_READ_TOOL_CEILING_MISSING}:peek`,
      );
      await expect(
        setup({ readTools: [...MCP_READ_TOOLS, { ...bare, readCeiling: { sources: [] } }] }),
      ).rejects.toThrow(MCP_READ_TOOL_CEILING_MISSING);
      await expect(
        setup({
          readTools: [
            ...MCP_READ_TOOLS,
            { ...bare, readCeiling: { sources: ["settings"] } } as unknown as McpReadToolEntry,
          ],
        }),
      ).rejects.toThrow(MCP_READ_TOOL_CEILING_MISSING);
    });

    it("refuses a read tool whose name is reused, taken by a write tool or cannot be recorded", async () => {
      const [first] = MCP_READ_TOOLS;
      if (!first) throw new Error("MCP_READ_TOOLS_EMPTY");
      await expect(setup({ readTools: [...MCP_READ_TOOLS, first] })).rejects.toThrow(
        "MCP_READ_TOOL_DUPLICATE:start_here",
      );
      await expect(
        setup({ readTools: [...MCP_READ_TOOLS, { ...first, name: "propose_rule" }] }),
      ).rejects.toThrow("MCP_READ_TOOL_DUPLICATE:propose_rule");
      await expect(
        setup({ readTools: [...MCP_READ_TOOLS, { ...first, name: "rule_book_failed" }] }),
      ).rejects.toThrow("MCP_READ_TOOL_DUPLICATE:rule_book_failed");
      await expect(
        setup({
          readTools: [
            { ...first, name: "peek_failed" },
            { ...first, name: "peek" },
          ],
        }),
      ).rejects.toThrow("MCP_READ_TOOL_DUPLICATE:peek");
      await expect(
        setup({ readTools: [...MCP_READ_TOOLS, { ...first, name: "p".repeat(58) }] }),
      ).rejects.toThrow("MCP_READ_TOOL_NAME_INVALID");
      await expect(
        setup({ readTools: [...MCP_READ_TOOLS, { ...first, name: "Peek Tool" }] }),
      ).rejects.toThrow("MCP_READ_TOOL_NAME_INVALID");
      const longest = { ...first, name: "p".repeat(57) };
      const f = await setup({ readTools: [...MCP_READ_TOOLS, longest] });
      const client = await f.connect("modern");
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(longest.name);
    });

    it("a newly registered read tool reads only through its declared sources, bounded by the ceiling", async () => {
      const peek: McpReadToolEntry = {
        name: "peek",
        description: "看一眼提醒",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        readCeiling: { sources: ["reminders"] },
        run: async ({ read }) => {
          const listed = await read.reminders?.(48 * 3_600_000);
          if (read.recall) throw new Error("RECALL_LEAKED_TO_PEEK");
          return {
            output: { texts: (listed?.reminders ?? []).map(({ text }) => text) },
            memoryIds: [],
          };
        },
      };
      const f = await setup({ readTools: [...MCP_READ_TOOLS, peek] });
      const client = await f.connect("modern");
      const result = await f.call(client, "peek");
      expect(result.result.isError).not.toBe(true);
      expect(result.text).toContain("牙医");
      expect(result.text).not.toContain("Wi-Fi");
      const [row] = await f.ledger();
      expect(row?.reasonCode).toBe("peek");
    });
  });

  describe("[P5-A] start_here and auto lookup", () => {
    it("gives the profile, the rule summaries and today's context in a fixed order, and the server carries instructions", async () => {
      const f = await setup();
      await f.seedProfile("memory-name", "identity", 800, "主人叫 Andy，住在东京");
      await f.seedProfile("memory-tea", "preference", 700, "只喝无糖绿茶");
      const client = await f.connect("modern");
      expect(client.getInstructions()).toContain("start_here");
      const first = await f.call(client, "start_here");
      expect(first.result.isError).not.toBe(true);
      const output = JSON.parse(first.text) as StartHere;
      expect(Object.keys(output)).toEqual(["profile", "rules", "today"]);
      expect(output["profile"].sections.flatMap((section) => section.items)).toEqual([
        expect.stringContaining("主人叫 Andy，住在东京"),
        expect.stringContaining("只喝无糖绿茶"),
      ]);
      expect(output["profile"].version).toMatch(/^[0-9a-f]{12}$/u);
      expect(output["rules"].items).toEqual(["退款邮件先读完整串", "日本入管局相关的邮件一律提醒"]);
      expect(first.text).not.toContain("撤销了的规则");
      expect(output["rules"].note).toContain("必定执行");
      expect(first.text).not.toContain("owner:");
      expect(first.text).not.toContain("memory-name");
      expect(first.text).not.toContain("senderDomains");
      expect(output["today"].today).toBe("2026-11-11");
      expect(output["today"].recentDays.length).toBeGreaterThan(0);
      const second = await f.call(client, "start_here");
      expect(second.text).toBe(first.text);
      const [row] = await f.ledger();
      expect(row).toMatchObject({ reasonCode: "start_here", outcome: "read" });
      expect(row?.inputs.memoryIds).toEqual(
        expect.arrayContaining(["memory-name", "memory-tea", "memory:reminder:dentist"]),
      );
      expect(row?.inputs.summaryRead).toBe("ok");
    });

    it("keeps the stable part the same when only today's part changes", async () => {
      const f = await setup();
      await f.seedProfile("memory-name", "identity", 800, "主人叫 Andy");
      const client = await f.connect("modern");
      const before = JSON.parse((await f.call(client, "start_here")).text);
      await f.writer.create({
        key: "extra",
        text: "明天下午三点开会",
        due: "2026-11-12T15:00",
        repeat: "none",
      });
      const after = JSON.parse((await f.call(client, "start_here")).text);
      expect(after.today).not.toEqual(before.today);
      expect(JSON.stringify(after.profile)).toBe(JSON.stringify(before.profile));
      expect(JSON.stringify(after.rules)).toBe(JSON.stringify(before.rules));
    });

    it("holds sensitive memories back by default and shows them only when the ceiling allows", async () => {
      const secretLine = "主人正在治疗一种慢性病";
      const hidden = await setup();
      await hidden.seedProfile("memory-health", "identity", 900, secretLine, "sensitive");
      const hiddenClient = await hidden.connect("modern");
      expect((await hidden.call(hiddenClient, "start_here")).text).not.toContain(secretLine);
      const open = await setup({ readCeiling: "sensitive" });
      await open.seedProfile("memory-health", "identity", 900, secretLine, "sensitive");
      const openClient = await open.connect("modern");
      expect((await open.call(openClient, "start_here")).text).toContain(secretLine);
    });

    it("REVERSE: leaves sensitive reminders and sensitive day summaries out of today under the default ceiling", async () => {
      const hidden = await setup({ sensitiveSummary: true });
      const hiddenClient = await hidden.connect("modern");
      const closed = await hidden.call(hiddenClient, "start_here");
      expect(closed.text).not.toContain("Wi-Fi");
      expect(closed.text).not.toContain("慢性病");
      expect(closed.text).toContain("牙医");
      const open = await setup({ sensitiveSummary: true, readCeiling: "sensitive" });
      const openClient = await open.connect("modern");
      const opened = await open.call(openClient, "start_here");
      expect(opened.text).toContain("Wi-Fi");
      expect(opened.text).toContain("慢性病");
    });

    it("fills today with eligible reminders when reminders saved as sensitive come first", async () => {
      const f = await setup();
      for (let index = 0; index < 22; index += 1)
        await f.sensitiveReminder(
          `secret-${index}`,
          `家里 Wi-Fi 密码：Key-${index}-abc`,
          `2026-11-12T08:${String(index).padStart(2, "0")}`,
        );
      const client = await f.connect("modern");
      const output = JSON.parse((await f.call(client, "start_here")).text) as StartHere;
      const texts = (output.today as unknown as { reminders: { text: string }[] }).reminders.map(
        ({ text }) => text,
      );
      expect(texts).toContain(DENTIST);
      expect(texts.some((text) => text.includes("Wi-Fi"))).toBe(false);
    });

    it("says there may be more reminders when the scan ends before enough eligible ones are found", async () => {
      const f = await setup();
      for (let index = 0; index < 201; index += 1)
        await f.writer.create({
          key: `crowd-${index}`,
          text: `家里 Wi-Fi 密码：Crowd-${index}-abc`,
          due: `2026-11-12T${String(Math.floor(index / 60) + 4).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
          repeat: "none",
        });
      const client = await f.connect("modern");
      const output = JSON.parse((await f.call(client, "start_here")).text) as {
        today: { more?: boolean };
      };
      expect(output.today.more).toBe(true);
    });

    it("keeps the profile version free of masked secrets", async () => {
      const versionFor = async (secret: string) => {
        const f = await setup();
        await f.seedProfile("memory-note", "preference", 800, `备用门禁密码：${secret}`);
        const client = await f.connect("modern");
        const output = JSON.parse((await f.call(client, "start_here")).text) as StartHere;
        return output.profile.version;
      };
      expect(await versionFor("Maple-7712-x")).toBe(await versionFor("Birch-1983-y"));
    });

    it("stays inside the profile budget and says how many lines were left out", async () => {
      const f = await setup();
      for (let index = 0; index < 40; index += 1)
        await f.seedProfile(
          `memory-fact-${String(index).padStart(2, "0")}`,
          "preference",
          700,
          `偏好${index}：${"很长的说明".repeat(20)}`,
        );
      const client = await f.connect("modern");
      const output = JSON.parse((await f.call(client, "start_here")).text) as StartHere;
      const lines = output.profile.sections.flatMap((section) => section.items);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThan(40);
      expect(lines.join("").length).toBeLessThanOrEqual(2000);
      expect(output.profile.omitted).toContain(`${40 - lines.length} 条`);
    });

    it("changes the profile version when only the count of left-out lines changes", async () => {
      const versionWith = async (extra: boolean) => {
        const f = await setup();
        for (let index = 0; index < 40; index += 1)
          await f.seedProfile(
            `memory-fact-${String(index).padStart(2, "0")}`,
            "preference",
            700,
            `偏好${index}：${"很长的说明".repeat(20)}`,
          );
        if (extra)
          await f.seedProfile(
            "memory-fact-zz",
            "preference",
            650,
            `偏好额外：${"很长".repeat(400)}`,
          );
        const client = await f.connect("modern");
        return JSON.parse((await f.call(client, "start_here")).text) as StartHere;
      };
      const without = await versionWith(false);
      const withExtra = await versionWith(true);
      expect(JSON.stringify(withExtra.profile.sections)).toBe(
        JSON.stringify(without.profile.sections),
      );
      expect(withExtra.profile.omitted).not.toBe(without.profile.omitted);
      expect(withExtra.profile.version).not.toBe(without.profile.version);
      expect((await versionWith(false)).profile.version).toBe(without.profile.version);
    });

    it("answers a tool error and records start_here as failed when the profile cannot be read", async () => {
      const f = await setup({ failProfile: true });
      const client = await f.connect("modern");
      const result = await f.call(client, "start_here");
      expect(result.result.isError).toBe(true);
      expect(result.text).not.toContain("PROFILE_STORE_DOWN");
      expect(result.text).not.toContain("牙医");
      const [row] = await f.ledger();
      expect(row).toMatchObject({ reasonCode: "start_here_failed", outcome: "read" });
      expect(row?.inputs.memoryIds).toEqual([]);
      expect(f.failures.length).toBeGreaterThan(0);
    });

    it("keeps a value masked by today's part out of the profile version", async () => {
      const versionFor = async (code: string, named: boolean) => {
        const f = await setup({ readCeiling: "sensitive" });
        await f.seedProfile("memory-number", "preference", 900, `常用的号码 ${code}`);
        await f.writer.create({
          key: "login-code",
          text: named ? `登录验证码是 ${code}` : "明天登录一下网银",
          due: "2026-11-12T09:00",
          repeat: "none",
        });
        const client = await f.connect("modern");
        return (JSON.parse((await f.call(client, "start_here")).text) as StartHere).profile.version;
      };
      expect(await versionFor("482913", true)).toBe(await versionFor("517204", true));
      expect(await versionFor("482913", false)).not.toBe(await versionFor("517204", false));
    });

    it("masks a code named in today's part where the same value stands alone in the profile, through a real start_here call", async () => {
      const f = await setup({ readCeiling: "sensitive" });
      await f.seedProfile("memory-number", "preference", 900, "常用的号码 482913");
      await f.writer.create({
        key: "login-code",
        text: "登录验证码是 482913",
        due: "2026-11-12T09:00",
        repeat: "none",
      });
      const client = await f.connect("modern");
      const result = await f.call(client, "start_here");
      expect(result.result.isError).not.toBe(true);
      expect(result.text).toContain("常用的号码");
      expect(result.text).toContain("登录验证码");
      expect(result.text).not.toContain("482913");
    });

    it("auto returns at most three memories where a plain lookup returns more", async () => {
      const f = await setup();
      for (let index = 0; index < 5; index += 1)
        await f.writer.create({
          key: `dentist-extra-${index}`,
          text: `牙医第${index}次复诊的注意事项`,
          due: "2026-11-20T10:00",
          repeat: "none",
        });
      await f.runProjection();
      const client = await f.connect("modern");
      const plain = JSON.parse(
        (await f.call(client, "find_memories", { query: "牙医", limit: 10 })).text,
      ) as { memories: unknown[] };
      expect(plain.memories.length).toBeGreaterThan(3);
      const found = await f.call(client, "find_memories", { query: "牙医", limit: 10, auto: true });
      const output = JSON.parse(found.text) as { memories: { text: string }[] };
      expect(output.memories.length).toBe(3);
    });

    it("REVERSE: auto on an unrelated question returns nothing at all, without the empty-result note", async () => {
      const f = await setup();
      const client = await f.connect("modern");
      const found = await f.call(client, "find_memories", { query: "量子色动力学", auto: true });
      const output = JSON.parse(found.text) as Record<string, unknown>;
      expect(output["memories"]).toEqual([]);
      expect(output["conversations"]).toEqual([]);
      expect(output).not.toHaveProperty("note");
      const plain = JSON.parse(
        (await f.call(client, "find_memories", { query: "量子色动力学" })).text,
      ) as Record<string, unknown>;
      expect(plain).toHaveProperty("note");
    });

    it("rejects a non-boolean auto", async () => {
      const f = await setup();
      const client = await f.connect("modern");
      const found = await f.call(client, "find_memories", { query: "牙医", auto: "yes" });
      expect(found.result.isError).toBe(true);
    });
  });

  describe("[P5-B] each connection has its own token, ceiling and counts", () => {
    const post = async (target: URL, token: string | null, body: unknown) =>
      fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const counted = (
      rows: readonly {
        connectionId: string;
        tool: string;
        auto: boolean;
        counter: string;
        value: number;
      }[],
    ) =>
      Object.fromEntries(
        rows.map((row) => [
          `${row.connectionId}/${row.tool}/${row.auto ? "auto" : "model"}/${row.counter}`,
          row.value,
        ]),
      );

    it("rejects a paused connection with 403 and a revoked one with 401 at once, and a resumed one works again", async () => {
      const f = await setup();
      expect((await post(f.url, f.token, listTools)).status).toBe(200);
      await f.connections.change({ ...scope, id: CONNECTION_ID, updatedAt: NOW, status: "paused" });
      expect((await post(f.url, f.token, listTools)).status).toBe(403);
      await f.connections.change({ ...scope, id: CONNECTION_ID, updatedAt: NOW, status: "active" });
      expect((await post(f.url, f.token, listTools)).status).toBe(200);
      await f.connections.change({
        ...scope,
        id: CONNECTION_ID,
        updatedAt: NOW,
        status: "revoked",
      });
      expect((await post(f.url, f.token, listTools)).status).toBe(401);
      expect(JSON.stringify(f.failures)).not.toContain(f.token);
      expect(await f.usage()).toEqual([]);
    });

    it("keeps one connection's ceiling and counts apart from another's", async () => {
      const f = await setup({ readCeiling: "sensitive" });
      const otherToken = await f.createConnection("conn-public", "public");
      const open = await f.connect("modern");
      const closed = await f.connect("modern", otherToken);
      const wifi = (text: string) => text.includes("家里 Wi-Fi 密码");
      expect(wifi((await f.call(open, "find_memories", { query: "Wi-Fi" })).text)).toBe(true);
      expect(wifi((await f.call(closed, "find_memories", { query: "Wi-Fi" })).text)).toBe(false);
      await f.call(closed, "today_context");
      const rows = counted(await f.usage());
      expect(rows[`${CONNECTION_ID}/find_memories/model/calls`]).toBe(1);
      expect(rows[`conn-public/find_memories/model/calls`]).toBe(1);
      expect(rows[`conn-public/today_context/model/calls`]).toBe(1);
      expect(rows[`${CONNECTION_ID}/today_context/model/calls`]).toBeUndefined();
      expect((await f.ledger()).map(({ subjectRef }) => subjectRef).sort()).toEqual([
        "mcp-connection:conn-mcp-read",
        "mcp-connection:conn-public",
        "mcp-connection:conn-public",
      ]);
    });

    it("counts an empty automatic lookup without a decision record, and records one that delivered", async () => {
      const f = await setup();
      const client = await f.connect("modern");
      await f.call(client, "find_memories", { query: "量子色动力学", auto: true });
      expect(await f.ledger()).toEqual([]);
      await f.call(client, "find_memories", { query: "牙医", auto: true });
      expect(await f.ledger()).toHaveLength(1);
      await f.call(client, "find_memories", { query: "量子色动力学" });
      expect(await f.ledger()).toHaveLength(2);
      expect(counted(await f.usage())).toEqual({
        [`${CONNECTION_ID}/find_memories/auto/calls`]: 2,
        [`${CONNECTION_ID}/find_memories/auto/empty`]: 1,
        [`${CONNECTION_ID}/find_memories/auto/delivered`]: 1,
        [`${CONNECTION_ID}/find_memories/model/calls`]: 1,
        [`${CONNECTION_ID}/find_memories/model/empty`]: 1,
      });
    });

    it("counts a recall its time-range check turns away for a bad date as failed, not delivered", async () => {
      const f = await setup();
      const client = await f.connect("modern");
      const fixed = await f.call(client, "find_memories", {
        query: "牙医",
        from: "2026-02-30",
        to: "2026-03-02",
      });
      expect(fixed.result.isError).toBe(true);
      expect(fixed.text).toContain("MEMORY_RECALL_INPUT_INVALID");
      expect(counted(await f.usage())).toEqual({
        [`${CONNECTION_ID}/find_memories/model/calls`]: 1,
        [`${CONNECTION_ID}/find_memories/model/failed`]: 1,
      });
    });

    it("counts a call the input check turns away as a failed call", async () => {
      const f = await setup();
      const client = await f.connect("modern");
      const found = await f.call(client, "find_memories", { query: "牙医", auto: "yes" });
      expect(found.result.isError).toBe(true);
      expect(counted(await f.usage())).toEqual({
        [`${CONNECTION_ID}/find_memories/model/calls`]: 1,
        [`${CONNECTION_ID}/find_memories/model/failed`]: 1,
      });
      expect(await f.ledger()).toEqual([]);
    });

    it("counts a failed read as failed and not as delivered", async () => {
      const f = await setup({ failRecall: true });
      const client = await f.connect("modern");
      await f.call(client, "find_memories", { query: "牙医" });
      expect(counted(await f.usage())).toEqual({
        [`${CONNECTION_ID}/find_memories/model/calls`]: 1,
        [`${CONNECTION_ID}/find_memories/model/failed`]: 1,
      });
    });

    it("limits automatic lookups on their own allowance and counts the refusals", async () => {
      const f = await setup({ hookReadsPerMinute: 2 });
      const owner = f.token;
      const client = await f.connect("modern");
      const auto = {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "find_memories", arguments: { query: "牙医", auto: true } },
      };
      await f.call(client, "find_memories", { query: "牙医", auto: true });
      await f.call(client, "find_memories", { query: "牙医", auto: true });
      expect((await post(f.url, owner, auto)).status).toBe(429);
      const plain = await f.call(client, "find_memories", { query: "牙医" });
      expect(plain.result.isError).not.toBe(true);
      expect(counted(await f.usage())).toMatchObject({
        [`${CONNECTION_ID}/find_memories/auto/calls`]: 2,
        [`${CONNECTION_ID}/find_memories/auto/rate_limited`]: 1,
        [`${CONNECTION_ID}/find_memories/model/calls`]: 1,
      });
    });

    it("never writes the token into failures, records, counts or replies", async () => {
      const f = await setup({ failRecall: true });
      const owner = f.token;
      const client = await f.connect("modern");
      await f.call(client, "find_memories", { query: "牙医" });
      await f.call(client, "today_context");
      const replies = [
        await post(f.url, owner, { jsonrpc: "2.0", id: 1, method: "nope", params: {} }),
        await post(f.url, null, listTools),
        await fetch(f.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
          body: "{",
        }),
        await fetch(f.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
          body: JSON.stringify({ padding: "x".repeat(70_000) }),
        }),
      ];
      expect(replies.at(-1)?.status).toBe(413);
      const bodies = await Promise.all(replies.map(async (reply) => reply.text()));
      await f.connections.change({ ...scope, id: CONNECTION_ID, updatedAt: NOW, status: "paused" });
      bodies.push(await (await post(f.url, owner, listTools)).text());
      const everything = JSON.stringify({
        failures: f.failures.map((failure) =>
          failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure,
        ),
        ledger: await f.ledger(),
        usage: await f.usage(),
        connection: await f.connections.read({ ...scope, id: CONNECTION_ID }),
        bodies,
      });
      expect(everything).toContain(CONNECTION_ID);
      expect(everything).not.toContain(f.token);
      expect(everything).not.toContain(createHash("sha256").update(f.token).digest("hex"));
    });
  });
});
