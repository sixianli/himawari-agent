import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  type DecisionLedgerPort,
  type DecisionLedgerWrite,
  type DurableMemoryService,
  EXTERNAL_PROPOSAL_REASON_CODES,
  type ExternalMemoryProposalRecord,
  type ExternalMemoryProposalStorePort,
  type MemoryBookStorePort,
  type MemoryCategory,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryStatePort,
  type SensitiveMemoryTopic,
} from "@himawari-agent/application";
import {
  EXTERNAL_PROPOSAL_TEXT_MAXIMUM,
  MEMORY_SENSITIVE_CATEGORY_NAMES,
} from "@himawari-agent/gateway-contracts";
import { normalizeProposalText, proposalTextDigest } from "@himawari-agent/persistence-sqlite";
export { EXTERNAL_PROPOSAL_TEXT_MAXIMUM };

import {
  classificationWithIdentifiers,
  scanMachineSecrets,
} from "@himawari-agent/sensitive-capture";

type MemoryId = Parameters<ProductMemoryStatePort["read"]>[0];
type GenerationId = NonNullable<Awaited<ReturnType<MemoryBookStorePort["latestGeneration"]>>>;

export const EXTERNAL_PROPOSAL_MEMORY_PREFIX = "memory:mcp:";
export const EXTERNAL_PROPOSAL_CONTENT_PREFIX = "memory-content:mcp:";
export const EXTERNAL_PROPOSAL_PENDING_CONTENT_PREFIX = "memory-content:mcp-proposal:";
export const EXTERNAL_PROPOSAL_POLICY_VERSION = "memory-mcp:v1";
export const EXTERNAL_PROPOSAL_NORMALIZATION = "mcp-text:v1";
export const EXTERNAL_PROPOSAL_SUBJECT_MAXIMUM = 128;
export const EXTERNAL_PROPOSAL_KEY_MAXIMUM = 200;
export const EXTERNAL_PROPOSAL_ID_MAXIMUM = 40;

const CLASSIFICATION_RANK: readonly string[] = ["public", "private", "sensitive", "restricted"];
export const EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS = 30;
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
const DAY_MS = 86_400_000;

export type ExternalProposalCategory = (typeof EXTERNAL_PROPOSAL_CATEGORIES)[number];

export type ExternalProposalDecision = "kept" | "declined" | "pending" | "superseded";

export interface ExternalMemoryProposal {
  readonly proposalId: string;
  readonly text: string;
  readonly category: ExternalProposalCategory;
  readonly client: string;
}

export interface ExternalProposalSubmission {
  readonly proposalId: string;
  readonly text: string;
  readonly category: ExternalProposalCategory;
  readonly client: string;
  readonly subjectRef: string;
  readonly sourceKey: string | null;
}

export interface ExternalProposalDecisionInput {
  readonly batchId: string | null;
  readonly editedText?: string;
  readonly started: number;
}

export { normalizeProposalText, proposalTextDigest };

