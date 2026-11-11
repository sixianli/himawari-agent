import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ClockPort,
  DecisionLedgerPort,
  DecisionLedgerWrite,
  JsonObject,
  ProactiveSettings,
  RuleRecord,
} from "@himawari-agent/application";
import { ruleBookFor } from "@himawari-agent/application";
import {
  MCP_PROPOSE_MEMORY_ALREADY_SAVED,
  MCP_PROPOSE_MEMORY_CHANGED,
  MCP_PROPOSE_MEMORY_CONFIRM,
  MCP_PROPOSE_MEMORY_DECLINED,
  MCP_PROPOSE_MEMORY_FAILED,
  MCP_PROPOSE_MEMORY_INVALID,
  MCP_PROPOSE_MEMORY_NOT_READY,
  MCP_PROPOSE_MEMORY_SAVE_LABEL,
  MCP_PROPOSE_MEMORY_SAVED,
  MCP_PROPOSE_MEMORY_SENSITIVE_NOTE,
  MCP_PROPOSE_MEMORY_UNSUPPORTED,
  MCP_TOOL_FIND_MEMORIES,
  MCP_TOOL_PROPOSE_MEMORY,
  MCP_TOOL_RESULT_FAILED,
  MCP_TOOL_RULE_BOOK,
  MCP_TOOL_TODAY_CONTEXT,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { maskSensitiveTexts } from "@himawari-agent/sensitive-capture";
import {
  type AuthInfo,
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  createRequestStateCodec,
  fromJsonSchema,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BearerGate } from "./bearer-admission.js";
import {
  EXTERNAL_PROPOSAL_CATEGORIES,
  EXTERNAL_PROPOSAL_TEXT_MAXIMUM,
  type ExternalMemoryProposal,
  type ExternalProposalCategory,
  type ExternalProposalDecision,
  normalizeProposalText,
  proposalClassification,
} from "./production-mcp-memory-writer.js";
import type { RecallResult } from "./production-memory-recall.js";
import type { ListedReminder } from "./production-reminder-writer.js";
import type { MailEmbeddingContext } from "./production-run-memory.js";

export const MCP_READ_PATH = "/api/mcp/v1";
export const MCP_READ_BODY_LIMIT = 65_536;
export const MCP_READ_SECRET_MINIMUM_LENGTH = 32;
export const MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"] as const;
export const MCP_WRITE_TOOL_NAMES = ["propose_memory"] as const;
export const MCP_PROPOSAL_CONFIRM_KEY = "confirm";
export const MCP_PROPOSAL_SAVE_FIELD = "save";
export const MCP_PROPOSAL_STATE_TTL_SECONDS = 600;
const WRITE_ACCESS = "himawari:write";
const READ_ACCESS = "himawari:read";
export const TODAY_CONTEXT_REMINDER_WINDOW_MS = 48 * 3_600_000;
const SERVER_NAME = "himawari";
const SERVER_VERSION = "1.0.0";
const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}/u;

type McpReadToolName = (typeof MCP_READ_TOOL_NAMES)[number];

export interface McpReadSources {
  readonly recall: (
    args: JsonObject,
    within: <T>(slot: string, operation: () => Promise<T>) => Promise<T>,
  ) => Promise<RecallResult>;
  readonly embedOutsideRun: <T>(
    context: MailEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly reminders: (windowMs: number) => Promise<{
    readonly reminders: readonly ListedReminder[];
    readonly more: boolean;
  }>;
  readonly settings: () => Promise<ProactiveSettings>;
}

export interface McpMemoryProposals {
  readonly ready: () => Promise<boolean>;
  readonly decided: (proposalId: string) => Promise<ExternalProposalDecision | undefined>;
  readonly keep: (proposal: ExternalMemoryProposal, started: number) => Promise<string>;
  readonly decline: (proposal: ExternalMemoryProposal, started: number) => Promise<void>;
}

export interface McpWriteAccess {
  readonly secret: string;
  readonly proposals: McpMemoryProposals;
}

export type McpAdmission =
  | { readonly status: "ok"; readonly authInfo: AuthInfo }
  | { readonly status: "unauthorized" | "rate_limited" };

interface ProposalState {
  readonly tool: "propose_memory";
  readonly proposalId: string;
  readonly argsHash: string;
  readonly client: string;
}

export interface ProductionMcpReadOptions {
  readonly scope: Pick<DecisionLedgerWrite, "ownerId" | "agentId">;
  readonly clock: ClockPort;
  readonly secret: string;
  readonly write?: McpWriteAccess;
  readonly timeZone: string;
  readonly requestTimeoutMs: number;
  readonly sources: McpReadSources;
  readonly ledger: Pick<DecisionLedgerPort, "append">;
  readonly onFailure: (error: unknown) => void;
}

interface ToolOutcome {
  readonly output: Record<string, unknown>;
  readonly memoryIds: readonly string[];
}

interface ReadCost {
  costMicros: number;
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        mapStrings(entry, map),
      ]),
    );
  return value;
}

