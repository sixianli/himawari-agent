import { createHash } from "node:crypto";
import {
  AutomaticMemoryService,
  type ClockPort,
  type CommittedRunMemoryInput,
  type DataClassification,
  DEFAULT_MEMORY_ATTRIBUTES,
  type DecisionLedgerPort,
  type ExtractedMemoryCandidate,
  type IncrementalMemoryProductPort,
  MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS,
  MEMORY_CATEGORIES,
  type MemoryBookStorePort,
  type MemoryCaptureBacklogPort,
  type MemoryCaptureFailureOutcome,
  type MemoryCategory,
  type MemoryExtractionAuditRecord,
  type MemoryPersonLinkMention,
  type MemoryPersonMention,
  type MemoryReminderSchedule,
  type MemoryReminderStorePort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductMemoryStatePort,
  type RunExecutionSourcePort,
  type RuntimeRequest,
  SENSITIVE_MEMORY_TOPICS,
  type SensitiveMemoryApprovalRequest,
  type SensitiveMemoryApprovalStatePort,
  type SensitiveMemoryCandidatePort,
  type SensitiveMemoryTopic,
  type ThreadDistillationStatePort,
  type ThreadDistillationWork,
  type ThreadRepositoryPort,
  type UnitOfWorkPort,
} from "@himawari-agent/application";
import { localDayStart } from "@himawari-agent/memory-engine";
import {
  MEMORY_CAPTURE,
  MEMORY_CONFIRMATION_JUDGE,
  TRUSTED_PROMPT_TEXTS,
} from "@himawari-agent/prompt-catalog";
import {
  classificationWithIdentifiers,
  type EgressPlaceholderKind,
  isSafeToIndex,
  placeholderTable,
  restorePlaceholders,
} from "@himawari-agent/sensitive-capture";
import { judgeOrDefault } from "./auxiliary-judgment.js";
import { externalContentSourceRefs } from "./context-external-content.js";

type MemoryId = NonNullable<ExtractedMemoryCandidate["existingMemoryId"]>;
type ProductThreadMessage = Awaited<
  ReturnType<ThreadRepositoryPort["readCommittedMessagesByIds"]>
>[number];
type MessageId = ProductThreadMessage["id"];
const createMemoryId = (value: string) => value as MemoryId;
const createMemoryGenerationId = (value: string) =>
  value as CommittedRunMemoryInput["generationId"];
const createCheckpointJobId = (value: string) => value as ThreadDistillationWork["jobId"];

export const MEMORY_CAPTURE_POLICY_VERSION = "memory-capture:v5";
const MAXIMUM_SOURCE_CHARACTERS = 6000;
const MAXIMUM_RECENT_MEMORIES = 20;

export function confirmedFirstByRecency<
  T extends { readonly updatedAt: string; readonly attributes?: { readonly tentative?: boolean } },
>(records: readonly T[]): T[] {
  return [...records].sort(
    (left, right) =>
      Number(left.attributes?.tentative === true) - Number(right.attributes?.tentative === true) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
}
const MAXIMUM_RELEVANT_MEMORIES = 10;
const MAXIMUM_CONTEXT_CHARACTERS = 1500;
const MAXIMUM_CANDIDATES = 8;
const MAXIMUM_MEMORY_CHARACTERS = 500;
const MAXIMUM_SUPPORT_CACHE = 500;
const SUPPORT_JUDGE_VERSION = createHash("sha256")
  .update(MEMORY_CONFIRMATION_JUDGE.text)
  .digest("hex");
const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
};
const TOPICS = new Set<string>(SENSITIVE_MEMORY_TOPICS);
const CATEGORIES = new Set<string>(MEMORY_CATEGORIES);
const MINIMUM_QUOTE_CHARACTERS = 8;
const MAXIMUM_QUOTE_CHARACTERS = 300;
const MAXIMUM_ENTITIES = 8;
const MAXIMUM_SUB_CATEGORIES = 8;
const MAXIMUM_SUB_CATEGORY_CHARACTERS = 12;
const MAXIMUM_KNOWN_PEOPLE = 40;
const MAXIMUM_PEOPLE = 8;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/u;
const HOUR = 3_600_000;
const DATE_ONLY_REMIND_HOUR = 9;
const MAXIMUM_YEARLY_CATCH_UP = 200;
const MAXIMUM_REMINDER_HORIZON = 2 * 366 * 24 * HOUR;

const KINDS = new Set<ExtractedMemoryCandidate["kind"]>([
  "durable_fact",
  "decision",
  "commitment",
  "experience",
  "transient",
]);
const DECISIONS = new Set<string>(["create", "update", "merge", "unchanged", "supersede"]);

export interface ExistingMemoryText {
  readonly id: MemoryId;
  readonly text: string;
  readonly stance?: string | null;
  readonly tentative?: boolean;
  readonly category?: MemoryCategory;
}

export interface MemoryCaptureContext {
  readonly subCategories?: Readonly<Record<string, readonly string[]>>;
  readonly people?: readonly {
    readonly id: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly relation: string | null;
  }[];
}

export interface ParsedMemoryCandidates {
  readonly candidates: readonly ExtractedMemoryCandidate[];
  readonly explicitOrdinal: number | null;
  readonly unverifiedEvidence: number;
  readonly rejectedCandidates: readonly ExtractedMemoryCandidate[];
  readonly invalidCandidates: number;
  readonly returnedNone: boolean;
  readonly supportChecks: readonly SupportCheck[];
}

function evidenceText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s\p{P}]/gu, "")
    .toLowerCase();
}

export function quoteFromOwnerMessage(quote: string, ownerMessage: string): boolean {
  const normalizedQuote = evidenceText(quote);
  const normalizedMessage = evidenceText(ownerMessage);
  const minimum = Math.min(MINIMUM_QUOTE_CHARACTERS, [...normalizedMessage].length);
  return (
    [...normalizedQuote].length >= Math.max(1, minimum) &&
    normalizedMessage.includes(normalizedQuote)
  );
}

export interface SupportCheck {
  readonly key: string;
  readonly memoryText: string;
  readonly quote: string;
}

export class SupportVerdictCache {
  readonly #known = new Map<string, boolean>();

