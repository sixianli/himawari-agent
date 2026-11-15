import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ClockPort,
  DataClassification,
  DecisionLedgerPort,
  DecisionLedgerWrite,
  JsonObject,
  McpConnectionEntry,
  McpConnectionPushPolicy,
  McpConnectionStorePort,
  McpUsageCounter,
  OwnerIdentityStatePort,
  OwnerProfileOutline,
  ProactiveSettings,
  RuleRecord,
  StoredOwnerRule,
} from "@himawari-agent/application";
import {
  classificationRank,
  enforceableOwnerRule,
  parseOwnerRuleParameters,
  ruleBookFor,
} from "@himawari-agent/application";
import {
  MCP_PROPOSE_MEMORIES_RESULT,
  MCP_PROPOSE_MEMORY_ALREADY_SAVED,
  MCP_PROPOSE_MEMORY_CHANGED,
  MCP_PROPOSE_MEMORY_CONFIRM,
  MCP_PROPOSE_MEMORY_DECLINED,
  MCP_PROPOSE_MEMORY_FAILED,
  MCP_PROPOSE_MEMORY_FULL,
  MCP_PROPOSE_MEMORY_INVALID,
  MCP_PROPOSE_MEMORY_PENDING,
  MCP_PROPOSE_MEMORY_SAVED,
  MCP_PROPOSE_MEMORY_SAVED_DIRECT,
  MCP_PROPOSE_MEMORY_SECRET,
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
  MCP_PROPOSE_RULE_NOT_READY,
  MCP_PROPOSE_RULE_REPLAY,
  MCP_PROPOSE_RULE_REPLAY_UNAVAILABLE,
  MCP_PROPOSE_RULE_SAVED,
  MCP_SERVER_CONNECTION_REQUIRED,
  MCP_SERVER_INSTRUCTIONS,
  MCP_START_HERE_OMITTED,
  MCP_START_HERE_RULES_NOTE,
  MCP_START_HERE_RULES_OMITTED,
  MCP_TOOL_FIND_MEMORIES,
  MCP_TOOL_PROPOSE_MEMORIES,
  MCP_TOOL_PROPOSE_MEMORY,
  MCP_TOOL_PROPOSE_RULE,
  MCP_TOOL_RESULT_FAILED,
  MCP_TOOL_RULE_BOOK,
  MCP_TOOL_START_HERE,
  MCP_TOOL_TODAY_CONTEXT,
  renderPrompt,
  TOOL_RESULT_RECALL_INPUT_INVALID,
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
import { AdmissionWindows } from "./bearer-admission.js";
import {
  MCP_CONNECTION_SECRET_PATTERN,
  type McpUsageRecorder,
  mcpConnectionSecretDigest,
  mcpConnectionSubject,
  recordMcpUsage,
  touchMcpConnection,
} from "./production-mcp-connections.js";
import {
  EXTERNAL_PROPOSAL_CATEGORIES,
  EXTERNAL_PROPOSAL_KEY_MAXIMUM,
  EXTERNAL_PROPOSAL_TEXT_MAXIMUM,
  type ExternalProposalCategory,
  type ExternalProposalDecision,
  type ExternalProposalDecisionInput,
  type ExternalProposalSubmission,
  externalDirectBatchId,
  normalizeProposalText,
  proposalClassification,
  proposalHasMachineSecret,
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
const MCP_ACCESS_OWNER_NOT_BOUND = Object.freeze({ code: "MCP_ACCESS_OWNER_NOT_BOUND" });
const MCP_CONNECTION_NOT_FOUND = Object.freeze({ code: "MCP_CONNECTION_NOT_FOUND" });
const MCP_CONNECTION_PAUSED = Object.freeze({ code: "MCP_CONNECTION_PAUSED" });
export const MCP_HOOK_READS_PER_MINUTE = 60;

export const MCP_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const MCP_WRITE_TOOL_NAMES = ["propose_memory", "propose_memories", "propose_rule"] as const;
export const MCP_PROPOSE_MEMORIES_MAXIMUM = 50;
export const MCP_PROPOSAL_CONFIRM_KEY = "confirm";
export const MCP_PROPOSAL_UNSEEN_ANSWER_MS = 1_500;
export const MCP_PROPOSAL_STATE_TTL_SECONDS = 600;
const WRITE_ACCESS = "himawari:write";
const READ_ACCESS = "himawari:read";
export const TODAY_CONTEXT_REMINDER_WINDOW_MS = 48 * 3_600_000;
export const TODAY_CONTEXT_SUMMARY_DAYS = 2;
export const TODAY_CONTEXT_SUMMARY_LIMIT = 8;
export const START_HERE_RULES_CHARACTER_BUDGET = 1_200;
export const AUTO_FIND_LIMIT = 3;
const START_HERE_MEMORY_ID_LIMIT = 200;
export const MCP_READ_DEFAULT_CEILING: McpReadCeiling = "private";
const SERVER_NAME = "himawari";
const SERVER_VERSION = "1.0.0";
const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}/u;

export type McpReadCeiling = Exclude<DataClassification, "restricted">;

type Within = <T>(slot: string, operation: () => Promise<T>) => Promise<T>;

interface ListedReminders {
  readonly reminders: readonly ListedReminder[];
  readonly more: boolean;
}

interface FoundSummaries {
  readonly summaries: readonly {
    readonly id: string;
    readonly day: string;
    readonly text: string;
  }[];
  readonly partial: boolean;
}

export interface McpReadSources {
  readonly recall: (
    args: JsonObject,
    within: Within,
    ceiling: McpReadCeiling,
  ) => Promise<RecallResult>;
  readonly embedOutsideRun: <T>(
    context: MailEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly reminders: (windowMs: number, ceiling: McpReadCeiling) => Promise<ListedReminders>;
  readonly settings: () => Promise<ProactiveSettings>;
  readonly ruleBook?: (settings: ProactiveSettings) => readonly RuleRecord[];
  readonly ownerRules?: () => Promise<readonly StoredOwnerRule[]>;
  readonly memoryClassifications?: (
    memoryIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DataClassification>>;
  readonly profile?: (maxClassification: McpReadCeiling) => Promise<OwnerProfileOutline>;
  readonly summaries?: (input: {
    readonly days: number;
    readonly limit: number;
    readonly maxClassification: McpReadCeiling;
  }) => Promise<FoundSummaries>;
}

export interface SharedRule {
  readonly rule: RuleRecord;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface McpCeilingReader {
  readonly recall: (args: JsonObject, within: Within) => Promise<RecallResult>;
  readonly reminders: (windowMs: number) => Promise<ListedReminders>;
  readonly profile: () => Promise<OwnerProfileOutline | undefined>;
  readonly summaries: (input: {
    readonly days: number;
    readonly limit: number;
  }) => Promise<FoundSummaries | undefined>;
  readonly ownerRules: () => Promise<readonly StoredOwnerRule[]>;
  readonly builtInRules: () => Promise<readonly SharedRule[]>;
}

export type McpReadSourceName = keyof McpCeilingReader;

const MCP_READ_SOURCE_NAMES: readonly McpReadSourceName[] = Object.freeze([
  "recall",
  "reminders",
  "profile",
  "summaries",
  "ownerRules",
  "builtInRules",
]);

export interface McpReadContext {
  readonly clock: ClockPort;
  readonly timeZone: string;
  readonly requestTimeoutMs: number;
  readonly embedOutsideRun: McpReadSources["embedOutsideRun"];
  readonly onSummariesFailed: (error: unknown) => void;
}

export interface McpReadRequest {
  readonly args: JsonObject;
  readonly signal: AbortSignal;
  readonly trace: ReadTrace;
  readonly read: Partial<McpCeilingReader>;
  readonly context: McpReadContext;
}

export interface McpReadToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readCeiling: { readonly sources: readonly McpReadSourceName[] };
  readonly run: (request: McpReadRequest) => Promise<ToolOutcome>;
}

export const MCP_READ_TOOL_CEILING_MISSING = "MCP_READ_TOOL_CEILING_MISSING";
const MCP_READ_FAILED_SUFFIX = "_failed";
const MCP_READ_TOOL_NAME_MAXIMUM = 64 - MCP_READ_FAILED_SUFFIX.length;
const MCP_READ_TOOL_NAME = new RegExp(`^[a-z][a-z0-9_]{0,${MCP_READ_TOOL_NAME_MAXIMUM - 1}}$`, "u");

export function mcpReadToolRegistry(
  entries: readonly McpReadToolEntry[],
): readonly McpReadToolEntry[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const sources = (entry as { readonly readCeiling?: { readonly sources?: unknown } }).readCeiling
      ?.sources;
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      !sources.every((source) => (MCP_READ_SOURCE_NAMES as readonly unknown[]).includes(source))
    )
      throw new Error(`${MCP_READ_TOOL_CEILING_MISSING}:${entry.name}`);
    if (!MCP_READ_TOOL_NAME.test(entry.name))
      throw new Error(
        `MCP_READ_TOOL_NAME_INVALID:${entry.name.slice(0, MCP_READ_TOOL_NAME_MAXIMUM)}`,
      );
    const failed = `${entry.name}${MCP_READ_FAILED_SUFFIX}`;
    if (
      names.has(entry.name) ||
      names.has(failed) ||
      (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(entry.name)
    )
      throw new Error(`MCP_READ_TOOL_DUPLICATE:${entry.name}`);
    names.add(entry.name);
    names.add(failed);
  }
  return Object.freeze([...entries]);
}

export interface McpProposalReceipt {
  readonly id: string;
  readonly status: "pending" | "committed" | "rejected" | "superseded";
  readonly receivedAt: string;
}

export interface McpMemoryProposals {
  readonly ready: () => Promise<boolean>;
  readonly submit: (input: ExternalProposalSubmission) => Promise<{
    readonly proposal: McpProposalReceipt;
    readonly created: boolean;
    readonly superseded: readonly string[];
  }>;
  readonly read: (proposalId: string) => Promise<McpProposalReceipt | undefined>;
  readonly decided: (proposalId: string) => Promise<ExternalProposalDecision | undefined>;
  readonly keep: (proposalId: string, input: ExternalProposalDecisionInput) => Promise<string>;
  readonly decline: (proposalId: string, input: ExternalProposalDecisionInput) => Promise<boolean>;
  readonly keepDirect: (
    proposalId: string,
    input: { readonly batchId: string; readonly started: number },
  ) => Promise<"saved" | "pending">;
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
  readonly proposals: McpMemoryProposals;
  readonly rules: McpRuleProposals;
}

export interface McpAccessVerifier {
  readonly verify: (assertion: string) => Promise<{ readonly externalSubjectRef: string }>;
}

export type McpAdmission =
  | { readonly status: "ok"; readonly authInfo: AuthInfo }
  | {
      readonly status: "unauthorized" | "not_found" | "paused" | "rate_limited" | "unavailable";
    };

interface ConnectionRef {
  readonly id: string;
  readonly entry: McpConnectionEntry;
  readonly pushPolicy: McpConnectionPushPolicy;
  readonly callKey: string | null;
}

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
  if (!(answeredAt - askedAt >= MCP_PROPOSAL_UNSEEN_ANSWER_MS)) return "unseen";
  return action === "accept" ? "accepted" : "declined";
}

export interface ProductionMcpReadOptions {
  readonly scope: Pick<DecisionLedgerWrite, "ownerId" | "agentId">;
  readonly clock: ClockPort;
  readonly access: McpAccessVerifier;
  readonly owners: Pick<OwnerIdentityStatePort, "readBySubject">;
  readonly write?: McpWriteAccess;
  readonly timeZone: string;
  readonly connections: Pick<McpConnectionStorePort, "findBySecret" | "touch" | "addUsage">;
  readonly hookReadsPerMinute?: number;
  readonly readTools?: readonly McpReadToolEntry[];
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

export interface ToolOutcome {
  readonly output: Record<string, unknown>;
  readonly memoryIds: readonly string[];
  readonly summaries?: SummaryRead;
  readonly empty?: boolean;
  readonly rejected?: true;
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

export interface ReadTrace {
  costMicros: number;
  summariesTried: boolean;
}

function isAlreadyDecided(error: unknown): boolean {
  return error instanceof Error && error.message === "MCP_PROPOSAL_ALREADY_DECIDED";
}

function isPendingFull(error: unknown): boolean {
  return error instanceof Error && error.message.includes("EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL");
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function localDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
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
  return (declared ?? userAgent ?? "").trim().match(CLIENT_NAME)?.[0] ?? UNKNOWN_CLIENT;
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
  readonly #readTools: readonly McpReadToolEntry[];
  readonly #windows: AdmissionWindows;
  readonly #connectionWindows = new Map<
    string,
    { readonly regular: AdmissionWindows; readonly hook: AdmissionWindows }
  >();
  readonly #usage: McpUsageRecorder;
  readonly #unsettled = new Map<
    string,
    ConnectionRef & { readonly tool: string; readonly auto: boolean }
  >();
  readonly handler: McpHttpHandler;

  readonly #stateCodec: RequestStateCodec<ProposalState>;
  readonly #deciding = new Map<string, Promise<void>>();
  readonly #decidedRules = new Map<string, { readonly until: number; readonly saved: boolean }>();

  constructor(options: ProductionMcpReadOptions) {
    this.#options = options;
    this.#readTools = mcpReadToolRegistry(options.readTools ?? MCP_READ_TOOLS);
    this.#windows = new AdmissionWindows(options.clock);
    this.#usage = {
      connections: options.connections,
      scope: options.scope,
      timeZone: options.timeZone,
      now: () => options.clock.now(),
      onFailure: options.onFailure,
    };
    this.#stateCodec = createRequestStateCodec<ProposalState>({
      key: randomBytes(32),
      ttlSeconds: MCP_PROPOSAL_STATE_TTL_SECONDS,
      bind: (context) => `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? ""}`,
    });
    this.handler = createMcpHandler((context) => this.#server(context), {
      onerror: options.onFailure,
    });
  }

  async admit(assertion: string | undefined, secret?: string): Promise<McpAdmission> {
    let subject: string | undefined;
    let rejection: unknown;
    if (assertion) {
      let verified: string | undefined;
      try {
        verified = (await this.#options.access.verify(assertion)).externalSubjectRef;
      } catch (error) {
        rejection = error;
      }
      if (verified !== undefined) {
        let binding: Awaited<ReturnType<OwnerIdentityStatePort["readBySubject"]>>;
        try {
          binding = await this.#options.owners.readBySubject(verified);
        } catch (error) {
          if (this.#windows.admit(true) === "rate_limited") return { status: "rate_limited" };
          this.#options.onFailure(error);
          return { status: "unavailable" };
        }
        if (binding?.ownerId === this.#options.scope.ownerId && binding.status === "active")
          subject = verified;
        else rejection = MCP_ACCESS_OWNER_NOT_BOUND;
      }
    }
    if (subject === undefined) return this.#reject("unauthorized", assertion ? rejection : null);
    if (secret === undefined) {
      if (this.#windows.admit(true) === "rate_limited") return { status: "rate_limited" };
      return { status: "ok", authInfo: { token: "", clientId: "", scopes: [], extra: {} } };
    }
    if (!MCP_CONNECTION_SECRET_PATTERN.test(secret))
      return this.#reject("not_found", MCP_CONNECTION_NOT_FOUND);
    let connection: Awaited<ReturnType<McpConnectionStorePort["findBySecret"]>>;
    try {
      connection = await this.#options.connections.findBySecret({
        ...this.#options.scope,
        secretSha256: mcpConnectionSecretDigest(secret),
      });
    } catch (error) {
      if (this.#windows.admit(true) === "rate_limited") return { status: "rate_limited" };
      this.#options.onFailure(error);
      return { status: "unavailable" };
    }
    if (connection === null || connection.status === "revoked")
      return this.#reject("not_found", MCP_CONNECTION_NOT_FOUND);
    if (connection.status === "paused")
      return this.#reject("paused", { ...MCP_CONNECTION_PAUSED, connectionId: connection.id });
    const scopes = this.#options.write ? [READ_ACCESS, WRITE_ACCESS] : [READ_ACCESS];
    return {
      status: "ok",
      authInfo: {
        token: "",
        clientId: connection.id,
        scopes,
        extra: {
          [READ_CEILING_KEY]: connection.readCeiling,
          [ENTRY_KEY]: "oauth" satisfies McpConnectionEntry,
          [PUSH_POLICY_KEY]: connection.pushPolicy,
        },
      },
    };
  }

  #reject(status: "unauthorized" | "not_found" | "paused", rejection: unknown): McpAdmission {
    if (this.#windows.admit(false) === "rate_limited") return { status: "rate_limited" };
    if (rejection !== null) this.#options.onFailure(rejection);
    return { status };
  }

  async begin(
    authInfo: AuthInfo,
    body: unknown,
  ): Promise<
    { readonly status: "ok"; readonly authInfo: AuthInfo } | { readonly status: "rate_limited" }
  > {
    const connection = connectionOf(authInfo);
    if (connection === null) return { status: "ok", authInfo };
    const call = toolCallOf(body);
    const known = call !== null && this.#knownTool(call.name);
    const auto = call?.auto === true;
    let windows = this.#connectionWindows.get(connection.id);
    if (!windows) {
      windows = {
        regular: new AdmissionWindows(this.#options.clock),
        hook: new AdmissionWindows(
          this.#options.clock,
          this.#options.hookReadsPerMinute ?? MCP_HOOK_READS_PER_MINUTE,
        ),
      };
      this.#connectionWindows.set(connection.id, windows);
    }
    const limited = (auto ? windows.hook : windows.regular).admit(true) === "rate_limited";
    if (!known || call === null)
      return limited ? { status: "rate_limited" } : { status: "ok", authInfo };
    await recordMcpUsage(this.#usage, {
      connectionId: connection.id,
      entry: connection.entry,
      tool: call.name,
      auto,
      counts: limited ? { rate_limited: 1 } : { calls: 1 },
    });
    if (limited) return { status: "rate_limited" };
    const callKey = randomUUID();
    this.#unsettled.set(callKey, { ...connection, tool: call.name, auto });
    return {
      status: "ok",
      authInfo: { ...authInfo, extra: { ...authInfo.extra, [CALL_KEY]: callKey } },
    };
  }

  minuteUsage(connectionId: string): { readonly reads: number; readonly hookReads: number } {
    const windows = this.#connectionWindows.get(connectionId);
    return { reads: windows?.regular.used() ?? 0, hookReads: windows?.hook.used() ?? 0 };
  }

  get hookReadsPerMinute(): number {
    return this.#options.hookReadsPerMinute ?? MCP_HOOK_READS_PER_MINUTE;
  }

  async finish(authInfo: AuthInfo): Promise<void> {
    const callKey = authInfo.extra?.[CALL_KEY];
    if (typeof callKey !== "string") return;
    const call = this.#unsettled.get(callKey);
    if (!call) return;
    this.#unsettled.delete(callKey);
    await recordMcpUsage(this.#usage, {
      connectionId: call.id,
      entry: call.entry,
      tool: call.tool,
      auto: call.auto,
      counts: { failed: 1 },
    });
  }

  async #settle(
    connection: ConnectionRef,
    tool: string,
    auto: boolean,
    counts: Readonly<Partial<Record<McpUsageCounter, number>>>,
  ): Promise<void> {
    if (connection.callKey !== null) this.#unsettled.delete(connection.callKey);
    if (Object.keys(counts).length === 0) return;
    await recordMcpUsage(this.#usage, {
      connectionId: connection.id,
      entry: connection.entry,
      tool,
      auto,
      counts,
    });
  }

  #knownTool(name: string): boolean {
    return (
      this.#readTools.some((tool) => tool.name === name) ||
      (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name)
    );
  }

  async #counted(
    connection: ConnectionRef,
    tool: string,
    client: string,
    work: () => Promise<CallToolResult | InputRequiredResult>,
  ): Promise<CallToolResult | InputRequiredResult> {
    await touchMcpConnection(this.#usage, connection.id, client === UNKNOWN_CLIENT ? null : client);
    let result: CallToolResult | InputRequiredResult | undefined;
    try {
      result = await work();
      return result;
    } finally {
      await this.#settle(
        connection,
        tool,
        false,
        result === undefined || ("isError" in result && result.isError === true)
          ? { failed: 1 }
          : {},
      );
    }
  }

  #server(context: McpRequestContext): McpServer {
    const request = context.requestInfo ?? null;
    const connection = connectionOf(context.authInfo);
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions: connection
          ? MCP_SERVER_INSTRUCTIONS.text
          : MCP_SERVER_CONNECTION_REQUIRED.text,
        requestState: { verify: this.#stateCodec.verify },
        inputRequired: { legacyShim: false },
      },
    );
    if (connection === null) return server;
    const userAgent = request?.headers.get("user-agent") ?? null;
    const ceiling = ceilingOf(context.authInfo);
    for (const tool of this.#readTools)
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: fromJsonSchema<JsonObject>(tool.inputSchema as never),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args: JsonObject, handlerContext) =>
          this.#call(
            tool,
            ceiling,
            connection,
            clientNameOf(handlerContext.mcpReq.envelope, userAgent),
            args,
            handlerContext.mcpReq.signal,
          ),
      );
    const proposals = this.#options.write?.proposals;
    const subjectRef = mcpConnectionSubject(connection.id);
    const direct = connection.pushPolicy === "direct";
    if (
      proposals &&
      context.era === "modern" &&
      context.authInfo?.scopes.includes(WRITE_ACCESS) === true
    ) {
      const item = {
        text: { type: "string", minLength: 1 },
        category: { type: "string", enum: [...EXTERNAL_PROPOSAL_CATEGORIES] },
        key: { type: "string", minLength: 1, maxLength: EXTERNAL_PROPOSAL_KEY_MAXIMUM },
      };
      server.registerTool(
        "propose_memory",
        {
          description: MCP_TOOL_PROPOSE_MEMORY.text,
          inputSchema: fromJsonSchema<JsonObject>({
            type: "object",
            properties: item,
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
        async (args: JsonObject, handlerContext) => {
          const client = clientNameOf(handlerContext.mcpReq.envelope, userAgent);
          return this.#counted(connection, "propose_memory", client, () =>
            this.#proposeMemory(proposals, args, client, subjectRef, handlerContext, direct),
          );
        },
      );
      server.registerTool(
        "propose_memories",
        {
          description: MCP_TOOL_PROPOSE_MEMORIES.text,
          inputSchema: fromJsonSchema<JsonObject>({
            type: "object",
            properties: {
              items: {
                type: "array",
                minItems: 1,
                maxItems: MCP_PROPOSE_MEMORIES_MAXIMUM,
                items: {
                  type: "object",
                  properties: item,
                  required: ["text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["items"],
            additionalProperties: false,
          } as never),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async (args: JsonObject, handlerContext) => {
          const client = clientNameOf(handlerContext.mcpReq.envelope, userAgent);
          return this.#counted(connection, "propose_memories", client, () =>
            this.#proposeMemories(proposals, args, client, subjectRef, direct),
          );
        },
      );
    }
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
        async (args: JsonObject, handlerContext) => {
          const client = clientNameOf(handlerContext.mcpReq.envelope, userAgent);
          return this.#counted(connection, "propose_rule", client, () =>
            this.#proposeRule(rules, args, client, connection.id, handlerContext),
          );
        },
      );
    }
    return server;
  }

  async #proposeRule(
    rules: McpRuleProposals,
    args: JsonObject,
    client: string,
    connectionId: string,
    context: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    const received = Date.parse(this.#options.clock.now());
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
          return proposalReply(MCP_PROPOSE_RULE_NOT_READY.text, true);
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
        !Number.isFinite(state.askedAt) ||
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
        connectionId,
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
        const outcome = mcpProposalAnswer(answer.action, state.askedAt, received);
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

  #readProposalArgs(args: JsonObject):
    | {
        readonly text: string;
        readonly category: ExternalProposalCategory;
        readonly sourceKey: string | null;
      }
    | "invalid"
    | "secret" {
    const text = normalizeProposalText(typeof args["text"] === "string" ? args["text"] : "");
    const category = (
      typeof args["category"] === "string" ? args["category"] : "other"
    ) as ExternalProposalCategory;
    const key = args["key"];
    const sourceKey = typeof key === "string" ? normalizeProposalText(key) : null;
    if (
      text.length === 0 ||
      text.length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM ||
      !(EXTERNAL_PROPOSAL_CATEGORIES as readonly string[]).includes(category) ||
      (key !== undefined &&
        (sourceKey === null ||
          sourceKey.length === 0 ||
          [...sourceKey].length > EXTERNAL_PROPOSAL_KEY_MAXIMUM))
    )
      return "invalid";
    if (
      proposalHasMachineSecret(text) ||
      (sourceKey !== null && proposalHasMachineSecret(sourceKey))
    )
      return "secret";
    return { text, category, sourceKey };
  }

  async #settledReply(proposalId: string): Promise<CallToolResult> {
    const decided = await this.#options.write?.proposals?.decided(proposalId);
    if (decided === "kept") return proposalReply(MCP_PROPOSE_MEMORY_ALREADY_SAVED.text, false);
    if (decided === "declined") return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
    return proposalReply(MCP_PROPOSE_MEMORY_CHANGED.text, true);
  }

  #pendingReply(proposal: McpProposalReceipt): CallToolResult {
    return proposalReply(
      renderPrompt(MCP_PROPOSE_MEMORY_PENDING, {
        proposalId: proposal.id,
        receivedAt: proposal.receivedAt,
      }),
      false,
    );
  }

  async #proposeMemories(
    proposals: McpMemoryProposals,
    args: JsonObject,
    client: string,
    subjectRef: string,
    direct: boolean,
  ): Promise<CallToolResult> {
    const items = Array.isArray(args["items"]) ? args["items"] : [];
    if (items.length === 0 || items.length > MCP_PROPOSE_MEMORIES_MAXIMUM)
      return proposalReply(MCP_PROPOSE_MEMORY_INVALID.text, true);
    try {
      const results: Record<string, unknown>[] = [];
      const replaced = new Set<string>();
      for (const [index, raw] of items.entries()) {
        const parsed =
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? this.#readProposalArgs(raw as JsonObject)
            : "invalid";
        if (typeof parsed === "string") {
          results.push({ index, status: parsed });
          continue;
        }
        let submitted: Awaited<ReturnType<McpMemoryProposals["submit"]>>;
        try {
          submitted = await proposals.submit({
            proposalId: randomUUID(),
            ...parsed,
            client,
            subjectRef,
          });
        } catch (error) {
          if (!isPendingFull(error)) throw error;
          results.push({ index, status: "full" });
          continue;
        }
        const { proposal, superseded } = submitted;
        for (const id of superseded) replaced.add(id);
        results.push({
          index,
          status:
            proposal.status === "committed"
              ? "already_saved"
              : proposal.status === "rejected"
                ? "declined_before"
                : "pending",
          proposalId: proposal.id,
          receivedAt: proposal.receivedAt,
        });
      }
      for (const result of results)
        if (
          result["status"] === "pending" &&
          typeof result["proposalId"] === "string" &&
          replaced.has(result["proposalId"])
        )
          result["status"] = "replaced";
      if (direct) {
        const batchId = externalDirectBatchId(randomUUID());
        for (const result of results) {
          if (result["status"] !== "pending" || typeof result["proposalId"] !== "string") continue;
          try {
            const kept = await proposals.keepDirect(result["proposalId"], {
              batchId,
              started: Date.parse(this.#options.clock.now()),
            });
            if (kept === "saved") result["status"] = "saved";
          } catch (error) {
            if (isAlreadyDecided(error)) {
              const decided = await this.#options.write?.proposals?.decided(result["proposalId"]);
              result["status"] =
                decided === "kept"
                  ? "already_saved"
                  : decided === "declined"
                    ? "declined_before"
                    : "pending";
            } else this.#options.onFailure(error);
          }
        }
      }
      return proposalReply(
        JSON.stringify({ note: MCP_PROPOSE_MEMORIES_RESULT.text, results }),
        false,
      );
    } catch (error) {
      this.#options.onFailure(error);
      return proposalReply(MCP_PROPOSE_MEMORY_FAILED.text, true);
    }
  }

  async #proposeMemory(
    proposals: McpMemoryProposals,
    args: JsonObject,
    client: string,
    subjectRef: string,
    context: ServerContext,
    direct: boolean,
  ): Promise<CallToolResult | InputRequiredResult> {
    const started = Date.parse(this.#options.clock.now());
    const parsed = this.#readProposalArgs(args);
    if (parsed === "invalid") return proposalReply(MCP_PROPOSE_MEMORY_INVALID.text, true);
    if (parsed === "secret") return proposalReply(MCP_PROPOSE_MEMORY_SECRET.text, true);
    const { text, category, sourceKey } = parsed;
    const argsHash = createHash("sha256")
      .update(JSON.stringify([text, category, sourceKey]))
      .digest("hex");
    const state = context.mcpReq.requestState<ProposalState>();
    try {
      if (state === undefined) {
        const { proposal } = await proposals.submit({
          proposalId: randomUUID(),
          text,
          category,
          sourceKey,
          client,
          subjectRef,
        });
        if (proposal.status === "committed")
          return proposalReply(MCP_PROPOSE_MEMORY_ALREADY_SAVED.text, false);
        if (proposal.status === "rejected")
          return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
        if (direct) {
          const kept = await this.#keepDirect(proposals, proposal.id, started);
          if (kept === "saved") return proposalReply(MCP_PROPOSE_MEMORY_SAVED_DIRECT.text, false);
          if (kept === "settled") return this.#settledReply(proposal.id);
          return this.#pendingReply(proposal);
        }
        if (!elicitationSupported(context.mcpReq.envelope) || !(await proposals.ready()))
          return this.#pendingReply(proposal);
        return await this.#askConfirmation(
          { tool: "propose_memory", proposalId: proposal.id, argsHash, client },
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
        !Number.isFinite(state.askedAt) ||
        state.argsHash !== argsHash
      )
        return proposalReply(MCP_PROPOSE_MEMORY_CHANGED.text, true);
      const proposalId = state.proposalId;
      return await this.#oneAtATime(proposalId, async () => {
        const decided = await proposals.decided(proposalId);
        if (decided === "kept") return proposalReply(MCP_PROPOSE_MEMORY_ALREADY_SAVED.text, false);
        if (decided === "declined") return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
        const proposal = await proposals.read(proposalId);
        if (decided !== "pending" || !proposal)
          return proposalReply(MCP_PROPOSE_MEMORY_CHANGED.text, true);
        const answer = inputResponse(context.mcpReq.inputResponses, MCP_PROPOSAL_CONFIRM_KEY);
        if (answer.kind !== "elicit")
          return await this.#askConfirmation(
            state,
            { text, category, client: state.client },
            context,
          );
        const outcome = mcpProposalAnswer(answer.action, state.askedAt, started);
        if (outcome === "unseen" || answer.action === "cancel") return this.#pendingReply(proposal);
        if (outcome === "accepted") {
          try {
            await proposals.keep(proposalId, { batchId: null, started });
          } catch (error) {
            if (!isAlreadyDecided(error)) throw error;
            return this.#settledReply(proposalId);
          }
          return proposalReply(MCP_PROPOSE_MEMORY_SAVED.text, false);
        }
        if (!(await proposals.decline(proposalId, { batchId: null, started })))
          return this.#settledReply(proposalId);
        return proposalReply(MCP_PROPOSE_MEMORY_DECLINED.text, false);
      });
    } catch (error) {
      if (isPendingFull(error)) return proposalReply(MCP_PROPOSE_MEMORY_FULL.text, true);
      this.#options.onFailure(error);
      return proposalReply(MCP_PROPOSE_MEMORY_FAILED.text, true);
    }
  }

  async #keepDirect(
    proposals: McpMemoryProposals,
    proposalId: string,
    started: number,
  ): Promise<"saved" | "pending" | "settled"> {
    try {
      return await proposals.keepDirect(proposalId, {
        batchId: externalDirectBatchId(randomUUID()),
        started,
      });
    } catch (error) {
      if (isAlreadyDecided(error)) return "settled";
      throw error;
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
    proposal: {
      readonly text: string;
      readonly category: ExternalProposalCategory;
      readonly client: string;
    },
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

  #reader(
    ceiling: McpReadCeiling,
    declared: readonly McpReadSourceName[],
  ): Partial<McpCeilingReader> {
    const sources = this.#options.sources;
    const profile = sources.profile;
    const summaries = sources.summaries;
    const full: McpCeilingReader = {
      recall: (args, within) => sources.recall(args, within, ceiling),
      reminders: (windowMs) => sources.reminders(windowMs, ceiling),
      profile: async () => profile?.(ceiling),
      summaries: async ({ days, limit }) =>
        summaries?.({ days, limit, maxClassification: ceiling }),
      ownerRules: () => ownerRulesWithin(sources, ceiling),
      builtInRules: async () =>
        sharedRulesWithin((sources.ruleBook ?? ruleBookFor)(await sources.settings()), ceiling),
    };
    const reader: Partial<Record<McpReadSourceName, unknown>> = {};
    for (const name of declared) {
      if (name === "profile" && !profile) continue;
      if (name === "summaries" && !summaries) continue;
      reader[name] = full[name];
    }
    return reader as Partial<McpCeilingReader>;
  }

  async #call(
    tool: McpReadToolEntry,
    ceiling: McpReadCeiling,
    connection: ConnectionRef,
    client: string,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const started = Date.parse(this.#options.clock.now());
    const auto = args["auto"] === true;
    await touchMcpConnection(this.#usage, connection.id, client === UNKNOWN_CLIENT ? null : client);
    const trace: ReadTrace = { costMicros: 0, summariesTried: false };
    const read = this.#reader(ceiling, tool.readCeiling.sources);
    let delivered:
      | {
          readonly text: string;
          readonly memoryIds: readonly string[] | undefined;
          readonly summaries?: SummaryRead;
          readonly empty: boolean;
          readonly rejected?: true;
        }
      | undefined;
    try {
      const outcome = await tool.run({
        args,
        signal,
        trace,
        read,
        context: {
          clock: this.#options.clock,
          timeZone: this.#options.timeZone,
          requestTimeoutMs: this.#options.requestTimeoutMs,
          embedOutsideRun: this.#options.sources.embedOutsideRun,
          onSummariesFailed: this.#options.onSummariesFailed,
        },
      });
      delivered = {
        text: JSON.stringify(maskForExternalRead(outcome.output)),
        memoryIds: outcome.rejected ? undefined : outcome.memoryIds,
        ...(outcome.summaries ? { summaries: outcome.summaries } : {}),
        empty: outcome.empty === true,
        ...(outcome.rejected ? { rejected: true as const } : {}),
      };
    } catch (error) {
      this.#options.onFailure(error);
    }
    const summaries = read.summaries
      ? (delivered?.summaries ?? (trace.summariesTried ? SUMMARIES_FAILED : SUMMARIES_NOT_TRIED))
      : undefined;
    if (!(auto && delivered?.empty === true))
      try {
        await this.#record(
          tool.name,
          connection.id,
          delivered?.memoryIds,
          summaries,
          trace.costMicros,
          started,
        );
      } catch (error) {
        this.#options.onFailure(error);
        delivered = undefined;
      }
    await this.#settle(connection, tool.name, auto, readCounts(delivered));
    return delivered
      ? {
          content: [{ type: "text", text: delivered.text }],
          ...(delivered.rejected ? { isError: true } : {}),
        }
      : { content: [{ type: "text", text: MCP_TOOL_RESULT_FAILED.text }], isError: true };
  }

  async #record(
    name: string,
    connectionId: string,
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
      reasonCode: memoryIds ? name : `${name}${MCP_READ_FAILED_SUFFIX}`,
      subjectRef: mcpConnectionSubject(connectionId),
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
}

