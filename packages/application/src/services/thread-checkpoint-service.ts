import {
  createCheckpointJobId,
  createMemoryGenerationId,
  type CheckpointJobId,
  type MemoryGenerationId,
} from "@himawari-agent/domain";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type ApprovedMemoryContentPort,
  type ThreadCheckpointSourceRef,
  type ThreadCheckpointTrigger,
  type ThreadDerivativeCandidateRecord,
  type ThreadDistillationModelPort,
  type ThreadDistillationOutput,
  type ThreadDistillationStatePort,
  type ThreadDistillationWork,
  type ThreadSummaryRecord,
} from "../ports/index.js";
import { scanMachineSecrets } from "./machine-secret-exclusion.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

export interface ThreadCheckpointServiceOptions {
  readonly state: ThreadDistillationStatePort;
  readonly model: ThreadDistillationModelPort;
  readonly content: ApprovedMemoryContentPort;
  readonly readSourceText: (sourceRef: string) => Promise<string>;
  readonly workerId: string;
  readonly now: () => string;
  readonly sourceSizeThreshold: number;
  readonly maximumAttempts?: number;
  readonly leaseMs?: number;
}

export interface ThreadCheckpointRequest {
  readonly ownerId: ThreadDistillationWork["ownerId"];
  readonly agentId: ThreadDistillationWork["agentId"];
  readonly threadId: ThreadDistillationWork["threadId"];
  readonly sourceWatermark: number;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly trigger: ThreadCheckpointTrigger;
  readonly sources: readonly ThreadCheckpointSourceRef[];
  readonly allAdmittedRunsStable: boolean;
  readonly sourceSize: number;
}

function stableIdentities(
  threadId: ThreadDistillationWork["threadId"],
  sourceWatermark: number,
  policyVersion: string,
): { readonly jobId: CheckpointJobId; readonly generationId: MemoryGenerationId } {
  const semanticIdentity = JSON.stringify([threadId, sourceWatermark, policyVersion]);
  const fingerprint = `${fnv1a64(semanticIdentity)}${fnv1a64(`thread-checkpoint:${semanticIdentity}`)}`;
  return {
    jobId: createCheckpointJobId(`checkpoint:${fingerprint}`),
    generationId: createMemoryGenerationId(`generation:${fingerprint}`),
  };
}

function fnv1a64(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function validateTrigger(input: ThreadCheckpointRequest, threshold: number): void {
  if (input.trigger === "controlled_idle" && !input.allAdmittedRunsStable) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Controlled idle checkpoint requires every admitted Run to be stable",
    );
  }
  if (input.trigger === "source_threshold" && input.sourceSize < threshold) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Source-size checkpoint is below the configured threshold",
    );
  }
  if (
    input.policyVersion.trim().length === 0 ||
    input.modelDescriptorRef.trim().length === 0 ||
    !Number.isSafeInteger(input.sourceWatermark) ||
    input.sourceWatermark < 1 ||
    input.sources.length === 0 ||
    new Set(input.sources.map(({ ref }) => ref)).size !== input.sources.length ||
    new Set(input.sources.map(({ sequence, kind }) => `${sequence}:${kind}`)).size !==
      input.sources.length ||
    input.sources.some(
      ({ ref, sequence }) =>
        ref.trim().length === 0 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence > input.sourceWatermark,
    )
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Thread checkpoint source range is invalid",
    );
  }
}

export class ThreadCheckpointService {
  private readonly options: ThreadCheckpointServiceOptions;

  constructor(options: ThreadCheckpointServiceOptions) {
    this.options = options;
  }

