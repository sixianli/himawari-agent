import { createHash } from "node:crypto";
import {
  type ClockPort,
  type CommittedRunMemoryInput,
  type DataClassification,
  DEFAULT_MEMORY_ATTRIBUTES,
  type DecisionLedgerPort,
  type ExtractedMemoryCandidate,
  type IncrementalMemoryProductPort,
  isModelVisible,
  MEMORY_CONVERSATION_REVIEW_MAX_ATTEMPTS,
  type MemoryBookStorePort,
  type MemoryConversationReview,
  type MemoryConversationReviewChange,
  type MemoryConversationReviewStorePort,
  type MemoryEpisode,
  type MemoryEpisodeStorePort,
  type MemoryReminderStorePort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  type RuntimeRequest,
  type SensitiveMemoryApprovalStatePort,
  type ThreadDistillationStatePort,
  type ThreadDistillationWork,
  type ThreadRepositoryPort,
} from "@himawari-agent/application";
import { localDay, replacesOlder, statedAt } from "@himawari-agent/memory-engine";
import {
  MEMORY_CONVERSATION_REVIEW,
  MEMORY_CONVERSATION_REVIEW_DAY,
  renderPrompt,
  TRUSTED_PROMPT_TEXTS,
} from "@himawari-agent/prompt-catalog";
import {
  type EgressPlaceholderKind,
  placeholderTable,
  restorePlaceholders,
} from "@himawari-agent/sensitive-capture";
import { judgeOrDefault } from "./auxiliary-judgment.js";
import {
  captureErrorCode,
  createProductionAutomaticMemory,
  type MemoryCaptureCall,
  memoryConfirmationJudgePrompt,
  type ParsedMemoryCandidates,
  parseMemoryCandidates,
  parseSupportVerdict,
  type SupportCheck,
  SupportVerdictCache,
} from "./production-memory-capture.js";
import { externalContentSourceRefs } from "./context-external-content.js";

type MemoryId = ProductMemoryRecord["id"];
type ProductThreadMessage = Awaited<ReturnType<ThreadRepositoryPort["listMessages"]>>[number];
type MemoryGenerationId = CommittedRunMemoryInput["generationId"];

export const MEMORY_CONVERSATION_REVIEW_POLICY_VERSION = "memory-conversation-review:v1";
const MAXIMUM_MESSAGE_CHARACTERS = 1500;
const MAXIMUM_QUERY_CHARACTERS = 2000;
const MAXIMUM_SEGMENT_MESSAGES = 120;
const MAXIMUM_REVIEW_CANDIDATES = 24;
const MAXIMUM_KNOWN_PEOPLE = 40;
const ID_DIGEST_LENGTH = 32;
const ATTEMPT_INTERVAL_MS = 10 * 60_000;
const NEVER_INFERRED = new Set(["health", "finance"]);
const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
};

export interface ConversationReviewSettings {
  readonly enabled: boolean;
  readonly maximumSegmentsPerDay: number;
  readonly maximumSourceCharacters: number;
  readonly maximumRelatedMemories: number;
  readonly maximumNewMemoriesPerDay: number;
  readonly maximumOutputTokens: number;
}

export const DEFAULT_CONVERSATION_REVIEW_SETTINGS: ConversationReviewSettings = Object.freeze({
  enabled: true,
  maximumSegmentsPerDay: 3,
  maximumSourceCharacters: 16000,
  maximumRelatedMemories: 30,
  maximumNewMemoriesPerDay: 5,
  maximumOutputTokens: 1024,
});

function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, ID_DIGEST_LENGTH);
}

export function conversationReviewId(episodeId: string): string {
  return `memory-review:${digest(episodeId)}`;
}

export function conversationReviewGenerationId(
  episodeId: string,
  messageId: string,
): MemoryGenerationId {
  return `memory-review:${digest(episodeId, messageId)}` as MemoryGenerationId;
}

export interface ReviewMessage {
  readonly id: string;
  readonly role: "owner" | "agent";
  readonly messageSentAt: string;
  readonly text: string;
}