const READ_CEILING_KEY = "readCeiling";
const ENTRY_KEY = "entry";
const PUSH_POLICY_KEY = "pushPolicy";
const CALL_KEY = "callKey";
const UNKNOWN_CLIENT = "unknown";

function readCounts(
  delivered: { readonly empty: boolean; readonly rejected?: true } | undefined,
): Readonly<Partial<Record<McpUsageCounter, number>>> {
  if (!delivered || delivered.rejected) return { failed: 1 };
  return delivered.empty ? { empty: 1 } : { delivered: 1 };
}

function connectionOf(authInfo: AuthInfo | undefined): ConnectionRef | null {
  const id = authInfo?.clientId;
  const entry = authInfo?.extra?.[ENTRY_KEY];
  if (typeof id !== "string" || id.length === 0) return null;
  if (entry !== "oauth" && entry !== "service_token") return null;
  const callKey = authInfo?.extra?.[CALL_KEY];
  return {
    id,
    entry,
    pushPolicy: authInfo?.extra?.[PUSH_POLICY_KEY] === "direct" ? "direct" : "ask",
    callKey: typeof callKey === "string" ? callKey : null,
  };
}

function toolCallOf(body: unknown): { readonly name: string; readonly auto: boolean } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const message = body as Record<string, unknown>;
  if (message["method"] !== "tools/call") return null;
  const params = message["params"];
  if (params === null || typeof params !== "object") return null;
  const name = (params as Record<string, unknown>)["name"];
  const args = (params as Record<string, unknown>)["arguments"];
  if (typeof name !== "string") return null;
  return {
    name,
    auto:
      args !== null &&
      typeof args === "object" &&
      (args as Record<string, unknown>)["auto"] === true,
  };
}

