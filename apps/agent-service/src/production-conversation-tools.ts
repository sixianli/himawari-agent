import {
  type DataClassification,
  highestClassification,
  modelVisibleClassifications,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  type ConversationLine,
  type ConversationTurnService,
  type EmbedWithin,
  localDay,
  requestedTimeScope,
} from "@himawari-agent/memory-engine";
import {
  TOOL_CONVERSATION_OPEN,
  TOOL_CONVERSATION_SEARCH,
  TOOL_RESULT_CONVERSATION_EMPTY,
  TOOL_RESULT_CONVERSATION_NOT_FOUND,
} from "@himawari-agent/prompt-catalog";

type SearchInput = Parameters<ConversationTurnService["search"]>[0];
type WindowInput = Parameters<ConversationTurnService["window"]>[0];

export const CONVERSATION_SEARCH_CAPABILITY_REF = "conversation.search";
export const CONVERSATION_OPEN_CAPABILITY_REF = "conversation.open";
export const DEFAULT_TOOL_RESULT_SHARE = 0.02;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SEARCHED_TURNS = 60;
const MINIMUM_PAGE_CHARACTERS = 2000;
const MAXIMUM_SEARCH_LINE_CHARACTERS = 500;
const MAXIMUM_PAGE = 100;

export class ConversationToolInputError extends Error {
  constructor() {
    super("CONVERSATION_INPUT_INVALID");
  }
}

export function conversationToolDescriptors(): RuntimeToolDescriptor[] {
  return [
    {
      name: "conversation_search",
      capabilityRef: CONVERSATION_SEARCH_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_CONVERSATION_SEARCH.text,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          page: { type: "integer", minimum: 1, maximum: MAXIMUM_PAGE },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "conversation_open",
      capabilityRef: CONVERSATION_OPEN_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_CONVERSATION_OPEN.text,
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string", minLength: 1, maxLength: 200 },
          sequence: { type: "integer", minimum: 1 },
          direction: { type: "string", enum: ["later", "earlier"] },
        },
        required: ["conversationId", "sequence"],
        additionalProperties: false,
      },
    },
  ];
}

export function toolResultCharacters(contextWindow: number | undefined, share: number): number {
  if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    return MINIMUM_PAGE_CHARACTERS;
  return Math.max(MINIMUM_PAGE_CHARACTERS, Math.floor(contextWindow * share));
}

export interface ProductionConversationToolsOptions {
  readonly ownerId: SearchInput["ownerId"];
  readonly agentId: SearchInput["agentId"];
  readonly turns: Pick<ConversationTurnService, "search" | "window">;
  readonly pageCharacters: number;
  readonly embedWithin: <T>(
    invocation: RuntimeToolInvocation,
    slot: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly timeZone?: string;
}

export interface ConversationToolResult {
  readonly output: Record<string, unknown>;
  readonly contentClassification: DataClassification;
}

function onlyKeys(args: RuntimeToolInvocation["arguments"], allowed: readonly string[]) {
  if (Object.keys(args).some((name) => !allowed.includes(name)))
    throw new ConversationToolInputError();
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new ConversationToolInputError();
  return value;
}

function clipped(text: string, maximum: number): { text: string; truncated: boolean } {
  const characters = [...text];
  return characters.length <= maximum
    ? { text, truncated: false }
    : { text: `${characters.slice(0, maximum).join("")}…`, truncated: true };
}

interface ShownLine {
  readonly sequence: number;
  readonly speaker: string;
  readonly time: string;
  readonly text: string;
  readonly truncated?: true;
}

export class ProductionConversationTools {
  readonly #options: ProductionConversationToolsOptions;

  constructor(options: ProductionConversationToolsOptions) {
    this.#options = options;
  }

  run(invocation: RuntimeToolInvocation): Promise<ConversationToolResult> {
    if (invocation.capabilityRef === CONVERSATION_SEARCH_CAPABILITY_REF)
      return this.#search(invocation);
    if (invocation.capabilityRef === CONVERSATION_OPEN_CAPABILITY_REF)
      return this.#open(invocation);
    throw new ConversationToolInputError();
  }

  #line(line: ConversationLine, maximum: number): ShownLine {
    const shown = clipped(line.text, maximum);
    return {
      sequence: line.sequence,
      speaker: line.role === "owner" ? "主人" : "你",
      time: line.committedAt,
      text: shown.text,
      ...(shown.truncated ? { truncated: true } : {}),
    };
  }

