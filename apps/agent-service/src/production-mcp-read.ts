import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ClockPort,
  DecisionLedgerPort,
  DecisionLedgerWrite,
  JsonObject,
  ProactiveSettings,
  RuleRecord,
  StoredOwnerRule,
} from "@himawari-agent/application";
import {
  enforceableOwnerRule,
  parseOwnerRuleParameters,
  ruleBookFor,
} from "@himawari-agent/application";
import {
  MCP_PROPOSE_MEMORY_ALREADY_SAVED,
  MCP_PROPOSE_MEMORY_CHANGED,
  MCP_PROPOSE_MEMORY_CONFIRM,
  MCP_PROPOSE_MEMORY_DECLINED,
  MCP_PROPOSE_MEMORY_FAILED,
  MCP_PROPOSE_MEMORY_INVALID,
  MCP_PROPOSE_MEMORY_NOT_READY,
  MCP_PROPOSE_MEMORY_SAVED,
  MCP_PROPOSE_MEMORY_SENSITIVE_NOTE,
  MCP_PROPOSE_MEMORY_UNSUPPORTED,
  MCP_PROPOSE_NOT_SHOWN,
  MCP_PROPOSE_RULE_ALREADY_SAVED,
  MCP_PROPOSE_RULE_CONDITIONS,
  MCP_PROPOSE_RULE_CONFIRM,
  MCP_PROPOSE_RULE_DECLINED,
  MCP_PROPOSE_RULE_FAILED,
  MCP_PROPOSE_RULE_INVALID,
  MCP_PROPOSE_RULE_KIND_NOTIFY,
  MCP_PROPOSE_RULE_KIND_WHOLE_THREAD,
  MCP_PROPOSE_RULE_REPLAY,
  MCP_PROPOSE_RULE_REPLAY_UNAVAILABLE,
  MCP_PROPOSE_RULE_SAVED,
  MCP_TOOL_FIND_MEMORIES,
  MCP_TOOL_PROPOSE_MEMORY,
  MCP_TOOL_PROPOSE_RULE,
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
import {
  EXTERNAL_RULE_REASON_MAXIMUM,
  EXTERNAL_RULE_TYPES,
  type ExternalRuleProposal,
  type ExternalRuleType,
} from "./production-mcp-rule-writer.js";
import type { RecallResult } from "./production-memory-recall.js";
import type { RulePreview } from "./production-owner-rules.js";
import type { ListedReminder } from "./production-reminder-writer.js";
import type { MailEmbeddingContext } from "./production-run-memory.js";

export const MCP_READ_PATH = "/api/mcp/v1";
export const MCP_READ_BODY_LIMIT = 65_536;
export const MCP_READ_SECRET_MINIMUM_LENGTH = 32;
export const MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"] as const;
export const MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_rule"] as const;
export const MCP_PROPOSAL_CONFIRM_KEY = "confirm";
export const MCP_PROPOSAL_UNSEEN_ANSWER_MS = 1_500;
export const MCP_PROPOSAL_STATE_TTL_SECONDS = 600;
const WRITE_ACCESS = "himawari:write";
const READ_ACCESS = "himawari:read";
export const TODAY_CONTEXT_REMINDER_WINDOW_MS = 48 * 3_600_000;
export const TODAY_CONTEXT_SUMMARY_DAYS = 2;
export const TODAY_CONTEXT_SUMMARY_LIMIT = 8;
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
  readonly ownerRules?: () => Promise<readonly StoredOwnerRule[]>;
  readonly summaries?: (input: { readonly days: number; readonly limit: number }) => Promise<{
    readonly summaries: readonly {
      readonly id: string;
      readonly day: string;
      readonly text: string;
    }[];
    readonly partial: boolean;
  }>;
}

export interface McpMemoryProposals {
  readonly ready: () => Promise<boolean>;
  readonly decided: (proposalId: string) => Promise<ExternalProposalDecision | undefined>;
  readonly keep: (proposal: ExternalMemoryProposal, started: number) => Promise<string>;
  readonly decline: (proposal: ExternalMemoryProposal, started: number) => Promise<void>;
}