export function sharedRulesWithin(
  rules: readonly RuleRecord[],
  ceiling: McpReadCeiling,
): readonly SharedRule[] {
  return rules.map((rule) => ({
    rule,
    parameters:
      rule.sharedParameters &&
      classificationRank(rule.sharedParameters.classification) <= classificationRank(ceiling)
        ? rule.sharedParameters.values
        : {},
  }));
}

function ceilingOf(authInfo: AuthInfo | undefined): McpReadCeiling {
  const value = authInfo?.extra?.[READ_CEILING_KEY];
  return value === "public" || value === "private" || value === "sensitive" ? value : "public";
}

async function ownerRulesWithin(
  sources: McpReadSources,
  ceiling: McpReadCeiling,
): Promise<readonly StoredOwnerRule[]> {
  const rows = sources.ownerRules ? await sources.ownerRules() : [];
  const memoryIds = [
    ...new Set(rows.flatMap(({ sourceMemoryId }) => (sourceMemoryId ? [sourceMemoryId] : []))),
  ];
  const classifications =
    memoryIds.length > 0 && sources.memoryClassifications
      ? await sources.memoryClassifications(memoryIds)
      : new Map<string, DataClassification>();
  return [...rows]
    .filter(({ sourceMemoryId }) => {
      const classification = sourceMemoryId ? classifications.get(sourceMemoryId) : undefined;
      return (
        classification !== undefined &&
        classification !== "restricted" &&
        classificationRank(classification) <= classificationRank(ceiling)
      );
    })
    .sort((a, b) => compareText(a.ruleId, b.ruleId));
}