  request(input: ThreadCheckpointRequest): Promise<ThreadDistillationWork> {
    validateTrigger(input, this.options.sourceSizeThreshold);
    const ids = stableIdentities(input.threadId, input.sourceWatermark, input.policyVersion);
    return this.options.state.request({
      jobId: ids.jobId,
      generationId: ids.generationId,
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
      sourceWatermark: input.sourceWatermark,
      policyVersion: input.policyVersion,
      modelDescriptorRef: input.modelDescriptorRef,
      trigger: input.trigger,
      status: "pending",
      revision: 1,
      attemptCount: 0,
      nextRetryAt: null,
      claimedBy: null,
      claimExpiresAt: null,
      sources: [...input.sources].sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.kind.localeCompare(right.kind) ||
          left.ref.localeCompare(right.ref),
      ),
      requestedAt: this.options.now(),
      errorCode: null,
    });
  }

  async processBatch(limit: number): Promise<readonly ThreadDistillationOutput[]> {
    const ready = await this.options.state.listReady(this.options.now(), limit);
    const outputs: ThreadDistillationOutput[] = [];
    for (const candidate of ready) {
      const claimedAt = this.options.now();
      const expiresAt = new Date(
        new Date(claimedAt).valueOf() + (this.options.leaseMs ?? 30_000),
      ).toISOString();
      const work = await this.options.state.claim({
        jobId: candidate.jobId,
        workerId: this.options.workerId,
        claimedAt,
        expiresAt,
      });
      if (!work) continue;
      const output = await this.processClaimed(work);
      if (output) outputs.push(output);
    }
    return outputs;
  }

  private async processClaimed(
    work: ThreadDistillationWork,
  ): Promise<ThreadDistillationOutput | null> {
    try {
      const sources = await Promise.all(
        work.sources.map(async (source) => ({
          ...source,
          text: await this.options.readSourceText(source.ref),
        })),
      );
      for (const source of sources) {
        if (scanMachineSecrets(source.text).length > 0) {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "Thread checkpoint source contains machine-secret material",
          );
        }
      }
      const result = await this.options.model.distill({
        threadId: work.threadId,
        sourceWatermark: work.sourceWatermark,
        policyVersion: work.policyVersion,
        modelDescriptorRef: work.modelDescriptorRef,
        sources,
      });
      const sourceClassificationByRef = new Map(
        work.sources.map(({ ref, dataClassification }) => [ref, dataClassification]),
      );
      const summaryClassificationFloor = Math.max(
        ...work.sources.map(({ dataClassification }) => CLASSIFICATION_RANK[dataClassification]),
      );
      if (
        result.summaryText.trim().length === 0 ||
        scanMachineSecrets(result.summaryText).length > 0 ||
        CLASSIFICATION_RANK[result.summaryClassification] < summaryClassificationFloor ||
        result.candidates.some(
          (candidate) =>
            candidate.text.trim().length === 0 ||
            scanMachineSecrets(candidate.text).length > 0 ||
            candidate.sourceRefs.length === 0 ||
            candidate.sourceRefs.some((ref) => !sourceClassificationByRef.has(ref)) ||
            CLASSIFICATION_RANK[candidate.dataClassification] <
              Math.max(
                ...candidate.sourceRefs.map(
                  (ref) => CLASSIFICATION_RANK[sourceClassificationByRef.get(ref) ?? "restricted"],
                ),
              ),
        )
      ) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Thread distillation output is empty or contains machine-secret material",
        );
      }
      const sourceSequences = work.sources.map(({ sequence }) => sequence);
      const summaryRef = await this.options.content.store({
        contentKey: `${work.generationId}:summary`,
        ownerId: work.ownerId,
        agentId: work.agentId,
        text: result.summaryText,
        dataClassification: result.summaryClassification,
        sourceRef: work.jobId,
        createdAt: this.options.now(),
      });
      const summary: ThreadSummaryRecord = {
        id: `summary:${work.generationId}`,
        generationId: work.generationId,
        ownerId: work.ownerId,
        agentId: work.agentId,
        threadId: work.threadId,
        contentRef: summaryRef,
        dataClassification: result.summaryClassification,
        sourceStartSequence: Math.min(...sourceSequences),
        sourceEndSequence: Math.max(...sourceSequences),
        sourceWatermark: work.sourceWatermark,
        policyVersion: work.policyVersion,
        modelDescriptorRef: work.modelDescriptorRef,
        createdAt: this.options.now(),
      };
      const candidates: ThreadDerivativeCandidateRecord[] = [];
      for (const [ordinal, candidate] of result.candidates.entries()) {
        const sensitive =
          candidate.dataClassification === "sensitive" ||
          candidate.dataClassification === "restricted";
        const contentRef = sensitive
          ? null
          : await this.options.content.store({
              contentKey: `${work.generationId}:candidate:${ordinal}`,
              ownerId: work.ownerId,
              agentId: work.agentId,
              text: candidate.text,
              dataClassification: candidate.dataClassification,
              sourceRef: work.jobId,
              createdAt: this.options.now(),
            });
        candidates.push({
          id: `derivative:${work.generationId}:${ordinal}`,
          generationId: work.generationId,
          ordinal,
          kind: candidate.kind,
          contentRef,
          dataClassification: candidate.dataClassification,
          status: sensitive ? "awaiting_sensitive_approval" : "candidate",
          sourceRefs: [...new Set(candidate.sourceRefs)].sort(),
          policyVersion: work.policyVersion,
          modelDescriptorRef: work.modelDescriptorRef,
          createdAt: this.options.now(),
        });
      }
      return await this.options.state.commit({
        jobId: work.jobId,
        workerId: this.options.workerId,
        summary,
        candidates,
      });
    } catch (error) {
      const existing = await this.options.state.readOutput(work.generationId);
      if (existing) return existing;
      const terminal = work.attemptCount >= (this.options.maximumAttempts ?? 5);
      const errorCode =
        error instanceof ApplicationPortError ? error.code : "THREAD_DISTILLATION_FAILED";
      await this.options.state.retry({
        jobId: work.jobId,
        workerId: this.options.workerId,
        errorCode,
        nextRetryAt: terminal
          ? null
          : new Date(
              new Date(this.options.now()).valueOf() + 2 ** work.attemptCount * 1000,
            ).toISOString(),
      });
      return null;
    }
  }
}