export function proposalHasMachineSecret(text: string): boolean {
  return scanMachineSecrets(text).length > 0;
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

export function externalProposalBatchId(idempotencyKey: string): string {
  return `batch-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

export function externalProposalMemoryId(proposalId: string, batchId: string | null): string {
  return batchId === null
    ? `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${proposalId}`
    : `${EXTERNAL_PROPOSAL_MEMORY_PREFIX}${proposalId}:${batchId}`;
}

function ledgerId(
  proposalId: string,
  batchId: string | null,
  decision: keyof typeof EXTERNAL_PROPOSAL_REASON_CODES,
): string {
  return batchId === null
    ? `ledger:mcp-proposal:${proposalId}:${decision}`
    : `ledger:mcp-proposal:${proposalId}:${batchId}:${decision}`;
}

export interface ExternalProposalDigestCache {
  digests?: Map<string, string>;
  memoryChanges?: number;
}

export interface ProductionMcpMemoryWriterOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly memory: Pick<DurableMemoryService, "applyProposal">;
  readonly state: Pick<ProductMemoryStatePort, "read" | "listActive">;
  readonly book: Pick<MemoryBookStorePort, "latestGeneration">;
  readonly ledger: Pick<DecisionLedgerPort, "append" | "read">;
  readonly proposals: ExternalMemoryProposalStorePort;
  readonly replaced?: (proposalId: string) => Promise<string | null>;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
}

export class ProductionMcpMemoryWriter {
  readonly #options: ProductionMcpMemoryWriterOptions;
  #queue: Promise<void> = Promise.resolve();
  #memoryChanges = 0;

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

  async submit(input: ExternalProposalSubmission): Promise<{
    readonly proposal: ExternalMemoryProposalRecord;
    readonly created: boolean;
    readonly superseded: readonly string[];
  }> {
    return this.#serially(() => this.#submit(input));
  }

  async #submit(input: ExternalProposalSubmission): Promise<{
    readonly proposal: ExternalMemoryProposalRecord;
    readonly created: boolean;
    readonly superseded: readonly string[];
  }> {
    const receivedAt = this.#options.clock.now();
    await this.#dropExpiredDiscardedText();
    const text = normalizeProposalText(input.text);
    const sourceKey = input.sourceKey === null ? null : normalizeProposalText(input.sourceKey);
    if (
      text.length === 0 ||
      text.length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM ||
      proposalHasMachineSecret(text) ||
      !(EXTERNAL_PROPOSAL_CATEGORIES as readonly string[]).includes(input.category) ||
      input.client.length < 1 ||
      input.client.length > 64 ||
      input.proposalId.length < 1 ||
      input.proposalId.length > EXTERNAL_PROPOSAL_ID_MAXIMUM ||
      (sourceKey !== null &&
        (sourceKey.length === 0 ||
          [...sourceKey].length > EXTERNAL_PROPOSAL_KEY_MAXIMUM ||
          proposalHasMachineSecret(sourceKey)))
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
    const textSha256 = proposalTextDigest(text);
    const dataClassification = proposalClassification(text, input.category);
    const scope = this.#scope();
    const contentRef = `${EXTERNAL_PROPOSAL_PENDING_CONTENT_PREFIX}${createHash("sha256")
      .update(
        `${scope.ownerId}\u0000${scope.agentId}\u0000${dataClassification}\u0000${textSha256}`,
      )
      .digest("hex")}`;
    await this.#storeText(contentRef, text, dataClassification);
    const submitted = await this.#options.proposals.submit({
      ...scope,
      id: input.proposalId,
      subjectRef:
        input.subjectRef.length >= 1 && input.subjectRef.length <= EXTERNAL_PROPOSAL_SUBJECT_MAXIMUM
          ? input.subjectRef
          : `sha256:${createHash("sha256").update(input.subjectRef).digest("hex")}`,
      client: input.client,
      sourceKey,
      textSha256,
      normalization: EXTERNAL_PROPOSAL_NORMALIZATION,
      contentRef,
      category: input.category,
      dataClassification,
      receivedAt,
    });
    if (submitted.created || submitted.proposal.status === "pending") {
      await this.#appendOnce(
        this.#ledgerWrite(
          submitted.proposal,
          null,
          "pending",
          null,
          Date.parse(submitted.proposal.receivedAt),
        ),
      );
    }
    for (const id of submitted.superseded) {
      const replaced = await this.#options.proposals.read({ ...scope, id });
      if (replaced)
        await this.#appendOnce(
          this.#ledgerWrite(replaced, null, "superseded", null, Date.parse(receivedAt)),
        );
    }
    return {
      proposal: submitted.proposal,
      created: submitted.created,
      superseded: submitted.superseded,
    };
  }

  async decided(proposalId: string): Promise<ExternalProposalDecision | undefined> {
    const found = await this.#options.proposals.read({ ...this.#scope(), id: proposalId });
    if (!found) return undefined;
    if (found.status === "committed") return "kept";
    if (found.status === "rejected") return "declined";
    return found.status;
  }

  async read(proposalId: string): Promise<ExternalMemoryProposalRecord | undefined> {
    return this.#options.proposals.read({ ...this.#scope(), id: proposalId });
  }

  async readText(proposal: Pick<ExternalMemoryProposalRecord, "contentRef">): Promise<string> {
    const payload = proposal.contentRef
      ? await this.#options.payloads.get(proposal.contentRef)
      : undefined;
    if (!payload)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_PROPOSAL_TEXT_MISSING");
    return new TextDecoder().decode(
      await this.#options.protector.unprotect({ ...this.#scope(), payload }),
    );
  }

  async keep(
    proposalId: string,
    input: ExternalProposalDecisionInput,
    digestCache?: ExternalProposalDigestCache,
  ): Promise<string> {
    return this.#serially(async () => {
      const proposal = await this.#pending(proposalId);
      if (proposal.status === "committed" && proposal.memoryId) return proposal.memoryId;
      if (proposal.status !== "pending")
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_ALREADY_DECIDED");
      const text = normalizeProposalText(input.editedText ?? (await this.readText(proposal)));
      if (text.length === 0 || text.length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM)
        throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
      if (proposalHasMachineSecret(text))
        throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
      const digests = await this.#digests(digestCache);
      const linked = digests.get(proposalTextDigest(text));
      const existing = linked ? await this.#options.state.read(linked as MemoryId) : undefined;
      const same =
        linked &&
        existing?.status === "active" &&
        CLASSIFICATION_RANK.indexOf(existing.dataClassification) >=
          CLASSIFICATION_RANK.indexOf(
            proposal.dataClassification === "sensitive"
              ? "sensitive"
              : proposalClassification(text, proposal.category),
          )
          ? linked
          : undefined;
      if (same) {
        await this.#commit(proposal, same, input);
        return same;
      }
      const memoryId = externalProposalMemoryId(proposal.id, input.batchId) as MemoryId;
      const write = this.#ledgerWrite(proposal, input.batchId, "kept", memoryId, input.started);
      const stored = await this.#options.state.read(memoryId);
      if (stored && stored.status !== "active" && stored.status !== "archived")
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_MEMORY_REMOVED");
      if (!stored) {
        const contentRef = `${EXTERNAL_PROPOSAL_CONTENT_PREFIX}${proposal.id}${
          input.batchId === null ? "" : `:${input.batchId}`
        }`;
        const generation: GenerationId | undefined = await this.#options.book.latestGeneration(
          this.#scope(),
        );
        if (!generation)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "MEMORY_GENERATION_MISSING",
          );
        const raised = proposalClassification(text, proposal.category);
        const dataClassification =
          proposal.dataClassification === "sensitive" ? "sensitive" : raised;
        await this.#storeText(contentRef, text, dataClassification);
        const replacedId = (await this.#options.replaced?.(proposal.id)) ?? null;
        const replaced = replacedId
          ? await this.#options.state.read(replacedId as MemoryId)
          : undefined;
        await this.#options.memory.applyProposal(
          {
            decision: "create",
            ...(replaced?.status === "active" &&
            (replaced.attributes?.supersededBy ?? null) === null
              ? { supersedes: replaced.id }
              : {}),
            memory: {
              id: memoryId,
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
          },
          generation,
          write,
        );
        this.#memoryChanges += 1;
        digests.set(proposalTextDigest(text), memoryId);
        if (digestCache) digestCache.memoryChanges = this.#memoryChanges;
      }
      await this.#appendOnce(write);
      await this.#decideCommitted(proposal, memoryId, input);
      return memoryId;
    });
  }

  async #commit(
    proposal: ExternalMemoryProposalRecord,
    memoryId: string,
    input: ExternalProposalDecisionInput,
  ): Promise<void> {
    await this.#appendOnce(
      this.#ledgerWrite(proposal, input.batchId, "kept", memoryId, input.started),
    );
    await this.#decideCommitted(proposal, memoryId, input);
  }

  async #decideCommitted(
    proposal: ExternalMemoryProposalRecord,
    memoryId: string,
    input: ExternalProposalDecisionInput,
  ): Promise<void> {
    const decided = await this.#options.proposals.decide({
      ...this.#scope(),
      id: proposal.id,
      status: "committed",
      decidedAt: this.#options.clock.now(),
      batchId: input.batchId,
      memoryId: memoryId as MemoryId,
    });
    if (!decided)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_ALREADY_DECIDED");
  }

  async decline(proposalId: string, input: ExternalProposalDecisionInput): Promise<boolean> {
    return this.#serially(async () => {
      const proposal = await this.#pending(proposalId);
      if (proposal.status === "rejected") {
        await this.#appendOnce(
          this.#ledgerWrite(proposal, proposal.batchId, "declined", null, input.started),
        );
        return true;
      }
      if (proposal.status !== "pending") return false;
      const decided = await this.#options.proposals.decide({
        ...this.#scope(),
        id: proposal.id,
        status: "rejected",
        decidedAt: this.#options.clock.now(),
        batchId: input.batchId,
        memoryId: null,
      });
      if (decided)
        await this.#appendOnce(
          this.#ledgerWrite(proposal, input.batchId, "declined", null, input.started),
        );
      return decided;
    });
  }

  async pendingSummary(limit: number): Promise<{
    readonly items: readonly Pick<ExternalMemoryProposalRecord, "id" | "dataClassification">[];
    readonly total: number;
  }> {
    const { items, total } = await this.#options.proposals.listPending({ ...this.#scope(), limit });
    return {
      items: items.map(({ id, dataClassification }) => ({ id, dataClassification })),
      total,
    };
  }

  async listPending(limit: number): Promise<{
    readonly items: readonly (ExternalMemoryProposalRecord & { readonly text: string })[];
    readonly total: number;
  }> {
    return this.#serially(async () => {
      await this.#dropExpiredDiscardedText();
      const { items, total } = await this.#options.proposals.listPending({
        ...this.#scope(),
        limit,
      });
      return {
        items: await Promise.all(
          items.map(async (item) => ({ ...item, text: await this.readText(item) })),
        ),
        total,
      };
    });
  }

  async listBatches(limit: number) {
    return this.#options.proposals.listBatches({ ...this.#scope(), limit });
  }

  async listBatch(batchId: string) {
    return this.#options.proposals.listBatch({ ...this.#scope(), batchId });
  }

  async undoBatch(
    batchId: string,
    trash: (memoryId: MemoryId) => Promise<void>,
  ): Promise<readonly string[] | undefined> {
    return this.#serially(async () => {
      const members = await this.#options.proposals.listBatch({ ...this.#scope(), batchId });
      if (members.length === 0) return undefined;
      const reopen: string[] = [];
      const trashed: string[] = [];
      const settle = (complete: boolean) => {
        this.#memoryChanges += 1;
        return this.#options.proposals.reopenBatch({
          ...this.#scope(),
          batchId,
          reopen,
          trashed,
          complete,
        });
      };
      try {
        for (const member of members) {
          if (
            member.status === "committed" &&
            member.memoryId === externalProposalMemoryId(member.id, batchId)
          ) {
            await trash(member.memoryId);
            trashed.push(member.memoryId);
            reopen.push(member.id);
          }
        }
      } catch (error) {
        if (trashed.length > 0) await settle(false);
        throw error;
      }
      for (const member of members) if (member.status === "rejected") reopen.push(member.id);
      return settle(true);
    });
  }

  async respond(
    items: readonly {
      readonly proposalId: string;
      readonly decision: "keep" | "reject";
      readonly editedText: string | null;
    }[],
    batchId: string,
  ): Promise<{ readonly decided: number; readonly failed: number }> {
    const started = Date.parse(this.#options.clock.now());
    const digestCache: ExternalProposalDigestCache = {};
    let decided = 0;
    let failed = 0;
    let firstError: unknown;
    for (const item of items) {
      try {
        const proposal = await this.#pending(item.proposalId);
        if (proposal.batchId === batchId) {
          decided += 1;
          continue;
        }
        if (proposal.status !== "pending") {
          failed += 1;
          continue;
        }
        if (item.decision === "reject") {
          if (await this.decline(item.proposalId, { batchId, started })) decided += 1;
          else failed += 1;
          continue;
        }
        await this.keep(
          item.proposalId,
          {
            batchId,
            started,
            ...(item.editedText === null ? {} : { editedText: item.editedText }),
          },
          digestCache,
        );
        decided += 1;
      } catch (error) {
        firstError ??= error;
        failed += 1;
      }
    }
    if (decided === 0 && firstError !== undefined) throw firstError;
    if (decided === 0 && failed > 0)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_ALREADY_DECIDED");
    return { decided, failed };
  }

  async #digests(cache?: ExternalProposalDigestCache): Promise<Map<string, string>> {
    if (cache?.digests && cache.memoryChanges === this.#memoryChanges) return cache.digests;
    const digests = await this.#activeDigests();
    if (cache) {
      cache.digests = digests;
      cache.memoryChanges = this.#memoryChanges;
    }
    return digests;
  }

  async #activeDigests(): Promise<Map<string, string>> {
    const { ownerId, agentId } = this.#scope();
    const digests = new Map<string, string>();
    for (const memory of await this.#options.state.listActive(ownerId, agentId)) {
      if (
        memory.attributes?.tentative === true ||
        (memory.attributes?.supersededBy ?? null) !== null
      )
        continue;
      const payload = await this.#options.payloads.get(memory.contentRef);
      if (!payload || payload.contentType !== "text/plain") continue;
      const text = new TextDecoder().decode(
        await this.#options.protector.unprotect({ ownerId, agentId, payload }),
      );
      const digest = proposalTextDigest(text);
      if (!digests.has(digest)) digests.set(digest, memory.id);
    }
    return digests;
  }

  async dropExpiredDiscardedText(): Promise<number> {
    return this.#serially(() => this.#dropExpiredDiscardedText());
  }

  async #dropExpiredDiscardedText(): Promise<number> {
    return this.#options.proposals.dropDiscardedText({
      ...this.#scope(),
      decidedBefore: new Date(
        Date.parse(this.#options.clock.now()) - EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS * DAY_MS,
      ).toISOString(),
    });
  }

  async #pending(proposalId: string): Promise<ExternalMemoryProposalRecord> {
    const proposal = await this.#options.proposals.read({ ...this.#scope(), id: proposalId });
    if (!proposal)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_PROPOSAL_NOT_FOUND");
    return proposal;
  }

  async #serially<T>(work: () => Promise<T>): Promise<T> {
    const current = this.#queue.then(work, work);
    this.#queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  async #appendOnce(write: DecisionLedgerWrite): Promise<void> {
    if (!(await this.#options.ledger.read({ ...this.#scope(), decisionId: write.id })))
      await this.#options.ledger.append(write);
  }

  #ledgerWrite(
    proposal: Pick<ExternalMemoryProposalRecord, "id" | "subjectRef" | "category">,
    batchId: string | null,
    decision: keyof typeof EXTERNAL_PROPOSAL_REASON_CODES,
    memoryId: string | null,
    started: number,
  ): DecisionLedgerWrite {
    const decidedAt = this.#options.clock.now();
    return {
      id: ledgerId(proposal.id, batchId, decision),
      ...this.#scope(),
      kind: "memory_candidate",
      decidedAt,
      outcome:
        decision === "kept" ? "kept" : decision === "pending" ? "pending_approval" : "discarded",
      reasonCode: EXTERNAL_PROPOSAL_REASON_CODES[decision],
      subjectRef: memoryId ?? proposal.subjectRef,
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