function declaredSource<K extends McpReadSourceName>(
  read: Partial<McpCeilingReader>,
  name: K,
): McpCeilingReader[K] {
  const source = read[name];
  if (!source) throw new Error(`MCP_READ_SOURCE_NOT_DECLARED:${name}`);
  return source as McpCeilingReader[K];
}

async function findMemories({
  args,
  signal,
  trace,
  read,
  context: options,
}: McpReadRequest): Promise<ToolOutcome> {
  const recall = declaredSource(read, "recall");
  const { auto, ...recallArgs } = args;
  const requested = recallArgs["limit"];
  const forwarded: JsonObject =
    auto === true
      ? {
          ...recallArgs,
          limit:
            typeof requested === "number" ? Math.min(requested, AUTO_FIND_LIMIT) : AUTO_FIND_LIMIT,
        }
      : recallArgs;
  const context: MailEmbeddingContext = {
    deadlineAt: new Date(Date.parse(options.clock.now()) + options.requestTimeoutMs).toISOString(),
    signal,
    costMicros: 0,
  };
  try {
    const result = await recall(forwarded, (_slot, operation) =>
      options.embedOutsideRun(context, operation),
    );
    const empty =
      Array.isArray(result.output["memories"]) &&
      result.output["memories"].length === 0 &&
      Array.isArray(result.output["conversations"]) &&
      result.output["conversations"].length === 0;
    if (empty && auto === true) {
      const { note: _note, tentativeNote: _tentativeNote, ...rest } = result.output;
      return { output: rest, memoryIds: result.memoryIds, empty };
    }
    return { output: result.output, memoryIds: result.memoryIds, empty };
  } catch (error) {
    if (error instanceof Error && error.message === "MEMORY_RECALL_INPUT_INVALID")
      return {
        output: {
          error: "MEMORY_RECALL_INPUT_INVALID",
          note: TOOL_RESULT_RECALL_INPUT_INVALID.text,
        },
        memoryIds: [],
        rejected: true,
      };
    throw error;
  } finally {
    trace.costMicros = context.costMicros;
  }
}