  async #search(invocation: RuntimeToolInvocation): Promise<ConversationToolResult> {
    const args = invocation.arguments;
    onlyKeys(args, ["query", "from", "to", "page"]);
    const query = typeof args["query"] === "string" ? args["query"].trim() : "";
    const from = args["from"];
    const to = args["to"];
    if (
      query.length === 0 ||
      query.length > 500 ||
      (from !== undefined && (typeof from !== "string" || !DATE.test(from))) ||
      (to !== undefined && (typeof to !== "string" || !DATE.test(to)))
    )
      throw new ConversationToolInputError();
    const page = args["page"] === undefined ? 1 : positiveInteger(args["page"], MAXIMUM_PAGE);
    const timeZone = this.#options.timeZone ?? "UTC";
    let scope: ReturnType<typeof requestedTimeScope>;
    try {
      scope = requestedTimeScope(
        {
          from: from as string | undefined,
          to: to as string | undefined,
          includeHistory: true,
        },
        timeZone,
      );
    } catch (error) {
      if (error instanceof RangeError) throw new ConversationToolInputError();
      throw error;
    }
    const within: EmbedWithin = (_classification, operation) =>
      this.#options.embedWithin(invocation, "conversation-search", operation);
    const hits = await this.#options.turns.search({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      query,
      from: scope.from,
      to: scope.to,
      excludeThreadId: null,
      allowedClassifications: modelVisibleClassifications(),
      limit: SEARCHED_TURNS,
      within,
    });
    const budget = this.#options.pageCharacters;
    const lineLimit = Math.min(MAXIMUM_SEARCH_LINE_CHARACTERS, budget);
    const pages: { turn: (typeof hits)[number]; lines: ShownLine[] }[][] = [];
    let current: (typeof pages)[number] = [];
    let used = 0;
    for (const hit of hits) {
      const lines = hit.lines.map((line) => this.#line(line, lineLimit));
      const size = lines.reduce((total, line) => total + line.text.length, 0);
      if (current.length > 0 && used + size > budget) {
        pages.push(current);
        current = [];
        used = 0;
      }
      current.push({ turn: hit, lines });
      used += size;
    }
    if (current.length > 0) pages.push(current);
    const shown = pages[page - 1] ?? [];
    const contentClassification = highestClassification(
      invocation.dataClassification,
      shown.flatMap(({ turn }) => turn.lines.map((line) => line.dataClassification)),
    );
    return {
      output: {
        query,
        window: scope.from || scope.to ? { from: scope.from, to: scope.to, timeZone } : null,
        page,
        turns: shown.map(({ turn, lines }) => ({
          conversationId: turn.turn.threadId,
          sequence: turn.turn.firstSequence,
          day: localDay(turn.turn.startedAt, timeZone),
          lines,
        })),
        ...(page < pages.length ? { nextPage: page + 1 } : {}),
        ...(shown.length === 0 ? { note: TOOL_RESULT_CONVERSATION_EMPTY.text } : {}),
      },
      contentClassification,
    };
  }

  async #open(invocation: RuntimeToolInvocation): Promise<ConversationToolResult> {
    const args = invocation.arguments;
    onlyKeys(args, ["conversationId", "sequence", "direction"]);
    const conversationId = args["conversationId"];
    const direction = args["direction"] ?? "later";
    if (
      typeof conversationId !== "string" ||
      conversationId.trim().length === 0 ||
      conversationId.length > 200 ||
      (direction !== "later" && direction !== "earlier")
    )
      throw new ConversationToolInputError();
    const sequence = positiveInteger(args["sequence"]);
    const budget = this.#options.pageCharacters;
    const opened = await this.#options.turns.window({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      threadId: conversationId as WindowInput["threadId"],
      fromSequence: sequence,
      direction,
      maximumCharacters: budget,
    });
    if (!opened)
      return {
        output: { conversationId, found: false, note: TOOL_RESULT_CONVERSATION_NOT_FOUND.text },
        contentClassification: invocation.dataClassification,
      };
    return {
      output: {
        conversationId,
        found: true,
        lines: opened.lines.map((line) => this.#line(line, budget)),
        earlierFrom: opened.earlierFrom,
        laterFrom: opened.laterFrom,
      },
      contentClassification: highestClassification(
        invocation.dataClassification,
        opened.lines.map((line) => line.dataClassification),
      ),
    };
  }
}
