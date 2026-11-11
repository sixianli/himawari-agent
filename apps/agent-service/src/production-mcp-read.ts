import { randomUUID } from "node:crypto";
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
  MCP_TOOL_FIND_MEMORIES,
  MCP_TOOL_RESULT_FAILED,
  MCP_TOOL_RULE_BOOK,
  MCP_TOOL_TODAY_CONTEXT,
} from "@himawari-agent/prompt-catalog";
import { maskSensitiveTexts } from "@himawari-agent/sensitive-capture";
import {
  type CallToolResult,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  fromJsonSchema,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BearerGate } from "./bearer-admission.js";
import type { RecallResult } from "./production-memory-recall.js";
import type { ListedReminder } from "./production-reminder-writer.js";
import type { MailEmbeddingContext } from "./production-run-memory.js";

export const MCP_READ_PATH = "/api/mcp/v1";
export const MCP_READ_BODY_LIMIT = 65_536;
export const MCP_READ_SECRET_MINIMUM_LENGTH = 32;
export const MCP_READ_TOOL_NAMES = ["find_memories", "today_context", "rule_book"] as const;
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
  readonly summaries?: (input: { readonly days: number; readonly limit: number }) => Promise<{
    readonly summaries: readonly {
      readonly id: string;
      readonly day: string;
      readonly text: string;
    }[];
    readonly partial: boolean;
  }>;
}

export interface ProductionMcpReadOptions {
  readonly scope: Pick<DecisionLedgerWrite, "ownerId" | "agentId">;
  readonly clock: ClockPort;
  readonly secret: string;
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

export class ProductionMcpRead {
  readonly #options: ProductionMcpReadOptions;
  readonly #gate: BearerGate;
  readonly handler: McpHttpHandler;

  constructor(options: ProductionMcpReadOptions) {
    this.#options = options;
    this.#gate = new BearerGate(
      options.clock,
      options.secret,
      MCP_READ_SECRET_MINIMUM_LENGTH,
      "MCP_READ_SECRET_TOO_SHORT",
    );
    this.handler = createMcpHandler((context) => this.#server(context.requestInfo ?? null), {
      onerror: options.onFailure,
    });
  }

  admit(authorization: string | undefined) {
    return this.#gate.admit(authorization);
  }

  #server(request: Request | null): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
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
    return server;
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
        if (gate === "ok") return;
        return reply
          .code(gate === "unauthorized" ? 401 : 429)
          .header("cache-control", "no-store")
          .header("www-authenticate", 'Bearer realm="himawari"')
          .send();
      },
      handler: async (request, reply) =>
        sendWebResponse(
          reply,
          await mcp.handler.fetch(webRequest(request), {
            ...(request.method === "POST" ? { parsedBody: request.body } : {}),
          }),
        ),
    });
  });
}