async function recentDays(
  read: Partial<McpCeilingReader>,
  trace: ReadTrace,
  onSummariesFailed: (error: unknown) => void,
): Promise<{
  readonly output: Record<string, unknown>;
  readonly read?: SummaryRead;
}> {
  const source = read.summaries;
  if (!source) return { output: {} };
  trace.summariesTried = true;
  try {
    const found = await source({
      days: TODAY_CONTEXT_SUMMARY_DAYS,
      limit: TODAY_CONTEXT_SUMMARY_LIMIT,
    });
    if (!found) return { output: {} };
    if (found.partial) onSummariesFailed(new Error(SUMMARIES_INCOMPLETE));
    const recent = found.summaries.map(({ day, text }) => ({ day, text }));
    return {
      output: { recentDays: recent, ...(found.partial ? { recentDaysComplete: false } : {}) },
      read: {
        ids: found.summaries.map(({ id }) => id),
        days: [...new Set(found.summaries.map(({ day }) => day))],
        characters: found.summaries.reduce((total, { text }) => total + [...text].length, 0),
        read: found.partial ? "partial" : "ok",
      },
    };
  } catch (error) {
    onSummariesFailed(error);
    return { output: { recentDays: [], recentDaysComplete: false }, read: SUMMARIES_FAILED };
  }
}

