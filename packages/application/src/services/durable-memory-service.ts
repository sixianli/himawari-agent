import {
  ApplicationPortError,
  DEFAULT_MEMORY_ATTRIBUTES,
  PORT_ERROR_CODES,
  type DataClassification,
  type DecisionLedgerWrite,
  type MemoryCategory,
  type MemoryConsolidationWrite,
  type MemoryContentPort,
  type MemoryHistoryNote,
  type MemoryProjectionJob,
  type MemoryProjectionJobStatePort,
  type MemoryProviderProjectionPort,
  type MemoryTimeScope,
  type ProductMemoryAttributes,
  type ProductMemoryProposal,
  type ProductMemoryRecord,
  type ProductMemorySearchResult,
  type ProductMemoryStatePort,
} from "../ports/index.js";
import type { AgentId, MemoryGenerationId, MemoryId, OwnerId } from "@himawari-agent/domain";
import { dropSameSourceDuplicates } from "./same-source-dedupe.js";

export interface DurableMemoryServiceOptions {
  readonly state: ProductMemoryStatePort;
  readonly jobs: MemoryProjectionJobStatePort;
  readonly provider: MemoryProviderProjectionPort;
  readonly content: MemoryContentPort;
  readonly workerId: string;
  readonly now: () => string;
  readonly maximumProjectionAttempts?: number;
  readonly projectionLeaseMs?: number;
  readonly dedupeSameSource?: boolean;
  readonly project?: (
    job: MemoryProjectionJob,
    memory: ProductMemoryRecord,
    operation: () => Promise<string>,
  ) => Promise<string>;
}

export interface MemorySearchPolicy {
  readonly allowedClassifications: readonly DataClassification[];
  readonly allowedSourceRefs?: readonly string[];
  readonly limit: number;
}

function stableJobId(memoryId: MemoryId, revision: number, operation: "upsert" | "delete"): string {
  return `memory-projection:${memoryId}:${revision}:${operation}`;
}

