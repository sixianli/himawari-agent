import {
  ApplicationPortError,
  type ClockPort,
  type DecisionLedgerPort,
  type DecisionLedgerWrite,
  type DurableMemoryService,
  EXTERNAL_PROPOSAL_REASON_CODES,
  type MemoryBookStorePort,
  type MemoryCategory,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryStatePort,
  type SensitiveMemoryTopic,
} from "@himawari-agent/application";
import { MEMORY_SENSITIVE_CATEGORY_NAMES } from "@himawari-agent/gateway-contracts";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";

type MemoryId = Parameters<ProductMemoryStatePort["read"]>[0];
type GenerationId = NonNullable<Awaited<ReturnType<MemoryBookStorePort["latestGeneration"]>>>;

export const EXTERNAL_PROPOSAL_MEMORY_PREFIX = "memory:mcp:";
export const EXTERNAL_PROPOSAL_CONTENT_PREFIX = "memory-content:mcp:";
export const EXTERNAL_PROPOSAL_POLICY_VERSION = "memory-mcp:v1";
export const EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000;
export const EXTERNAL_PROPOSAL_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "health",
  "finance",
  "event",
  "other",
] as const satisfies readonly MemoryCategory[];
const EXTERNAL_PROPOSAL_IMPORTANCE = 500;
const INVISIBLE_FORMATTING = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

export type ExternalProposalCategory = (typeof EXTERNAL_PROPOSAL_CATEGORIES)[number];

export type ExternalProposalDecision = "kept" | "declined";

export interface ExternalMemoryProposal {
  readonly proposalId: string;
  readonly text: string;
  readonly category: ExternalProposalCategory;
  readonly client: string;
}

export function normalizeProposalText(text: string): string {
  return text.normalize("NFC").replace(INVISIBLE_FORMATTING, " ").replace(/ {2,}/gu, " ").trim();
}

export function proposalClassification(
  text: string,
  category: ExternalProposalCategory,
): "private" | "sensitive" {
  return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category)
    ? "sensitive"
    : classificationWithIdentifiers(text, "private");
}

function sensitiveTopicFor(category: ExternalProposalCategory): SensitiveMemoryTopic {
  return category === "health" || category === "finance" ? category : "other";
}

export function externalProposalMemoryId(proposalId: string): string {
  return `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${proposalId}`;
}

function ledgerId(proposalId: string, decision: ExternalProposalDecision): string {
  return `ledger:mcp-proposal:${proposalId}:${decision}`;
}

export interface ProductionMcpMemoryWriterOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly memory: Pick<DurableMemoryService, "applyProposal">;
  readonly state: Pick<ProductMemoryStatePort, "read">;
  readonly book: Pick<MemoryBookStorePort, "latestGeneration">;
  readonly ledger: Pick<DecisionLedgerPort, "append" | "read">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
}

export class ProductionMcpMemoryWriter {
  readonly #options: ProductionMcpMemoryWriterOptions;

  constructor(options: ProductionMcpMemoryWriterOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async ready(): Promise<boolean> {
    return (await this.#options.book.latestGeneration(this.#scope())) !== undefined;
  }

  async decided(proposalId: string): Promise<ExternalProposalDecision | undefined> {
    for (const decision of ["kept", "declined"] as const)
      if (
        await this.#options.ledger.read({
          ...this.#scope(),
          decisionId: ledgerId(proposalId, decision),
        })
      )
        return decision;
    const existing = await this.#options.state.read(
      externalProposalMemoryId(proposalId) as MemoryId,
    );
    return existing ? "kept" : undefined;
  }

  #ledgerWrite(
    proposal: ExternalMemoryProposal,
    decision: ExternalProposalDecision,
    memoryId: string | null,
    started: number,
  ): DecisionLedgerWrite {
    const decidedAt = this.#options.clock.now();
    return {
      id: ledgerId(proposal.proposalId, decision),
      ...this.#scope(),
      kind: "memory_candidate",
      decidedAt,
      outcome: decision === "kept" ? "kept" : "discarded",
      reasonCode: EXTERNAL_PROPOSAL_REASON_CODES[decision],
      subjectRef: memoryId ?? `mcp-client:${proposal.client}`,
      inputs: { memoryIds: memoryId ? [memoryId] : [], ruleIds: [] },
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: Math.max(0, Date.parse(decidedAt) - started),
      category: proposal.category,
      confidencePermille: 1000,
      inferred: false,
    };
  }

  async keep(proposal: ExternalMemoryProposal, started: number): Promise<string> {
    const memoryId = externalProposalMemoryId(proposal.proposalId);
    const contentRef = `${EXTERNAL_PROPOSAL_CONTENT_PREFIX}${proposal.proposalId}`;
    const generation: GenerationId | undefined = await this.#options.book.latestGeneration(
      this.#scope(),
    );
    if (!generation)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "MEMORY_GENERATION_MISSING",
      );
    const dataClassification = proposalClassification(proposal.text, proposal.category);
    await this.#storeText(contentRef, proposal.text, dataClassification);
    const proposalRecord = {
      decision: "create" as const,
      memory: {
        id: memoryId as MemoryId,
        ...this.#scope(),
        contentRef,
        dataClassification,
        sourceThreadId: null,
        sourceRefs: [contentRef],
        inference: false,
        confidencePermille: 1000,
        policyVersion: EXTERNAL_PROPOSAL_POLICY_VERSION,
        attributes: {
          category: proposal.category,
          importancePermille: EXTERNAL_PROPOSAL_IMPORTANCE,
          entities: [],
          validFrom: null,
          validTo: null,
          supersededBy: null,
          evidenceVerified: false,
          ...(dataClassification === "sensitive"
            ? { sensitiveTopic: sensitiveTopicFor(proposal.category) }
            : {}),
        },
      },
    };
    const write = this.#ledgerWrite(proposal, "kept", memoryId, started);
    await this.#options.memory.applyProposal(proposalRecord, generation, write);
    if (!(await this.#options.ledger.read({ ...this.#scope(), decisionId: write.id })))
      await this.#options.ledger.append(write);
    return memoryId;
  }

  async decline(proposal: ExternalMemoryProposal, started: number): Promise<void> {
    await this.#options.ledger.append(this.#ledgerWrite(proposal, "declined", null, started));
  }

  async #storeText(
    contentRef: string,
    text: string,
    dataClassification: "private" | "sensitive",
  ): Promise<void> {
    const existing = await this.#options.payloads.get(contentRef);
    if (existing) {
      if (existing.dataClassification !== dataClassification)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_CONTENT_CHANGED");
      return;
    }
    try {
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope(),
          ref: contentRef,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: this.#options.clock.now(),
        }),
      );
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
        throw error;
    }
  }
}
