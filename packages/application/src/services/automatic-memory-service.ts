import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type ApprovedMemoryContentPort,
  type ExtractedMemoryCandidate,
  type IncrementalMemoryExtractionPort,
  type IncrementalMemoryProductPort,
  type MemoryExtractionAuditPort,
  type MemoryExtractionAuditRecord,
  type ProductMemoryProposal,
  type SensitiveMemoryApprovalRequest,
  type SensitiveMemoryApprovalStatePort,
} from "../ports/index.js";
import { scanMachineSecrets } from "./machine-secret-exclusion.js";

export interface AutomaticMemoryServiceOptions {
  readonly extraction: IncrementalMemoryExtractionPort;
  readonly product: IncrementalMemoryProductPort;
  readonly content: ApprovedMemoryContentPort;
  readonly approvals: SensitiveMemoryApprovalStatePort;
  readonly audit: MemoryExtractionAuditPort;
  readonly readSourceText: (sourceRef: string) => Promise<string>;
  readonly now: () => string;
  readonly memoryIdFor: (generationId: MemoryGenerationId, candidateOrdinal: number) => MemoryId;
  readonly approvalIdFor: (generationId: MemoryGenerationId, candidateOrdinal: number) => string;
  readonly automaticConfidencePermille?: number;
}

export interface CommittedRunMemoryInput {
  readonly ownerId: SensitiveMemoryApprovalRequest["ownerId"];
  readonly agentId: SensitiveMemoryApprovalRequest["agentId"];
  readonly runId: SensitiveMemoryApprovalRequest["runId"];
  readonly threadId: SensitiveMemoryApprovalRequest["threadId"];
  readonly generationId: MemoryGenerationId;
  readonly sourceRef: string;
  readonly sourceClassification: SensitiveMemoryApprovalRequest["sourceClassification"];
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly interactive: boolean;
  readonly explicitRememberCandidateOrdinal: number | null;
}

export interface AutomaticMemoryResult {
  readonly status: "completed" | "source_secret_excluded" | "extraction_failed";
  readonly committedMemoryIds: readonly MemoryId[];
  readonly approvalRequestIds: readonly string[];
  readonly excludedCandidateOrdinals: readonly number[];
}

export type SensitiveMemoryResolution =
  | { readonly requestId: string; readonly resolution: "approved" | "rejected" | "expired" }
  | { readonly requestId: string; readonly resolution: "edited"; readonly editedText: string };

function isSensitive(candidate: ExtractedMemoryCandidate): candidate is ExtractedMemoryCandidate & {
  readonly dataClassification: "sensitive" | "restricted";
} {
  return (
    candidate.dataClassification === "sensitive" || candidate.dataClassification === "restricted"
  );
}

export class AutomaticMemoryService {
  private readonly options: AutomaticMemoryServiceOptions;

  constructor(options: AutomaticMemoryServiceOptions) {
    this.options = options;
  }

  async processCommittedRun(input: CommittedRunMemoryInput): Promise<AutomaticMemoryResult> {
    const sourceText = await this.options.readSourceText(input.sourceRef);
    const sourceFindings = scanMachineSecrets(sourceText);
    if (sourceFindings.length > 0) {
      await this.audit(input, null, "source_secret_excluded", sourceFindings);
      return {
        status: "source_secret_excluded",
        committedMemoryIds: [],
        approvalRequestIds: [],
        excludedCandidateOrdinals: [],
      };
    }
    let candidates: readonly ExtractedMemoryCandidate[];
    try {
      candidates = await this.options.extraction.extract({
        sourceText,
        sourceRef: input.sourceRef,
        sourceClassification: input.sourceClassification,
        policyVersion: input.policyVersion,
        modelDescriptorRef: input.modelDescriptorRef,
      });
    } catch {
      await this.audit(input, null, "extraction_failed", []);
      return {
        status: "extraction_failed",
        committedMemoryIds: [],
        approvalRequestIds: [],
        excludedCandidateOrdinals: [],
      };
    }

    const committedMemoryIds: MemoryId[] = [];
    const approvalRequestIds: string[] = [];
    const excludedCandidateOrdinals: number[] = [];
    for (const [candidateOrdinal, candidate] of candidates.entries()) {
      const candidateFindings = scanMachineSecrets(candidate.text);
      if (candidateFindings.length > 0) {
        excludedCandidateOrdinals.push(candidateOrdinal);
        await this.audit(input, candidateOrdinal, "candidate_secret_excluded", candidateFindings);
        continue;
      }
      if (candidate.kind === "transient") {
        await this.audit(input, candidateOrdinal, "transient_ignored", []);
        continue;
      }
      const explicitlyApproved = input.explicitRememberCandidateOrdinal === candidateOrdinal;
      if (isSensitive(candidate) && !explicitlyApproved) {
        const request = await this.requestApproval(input, candidate, candidateOrdinal);
        approvalRequestIds.push(request.id);
        await this.audit(
          input,
          candidateOrdinal,
          input.interactive ? "approval_requested" : "background_reference_queued",
          [],
        );
        continue;
      }
      if (
        !explicitlyApproved &&
        candidate.confidencePermille < (this.options.automaticConfidencePermille ?? 850)
      ) {
        await this.audit(input, candidateOrdinal, "confidence_below_threshold", []);
        continue;
      }
      const committed = await this.commitCandidate(input, candidate, candidateOrdinal);
      committedMemoryIds.push(committed);
      await this.audit(
        input,
        candidateOrdinal,
        explicitlyApproved ? "explicitly_approved" : "auto_committed",
        [],
      );
    }
    return {
      status: "completed",
      committedMemoryIds,
      approvalRequestIds,
      excludedCandidateOrdinals,
    };
  }