export interface ReviewExistingMemory {
  readonly id: MemoryId;
  readonly recordedOn: string;
  readonly text: string;
  readonly stance: string | null;
  readonly tentative: boolean;
}

export function conversationReviewPrompt(input: {
  readonly messages: readonly ReviewMessage[];
  readonly existing: readonly ReviewExistingMemory[];
  readonly subCategories: Readonly<Record<string, readonly string[]>>;
  readonly people: readonly unknown[];
  readonly timeZone: string;
  readonly day: string;
}): string {
  return [
    MEMORY_CONVERSATION_REVIEW.text,
    JSON.stringify({
      existingMemories: input.existing.map(({ id, recordedOn, text, stance, tentative }) => ({
        id,
        recordedOn,
        text,
        stance,
        tentative,
      })),
      existingSubCategories: input.subCategories,
      knownPeople: input.people.slice(0, MAXIMUM_KNOWN_PEOPLE),
      ownerTimeZone: input.timeZone,
      messages: input.messages.map(({ id, role, messageSentAt, text }) => ({
        id,
        role,
        messageSentAt,
        text,
      })),
    }),
    renderPrompt(MEMORY_CONVERSATION_REVIEW_DAY, { day: input.day }),
  ].join("\n");
}

export interface ReviewSourceMessage {
  readonly message: ProductThreadMessage;
  readonly text: string;
}

export interface ReviewMessageCandidates {
  readonly source: ReviewSourceMessage;
  readonly parsed: ParsedMemoryCandidates;
}

export interface ParsedConversationReview {
  readonly groups: readonly ReviewMessageCandidates[];
  readonly skipped: Readonly<Record<ReviewSkipReason, number>>;
  readonly supportChecks: readonly SupportCheck[];
}

export type ReviewSkipReason =
  | "invalid"
  | "unknown_message"
  | "pattern_single_day"
  | "sensitive"
  | "inferred_private_topic"
  | "not_a_change"
  | "daily_limit";

function jsonObject(output: string): unknown {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("MEMORY_CONVERSATION_REVIEW_RESPONSE_INVALID");
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error("MEMORY_CONVERSATION_REVIEW_RESPONSE_INVALID");
  }
}

function sensitive(candidate: ExtractedMemoryCandidate): boolean {
  return (
    candidate.dataClassification === "sensitive" || candidate.dataClassification === "restricted"
  );
}

