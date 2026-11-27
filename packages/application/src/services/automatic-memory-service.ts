import {
  MEMORY_AUTO_COMMIT_GATE,
  MEMORY_TENTATIVE_CONFIRM_GATE,
  type ThresholdGate,
  thresholdFor,
} from "@himawari-agent/calibration";
import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  ApplicationPortError,
  type ApprovedMemoryContentPort,
  DEFAULT_MEMORY_ATTRIBUTES,
  type DecisionLedgerPort,
  type DecisionLedgerWrite,
  type ExtractedMemoryCandidate,
  type IncrementalMemoryExtractionPort,
  type IncrementalMemoryProductPort,
  type MemoryExtractionAuditPort,
  type MemoryExtractionAuditRecord,
  PORT_ERROR_CODES,
  type ProductMemoryProposal,
  type SensitiveMemoryApprovalRequest,
  type SensitiveMemoryApprovalStatePort,
  type SensitiveMemoryCandidatePort,
} from "../ports/index.js";

export interface AutomaticMemoryServiceOptions {
  readonly extraction: IncrementalMemoryExtractionPort;
  readonly product: IncrementalMemoryProductPort;
  readonly content: ApprovedMemoryContentPort;
  readonly approvals: SensitiveMemoryApprovalStatePort;
  readonly candidates?: SensitiveMemoryCandidatePort;
  readonly audit: MemoryExtractionAuditPort;
  readonly ledger?: DecisionLedgerPort;
  readonly readSourceText: (sourceRef: string) => Promise<string>;
  readonly gates?: CaptureGates;
  readonly now: () => string;
  readonly memoryIdFor: (generationId: MemoryGenerationId, candidateOrdinal: number) => MemoryId;
  readonly approvalIdFor: (generationId: MemoryGenerationId, candidateOrdinal: number) => string;
  readonly onCommitted?: (input: {
    readonly candidate: ExtractedMemoryCandidate;
    readonly memoryId: MemoryId;
    readonly ownerId: CommittedRunMemoryInput["ownerId"];
    readonly agentId: CommittedRunMemoryInput["agentId"];
  }) => Promise<void>;
}

export interface CaptureGates {
  readonly autoCommit: ThresholdGate;
  readonly confirmTentative: ThresholdGate;
}

export const DEFAULT_CAPTURE_GATES: CaptureGates = Object.freeze({
  autoCommit: MEMORY_AUTO_COMMIT_GATE,
  confirmTentative: MEMORY_TENTATIVE_CONFIRM_GATE,
});

export function autoCommitThreshold(
  category: string | null,
  gates: CaptureGates = DEFAULT_CAPTURE_GATES,
): number {
  return thresholdFor(gates.autoCommit, category);
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
  readonly rejectedCandidates?: readonly ExtractedMemoryCandidate[];
}

export interface AutomaticMemoryResult {
  readonly status: "completed" | "extraction_failed";
  readonly committedMemoryIds: readonly MemoryId[];
  readonly tentativeMemoryIds: readonly MemoryId[];
  readonly approvalRequestIds: readonly string[];
  readonly excludedCandidateOrdinals: readonly number[];
}

export type SensitiveMemoryResolution =
  | { readonly requestId: string; readonly resolution: "approved" | "rejected" | "expired" }
  | { readonly requestId: string; readonly resolution: "edited"; readonly editedText: string };

type KeptReason =
  | "auto_committed"
  | "tentative_confirmed"
  | "explicitly_approved"
  | "approval_committed"
  | "kept_tentative";

function canBeKeptTentatively(candidate: ExtractedMemoryCandidate): boolean {
  return (
    candidate.decision === "create" &&
    candidate.quote !== undefined &&
    candidate.quote.length > 0 &&
    candidate.reminder === undefined &&
    (candidate.people?.length ?? 0) === 0 &&
    (candidate.personLinks?.length ?? 0) === 0
  );
}

function confirmedTentativeCategory(
  candidate: ExtractedMemoryCandidate,
): ExtractedMemoryCandidate["confirmsTentativeCategory"] {
  return candidate.decision !== "create" && candidate.existingMemoryId !== null
    ? candidate.confirmsTentativeCategory
    : undefined;
}

