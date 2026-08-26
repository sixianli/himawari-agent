import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type DataClassification,
  type MemoryContentPort,
  type MemoryProjectionJob,
  type MemoryProjectionJobStatePort,
  type MemoryProviderProjectionPort,
  type ProductMemoryProposal,
  type ProductMemoryRecord,
  type ProductMemorySearchResult,
  type ProductMemoryStatePort,
} from "../ports/index.js";
import type { AgentId, MemoryGenerationId, MemoryId, OwnerId } from "@himawari-agent/domain";

export interface DurableMemoryServiceOptions {
  readonly state: ProductMemoryStatePort;
  readonly jobs: MemoryProjectionJobStatePort;
  readonly provider: MemoryProviderProjectionPort;
  readonly content: MemoryContentPort;
  readonly workerId: string;
  readonly now: () => string;
  readonly maximumProjectionAttempts?: number;
  readonly projectionLeaseMs?: number;
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

export class DurableMemoryService {
  private readonly options: DurableMemoryServiceOptions;

  constructor(options: DurableMemoryServiceOptions) {
    this.options = options;
  }

  async applyProposal(
    proposal: ProductMemoryProposal,
    generationId: MemoryGenerationId,
  ): Promise<ProductMemoryRecord> {
    if (proposal.decision === "unchanged") {
      return requireRecord(await this.options.state.read(proposal.memoryId), proposal.memoryId);
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
        if (sameProposal) return existing;
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
      const saved = await this.options.state.save(record, null);
      await this.proposeProjection(saved, "upsert", generationId);
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
    const saved = await this.options.state.save(
      nextRecord(
        current,
        {
          contentRef: proposal.contentRef,
          sourceRefs: [...new Set([...current.sourceRefs, ...proposal.sourceRefs])].sort(),
          dataClassification: proposal.dataClassification,
          inference: proposal.inference,
          confidencePermille: proposal.confidencePermille,
          policyVersion: proposal.policyVersion,
        },
        updatedAt,
      ),
      current.revision,
    );
    await this.proposeProjection(saved, "upsert", generationId);
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
    const saved = await this.options.state.save(
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
    );
    await this.proposeProjection(saved, "upsert", input.generationId);
    return saved;
  }

  archive(memoryId: MemoryId, generationId: MemoryGenerationId): Promise<ProductMemoryRecord> {
    return this.deactivate(memoryId, "archived", generationId);
  }

  delete(memoryId: MemoryId, generationId: MemoryGenerationId): Promise<ProductMemoryRecord> {
    return this.deactivate(memoryId, "deletion_pending", generationId);
  }

  async search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly queryRef: string;
    readonly policy: MemorySearchPolicy;
  }): Promise<readonly ProductMemorySearchResult[]> {
    const query = await this.options.content.readText(input.queryRef);
    const providerHits = await this.options.provider.search({
      ownerId: input.ownerId,
      agentId: input.agentId,
      query,
      limit: Math.min(1000, Math.max(input.policy.limit * 4, input.policy.limit)),
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
    const selected = providerHits
      .flatMap((hit) => {
        const memory = records.get(hit.productMemoryId);
        if (
          !memory ||
          memory.status !== "active" ||
          memory.providerRecordId !== hit.providerRecordId ||
          !allowedClassifications.has(memory.dataClassification) ||
          (allowedSources && !memory.sourceRefs.some((source) => allowedSources.has(source)))
        ) {
          return [];
        }
        return [{ memory, providerRecordId: hit.providerRecordId, score: hit.score }];
      })
      .sort(
        (left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, input.policy.limit);
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

  private async deactivate(
    memoryId: MemoryId,
    status: "archived" | "deletion_pending",
    generationId: MemoryGenerationId,
  ): Promise<ProductMemoryRecord> {
    const current = requireRecord(await this.options.state.read(memoryId), memoryId);
    if (current.status === "deleted_verified" || current.status === "deletion_pending") {
      return current;
    }
    if (
      current.status !== "active" &&
      current.status !== "archived" &&
      status !== "deletion_pending"
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Memory ${memoryId} cannot transition from ${current.status} to ${status}`,
      );
    }
    const saved = await this.options.state.save(
      nextRecord(current, { status }, this.options.now()),
      current.revision,
    );
    await this.proposeProjection(saved, "delete", generationId);
    return saved;
  }

  private proposeProjection(
    memory: ProductMemoryRecord,
    operation: "upsert" | "delete",
    generationId: MemoryGenerationId,
    requeueCompleted = false,
  ): Promise<MemoryProjectionJob> {
    const job: MemoryProjectionJob = Object.freeze({
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
    return this.options.jobs.propose({ job, requeueCompleted });
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
        providerRecordId = await this.options.provider.upsert({ memory: current, content });
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