export function parseConversationReview(input: {
  readonly output: string;
  readonly messages: readonly ReviewSourceMessage[];
  readonly existing: readonly (ReviewExistingMemory & {
    readonly memory: ProductMemoryRecord;
  })[];
  readonly timeZone: string;
  readonly subCategories?: Readonly<Record<string, readonly string[]>>;
  readonly knownPersonIds?: ReadonlySet<string>;
  readonly newMemoriesAllowed: number;
  readonly restore?: (text: string) => string;
  readonly supportVerdicts?: ReadonlyMap<string, boolean>;
  readonly externalOrigins?: readonly string[];
}): ParsedConversationReview {
  const parsed = jsonObject(input.output);
  if (typeof parsed !== "object" || parsed === null || !("memories" in parsed))
    throw new Error("MEMORY_CONVERSATION_REVIEW_RESPONSE_INVALID");
  const items = (parsed as { memories: unknown }).memories;
  if (!Array.isArray(items)) throw new Error("MEMORY_CONVERSATION_REVIEW_RESPONSE_INVALID");
  const skipped: Record<ReviewSkipReason, number> = {
    invalid: 0,
    unknown_message: 0,
    pattern_single_day: 0,
    sensitive: 0,
    inferred_private_topic: 0,
    not_a_change: 0,
    daily_limit: 0,
  };
  const owners = new Map(
    input.messages
      .filter(({ message }) => message.role === "owner")
      .map((source) => [source.message.id as string, source]),
  );
  const existing = new Map(input.existing.map((entry) => [entry.id as string, entry]));
  const byMessage = new Map<string, Record<string, unknown>[]>();
  for (const item of items.slice(0, MAXIMUM_REVIEW_CANDIDATES)) {
    if (typeof item !== "object" || item === null) {
      skipped.invalid += 1;
      continue;
    }
    const { messageId, pattern, alsoSeenIn, ...rest } = item as Record<string, unknown>;
    const source = typeof messageId === "string" ? owners.get(messageId) : undefined;
    if (!source) {
      skipped.unknown_message += 1;
      continue;
    }
    if (rest["decision"] === "update" || rest["decision"] === "merge") {
      skipped.invalid += 1;
      continue;
    }
    if (pattern === true) {
      const sourceDay = localDay(source.message.committedAt, input.timeZone);
      const otherDays = (Array.isArray(alsoSeenIn) ? alsoSeenIn : []).filter((id) => {
        const memory = typeof id === "string" ? existing.get(id) : undefined;
        return memory !== undefined && memory.recordedOn !== sourceDay;
      });
      if (otherDays.length === 0) {
        skipped.pattern_single_day += 1;
        continue;
      }
    }
    byMessage.set(source.message.id, [...(byMessage.get(source.message.id) ?? []), rest]);
  }
  const tentativeMemories = new Map(
    input.existing
      .filter(({ tentative }) => tentative)
      .map(({ id, text, memory }) => [
        id as string,
        {
          text,
          category: memory.attributes?.category ?? DEFAULT_MEMORY_ATTRIBUTES.category,
        },
      ]),
  );
  let newAllowed = Math.max(0, input.newMemoriesAllowed);
  const groups: ReviewMessageCandidates[] = [];
  const supportChecks: SupportCheck[] = [];
  for (const source of input.messages) {
    const raw = byMessage.get(source.message.id);
    if (!raw) continue;
    const parsedGroup = parseMemoryCandidates({
      output: JSON.stringify({ memories: raw }),
      sourceRef: source.message.contentRef,
      extraSourceRefs: externalContentSourceRefs(
        source.message.contentRef,
        input.externalOrigins ?? [],
      ),
      sourceClassification: source.message.dataClassification,
      existingIds: new Set(existing.keys()),
      tentativeMemories,
      ownerMessage: source.text,
      sentAt: source.message.committedAt,
      timeZone: input.timeZone,
      ...(input.supportVerdicts ? { supportVerdicts: input.supportVerdicts } : {}),
      ...(input.subCategories ? { subCategories: input.subCategories } : {}),
      ...(input.knownPersonIds ? { knownPersonIds: input.knownPersonIds } : {}),
      ...(input.restore ? { restore: input.restore } : {}),
    });
    skipped.invalid += parsedGroup.invalidCandidates;
    supportChecks.push(...parsedGroup.supportChecks);
    const kept: ExtractedMemoryCandidate[] = [];
    for (const candidate of parsedGroup.candidates) {
      if (sensitive(candidate)) {
        skipped.sensitive += 1;
        continue;
      }
      if (candidate.inference && NEVER_INFERRED.has(candidate.attributes?.category ?? "")) {
        skipped.inferred_private_topic += 1;
        continue;
      }
      if (candidate.decision !== "create" && candidate.confirmsTentativeCategory === undefined) {
        skipped.not_a_change += 1;
        continue;
      }
      if (candidate.decision === "create") {
        if (newAllowed === 0) {
          skipped.daily_limit += 1;
          continue;
        }
        newAllowed -= 1;
      }
      kept.push(withReplacementRule(candidate, source, existing));
    }
    const rejected = parsedGroup.rejectedCandidates.filter((candidate) => !sensitive(candidate));
    if (kept.length === 0 && rejected.length === 0) continue;
    groups.push({
      source,
      parsed: {
        ...parsedGroup,
        candidates: kept,
        rejectedCandidates: rejected,
        explicitOrdinal: null,
      },
    });
  }
  return { groups, skipped, supportChecks };
}