function ledgerId(key: string): string {
  return `ledger:${bytesToHex(sha256(utf8ToBytes(key))).slice(0, 40)}`;
}

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
        tentativeMemoryIds: [],
        approvalRequestIds: [],
        excludedCandidateOrdinals: [],
      };
    }

    const committedMemoryIds: MemoryId[] = [];
    const tentativeMemoryIds: MemoryId[] = [];
    const approvalRequestIds: string[] = [];
    const excludedCandidateOrdinals: number[] = [];
    for (const [candidateOrdinal, candidate] of candidates.entries()) {
      if (candidate.dataClassification === "restricted") {
        excludedCandidateOrdinals.push(candidateOrdinal);
        await this.audit(input, candidateOrdinal, "restricted_excluded", []);
        await this.discard(input, candidate, candidateOrdinal, "restricted_excluded", false);
        continue;
      }
      if (candidate.kind === "transient") {
        await this.audit(input, candidateOrdinal, "transient_ignored", []);
        await this.discard(input, candidate, candidateOrdinal, "transient_ignored", true);
        continue;
      }
      const explicitlyApproved = input.explicitRememberCandidateOrdinal === candidateOrdinal;
      const confirmationCategory = confirmedTentativeCategory(candidate);
      const confirmsTentative = confirmationCategory !== undefined;
      const gates = this.options.gates ?? DEFAULT_CAPTURE_GATES;
      if (
        !explicitlyApproved &&
        candidate.confidencePermille <
          (confirmationCategory === undefined
            ? thresholdFor(gates.autoCommit, candidate.attributes?.category ?? null)
            : thresholdFor(gates.confirmTentative, confirmationCategory))
      ) {
        if (canBeKeptTentatively(candidate)) {
          const { supersedes: _dropped, ...rest } = candidate;
          const tentativeCandidate: ExtractedMemoryCandidate = {
            ...rest,
            attributes: { ...(candidate.attributes ?? DEFAULT_MEMORY_ATTRIBUTES), tentative: true },
          };
          tentativeMemoryIds.push(
            await this.commitCandidate(
              input,
              tentativeCandidate,
              candidateOrdinal,
              undefined,
              "kept_tentative",
            ),
          );
          await this.audit(input, candidateOrdinal, "tentative_kept", []);
          continue;
        }
        await this.audit(input, candidateOrdinal, "confidence_below_threshold", []);
        await this.discard(
          input,
          candidate,
          candidateOrdinal,
          confirmsTentative ? "confirm_below_threshold" : "confidence_below_threshold",
          true,
        );
        continue;
      }
      const committed = await this.commitCandidate(
        input,
        candidate,
        candidateOrdinal,
        undefined,
        explicitlyApproved
          ? "explicitly_approved"
          : confirmsTentative
            ? "tentative_confirmed"
            : "auto_committed",
      );
      committedMemoryIds.push(committed);
      await this.audit(
        input,
        candidateOrdinal,
        explicitlyApproved ? "explicitly_approved" : "auto_committed",
        [],
      );
    }
    for (const [index, candidate] of (input.rejectedCandidates ?? []).entries()) {
      const candidateOrdinal = candidates.length + index;
      await this.discard(
        input,
        candidate,
        candidateOrdinal,
        "evidence_unverified",
        candidate.dataClassification !== "restricted",
      );
    }
    return {
      status: "completed",
      committedMemoryIds,
      tentativeMemoryIds,
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
        ownerId: request.ownerId,
        agentId: request.agentId,
        threadId: request.threadId,
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
      const pendingCandidate = this.options.ledger
        ? await this.options.candidates?.read(request)
        : undefined;
      await this.options.ledger?.append(
        this.candidateLedger(
          {
            ownerId: request.ownerId,
            agentId: request.agentId,
            generationId: request.generationId,
          },
          request.candidateOrdinal,
          "discarded",
          resolved.status === "rejected" ? "approval_rejected" : "approval_expired",
          { subjectRef: request.id, contentRef: null, memoryIds: [], candidate: pendingCandidate },
        ),
      );
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
    const candidate = this.options.candidates
      ? await this.options.candidates.read(request)
      : (
          await this.options.extraction.extract({
            sourceText,
            sourceRef: request.sourceRef,
            sourceClassification: request.sourceClassification,
            policyVersion: request.policyVersion,
            modelDescriptorRef: request.modelDescriptorRef,
          })
        )[request.candidateOrdinal];
    if (!candidate || !isSensitive(candidate)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Sensitive Memory candidate cannot be deterministically re-extracted",
      );
    }
    const text = input.resolution === "edited" ? input.editedText : candidate.text;
    if (text.trim().length === 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Approved Memory content is empty",
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
      {
        ...candidate,
        text,
        dataClassification:
          candidate.dataClassification === "sensitive" &&
          (request.sourceClassification === "public" || request.sourceClassification === "private")
            ? "private"
            : candidate.dataClassification,
        attributes: {
          ...(candidate.attributes ?? DEFAULT_MEMORY_ATTRIBUTES),
          sensitiveTopic: candidate.sensitiveTopic ?? "other",
        },
      },
      request.candidateOrdinal,
      request.productMemoryId,
      "approval_committed",
    );
    await this.options.approvals.markCommitted({
      requestId: request.id,
      committedAt: this.options.now(),
    });
    await this.options.audit.record({
      ownerId: request.ownerId,
      agentId: request.agentId,
      threadId: request.threadId,
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

  private async commitCandidate(
    input: CommittedRunMemoryInput,
    candidate: ExtractedMemoryCandidate,
    candidateOrdinal: number,
    forcedMemoryId: MemoryId | undefined,
    keptReason: KeptReason,
  ): Promise<MemoryId> {
    const quoteRef = candidate.quote
      ? await this.options.content.store({
          contentKey: `${input.generationId}:${candidateOrdinal}:quote`,
          ownerId: input.ownerId,
          agentId: input.agentId,
          text: candidate.quote,
          dataClassification: candidate.dataClassification,
          sourceRef: input.sourceRef,
          createdAt: this.options.now(),
        })
      : null;
    if (candidate.decision === "unchanged") {
      if (!candidate.existingMemoryId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "An unchanged Memory candidate requires an existing product ID",
        );
      }
      const record = await this.options.product.applyProposal(
        {
          decision: "unchanged",
          memoryId: candidate.existingMemoryId,
          quoteRef,
          sourceThreadId: input.threadId,
        },
        input.generationId,
      );
      await this.options.ledger?.append(
        this.candidateLedger(input, candidateOrdinal, "kept", keptReason, {
          subjectRef: record.id,
          contentRef: null,
          memoryIds: [record.id],
          candidate,
        }),
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
          ...(candidate.attributes ? { attributes: candidate.attributes } : {}),
        },
        ...(candidate.supersedes ? { supersedes: candidate.supersedes } : {}),
        quoteRef,
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
        ...(candidate.attributes ? { attributes: candidate.attributes } : {}),
        quoteRef,
        sourceThreadId: input.threadId,
      };
    }
    const targetId = proposal.decision === "create" ? proposal.memory.id : proposal.memoryId;
    const supersedes = proposal.decision === "create" ? proposal.supersedes : undefined;
    const ledger = this.options.ledger
      ? this.candidateLedger(input, candidateOrdinal, "kept", keptReason, {
          subjectRef: targetId,
          contentRef,
          memoryIds: [targetId, ...(supersedes ? [supersedes] : [])],
          candidate,
        })
      : undefined;
    const memoryId = (
      await this.options.product.applyProposal(proposal, input.generationId, ledger)
    ).id;
    if (keptReason !== "kept_tentative")
      await this.options.onCommitted?.({
        candidate,
        memoryId,
        ownerId: input.ownerId,
        agentId: input.agentId,
      });
    return memoryId;
  }

  private candidateLedger(
    input: Pick<CommittedRunMemoryInput, "ownerId" | "agentId" | "generationId">,
    candidateOrdinal: number,
    outcome: "kept" | "discarded" | "pending_approval",
    reasonCode: string,
    detail: {
      readonly subjectRef: string;
      readonly contentRef: string | null;
      readonly memoryIds: readonly string[];
      readonly candidate?: ExtractedMemoryCandidate | undefined;
    },
  ): DecisionLedgerWrite {
    return {
      id: ledgerId(`${input.generationId}:${candidateOrdinal}:${outcome}:${reasonCode}`),
      ownerId: input.ownerId,
      agentId: input.agentId,
      kind: "memory_candidate",
      decidedAt: this.options.now(),
      outcome,
      reasonCode,
      subjectRef: detail.subjectRef,
      inputs: { memoryIds: [...new Set(detail.memoryIds)], ruleIds: [] },
      reasonRef: null,
      contentRef: detail.contentRef,
      costMicros: 0,
      durationMs: 0,
      category:
        (detail.candidate ? confirmedTentativeCategory(detail.candidate) : undefined) ??
        detail.candidate?.attributes?.category ??
        null,
      confidencePermille: detail.candidate?.confidencePermille ?? null,
      inferred: detail.candidate?.inference ?? null,
    };
  }

  private async discard(
    input: CommittedRunMemoryInput,
    candidate: ExtractedMemoryCandidate,
    candidateOrdinal: number,
    reasonCode: MemoryExtractionAuditRecord["outcome"] | "confirm_below_threshold",
    keepText: boolean,
  ): Promise<void> {
    if (!this.options.ledger) return;
    const contentRef = keepText
      ? await this.options.content.store({
          contentKey: `${input.generationId}:${candidateOrdinal}:discarded`,
          ownerId: input.ownerId,
          agentId: input.agentId,
          text: candidate.text,
          dataClassification: candidate.dataClassification,
          sourceRef: input.sourceRef,
          createdAt: this.options.now(),
        })
      : null;
    const write = this.candidateLedger(input, candidateOrdinal, "discarded", reasonCode, {
      subjectRef: `${input.generationId}:${candidateOrdinal}`,
      contentRef,
      memoryIds: candidate.existingMemoryId ? [candidate.existingMemoryId] : [],
      candidate,
    });
    await this.options.ledger.append(write);
  }

  private audit(
    input: CommittedRunMemoryInput,
    candidateOrdinal: number | null,
    outcome: MemoryExtractionAuditRecord["outcome"],
    secretFindings: MemoryExtractionAuditRecord["secretFindings"],
  ): Promise<void> {
    return this.options.audit.record({
      ownerId: input.ownerId,
      agentId: input.agentId,
      threadId: input.threadId,
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