  async resolveSensitive(input: SensitiveMemoryResolution): Promise<MemoryId | null> {
    const request = await this.options.approvals.read(input.requestId);
    if (!request) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Sensitive Memory approval ${input.requestId} not found`,
      );
    }
    if (request.status === "committed") return request.productMemoryId;
    if (input.resolution === "rejected" || input.resolution === "expired") {
      const resolved = await this.options.approvals.resolve({
        requestId: request.id,
        resolution: input.resolution,
        decidedAt: this.options.now(),
      });
      await this.options.audit.record({
        sourceRef: request.sourceRef,
        generationId: request.generationId,
        policyVersion: request.policyVersion,
        modelDescriptorRef: request.modelDescriptorRef,
        candidateOrdinal: request.candidateOrdinal,
        classification: request.dataClassification,
        outcome: resolved.status === "rejected" ? "approval_rejected" : "approval_expired",
        secretFindings: [],
        occurredAt: this.options.now(),
      });
      return null;
    }
    let resolved = request;
    if (request.status === "pending") {
      resolved = await this.options.approvals.resolve({
        requestId: request.id,
        resolution: input.resolution,
        decidedAt: this.options.now(),
      });
    } else if (request.status !== "approved" && request.status !== "edited") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Sensitive Memory approval ${request.id} is ${request.status}`,
      );
    }
    const sourceText = await this.options.readSourceText(request.sourceRef);
    const sourceFindings = scanMachineSecrets(sourceText);
    if (sourceFindings.length > 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Approved Memory source now contains machine-secret material",
      );
    }
    const candidates = await this.options.extraction.extract({
      sourceText,
      sourceRef: request.sourceRef,
      sourceClassification: request.sourceClassification,
      policyVersion: request.policyVersion,
      modelDescriptorRef: request.modelDescriptorRef,
    });
    const candidate = candidates[request.candidateOrdinal];
    if (!candidate || !isSensitive(candidate)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Sensitive Memory candidate cannot be deterministically re-extracted",
      );
    }
    const text = input.resolution === "edited" ? input.editedText : candidate.text;
    if (text.trim().length === 0 || scanMachineSecrets(text).length > 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Approved Memory content is empty or contains machine-secret material",
      );
    }
    const committed = await this.commitCandidate(
      {
        ownerId: request.ownerId,
        agentId: request.agentId,
        runId: request.runId,
        threadId: request.threadId,
        generationId: request.generationId,
        sourceRef: request.sourceRef,
        sourceClassification: request.sourceClassification,
        policyVersion: request.policyVersion,
        modelDescriptorRef: request.modelDescriptorRef,
        interactive: resolved.deliveryState === "deliverable",
        explicitRememberCandidateOrdinal: null,
      },
      { ...candidate, text },
      request.candidateOrdinal,
      request.productMemoryId,
    );
    await this.options.approvals.markCommitted({
      requestId: request.id,
      committedAt: this.options.now(),
    });
    await this.options.audit.record({
      sourceRef: request.sourceRef,
      generationId: request.generationId,
      policyVersion: request.policyVersion,
      modelDescriptorRef: request.modelDescriptorRef,
      candidateOrdinal: request.candidateOrdinal,
      classification: request.dataClassification,
      outcome: "approval_committed",
      secretFindings: [],
      occurredAt: this.options.now(),
    });
    return committed;
  }

  private async requestApproval(
    input: CommittedRunMemoryInput,
    candidate: ExtractedMemoryCandidate & {
      readonly dataClassification: "sensitive" | "restricted";
    },
    candidateOrdinal: number,
  ): Promise<SensitiveMemoryApprovalRequest> {
    return this.options.approvals.create({
      id: this.options.approvalIdFor(input.generationId, candidateOrdinal),
      ownerId: input.ownerId,
      agentId: input.agentId,
      runId: input.runId,
      threadId: input.threadId,
      generationId: input.generationId,
      sourceRef: input.sourceRef,
      sourceClassification: input.sourceClassification,
      candidateOrdinal,
      productMemoryId:
        candidate.existingMemoryId ??
        this.options.memoryIdFor(input.generationId, candidateOrdinal),
      decision: candidate.decision,
      existingMemoryId: candidate.existingMemoryId,
      dataClassification: candidate.dataClassification,
      policyVersion: input.policyVersion,
      modelDescriptorRef: input.modelDescriptorRef,
      status: "pending",
      deliveryState: input.interactive ? "deliverable" : "queued_no_ui",
      requestedAt: this.options.now(),
      decidedAt: null,
      committedAt: null,
    });
  }

  private async commitCandidate(
    input: CommittedRunMemoryInput,
    candidate: ExtractedMemoryCandidate,
    candidateOrdinal: number,
    forcedMemoryId?: MemoryId,
  ): Promise<MemoryId> {
    if (candidate.decision === "unchanged") {
      if (!candidate.existingMemoryId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "An unchanged Memory candidate requires an existing product ID",
        );
      }
      const record = await this.options.product.applyProposal(
        { decision: "unchanged", memoryId: candidate.existingMemoryId },
        input.generationId,
      );
      return record.id;
    }
    const contentRef = await this.options.content.store({
      contentKey: `${input.generationId}:${candidateOrdinal}`,
      ownerId: input.ownerId,
      agentId: input.agentId,
      text: candidate.text,
      dataClassification: candidate.dataClassification,
      sourceRef: input.sourceRef,
      createdAt: this.options.now(),
    });
    let proposal: ProductMemoryProposal;
    if (candidate.decision === "create") {
      proposal = {
        decision: "create",
        memory: {
          id: forcedMemoryId ?? this.options.memoryIdFor(input.generationId, candidateOrdinal),
          ownerId: input.ownerId,
          agentId: input.agentId,
          contentRef,
          dataClassification: candidate.dataClassification,
          sourceThreadId: input.threadId,
          sourceRefs: [...new Set([input.sourceRef, ...candidate.sourceRefs])].sort(),
          inference: candidate.inference,
          confidencePermille: candidate.confidencePermille,
          policyVersion: input.policyVersion,
        },
      };
    } else {
      if (!candidate.existingMemoryId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `${candidate.decision} requires an existing product Memory ID`,
        );
      }
      proposal = {
        decision: candidate.decision,
        memoryId: candidate.existingMemoryId,
        contentRef,
        sourceRefs: [...new Set([input.sourceRef, ...candidate.sourceRefs])].sort(),
        dataClassification: candidate.dataClassification,
        inference: candidate.inference,
        confidencePermille: candidate.confidencePermille,
        policyVersion: input.policyVersion,
      };
    }
    return (await this.options.product.applyProposal(proposal, input.generationId)).id;
  }

  private audit(
    input: CommittedRunMemoryInput,
    candidateOrdinal: number | null,
    outcome: MemoryExtractionAuditRecord["outcome"],
    secretFindings: MemoryExtractionAuditRecord["secretFindings"],
  ): Promise<void> {
    return this.options.audit.record({
      sourceRef: input.sourceRef,
      generationId: input.generationId,
      policyVersion: input.policyVersion,
      modelDescriptorRef: input.modelDescriptorRef,
      candidateOrdinal,
      classification: input.sourceClassification,
      outcome,
      secretFindings,
      occurredAt: this.options.now(),
    });
  }
}
