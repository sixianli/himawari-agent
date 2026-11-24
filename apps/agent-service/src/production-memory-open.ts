import {
  type DataClassification,
  highestClassification,
  type MemoryHistoryEvent,
  modelVisibleClassifications,
  type PayloadRef,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { TOOL_MEMORY_OPEN, TOOL_RESULT_MEMORY_NOT_FOUND } from "@himawari-agent/prompt-catalog";
import { carriesExternalContent } from "./context-external-content.js";

export const MEMORY_OPEN_CAPABILITY_REF = "memory.open";
const MAXIMUM_PAGE = 100;

export class MemoryOpenInputError extends Error {
  constructor() {
    super("MEMORY_OPEN_INPUT_INVALID");
  }
}

export function memoryOpenDescriptor(): RuntimeToolDescriptor {
  return {
    name: "memory_open",
    capabilityRef: MEMORY_OPEN_CAPABILITY_REF,
    capabilityHandleRef: null,
    description: TOOL_MEMORY_OPEN.text,
    parameters: {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1 },
        page: { type: "integer", minimum: 1, maximum: MAXIMUM_PAGE },
      },
      required: ["number"],
      additionalProperties: false,
    },
  };
}

type MemoryScope = Pick<ProductMemoryRecord, "ownerId" | "agentId">;

export interface ProductionMemoryOpenOptions {
  readonly ownerId: ProductMemoryRecord["ownerId"];
  readonly agentId: ProductMemoryRecord["agentId"];
  readonly state: Pick<ProductMemoryStatePort, "byNumber" | "read" | "numbers" | "listHistory">;
  readonly readText: (ref: PayloadRef, scope: MemoryScope) => Promise<string | undefined>;
  readonly pageCharacters: number;
  readonly now: () => string;
}

export interface MemoryOpenResult {
  readonly output: Record<string, unknown>;
  readonly contentClassification: DataClassification;
  readonly memoryIds: readonly string[];
  readonly externalContent: boolean;
}

interface ShownVersion {
  readonly kind: MemoryHistoryEvent["kind"];
  readonly time: string;
  readonly text: string | null;
  readonly quote: string | null;
  readonly conversationId: string | null;
}

function wholeNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new MemoryOpenInputError();
  return value;
}

function clipped(text: string | null, maximum: number): string | null {
  if (text === null) return null;
  const characters = [...text];
  return characters.length <= maximum ? text : `${characters.slice(0, maximum - 1).join("")}…`;
}

function status(memory: ProductMemoryRecord, now: string): string {
  if (memory.status === "trashed") return "trashed";
  if (memory.status !== "active") return "archived";
  const attributes = memory.attributes;
  if (attributes?.supersededBy) return "corrected";
  if (attributes?.validTo && attributes.validTo <= now) return "ended";
  if (attributes?.tentative === true) return "tentative";
  return "current";
}

export class ProductionMemoryOpen {
  readonly #options: ProductionMemoryOpenOptions;

  constructor(options: ProductionMemoryOpenOptions) {
    this.#options = options;
  }

  async open(invocation: RuntimeToolInvocation): Promise<MemoryOpenResult> {
    const args = invocation.arguments;
    if (Object.keys(args).some((name) => name !== "number" && name !== "page"))
      throw new MemoryOpenInputError();
    const number = wholeNumber(args["number"]);
    const page = args["page"] === undefined ? 1 : wholeNumber(args["page"], MAXIMUM_PAGE);
    const scope = { ownerId: this.#options.ownerId, agentId: this.#options.agentId };
    const missing = (): MemoryOpenResult => ({
      output: { number, found: false, note: TOOL_RESULT_MEMORY_NOT_FOUND.text },
      contentClassification: invocation.dataClassification,
      memoryIds: [],
      externalContent: false,
    });
    const memoryId = await this.#options.state.byNumber({ ...scope, number });
    if (!memoryId) return missing();
    const memory = await this.#options.state.read(memoryId);
    if (
      !memory ||
      memory.ownerId !== scope.ownerId ||
      memory.agentId !== scope.agentId ||
      memory.status === "deletion_pending" ||
      memory.status === "deleted_verified" ||
      !modelVisibleClassifications().includes(memory.dataClassification)
    )
      return missing();
    const text = (await this.#options.readText(memory.contentRef, scope)) ?? null;
    const supersededBy = memory.attributes?.supersededBy ?? null;
    const correctedBy = supersededBy
      ? ((await this.#options.state.numbers({ ...scope, memoryIds: [supersededBy] }))[0]?.number ??
        null)
      : null;
    const events = await this.#options.state.listHistory({ ...scope, memoryIds: [memory.id] });
    const versions: ShownVersion[] = [];
    for (const event of [...events].sort(
      (left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id - right.id,
    ))
      versions.push({
        kind: event.kind,
        time: event.occurredAt,
        text: (await this.#options.readText(event.contentRef, scope)) ?? null,
        quote: event.quoteRef
          ? ((await this.#options.readText(event.quoteRef, scope)) ?? null)
          : null,
        conversationId: event.sourceDeleted ? null : event.sourceThreadId,
      });
    const attributes = memory.attributes;
    const head = {
      number,
      found: true,
      text,
      category: attributes?.category ?? null,
      status: status(memory, this.#options.now()),
      recordedAt: memory.recordedAt ?? memory.updatedAt,
      validFrom: attributes?.validFrom ?? null,
      validTo: attributes?.validTo ?? null,
      correctedBy,
      page,
    };
    const budget = this.#options.pageCharacters;
    const pages: ShownVersion[][] = [];
    let current: ShownVersion[] = [];
    let used = JSON.stringify({ ...head, versions: [], nextPage: MAXIMUM_PAGE }).length;
    const fixed = used;
    for (const whole of versions) {
      const bare = JSON.stringify({ ...whole, text: "", quote: "" }).length + 1;
      const room = Math.max(1, Math.floor((budget - fixed - bare) / 2));
      const version = {
        ...whole,
        text: clipped(whole.text, room),
        quote: clipped(whole.quote, room),
      };
      const size = JSON.stringify(version).length + 1;
      if (current.length > 0 && used + size > budget) {
        pages.push(current);
        current = [];
        used = fixed;
      }
      current.push(version);
      used += size;
    }
    if (current.length > 0 || pages.length === 0) pages.push(current);
    const shown = pages[page - 1] ?? [];
    return {
      output: {
        ...head,
        versions: shown,
        ...(page < pages.length ? { nextPage: page + 1 } : {}),
      },
      contentClassification: highestClassification(invocation.dataClassification, [
        memory.dataClassification,
      ]),
      memoryIds: [memory.id],
      externalContent: carriesExternalContent(memory.sourceRefs),
    };
  }
}