export function maskForExternalRead(value: unknown): unknown {
  const texts: string[] = [];
  mapStrings(value, (text) => {
    texts.push(text);
    return text;
  });
  const masked = maskSensitiveTexts(texts);
  let next = 0;
  return mapStrings(value, () => masked[next++] ?? "");
}

function localDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

function ruleParameters(rule: RuleRecord, settings: ProactiveSettings): Record<string, unknown> {
  if (rule.id === "quiet_hours") return { quietHours: settings.quietHours };
  if (rule.id === "floor_important_sender") return { importantSenders: settings.importantSenders };
  return {};
}

function clientNameOf(envelope: unknown, userAgent: string | null): string {
  const info =
    envelope !== null && typeof envelope === "object"
      ? (envelope as Record<string, unknown>)[CLIENT_INFO_META_KEY]
      : undefined;
  const declared =
    info !== null && typeof info === "object" && "name" in info && typeof info.name === "string"
      ? info.name
      : null;
  return (declared ?? userAgent ?? "").trim().match(CLIENT_NAME)?.[0] ?? "unknown";
}

function proposalReply(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function elicitationSupported(envelope: unknown): boolean {
  const capabilities =
    envelope !== null && typeof envelope === "object"
      ? (envelope as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY]
      : undefined;
  if (capabilities === null || typeof capabilities !== "object") return false;
  const elicitation = (capabilities as Record<string, unknown>)["elicitation"];
  if (elicitation === null || typeof elicitation !== "object") return false;
  const modes = Object.keys(elicitation);
  return modes.length === 0 || modes.includes("form");
}

export class ProductionMcpRead {
  readonly #options: ProductionMcpReadOptions;
  readonly #gate: BearerGate;
  readonly handler: McpHttpHandler;

  readonly #writeGate: BearerGate | undefined;
  readonly #stateCodec: RequestStateCodec<ProposalState>;
  readonly #deciding = new Map<string, Promise<void>>();

  constructor(options: ProductionMcpReadOptions) {
    this.#options = options;
    this.#gate = new BearerGate(
      options.clock,
      options.secret,
      MCP_READ_SECRET_MINIMUM_LENGTH,
      "MCP_READ_SECRET_TOO_SHORT",
    );
    if (options.write && options.write.secret === options.secret)
      throw new Error("MCP_WRITE_SECRET_REUSED");
    this.#writeGate = options.write
      ? new BearerGate(
          options.clock,
          options.write.secret,
          MCP_READ_SECRET_MINIMUM_LENGTH,
          "MCP_WRITE_SECRET_TOO_SHORT",
        )
      : undefined;
    this.#stateCodec = createRequestStateCodec<ProposalState>({
      key: randomBytes(32),
      ttlSeconds: MCP_PROPOSAL_STATE_TTL_SECONDS,
      bind: (context) => `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? ""}`,
    });
    this.handler = createMcpHandler((context) => this.#server(context), {
      onerror: options.onFailure,
    });
  }

  admit(authorization: string | undefined): McpAdmission {
    const writing = this.#writeGate?.matches(authorization) === true;
    const status = (writing ? this.#writeGate : this.#gate)?.admit(authorization) ?? "unauthorized";
    if (status !== "ok") return { status };
    const access = writing ? WRITE_ACCESS : READ_ACCESS;
    return { status, authInfo: { token: "", clientId: access, scopes: [access] } };
  }

  #server(context: McpRequestContext): McpServer {
    const request = context.requestInfo ?? null;
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        requestState: { verify: this.#stateCodec.verify },
        inputRequired: { legacyShim: false },
      },
    );
    const userAgent = request?.headers.get("user-agent") ?? null;
    const register = (
      name: McpReadToolName,
      description: string,
      inputSchema: Record<string, unknown>,
      run: (args: JsonObject, signal: AbortSignal, cost: ReadCost) => Promise<ToolOutcome>,
    ) =>
      server.registerTool(
        name,
        {
          description,
          inputSchema: fromJsonSchema<JsonObject>(inputSchema as never),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args: JsonObject, context) =>
          this.#call(
            name,
            clientNameOf(context.mcpReq.envelope, userAgent),
            args,
            context.mcpReq.signal,
            run,
          ),
      );
    register(
      "find_memories",
      MCP_TOOL_FIND_MEMORIES.text,
      {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      (args, signal, cost) => this.#findMemories(args, signal, cost),
    );
    register(
      "today_context",
      MCP_TOOL_TODAY_CONTEXT.text,
      { type: "object", properties: {}, additionalProperties: false },
      () => this.#todayContext(),
    );
    register(
      "rule_book",
      MCP_TOOL_RULE_BOOK.text,
      { type: "object", properties: {}, additionalProperties: false },
      () => this.#ruleBook(),
    );
    const proposals = this.#options.write?.proposals;
    if (
      proposals &&
      context.era === "modern" &&
      context.authInfo?.scopes.includes(WRITE_ACCESS) === true
    )
      server.registerTool(
        "propose_memory",
        {
          description: MCP_TOOL_PROPOSE_MEMORY.text,
          inputSchema: fromJsonSchema<JsonObject>({
            type: "object",
            properties: {
              text: { type: "string", minLength: 1 },
              category: { type: "string", enum: [...EXTERNAL_PROPOSAL_CATEGORIES] },
            },
            required: ["text"],
            additionalProperties: false,
          } as never),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async (args: JsonObject, handlerContext) =>
          this.#proposeMemory(
            proposals,
            args,
            clientNameOf(handlerContext.mcpReq.envelope, userAgent),
            handlerContext,
          ),
      );
    return server;
  }

  async #proposeMemory(
    proposals: McpMemoryProposals,
    args: JsonObject,
    client: string,
    context: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    const started = Date.parse(this.#options.clock.now());
    const text = normalizeProposalText(typeof args["text"] === "string" ? args["text"] : "");
    const category = (
      typeof args["category"] === "string" ? args["category"] : "other"
    ) as ExternalProposalCategory;
    if (
      text.length === 0 ||
      [...text].length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM ||
      !(EXTERNAL_PROPOSAL_CATEGORIES as readonly string[]).includes(category)
    )
      return proposalReply(MCP_PROPOSE_MEMORY_INVALID.text, true);
    const argsHash = createHash("sha256")
      .update(JSON.stringify([text, category]))
      .digest("hex");
    const state = context.mcpReq.requestState<ProposalState>();
    try {
      if (state === undefined) {
        if (!elicitationSupported(context.mcpReq.envelope))
          return proposalReply(MCP_PROPOSE_MEMORY_UNSUPPORTED.text, true);
        if (!(await proposals.ready()))
          return proposalReply(MCP_PROPOSE_MEMORY_NOT_READY.text, true);
        return await this.#askConfirmation(
          { tool: "propose_memory", proposalId: randomUUID(), argsHash, client },
          { text, category, client },
          context,
        );
      }
      if (
        typeof state !== "object" ||
        state === null ||
        state.tool !== "propose_memory" ||
        typeof state.proposalId !== "string" ||
        typeof state.client !== "string" ||
        state.argsHash !== argsHash
      )
        return proposalReply(MCP_PROPOSE_MEMORY_CHANGED.text, true);
      const proposal: ExternalMemoryProposal = {
        proposalId: state.proposalId,
        text,
        category,
        client: state.client,
      };
      return await this.#oneAtATime(state.proposalId, async () => {
        const decided = await proposals.decided(proposal.proposalId);
        if (decided === "kept") return proposalReply(MCP_PROPOSE_MEMORY_ALREADY_SAVED.text, false);
        if (decided === "declined") return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
        const answer = inputResponse(context.mcpReq.inputResponses, MCP_PROPOSAL_CONFIRM_KEY);
        if (answer.kind !== "elicit") return await this.#askConfirmation(state, proposal, context);
        if (answer.action === "accept" && answer.content?.[MCP_PROPOSAL_SAVE_FIELD] === true) {
          await proposals.keep(proposal, started);
          return proposalReply(MCP_PROPOSE_MEMORY_SAVED.text, false);
        }
        await proposals.decline(proposal, started);
        return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
      });
    } catch (error) {
      this.#options.onFailure(error);
      return proposalReply(MCP_PROPOSE_MEMORY_FAILED.text, true);
    }
  }

  async #oneAtATime<T>(proposalId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#deciding.get(proposalId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#deciding.set(proposalId, settled);
    try {
      return await current;
    } finally {
      if (this.#deciding.get(proposalId) === settled) this.#deciding.delete(proposalId);
    }
  }

  async #askConfirmation(
    state: ProposalState,
    proposal: Pick<ExternalMemoryProposal, "text" | "category" | "client">,
    context: ServerContext,
  ): Promise<InputRequiredResult> {
    const sensitive = proposalClassification(proposal.text, proposal.category) === "sensitive";
    return inputRequired({
      inputRequests: {
        [MCP_PROPOSAL_CONFIRM_KEY]: inputRequired.elicit({
          message: renderPrompt(MCP_PROPOSE_MEMORY_CONFIRM, {
            client: proposal.client,
            category: proposal.category,
            sensitive: sensitive ? MCP_PROPOSE_MEMORY_SENSITIVE_NOTE.text : "",
            text: proposal.text,
          }),
          requestedSchema: {
            type: "object",
            properties: {
              [MCP_PROPOSAL_SAVE_FIELD]: {
                type: "boolean",
                title: MCP_PROPOSE_MEMORY_SAVE_LABEL.text,
              },
            },
            required: [MCP_PROPOSAL_SAVE_FIELD],
          },
        }),
      },
      requestState: await this.#stateCodec.mint(state, context),
    });
  }

  async #call(
    name: McpReadToolName,
    client: string,
    args: JsonObject,
    signal: AbortSignal,
    run: (args: JsonObject, signal: AbortSignal, cost: ReadCost) => Promise<ToolOutcome>,
  ): Promise<CallToolResult> {
    const started = Date.parse(this.#options.clock.now());
    const cost: ReadCost = { costMicros: 0 };
    let delivered: { readonly text: string; readonly memoryIds: readonly string[] } | undefined;
    try {
      const outcome = await run(args, signal, cost);
      delivered = {
        text: JSON.stringify(maskForExternalRead(outcome.output)),
        memoryIds: outcome.memoryIds,
      };
    } catch (error) {
      this.#options.onFailure(error);
    }
    try {
      await this.#record(name, client, delivered?.memoryIds, cost.costMicros, started);
    } catch (error) {
      this.#options.onFailure(error);
      delivered = undefined;
    }
    return delivered
      ? { content: [{ type: "text", text: delivered.text }] }
      : { content: [{ type: "text", text: MCP_TOOL_RESULT_FAILED.text }], isError: true };
  }

  async #record(
    name: McpReadToolName,
    client: string,
    memoryIds: readonly string[] | undefined,
    costMicros: number,
    started: number,
  ): Promise<void> {
    const decidedAt = this.#options.clock.now();
    await this.#options.ledger.append({
      id: `ledger:${randomUUID()}`,
      ...this.#options.scope,
      kind: "external_read",
      decidedAt,
      outcome: "read",
      reasonCode: memoryIds ? name : `${name}_failed`,
      subjectRef: `mcp-client:${client}`,
      inputs: { memoryIds: memoryIds ?? [], ruleIds: [] },
      reasonRef: null,
      contentRef: null,
      costMicros,
      durationMs: Math.max(0, Date.parse(decidedAt) - started),
    });
  }

  async #findMemories(args: JsonObject, signal: AbortSignal, cost: ReadCost): Promise<ToolOutcome> {
    const context: MailEmbeddingContext = {
      deadlineAt: new Date(
        Date.parse(this.#options.clock.now()) + this.#options.requestTimeoutMs,
      ).toISOString(),
      signal,
      costMicros: 0,
    };
    try {
      const result = await this.#options.sources.recall(args, (_slot, operation) =>
        this.#options.sources.embedOutsideRun(context, operation),
      );
      return { output: result.output, memoryIds: result.memoryIds };
    } finally {
      cost.costMicros = context.costMicros;
    }
  }

  async #todayContext(): Promise<ToolOutcome> {
    const now = this.#options.clock.now();
    const listed = await this.#options.sources.reminders(TODAY_CONTEXT_REMINDER_WINDOW_MS);
    return {
      output: {
        today: localDay(now, this.#options.timeZone),
        timeZone: this.#options.timeZone,
        now,
        reminders: listed.reminders.map((reminder) => ({
          text: reminder.text,
          dueAt: reminder.dueAt,
          remindAt: reminder.remindAt,
          repeat: reminder.repeat,
        })),
        ...(listed.more ? { more: true } : {}),
      },
      memoryIds: listed.reminders.map(({ memoryId }) => memoryId),
    };
  }

  async #ruleBook(): Promise<ToolOutcome> {
    const settings = await this.#options.sources.settings();
    return {
      output: {
        rules: ruleBookFor(settings).map((rule) => ({
          id: rule.id,
          revision: rule.revision,
          gate: rule.gate,
          outcome: rule.outcome,
          origin: rule.origin,
          source: rule.source,
          status: rule.status,
          ...ruleParameters(rule, settings),
        })),
      },
      memoryIds: [],
    };
  }
}

function webRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  const host = request.headers.host ?? "localhost";
  return new Request(new URL(request.url, `${request.protocol}://${host}`), {
    method: request.method,
    headers,
    ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? null) } : {}),
  });
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.code(response.status).header("cache-control", "no-store");
  response.headers.forEach((value, name) => {
    if (name !== "content-length" && name !== "cache-control") reply.header(name, value);
  });
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

export function registerMcpReadRoute(app: FastifyInstance, mcp: ProductionMcpRead): void {
  const admitted = new WeakMap<FastifyRequest, AuthInfo>();
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error.statusCode as number)
          : 500;
      const known = status === 400 || status === 413 || status === 415;
      return reply
        .code(known ? status : 500)
        .header("cache-control", "no-store")
        .send({ error: known ? "request_invalid" : "failed" });
    });
    scope.route({
      method: ["GET", "POST", "DELETE"],
      url: MCP_READ_PATH,
      bodyLimit: MCP_READ_BODY_LIMIT,
      onRequest: async (request, reply) => {
        const gate = mcp.admit(request.headers.authorization);
        if (gate.status === "ok") {
          admitted.set(request, gate.authInfo);
          return;
        }
        return reply
          .code(gate.status === "unauthorized" ? 401 : 429)
          .header("cache-control", "no-store")
          .header("www-authenticate", 'Bearer realm="himawari"')
          .send();
      },
      handler: async (request, reply) =>
        sendWebResponse(
          reply,
          await mcp.handler.fetch(webRequest(request), {
            ...(request.method === "POST" ? { parsedBody: request.body } : {}),
            ...(admitted.has(request) ? { authInfo: admitted.get(request) as AuthInfo } : {}),
          }),
        ),
    });
  });
}