  get(check: SupportCheck, classification: DataClassification): boolean | undefined {
    return this.#known.get(this.#key(check, classification));
  }

  set(check: SupportCheck, classification: DataClassification, verdict: boolean): void {
    if (this.#known.size >= MAXIMUM_SUPPORT_CACHE) this.#known.clear();
    this.#known.set(this.#key(check, classification), verdict);
  }

  #key(check: SupportCheck, classification: DataClassification): string {
    return createHash("sha256")
      .update(
        `${SUPPORT_JUDGE_VERSION}\u0000${classification}\u0000${check.memoryText}\u0000${check.quote}`,
      )
      .digest("hex");
  }
}

export function supportCheckKey(memoryId: string, quote: string): string {
  return `${memoryId}\u0000${quote}`;
}

export function memoryConfirmationJudgePrompt(memoryText: string, quote: string): string {
  return [
    MEMORY_CONFIRMATION_JUDGE.text,
    JSON.stringify({
      pendingMemory: memoryText.slice(0, MAXIMUM_MEMORY_CHARACTERS),
      ownerQuote: quote.slice(0, MAXIMUM_SOURCE_CHARACTERS),
    }),
  ].join("\n");
}

export function parseSupportVerdict(output: string): boolean {
  const parsed = jsonObject(output);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { supports?: unknown }).supports !== "boolean"
  )
    throw new Error("MEMORY_CAPTURE_RESPONSE_INVALID");
  return (parsed as { supports: boolean }).supports;
}

export function memoryCapturePrompt(
  message: string,
  existing: readonly ExistingMemoryText[],
  previousAssistantMessage: string | null = null,
  sentAt: string | null = null,
  timeZone: string | null = null,
  context: MemoryCaptureContext = {},
): string {
  return [
    MEMORY_CAPTURE.text,
    JSON.stringify({
      existingMemories: existing.map(({ id, text, stance }) => ({
        id,
        text,
        stance: stance ?? null,
      })),
      existingSubCategories: context.subCategories ?? {},
      knownPeople: (context.people ?? []).slice(0, MAXIMUM_KNOWN_PEOPLE),
      previousAssistantMessage:
        previousAssistantMessage?.slice(-MAXIMUM_CONTEXT_CHARACTERS) ?? null,
      messageSentAt: sentAt,
      ownerTimeZone: timeZone ?? "UTC",
      ownerMessage: message.slice(0, MAXIMUM_SOURCE_CHARACTERS),
    }),
  ].join("\n");
}

function laterYear(localValue: string, years: number): string {
  return localValue.replace(/^\d{4}/u, (year) => String(Number(year) + years).padStart(4, "0"));
}

export function reminderSchedule(
  dueAt: unknown,
  repeat: unknown,
  sentAt: string | undefined,
  timeZone = "UTC",
): MemoryReminderSchedule | undefined {
  if (typeof dueAt !== "string" || sentAt === undefined) return undefined;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return undefined;
  const yearly = repeat === "yearly";
  const resolve = (value: string) => {
    const timed = LOCAL_TIME.exec(value);
    const day = timed ? timed[1] : value;
    if (!day || !DATE_ONLY.test(day)) return null;
    const start = localDayStart(day, timeZone);
    if (start === null) return null;
    const hours = timed ? Number(timed[2]) : DATE_ONLY_REMIND_HOUR;
    const minutes = timed ? Number(timed[3]) : 0;
    if (hours > 23 || minutes > 59) return null;
    const due = Date.parse(start) + hours * HOUR + minutes * 60_000;
    return { due, remind: timed ? Math.max(due - HOUR, sent) : due };
  };
  const local = dueAt.trim();
  let resolved = resolve(local);
  if (resolved === null) return undefined;
  if (yearly)
    for (let years = 1; years <= MAXIMUM_YEARLY_CATCH_UP && resolved.due <= sent; years += 1) {
      resolved = resolve(laterYear(local, years));
      if (resolved === null) return undefined;
    }
  if (resolved.due <= sent || resolved.due - sent > MAXIMUM_REMINDER_HORIZON) return undefined;
  return {
    dueAt: new Date(resolved.due).toISOString(),
    remindAt: new Date(resolved.remind).toISOString(),
    repeat: yearly ? "yearly" : "none",
  };
}