async function todayContext({ trace, read, context }: McpReadRequest): Promise<ToolOutcome> {
  const now = context.clock.now();
  const listed = await declaredSource(read, "reminders")(TODAY_CONTEXT_REMINDER_WINDOW_MS);
  const recent = await recentDays(read, trace, context.onSummariesFailed);
  const orderedReminders = [...listed.reminders].sort(
    (a, b) =>
      compareText(a.dueAt, b.dueAt) ||
      compareText(a.remindAt ?? "", b.remindAt ?? "") ||
      compareText(a.text, b.text) ||
      compareText(a.memoryId, b.memoryId),
  );
  return {
    output: {
      today: localDay(now, context.timeZone),
      timeZone: context.timeZone,
      now,
      reminders: orderedReminders.map((reminder) => ({
        text: reminder.text,
        dueAt: reminder.dueAt,
        remindAt: reminder.remindAt,
        repeat: reminder.repeat,
      })),
      ...(listed.more ? { more: true } : {}),
      ...recent.output,
    },
    memoryIds: orderedReminders.map(({ memoryId }) => memoryId),
    ...(recent.read ? { summaries: recent.read } : {}),
  };
}

async function startHere(request: McpReadRequest): Promise<ToolOutcome> {
  const { read } = request;
  const outline = await read.profile?.();
  const requirements = (outline?.rules ?? []).map(({ text }) => text);
  const sections = (outline?.sections ?? []).map(({ title, lines }) => ({
    title,
    items: lines.map(({ text }) => text),
  }));
  const omittedProfile = outline?.usage.queued.length ?? 0;
  const owned = await declaredSource(read, "ownerRules")();
  const summaries = owned.flatMap((row) => {
    const summary = enforcedOwnerRule(row)?.summary.replace(/\s+/gu, " ").trim();
    return summary ? [summary] : [];
  });
  const kept: string[] = [];
  let remaining = START_HERE_RULES_CHARACTER_BUDGET;
  for (const summary of summaries) {
    const length = [...summary].length + 3;
    if (length > remaining) break;
    remaining -= length;
    kept.push(summary);
  }
  const omittedRules = summaries.length - kept.length;
  const rules = {
    note: MCP_START_HERE_RULES_NOTE.text,
    items: kept,
    ...(omittedRules > 0
      ? { omitted: renderPrompt(MCP_START_HERE_RULES_OMITTED, { count: String(omittedRules) }) }
      : {}),
  };
  const today = await todayContext(request);
  const [maskedRequirements, maskedSections] = maskForExternalRead([
    requirements,
    sections,
    rules,
    today.output,
  ]) as [unknown, unknown];
  const profile = {
    version: createHash("sha256")
      .update(JSON.stringify([maskedRequirements, maskedSections, omittedProfile]))
      .digest("hex")
      .slice(0, 12),
    requirements,
    sections,
    ...(omittedProfile > 0
      ? { omitted: renderPrompt(MCP_START_HERE_OMITTED, { count: String(omittedProfile) }) }
      : {}),
  };
  const memoryIds = [
    ...new Set([
      ...(outline?.rules ?? []).map(({ memoryId }) => memoryId as string),
      ...(outline?.sections ?? []).flatMap(({ lines }) =>
        lines.map(({ memoryId }) => memoryId as string),
      ),
      ...today.memoryIds,
    ]),
  ].slice(0, START_HERE_MEMORY_ID_LIMIT);
  return {
    output: { profile, rules, today: today.output },
    memoryIds,
    ...(today.summaries ? { summaries: today.summaries } : {}),
  };
}

