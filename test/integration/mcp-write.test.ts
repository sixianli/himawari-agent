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
import { memorySourceState } from "@himawari-agent/gateway-contracts";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  MCP_PROPOSE_MEMORIES_RESULT,
  MCP_PROPOSE_MEMORY_ALREADY_SAVED,
  MCP_PROPOSE_MEMORY_CHANGED,
  MCP_PROPOSE_MEMORY_DECLINED,
  MCP_PROPOSE_MEMORY_FAILED,
  MCP_PROPOSE_MEMORY_FULL,
  MCP_PROPOSE_MEMORY_INVALID,
  MCP_PROPOSE_MEMORY_PENDING,
  MCP_PROPOSE_MEMORY_SAVED,
  MCP_PROPOSE_MEMORY_SAVED_DIRECT,
  MCP_PROPOSE_MEMORY_SECRET,
  MCP_PROPOSE_MEMORY_UNSUPPORTED,
  MCP_PROPOSE_NOT_SHOWN,
  MCP_PROPOSE_RULE_ALREADY_SAVED,
  MCP_PROPOSE_RULE_DECLINED,
  MCP_PROPOSE_RULE_INVALID,
  MCP_PROPOSE_RULE_NOT_READY,
  MCP_PROPOSE_RULE_REPLAY_UNAVAILABLE,
  MCP_PROPOSE_RULE_SAVED,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpConnectionSecretDigest,
  newMcpConnectionSecret,
} from "../../apps/agent-service/src/production-mcp-connections.ts";
import {
  EXTERNAL_PROPOSAL_MEMORY_PREFIX,
  EXTERNAL_PROPOSAL_TEXT_MAXIMUM,
  externalProposalBatchId,
  normalizeProposalText,
  ProductionMcpMemoryWriter,
  proposalTextDigest,
} from "../../apps/agent-service/src/production-mcp-memory-writer.ts";
import {
  MCP_PROPOSAL_CONFIRM_KEY,
  MCP_PROPOSAL_UNSEEN_ANSWER_MS,
  MCP_READ_PATH,
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
import { ProductionMemoryControl } from "../../apps/agent-service/src/production-memory-control.ts";
import { ProductionMemoryRecall } from "../../apps/agent-service/src/production-memory-recall.ts";
import { ProductionOwnerRuleWriter } from "../../apps/agent-service/src/production-owner-rules.ts";
import { ProductionProposalBox } from "../../apps/agent-service/src/production-proposals.ts";
import { ProductionReminderWriter } from "../../apps/agent-service/src/production-reminder-writer.ts";
import { createMcpAccess } from "../../apps/agent-service/test/fixtures/mcp-access.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const READ_TOOL_NAMES = ["start_here", "find_memories", "today_context", "rule_book"];
const OWNER_ID = createOwnerId("owner-mcp-write");
const AGENT_ID = createAgentId("agent-mcp-write");
const THREAD_ID = createThreadId("thread-mcp-write");
const GENERATION_ID = createMemoryGenerationId("generation-mcp-write");
const CONNECTION_ID = "conn-mcp-write";
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
      readonly direct?: boolean;
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
    let activeScans = 0;
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
            listActive: (ownerId, agentId) =>
              repository.productMemoryState().listActive(ownerId, agentId),
          }
        : {
            read: (id) => repository.productMemoryState().read(id),
            listActive: (ownerId, agentId) => {
              activeScans += 1;
              return repository.productMemoryState().listActive(ownerId, agentId);
            },
          },
      book: repository.memoryBook(),
      ledger: options.failDecline
        ? {
            read: (input) => realLedger.read(input),
            append: async (write) => {
              if (write.id.endsWith(":declined")) throw new Error("LEDGER_WRITE_DOWN");
              return realLedger.append(write);
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
      proposals: repository.externalMemoryProposals(),
      payloads,
      protector: adapters.payloadProtector,
      clock,
    });
    const failures: unknown[] = [];
    const settingsStore = repository.proactive();
    const proposalBox = new ProductionProposalBox({
      configuration: scope,
      store: repository.ownerProposals(),
      payloads,
      protector: adapters.payloadProtector,
      clock,
    });
    const ownerRules = new ProductionOwnerRuleWriter({
      configuration: scope,
      rules: repository.ownerRules(),
      box: proposalBox,
      reviews: repository.ruleReviews(),
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
    const hooks: { afterDecided?: (() => Promise<void>) | undefined } = {};
    const slowDecided = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(inner, key) {
          const value = Reflect.get(inner, key, inner);
          if (typeof value !== "function") return value;
          if (key === "ready" && options.notReady) return async () => false;
          if (key !== "decided") return value.bind(inner);
          return async (proposalId: string) => {
            const found = await value.call(inner, proposalId);
            if (options.slowDecidedMs !== undefined) {
              slowReads += 1;
              clock.advance(options.slowDecidedMs);
            }
            const after = hooks.afterDecided;
            hooks.afterDecided = undefined;
            await after?.();
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
      connections: repository.mcpConnections(),
      requestTimeoutMs: 30_000,
      sources: {
        recall: (args, within, ceiling) => recall.recallOutsideRun(args, within, ceiling),
        embedOutsideRun: async (_context, operation) => operation(),
        reminders: (windowMs, ceiling) => reminders.list(windowMs, ceiling),
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
    const secret = newMcpConnectionSecret();
    await repository.mcpConnections().create({
      ...scope,
      id: CONNECTION_ID,
      name: CONNECTION_ID,
      secretSha256: mcpConnectionSecretDigest(secret),
      capabilities: ["mcp"],
      readCeiling: "private",
      pushPolicy: options.direct ? "direct" : "ask",
      createdAt: clock.now(),
    });
    const url = new URL(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${MCP_READ_PATH}/${secret}`,
    );
    const usage = async () =>
      repository.mcpConnections().usage({ ...scope, fromDay: "2000-01-01", toDay: "2100-01-01" });
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
        readonly beforeAnswer?: () => Promise<void>;
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
          await input.beforeAnswer?.();
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
    const external = async (prefix = EXTERNAL_PROPOSAL_MEMORY_PREFIX) =>
      (await repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)).filter(({ id }) =>
        id.startsWith(prefix),
      );
    const ledgerRows = async () =>
      (
        await realLedger.list({ ...scope, kind: "memory_candidate", since: SINCE, limit: 100 })
      ).filter(({ reasonCode }) => reasonCode.startsWith("mcp_proposal_"));
    const decisions = async () =>
      (await ledgerRows()).filter(
        ({ reasonCode }) =>
          reasonCode === EXTERNAL_PROPOSAL_REASON_CODES.kept ||
          reasonCode === EXTERNAL_PROPOSAL_REASON_CODES.declined,
      );
    const pending = async () =>
      (await repository.externalMemoryProposals().listPending({ ...scope, limit: 1000 })).items;
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
      activeScanCount: () => activeScans,
      usage,
      hooks,
      connect,
      propose,
      proposeRule,
      rawRule,
      storedRules,
      rulePayloads,
      ownerRules,
      proposalBox,
      raw,
      external,
      decisions,
      ledgerRows,
      pending,
      writer,
      payloads,
      protector: adapters.payloadProtector,
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
    expect((await reader.listTools()).tools.map(({ name }) => name)).toEqual([...READ_TOOL_NAMES]);
    const f = await setup();
    const writer = await f.connect();
    const tools = (await writer.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual([...READ_TOOL_NAMES, ...MCP_WRITE_TOOL_NAMES]);
    expect(tools.at(-1)?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    const legacy = await f.connect({ era: "legacy" });
    expect((await legacy.listTools()).tools.map(({ name }) => name)).toEqual([...READ_TOOL_NAMES]);
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
    const lines = String(asked?.["message"]).split("\n");
    expect(lines[0]?.startsWith("把下面这条存进 Himawari 的长期记忆？同意（Accept）就保存")).toBe(
      true,
    );
    expect(lines[1]).toBe(`▍对方提议的原文（只占这一行）：${COFFEE}`);
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

  it("does not save when the owner declines, and never asks about the same text again", async () => {
    const f = await setup();
    const client = await f.connect({ answer: { action: "decline" } });
    const declined = await f.propose(client, { text: COFFEE });
    expect(declined.result.isError).not.toBe(true);
    expect(declined.text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    expect(await f.external()).toEqual([]);
    expect(await f.pending()).toEqual([]);
    const [row] = await f.decisions();
    expect(row).toMatchObject({
      outcome: "discarded",
      reasonCode: EXTERNAL_PROPOSAL_REASON_CODES.declined,
      subjectRef: `mcp-connection:${CONNECTION_ID}`,
    });
    const other = await f.connect({ name: "muse", elicitation: false });
    const again = await f.propose(other, { text: ` ${COFFEE}\u200b` });
    expect(again.text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    expect(f.elicitations).toHaveLength(1);
    expect(await f.pending()).toEqual([]);
  });

  it("[P5-3] keeps the proposal waiting for the owner in Himawari when the dialog is dismissed", async () => {
    const f = await setup();
    const client = await f.connect({ answer: { action: "cancel" } });
    const dismissed = await f.propose(client, { text: COFFEE, category: "preference" });
    expect(dismissed.result.isError).not.toBe(true);
    const [waiting] = await f.pending();
    expect(waiting).toMatchObject({
      status: "pending",
      client: "claude-code",
      category: "preference",
    });
    expect(dismissed.text).toBe(
      renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
        proposalId: waiting?.id ?? "",
        receivedAt: waiting?.receivedAt ?? "",
      }),
    );
    expect(await f.external()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
    expect((await f.ledgerRows()).map(({ outcome, reasonCode }) => [outcome, reasonCode])).toEqual([
      ["pending_approval", EXTERNAL_PROPOSAL_REASON_CODES.pending],
    ]);
  });

  it("[P5-2 desktop][P5-3] keeps a decline that comes back before anyone could read the dialog waiting in Himawari", async () => {
    expect(mcpProposalAnswer("accept", 0, 0)).toBe("unseen");
    expect(mcpProposalAnswer("accept", 0, MCP_PROPOSAL_UNSEEN_ANSWER_MS - 1)).toBe("unseen");
    expect(mcpProposalAnswer("accept", 0, MCP_PROPOSAL_UNSEEN_ANSWER_MS)).toBe("accepted");
    expect(mcpProposalAnswer("decline", 0, MCP_PROPOSAL_UNSEEN_ANSWER_MS - 1)).toBe("unseen");
    expect(mcpProposalAnswer("cancel", 0, 10)).toBe("unseen");
    expect(mcpProposalAnswer("decline", 0, MCP_PROPOSAL_UNSEEN_ANSWER_MS)).toBe("declined");
    expect(mcpProposalAnswer("decline", 0, Number.NaN)).toBe("unseen");
    expect(mcpProposalAnswer("decline", 5_000, 0)).toBe("unseen");
    const f = await setup();
    const desktop = await f.connect({ answer: { action: "decline" }, answerAfterMs: 10 });
    const unseen = await f.propose(desktop, { text: COFFEE });
    expect(unseen.result.isError).not.toBe(true);
    const [waiting] = await f.pending();
    expect(unseen.text).toBe(
      renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
        proposalId: waiting?.id ?? "",
        receivedAt: waiting?.receivedAt ?? "",
      }),
    );
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
    expect(instant.content?.[0]?.text).toBe(unseen.text);
    expect(await f.decisions()).toEqual([]);
    expect(await f.pending()).toHaveLength(1);
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
    const [rain] = await f.pending();
    expect(ignored.content?.[0]?.text).toBe(
      renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
        proposalId: rain?.id ?? "",
        receivedAt: rain?.receivedAt ?? "",
      }),
    );
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
    const memory = await f.propose(desktop, { text: COFFEE });
    const [waiting] = await f.pending();
    expect(memory.text).toBe(
      renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
        proposalId: waiting?.id ?? "",
        receivedAt: waiting?.receivedAt ?? "",
      }),
    );
    expect((await f.proposeRule(desktop, RULE)).text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    expect(f.slowReads()).toBe(2);
    expect(await f.decisions()).toEqual([]);
    expect(await f.storedRules()).toEqual([]);
  });

  it("[P5-2][P5-3] keeps a memory proposal waiting without asking while the memory book is not ready", async () => {
    const f = await setup({ notReady: true });
    const client = await f.connect();
    const waiting = await f.propose(client, { text: COFFEE });
    expect(waiting.result.isError).not.toBe(true);
    expect(await f.pending()).toHaveLength(1);
    expect((await f.proposeRule(client, RULE)).text).toBe(MCP_PROPOSE_RULE_NOT_READY.text);
    expect(f.elicitations).toEqual([]);
  });

  it("[P5-3] keeps the proposal waiting for the owner when the client cannot show a dialog, and answers resends the same way", async () => {
    const f = await setup();
    const client = await f.connect({ elicitation: false, name: "muse" });
    const first = await f.propose(client, { text: COFFEE });
    expect(first.result.isError).not.toBe(true);
    const [waiting] = await f.pending();
    expect(waiting).toMatchObject({ status: "pending", client: "muse", category: "other" });
    expect(first.text).toBe(
      renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
        proposalId: waiting?.id ?? "",
        receivedAt: waiting?.receivedAt ?? "",
      }),
    );
    f.clock.advance(60_000);
    const again = await f.propose(client, { text: `${COFFEE}  ` });
    expect(again.text).toBe(first.text);
    const otherName = await f.connect({ elicitation: false, name: "codex" });
    expect((await f.propose(otherName, { text: COFFEE })).text).toBe(first.text);
    expect(await f.pending()).toHaveLength(1);
    await expect(f.connect({ elicitationCapability: [] })).rejects.toThrow();
    const today = await client.callTool({ name: "today_context", arguments: {} });
    expect(today.isError).not.toBe(true);
    expect(await f.external()).toEqual([]);
    expect(await f.decisions()).toEqual([]);
    expect(f.elicitations).toEqual([]);
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

  it("records the connection as the source, not the client name on the answer", async () => {
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
    expect(row?.subjectRef).toBe(`mcp-connection:${CONNECTION_ID}`);
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
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK, key: "muse:memory/park" });
    await f.propose(muse, { text: `${PARK}和代代木公园`, key: "muse:memory/park" });
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
    const waitingRows = (await f.ledgerRows()).filter(({ reasonCode }) =>
      (
        [
          EXTERNAL_PROPOSAL_REASON_CODES.pending,
          EXTERNAL_PROPOSAL_REASON_CODES.superseded,
        ] as string[]
      ).includes(reasonCode),
    );
    expect(waitingRows).toHaveLength(5);
    for (const row of waitingRows) expect(reviewed).not.toContain(`ledger:${row.id}`);
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
    const lines = message.split("\n");
    expect(lines[0]?.startsWith("让下面这条邮件长期规则生效？同意（Accept）就生效")).toBe(true);
    expect(lines.slice(1, 3)).toEqual([
      `▍对方提议的规则（只占这一行）：${RULE.summary}`,
      `▍对方给的理由（只占这一行）：${RULE.reason}`,
    ]);
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
    expect(row).toMatchObject({ status: "active", source: `mcp:${CONNECTION_ID}` });
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
    expect(await f.proposalBox.list()).toMatchObject({ proposals: [], pendingCount: 0 });
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

  it("[P5-2 auto-accept][P5-3] saves nothing when an accept comes back before anyone could read the dialog", async () => {
    const f = await setup();
    const auto = await f.connect({ answerAfterMs: 10 });
    const memory = await f.propose(auto, { text: COFFEE });
    expect(memory.result.isError).not.toBe(true);
    const [waiting] = await f.pending();
    const pendingText = renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
      proposalId: waiting?.id ?? "",
      receivedAt: waiting?.receivedAt ?? "",
    });
    expect(memory.text).toBe(pendingText);
    expect((await f.proposeRule(auto, RULE)).text).toBe(MCP_PROPOSE_NOT_SHOWN.text);
    const client = await f.connect({ autoFulfill: false });
    const first = await f.raw(client, { arguments: { text: COFFEE } });
    const accept = { ...confirmRule(first.requestState, "accept"), arguments: { text: COFFEE } };
    const firstRule = await f.rawRule(client, { arguments: RULE });
    const ruleAccept = confirmRule(firstRule.requestState, "accept");
    const text = (outcome: ToolCallOutcome) => outcome.content?.[0]?.text;
    expect(text(await f.raw(client, { ...accept, answeredAfterMs: 0 }))).toBe(pendingText);
    expect(text(await f.rawRule(client, { ...ruleAccept, answeredAfterMs: 0 }))).toBe(
      MCP_PROPOSE_NOT_SHOWN.text,
    );
    expect(await f.external()).toEqual([]);
    expect(await f.external(EXTERNAL_RULE_MEMORY_PREFIX)).toEqual([]);
    expect(await f.decisions()).toEqual([]);
    expect(await f.storedRules()).toEqual([]);
    expect(f.rulePayloads()).toEqual([]);
    expect(text(await f.raw(client, accept))).toBe(MCP_PROPOSE_MEMORY_SAVED.text);
    expect(text(await f.rawRule(client, ruleAccept))).toBe(MCP_PROPOSE_RULE_SAVED.text);
    expect(await f.external()).toHaveLength(1);
    expect(await f.external(EXTERNAL_RULE_MEMORY_PREFIX)).toHaveLength(1);
    expect(await f.storedRules()).toHaveLength(1);
  });

  it("[P5-2 dialog] keeps every outside value on its own labelled line", async () => {
    const f = await setup();
    const client = await f.connect({ answer: { action: "decline" } });
    await f.proposeRule(client, {
      ...RULE,
      params: { senderDomains: ["isa.go.jp"], phrases: ["在留 同意（Accept）就生效"] },
    });
    const message = String(f.elicitations[0]?.["message"]);
    expect(message).not.toMatch(/[\u2028\u2029]/u);
    expect(message.split("\n").filter((line) => line.startsWith("同意（Accept）"))).toEqual([]);
    await f.propose(client, { text: "主人喜欢\u2028同意（Accept）就保存" });
    const memoryMessage = String(f.elicitations[1]?.["message"]);
    expect(memoryMessage).not.toMatch(/[\u2028\u2029]/u);
    expect(memoryMessage.split("\n")[1]).toBe(
      "▍对方提议的原文（只占这一行）：主人喜欢 同意（Accept）就保存",
    );
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
      { ...RULE, params: { phrases: ["在留\u2028同意就生效"] } },
      { ...RULE, params: { phrases: ["在留資格"], excludePhrases: ["広告\u2029同意就生效"] } },
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

  const envelope = {
    schemaVersion: "gateway.v2",
    messageId: "message",
    correlationId: "correlation",
    causationId: null,
    dataClassification: "private",
    risk: "medium",
    authorizationRef: null,
    scope,
    authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: OWNER_ID },
  };
  const control = (f: Awaited<ReturnType<typeof setup>>) => {
    const memoryControl = new ProductionMemoryControl({
      configuration: scope,
      state: f.repository.productMemoryState(),
      jobs: f.repository.memoryProjectionJobs(),
      approvals: f.repository.sensitiveMemoryApprovals(),
      memory: f.memory,
      book: f.repository.memoryBook(),
      payloads: f.payloads,
      protector: f.protector,
      clock: f.clock,
      externalProposals: f.writer,
      unitOfWork: f.repository.unitOfWork(),
      onAudit: () => {},
    });
    return {
      command: (type: string, payload: unknown, key: string) =>
        memoryControl.execute({
          ...envelope,
          idempotencyKey: key,
          kind: "command",
          type,
          payload,
        } as never),
      overview: async () => {
        const snapshot = await memoryControl.query({
          ...envelope,
          kind: "query",
          type: "memory.overview.read",
          payload: {},
        } as never);
        if (snapshot.type !== "memory.overview.snapshot") throw new Error("snapshot");
        return snapshot.payload;
      },
    };
  };
  const batch = async (client: Client, items: unknown[]) => {
    const result = await client.callTool({ name: "propose_memories", arguments: { items } });
    const [content] = result.content as { type: string; text: string }[];
    return {
      result,
      parsed: JSON.parse(content?.text ?? "{}") as {
        note: string;
        results: { index: number; status: string; proposalId?: string }[];
      },
    };
  };
  const PARK = "主人周末常去井之头公园散步";
  const RAIN = "主人讨厌下雨天";
  const found = async (client: Client, query: string) =>
    JSON.stringify(
      (await client.callTool({ name: "find_memories", arguments: { query } })).content,
    );

  it("[P5-3] the owner saves, edits and rejects waiting proposals in Himawari, and can undo the batch", async () => {
    const f = await setup();
    const web = control(f);
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const sent = await batch(muse, [
      { text: COFFEE, category: "preference", key: "muse:memory/coffee" },
      { text: PARK },
      { text: RAIN },
    ]);
    expect(sent.result.isError).not.toBe(true);
    expect(sent.parsed.note).toBe(MCP_PROPOSE_MEMORIES_RESULT.text);
    expect(sent.parsed.results.map(({ status }) => status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    const before = await web.overview();
    expect(before.externalProposals.total).toBe(3);
    expect(before.externalProposals.items.map(({ text, client }) => [text, client])).toEqual([
      [COFFEE, "muse"],
      [PARK, "muse"],
      [RAIN, "muse"],
    ]);
    await f.memory.runProjectionBatch(10);
    expect(await found(muse, "拿铁")).not.toContain("燕麦拿铁");
    const [coffee, park, rain] = sent.parsed.results.map(({ proposalId }) => proposalId ?? "");
    const edited = "主人周末常去井之头恩赐公园散步";
    const firstKey = `external-batch-1-${"x".repeat(111)}`;
    const first = externalProposalBatchId(firstKey);
    const second = externalProposalBatchId("external-batch-2");
    await web.command(
      "memory.external.respond",
      {
        items: [
          { proposalId: coffee, decision: "keep", editedText: null },
          { proposalId: park, decision: "keep", editedText: edited },
          { proposalId: rain, decision: "reject", editedText: null },
        ],
      },
      firstKey,
    );
    const saved = await f.external();
    expect(saved.map(({ id }) => id).sort()).toEqual(
      [
        `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${coffee}:${first}`,
        `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${park}:${first}`,
      ].sort(),
    );
    expect(await Promise.all(saved.map(({ contentRef }) => f.readText(contentRef)))).toEqual(
      expect.arrayContaining([COFFEE, edited]),
    );
    const after = await web.overview();
    expect(after.externalProposals.total).toBe(0);
    expect(after.externalProposals.batches).toEqual([
      { batchId: first, decidedAt: NOW, committed: 2, rejected: 1 },
    ]);
    expect((await f.decisions()).map(({ outcome }) => outcome).sort()).toEqual([
      "discarded",
      "kept",
      "kept",
    ]);
    await f.memory.runProjectionBatch(10);
    expect(await found(muse, "拿铁")).toContain("燕麦拿铁");
    expect((await f.propose(muse, { text: RAIN })).text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    expect((await f.propose(muse, { text: COFFEE })).text).toBe(
      MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
    );
    await web
      .command(
        "memory.external.respond",
        { items: [{ proposalId: coffee, decision: "reject", editedText: null }] },
        firstKey,
      )
      .catch(() => undefined);
    expect(await f.external()).toHaveLength(2);
    await web.command("memory.external.undo", { batchId: first }, "undo-1");
    expect(await f.external()).toEqual([]);
    expect((await web.overview()).externalProposals.total).toBe(3);
    await web.command(
      "memory.external.respond",
      { items: [{ proposalId: coffee, decision: "keep", editedText: null }] },
      "external-batch-2",
    );
    expect((await f.external()).map(({ id }) => id)).toEqual([
      `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${coffee}:${second}`,
    ]);
    await expect(
      web.command("memory.external.undo", { batchId: "external-batch-9" }, "undo-9"),
    ).rejects.toThrow("MEMORY_EXTERNAL_BATCH_NOT_FOUND");
  });

  it("[P5-3] links a waiting proposal to an existing memory with the same text instead of saving a copy", async () => {
    const f = await setup();
    const web = control(f);
    const claude = await f.connect();
    expect((await f.propose(claude, { text: COFFEE })).text).toBe(MCP_PROPOSE_MEMORY_SAVED.text);
    const [first] = await f.external();
    const writer = f.writer;
    const { proposal } = await writer.submit({
      proposalId: "proposal-same-text",
      text: `${COFFEE}。`,
      category: "other",
      client: "muse",
      subjectRef: "subject",
      sourceKey: null,
    });
    expect(proposal.status).toBe("pending");
    await writer.respond(
      [{ proposalId: "proposal-same-text", decision: "keep", editedText: COFFEE }],
      "external-batch-same",
    );
    expect((await f.external()).map(({ id }) => id)).toEqual([first?.id]);
    expect(await writer.read("proposal-same-text")).toMatchObject({
      status: "committed",
      memoryId: first?.id,
    });
    expect((await web.overview()).externalProposals.total).toBe(0);
    await web.command("memory.external.undo", { batchId: "external-batch-same" }, "undo-same");
    expect((await f.external()).map(({ id }) => id)).toEqual([first?.id]);
    expect(await writer.read("proposal-same-text")).toMatchObject({
      status: "committed",
      memoryId: first?.id,
      batchId: null,
    });
    expect((await web.overview()).externalProposals.total).toBe(0);
  });

  it("[P5-3] replaces a waiting proposal when the same key brings new text, and counts each batch item on its own", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const secret = `主人的令牌是 gh${"p_"}${"x".repeat(24)}`;
    const first = await batch(muse, [
      { text: "主人每天喝两杯咖啡", key: "muse:memory/coffee" },
      { text: "   " },
      { text: secret },
      { text: "主人每天喝两杯咖啡" },
    ]);
    expect(first.parsed.results.map(({ status }) => status)).toEqual([
      "pending",
      "invalid",
      "secret",
      "pending",
    ]);
    expect(first.parsed.results[3]?.proposalId).toBe(first.parsed.results[0]?.proposalId);
    expect((await f.propose(muse, { text: secret })).text).toBe(MCP_PROPOSE_MEMORY_SECRET.text);
    f.clock.advance(1_000);
    const second = await batch(muse, [{ text: "主人每天只喝一杯咖啡", key: "muse:memory/coffee" }]);
    const waiting = await f.pending();
    expect(waiting.map(({ id }) => id)).toEqual([second.parsed.results[0]?.proposalId]);
    expect(await f.writer.read(first.parsed.results[0]?.proposalId ?? "")).toMatchObject({
      status: "superseded",
      supersededBy: second.parsed.results[0]?.proposalId,
    });
    expect((await f.ledgerRows()).map(({ reasonCode }) => reasonCode).sort()).toEqual(
      [
        EXTERNAL_PROPOSAL_REASON_CODES.pending,
        EXTERNAL_PROPOSAL_REASON_CODES.pending,
        EXTERNAL_PROPOSAL_REASON_CODES.superseded,
      ].sort(),
    );
    const twice = await batch(muse, [
      { text: "主人的车是白色的", key: "muse:memory/car" },
      { text: "主人的车是银色的", key: "muse:memory/car" },
    ]);
    expect(twice.parsed.results.map(({ status }) => status)).toEqual(["replaced", "pending"]);
    await f.writer.respond(
      [
        {
          proposalId: second.parsed.results[0]?.proposalId ?? "",
          decision: "reject",
          editedText: null,
        },
      ],
      "external-batch-reject-coffee",
    );
    const fifty = await batch(
      muse,
      Array.from({ length: 50 }, (_unused, index) => ({ text: `主人的第 ${index} 条习惯` })),
    );
    expect(fifty.parsed.results.filter(({ status }) => status === "pending")).toHaveLength(50);
    const tooMany = await muse.callTool({
      name: "propose_memories",
      arguments: { items: Array.from({ length: 51 }, (_unused, index) => ({ text: `${index}` })) },
    });
    expect(tooMany.isError).toBe(true);
    expect(await f.pending()).toHaveLength(51);
    expect(await f.writer.read(second.parsed.results[0]?.proposalId ?? "")).toMatchObject({
      status: "rejected",
    });
    expect(await f.external()).toEqual([]);
  });

  it("[P5-3] keeps waiting text out of every memory the model can read", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const marker = "主人的暗号是紫色独角兽";
    await f.propose(muse, { text: marker, key: "muse:memory/marker" });
    await f.memory.runProjectionBatch(10);
    expect(await f.external()).toEqual([]);
    expect(await f.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(await found(muse, "暗号")).not.toContain("独角兽");
    const today = await muse.callTool({ name: "today_context", arguments: {} });
    expect(JSON.stringify(today.content)).not.toContain("独角兽");
    const database = openQualifiedDatabase(f.databasePath);
    try {
      const [proposal] = await f.pending();
      expect(
        database
          .prepare("SELECT COUNT(*) FROM memory_records WHERE content_ref = ?")
          .pluck()
          .get(proposal?.contentRef),
      ).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM memory_search_index").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("[P5-3] drops the text of a rejected proposal after 30 days but keeps blocking the same text", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: RAIN });
    const [waiting] = await f.pending();
    await f.writer.respond(
      [{ proposalId: waiting?.id ?? "", decision: "reject", editedText: null }],
      "external-batch-rain",
    );
    f.clock.advance(29 * 86_400_000);
    expect(await f.writer.dropExpiredDiscardedText()).toBe(0);
    f.clock.advance(2 * 86_400_000);
    expect(await f.writer.dropExpiredDiscardedText()).toBe(1);
    expect(await f.writer.listBatches(10)).toEqual([]);
    const later = await f.connect({ elicitation: false, name: "muse" });
    expect(await f.writer.read(waiting?.id ?? "")).toMatchObject({
      status: "rejected",
      contentRef: null,
    });
    expect(await f.payloads.get(waiting?.contentRef ?? "")).toBeUndefined();
    expect((await f.propose(later, { text: RAIN })).text).toBe(MCP_PROPOSE_MEMORY_DECLINED.text);
    expect(await f.payloads.get(waiting?.contentRef ?? "")).toBeUndefined();
    expect(await f.writer.undoBatch("external-batch-rain", async () => undefined)).toBeUndefined();
    expect(await f.writer.listBatch("external-batch-rain")).toEqual([]);
  });

  it("[P5-3] drops the text of a replaced proposal after 30 days unless the same text is waiting again", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK, key: "muse:memory/park" });
    const [old] = await f.pending();
    f.clock.advance(1_000);
    await f.propose(muse, { text: RAIN, key: "muse:memory/park" });
    f.clock.advance(1_000);
    await f.propose(muse, { text: COFFEE, key: "muse:memory/coffee" });
    f.clock.advance(1_000);
    await f.propose(muse, { text: "主人每天只喝一杯咖啡", key: "muse:memory/coffee" });
    await f.propose(muse, { text: COFFEE });
    const waitingCoffee = (await f.pending()).find((proposal) => proposal.sourceKey === null);
    f.clock.advance(31 * 86_400_000);
    expect(await f.writer.dropExpiredDiscardedText()).toBe(2);
    expect(await f.writer.read(old?.id ?? "")).toMatchObject({
      status: "superseded",
      contentRef: null,
    });
    expect(await f.payloads.get(old?.contentRef ?? "")).toBeUndefined();
    expect(waitingCoffee).toBeDefined();
    expect(await f.writer.readText(waitingCoffee ?? { contentRef: null })).toBe(COFFEE);
    expect((await f.pending()).map(({ id }) => id)).toHaveLength(3);
  });

  it("[P5-3] counts proposal text the way the memory page does, and refuses secrets in the key", async () => {
    const f = await setup();
    const web = control(f);
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const wide = "😀".repeat(1001);
    expect([...wide].length).toBeLessThan(2000);
    expect((await f.propose(muse, { text: wide })).text).toBe(MCP_PROPOSE_MEMORY_INVALID.text);
    expect((await f.propose(muse, { text: "😀".repeat(1000) })).text).toContain("待确认");
    expect(
      (await f.propose(muse, { text: PARK, key: `muse:gh${"p_"}${"x".repeat(24)}` })).text,
    ).toBe(MCP_PROPOSE_MEMORY_SECRET.text);
    const overview = await web.overview();
    expect(overview.externalProposals.items.map(({ text }) => text)).toEqual(["😀".repeat(1000)]);
    expect(overview.externalProposals.items.every(({ text }) => text.length <= 2000)).toBe(true);
  });

  it("[P5-3] raises a waiting proposal to sensitive when the same text comes back as health", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const text = "主人每晚十点吃降压药";
    await f.propose(muse, { text, category: "other" });
    expect((await f.pending())[0]?.dataClassification).toBe("private");
    await f.propose(muse, { text, category: "health" });
    const [waiting] = await f.pending();
    expect(waiting?.dataClassification).toBe("sensitive");
    expect((await f.payloads.get(waiting?.contentRef ?? ""))?.dataClassification).toBe("sensitive");
    expect(await f.writer.readText(waiting ?? { contentRef: null })).toBe(text);
    await f.writer.respond(
      [{ proposalId: waiting?.id ?? "", decision: "keep", editedText: null }],
      "external-batch-health",
    );
    const [saved] = await f.external();
    expect(saved?.dataClassification).toBe("sensitive");
    expect(saved?.attributes?.category).toBe("health");
    expect(saved?.attributes?.sensitiveTopic).toBe("health");
  });

  it("[P5-3] saves one memory when two waiting proposals are edited to the same text, and the client dialog links to an existing memory too", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK });
    await f.propose(muse, { text: RAIN });
    const [park, rain] = await f.pending();
    await f.writer.respond(
      [
        { proposalId: park?.id ?? "", decision: "keep", editedText: COFFEE },
        { proposalId: rain?.id ?? "", decision: "keep", editedText: COFFEE },
      ],
      "external-batch-same-edit",
    );
    const saved = await f.external();
    expect(saved).toHaveLength(1);
    expect(await f.writer.read(rain?.id ?? "")).toMatchObject({
      status: "committed",
      memoryId: saved[0]?.id,
    });
    const claude = await f.connect();
    await f.propose(claude, { text: `${COFFEE}。` });
    await f.writer.submit({
      proposalId: "proposal-dialog-same",
      text: "主人每天喝燕麦拿铁",
      category: "preference",
      client: "claude-code",
      subjectRef: "x".repeat(300),
      sourceKey: null,
    });
    const linked = await f.writer.keep("proposal-dialog-same", {
      batchId: null,
      started: Date.parse(NOW),
      editedText: COFFEE,
    });
    expect(linked).toBe(saved[0]?.id);
    expect(
      (await f.external()).filter(({ id }) => id === "memory:mcp:proposal-dialog-same"),
    ).toEqual([]);
    expect((await f.writer.read("proposal-dialog-same"))?.subjectRef).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it("[P5-3] tells the client what really happened when the owner decided in Himawari while the dialog was open", async () => {
    const f = await setup();
    const web = control(f);
    const decideOnWeb = (decision: "keep" | "reject", key: string) => async () => {
      f.hooks.afterDecided = async () => {
        const [waiting] = await f.pending();
        await web.command(
          "memory.external.respond",
          { items: [{ proposalId: waiting?.id ?? "", decision, editedText: null }] },
          key,
        );
      };
    };
    const declining = await f.connect({
      answer: { action: "decline" },
      beforeAnswer: decideOnWeb("keep", "web-keep"),
    });
    expect((await f.propose(declining, { text: PARK })).text).toBe(
      MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
    );
    expect(await f.external()).toHaveLength(1);
    const accepting = await f.connect({ beforeAnswer: decideOnWeb("reject", "web-reject") });
    expect((await f.propose(accepting, { text: RAIN })).text).toBe(
      MCP_PROPOSE_MEMORY_DECLINED.text,
    );
    expect(await f.external()).toHaveLength(1);
    await web.command(
      "memory.external.undo",
      { batchId: externalProposalBatchId("web-keep") },
      "undo-web-keep",
    );
    expect(await f.external()).toEqual([]);
    expect((await f.pending()).map(({ id }) => id)).toHaveLength(1);
  });

  it("[P5-3] does not link a proposal to a memory the owner just undid, and a key moves to waiting text it already matches", async () => {
    const f = await setup();
    const web = control(f);
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK });
    await f.propose(muse, { text: RAIN });
    const [park, rain] = await f.pending();
    const cache = {};
    const started = Date.parse(NOW);
    const first = await f.writer.keep(park?.id ?? "", { batchId: "batch-a", started }, cache);
    await web.command("memory.external.undo", { batchId: "batch-a" }, "undo-a");
    const second = await f.writer.keep(
      rain?.id ?? "",
      { batchId: "batch-b", started, editedText: PARK },
      cache,
    );
    expect(second).not.toBe(first);
    expect((await f.external()).map(({ id }) => id)).toEqual([second]);
    await f.propose(muse, { text: COFFEE, key: "muse:memory/drink" });
    await f.propose(muse, { text: "主人每天喝两杯咖啡" });
    await f.propose(muse, { text: "主人每天喝两杯咖啡", key: "muse:memory/drink" });
    const waiting = await f.pending();
    expect(waiting.map(({ sourceKey }) => sourceKey)).toEqual([null, "muse:memory/drink"]);
    expect(waiting).toHaveLength(2);
    const database = openQualifiedDatabase(f.databasePath);
    try {
      expect(
        database
          .prepare(
            "SELECT status, superseded_by AS supersededBy FROM external_memory_proposals WHERE text_sha256 = ?",
          )
          .get(proposalTextDigest(COFFEE)),
      ).toEqual({ status: "superseded", supersededBy: waiting[1]?.id });
    } finally {
      database.close();
    }
  });

  it("[P5-3] keeps waiting text that another key still points at when the first key moves on", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const TEA = "主人下午喝一杯绿茶";
    await f.propose(muse, { text: COFFEE, key: "muse:memory/one" });
    await f.propose(muse, { text: COFFEE, key: "muse:memory/two" });
    await f.propose(muse, { text: TEA, key: "muse:memory/one" });
    const status = () => {
      const database = openQualifiedDatabase(f.databasePath);
      try {
        return database
          .prepare("SELECT status FROM external_memory_proposals WHERE text_sha256 = ?")
          .pluck()
          .get(proposalTextDigest(COFFEE));
      } finally {
        database.close();
      }
    };
    expect(status()).toBe("pending");
    expect((await f.pending()).length).toBe(2);
    await f.propose(muse, { text: PARK, key: "muse:memory/two" });
    expect(status()).toBe("superseded");
  });

  it("[P5-3] the writer refuses long text, machine secrets and long keys itself", async () => {
    const f = await setup();
    const submit = (text: string, sourceKey: string | null) =>
      f.writer.submit({
        proposalId: `proposal-${String(text.length)}-${String(sourceKey?.length ?? 0)}`,
        text,
        category: "other",
        client: "muse",
        subjectRef: "subject",
        sourceKey,
      });
    await expect(submit("咖".repeat(2001), null)).rejects.toThrow("MEMORY_TEXT_REFUSED");
    await expect(submit(`token ${"ghp_"}${"a".repeat(36)}`, null)).rejects.toThrow(
      "MEMORY_TEXT_REFUSED",
    );
    await expect(submit(COFFEE, "k".repeat(201))).rejects.toThrow("MEMORY_TEXT_REFUSED");
    await expect(submit(COFFEE, `ghp_${"a".repeat(36)}`)).rejects.toThrow("MEMORY_TEXT_REFUSED");
    expect(await f.pending()).toEqual([]);
  });

  it("[P5-3] a key that brings text already saved retires its older waiting text, and keys belong to one client", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const claude = await f.connect({ elicitation: false, name: "claude-code" });
    const TEA = "主人下午喝一杯绿茶";
    await f.propose(muse, { text: COFFEE });
    const [coffee] = await f.pending();
    await f.writer.respond(
      [{ proposalId: coffee?.id ?? "", decision: "keep", editedText: null }],
      "external-batch-coffee",
    );
    await f.propose(muse, { text: TEA, key: "memory/drink" });
    await f.propose(claude, { text: "主人每晚喝一杯热牛奶", key: "memory/drink" });
    expect((await f.pending()).length).toBe(2);
    expect((await f.propose(muse, { text: COFFEE, key: "memory/drink" })).text).toBe(
      MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
    );
    const waiting = await f.pending();
    expect(waiting.map(({ client }) => client)).toEqual(["claude-code"]);
  });

  it("[P5-3] a sensitive proposal is not hung on a private memory with the same text", async () => {
    const f = await setup();
    const text = "主人每晚十点吃降压药";
    await f.writer.submit({
      proposalId: "proposal-private",
      text,
      category: "other",
      client: "muse",
      subjectRef: "subject",
      sourceKey: null,
    });
    await f.writer.respond(
      [{ proposalId: "proposal-private", decision: "keep", editedText: null }],
      "external-batch-private",
    );
    const [privateMemory] = await f.external();
    expect(privateMemory?.dataClassification).toBe("private");
    await f.writer.submit({
      proposalId: "proposal-sensitive",
      text: `${text}。`,
      category: "health",
      client: "muse",
      subjectRef: "subject",
      sourceKey: null,
    });
    await f.writer.respond(
      [{ proposalId: "proposal-sensitive", decision: "keep", editedText: text }],
      "external-batch-sensitive",
    );
    const saved = await f.writer.read("proposal-sensitive");
    expect(saved?.memoryId).not.toBe(privateMemory?.id);
    const memories = await f.external();
    expect(memories.find(({ id }) => id === saved?.memoryId)?.dataClassification).toBe("sensitive");
  });

  it("[P5-3] confirming items that were all decided elsewhere reports a conflict", async () => {
    const f = await setup();
    const web = control(f);
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: COFFEE });
    const [coffee] = await f.pending();
    const items = [{ proposalId: coffee?.id ?? "", decision: "reject" as const, editedText: null }];
    await web.command("memory.external.respond", { items }, "respond-first");
    await expect(
      web.command("memory.external.respond", { items }, "respond-second"),
    ).rejects.toThrow("MCP_PROPOSAL_ALREADY_DECIDED");
  });

  it("[P5-3] undoing a batch reopens every proposal hung on the memories it moves to the trash", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK });
    await f.propose(muse, { text: RAIN });
    await f.propose(muse, { text: "主人周末常去公园" });
    const [park, rain, walk] = await f.pending();
    await f.writer.respond(
      [
        { proposalId: park?.id ?? "", decision: "keep", editedText: COFFEE },
        { proposalId: rain?.id ?? "", decision: "keep", editedText: COFFEE },
      ],
      "external-batch-first",
    );
    await f.writer.respond(
      [{ proposalId: walk?.id ?? "", decision: "keep", editedText: COFFEE }],
      "external-batch-second",
    );
    expect(await f.external()).toHaveLength(1);
    await f.writer.undoBatch("external-batch-first", async () => undefined);
    expect((await f.pending()).map(({ id }) => id).sort()).toEqual(
      [park?.id, rain?.id, walk?.id].sort(),
    );
    expect(await f.writer.listBatch("external-batch-first")).toEqual([]);
    expect(await f.writer.listBatch("external-batch-second")).toEqual([]);
  });

  it("[P5-3] text the owner reopened by undo is not replaced when its old key moves on", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK, key: "memory/walk" });
    const [park] = await f.pending();
    await f.writer.respond(
      [{ proposalId: park?.id ?? "", decision: "keep", editedText: null }],
      "external-batch-walk",
    );
    await f.propose(muse, { text: RAIN, key: "memory/walk" });
    await f.writer.undoBatch("external-batch-walk", async () => undefined);
    await f.propose(muse, { text: "主人周末常去公园", key: "memory/walk" });
    const waiting = await f.pending();
    expect(waiting.map(({ id }) => id)).toContain(park?.id);
    expect(waiting).toHaveLength(2);
  });

  it("[P5-3] a key update from one client does not replace text another client sent without a key", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const claude = await f.connect({ elicitation: false, name: "claude-code" });
    await f.propose(muse, { text: PARK });
    await f.propose(claude, { text: PARK, key: "memory/walk" });
    await f.propose(claude, { text: RAIN, key: "memory/walk" });
    expect((await f.pending()).length).toBe(2);
  });

  it("[P5-3] stops taking new text once 1000 proposals wait, without leaving its text behind", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK });
    const [park] = await f.pending();
    const database = openQualifiedDatabase(f.databasePath);
    try {
      const insert = database.prepare(
        `INSERT INTO external_memory_proposals (
          id, owner_id, agent_id, subject_ref, client, source_key, text_sha256, normalization,
          content_ref, category, classification, status, received_at
        ) SELECT ?, owner_id, agent_id, subject_ref, client, NULL, ?, normalization, content_ref,
          category, classification, 'pending', received_at
        FROM external_memory_proposals WHERE id = ?`,
      );
      for (let index = 1; index < 1000; index += 1)
        insert.run(`filler-${String(index)}`, index.toString(16).padStart(64, "0"), park?.id ?? "");
    } finally {
      database.close();
    }
    const payloadsBefore = () => {
      const opened = openQualifiedDatabase(f.databasePath);
      try {
        return opened.prepare("SELECT COUNT(*) FROM payloads").pluck().get();
      } finally {
        opened.close();
      }
    };
    const before = payloadsBefore();
    expect((await f.propose(muse, { text: RAIN })).text).toBe(MCP_PROPOSE_MEMORY_FULL.text);
    const sent = await batch(muse, [{ text: RAIN }, { text: PARK }]);
    expect(sent.parsed.results.map(({ status }) => status)).toEqual(["full", "pending"]);
    expect(payloadsBefore()).toBe(before);
  });

  it("[P5-3] a key that keeps changing its text cannot get past the limit on kept text", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK });
    const [park] = await f.pending();
    const database = openQualifiedDatabase(f.databasePath);
    try {
      const insert = database.prepare(
        `INSERT INTO external_memory_proposals (
          id, owner_id, agent_id, subject_ref, client, source_key, text_sha256, normalization,
          content_ref, category, classification, status, received_at, decided_at
        ) SELECT ?, owner_id, agent_id, subject_ref, client, NULL, ?, normalization, content_ref,
          category, classification, 'superseded', received_at, received_at
        FROM external_memory_proposals WHERE id = ?`,
      );
      for (let index = 1; index < 5000; index += 1)
        insert.run(`old-${String(index)}`, index.toString(16).padStart(64, "0"), park?.id ?? "");
    } finally {
      database.close();
    }
    expect((await f.pending()).length).toBe(1);
    expect((await f.propose(muse, { text: RAIN, key: "memory/rain" })).text).toBe(
      MCP_PROPOSE_MEMORY_FULL.text,
    );
  });

  it("[P5-3] an undo that fails part way reopens what it moved to the trash and leaves the rest to undo again", async () => {
    const f = await setup();
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await f.propose(muse, { text: PARK });
    await f.propose(muse, { text: RAIN });
    const [park, rain] = await f.pending();
    await f.writer.respond(
      [
        { proposalId: park?.id ?? "", decision: "keep", editedText: null },
        { proposalId: rain?.id ?? "", decision: "keep", editedText: null },
      ],
      "external-batch-two",
    );
    let calls = 0;
    await expect(
      f.writer.undoBatch("external-batch-two", async () => {
        calls += 1;
        if (calls === 2) throw new Error("trash failed");
      }),
    ).rejects.toThrow("trash failed");
    const waiting = await f.pending();
    expect(waiting).toHaveLength(1);
    const left = await f.writer.listBatch("external-batch-two");
    expect(left).toHaveLength(1);
    expect(left[0]?.status).toBe("committed");
    expect([park?.id, rain?.id].sort()).toEqual([waiting[0]?.id, left[0]?.id].sort());
    expect(await f.writer.undoBatch("external-batch-two", async () => undefined)).toEqual([
      left[0]?.id,
    ]);
  });

  it("[P5-B] counts every push call on the connection and the rejected ones as failed", async () => {
    const f = await setup();
    const client = await f.connect();
    await f.propose(client, { text: COFFEE });
    expect((await f.propose(client, { text: "" })).result.isError).toBe(true);
    const many = await client.callTool({
      name: "propose_memories",
      arguments: { items: [{ text: PARK }] },
    });
    expect(many.isError).not.toBe(true);
    expect(
      (
        await f.proposeRule(client, {
          type: "mail_must_notify",
          params: { senderDomains: ["isa.go.jp"] },
          summary: "入管局的邮件一律提醒",
          reason: " ",
        })
      ).result.isError,
    ).toBe(true);
    const rows = Object.fromEntries(
      (await f.usage()).map((row) => [`${row.connectionId}/${row.tool}/${row.counter}`, row.value]),
    );
    expect(rows).toEqual({
      [`${CONNECTION_ID}/propose_memory/calls`]: 3,
      [`${CONNECTION_ID}/propose_memory/failed`]: 1,
      [`${CONNECTION_ID}/propose_memories/calls`]: 1,
      [`${CONNECTION_ID}/propose_rule/calls`]: 1,
      [`${CONNECTION_ID}/propose_rule/failed`]: 1,
    });
  });

  it("[direct] saves a proposed memory at once on a connection set to direct save, with no confirmation box", async () => {
    const f = await setup({ direct: true });
    const claude = await f.connect();
    const saved = await f.propose(claude, { text: COFFEE, category: "preference" });
    expect(saved.text).toBe(MCP_PROPOSE_MEMORY_SAVED_DIRECT.text);
    expect(f.elicitations).toEqual([]);
    expect(await f.pending()).toEqual([]);
    const [memory] = await f.external();
    expect(memory?.id).toMatch(/^memory:mcp:[^:]+:batch-direct-[0-9a-f]{24}$/);
    expect(
      memorySourceState({
        memoryId: memory?.id ?? "",
        importBatchId: null,
        sourceThreadId: null,
        sourceMessageId: null,
        sourceRefs: [],
        history: [],
      }),
    ).toBe("external_direct");
    expect(await f.readText(memory?.contentRef ?? "")).toBe(COFFEE);
    expect((await f.ledgerRows()).map(({ reasonCode, outcome }) => [reasonCode, outcome])).toEqual(
      expect.arrayContaining([[EXTERNAL_PROPOSAL_REASON_CODES.keptDirect, "kept"]]),
    );
    await f.memory.runProjectionBatch(10);
    expect(await found(claude, "拿铁")).toContain("燕麦拿铁");
    expect((await f.propose(claude, { text: COFFEE })).text).toBe(
      MCP_PROPOSE_MEMORY_ALREADY_SAVED.text,
    );
  });

  it("[direct] still holds sensitive proposals for the owner, and a connection set to ask keeps asking", async () => {
    const f = await setup({ direct: true });
    const claude = await f.connect({ elicitation: false });
    const sensitive = await f.propose(claude, {
      text: "主人有高血压，每天吃降压药",
      category: "health",
    });
    expect(sensitive.text).not.toBe(MCP_PROPOSE_MEMORY_SAVED_DIRECT.text);
    expect(sensitive.text).toContain("待确认");
    expect(await f.external()).toEqual([]);
    expect(await f.pending()).toHaveLength(1);
    const asking = await setup();
    const muse = await asking.connect({ elicitation: false });
    expect((await asking.propose(muse, { text: COFFEE })).text).toContain("待确认");
    expect(await asking.external()).toEqual([]);
    expect(await asking.pending()).toHaveLength(1);
  });

  it("[direct] saves a whole propose_memories call as one batch the owner can undo, and does not save replaced or sensitive ones", async () => {
    const f = await setup({ direct: true });
    const web = control(f);
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const sent = await batch(muse, [
      { text: COFFEE, category: "preference", key: "muse:memory/coffee" },
      { text: PARK },
      { text: "主人有高血压", category: "health" },
      { text: RAIN, key: "muse:memory/weather" },
      { text: "主人讨厌下大雨天", key: "muse:memory/weather" },
    ]);
    expect(sent.parsed.results.map(({ status }) => status)).toEqual([
      "saved",
      "saved",
      "pending",
      "replaced",
      "saved",
    ]);
    const saved = await f.external();
    expect(saved).toHaveLength(3);
    const batchIds = new Set(saved.map(({ id }) => id.split(":").at(-1)));
    expect(batchIds.size).toBe(1);
    const [batchId] = [...batchIds];
    expect(batchId).toMatch(/^batch-direct-/);
    expect(await f.pending()).toHaveLength(1);
    expect((await web.overview()).externalProposals.batches).toEqual([
      { batchId, decidedAt: NOW, committed: 3, rejected: 0 },
    ]);
    const again = await batch(muse, [{ text: PARK }]);
    expect(again.parsed.results.map(({ status }) => status)).toEqual(["already_saved"]);
    await web.command("memory.external.undo", { batchId }, "undo-direct");
    expect(await f.external()).toEqual([]);
    expect((await web.overview()).externalProposals.total).toBe(4);
  });

  it("[direct] scans active memories once for a whole propose_memories call", async () => {
    const f = await setup({ direct: true });
    const muse = await f.connect({ elicitation: false, name: "muse" });
    const before = f.activeScanCount();
    const sent = await batch(muse, [{ text: COFFEE }, { text: PARK }, { text: RAIN }]);
    expect(sent.parsed.results.map(({ status }) => status)).toEqual(["saved", "saved", "saved"]);
    expect(f.activeScanCount() - before).toBe(1);
  });

  it("[direct] keeps proposals waiting while the memory book is not ready, and an all-duplicate batch has nothing to undo", async () => {
    const waiting = await setup({ direct: true, notReady: true });
    const client = await waiting.connect({ elicitation: false });
    const held = await waiting.propose(client, { text: COFFEE });
    expect(held.result.isError).not.toBe(true);
    expect(held.text).toContain("待确认");
    expect(await waiting.external()).toEqual([]);
    const f = await setup({ direct: true });
    const web = control(f);
    const muse = await f.connect({ elicitation: false, name: "muse" });
    await batch(muse, [{ text: PARK }]);
    await batch(muse, [{ text: PARK }]);
    expect((await web.overview()).externalProposals.batches).toHaveLength(1);
  });

  it("[direct] never turns a proposed rule into a rule without the owner, even on a connection set to direct save", async () => {
    const f = await setup({ direct: true });
    const muse = await f.connect({ elicitation: false });
    const result = await f.proposeRule(muse, RULE);
    expect(result.result.isError).toBe(true);
    expect(await f.storedRules()).toEqual([]);
  });
});