function withReplacementRule(
  candidate: ExtractedMemoryCandidate,
  source: ReviewSourceMessage,
  existing: ReadonlyMap<string, { readonly memory: ProductMemoryRecord }>,
): ExtractedMemoryCandidate {
  if (!candidate.supersedes) return candidate;
  const older = existing.get(candidate.supersedes)?.memory;
  if (
    older &&
    replacesOlder(older, {
      statedAt: candidate.attributes?.validFrom ?? source.message.committedAt,
      confidencePermille: candidate.confidencePermille,
      category: candidate.attributes?.category ?? null,
    })
  )
    return candidate;
  const { supersedes: _held, ...rest } = candidate;
  return {
    ...rest,
    attributes: {
      ...(candidate.attributes ?? DEFAULT_MEMORY_ATTRIBUTES),
      tentative: true,
    },
  };
}

export interface ConversationReviewResult {
  readonly reviewId: string;
  readonly changes: readonly MemoryConversationReviewChange[];
  readonly skipped: Readonly<Record<ReviewSkipReason, number>>;
}

export interface ProductionMemoryConversationReviewOptions {
  readonly settings: () => ConversationReviewSettings;
  readonly episodes: Pick<MemoryEpisodeStorePort, "listDaySummariesAfter">;
  readonly store: MemoryConversationReviewStorePort;
  readonly threads: Pick<ThreadRepositoryPort, "listMessages">;
  readonly state: Pick<ProductMemoryStatePort, "readMany" | "read">;
  readonly search: (
    request: RuntimeRequest,
    query: string,
    limit: number,
  ) => Promise<readonly { readonly productMemoryId: MemoryId }[]>;
  readonly generations: Pick<ThreadDistillationStatePort, "request">;
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
  readonly ledger?: DecisionLedgerPort;
  readonly timeZone?: string;
  readonly externalOrigins?: (threadId: string) => Promise<readonly string[]>;
  readonly assertActive: () => Promise<void>;
  readonly externalTag: () => Promise<(kind: EgressPlaceholderKind, value: string) => string>;
  readonly generate: (
    request: RuntimeRequest,
    prompt: string,
    onAdmitted: () => void,
    call: MemoryCaptureCall,
  ) => Promise<string>;
  readonly onResult?: (result: ConversationReviewResult) => void;
  readonly onFailure: (error: unknown) => void;
}

interface ReviewPlan {
  readonly request: RuntimeRequest;
  readonly review: MemoryConversationReview;
  readonly episode: MemoryEpisode;
  readonly messages: readonly ReviewSourceMessage[];
  readonly existing: readonly (ReviewExistingMemory & {
    readonly memory: ProductMemoryRecord;
  })[];
  readonly subCategories: Record<string, string[]>;
  readonly people: readonly { readonly id: string }[];
  readonly prompt: string;
  readonly newMemoriesAllowed: number;
}

export class ProductionMemoryConversationReview {
  readonly #options: ProductionMemoryConversationReviewOptions;
  readonly #pending = new Map<string, Promise<void>>();
  #attemptedAt = Number.NEGATIVE_INFINITY;
  readonly #supportCache = new SupportVerdictCache();
  #stopping = false;

  constructor(options: ProductionMemoryConversationReviewOptions) {
    this.#options = options;
  }