function jsonObject(output: string): unknown {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("MEMORY_CAPTURE_RESPONSE_INVALID");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function parseMemoryCandidates(input: {
  readonly output: string;
  readonly sourceRef: string;
  readonly extraSourceRefs?: readonly string[];
  readonly sourceClassification: DataClassification;
  readonly existingIds: ReadonlySet<string>;
  readonly tentativeMemories?: ReadonlyMap<
    string,
    { readonly text: string; readonly category: MemoryCategory }
  >;
  readonly ownerMessage?: string;
  readonly supportVerdicts?: ReadonlyMap<string, boolean>;
  readonly sentAt?: string;
  readonly timeZone?: string;
  readonly subCategories?: Readonly<Record<string, readonly string[]>>;
  readonly knownPersonIds?: ReadonlySet<string>;
  readonly restore?: (text: string) => string;
}): ParsedMemoryCandidates {
  const restore = input.restore ?? ((text: string) => text);
  const subCategories = new Map(
    Object.entries(input.subCategories ?? {}).map(([category, names]) => [
      category,
      new Set(names),
    ]),
  );
  const subCategoryFor = (category: MemoryCategory, value: unknown): string | null => {
    if (typeof value !== "string" || category === "relationship" || category === "event")
      return null;
    const name = value.normalize("NFKC").trim();
    if (name.length === 0 || [...name].length > MAXIMUM_SUB_CATEGORY_CHARACTERS) return null;
    const known = subCategories.get(category) ?? new Set<string>();
    if (!known.has(name)) {
      if (known.size >= MAXIMUM_SUB_CATEGORIES) return null;
      known.add(name);
      subCategories.set(category, known);
    }
    return name;
  };
  const shortText = (value: unknown, maximum: number): string | null => {
    if (typeof value !== "string") return null;
    const text = value.normalize("NFKC").trim();
    return text.length === 0 || [...text].length > maximum ? null : text;
  };
  const knownPerson = (value: unknown): string | null =>
    typeof value === "string" && input.knownPersonIds?.has(value) ? value : null;
  const parsed = jsonObject(input.output);
  if (typeof parsed !== "object" || parsed === null || !("memories" in parsed))
    throw new Error("MEMORY_CAPTURE_RESPONSE_INVALID");
  const items = (parsed as { memories: unknown }).memories;
  if (!Array.isArray(items)) throw new Error("MEMORY_CAPTURE_RESPONSE_INVALID");
  const candidates: ExtractedMemoryCandidate[] = [];
  const rejectedCandidates: ExtractedMemoryCandidate[] = [];
  let explicitOrdinal: number | null = null;
  let unverifiedEvidence = 0;
  let invalidCandidates = 0;
  const supportChecks: SupportCheck[] = [];
  for (const item of items.slice(0, MAXIMUM_CANDIDATES)) {
    if (typeof item !== "object" || item === null) {
      invalidCandidates += 1;
      continue;
    }
    const value = item as Record<string, unknown>;
    const text = typeof value["text"] === "string" ? restore(value["text"].trim()) : "";
    const kind = value["kind"] as ExtractedMemoryCandidate["kind"];
    const requestedDecision = value["decision"];
    const existing =
      typeof value["existingMemoryId"] === "string" &&
      input.existingIds.has(value["existingMemoryId"])
        ? createMemoryId(value["existingMemoryId"])
        : null;
    if (
      !text ||
      text.length > MAXIMUM_MEMORY_CHARACTERS ||
      !KINDS.has(kind) ||
      typeof requestedDecision !== "string" ||
      !DECISIONS.has(requestedDecision) ||
      (requestedDecision !== "create" && existing === null)
    ) {
      invalidCandidates += 1;
      continue;
    }
    const supersedes = requestedDecision === "supersede" ? existing : null;
    const decision: ExtractedMemoryCandidate["decision"] =
      requestedDecision === "supersede" || existing === null
        ? "create"
        : (requestedDecision as ExtractedMemoryCandidate["decision"]);
    const quote = typeof value["quote"] === "string" ? restore(value["quote"]) : "";
    const requested = classificationWithIdentifiers(
      quote,
      classificationWithIdentifiers(
        text,
        value["classification"] === "sensitive" || value["classification"] === "restricted"
          ? value["classification"]
          : "private",
      ),
    );
    const dataClassification =
      CLASSIFICATION_RANK[requested] >= CLASSIFICATION_RANK[input.sourceClassification]
        ? requested
        : input.sourceClassification;
    const evidenceVerified =
      input.ownerMessage !== undefined && quoteFromOwnerMessage(quote, input.ownerMessage);
    const confirmsTentative =
      existing !== null &&
      input.tentativeMemories?.has(existing) === true &&
      (decision === "unchanged" || decision === "update" || decision === "merge");
    const supportKey = existing === null ? "" : supportCheckKey(existing, quote);
    if (confirmsTentative && evidenceVerified && !input.supportVerdicts?.has(supportKey))
      supportChecks.push({
        key: supportKey,
        memoryText: input.tentativeMemories?.get(existing)?.text ?? "",
        quote,
      });
    const evidenceRejected =
      (input.ownerMessage !== undefined &&
        decision !== "unchanged" &&
        dataClassification !== "restricted" &&
        !evidenceVerified) ||
      (confirmsTentative && (!evidenceVerified || input.supportVerdicts?.get(supportKey) !== true));
    const category = (
      typeof value["category"] === "string" && CATEGORIES.has(value["category"])
        ? value["category"]
        : "other"
    ) as MemoryCategory;
    const importancePermille =
      typeof value["importance"] === "number" && Number.isFinite(value["importance"])
        ? Math.max(0, Math.min(1000, Math.round(value["importance"])))
        : 500;
    const entities = Array.isArray(value["entities"])
      ? [
          ...new Set(
            value["entities"]
              .filter((entity): entity is string => typeof entity === "string")
              .map((entity) => entity.normalize("NFKC").trim())
              .filter(
                (entity) => entity.length > 0 && entity.length <= 64 && isSafeToIndex(entity),
              ),
          ),
        ].slice(0, MAXIMUM_ENTITIES)
      : [];
    const validFrom =
      typeof value["validFrom"] === "string" &&
      DATE_ONLY.test(value["validFrom"]) &&
      !Number.isNaN(Date.parse(`${value["validFrom"]}T00:00:00.000Z`))
        ? value["validFrom"]
        : null;
    const subCategory = subCategoryFor(category, value["subCategory"]);
    const stance = shortText(value["stance"], 16);
    const people: MemoryPersonMention[] = Array.isArray(value["people"])
      ? value["people"]
          .filter(
            (person): person is Record<string, unknown> =>
              typeof person === "object" && person !== null,
          )
          .flatMap((person) => {
            const name = shortText(person["name"], 64);
            if (!name) return [];
            return [
              {
                name,
                aliases: Array.isArray(person["aliases"])
                  ? person["aliases"]
                      .map((alias) => shortText(alias, 64))
                      .filter((alias): alias is string => alias !== null)
                      .slice(0, MAXIMUM_ENTITIES)
                  : [],
                relation: shortText(person["relation"], 32),
                reverseRelation: shortText(person["reverseRelation"], 32),
                personId: knownPerson(person["personId"]),
                maybeSameAs: knownPerson(person["maybeSameAs"]),
              },
            ];
          })
          .slice(0, MAXIMUM_PEOPLE)
      : [];
    const personLinks: MemoryPersonLinkMention[] = Array.isArray(value["personLinks"])
      ? value["personLinks"]
          .filter(
            (link): link is Record<string, unknown> => typeof link === "object" && link !== null,
          )
          .flatMap((link) => {
            const from = shortText(link["from"], 64);
            const to = shortText(link["to"], 64);
            const relation = shortText(link["relation"], 32);
            return from && to && relation
              ? [{ from, to, relation, reverseRelation: shortText(link["reverseRelation"], 32) }]
              : [];
          })
          .slice(0, MAXIMUM_PEOPLE)
      : [];
    const inference = value["inference"] === true;
    const rawConfidence =
      typeof value["confidence"] === "number" && Number.isFinite(value["confidence"])
        ? Math.round(value["confidence"])
        : 0;
    const confidencePermille = Math.max(0, Math.min(inference ? 700 : 1000, rawConfidence));
    const reminder =
      dataClassification === "restricted"
        ? undefined
        : reminderSchedule(value["dueAt"], value["repeat"], input.sentAt, input.timeZone);
    const built: ExtractedMemoryCandidate = {
      kind,
      decision,
      existingMemoryId: decision === "create" ? null : existing,
      ...(supersedes ? { supersedes } : {}),
      text,
      dataClassification,
      confidencePermille,
      inference,
      sourceRefs: [input.sourceRef, ...(input.extraSourceRefs ?? [])],
      attributes: {
        category,
        importancePermille,
        entities,
        validFrom,
        validTo: null,
        supersededBy: null,
        evidenceVerified,
        ...(category === "rule" && value["explicit"] !== true ? { tentative: true } : {}),
        ...(subCategory ? { subCategory } : {}),
        ...(stance ? { stance } : {}),
      },
      ...(evidenceVerified && dataClassification !== "restricted"
        ? { quote: quote.trim().slice(0, MAXIMUM_QUOTE_CHARACTERS) }
        : {}),
      ...(reminder ? { reminder } : {}),
      ...(people.length ? { people } : {}),
      ...(personLinks.length ? { personLinks } : {}),
      ...(confirmsTentative
        ? {
            confirmsTentativeCategory:
              decision === "unchanged"
                ? (input.tentativeMemories?.get(existing)?.category ?? category)
                : category,
          }
        : {}),
      ...(dataClassification === "sensitive"
        ? {
            sensitiveTopic: (typeof value["topic"] === "string" && TOPICS.has(value["topic"])
              ? value["topic"]
              : "other") as SensitiveMemoryTopic,
          }
        : {}),
    };
    if (evidenceRejected) {
      unverifiedEvidence += 1;
      rejectedCandidates.push(built);
      continue;
    }
    if (value["explicit"] === true && explicitOrdinal === null && !inference)
      explicitOrdinal = candidates.length;
    candidates.push(built);
  }
  return {
    candidates,
    explicitOrdinal,
    unverifiedEvidence,
    rejectedCandidates,
    invalidCandidates,
    returnedNone: items.length === 0,
    supportChecks,
  };
}

function protectedText(
  options: Pick<ProductionMemoryCaptureOptions, "payloads" | "protector">,
  input: {
    readonly ref: string;
    readonly ownerId: RuntimeRequest["ownerId"];
    readonly agentId: RuntimeRequest["agentId"];
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly createdAt: string;
  },
) {
  return options.protector.protect({
    ownerId: input.ownerId,
    agentId: input.agentId,
    ref: input.ref,
    contentType: "text/plain",
    dataClassification: input.dataClassification,
    plaintext: new TextEncoder().encode(input.text),
    createdAt: input.createdAt,
  });
}

export function memoryCandidateRef(request: Pick<SensitiveMemoryApprovalRequest, "id">): string {
  return `memory-candidate:${request.id}`;
}

export function protectedMemoryCandidates(
  options: Pick<ProductionMemoryCaptureOptions, "payloads" | "protector" | "clock">,
): SensitiveMemoryCandidatePort {
  return {
    store: async ({ request, candidate }) => {
      const ref = memoryCandidateRef(request);
      if (await options.payloads.get(ref)) return;
      await options.payloads.put(
        await protectedText(options, {
          ref,
          ownerId: request.ownerId,
          agentId: request.agentId,
          text: JSON.stringify(candidate),
          dataClassification: request.dataClassification,
          createdAt: options.clock.now(),
        }),
      );
    },
    read: async (request) => {
      const payload = await options.payloads.get(memoryCandidateRef(request));
      if (!payload) return undefined;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await options.protector.unprotect({
          ownerId: request.ownerId,
          agentId: request.agentId,
          payload,
        }),
      );
      return JSON.parse(text) as ExtractedMemoryCandidate;
    },
  };
}