async function ruleBook({ read }: McpReadRequest): Promise<ToolOutcome> {
  const builtIn = await declaredSource(read, "builtInRules")();
  const owned = await declaredSource(read, "ownerRules")();
  return {
    output: {
      rules: [
        ...builtIn.map(({ rule, parameters }) => ({
          ...parameters,
          id: rule.id,
          revision: rule.revision,
          gate: rule.gate,
          outcome: rule.outcome,
          origin: rule.origin,
          source: rule.source,
          status: rule.status,
        })),
        ...owned.map(ownerRuleEntry),
      ],
    },
    memoryIds: [],
  };
}

const NO_ARGUMENTS = Object.freeze({ type: "object", properties: {}, additionalProperties: false });

export const MCP_READ_TOOLS: readonly McpReadToolEntry[] = mcpReadToolRegistry([
  {
    name: "start_here",
    description: MCP_TOOL_START_HERE.text,
    inputSchema: NO_ARGUMENTS,
    readCeiling: { sources: ["profile", "ownerRules", "reminders", "summaries"] },
    run: startHere,
  },
  {
    name: "find_memories",
    description: MCP_TOOL_FIND_MEMORIES.text,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        includeHistory: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        auto: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readCeiling: { sources: ["recall"] },
    run: findMemories,
  },
  {
    name: "today_context",
    description: MCP_TOOL_TODAY_CONTEXT.text,
    inputSchema: NO_ARGUMENTS,
    readCeiling: { sources: ["reminders", "summaries"] },
    run: todayContext,
  },
  {
    name: "rule_book",
    description: MCP_TOOL_RULE_BOOK.text,
    inputSchema: NO_ARGUMENTS,
    readCeiling: { sources: ["builtInRules", "ownerRules"] },
    run: ruleBook,
  },
]);

