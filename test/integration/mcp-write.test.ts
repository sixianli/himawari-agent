import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileRuleExpression,
  DurableMemoryService,
  EXTERNAL_PROPOSAL_REASON_CODES,
  enforceableOwnerRule,
  mailItemFacts,
  OwnerRuleReplay,
  readDailyReview,
} from "@himawari-agent/application";
import { CALIBRATION_SQL } from "@himawari-agent/calibration";
import {
  createAgentId,
  createMemoryGenerationId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  MCP_PROPOSE_MEMORY_ALREADY_SAVED,
  MCP_PROPOSE_MEMORY_CHANGED,
  MCP_PROPOSE_MEMORY_DECLINED,
  MCP_PROPOSE_MEMORY_FAILED,
  MCP_PROPOSE_MEMORY_INVALID,
  MCP_PROPOSE_MEMORY_NOT_READY,
  MCP_PROPOSE_MEMORY_SAVED,
  MCP_PROPOSE_MEMORY_UNSUPPORTED,
  MCP_PROPOSE_NOT_SHOWN,
  MCP_PROPOSE_RULE_ALREADY_SAVED,
  MCP_PROPOSE_RULE_DECLINED,
  MCP_PROPOSE_RULE_INVALID,
  MCP_PROPOSE_RULE_NOT_READY,
  MCP_PROPOSE_RULE_REPLAY_UNAVAILABLE,
  MCP_PROPOSE_RULE_SAVED,
} from "@himawari-agent/prompt-catalog";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_PROPOSAL_MEMORY_PREFIX,
  EXTERNAL_PROPOSAL_TEXT_MAXIMUM,
  normalizeProposalText,
  ProductionMcpMemoryWriter,
} from "../../apps/agent-service/src/production-mcp-memory-writer.ts";
import {
  MCP_PROPOSAL_CONFIRM_KEY,
  MCP_PROPOSAL_UNSEEN_ANSWER_MS,
  MCP_READ_PATH,
  MCP_READ_TOOL_NAMES,
  MCP_WRITE_TOOL_NAMES,
  mcpProposalAnswer,
  ProductionMcpRead,
  registerMcpReadRoute,
} from "../../apps/agent-service/src/production-mcp-read.ts";
import {
  EXTERNAL_RULE_DECISION_PREFIX,
  EXTERNAL_RULE_MEMORY_PREFIX,
  ProductionMcpRuleWriter,
} from "../../apps/agent-service/src/production-mcp-rule-writer.ts";
import { ProductionMemoryRecall } from "../../apps/agent-service/src/production-memory-recall.ts";
import { ProductionOwnerRuleWriter } from "../../apps/agent-service/src/production-owner-rules.ts";
import { ProductionReminderWriter } from "../../apps/agent-service/src/production-reminder-writer.ts";
import { createMcpAccess } from "../../apps/agent-service/test/fixtures/mcp-access.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-mcp-write");
const AGENT_ID = createAgentId("agent-mcp-write");
const THREAD_ID = createThreadId("thread-mcp-write");
const GENERATION_ID = createMemoryGenerationId("generation-mcp-write");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-11T03:00:00.000Z";
const SINCE = "1970-01-01T00:00:00.000Z";
const TIME_ZONE = "Asia/Tokyo";
const COFFEE = "主人每天早上只喝无糖的燕麦拿铁";

const embedder: Embedder = {
  model: "fixture-embedding",
  dimensions: 2,
  async embedQuery(text: string) {
    return new Float32Array(text.includes("拿铁") ? [1, 0] : [0, 1]);
  },
  async embedDocument(text: string) {
    return new Float32Array(text.includes("拿铁") ? [1, 0] : [0, 1]);
  },
};

const HUMAN_ANSWER_MS = 3_000;

type Answer =
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline" }
  | { action: "cancel" };

interface ToolCallOutcome {
  readonly resultType?: string;
  readonly isError?: boolean;
  readonly content?: { readonly type: string; readonly text: string }[];
  readonly inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
  readonly requestState?: string;
}