export function createProductionAutomaticMemory(
  options: Pick<
    ProductionMemoryCaptureOptions,
    "product" | "approvals" | "payloads" | "protector" | "clock" | "reminders" | "book" | "ledger"
  > & {
    readonly extract: () => Promise<readonly ExtractedMemoryCandidate[]>;
    readonly readSourceText: (sourceRef: string) => Promise<string>;
    readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  },
): AutomaticMemoryService {
  return new AutomaticMemoryService({
    extraction: { extract: options.extract },
    product: options.product,
    content: {
      store: async (stored) => {
        const ref = `memory-content:${stored.contentKey}`;
        if (await options.payloads.get(ref)) return ref;
        await options.payloads.put(
          await protectedText(options, {
            ref,
            ownerId: stored.ownerId,
            agentId: stored.agentId,
            text: stored.text,
            dataClassification: stored.dataClassification,
            createdAt: stored.createdAt,
          }),
        );
        return ref;
      },
    },
    approvals: options.approvals,
    candidates: protectedMemoryCandidates(options),
    audit: { record: async (record) => options.onAudit(record) },
    ...(options.ledger ? { ledger: options.ledger } : {}),
    readSourceText: options.readSourceText,
    now: () => options.clock.now(),
    memoryIdFor: (generation, ordinal) => createMemoryId(`memory:${generation}:${ordinal}`),
    approvalIdFor: (generation, ordinal) => `memory-approval:${generation}:${ordinal}`,
    ...(options.reminders || options.book
      ? {
          onCommitted: async ({ candidate, memoryId, ownerId, agentId }) => {
            const now = options.clock.now();
            if (candidate.reminder && options.reminders)
              await options.reminders.schedule({
                ...candidate.reminder,
                id: `reminder:${memoryId}`,
                ownerId,
                agentId,
                memoryId,
                status: "scheduled",
                dismissedAt: null,
                createdAt: now,
                updatedAt: now,
              });
            if (candidate.people?.length && options.book)
              await options.book.recordPeople({
                ownerId,
                agentId,
                memoryId,
                people: candidate.people,
                links: candidate.personLinks ?? [],
                now,
              });
          },
        }
      : {}),
  });
}