export interface McpRuleProposals {
  readonly preview: (input: {
    readonly type: string;
    readonly params: unknown;
    readonly summary: string;
  }) => Promise<RulePreview>;
  readonly decided: (proposalId: string) => Promise<boolean>;
  readonly accept: (proposal: ExternalRuleProposal) => Promise<string>;
}

export interface McpWriteAccess {
  readonly secret: string;
  readonly proposals: McpMemoryProposals;
  readonly rules: McpRuleProposals;
}

export type McpAdmission =
  | { readonly status: "ok"; readonly authInfo: AuthInfo }
  | { readonly status: "unauthorized" | "rate_limited" };

interface ProposalState {
  readonly tool: "propose_memory" | "propose_rule";
  readonly proposalId: string;
  readonly argsHash: string;
  readonly client: string;
  readonly askedAt: number;
}

type ProposalTicket = Omit<ProposalState, "askedAt">;

export type McpProposalAnswer = "accepted" | "declined" | "unseen";

export function mcpProposalAnswer(
  action: "accept" | "decline" | "cancel",
  askedAt: number,
  answeredAt: number,
): McpProposalAnswer {
  if (action === "accept") return "accepted";
  return answeredAt - askedAt < MCP_PROPOSAL_UNSEEN_ANSWER_MS ? "unseen" : "declined";
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
  readonly onSummariesFailed: (error: unknown) => void;
}

interface SummaryRead {
  readonly ids: readonly string[];
  readonly days: readonly string[];
  readonly characters: number;
  readonly read: "off" | "ok" | "partial" | "failed";
}

interface ToolOutcome {
  readonly output: Record<string, unknown>;
  readonly memoryIds: readonly string[];
  readonly summaries?: SummaryRead;
}

const SUMMARIES_FAILED: SummaryRead = Object.freeze({
  ids: [],
  days: [],
  characters: 0,
  read: "failed",
});

const SUMMARIES_INCOMPLETE = "MCP_READ_SUMMARIES_INCOMPLETE";

const SUMMARIES_NOT_TRIED: SummaryRead = Object.freeze({
  ids: [],
  days: [],
  characters: 0,
  read: "off",
});