export const MCP_READ_TOOL_NAMES: readonly string[] = Object.freeze(
  MCP_READ_TOOLS.map(({ name }) => name),
);

function webRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  const host = request.headers.host ?? "localhost";
  return new Request(new URL(MCP_READ_PATH, `${request.protocol}://${host}`), {
    method: request.method,
    headers,
    ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? null) } : {}),
  });
}

async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
  body: Buffer,
): Promise<FastifyReply> {
  reply.code(response.status).header("cache-control", "no-store");
  response.headers.forEach((value, name) => {
    if (name !== "content-length" && name !== "cache-control") reply.header(name, value);
  });
  return reply.send(body);
}

const MCP_ADMISSION_STATUS = {
  unauthorized: 401,
  paused: 403,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
} as const;

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
    const route = (url: string) =>
      scope.route({
        method: ["GET", "POST", "DELETE"],
        url,
        bodyLimit: MCP_READ_BODY_LIMIT,
        logLevel: "silent",
        onRequest: async (request, reply) => {
          const header = request.headers[MCP_ACCESS_ASSERTION_HEADER];
          const params = request.params as { readonly secret?: unknown };
          const gate = await mcp.admit(
            typeof header === "string" ? header : undefined,
            typeof params.secret === "string" ? params.secret : undefined,
          );
          if (gate.status === "ok") {
            admitted.set(request, gate.authInfo);
            return;
          }
          return reply
            .code(MCP_ADMISSION_STATUS[gate.status])
            .header("cache-control", "no-store")
            .send();
        },
        preHandler: async (request, reply) => {
          const authInfo = admitted.get(request);
          if (!authInfo) return;
          const begun = await mcp.begin(authInfo, request.body);
          if (begun.status === "ok") {
            admitted.set(request, begun.authInfo);
            return;
          }
          return reply.code(429).header("cache-control", "no-store").send();
        },
        handler: async (request, reply) => {
          const authInfo = admitted.get(request);
          try {
            const response = await mcp.handler.fetch(webRequest(request), {
              ...(request.method === "POST" ? { parsedBody: request.body } : {}),
              ...(authInfo ? { authInfo } : {}),
            });
            const body = Buffer.from(await response.arrayBuffer());
            return sendWebResponse(reply, response, body);
          } finally {
            if (authInfo) await mcp.finish(authInfo);
          }
        },
      });
    route(MCP_READ_PATH);
    route(`${MCP_READ_PATH}/:secret`);
  });
}