  start(request: RuntimeRequest): Promise<void> {
    const now = Date.parse(this.#options.clock.now());
    if (
      this.#stopping ||
      !this.#options.settings().enabled ||
      !request.threadId ||
      request.continuationRef ||
      request.knownToolResult ||
      this.#pending.size > 0 ||
      now - this.#attemptedAt < ATTEMPT_INTERVAL_MS
    )
      return Promise.resolve();
    this.#attemptedAt = now;
    let onAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => {
      onAdmitted = resolve;
    });
    const work = this.runDue(request, onAdmitted)
      .then(() => undefined)
      .catch(this.#options.onFailure)
      .finally(() => {
        onAdmitted();
        this.#pending.delete(request.runId);
      });
    this.#pending.set(request.runId, work);
    return admitted;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#pending.values()]);
  }

  async runDue(
    request: RuntimeRequest,
    onAdmitted: () => void = () => {},
  ): Promise<readonly ConversationReviewResult[]> {
    const results: ConversationReviewResult[] = [];
    const settings = this.#options.settings();
    if (!settings.enabled) return results;
    const { ownerId, agentId } = request;
    const timeZone = this.#options.timeZone ?? "UTC";
    while (!this.#stopping) {
      if (
        this.#options.book &&
        (await this.#options.book.readSettings({ ownerId, agentId })).capturePaused
      )
        return results;
      const day = localDay(this.#options.clock.now(), timeZone);
      const usage = await this.#options.store.dayUsage({
        ownerId,
        agentId,
        day,
      });
      if (usage.reviews >= settings.maximumSegmentsPerDay) return results;
      const after = await this.#options.store.position({ ownerId, agentId });
      const [episode] = await this.#options.episodes.listDaySummariesAfter({
        ownerId,
        agentId,
        after,
        limit: 1,
      });
      if (!episode) return results;
      await this.#options.assertActive();
      const review = await this.#options.store.begin({
        id: conversationReviewId(episode.id),
        ownerId,
        agentId,
        threadId: episode.threadId,
        episodeId: episode.id,
        episodeCreatedAt: episode.createdAt,
        day,
        startedAt: this.#options.clock.now(),
      });
      if (review.attempts > MEMORY_CONVERSATION_REVIEW_MAX_ATTEMPTS) {
        await this.#settle(review);
        await this.#options.store.finish({
          id: review.id,
          status: "gave_up",
          errorCode: review.errorCode,
          finishedAt: this.#options.clock.now(),
        });
        continue;
      }
      try {
        results.push(
          await this.#review(
            request,
            review,
            episode,
            settings,
            settings.maximumNewMemoriesPerDay - usage.created,
            onAdmitted,
          ),
        );
        await this.#options.store.finish({
          id: review.id,
          status: "completed",
          errorCode: null,
          finishedAt: this.#options.clock.now(),
        });
      } catch (error) {
        await this.#settle(review).catch(this.#options.onFailure);
        await this.#options.store
          .finish({
            id: review.id,
            status:
              review.attempts >= MEMORY_CONVERSATION_REVIEW_MAX_ATTEMPTS ? "gave_up" : "failed",
            errorCode: captureErrorCode(error),
            finishedAt: this.#options.clock.now(),
          })
          .catch(this.#options.onFailure);
        throw error;
      }
    }
    return results;
  }

  async #readText(request: RuntimeRequest, ref: string): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(ref);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.#options.protector.unprotect({
        ownerId: request.ownerId,
        agentId: request.agentId,
        payload,
      }),
    );
  }

  async #plan(
    request: RuntimeRequest,
    review: MemoryConversationReview,
    episode: MemoryEpisode,
    settings: ConversationReviewSettings,
    newMemoriesAllowed: number,
  ): Promise<ReviewPlan | undefined> {
    const { ownerId, agentId } = request;
    const timeZone = this.#options.timeZone ?? "UTC";
    const allowed = (classification: DataClassification) =>
      isModelVisible(classification) &&
      CLASSIFICATION_RANK[classification] <= CLASSIFICATION_RANK[episode.dataClassification];
    const listed = await this.#options.threads.listMessages(
      ownerId,
      agentId,
      episode.threadId,
      Math.max(0, episode.firstSequence - 1),
      Math.min(MAXIMUM_SEGMENT_MESSAGES, episode.lastSequence - episode.firstSequence + 1),
    );
    const messages: ReviewSourceMessage[] = [];
    let characters = 0;
    for (const message of listed.toSorted((left, right) => left.sequence - right.sequence)) {
      if (
        message.sequence < episode.firstSequence ||
        message.sequence > episode.lastSequence ||
        message.role === "system" ||
        message.status !== "committed" ||
        !allowed(message.dataClassification)
      )
        continue;
      const text = (await this.#readText(request, message.contentRef).catch(() => undefined))
        ?.trim()
        .slice(0, MAXIMUM_MESSAGE_CHARACTERS);
      if (!text) continue;
      if (characters + text.length > settings.maximumSourceCharacters) break;
      characters += text.length;
      messages.push({ message, text });
    }
    if (!messages.some(({ message }) => message.role === "owner")) return undefined;
    const query = messages
      .filter(({ message }) => message.role === "owner")
      .map(({ text }) => text)
      .join("\n")
      .slice(0, MAXIMUM_QUERY_CHARACTERS);
    const hits = await this.#options.search(
      { ...request, dataClassification: episode.dataClassification },
      query,
      settings.maximumRelatedMemories,
    );
    const ids = [...new Set(hits.map(({ productMemoryId }) => productMemoryId))]
      .slice(0, settings.maximumRelatedMemories)
      .sort();
    const records = new Map(
      (ids.length === 0
        ? []
        : await this.#options.state.readMany({
            ownerId,
            agentId,
            memoryIds: ids,
          })
      ).map((record) => [record.id, record]),
    );
    const existing: (ReviewExistingMemory & {
      readonly memory: ProductMemoryRecord;
    })[] = [];
    for (const id of ids) {
      const memory = records.get(id);
      if (
        !memory ||
        memory.status !== "active" ||
        !allowed(memory.dataClassification) ||
        (memory.attributes?.supersededBy ?? null) !== null
      )
        continue;
      const text = await this.#readText(request, memory.contentRef).catch(() => undefined);
      if (!text) continue;
      existing.push({
        id: memory.id,
        recordedOn: localDay(statedAt(memory), timeZone),
        text,
        stance: memory.attributes?.stance ?? null,
        tentative: memory.attributes?.tentative === true,
        memory,
      });
    }
    const subCategories: Record<string, string[]> = {};
    for (const { category, subCategory } of (await this.#options.book?.listSubCategories({
      ownerId,
      agentId,
    })) ?? [])
      subCategories[category] = [...(subCategories[category] ?? []), subCategory];
    for (const names of Object.values(subCategories)) names.sort();
    const people = ((await this.#options.book?.listPeople({ ownerId, agentId })) ?? [])
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      )
      .slice(0, MAXIMUM_KNOWN_PEOPLE)
      .map(({ id, name, aliases, relation }) => ({
        id,
        name,
        aliases,
        relation,
      }));
    return {
      request: { ...request, dataClassification: episode.dataClassification },
      review,
      episode,
      messages,
      existing,
      subCategories,
      people,
      prompt: conversationReviewPrompt({
        messages: messages.map(({ message, text }) => ({
          id: message.id,
          role: message.role === "owner" ? "owner" : "agent",
          messageSentAt: message.committedAt,
          text,
        })),
        existing,
        subCategories,
        people,
        timeZone,
        day: localDay(this.#options.clock.now(), timeZone),
      }),
      newMemoriesAllowed,
    };
  }

  async #output(plan: ReviewPlan, settings: ConversationReviewSettings, onAdmitted: () => void) {
    const { review, request } = plan;
    if (review.outputRef) {
      const stored = await this.#readText(request, review.outputRef);
      if (stored !== undefined) return stored;
    }
    if (this.#stopping) throw new Error("MEMORY_CONVERSATION_REVIEW_STOPPING");
    await this.#options.assertActive();
    const output = await this.#options.generate(request, plan.prompt, onAdmitted, {
      invocationId: `${review.id}:${review.attempts}`,
      retryToolCall: false,
      maxOutputTokens: settings.maximumOutputTokens,
    });
    const ref = `memory-review-output:${review.id}:${review.attempts}`;
    await this.#options.payloads.put(
      await this.#options.protector.protect({
        ownerId: request.ownerId,
        agentId: request.agentId,
        ref,
        contentType: "text/plain",
        dataClassification: plan.episode.dataClassification,
        plaintext: new TextEncoder().encode(output),
        createdAt: this.#options.clock.now(),
      }),
    );
    await this.#options.store.attachOutput({ id: review.id, outputRef: ref });
    return output;
  }

  async #review(
    request: RuntimeRequest,
    review: MemoryConversationReview,
    episode: MemoryEpisode,
    settings: ConversationReviewSettings,
    newMemoriesAllowed: number,
    onAdmitted: () => void,
  ): Promise<ConversationReviewResult> {
    await this.#settle(review);
    const plan = await this.#plan(request, review, episode, settings, newMemoriesAllowed);
    if (!plan) return { reviewId: review.id, changes: [], skipped: emptySkips() };
    const output = await this.#output(plan, settings, onAdmitted);
    const tag = await this.#options.externalTag();
    const externalOrigins = (await this.#options.externalOrigins?.(episode.threadId)) ?? [];
    const table = placeholderTable(plan.prompt, tag, {
      trusted: TRUSTED_PROMPT_TEXTS,
      jsonEmbedded: true,
    });
    const parse = (supportVerdicts?: ReadonlyMap<string, boolean>) =>
      parseConversationReview({
        output,
        messages: plan.messages,
        existing: plan.existing,
        timeZone: this.#options.timeZone ?? "UTC",
        subCategories: plan.subCategories,
        knownPersonIds: new Set(plan.people.map(({ id }) => id)),
        newMemoriesAllowed: plan.newMemoriesAllowed,
        restore: (text) => restorePlaceholders(text, table),
        externalOrigins,
        ...(supportVerdicts ? { supportVerdicts } : {}),
      });
    const first = parse();
    const parsed =
      first.supportChecks.length === 0
        ? first
        : parse(await this.#judgeSupport(plan, first.supportChecks));
    const changes: MemoryConversationReviewChange[] = [];
    for (const group of parsed.groups)
      changes.push(...(await this.#commit(plan, group, parsed.skipped)));
    const result = { reviewId: review.id, changes, skipped: parsed.skipped };
    this.#options.onResult?.(result);
    return result;
  }

  async #judgeSupport(
    plan: ReviewPlan,
    checks: readonly SupportCheck[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const { review, request } = plan;
    const verdicts = new Map<string, boolean>();
    for (const [index, check] of checks.entries()) {
      if (verdicts.has(check.key)) continue;
      if (this.#stopping) throw new Error("MEMORY_CONVERSATION_REVIEW_STOPPING");
      const known = this.#supportCache.get(check, request.dataClassification);
      if (known !== undefined) {
        verdicts.set(check.key, known);
        continue;
      }
      await this.#options.assertActive();
      const prompt = memoryConfirmationJudgePrompt(check.memoryText, check.quote);
      let settled = true;
      const verdict = await judgeOrDefault(
        {
          ask: (attempt) =>
            this.#options.generate(request, prompt, () => {}, {
              invocationId: `${review.id}:${review.attempts}:support:${index}:${attempt}`,
              retryToolCall: false,
            }),
          parse: parseSupportVerdict,
        },
        false,
        (error) => {
          settled = false;
          this.#options.onFailure(error);
        },
      );
      if (settled) this.#supportCache.set(check, request.dataClassification, verdict);
      verdicts.set(check.key, verdict);
    }
    return verdicts;
  }

  async #commit(
    plan: ReviewPlan,
    group: ReviewMessageCandidates,
    skipped: Record<ReviewSkipReason, number>,
  ): Promise<MemoryConversationReviewChange[]> {
    const { request, episode } = plan;
    const { ownerId, agentId } = request;
    const { message } = group.source;
    const known = new Map(plan.existing.map(({ id, memory }) => [id as string, memory]));
    const touched = [
      ...new Set(
        group.parsed.candidates.flatMap((candidate) => [
          ...(candidate.supersedes ? [candidate.supersedes] : []),
          ...(candidate.existingMemoryId ? [candidate.existingMemoryId] : []),
        ]),
      ),
    ];
    const current = new Map(
      (touched.length === 0
        ? []
        : await this.#options.state.readMany({
            ownerId,
            agentId,
            memoryIds: touched,
          })
      ).map((record) => [record.id as string, record]),
    );
    const unchanged = (id: MemoryId | null | undefined) =>
      !id || current.get(id)?.revision === known.get(id)?.revision;
    const candidates = group.parsed.candidates.filter((candidate) => {
      const fresh = unchanged(candidate.supersedes) && unchanged(candidate.existingMemoryId);
      if (!fresh) skipped.not_a_change += 1;
      return fresh;
    });
    if (candidates.length === 0 && group.parsed.rejectedCandidates.length === 0) return [];
    const generationId = conversationReviewGenerationId(episode.id, message.id);
    await this.#options.assertActive();
    const createdAt = this.#options.clock.now();
    const intent = (
      memoryId: MemoryId,
      action: MemoryConversationReviewChange["action"],
      before?: ProductMemoryRecord,
    ) =>
      this.#options.store.recordChange({
        reviewId: plan.review.id,
        memoryId,
        action,
        sourceMessageId: message.id,
        afterRevision: null,
        beforeSupersededBy: before?.attributes?.supersededBy ?? null,
        beforeValidTo: before?.attributes?.validTo ?? null,
        createdAt,
      });
    for (const [ordinal, candidate] of candidates.entries()) {
      if (candidate.decision === "create") {
        await intent(`memory:${generationId}:${ordinal}` as MemoryId, "created");
        if (candidate.supersedes)
          await intent(candidate.supersedes, "superseded", known.get(candidate.supersedes));
      } else if (candidate.existingMemoryId) await intent(candidate.existingMemoryId, "confirmed");
    }
    if (candidates.length > 0)
      await this.#options.generations.request({
        jobId: `checkpoint:${generationId}` as ThreadDistillationWork["jobId"],
        generationId,
        ownerId,
        agentId,
        threadId: episode.threadId,
        sourceWatermark: message.sequence,
        policyVersion: MEMORY_CONVERSATION_REVIEW_POLICY_VERSION,
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
            ref: message.id,
            sequence: message.sequence,
            kind: "message",
            dataClassification: message.dataClassification,
          },
        ],
        requestedAt: createdAt,
        errorCode: null,
      });
    const service = createProductionAutomaticMemory({
      ...this.#options,
      extract: async () => candidates,
      readSourceText: async () => group.source.text,
      onAudit: () => {},
    });
    await service.processCommittedRun({
      ownerId,
      agentId,
      runId: message.runId ?? request.runId,
      threadId: episode.threadId,
      generationId,
      sourceRef: message.contentRef,
      sourceClassification: message.dataClassification,
      policyVersion: MEMORY_CONVERSATION_REVIEW_POLICY_VERSION,
      modelDescriptorRef: request.modelRef,
      interactive: false,
      explicitRememberCandidateOrdinal: null,
      rejectedCandidates: group.parsed.rejectedCandidates,
    });
    await this.#settle(plan.review);
    return (await this.#options.store.listChanges(plan.review.id)).filter(
      (change) => change.sourceMessageId === message.id && change.afterRevision !== null,
    );
  }

  async #settle(review: MemoryConversationReview): Promise<void> {
    const all = await this.#options.store.listChanges(review.id);
    const pending = all.filter(({ afterRevision }) => afterRevision === null);
    if (pending.length === 0) return;
    const createdHere = new Set<string>(
      all.filter(({ action }) => action === "created").map(({ memoryId }) => memoryId),
    );
    const records = new Map(
      (
        await this.#options.state.readMany({
          ownerId: review.ownerId,
          agentId: review.agentId,
          memoryIds: [...new Set(pending.map(({ memoryId }) => memoryId))],
        })
      ).map((record) => [record.id as string, record]),
    );
    for (const { undoneRevision: _undone, ...change } of pending) {
      const memory = records.get(change.memoryId);
      const supersededBy = memory?.attributes?.supersededBy ?? null;
      const happened =
        memory !== undefined &&
        (change.action === "created" ||
          (change.action === "superseded"
            ? supersededBy !== null && createdHere.has(supersededBy)
            : memory.attributes?.tentative !== true));
      if (memory && happened)
        await this.#options.store.recordChange({ ...change, afterRevision: memory.revision });
      else
        await this.#options.store.discardChange({
          reviewId: review.id,
          memoryId: change.memoryId,
        });
    }
  }
}

function emptySkips(): Record<ReviewSkipReason, number> {
  return {
    invalid: 0,
    unknown_message: 0,
    pattern_single_day: 0,
    sensitive: 0,
    inferred_private_topic: 0,
    not_a_change: 0,
    daily_limit: 0,
  };
}
