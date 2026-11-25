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
        page: { type: "integer", minimum: 1 },
      },
      required: ["number"],
      additionalProperties: false,
    },
  };
}

type MemoryScope = Pick<ProductMemoryRecord, "ownerId" | "agentId">;

export interface MemoryOpenText {
  readonly text: string;
  readonly dataClassification: DataClassification;
}

export interface ProductionMemoryOpenOptions {
  readonly ownerId: ProductMemoryRecord["ownerId"];
  readonly agentId: ProductMemoryRecord["agentId"];
  readonly state: Pick<ProductMemoryStatePort, "byNumber" | "read" | "numbers" | "listHistory">;
  readonly readText: (ref: PayloadRef, scope: MemoryScope) => Promise<MemoryOpenText | undefined>;
  readonly pageCharacters: number;
  readonly now: () => string;
}

export interface MemoryOpenResult {
  readonly output: Record<string, unknown>;
  readonly contentClassification: DataClassification;
  readonly memoryIds: readonly string[];
  readonly externalContent: boolean;
}

interface ShownPage {
  readonly text?: string | null;
  readonly versions: ShownVersion[];
}

interface ShownText {
  readonly text: string | null;
  readonly classifications: DataClassification[];
}

interface ShownVersion {
  readonly kind: MemoryHistoryEvent["kind"];
  readonly time: string;
  readonly text: string | null;
  readonly quote: string | null;
  readonly conversationId: string | null;
}

function wholeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new MemoryOpenInputError();
  return value;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function fitted(text: string | null, limit: number): string | null {
  if (text === null || serializedLength(text) <= limit) return text;
  const characters = [...text];
  const shortened = (keep: number) => `${characters.slice(0, keep).join("")}…`;
  let low = 0;
  let high = Math.max(0, Math.min(characters.length - 1, limit - 3));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedLength(shortened(middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return shortened(low);
}

function textPieces(text: string, limit: number): string[] {
  const characters = [...text];
  const pieces: string[] = [];
  let start = 0;
  do {
    let low = 1;
    let high = Math.max(1, Math.min(characters.length - start, limit - 2));
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serializedLength(characters.slice(start, start + middle).join("")) <= limit) low = middle;
      else high = middle - 1;
    }
    const end = Math.min(characters.length, start + low);
    pieces.push(characters.slice(start, end).join(""));
    start = end;
  } while (start < characters.length);
  return pieces;
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
    const page = args["page"] === undefined ? 1 : wholeNumber(args["page"]);
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
    const visible = async (ref: PayloadRef): Promise<ShownText> => {
      const read = await this.#options.readText(ref, scope);
      if (!read || !modelVisibleClassifications().includes(read.dataClassification))
        return { text: null, classifications: [] };
      return { text: read.text, classifications: [read.dataClassification] };
    };
    const current = await visible(memory.contentRef);
    const text = current.text;
    const supersededBy = memory.attributes?.supersededBy ?? null;
    const correctedBy = supersededBy
      ? ((await this.#options.state.numbers({ ...scope, memoryIds: [supersededBy] }))[0]?.number ??
        null)
      : null;
    const events = await this.#options.state.listHistory({ ...scope, memoryIds: [memory.id] });
    const versions: {
      readonly shown: ShownVersion;
      readonly classifications: DataClassification[];
    }[] = [];
    for (const event of [...events].sort(
      (left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id - right.id,
    )) {
      const body = await visible(event.contentRef);
      const quote = event.quoteRef
        ? await visible(event.quoteRef)
        : { text: null, classifications: [] };
      versions.push({
        shown: {
          kind: event.kind,
          time: event.occurredAt,
          text: body.text,
          quote: quote.text,
          conversationId: event.sourceDeleted ? null : event.sourceThreadId,
        },
        classifications: [...body.classifications, ...quote.classifications],
      });
    }
    const attributes = memory.attributes;
    const meta = {
      number,
      found: true,
      category: attributes?.category ?? null,
      status: status(memory, this.#options.now()),
      recordedAt: memory.recordedAt ?? memory.updatedAt,
      validFrom: attributes?.validFrom ?? null,
      validTo: attributes?.validTo ?? null,
      correctedBy,
    };
    const pageOutput = (
      shown: ShownPage,
      pageNumber: number,
      nextPage: number | undefined,
    ): Record<string, unknown> => ({
      number: meta.number,
      found: meta.found,
      ...("text" in shown ? { text: shown.text } : {}),
      category: meta.category,
      status: meta.status,
      recordedAt: meta.recordedAt,
      validFrom: meta.validFrom,
      validTo: meta.validTo,
      correctedBy: meta.correctedBy,
      page: pageNumber,
      versions: shown.versions,
      ...(nextPage === undefined ? {} : { nextPage }),
    });
    const budget = this.#options.pageCharacters;
    const widest = Number.MAX_SAFE_INTEGER;
    const bareWithText = serializedLength(pageOutput({ text: "", versions: [] }, widest, widest));
    const bareWithoutText = serializedLength(pageOutput({ versions: [] }, widest, widest));
    const pages: ShownPage[] = [];
    const pageClassifications: DataClassification[][] = [];
    let used: number;
    if (text === null) {
      pages.push({ text: null, versions: [] });
      pageClassifications.push([]);
      used = serializedLength(pageOutput({ text: null, versions: [] }, widest, widest));
    } else {
      const pieces = textPieces(text, budget - bareWithText + 2);
      for (const piece of pieces) {
        pages.push({ text: piece, versions: [] });
        pageClassifications.push([...current.classifications]);
      }
      used = bareWithText - 2 + serializedLength(pieces.at(-1) ?? "");
    }
    for (const { shown: whole, classifications } of versions) {
      const bare = serializedLength({ ...whole, text: "", quote: "" }) + 1;
      const room = Math.floor((budget - bareWithoutText - bare) / 2) + 2;
      const version = {
        ...whole,
        text: fitted(whole.text, room),
        quote: fitted(whole.quote, room),
      };
      const size = serializedLength(version) + 1;
      const last = pages.at(-1) as ShownPage;
      if (used + size > budget && (last.versions.length > 0 || "text" in last)) {
        pages.push({ versions: [version] });
        pageClassifications.push([...classifications]);
        used = bareWithoutText + size;
      } else {
        last.versions.push(version);
        pageClassifications.at(-1)?.push(...classifications);
        used += size;
      }
    }
    const shown = pages[page - 1];
    if (!shown) throw new MemoryOpenInputError();
    return {
      output: pageOutput(shown, page, page < pages.length ? page + 1 : undefined),
      contentClassification: highestClassification(invocation.dataClassification, [
        memory.dataClassification,
        ...(pageClassifications[page - 1] ?? []),
      ]),
      memoryIds: [memory.id],
      externalContent: carriesExternalContent(memory.sourceRefs),
    };
  }
}