interface ReadTrace {
  costMicros: number;
  summariesTried: boolean;
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

function ownerRuleEntry(row: StoredOwnerRule): Record<string, unknown> {
  const stored =
    row.parameters !== null && typeof row.parameters === "object"
      ? (row.parameters as Record<string, unknown>)
      : {};
  const enforced = enforcedOwnerRule(row);
  const rule = enforced?.rule;
  return {
    id: row.ruleId,
    revision: row.revision,
    ...(rule ? { gate: rule.gate, outcome: rule.outcome } : {}),
    origin: "owner_setting",
    source: row.source,
    status: row.status,
    enforced: rule !== undefined,
    ...(enforced
      ? { type: enforced.type, summary: enforced.summary, parameters: enforced.params }
      : {
          ...(typeof stored["type"] === "string" ? { type: stored["type"] } : {}),
          ...(typeof stored["summary"] === "string" ? { summary: stored["summary"] } : {}),
        }),
  };
}

function enforcedOwnerRule(row: StoredOwnerRule):
  | {
      readonly rule: RuleRecord;
      readonly type: string;
      readonly summary: string;
      readonly params: unknown;
    }
  | undefined {
  try {
    const rule = enforceableOwnerRule(row);
    if (!rule) return undefined;
    const parsed = parseOwnerRuleParameters(row.parameters);
    return { rule, type: parsed.type, summary: parsed.summary, params: parsed.params };
  } catch {
    return undefined;
  }
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
  if (elicitation === null || typeof elicitation !== "object" || Array.isArray(elicitation))
    return false;
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
  readonly #decidedRules = new Map<string, { readonly until: number; readonly saved: boolean }>();

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
      run: (args: JsonObject, signal: AbortSignal, trace: ReadTrace) => Promise<ToolOutcome>,
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
      (args, signal, trace) => this.#findMemories(args, signal, trace),
    );
    register(
      "today_context",
      MCP_TOOL_TODAY_CONTEXT.text,
      { type: "object", properties: {}, additionalProperties: false },
      (_args, _signal, trace) => this.#todayContext(trace),
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
    const rules = this.#options.write?.rules;
    if (
      rules &&
      context.era === "modern" &&
      context.authInfo?.scopes.includes(WRITE_ACCESS) === true
    ) {
      const list = { type: "array", items: { type: "string" } };
      server.registerTool(
        "propose_rule",
        {
          description: MCP_TOOL_PROPOSE_RULE.text,
          inputSchema: fromJsonSchema<JsonObject>({
            type: "object",
            properties: {
              type: { type: "string", enum: [...EXTERNAL_RULE_TYPES] },
              params: {
                type: "object",
                properties: {
                  senderDomains: list,
                  senderAddresses: list,
                  phrases: list,
                  words: list,
                  excludePhrases: list,
                },
                additionalProperties: false,
              },
              summary: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
            required: ["type", "params", "summary", "reason"],
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
          this.#proposeRule(
            rules,
            args,
            clientNameOf(handlerContext.mcpReq.envelope, userAgent),
            handlerContext,
          ),
      );
    }
    return server;
  }

  async #proposeRule(
    rules: McpRuleProposals,
    args: JsonObject,
    client: string,
    context: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    const reason = normalizeProposalText(typeof args["reason"] === "string" ? args["reason"] : "");
    let parsed: { readonly type: string; readonly params: unknown; readonly summary: string };
    try {
      parsed = parseOwnerRuleParameters({
        type: args["type"],
        params: args["params"],
        summary: typeof args["summary"] === "string" ? args["summary"].trim() : args["summary"],
      });
    } catch {
      return proposalReply(MCP_PROPOSE_RULE_INVALID.text, true);
    }
    if (
      reason.length === 0 ||
      [...reason].length > EXTERNAL_RULE_REASON_MAXIMUM ||
      !(EXTERNAL_RULE_TYPES as readonly string[]).includes(parsed.type)
    )
      return proposalReply(MCP_PROPOSE_RULE_INVALID.text, true);
    const argsHash = createHash("sha256")
      .update(JSON.stringify(["propose_rule", parsed.type, parsed.params, parsed.summary, reason]))
      .digest("hex");
    const state = context.mcpReq.requestState<ProposalState>();
    try {
      if (state === undefined) {
        if (!elicitationSupported(context.mcpReq.envelope))
          return proposalReply(MCP_PROPOSE_MEMORY_UNSUPPORTED.text, true);
        if (!(await this.#options.write?.proposals.ready()))
          return proposalReply(MCP_PROPOSE_MEMORY_NOT_READY.text, true);
        return await this.#askRuleConfirmation(
          rules,
          { tool: "propose_rule", proposalId: randomUUID(), argsHash, client },
          { ...parsed, type: parsed.type as ExternalRuleType, reason, client },
          context,
        );
      }
      if (
        typeof state !== "object" ||
        state === null ||
        state.tool !== "propose_rule" ||
        typeof state.proposalId !== "string" ||
        typeof state.client !== "string" ||
        typeof state.askedAt !== "number" ||
        state.argsHash !== argsHash
      )
        return proposalReply(MCP_PROPOSE_MEMORY_CHANGED.text, true);
      const proposal: ExternalRuleProposal = {
        proposalId: state.proposalId,
        type: parsed.type as ExternalRuleType,
        params: parsed.params,
        summary: parsed.summary,
        reason,
        client: state.client,
      };
      return await this.#oneAtATime(state.proposalId, async () => {
        const now = Date.now();
        for (const [proposalId, { until }] of this.#decidedRules)
          if (until <= now) this.#decidedRules.delete(proposalId);
        const remembered = this.#decidedRules.get(proposal.proposalId);
        if (remembered)
          return proposalReply(
            remembered.saved ? MCP_PROPOSE_RULE_ALREADY_SAVED.text : MCP_PROPOSE_RULE_DECLINED.text,
            false,
          );
        if (await rules.decided(proposal.proposalId))
          return proposalReply(MCP_PROPOSE_RULE_ALREADY_SAVED.text, false);
        const answer = inputResponse(context.mcpReq.inputResponses, MCP_PROPOSAL_CONFIRM_KEY);
        if (answer.kind !== "elicit")
          return await this.#askRuleConfirmation(rules, state, proposal, context);
        const outcome = mcpProposalAnswer(
          answer.action,
          state.askedAt,
          Date.parse(this.#options.clock.now()),
        );
        if (outcome === "unseen") return proposalReply(MCP_PROPOSE_NOT_SHOWN.text, true);
        if (outcome === "accepted") {
          await rules.accept(proposal);
          this.#decidedRules.set(proposal.proposalId, {
            until: Date.now() + MCP_PROPOSAL_STATE_TTL_SECONDS * 1000,
            saved: true,
          });
          return proposalReply(MCP_PROPOSE_RULE_SAVED.text, false);
        }
        this.#decidedRules.set(proposal.proposalId, {
          until: now + MCP_PROPOSAL_STATE_TTL_SECONDS * 1000,
          saved: false,
        });
        return proposalReply(MCP_PROPOSE_RULE_DECLINED.text, false);
      });
    } catch (error) {
      this.#options.onFailure(error);
      return proposalReply(MCP_PROPOSE_RULE_FAILED.text, true);
    }
  }

  async #askRuleConfirmation(
    rules: McpRuleProposals,
    ticket: ProposalTicket,
    proposal: Pick<ExternalRuleProposal, "type" | "params" | "summary" | "reason" | "client">,
    context: ServerContext,
  ): Promise<InputRequiredResult> {
    const preview = await rules.preview(proposal);
    const params = (preview.params ?? {}) as Record<string, unknown>;
    const listed = (key: string) => {
      const value = params[key];
      return Array.isArray(value) && value.length > 0 ? value.join("、") : "—";
    };
    return inputRequired({
      inputRequests: {
        [MCP_PROPOSAL_CONFIRM_KEY]: inputRequired.elicit({
          message: renderPrompt(MCP_PROPOSE_RULE_CONFIRM, {
            client: proposal.client,
            summary: preview.summary,
            kind:
              preview.type === "mail_must_notify"
                ? MCP_PROPOSE_RULE_KIND_NOTIFY.text
                : MCP_PROPOSE_RULE_KIND_WHOLE_THREAD.text,
            conditions: renderPrompt(MCP_PROPOSE_RULE_CONDITIONS, {
              senderDomains: listed("senderDomains"),
              senderAddresses: listed("senderAddresses"),
              phrases: listed("phrases"),
              words: listed("words"),
              excludePhrases: listed("excludePhrases"),
            }),
            replay: preview.replay
              ? renderPrompt(MCP_PROPOSE_RULE_REPLAY, {
                  days: String(preview.replay.days),
                  checked: String(preview.replay.mailsChecked),
                  hit: String(preview.replay.mailsHit),
                  changed: String(preview.replay.changed),
                })
              : MCP_PROPOSE_RULE_REPLAY_UNAVAILABLE.text,
            reason: proposal.reason,
          }),
          requestedSchema: { type: "object", properties: {} },
        }),
      },
      requestState: await this.#stateCodec.mint(
        {
          tool: ticket.tool,
          proposalId: ticket.proposalId,
          argsHash: ticket.argsHash,
          client: ticket.client,
          askedAt: Date.parse(this.#options.clock.now()),
        },
        context,
      ),
    });
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
        typeof state.askedAt !== "number" ||
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
        const outcome = mcpProposalAnswer(answer.action, state.askedAt, started);
        if (outcome === "unseen") return proposalReply(MCP_PROPOSE_NOT_SHOWN.text, true);
        if (outcome === "accepted") {
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
    ticket: ProposalTicket,
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
          requestedSchema: { type: "object", properties: {} },
        }),
      },
      requestState: await this.#stateCodec.mint(
        {
          tool: ticket.tool,
          proposalId: ticket.proposalId,
          argsHash: ticket.argsHash,
          client: ticket.client,
          askedAt: Date.parse(this.#options.clock.now()),
        },
        context,
      ),
    });
  }

  async #call(
    name: McpReadToolName,
    client: string,
    args: JsonObject,
    signal: AbortSignal,
    run: (args: JsonObject, signal: AbortSignal, trace: ReadTrace) => Promise<ToolOutcome>,
  ): Promise<CallToolResult> {
    const started = Date.parse(this.#options.clock.now());
    const trace: ReadTrace = { costMicros: 0, summariesTried: false };
    let delivered:
      | {
          readonly text: string;
          readonly memoryIds: readonly string[];
          readonly summaries?: SummaryRead;
        }
      | undefined;
    try {
      const outcome = await run(args, signal, trace);
      delivered = {
        text: JSON.stringify(maskForExternalRead(outcome.output)),
        memoryIds: outcome.memoryIds,
        ...(outcome.summaries ? { summaries: outcome.summaries } : {}),
      };
    } catch (error) {
      this.#options.onFailure(error);
    }
    const summaries =
      name === "today_context" && this.#options.sources.summaries
        ? (delivered?.summaries ?? (trace.summariesTried ? SUMMARIES_FAILED : SUMMARIES_NOT_TRIED))
        : undefined;
    try {
      await this.#record(name, client, delivered?.memoryIds, summaries, trace.costMicros, started);
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
    summaries: SummaryRead | undefined,
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
      inputs: {
        memoryIds: memoryIds ?? [],
        ruleIds: [],
        ...(summaries
          ? {
              summaryInjected: summaries.ids.length > 0,
              summaryIds: summaries.ids,
              summaryDays: summaries.days,
              summaryCharacters: summaries.characters,
              summaryRead: summaries.read,
              summaryGenerated: 0,
            }
          : {}),
      },
      reasonRef: null,
      contentRef: null,
      costMicros,
      durationMs: Math.max(0, Date.parse(decidedAt) - started),
    });
  }

  async #findMemories(
    args: JsonObject,
    signal: AbortSignal,
    trace: ReadTrace,
  ): Promise<ToolOutcome> {
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
      trace.costMicros = context.costMicros;
    }
  }

  async #recentDays(trace: ReadTrace): Promise<{
    readonly output: Record<string, unknown>;
    readonly read?: SummaryRead;
  }> {
    const source = this.#options.sources.summaries;
    if (!source) return { output: {} };
    trace.summariesTried = true;
    try {
      const found = await source({
        days: TODAY_CONTEXT_SUMMARY_DAYS,
        limit: TODAY_CONTEXT_SUMMARY_LIMIT,
      });
      if (found.partial) this.#options.onSummariesFailed(new Error(SUMMARIES_INCOMPLETE));
      const recentDays = found.summaries.map(({ day, text }) => ({ day, text }));
      return {
        output: { recentDays, ...(found.partial ? { recentDaysComplete: false } : {}) },
        read: {
          ids: found.summaries.map(({ id }) => id),
          days: [...new Set(found.summaries.map(({ day }) => day))],
          characters: found.summaries.reduce((total, { text }) => total + [...text].length, 0),
          read: found.partial ? "partial" : "ok",
        },
      };
    } catch (error) {
      this.#options.onSummariesFailed(error);
      return { output: { recentDays: [], recentDaysComplete: false }, read: SUMMARIES_FAILED };
    }
  }

  async #todayContext(trace: ReadTrace): Promise<ToolOutcome> {
    const now = this.#options.clock.now();
    const listed = await this.#options.sources.reminders(TODAY_CONTEXT_REMINDER_WINDOW_MS);
    const recent = await this.#recentDays(trace);
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
        ...recent.output,
      },
      memoryIds: listed.reminders.map(({ memoryId }) => memoryId),
      ...(recent.read ? { summaries: recent.read } : {}),
    };
  }

  async #ruleBook(): Promise<ToolOutcome> {
    const settings = await this.#options.sources.settings();
    const owned = this.#options.sources.ownerRules
      ? [...(await this.#options.sources.ownerRules())].sort((a, b) =>
          a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0,
        )
      : [];
    return {
      output: {
        rules: [
          ...ruleBookFor(settings).map((rule) => ({
            id: rule.id,
            revision: rule.revision,
            gate: rule.gate,
            outcome: rule.outcome,
            origin: rule.origin,
            source: rule.source,
            status: rule.status,
            ...ruleParameters(rule, settings),
          })),
          ...owned.map(ownerRuleEntry),
        ],
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
