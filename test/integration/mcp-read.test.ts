import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableMemoryService } from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
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
  MCP_READ_TOOL_NAMES,
  ProductionMcpRead,
  registerMcpReadRoute,
} from "../../apps/agent-service/src/production-mcp-read.ts";
import { ProductionMemoryRecall } from "../../apps/agent-service/src/production-memory-recall.ts";
import { ProductionReminderWriter } from "../../apps/agent-service/src/production-reminder-writer.ts";
import { createMcpAccess } from "../../apps/agent-service/test/fixtures/mcp-access.ts";
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

const embedder: Embedder = {
  model: "fixture-embedding",
  dimensions: 4,
  async embed(text: string) {
    const hits = TOPICS.map((topic) => (text.includes(topic) ? 1 : 0));
    return new Float32Array([...hits, hits.some(Boolean) ? 0 : 1]);
  },
};

type Era = "legacy" | "modern";

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
    await writer.create({ key: "wifi", text: WIFI, due: "2026-11-12T20:00", repeat: "none" });
    await writer.create({ key: "trip", text: TRIP, due: "2026-11-13T13:00", repeat: "none" });
    await memory.runProjectionBatch(10);
    const episodeStore = repository.memoryEpisodes();
    const seedSummary = async (id: string, day: string, text: string, sequence: number) => {
      const contentRef = `payload:episode:${id}` as Parameters<typeof payloads.get>[0];
      await payloads.put(
        await adapters.payloadProtector.protect({
          ...scope,
          ref: contentRef,
          contentType: "text/plain",
          dataClassification: "private",
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
        dataClassification: "private",
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
    const access = await createMcpAccess(() => new Date(clock.now()));
    const mcp = new ProductionMcpRead({
      scope,
      clock,
      access: access.verifier,
      timeZone: TIME_ZONE,
      requestTimeoutMs: 30_000,
      sources: {
        recall: (args, within) => recall.recallOutsideRun(args, within),
        embedOutsideRun: async (context, operation) => {
          embeddingContexts.push({
            deadlineAt: context.deadlineAt,
            aborted: context.signal.aborted,
          });
          context.costMicros += 7;
          return operation();
        },
        reminders: async (windowMs) => {
          if (options.failReminders) throw new Error("REMINDER_STORE_DOWN");
          return writer.list(windowMs);
        },
        settings: () => settingsStore.readSettings(scope),
        ...(options.withoutSummaries
          ? {}
          : {
              summaries: async ({ days, limit }: { days: number; limit: number }) => {
                if (options.failSummaries) throw new Error("SUMMARY_STORE_DOWN");
                const found = await episodes.recent({
                  ...scope,
                  days,
                  limit,
                  allowedClassifications: ["public", "private", "sensitive"],
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
    const app = Fastify({ logger: false });
    registerMcpReadRoute(app, mcp);
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${MCP_READ_PATH}`,
    );
    const connect = async (era: Era, assertion?: string) => {
      const client = new Client(
        { name: `mcp-read-test-${era}`, version: "1.0.0" },
        era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: { "cf-access-jwt-assertion": assertion ?? (await access.sign()) },
          },
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
    return {
      url,
      connect,
      access,
      call,
      ledger,
      recordFields,
      embeddingContexts,
      failures,
      summaryFailures,
      writer,
    };
  }

  it.each(["legacy", "modern"] as const)(
    "lists the three read-only tools in a fixed order to a %s client",
    async (era) => {
      const f = await setup();
      const client = await f.connect(era);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual([...MCP_READ_TOOL_NAMES]);
      expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
    },
  );

  it.each(["legacy", "modern"] as const)(
    "finds the owner's memory through the existing recall, masks secrets and records an external read (%s)",
    async (era) => {
      const f = await setup();
      const client = await f.connect(era);
      const found = await f.call(client, "find_memories", { query: "牙医" });
      expect(found.result.isError).not.toBe(true);
      const output = JSON.parse(found.text) as { memories: { text: string }[] };
      expect(output.memories.map(({ text }) => text)).toContain(DENTIST);
      expect(f.embeddingContexts.length).toBeGreaterThan(0);
      expect(f.embeddingContexts.every(({ aborted }) => !aborted)).toBe(true);
      const wifi = await f.call(client, "find_memories", { query: "Wi-Fi" });
      expect(wifi.text).toContain("Wi-Fi");
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
        subjectRef: `mcp-client:${era === "modern" ? "mcp-read-test-modern" : "node"}`,
      });
      expect(dentistRow?.costMicros).toBeGreaterThan(0);
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
    const f = await setup();
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
    ]);
    expect(output.rules.every((rule) => rule.expression === undefined)).toBe(true);
    expect(output.rules.find(({ id }) => id === "quiet_hours")).toHaveProperty("quietHours");
    const [row] = await f.ledger();
    expect(row).toMatchObject({ reasonCode: "rule_book", outcome: "read" });
  });

  it("rejects requests without a valid Cloudflare Access assertion, and records nothing", async () => {
    const f = await setup();
    const bare = await fetch(f.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBeNull();
    const withBearer = await fetch(f.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: ["Bearer", "m".repeat(40)].join(" "),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(withBearer.status).toBe(401);
    await expect(f.connect("legacy", await f.access.signWithForeignKey())).rejects.toThrow();
    await expect(
      f.connect("modern", await f.access.sign({ audience: "another-app" })),
    ).rejects.toThrow();
    await expect(
      f.connect("modern", await f.access.sign({ expiresInSeconds: -120 })),
    ).rejects.toThrow();
    expect(await f.ledger()).toEqual([]);
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

  it("withholds the result when the read cannot be recorded", async () => {
    const f = await setup({ failLedger: true });
    const client = await f.connect("modern");
    const found = await f.call(client, "today_context");
    expect(found.result.isError).toBe(true);
    expect(found.text).not.toContain("牙医");
    expect(found.text).not.toContain("LEDGER_WRITE_DOWN");
    expect(f.failures.length).toBeGreaterThan(0);
  });
});