function requireRecord(
  record: ProductMemoryRecord | undefined,
  memoryId: MemoryId,
): ProductMemoryRecord {
  if (!record) {
    throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Memory ${memoryId} not found`, {
      memoryId,
    });
  }
  return record;
}

function nextRecord(
  current: ProductMemoryRecord,
  update: Partial<ProductMemoryRecord>,
  updatedAt: string,
): ProductMemoryRecord {
  return Object.freeze({
    ...current,
    ...update,
    id: current.id,
    ownerId: current.ownerId,
    agentId: current.agentId,
    revision: current.revision + 1,
    updatedAt,
  });
}

function historyNote(
  kind: MemoryHistoryNote["kind"],
  proposal: ProductMemoryProposal,
): MemoryHistoryNote {
  const sourceThreadId =
    proposal.decision === "create" ? proposal.memory.sourceThreadId : proposal.sourceThreadId;
  return {
    kind,
    quoteRef: proposal.quoteRef ?? null,
    ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
  };
}

export type ConsolidationWriteFor = (saved: ProductMemoryRecord) => MemoryConsolidationWrite;

export class DurableMemoryService {
  private readonly options: DurableMemoryServiceOptions;

  constructor(options: DurableMemoryServiceOptions) {
    this.options = options;
  }

  async applyProposal(
    proposal: ProductMemoryProposal,
    generationId: MemoryGenerationId,
    ledger?: DecisionLedgerWrite,
    consolidation?: ConsolidationWriteFor,
  ): Promise<ProductMemoryRecord> {
    if (proposal.decision === "unchanged") {
      const current = requireRecord(
        await this.options.state.read(proposal.memoryId),
        proposal.memoryId,
      );
      if (current.status === "active" && (current.attributes?.supersededBy ?? null) === null)
        await this.options.state.appendHistory({
          memoryId: current.id,
          note: historyNote("reaffirmed", proposal),
          occurredAt: this.options.now(),
        });
      return current.status === "active" && current.attributes?.tentative === true
        ? this.confirm(current.id, generationId)
        : current;
    }
    const updatedAt = this.options.now();
    if (proposal.decision === "create") {
      const existing = await this.options.state.read(proposal.memory.id);
      if (existing) {
        const sameProposal =
          existing.ownerId === proposal.memory.ownerId &&
          existing.agentId === proposal.memory.agentId &&
          existing.contentRef === proposal.memory.contentRef &&
          existing.dataClassification === proposal.memory.dataClassification &&
          existing.policyVersion === proposal.memory.policyVersion &&
          existing.inference === proposal.memory.inference &&
          existing.confidencePermille === proposal.memory.confidencePermille &&
          existing.sourceRefs.length === proposal.memory.sourceRefs.length &&
          existing.sourceRefs.every((source) => proposal.memory.sourceRefs.includes(source));
        if (sameProposal) {
          if (existing.status === "active") {
            await this.proposeProjection(existing, "upsert", generationId);
            if (proposal.supersedes)
              await this.supersede(proposal.supersedes, existing, generationId);
          }
          return existing;
        }
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          `Memory ${proposal.memory.id} already exists with different product content`,
          { memoryId: proposal.memory.id },
        );
      }
      const record: ProductMemoryRecord = Object.freeze({
        ...proposal.memory,
        revision: 1,
        status: "active",
        providerRecordId: null,
        lastUsedAt: null,
        updatedAt,
      });
      const saved = await this.saveWithProjection(
        record,
        null,
        "upsert",
        generationId,
        historyNote("created", proposal),
        ledger,
        consolidation,
      );
      if (proposal.supersedes) await this.supersede(proposal.supersedes, saved, generationId);
      return saved;
    }
    const current = requireRecord(
      await this.options.state.read(proposal.memoryId),
      proposal.memoryId,
    );
    if (current.status !== "active") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${current.id} is not active`,
        { memoryId: current.id, status: current.status },
      );
    }
    const saved = await this.saveWithProjection(
      nextRecord(
        current,
        {
          contentRef: proposal.contentRef,
          sourceRefs: [...new Set([...current.sourceRefs, ...proposal.sourceRefs])].sort(),
          dataClassification: proposal.dataClassification,
          inference: proposal.inference,
          confidencePermille: proposal.confidencePermille,
          policyVersion: proposal.policyVersion,
          ...(proposal.attributes || current.attributes?.tentative
            ? {
                attributes: {
                  ...(proposal.attributes ?? current.attributes ?? DEFAULT_MEMORY_ATTRIBUTES),
                  tentative: false,
                },
              }
            : {}),
        },
        updatedAt,
      ),
      current.revision,
      "upsert",
      generationId,
      historyNote("updated", proposal),
      ledger,
      consolidation,
    );
    return saved;
  }

  async correct(input: {
    readonly memoryId: MemoryId;
    readonly contentRef: string;
    readonly sourceRef: string;
    readonly generationId: MemoryGenerationId;
  }): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(input.memoryId), input.memoryId);
    if (current.status !== "active") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${current.id} cannot be corrected from ${current.status}`,
      );
    }
    const saved = await this.saveWithProjection(
      nextRecord(
        current,
        {
          contentRef: input.contentRef,
          sourceRefs: [...new Set([...current.sourceRefs, input.sourceRef])].sort(),
          inference: false,
          confidencePermille: 1000,
        },
        this.options.now(),
      ),
      current.revision,
      "upsert",
      input.generationId,
      { kind: "edited", sourceThreadId: null },
    );
    return saved;
  }

  async restore(
    memoryId: MemoryId,
    generationId: MemoryGenerationId,
  ): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(memoryId), memoryId);
    const attributes = current.attributes;
    if (current.status !== "active" || !attributes || attributes.supersededBy === null)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${memoryId} is not superseded`,
      );
    const replacement = await this.options.state.read(attributes.supersededBy);
    if (replacement?.status === "active")
      await this.deactivate(replacement.id, "archived", generationId);
    return this.saveWithProjection(
      nextRecord(
        current,
        { attributes: { ...attributes, supersededBy: null, validTo: null } },
        this.options.now(),
      ),
      current.revision,
      "upsert",
      generationId,
      { kind: "restored", sourceThreadId: null },
    );
  }

  async restoreVersion(input: {
    readonly memoryId: MemoryId;
    readonly expectedRevision: number;
    readonly contentRef: string;
    readonly stance: string | null;
    readonly generationId: MemoryGenerationId;
  }): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(input.memoryId), input.memoryId);
    if (current.revision !== input.expectedRevision)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Memory ${input.memoryId} changed since it was read`,
        { memoryId: input.memoryId },
      );
    const attributes = current.attributes ?? DEFAULT_MEMORY_ATTRIBUTES;
    if (current.status !== "active" || attributes.supersededBy !== null)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${input.memoryId} is not the current wording`,
      );
    return this.saveWithProjection(
      nextRecord(
        current,
        {
          contentRef: input.contentRef,
          inference: false,
          confidencePermille: 1000,
          attributes: { ...attributes, stance: input.stance },
        },
        this.options.now(),
      ),
      current.revision,
      "upsert",
      input.generationId,
      { kind: "restored", sourceThreadId: null },
    );
  }

  async confirm(
    memoryId: MemoryId,
    generationId: MemoryGenerationId,
  ): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(memoryId), memoryId);
    if (current.status !== "active" || current.attributes?.tentative !== true)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${memoryId} is not waiting for confirmation`,
      );
    return this.saveWithProjection(
      nextRecord(
        current,
        { attributes: { ...current.attributes, tentative: false } },
        this.options.now(),
      ),
      current.revision,
      "upsert",
      generationId,
    );
  }

  async revise(input: {
    readonly memoryId: MemoryId;
    readonly expectedRevision: number;
    readonly status?: "active" | "archived";
    readonly attributes?: Partial<ProductMemoryAttributes>;
    readonly generationId: MemoryGenerationId;
    readonly consolidation?: ConsolidationWriteFor;
  }): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(input.memoryId), input.memoryId);
    if (current.revision !== input.expectedRevision)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Memory ${input.memoryId} changed since it was read`,
        { memoryId: input.memoryId },
      );
    const status = input.status ?? current.status;
    if (
      (current.status !== "active" && current.status !== "archived") ||
      (status !== "active" && status !== "archived")
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${input.memoryId} cannot be revised from ${current.status}`,
      );
    return this.saveWithProjection(
      nextRecord(
        current,
        {
          status,
          ...(input.attributes
            ? {
                attributes: {
                  ...(current.attributes ?? DEFAULT_MEMORY_ATTRIBUTES),
                  ...input.attributes,
                },
              }
            : {}),
        },
        this.options.now(),
      ),
      current.revision,
      status === "active" ? "upsert" : "delete",
      input.generationId,
      undefined,
      undefined,
      input.consolidation,
    );
  }

  archive(memoryId: MemoryId, generationId: MemoryGenerationId): Promise<ProductMemoryRecord> {
    return this.deactivate(memoryId, "archived", generationId);
  }

  delete(memoryId: MemoryId, generationId: MemoryGenerationId): Promise<ProductMemoryRecord> {
    return this.deactivate(memoryId, "deletion_pending", generationId);
  }

  trash(memoryId: MemoryId, generationId: MemoryGenerationId): Promise<ProductMemoryRecord> {
    return this.deactivate(memoryId, "trashed", generationId);
  }

  async recover(
    memoryId: MemoryId,
    generationId: MemoryGenerationId,
  ): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(memoryId), memoryId);
    if (current.status !== "trashed" && current.status !== "archived")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${memoryId} cannot be recovered from ${current.status}`,
      );
    return this.saveWithProjection(
      nextRecord(current, { status: "active" }, this.options.now()),
      current.revision,
      "upsert",
      generationId,
    );
  }

  async search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly queryRef: string;
    readonly policy: MemorySearchPolicy;
    readonly scope?: MemoryTimeScope;
    readonly queryText?: string;
    readonly minimumSimilarity?: number;
    readonly recordUse?: boolean;
    readonly excludeCategories?: readonly MemoryCategory[];
    readonly includeTentative?: boolean;
  }): Promise<readonly ProductMemorySearchResult[]> {
    const query = input.queryText ?? (await this.options.content.readText(input.queryRef));
    const providerHits = await this.options.provider.search({
      ownerId: input.ownerId,
      agentId: input.agentId,
      query,
      limit: Math.min(1000, Math.max(input.policy.limit * 4, input.policy.limit)),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.minimumSimilarity === undefined
        ? {}
        : { minimumSimilarity: input.minimumSimilarity }),
      relevanceCutoff: true,
      ...(input.includeTentative === true ? { includeTentative: true } : {}),
    });
    const productRecords = await this.options.state.readMany({
      ownerId: input.ownerId,
      agentId: input.agentId,
      memoryIds: providerHits.map(({ productMemoryId }) => productMemoryId),
    });
    const records = new Map(productRecords.map((record) => [record.id, record]));
    const allowedClassifications = new Set(input.policy.allowedClassifications);
    const allowedSources = input.policy.allowedSourceRefs
      ? new Set(input.policy.allowedSourceRefs)
      : null;
    const ranked = providerHits
      .flatMap((hit) => {
        const memory = records.get(hit.productMemoryId);
        if (
          !memory ||
          memory.status !== "active" ||
          memory.providerRecordId !== hit.providerRecordId ||
          !allowedClassifications.has(memory.dataClassification) ||
          (input.excludeCategories &&
            memory.attributes &&
            input.excludeCategories.includes(memory.attributes.category)) ||
          (allowedSources && !memory.sourceRefs.some((source) => allowedSources.has(source)))
        ) {
          return [];
        }
        return [{ memory, providerRecordId: hit.providerRecordId, score: hit.score }];
      })
      .sort(
        (left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id),
      );
    const selected =
      this.options.dedupeSameSource !== false
        ? (
            await dropSameSourceDuplicates(
              ranked.map((hit) => ({
                ...hit,
                id: hit.memory.id,
                sourceRefs: hit.memory.sourceRefs,
                contentRef: hit.memory.contentRef,
              })),
              input.policy.limit,
              (contentRef) => this.options.content.readText(contentRef),
            )
          ).map(({ memory, providerRecordId, score }) => ({ memory, providerRecordId, score }))
        : ranked.slice(0, input.policy.limit);
    if (input.recordUse !== false)
      await this.options.state.markUsed(
        selected.map(({ memory }) => memory.id),
        this.options.now(),
      );
    return selected;
  }

  async runProjectionBatch(limit: number): Promise<readonly MemoryProjectionJob[]> {
    const pending = await this.options.jobs.listPending(this.options.now(), limit);
    const settled: MemoryProjectionJob[] = [];
    for (const candidate of pending) {
      const claimedAt = this.options.now();
      const expiresAt = new Date(
        new Date(claimedAt).valueOf() + (this.options.projectionLeaseMs ?? 30_000),
      ).toISOString();
      const job = await this.options.jobs.claim({
        jobId: candidate.id,
        claimedBy: this.options.workerId,
        claimedAt,
        expiresAt,
      });
      if (!job) continue;
      settled.push(await this.projectClaimed(job));
    }
    return settled;
  }

  async rebuild(
    ownerId: OwnerId,
    agentId: AgentId,
    generationId: MemoryGenerationId,
  ): Promise<readonly MemoryProjectionJob[]> {
    await this.options.provider.clearScope(ownerId, agentId);
    const records = await this.options.state.listActive(ownerId, agentId);
    for (const record of records) {
      await this.proposeProjection(record, "upsert", generationId, true);
    }
    const completed: MemoryProjectionJob[] = [];
    while (true) {
      const batch = await this.runProjectionBatch(100);
      completed.push(...batch);
      if (batch.length === 0) return completed;
      if (batch.some(({ status }) => status !== "completed")) return completed;
    }
  }

  async requeueProjection(memoryIds: readonly MemoryId[]): Promise<number> {
    let requeued = 0;
    for (const memoryId of memoryIds) {
      const memory = await this.options.state.read(memoryId);
      if (!memory || memory.status !== "active") continue;
      const generationId = (await this.options.jobs.listByMemory(memoryId)).at(-1)?.generationId;
      if (!generationId) continue;
      await this.proposeProjection(memory, "upsert", generationId, true);
      requeued += 1;
    }
    return requeued;
  }

  private async supersede(
    memoryId: MemoryId,
    replacement: ProductMemoryRecord,
    generationId: MemoryGenerationId,
  ): Promise<void> {
    const current = await this.options.state.read(memoryId);
    if (
      !current ||
      current.id === replacement.id ||
      current.status !== "active" ||
      current.ownerId !== replacement.ownerId ||
      current.agentId !== replacement.agentId ||
      (current.attributes?.supersededBy ?? null) !== null
    )
      return;
    const attributes = current.attributes ?? DEFAULT_MEMORY_ATTRIBUTES;
    const endedAt = replacement.attributes?.validFrom ?? replacement.updatedAt;
    await this.saveWithProjection(
      nextRecord(
        current,
        {
          attributes: {
            ...attributes,
            supersededBy: replacement.id,
            validTo:
              attributes.validTo !== null && attributes.validTo < endedAt
                ? attributes.validTo
                : endedAt,
          },
        },
        replacement.updatedAt,
      ),
      current.revision,
      "upsert",
      generationId,
    );
  }

  private async deactivate(
    memoryId: MemoryId,
    status: "archived" | "trashed" | "deletion_pending",
    generationId: MemoryGenerationId,
  ): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(memoryId), memoryId);
    if (current.status === "deleted_verified" || current.status === "deletion_pending") {
      if (current.status === "deletion_pending")
        await this.proposeProjection(current, "delete", generationId);
      return current;
    }
    if (
      (current.status !== "active" &&
        current.status !== "archived" &&
        status !== "deletion_pending") ||
      (status === "trashed" && current.status !== "active" && current.status !== "archived")
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${memoryId} cannot transition from ${current.status} to ${status}`,
      );
    }
    const saved = await this.saveWithProjection(
      nextRecord(current, { status }, this.options.now()),
      current.revision,
      "delete",
      generationId,
    );
    return saved;
  }

  private proposeProjection(
    memory: ProductMemoryRecord,
    operation: "upsert" | "delete",
    generationId: MemoryGenerationId,
    requeueCompleted = false,
  ): Promise<MemoryProjectionJob> {
    const job = this.projectionJob(memory, operation, generationId);
    return this.options.jobs.propose({ job, requeueCompleted });
  }

  private saveWithProjection(
    memory: ProductMemoryRecord,
    expectedRevision: number | null,
    operation: "upsert" | "delete",
    generationId: MemoryGenerationId,
    history?: MemoryHistoryNote,
    ledger?: DecisionLedgerWrite,
    consolidation?: ConsolidationWriteFor,
  ) {
    return this.options.state.saveWithProjection({
      memory,
      expectedRevision,
      job: this.projectionJob(memory, operation, generationId),
      ...(history ? { history } : {}),
      ...(ledger ? { ledger } : {}),
      ...(consolidation ? { consolidation: consolidation(memory) } : {}),
    });
  }

  private projectionJob(
    memory: ProductMemoryRecord,
    operation: "upsert" | "delete",
    generationId: MemoryGenerationId,
  ): MemoryProjectionJob {
    return Object.freeze({
      id: stableJobId(memory.id, memory.revision, operation),
      memoryId: memory.id,
      memoryRevision: memory.revision,
      generationId,
      operation,
      status: "pending",
      attemptCount: 0,
      nextRetryAt: null,
      providerRecordId: memory.providerRecordId,
      errorCode: null,
      claimedBy: null,
      claimExpiresAt: null,
    });
  }

  private async projectClaimed(job: MemoryProjectionJob): Promise<MemoryProjectionJob> {
    try {
      const current = requireRecord(await this.options.state.read(job.memoryId), job.memoryId);
      let providerRecordId: string | null = null;
      if (
        job.operation === "upsert" &&
        current.status === "active" &&
        current.revision === job.memoryRevision
      ) {
        const content = await this.options.content.readText(current.contentRef);
        const operation = () => this.options.provider.upsert({ memory: current, content });
        providerRecordId = this.options.project
          ? await this.options.project(job, current, operation)
          : await operation();
      } else if (job.operation === "delete" && current.providerRecordId) {
        await this.options.provider.delete(current.providerRecordId);
      }
      const completed = await this.options.jobs.complete({
        jobId: job.id,
        claimedBy: this.options.workerId,
        providerRecordId,
      });
      if (providerRecordId) {
        const linked = await this.options.state.read(job.memoryId);
        if (
          !linked ||
          linked.status !== "active" ||
          linked.revision !== job.memoryRevision ||
          linked.providerRecordId !== providerRecordId
        ) {
          await this.options.provider.delete(providerRecordId);
        }
      }
      return completed;
    } catch (error) {
      const attempts = job.attemptCount;
      const terminal = attempts >= (this.options.maximumProjectionAttempts ?? 5);
      const errorCode =
        error instanceof ApplicationPortError ? error.code : "MEMORY_PROJECTION_FAILED";
      const nextRetryAt = terminal
        ? null
        : new Date(new Date(this.options.now()).valueOf() + 2 ** attempts * 1000).toISOString();
      return this.options.jobs.retry({
        jobId: job.id,
        claimedBy: this.options.workerId,
        errorCode,
        nextRetryAt,
      });
    }
  }
}