export interface MemoryCaptureCall {
  readonly invocationId: string;
  readonly retryToolCall: boolean;
  readonly maxOutputTokens?: number;
}

export interface ProductionMemoryCaptureOptions {
  readonly sources: RunExecutionSourcePort;
  readonly threads: Pick<ThreadRepositoryPort, "listMessages" | "readCommittedMessagesByIds">;
  readonly generations: Pick<ThreadDistillationStatePort, "request">;
  readonly state: Pick<ProductMemoryStatePort, "listActive" | "readMany">;
  readonly relevantMemoryIds?: (runId: RuntimeRequest["runId"]) => readonly MemoryId[];
  readonly externalOrigins?: (runId: RuntimeRequest["runId"]) => Promise<readonly string[]>;
  readonly product: IncrementalMemoryProductPort;
  readonly approvals: SensitiveMemoryApprovalStatePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly reminders?: Pick<MemoryReminderStorePort, "schedule">;
  readonly book?: Pick<
    MemoryBookStorePort,
    "readSettings" | "listSubCategories" | "listPeople" | "recordPeople"
  >;
  readonly timeZone?: string;
  readonly assertActive: () => Promise<void>;
  readonly externalTag: () => Promise<(kind: EgressPlaceholderKind, value: string) => string>;
  readonly generate: (
    request: RuntimeRequest,
    prompt: string,
    onAdmitted: () => void,
    call: MemoryCaptureCall,
  ) => Promise<string>;
  readonly backlog?: MemoryCaptureBacklogPort;
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledger?: DecisionLedgerPort;
  readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  readonly onFailure: (error: unknown) => void;
}

export const SAME_TURN_RETRYABLE_CAPTURE_ERRORS: ReadonlySet<string> = new Set([
  "AI_GATEWAY_TOOL_CALL_UNSUPPORTED",
  "AI_GATEWAY_REQUEST_TIMEOUT",
  "AI_GATEWAY_RATE_LIMITED",
  "AI_GATEWAY_PROVIDER_UNAVAILABLE",
  "AI_GATEWAY_EMPTY_RESPONSE",
  "PI_MODEL_STREAM_ERROR",
  "MEMORY_CAPTURE_RESPONSE_INVALID",
  "MEMORY_CAPTURE_RESPONSE_INCOMPLETE",
  "PORT_CONFLICT",
]);

const REPLAY_NOT_ATTEMPTED_ERRORS: ReadonlySet<string> = new Set([
  "MEMORY_CAPTURE_ADMISSION_UNAVAILABLE",
  "MEMORY_CAPTURE_MODEL_UNAVAILABLE",
]);

const UNKNOWN_CAPTURE_ERROR = "MEMORY_CAPTURE_FAILED";
const SAVE_PENDING_CODE = "MEMORY_CAPTURE_SAVE_PENDING";
const SAVE_ATTEMPTS_PER_TURN = 2;

export function captureErrorCode(error: unknown): string {
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : UNKNOWN_CAPTURE_ERROR;
}