describe("[P5-2] external agents propose memories through MCP and the owner confirms in the client", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    options: {
      readonly failDecline?: boolean;
      readonly slowDecisionRead?: boolean;
      readonly readOnly?: boolean;
      readonly failRuleMarker?: boolean;
      readonly slowDecidedMs?: number;
      readonly notReady?: boolean;
      readonly replay?: boolean;
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-mcp-write-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
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
        ) VALUES ('checkpoint-mcp-write', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, NOW);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-mcp-write', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
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
      workerId: "mcp-write-worker",
      now: () => clock.now(),
    });
    const reminders = new ProductionReminderWriter({
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
    const recall = new ProductionMemoryRecall({
      ...scope,
      provider,
      state: repository.productMemoryState(),
      readText: async (record) => readText(record.contentRef),
      embedWithin: async () => {
        throw new Error("RUN_EMBEDDING_NOT_EXPECTED");
      },
      now: () => clock.now(),
      timeZone: TIME_ZONE,
    });
    const realLedger = repository.decisionLedger();
    const writer = new ProductionMcpMemoryWriter({
      configuration: scope,
      memory,
      state: options.slowDecisionRead
        ? {
            read: async (id) => {
              const found = await repository.productMemoryState().read(id);
              await new Promise((resolve) => setTimeout(resolve, 100));
              return found;
            },
          }
        : repository.productMemoryState(),
      book: repository.memoryBook(),
      ledger: options.failDecline
        ? {
            read: (input) => realLedger.read(input),
            append: async () => {
              throw new Error("LEDGER_WRITE_DOWN");
            },
          }
        : options.slowDecisionRead
          ? {
              read: async (input) => {
                const found = await realLedger.read(input);
                await new Promise((resolve) => setTimeout(resolve, 100));
                return found;
              },
              append: (write) => realLedger.append(write),
            }
          : realLedger,
      payloads,
      protector: adapters.payloadProtector,
      clock,
    });
    const failures: unknown[] = [];
    const settingsStore = repository.proactive();
    const ownerRules = new ProductionOwnerRuleWriter({
      configuration: scope,
      rules: repository.ownerRules(),
      memory,
      memories: repository.productMemoryState(),
      book: repository.memoryBook(),
      threads: repository.threadRepository(),
      payloads,
      protector: adapters.payloadProtector,
      clock,
      ...(options.replay === false
        ? {}
        : {
            replay: (rule) =>
              new OwnerRuleReplay({
                scope,
                store: settingsStore,
                seal: {
                  open: async () => {
                    throw new Error("NO_MAIL_TO_OPEN");
                  },
                },
                readModelInput: async () => {
                  throw new Error("NO_MAIL_TO_OPEN");
                },
                clock,
                days: 30,
                mailsPerOutcome: 5,
              }).replay(rule),
          }),
    });
    const ruleProposals = new ProductionMcpRuleWriter({
      configuration: scope,
      rules: ownerRules,
      payloads: options.failRuleMarker
        ? {
            ...payloads,
            get: (ref) => payloads.get(ref),
            delete: (ref) => payloads.delete(ref),
            put: async (payload) => {
              if (payload.ref.startsWith(EXTERNAL_RULE_DECISION_PREFIX))
                throw new Error("PAYLOAD_DISK_FULL");
              return payloads.put(payload);
            },
          }
        : payloads,
      protector: adapters.payloadProtector,
      clock,
      onFailure: (error) => failures.push(error),
    });
    let slowReads = 0;
    const slowDecided = <T extends object>(target: T): T =>
      options.slowDecidedMs === undefined && !options.notReady
        ? target
        : new Proxy(target, {
            get(inner, key) {
              const value = Reflect.get(inner, key, inner);
              if (typeof value !== "function") return value;
              if (key === "ready" && options.notReady) return async () => false;
              if (key !== "decided" || options.slowDecidedMs === undefined)
                return value.bind(inner);
              return async (proposalId: string) => {
                const found = await value.call(inner, proposalId);
                slowReads += 1;
                clock.advance(options.slowDecidedMs ?? 0);
                return found;
              };
            },
          });
    const access = await createMcpAccess(() => new Date(clock.now()));
    const owners = repository.ownerIdentityState();
    await owners.bindFirstOwner({
      ownerId: OWNER_ID,
      externalSubjectRef: await access.ownerSubjectRef(),
      boundAt: clock.now(),
    });
    const mcp = new ProductionMcpRead({
      scope,
      clock,
      access: access.verifier,
      owners,
      ...(options.readOnly
        ? {}
        : {
            write: { proposals: slowDecided(writer), rules: slowDecided(ruleProposals) },
          }),
      timeZone: TIME_ZONE,
      requestTimeoutMs: 30_000,
      sources: {
        recall: (args, within) => recall.recallOutsideRun(args, within),
        embedOutsideRun: async (_context, operation) => operation(),
        reminders: (windowMs) => reminders.list(windowMs),
        settings: () => settingsStore.readSettings(scope),
      },
      ledger: realLedger,
      onFailure: (error) => failures.push(error),
      onSummariesFailed: (error) => failures.push(error),
    });
    const app = Fastify({ logger: false });
    registerMcpReadRoute(app, mcp);
    closers.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${MCP_READ_PATH}`,
    );
    const elicitations: Record<string, unknown>[] = [];
    const connect = async (
      input: {
        readonly era?: "legacy" | "modern";
        readonly elicitation?: boolean;
        readonly answer?: Answer;
        readonly autoFulfill?: boolean;
        readonly name?: string;
        readonly elicitationCapability?: unknown;
        readonly answerAfterMs?: number;
      } = {},
    ) => {
      const era = input.era ?? "modern";
      const client = new Client(
        { name: input.name ?? "claude-code", version: "2.1.400" },
        {
          ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
          capabilities:
            input.elicitation === false
              ? {}
              : { elicitation: (input.elicitationCapability ?? { form: {} }) as never },
          ...(input.autoFulfill === false ? { inputRequired: { autoFulfill: false } } : {}),
        },
      );
      if (input.elicitation !== false)
        client.setRequestHandler("elicitation/create", async (request) => {
          elicitations.push(request.params as Record<string, unknown>);
          clock.advance(input.answerAfterMs ?? HUMAN_ANSWER_MS);
          return input.answer ?? { action: "accept", content: {} };
        });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { "cf-access-jwt-assertion": await access.sign() } },
        }),
      );
      closers.push(() => client.close());
      return client;
    };
    const propose = async (client: Client, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "propose_memory", arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      return { result, text: content?.text ?? "" };
    };
    const answered = (params: Record<string, unknown>) => {
      if (params["inputResponses"] !== undefined && params["answeredAfterMs"] !== 0)
        clock.advance(HUMAN_ANSWER_MS);
      const { answeredAfterMs: _unused, ...rest } = params;
      return rest;
    };
    const raw = async (client: Client, params: Record<string, unknown>) =>
      (await client.request(
        { method: "tools/call", params: { name: "propose_memory", ...answered(params) } },
        { allowInputRequired: true },
      )) as ToolCallOutcome;
    const external = async () =>
      (await repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)).filter(({ id }) =>
        id.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX),
      );
    const decisions = async () =>
      (
        await realLedger.list({ ...scope, kind: "memory_candidate", since: SINCE, limit: 100 })
      ).filter(({ reasonCode }) => reasonCode.startsWith("mcp_proposal_"));
    const proposeRule = async (client: Client, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "propose_rule", arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      return { result, text: content?.text ?? "" };
    };
    const rawRule = async (client: Client, params: Record<string, unknown>) =>
      (await client.request(
        { method: "tools/call", params: { name: "propose_rule", ...answered(params) } },
        { allowInputRequired: true },
      )) as ToolCallOutcome;
    const storedRules = () =>
      repository.ownerRules().list({ ...scope, includeRetired: true } as never);
    const rulePayloads = () => {
      const database = openQualifiedDatabase(databasePath);
      try {
        return (
          database
            .prepare(
              "SELECT ref FROM payloads WHERE ref LIKE 'rule-%' OR ref LIKE 'memory-content:rule:%' ORDER BY ref",
            )
            .all() as { ref: string }[]
        ).map(({ ref }) => ref);
      } finally {
        database.close();
      }
    };
    return {
      connect,
      propose,
      proposeRule,
      rawRule,
      storedRules,
      rulePayloads,
      ownerRules,
      raw,
      external,
      decisions,
      elicitations,
      failures,
      memory,
      readText,
      repository,
      databasePath,
      clock,
      slowReads: () => slowReads,
      realLedger,
    };
  }

  it("shows the write tool only when proposals are turned on, and only on a modern connection", async () => {
    const readOnly = await setup({ readOnly: true });
    const reader = await readOnly.connect();
    expect((await reader.listTools()).tools.map(({ name }) => name)).toEqual([
      ...MCP_READ_TOOL_NAMES,
    ]);
    const f = await setup();
    const writer = await f.connect();
    const tools = (await writer.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual([
      ...MCP_READ_TOOL_NAMES,
      ...MCP_WRITE_TOOL_NAMES,
    ]);
    expect(tools.at(-1)?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    const legacy = await f.connect({ era: "legacy" });
    expect((await legacy.listTools()).tools.map(({ name }) => name)).toEqual([
      ...MCP_READ_TOOL_NAMES,
    ]);
    await expect(
      legacy.callTool({ name: "propose_memory", arguments: { text: COFFEE } }),
    ).rejects.toThrow();
    expect(f.elicitations).toEqual([]);
    expect(await f.external()).toEqual([]);
  });

  it("asks the owner in the client, saves after a confirm and records the decision", async () => {
    const f = await setup();
    const client = await f.connect();
    const saved = await f.propose(client, { text: `  ${COFFEE}‮ `, category: "preference" });
    expect(saved.result.isError).not.toBe(true);
    expect(saved.text).toBe(MCP_PROPOSE_MEMORY_SAVED.text);
    expect(f.elicitations).toHaveLength(1);
    const [asked] = f.elicitations;
    expect(
      String(asked?.["message"]).startsWith(`把这条存进 Himawari 的长期记忆？\n「${COFFEE}」`),
    ).toBe(true);
    expect(asked?.["requestedSchema"]).toEqual({ type: "object", properties: {} });
    expect(asked?.["message"]).toContain("claude-code（对方自称）");
    const memories = await f.external();
    expect(memories).toHaveLength(1);
    const [stored] = memories;
    expect(await f.readText(stored?.contentRef ?? "")).toBe(COFFEE);
    expect(stored).toMatchObject({
      dataClassification: "private",
      inference: false,
      attributes: { category: "preference" },
    });
    expect(stored?.id.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX)).toBe(true);
    const [row] = await f.decisions();
    expect(row).toMatchObject({
      kind: "memory_candidate",
      outcome: "kept",
      reasonCode: EXTERNAL_PROPOSAL_REASON_CODES.kept,
      subjectRef: stored?.id,
      contentRef: null,
    });
    expect(row?.inputs.memoryIds).toEqual([stored?.id]);
    await f.memory.runProjectionBatch(10);
    const found = await client.callTool({ name: "find_memories", arguments: { query: "拿铁" } });
    expect(JSON.stringify(found.content)).toContain("燕麦拿铁");
  });

  it.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
  ] as const)("does not save when the owner answers %s", async (_label, answer) => {
    const f = await setup();
    const client = await f.connect({ answer: answer as Answer });
    const declined = await f.propose(client, { text: COFFEE });
    expect(declined.result.isError).not.toBe(true);
    expect(declined.text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    expect(await f.external()).toEqual([]);
    const [row] = await f.decisions();
    expect(row).toMatchObject({
      outcome: "discarded",
      reasonCode: EXTERNAL_PROPOSAL_REASON_CODES.declined,
      subjectRef: "mcp-client:claude-code",
    });
  });

  it("[P5-2 desktop] treats a decline that comes back before anyone could read the dialog as not shown", async () => {
    expect(mcpProposalAnswer("accept", 0, 0)).toBe("accepted");
    expect(mcpProposalAnswer("decline", 0, MCP_PROPOSAL_UNSEEN_ANSWER_MS - 1)).toBe("unseen");
    expect(mcpProposalAnswer("cancel", 0, 10)).toBe("unseen");
    expect(mcpProposalAnswer("decline", 0, MCP_PROPOSAL_UNSEEN_ANSWER_MS)).toBe("declined");
    expect(mcpProposalAnswer("decline", 0, Number.NaN)).toBe("unseen");
    expect(mcpProposalAnswer("decline", 5_000, 0)).toBe("unseen");
    const f = await setup();
    const desktop = await f.connect({ answer: { action: "decline" }, answerAfterMs: 10 });
    const unseen = await f.propose(desktop, { text: COFFEE });
    expect(unseen.result.isError).toBe(true);
    expect(unseen.text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    expect(await f.external()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    const instant = await f.raw(client, {
      arguments: { text: COFFEE },
      requestState: first.requestState,
      inputResponses: { [MCP_PROPOSAL_CONFIRM_KEY]: { action: "decline" } },
      answeredAfterMs: 0,
    });
    expect(instant.content?.[0]?.text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    expect(await f.decisions()).toEqual([]);
    const later = await f.raw(client, {
      arguments: { text: COFFEE },
      requestState: first.requestState,
      inputResponses: { [MCP_PROPOSAL_CONFIRM_KEY]: { action: "accept", content: {} } },
    });
    expect(later.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_SAVED.text);
    expect(await f.external()).toHaveLength(1);
    expect((await f.decisions()).map(({ outcome }) => outcome)).toEqual(["kept"]);
    const second = await f.raw(client, { arguments: { text: "主人讨厌下雨天" } });
    const ignored = await f.raw(client, {
      arguments: { text: "主人讨厌下雨天" },
      requestState: second.requestState,
      inputResponses: { [MCP_PROPOSAL_CONFIRM_KEY]: { action: "cancel" } },
      answeredAfterMs: 0,
    });
    expect(ignored.content?.[0]?.text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    const refused = await f.raw(client, {
      arguments: { text: "主人讨厌下雨天" },
      requestState: second.requestState,
      inputResponses: { [MCP_PROPOSAL_CONFIRM_KEY]: { action: "decline" } },
    });
    expect(refused.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    expect((await f.decisions()).map(({ outcome }) => outcome).sort()).toEqual([
      "discarded",
      "kept",
    ]);
    expect(await f.external()).toHaveLength(1);
  });

  it("[P5-2 desktop] times an unseen decline from when the resend arrives, not after a slow read", async () => {
    const f = await setup({ slowDecidedMs: 2_000 });
    const desktop = await f.connect({ answer: { action: "decline" }, answerAfterMs: 10 });
    expect((await f.propose(desktop, { text: COFFEE })).text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    expect((await f.proposeRule(desktop, RULE)).text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    expect(f.slowReads()).toBe(2);
    expect(await f.decisions()).toEqual([]);
    expect(await f.storedRules()).toEqual([]);
  });

  it("[P5-2] refuses before asking while the memory book is not ready", async () => {
    const f = await setup({ notReady: true });
    const client = await f.connect();
    expect((await f.propose(client, { text: COFFEE })).text).toBe(
      MCP_PROPOSE_MEMORY_NOT_READY.text,
    );
    expect((await f.proposeRule(client, RULE)).text).toBe(MCP_PROPOSE_RULE_NOT_READY.text);
    expect(f.elicitations).toEqual([]);
  });

  it("refuses without a dialog when the client cannot show a confirmation form", async () => {
    const f = await setup();
    const client = await f.connect({ elicitation: false });
    const refused = await f.propose(client, { text: COFFEE });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toBe(MCP_PROPOSE_MEMORY_UNSUPPORTED.text);
    await expect(f.connect({ elicitationCapability: [] })).rejects.toThrow();
    const today = await client.callTool({ name: "today_context", arguments: {} });
    expect(today.isError).not.toBe(true);
    expect(await f.external()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
  });

  it("saves one memory however many times the confirmed retry is resent, even concurrently", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    expect(first.resultType).toBe("input_required");
    expect(Object.keys(first.inputRequests ?? {})).toEqual([MCP_PROPOSAL_CONFIRM_KEY]);
    expect(await f.external()).toEqual([]);
    const retry = {
      arguments: { text: COFFEE },
      requestState: first.requestState,
      inputResponses: {
        [MCP_PROPOSAL_CONFIRM_KEY]: {
          action: "accept",
          content: {},
        },
      },
    };
    const [one, two] = await Promise.all([f.raw(client, retry), f.raw(client, retry)]);
    const texts = [one, two].map((outcome) => outcome.content?.[0]?.text);
    expect(texts).toContain(MCP_PROPOSE_MEMORY_SAVED.text);
    expect(
      texts.every(
        (text) =>
          text === MCP_PROPOSE_MEMORY_SAVED.text || text === MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
      ),
    ).toBe(true);
    const third = await f.raw(client, retry);
    expect(third.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_ALREADY_SAVED.text);
    expect(await f.external()).toHaveLength(1);
    expect(await f.decisions()).toHaveLength(1);
  });

  it("records exactly one outcome when a save and a decline for one proposal arrive together", async () => {
    const f = await setup({ slowDecisionRead: true });
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    const answer = (action: "accept" | "decline") => ({
      arguments: { text: COFFEE },
      requestState: first.requestState,
      inputResponses: {
        [MCP_PROPOSAL_CONFIRM_KEY]: action === "accept" ? { action, content: {} } : { action },
      },
    });
    const clients = await Promise.all([0, 1, 2].map(() => f.connect({ autoFulfill: false })));
    const outcomes = await Promise.all([
      f.raw(client, answer("accept")),
      f.raw(clients[0] ?? client, answer("decline")),
      f.raw(clients[1] ?? client, answer("accept")),
      f.raw(clients[2] ?? client, answer("decline")),
    ]);
    const rows = await f.decisions();
    expect(rows).toHaveLength(1);
    const kept = rows[0]?.outcome === "kept";
    expect(await f.external()).toHaveLength(kept ? 1 : 0);
    const texts = outcomes.map((outcome) => outcome.content?.[0]?.text).sort();
    expect(texts).toEqual(
      kept
        ? [
            MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
            MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
            MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
            MCP_PROPOSE_MEMORY_SAVED.text,
          ].sort()
        : Array(4).fill(MCP_PROPOSE_MEMORY_DECLINED.text),
    );
  });

  it("records the client name the owner saw in the dialog, not the one on the answer", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    const other = await f.connect({ autoFulfill: false, name: "another-agent" });
    const declined = await f.raw(other, {
      arguments: { text: COFFEE },
      requestState: first.requestState,
      inputResponses: { [MCP_PROPOSAL_CONFIRM_KEY]: { action: "decline" } },
    });
    expect(declined.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    const [row] = await f.decisions();
    expect(row?.subjectRef).toBe("mcp-client:claude-code");
  });

  it("removes invisible formatting before checking the length and showing the text", async () => {
    expect(normalizeProposalText("a\u00adb\u061cc\u2028d\u2029e\u180ef\ud800g😀")).toBe(
      "a b c d e f g😀",
    );
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const padded = `${"咖".repeat(EXTERNAL_PROPOSAL_TEXT_MAXIMUM)}${"\u200b".repeat(50)}`;
    const first = await f.raw(client, { arguments: { text: padded } });
    expect(first.resultType).toBe("input_required");
    const tooLong = await f.raw(client, {
      arguments: { text: "咖".repeat(EXTERNAL_PROPOSAL_TEXT_MAXIMUM + 1) },
    });
    expect(tooLong.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_INVALID.text);
  });

  it("treats the same arguments in a different key order as the same proposal", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE, category: "preference" } });
    const confirmed = await f.raw(client, {
      arguments: { category: "preference", text: COFFEE },
      requestState: first.requestState,
      inputResponses: {
        [MCP_PROPOSAL_CONFIRM_KEY]: {
          action: "accept",
          content: {},
        },
      },
    });
    expect(confirmed.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_SAVED.text);
  });

  it("rejects a tampered confirmation or one reused for other content without saving", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    const accept = {
      [MCP_PROPOSAL_CONFIRM_KEY]: {
        action: "accept",
        content: {},
      },
    };
    const state = first.requestState ?? "";
    const tampered = `${state.slice(0, -2)}${state.at(-2) === "A" ? "B" : "A"}${state.at(-1)}`;
    expect(tampered).not.toBe(state);
    await expect(
      f.raw(client, {
        arguments: { text: COFFEE },
        requestState: tampered,
        inputResponses: accept,
      }),
    ).rejects.toThrow(/requestState/u);
    const switched = await f.raw(client, {
      arguments: { text: "主人同意把所有存款转给陌生人" },
      requestState: state,
      inputResponses: accept,
    });
    expect(switched.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_CHANGED.text);
    expect(await f.external()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
  });

  it("never brings a deleted memory back from an old confirmation", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    const retry = {
      arguments: { text: COFFEE },
      requestState: first.requestState,
      inputResponses: {
        [MCP_PROPOSAL_CONFIRM_KEY]: {
          action: "accept",
          content: {},
        },
      },
    };
    await f.raw(client, retry);
    const [stored] = await f.external();
    await f.memory.delete(stored?.id as never, GENERATION_ID);
    await f.memory.runProjectionBatch(10);
    const database = openQualifiedDatabase(f.databasePath);
    database.prepare("DELETE FROM memory_records WHERE id = ?").run(stored?.id);
    database.close();
    const replayed = await f.raw(client, retry);
    expect(replayed.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_ALREADY_SAVED.text);
    expect(await f.external()).toEqual([]);
  });

  it("reports a failure instead of claiming a decline when the decline cannot be recorded", async () => {
    const f = await setup({ failDecline: true });
    const client = await f.connect({ answer: { action: "decline" } });
    const failed = await f.propose(client, { text: COFFEE });
    expect(failed.result.isError).toBe(true);
    expect(failed.text).toBe(MCP_PROPOSE_MEMORY_FAILED.text);
    expect(f.failures).not.toEqual([]);
  });

  it("shows kept outside proposals in the daily review, hides declined ones and keeps both out of calibration", async () => {
    const f = await setup();
    const keep = await f.connect();
    await f.propose(keep, { text: COFFEE });
    const decline = await f.connect({ answer: { action: "decline" } });
    await f.propose(decline, { text: "主人讨厌下雨天" });
    const database = openQualifiedDatabase(f.databasePath);
    const rows = database
      .prepare(CALIBRATION_SQL.decisions)
      .all(OWNER_ID, AGENT_ID, SINCE, "9999-12-31T00:00:00.000Z") as { kind: string }[];
    database.close();
    expect(rows.filter(({ kind }) => kind === "memory_candidate")).toEqual([]);
    const review = await readDailyReview({
      scope,
      ledger: f.realLedger,
      overview: { decisions: [], audit: { items: [] } } as never,
      readMemoryText: async (ref) => f.readText(ref),
      timeZone: TIME_ZONE,
      now: NOW,
      budgetSeconds: 600,
      secondsPerItem: 5,
    });
    const reviewed = [...review.items, ...review.folded.items].map(({ key }) => key);
    const [kept] = await f.external();
    const keptDecision = (await f.decisions()).find(({ outcome }) => outcome === "kept");
    const declinedDecision = (await f.decisions()).find(({ outcome }) => outcome === "discarded");
    expect(kept).toBeDefined();
    expect(reviewed).toContain(`ledger:${keptDecision?.id}`);
    expect(reviewed).not.toContain(`ledger:${declinedDecision?.id}`);
  });

  const RULE = {
    type: "mail_must_notify",
    params: { senderDomains: ["isa.go.jp"], phrases: ["在留資格"] },
    summary: "入管局的邮件一律提醒",
    reason: "主人在这个会话里说过：入管局来的邮件以后都要提醒我",
  };
  const confirmRule = (requestState: string | undefined, action: "accept" | "decline") => ({
    arguments: RULE,
    requestState,
    inputResponses: {
      [MCP_PROPOSAL_CONFIRM_KEY]: action === "accept" ? { action, content: {} } : { action },
    },
  });

  it("[P5-2 rule] turns a confirmed outside proposal into an enforced owner rule through the P2-3 flow", async () => {
    const f = await setup();
    const client = await f.connect();
    const saved = await f.proposeRule(client, RULE);
    expect(saved.result.isError).not.toBe(true);
    expect(saved.text).toBe(MCP_PROPOSE_RULE_SAVED.text);
    expect(f.elicitations).toHaveLength(1);
    const message = String(f.elicitations[0]?.["message"]);
    expect(f.elicitations[0]?.["requestedSchema"]).toEqual({ type: "object", properties: {} });
    expect(message.startsWith(`让这条邮件长期规则生效？\n「${RULE.summary}」`)).toBe(true);
    for (const shown of [
      "claude-code（对方自称）",
      RULE.summary,
      "同意（Accept）就生效",
      "isa.go.jp",
      "在留資格",
      RULE.reason,
      "估计：近 30 天判断过的 0 封邮件里",
    ])
      expect(message).toContain(shown);
    const rows = await f.storedRules();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ status: "active", source: "mcp:claude-code" });
    expect(row?.ruleId).toMatch(/^owner:[0-9a-f]{24}$/u);
    expect(row?.sourceMemoryId?.startsWith(EXTERNAL_RULE_MEMORY_PREFIX)).toBe(true);
    const ruleMemory = await f.repository.productMemoryState().read(row?.sourceMemoryId as never);
    expect(ruleMemory).toMatchObject({ status: "active", attributes: { category: "rule" } });
    expect(await f.readText(ruleMemory?.contentRef ?? "")).toBe(
      `外部 agent「claude-code」提议：${RULE.reason}\n${RULE.summary}`,
    );
    const enforced = enforceableOwnerRule(row as never);
    expect(enforced).toBeDefined();
    const compiled = compileRuleExpression(
      enforced?.gate ?? "mail_item",
      enforced?.expression ?? "",
    );
    const mail = (fromAddress: string, subject: string) =>
      compiled.evaluate(mailItemFacts({ fromAddress, subject, snippet: "" }));
    expect(mail("notice@isa.go.jp", "お知らせ")).toBe(true);
    expect(mail("shop@example.com", "在留資格の更新")).toBe(true);
    expect(mail("shop@example.com", "セールのお知らせ")).toBe(false);
    const payloads = f.rulePayloads();
    expect(payloads.filter((ref) => ref.startsWith("rule-proposal:"))).toHaveLength(1);
    expect(payloads.filter((ref) => ref.startsWith(EXTERNAL_RULE_DECISION_PREFIX))).toHaveLength(1);
  });

  it.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
  ] as const)("[P5-2 rule] writes nothing when the owner answers %s", async (_label, answer) => {
    const f = await setup();
    const client = await f.connect({ answer: answer as Answer });
    const declined = await f.proposeRule(client, RULE);
    expect(declined.result.isError).not.toBe(true);
    expect(declined.text).toBe(MCP_PROPOSE_RULE_DECLINED.text);
    expect(await f.storedRules()).toEqual([]);
    expect(f.rulePayloads()).toEqual([]);
    expect(await f.external()).toEqual([]);
  });

  it("[P5-2 desktop] writes no rule and remembers no refusal when the decline comes back unseen", async () => {
    const f = await setup();
    const desktop = await f.connect({ answer: { action: "decline" }, answerAfterMs: 10 });
    const unseen = await f.proposeRule(desktop, RULE);
    expect(unseen.result.isError).toBe(true);
    expect(unseen.text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    expect(await f.storedRules()).toEqual([]);
    expect(f.rulePayloads()).toEqual([]);
    const client = await f.connect({ autoFulfill: false });
    const first = await f.rawRule(client, { arguments: RULE });
    const instant = await f.rawRule(client, {
      ...confirmRule(first.requestState, "decline"),
      answeredAfterMs: 0,
    });
    expect(instant.content?.[0]?.text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    const later = await f.rawRule(client, confirmRule(first.requestState, "accept"));
    expect(later.content?.[0]?.text).toBe(MCP_PROPOSE_RULE_SAVED.text);
    expect((await f.storedRules()).map(({ status }) => status)).toEqual(["active"]);
    const second = await f.rawRule(client, {
      arguments: { ...RULE, summary: "入管局的邮件也要提醒" },
    });
    const confirmSecond = (action: "accept" | "decline", answeredAfterMs?: number) => ({
      ...confirmRule(second.requestState, action),
      arguments: { ...RULE, summary: "入管局的邮件也要提醒" },
      ...(answeredAfterMs === undefined ? {} : { answeredAfterMs }),
    });
    expect((await f.rawRule(client, confirmSecond("decline", 0))).content?.[0]?.text).toBe(
      MCP_PROPOSE_NOT_SHOWN.text,
    );
    expect((await f.rawRule(client, confirmSecond("decline"))).content?.[0]?.text).toBe(
      MCP_PROPOSE_RULE_DECLINED.text,
    );
    expect((await f.rawRule(client, confirmSecond("accept"))).content?.[0]?.text).toBe(
      MCP_PROPOSE_RULE_DECLINED.text,
    );
    expect(await f.storedRules()).toHaveLength(1);
  });

  it("[P5-2 rule] rejects bad rules before asking and hides the tool from readers and old connections", async () => {
    const f = await setup({ replay: false });
    const client = await f.connect();
    for (const args of [
      { ...RULE, params: {} },
      { ...RULE, params: { phrases: ["留"] } },
      { ...RULE, params: { excludePhrases: ["広告"] } },
      { ...RULE, params: { phrases: ["a\nb"] } },
      { ...RULE, summary: "两行\n说明" },
      { ...RULE, reason: "​⁠" },
      { ...RULE, reason: "理".repeat(201) },
    ]) {
      const refused = await f.proposeRule(client, args);
      expect(refused.result.isError, JSON.stringify(args)).toBe(true);
      expect(refused.text, JSON.stringify(args)).toBe(MCP_PROPOSE_RULE_INVALID.text);
    }
    for (const args of [
      { ...RULE, type: "mail_unknown" },
      { ...RULE, params: { regex: [".*"] } },
    ]) {
      const refused = await client
        .callTool({ name: "propose_rule", arguments: args })
        .then((result) => result.isError === true)
        .catch(() => true);
      expect(refused, JSON.stringify(args)).toBe(true);
    }
    expect(f.elicitations).toEqual([]);
    const reader = await (await setup({ readOnly: true })).connect();
    await expect(reader.callTool({ name: "propose_rule", arguments: RULE })).rejects.toThrow();
    const legacy = await f.connect({ era: "legacy" });
    await expect(legacy.callTool({ name: "propose_rule", arguments: RULE })).rejects.toThrow();
    const unsupported = await f.connect({ elicitation: false });
    const noDialog = await f.proposeRule(unsupported, RULE);
    expect(noDialog.text).toBe(MCP_PROPOSE_MEMORY_UNSUPPORTED.text);
    const asked = await f.rawRule(await f.connect({ autoFulfill: false }), { arguments: RULE });
    const [request] = Object.values(asked.inputRequests ?? {});
    expect(String(request?.params["message"])).toContain(MCP_PROPOSE_RULE_REPLAY_UNAVAILABLE.text);
    expect(await f.storedRules()).toEqual([]);
    expect(f.rulePayloads()).toEqual([]);
  });

  it("[P5-2 rule] activates once however often the confirmation is resent, and an undone rule stays undone", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const first = await f.rawRule(client, { arguments: RULE });
    expect(first.resultType).toBe("input_required");
    expect(await f.storedRules()).toEqual([]);
    const retry = confirmRule(first.requestState, "accept");
    const texts = (await Promise.all([f.rawRule(client, retry), f.rawRule(client, retry)])).map(
      (outcome) => outcome.content?.[0]?.text,
    );
    expect(texts.sort()).toEqual(
      [MCP_PROPOSE_RULE_SAVED.text, MCP_PROPOSE_RULE_ALREADY_SAVED.text].sort(),
    );
    const [row] = await f.storedRules();
    expect(row?.status).toBe("active");
    await f.ownerRules.undo(row?.ruleId ?? "");
    const database = openQualifiedDatabase(f.databasePath);
    database
      .prepare("DELETE FROM payloads WHERE ref LIKE ?")
      .run(`${EXTERNAL_RULE_DECISION_PREFIX}%`);
    database.close();
    const replayed = await f.rawRule(client, retry);
    expect(replayed.content?.[0]?.text).toBe(MCP_PROPOSE_RULE_ALREADY_SAVED.text);
    const after = await f.storedRules();
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe("retired");
    expect(
      await f.repository.productMemoryState().read(after[0]?.sourceMemoryId as never),
    ).not.toMatchObject({ status: "active" });
  });

  it("[P5-2 rule] applies exactly one answer when a confirm and a decline for one proposal arrive together", async () => {
    for (const order of [
      ["decline", "accept"],
      ["accept", "decline"],
    ] as const) {
      const f = await setup();
      const client = await f.connect({ autoFulfill: false });
      const first = await f.rawRule(client, { arguments: RULE });
      const others = await Promise.all(order.map(() => f.connect({ autoFulfill: false })));
      const outcomes = await Promise.all(
        order.map((action, index) =>
          f.rawRule(others[index] ?? client, confirmRule(first.requestState, action)),
        ),
      );
      const texts = outcomes.map((outcome) => outcome.content?.[0]?.text).sort();
      const kept = (await f.storedRules()).length === 1;
      expect(texts, order.join(",")).toEqual(
        kept
          ? [MCP_PROPOSE_RULE_SAVED.text, MCP_PROPOSE_RULE_ALREADY_SAVED.text].sort()
          : [MCP_PROPOSE_RULE_DECLINED.text, MCP_PROPOSE_RULE_DECLINED.text],
      );
      if (!kept) expect(f.rulePayloads()).toEqual([]);
    }
  });

  it("[P5-2 rule] reports a rule as active when only the marker could not be written, and still refuses a second activation", async () => {
    const f = await setup({ failRuleMarker: true });
    const client = await f.connect({ autoFulfill: false });
    const first = await f.rawRule(client, { arguments: RULE });
    const retry = confirmRule(first.requestState, "accept");
    const saved = await f.rawRule(client, retry);
    expect(saved.isError).not.toBe(true);
    expect(saved.content?.[0]?.text).toBe(MCP_PROPOSE_RULE_SAVED.text);
    expect(f.failures).not.toEqual([]);
    const [row] = await f.storedRules();
    expect(row?.status).toBe("active");
    await f.ownerRules.undo(row?.ruleId ?? "");
    const replayed = await f.rawRule(client, retry);
    expect(replayed.content?.[0]?.text).toBe(MCP_PROPOSE_RULE_ALREADY_SAVED.text);
    expect((await f.storedRules()).map(({ status }) => status)).toEqual(["retired"]);
  });

  it("[P5-2 rule] reuses an existing rule with the same conditions and an old confirmation cannot bring it back after undo", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const accept = async (args: typeof RULE) => {
      const first = await f.rawRule(client, { arguments: args });
      const retry = { ...confirmRule(first.requestState, "accept"), arguments: args };
      expect((await f.rawRule(client, retry)).content?.[0]?.text).toBe(MCP_PROPOSE_RULE_SAVED.text);
      return retry;
    };
    await accept(RULE);
    const again = await accept({ ...RULE, reason: "主人又说了一遍：入管局的邮件都要提醒" });
    const rows = await f.storedRules();
    expect(rows).toHaveLength(1);
    await f.ownerRules.undo(rows[0]?.ruleId ?? "");
    const database = openQualifiedDatabase(f.databasePath);
    database
      .prepare("DELETE FROM payloads WHERE ref LIKE ?")
      .run(`${EXTERNAL_RULE_DECISION_PREFIX}%`);
    database.close();
    expect((await f.rawRule(client, again)).content?.[0]?.text).toBe(
      MCP_PROPOSE_RULE_ALREADY_SAVED.text,
    );
    expect((await f.storedRules()).map(({ status }) => status)).toEqual(["retired"]);
  });

  it("[P5-2 rule] treats the same conditions in a different key and list order as the same proposal", async () => {
    const f = await setup();
    const client = await f.connect({ autoFulfill: false });
    const listed = {
      ...RULE,
      params: { senderDomains: ["isa.go.jp", "moj.go.jp"], phrases: ["在留資格", "在留カード"] },
    };
    const first = await f.rawRule(client, { arguments: listed });
    const reordered = {
      reason: RULE.reason,
      summary: RULE.summary,
      params: { phrases: ["在留カード", "在留資格"], senderDomains: ["moj.go.jp", "isa.go.jp"] },
      type: RULE.type,
    };
    const confirmed = await f.rawRule(client, {
      ...confirmRule(first.requestState, "accept"),
      arguments: reordered,
    });
    expect(confirmed.content?.[0]?.text).toBe(MCP_PROPOSE_RULE_SAVED.text);
  });
});
