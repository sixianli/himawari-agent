import {
  AutomaticMemoryService,
  type ClockPort,
  type CommittedRunMemoryInput,
  type DataClassification,
  type DecisionLedgerPort,
  type ExtractedMemoryCandidate,
  type IncrementalMemoryProductPort,
  MEMORY_CATEGORIES,
  type MemoryBookStorePort,
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
  scanMachineSecrets,
  type ThreadDistillationStatePort,
  type ThreadDistillationWork,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import { localDayStart } from "@himawari-agent/memory-engine";
import { MEMORY_CAPTURE } from "@himawari-agent/prompt-catalog";

type MemoryId = NonNullable<ExtractedMemoryCandidate["existingMemoryId"]>;
const createMemoryId = (value: string) => value as MemoryId;
const createMemoryGenerationId = (value: string) =>
  value as CommittedRunMemoryInput["generationId"];
const createCheckpointJobId = (value: string) => value as ThreadDistillationWork["jobId"];

export const MEMORY_CAPTURE_POLICY_VERSION = "memory-capture:v5";
const MAXIMUM_SOURCE_CHARACTERS = 6000;
const MAXIMUM_RECENT_MEMORIES = 20;
const MAXIMUM_RELEVANT_MEMORIES = 10;
const MAXIMUM_CONTEXT_CHARACTERS = 1500;
const MAXIMUM_CANDIDATES = 8;
const MAXIMUM_MEMORY_CHARACTERS = 500;
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
const MAXIMUM_REMINDER_HORIZON = 2 * 366 * 24 * HOUR;
const RESTRICTED_IDENTIFIER =
  /(?<![0-9])(?:[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]|[0-9]{16,19})(?![0-9])/u;

export function containsRestrictedIdentifier(text: string): boolean {
  return RESTRICTED_IDENTIFIER.test(text.replace(/[\s-]/gu, ""));
}

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
    for (let years = 1; years <= 2 && resolved.due <= sent; years += 1) {
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
  readonly sourceClassification: DataClassification;
  readonly existingIds: ReadonlySet<string>;
  readonly ownerMessage?: string;
  readonly sentAt?: string;
  readonly timeZone?: string;
  readonly subCategories?: Readonly<Record<string, readonly string[]>>;
  readonly knownPersonIds?: ReadonlySet<string>;
}): ParsedMemoryCandidates {
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
  for (const item of items.slice(0, MAXIMUM_CANDIDATES)) {
    if (typeof item !== "object" || item === null) {
      invalidCandidates += 1;
      continue;
    }
    const value = item as Record<string, unknown>;
    const text = typeof value["text"] === "string" ? value["text"].trim() : "";
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
    const requested = containsRestrictedIdentifier(text)
      ? "restricted"
      : value["classification"] === "sensitive" || value["classification"] === "restricted"
        ? value["classification"]
        : "private";
    const dataClassification =
      CLASSIFICATION_RANK[requested] >= CLASSIFICATION_RANK[input.sourceClassification]
        ? requested
        : input.sourceClassification;
    const quote = typeof value["quote"] === "string" ? value["quote"] : "";
    const evidenceVerified =
      input.ownerMessage !== undefined && quoteFromOwnerMessage(quote, input.ownerMessage);
    const evidenceRejected =
      input.ownerMessage !== undefined &&
      decision !== "unchanged" &&
      dataClassification !== "restricted" &&
      !evidenceVerified;
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
              .filter((entity) => entity.length > 0 && entity.length <= 64),
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
      sourceRefs: [input.sourceRef],
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

export interface ProductionMemoryCaptureOptions {
  readonly sources: RunExecutionSourcePort;
  readonly threads: Pick<ThreadRepositoryPort, "read" | "listMessages">;
  readonly generations: Pick<ThreadDistillationStatePort, "request">;
  readonly state: Pick<ProductMemoryStatePort, "listActive" | "readMany">;
  readonly relevantMemoryIds?: (runId: RuntimeRequest["runId"]) => readonly MemoryId[];
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
  readonly generate: (
    request: RuntimeRequest,
    prompt: string,
    onAdmitted: () => void,
  ) => Promise<string>;
  readonly ledger?: DecisionLedgerPort;
  readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  readonly onFailure: (error: unknown) => void;
}

export class ProductionMemoryCapture {
  readonly #pending = new Map<string, { work: Promise<void>; admitted: Promise<void> }>();
  readonly #captured = new Set<string>();
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
    const work = this.#capture(request, onAdmitted)
      .catch(this.options.onFailure)
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

  async #capture(request: RuntimeRequest, onAdmitted: () => void): Promise<void> {
    const { ownerId, agentId, runId, threadId } = request;
    if (!threadId) return;
    const source = await this.options.sources.read(runId);
    if (!source || source.sourceType !== "user_message" || source.threadId !== threadId) return;
    if (
      this.options.book &&
      (await this.options.book.readSettings({ ownerId, agentId })).capturePaused
    )
      return;
    const message = await this.#readText(source.payloadRef, ownerId, agentId);
    if (!message || message.trim().length < 2) return;
    const thread = await this.options.threads.read(ownerId, agentId, threadId);
    if (!thread) return;
    const messages = await this.options.threads.listMessages(
      ownerId,
      agentId,
      threadId,
      Math.max(0, thread.messageWatermark - 50),
      50,
    );
    const owner = messages.find(
      (item) => item.role === "owner" && item.contentRef === source.payloadRef,
    );
    if (!owner) return;
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
    const relevantIds = (this.options.relevantMemoryIds?.(runId) ?? []).slice(
      0,
      MAXIMUM_RELEVANT_MEMORIES,
    );
    const relevant =
      relevantIds.length === 0
        ? []
        : await this.options.state.readMany({ ownerId, agentId, memoryIds: relevantIds });
    const recent = [...(await this.options.state.listActive(ownerId, agentId))]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAXIMUM_RECENT_MEMORIES);
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
      if (text) existing.push({ id: memory.id, text, stance: memory.attributes?.stance ?? null });
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
    const generationId = createMemoryGenerationId(`memory-capture:${runId}`);
    const input = {
      ownerId,
      agentId,
      runId,
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
    let parsed: ParsedMemoryCandidates = {
      candidates: [],
      explicitOrdinal: null,
      unverifiedEvidence: 0,
      rejectedCandidates: [],
      invalidCandidates: 0,
      returnedNone: false,
    };
    if (scanMachineSecrets(message).length === 0) {
      try {
        await this.options.assertActive();
        const output = await this.options.generate(
          { ...request, dataClassification: source.dataClassification },
          memoryCapturePrompt(
            message,
            existing,
            previousAssistantMessage,
            owner.committedAt,
            this.options.timeZone ?? "UTC",
            { subCategories, people },
          ),
          onAdmitted,
        );
        parsed = parseMemoryCandidates({
          output,
          sourceRef: source.payloadRef,
          sourceClassification: source.dataClassification,
          existingIds: new Set(existing.map(({ id }) => id)),
          ownerMessage: message,
          ...(owner.committedAt ? { sentAt: owner.committedAt } : {}),
          timeZone: this.options.timeZone ?? "UTC",
          subCategories,
          knownPersonIds: new Set(people.map(({ id }) => id)),
        });
      } catch (error) {
        audit("extraction_failed");
        throw error;
      }
      for (let index = 0; index < parsed.unverifiedEvidence; index += 1)
        audit("evidence_unverified");
      for (let index = 0; index < parsed.invalidCandidates; index += 1) audit("candidate_invalid");
      if (parsed.returnedNone) audit("nothing_to_remember");
      if (parsed.candidates.length === 0 && parsed.rejectedCandidates.length === 0) return;
      await this.options.assertActive();
      if (parsed.candidates.length > 0)
        await this.options.generations.request({
          jobId: createCheckpointJobId(`checkpoint:memory-capture:${runId}`),
          generationId,
          ownerId,
          agentId,
          threadId,
          sourceWatermark: owner.sequence,
          policyVersion: MEMORY_CAPTURE_POLICY_VERSION,
          modelDescriptorRef: request.modelRef,
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
    }
    const service = createProductionAutomaticMemory({
      ...this.options,
      extract: async () => parsed.candidates,
      readSourceText: async () => message,
      onAudit: this.options.onAudit,
    });
    await service.processCommittedRun({
      ...input,
      explicitRememberCandidateOrdinal: parsed.explicitOrdinal,
      rejectedCandidates: parsed.rejectedCandidates,
    });
  }
}