function captureLedgerId(key: string): string {
  return `ledger:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

interface CapturePlan {
  readonly request: RuntimeRequest;
  readonly sourceRunId: RuntimeRequest["runId"];
  readonly threadId: NonNullable<RuntimeRequest["threadId"]>;
  readonly generationId: CommittedRunMemoryInput["generationId"];
  readonly message: string;
  readonly owner: ProductThreadMessage;
  readonly prompt: string;
  readonly existing: readonly ExistingMemoryText[];
  readonly subCategories: Record<string, string[]>;
  readonly people: readonly { readonly id: string }[];
  readonly committedAt: string | null;
  readonly externalSourceRefs: readonly string[];
  readonly input: Omit<
    CommittedRunMemoryInput,
    "explicitRememberCandidateOrdinal" | "rejectedCandidates"
  >;
  readonly audit: (outcome: MemoryExtractionAuditRecord["outcome"]) => void;
  tag?: (kind: EgressPlaceholderKind, value: string) => string;
}

export class ProductionMemoryCapture {
  readonly #pending = new Map<string, { work: Promise<void>; admitted: Promise<void> }>();
  readonly #captured = new Set<string>();
  readonly #busy = new Set<string>();
  readonly #supportCache = new SupportVerdictCache();
  readonly #settled = new Set<string>();
  #stopping = false;
  private readonly options: ProductionMemoryCaptureOptions;

  constructor(options: ProductionMemoryCaptureOptions) {
    this.options = options;
  }

  start(request: RuntimeRequest): Promise<void> {
    if (this.#stopping || !request.threadId || request.continuationRef || request.knownToolResult)
      return Promise.resolve();
    const id = request.runId;
    const pending = this.#pending.get(id);
    if (pending) return pending.admitted;
    if (this.#captured.has(id)) return Promise.resolve();
    this.#captured.add(id);
    if (this.#captured.size > 1000) {
      const oldest = this.#captured.values().next().value;
      if (oldest !== undefined) this.#captured.delete(oldest);
    }
    let onAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => {
      onAdmitted = resolve;
    });
    let onCaptureAdmitted = () => {};
    const captureAdmitted = new Promise<void>((resolve) => {
      onCaptureAdmitted = resolve;
    });
    const capture = this.#captureTurn(request, onCaptureAdmitted)
      .catch(this.options.onFailure)
      .finally(onCaptureAdmitted);
    const replay = captureAdmitted
      .then(() => this.#replayOne(request, onAdmitted))
      .catch(this.options.onFailure)
      .finally(onAdmitted);
    const work = Promise.all([capture, replay])
      .then(() => undefined)
      .finally(() => {
        onAdmitted();
        this.#pending.delete(id);
      });
    this.#pending.set(id, { work, admitted });
    return admitted;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#pending.values()].map(({ work }) => work));
  }

  async #readText(
    ref: string,
    ownerId: RuntimeRequest["ownerId"],
    agentId: RuntimeRequest["agentId"],
  ) {
    const payload = await this.options.payloads.get(ref);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.options.protector.unprotect({ ownerId, agentId, payload }),
    );
  }

  async #paused(request: RuntimeRequest): Promise<boolean> {
    return (
      this.options.book !== undefined &&
      (await this.options.book.readSettings({ ownerId: request.ownerId, agentId: request.agentId }))
        .capturePaused
    );
  }

  async #captureTurn(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    if (!request.threadId) return;
    const plan = await this.#plan(request, request.runId, request.threadId);
    if (!plan) return;
    const { backlog } = this.options;
    let parsed: ParsedMemoryCandidates;
    try {
      parsed = await this.#prepare(plan, onAdmitted, {
        invocationId: `memory-capture:${request.runId}`,
        retryToolCall: backlog === undefined,
      });
    } catch (first) {
      if (!backlog) throw first;
      this.#busy.add(plan.generationId);
      try {
        const retried = await this.#retryTurn(plan, request, backlog, first);
        if (retried) await this.#save(plan, retried);
      } finally {
        this.#busy.delete(plan.generationId);
      }
      return;
    }
    await this.#save(plan, parsed);
  }

  async #retryTurn(
    plan: CapturePlan,
    request: RuntimeRequest,
    backlog: MemoryCaptureBacklogPort,
    first: unknown,
  ): Promise<ParsedMemoryCandidates | undefined> {
    const queue = (lastErrorCode: string) =>
      backlog.enqueue({
        generationId: plan.generationId,
        ownerId: request.ownerId,
        agentId: request.agentId,
        threadId: plan.threadId,
        sourceRunId: plan.sourceRunId,
        lastErrorCode,
        createdAt: this.options.clock.now(),
      });
    const firstCode = captureErrorCode(first);
    await queue(firstCode);
    this.options.onFailure(first);
    if (!SAME_TURN_RETRYABLE_CAPTURE_ERRORS.has(firstCode)) {
      await this.#recordFailure(plan, "capture_queued", firstCode, "turn:1");
      return undefined;
    }
    await this.#recordFailure(plan, "capture_retrying", firstCode, "turn:1");
    try {
      return await this.#prepare(plan, () => {}, {
        invocationId: `memory-capture:${request.runId}:retry`,
        retryToolCall: false,
      });
    } catch (second) {
      const secondCode = captureErrorCode(second);
      await queue(secondCode);
      await this.#recordFailure(plan, "capture_queued", secondCode, "turn:2");
      throw second;
    }
  }

  async #save(plan: CapturePlan, parsed: ParsedMemoryCandidates): Promise<void> {
    const { backlog } = this.options;
    if (!backlog) {
      await this.#commit(plan, parsed);
      return;
    }
    if (parsed.candidates.length === 0 && parsed.rejectedCandidates.length === 0) {
      await this.#commit(plan, parsed);
      await this.#settle(plan.generationId);
      return;
    }
    const owned = !this.#busy.has(plan.generationId);
    if (owned) this.#busy.add(plan.generationId);
    try {
      if (!(await backlog.has(plan.generationId).catch(() => false)))
        await backlog.enqueue({
          generationId: plan.generationId,
          ownerId: plan.request.ownerId,
          agentId: plan.request.agentId,
          threadId: plan.threadId,
          sourceRunId: plan.sourceRunId,
          lastErrorCode: SAVE_PENDING_CODE,
          createdAt: this.options.clock.now(),
        });
      let failure: unknown;
      const held: MemoryExtractionAuditRecord[] = [];
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS_PER_TURN; attempt += 1) {
        try {
          await this.#commit(plan, parsed, held);
          return;
        } catch (error) {
          failure = error;
          const state = await backlog.has(plan.generationId).then(
            (queued) => (queued ? "queued" : "gone"),
            () => "unknown",
          );
          if (state === "gone") {
            this.#emitAudits(held);
            return;
          }
          if (state === "unknown") break;
        }
      }
      const code = captureErrorCode(failure);
      const attempts = await backlog
        .recordAttempt({
          generationId: plan.generationId,
          errorCode: code,
          updatedAt: this.options.clock.now(),
        })
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === "PORT_NOT_FOUND") return 0;
          throw error;
        });
      if (attempts === 0) {
        this.#emitAudits(held);
        return;
      }
      const gaveUp = attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS;
      if (gaveUp) await this.#settle(plan.generationId);
      await this.#recordFailure(
        plan,
        gaveUp ? "capture_gave_up" : "capture_queued",
        code,
        `save:${attempts}`,
      ).catch(this.options.onFailure);
      throw failure;
    } finally {
      if (owned) this.#busy.delete(plan.generationId);
    }
  }

  async #settle(generationId: string): Promise<void> {
    try {
      await this.options.backlog?.remove(generationId);
      this.#settled.delete(generationId);
    } catch (error) {
      this.#settled.add(generationId);
      if (this.#settled.size > 1000) {
        const oldest = this.#settled.values().next().value;
        if (oldest !== undefined) this.#settled.delete(oldest);
      }
      this.options.onFailure(error);
    }
  }

  async #replayOne(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    const { backlog } = this.options;
    if (!backlog || this.#stopping || (await this.#paused(request))) return;
    const entry = await backlog.oldest({
      ownerId: request.ownerId,
      agentId: request.agentId,
      excludeGenerationId: `memory-capture:${request.runId}`,
    });
    if (!entry || this.#busy.has(entry.generationId)) return;
    this.#busy.add(entry.generationId);
    try {
      if (
        this.#settled.has(entry.generationId) ||
        entry.attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS
      ) {
        await backlog.remove(entry.generationId);
        this.#settled.delete(entry.generationId);
        return;
      }
      const plan = await this.#plan(request, entry.sourceRunId, entry.threadId);
      if (!plan || plan.generationId !== entry.generationId) {
        await backlog.remove(entry.generationId);
        return;
      }
      let parsed: ParsedMemoryCandidates;
      try {
        parsed = await this.#prepare(plan, onAdmitted, {
          invocationId: `memory-capture:${request.runId}:backlog`,
          retryToolCall: false,
        });
      } catch (error) {
        const code = captureErrorCode(error);
        if (REPLAY_NOT_ATTEMPTED_ERRORS.has(code)) throw error;
        const attempts = await backlog.recordAttempt({
          generationId: entry.generationId,
          errorCode: code,
          updatedAt: this.options.clock.now(),
        });
        const gaveUp = attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS;
        if (gaveUp) await this.#settle(entry.generationId);
        await this.#recordFailure(
          plan,
          gaveUp ? "capture_gave_up" : "capture_queued",
          code,
          `backlog:${attempts}`,
        );
        throw error;
      }
      await this.#save(plan, parsed);
    } finally {
      this.#busy.delete(entry.generationId);
    }
  }

  async #recordFailure(
    plan: CapturePlan,
    outcome: MemoryCaptureFailureOutcome,
    errorCode: string,
    attempt: string,
  ): Promise<void> {
    if (!this.options.ledger) return;
    await this.options.ledger.append({
      id: captureLedgerId(`${plan.generationId}:${outcome}:${attempt}`),
      ownerId: plan.request.ownerId,
      agentId: plan.request.agentId,
      kind: "memory_candidate",
      decidedAt: this.options.clock.now(),
      outcome,
      reasonCode: errorCode.slice(0, 64),
      subjectRef: plan.generationId,
      inputs: { memoryIds: [], ruleIds: [] },
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: 0,
    });
  }

  async #plan(
    request: RuntimeRequest,
    sourceRunId: RuntimeRequest["runId"],
    threadId: NonNullable<RuntimeRequest["threadId"]>,
  ): Promise<CapturePlan | undefined> {
    const { ownerId, agentId } = request;
    const source = await this.options.sources.read(sourceRunId);
    if (!source || source.sourceType !== "user_message" || source.threadId !== threadId) return;
    if (await this.#paused(request)) return;
    const message = await this.#readText(source.payloadRef, ownerId, agentId);
    if (!message || message.trim().length < 2) return;
    const [owner] = await this.options.threads.readCommittedMessagesByIds({
      ownerId,
      agentId,
      threadId,
      messageIds: [source.sourceId as MessageId],
    });
    if (
      !owner ||
      owner.role !== "owner" ||
      owner.internal === true ||
      owner.contentRef !== source.payloadRef
    )
      return;
    const messages = await this.options.threads.listMessages(
      ownerId,
      agentId,
      threadId,
      Math.max(0, owner.sequence - 51),
      50,
    );
    const allowed = (classification: DataClassification) =>
      CLASSIFICATION_RANK[classification] <= CLASSIFICATION_RANK[source.dataClassification];
    const previous = messages
      .filter(
        (item) =>
          item.role === "agent" &&
          item.status === "committed" &&
          item.sequence < owner.sequence &&
          allowed(item.dataClassification),
      )
      .sort((left, right) => right.sequence - left.sequence)[0];
    const previousAssistantMessage = previous
      ? ((await this.#readText(previous.contentRef, ownerId, agentId).catch(() => undefined)) ??
        null)
      : null;
    const relevantIds = (this.options.relevantMemoryIds?.(sourceRunId) ?? []).slice(
      0,
      MAXIMUM_RELEVANT_MEMORIES,
    );
    const relevant =
      relevantIds.length === 0
        ? []
        : await this.options.state.readMany({ ownerId, agentId, memoryIds: relevantIds });
    const recent = confirmedFirstByRecency(
      await this.options.state.listActive(ownerId, agentId),
    ).slice(0, MAXIMUM_RECENT_MEMORIES);
    const seen = new Set<string>();
    const existing: ExistingMemoryText[] = [];
    for (const memory of [...relevant, ...recent]) {
      if (
        seen.has(memory.id) ||
        memory.status !== "active" ||
        !allowed(memory.dataClassification) ||
        (memory.attributes?.supersededBy ?? null) !== null
      )
        continue;
      seen.add(memory.id);
      const text = await this.#readText(memory.contentRef, ownerId, agentId).catch(() => undefined);
      if (text)
        existing.push({
          id: memory.id,
          text,
          stance: memory.attributes?.stance ?? null,
          tentative: memory.attributes?.tentative === true,
          category: memory.attributes?.category ?? DEFAULT_MEMORY_ATTRIBUTES.category,
        });
    }
    const subCategories: Record<string, string[]> = {};
    for (const { category, subCategory } of (await this.options.book?.listSubCategories({
      ownerId,
      agentId,
    })) ?? [])
      subCategories[category] = [...(subCategories[category] ?? []), subCategory];
    const people = ((await this.options.book?.listPeople({ ownerId, agentId })) ?? [])
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAXIMUM_KNOWN_PEOPLE)
      .map(({ id, name, aliases, relation }) => ({ id, name, aliases, relation }));
    const generationId = createMemoryGenerationId(`memory-capture:${sourceRunId}`);
    const input = {
      ownerId,
      agentId,
      runId: sourceRunId,
      threadId,
      generationId,
      sourceRef: source.payloadRef,
      sourceClassification: source.dataClassification,
      policyVersion: MEMORY_CAPTURE_POLICY_VERSION,
      modelDescriptorRef: request.modelRef,
      interactive: true,
    };
    const audit = (outcome: MemoryExtractionAuditRecord["outcome"]) =>
      this.options.onAudit({
        ownerId,
        agentId,
        threadId,
        sourceRef: input.sourceRef,
        generationId,
        policyVersion: input.policyVersion,
        modelDescriptorRef: input.modelDescriptorRef,
        candidateOrdinal: null,
        classification: input.sourceClassification,
        outcome,
        secretFindings: [],
        occurredAt: this.options.clock.now(),
      });
    return {
      request: { ...request, dataClassification: source.dataClassification },
      sourceRunId,
      threadId,
      generationId,
      message,
      owner,
      prompt: memoryCapturePrompt(
        message,
        existing,
        previousAssistantMessage,
        owner.committedAt,
        this.options.timeZone ?? "UTC",
        { subCategories, people },
      ),
      existing,
      subCategories,
      people,
      committedAt: owner.committedAt,
      externalSourceRefs: externalContentSourceRefs(
        source.payloadRef,
        (await this.options.externalOrigins?.(sourceRunId)) ?? [],
      ),
      input,
      audit,
    };
  }

  async #judgeSupport(
    plan: CapturePlan,
    call: MemoryCaptureCall,
    checks: readonly SupportCheck[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const verdicts = new Map<string, boolean>();
    for (const [index, check] of checks.entries()) {
      const known = this.#supportCache.get(check, plan.request.dataClassification);
      if (known !== undefined) {
        verdicts.set(check.key, known);
        continue;
      }
      const prompt = memoryConfirmationJudgePrompt(check.memoryText, check.quote);
      let settled = true;
      const verdict = await judgeOrDefault(
        {
          ask: (attempt) =>
            this.options.generate(plan.request, prompt, () => {}, {
              invocationId: `${call.invocationId}:support:${index}:${attempt}`,
              retryToolCall: false,
            }),
          parse: parseSupportVerdict,
        },
        false,
        (error) => {
          settled = false;
          this.options.onFailure(error);
        },
      );
      if (settled) this.#supportCache.set(check, plan.request.dataClassification, verdict);
      verdicts.set(check.key, verdict);
    }
    return verdicts;
  }

  async #extract(
    plan: CapturePlan,
    onAdmitted: () => void,
    call: MemoryCaptureCall,
  ): Promise<ParsedMemoryCandidates> {
    try {
      await this.options.assertActive();
      plan.tag ??= await this.options.externalTag();
      const output = await this.options.generate(plan.request, plan.prompt, onAdmitted, call);
      const table = placeholderTable(plan.prompt, plan.tag, {
        trusted: TRUSTED_PROMPT_TEXTS,
        jsonEmbedded: true,
      });
      const { existing } = plan;
      const parseWith = (supportVerdicts: ReadonlyMap<string, boolean>) =>
        parseMemoryCandidates({
          output,
          sourceRef: plan.input.sourceRef,
          extraSourceRefs: plan.externalSourceRefs,
          sourceClassification: plan.input.sourceClassification,
          existingIds: new Set(existing.map(({ id }) => id)),
          tentativeMemories: new Map(
            existing
              .filter(({ tentative }) => tentative)
              .map(({ id, text, category }) => [
                id,
                { text, category: category ?? DEFAULT_MEMORY_ATTRIBUTES.category },
              ]),
          ),
          supportVerdicts,
          ownerMessage: plan.message,
          ...(plan.committedAt ? { sentAt: plan.committedAt } : {}),
          timeZone: this.options.timeZone ?? "UTC",
          subCategories: plan.subCategories,
          knownPersonIds: new Set(plan.people.map(({ id }) => id)),
          restore: (text: string) => restorePlaceholders(text, table),
        });
      const first = parseWith(new Map());
      if (first.supportChecks.length === 0) return first;
      return parseWith(await this.#judgeSupport(plan, call, first.supportChecks));
    } catch (error) {
      plan.audit("extraction_failed");
      throw error;
    }
  }

  async #prepare(
    plan: CapturePlan,
    onAdmitted: () => void,
    call: MemoryCaptureCall,
  ): Promise<ParsedMemoryCandidates> {
    const parsed = await this.#extract(plan, onAdmitted, call);
    const { owner } = plan;
    const { ownerId, agentId } = plan.request;
    if (parsed.candidates.length === 0 && parsed.rejectedCandidates.length === 0) return parsed;
    await this.options.assertActive();
    if (parsed.candidates.length > 0)
      await this.options.generations.request({
        jobId: createCheckpointJobId(`checkpoint:memory-capture:${plan.sourceRunId}`),
        generationId: plan.generationId,
        ownerId,
        agentId,
        threadId: plan.threadId,
        sourceWatermark: owner.sequence,
        policyVersion: MEMORY_CAPTURE_POLICY_VERSION,
        modelDescriptorRef: plan.request.modelRef,
        trigger: "controlled_idle",
        summaryRef: null,
        summaryClassification: null,
        status: "pending",
        revision: 1,
        attemptCount: 0,
        nextRetryAt: null,
        claimedBy: null,
        claimExpiresAt: null,
        sources: [
          {
            ref: owner.id,
            sequence: owner.sequence,
            kind: "message",
            dataClassification: owner.dataClassification,
          },
        ],
        requestedAt: this.options.clock.now(),
        errorCode: null,
      });
    return parsed;
  }

  #emitAudits(records: readonly MemoryExtractionAuditRecord[]): void {
    for (const record of records)
      try {
        this.options.onAudit(record);
      } catch (error) {
        try {
          this.options.onFailure(error);
        } catch {}
      }
  }

  async #commit(
    plan: CapturePlan,
    parsed: ParsedMemoryCandidates,
    audits: MemoryExtractionAuditRecord[] = [],
  ): Promise<void> {
    const { input } = plan;
    audits.length = 0;
    const note = (outcome: MemoryExtractionAuditRecord["outcome"]) =>
      audits.push({
        ownerId: input.ownerId,
        agentId: input.agentId,
        threadId: input.threadId,
        sourceRef: input.sourceRef,
        generationId: input.generationId,
        policyVersion: input.policyVersion,
        modelDescriptorRef: input.modelDescriptorRef,
        candidateOrdinal: null,
        classification: input.sourceClassification,
        outcome,
        secretFindings: [],
        occurredAt: this.options.clock.now(),
      });
    for (let index = 0; index < parsed.unverifiedEvidence; index += 1) note("evidence_unverified");
    for (let index = 0; index < parsed.invalidCandidates; index += 1) note("candidate_invalid");
    if (parsed.returnedNone) note("nothing_to_remember");
    if (parsed.candidates.length > 0 || parsed.rejectedCandidates.length > 0) {
      const service = createProductionAutomaticMemory({
        ...this.options,
        extract: async () => parsed.candidates,
        readSourceText: async () => plan.message,
        onAudit: (record) => {
          audits.push(record);
        },
      });
      const { backlog } = this.options;
      await this.options.unitOfWork.run(async () => {
        await service.processCommittedRun({
          ...input,
          explicitRememberCandidateOrdinal: parsed.explicitOrdinal,
          rejectedCandidates: parsed.rejectedCandidates,
        });
        await backlog?.remove(plan.generationId);
      });
    }
    this.#emitAudits(audits);
  }
}
