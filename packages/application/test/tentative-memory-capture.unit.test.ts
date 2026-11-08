import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import type {
  ExtractedMemoryCandidate,
  MemoryExtractionAuditRecord,
} from "../src/ports/automatic-memory.js";
import type { DecisionLedgerWrite } from "../src/ports/decision-ledger.js";
import {
  AutomaticMemoryService,
  type CommittedRunMemoryInput,
} from "../src/services/automatic-memory-service.js";

const candidate = (overrides: Partial<ExtractedMemoryCandidate>): ExtractedMemoryCandidate => ({
  kind: "durable_fact",
  decision: "create",
  existingMemoryId: null,
  text: "主人偏好明治乳制品",
  dataClassification: "private",
  confidencePermille: 700,
  inference: true,
  sourceRefs: ["payload-source"],
  quote: "好家里只喝明治的牛奶",
  ...overrides,
});

const input = {
  ownerId: "owner-1",
  agentId: "agent-1",
  runId: "run-1",
  threadId: "thread-1",
  generationId: "generation-1" as MemoryGenerationId,
  sourceRef: "payload-source",
  sourceClassification: "private",
  policyVersion: "memory-capture:test",
  modelDescriptorRef: "model-1",
  interactive: true,
  explicitRememberCandidateOrdinal: null,
} as unknown as CommittedRunMemoryInput;

async function capture(candidates: readonly ExtractedMemoryCandidate[]) {
  const audit: MemoryExtractionAuditRecord[] = [];
  const ledger: DecisionLedgerWrite[] = [];
  const proposals: Record<string, unknown>[] = [];
  const committed: MemoryId[] = [];
  const service = new AutomaticMemoryService({
    extraction: { extract: async () => candidates },
    product: {
      applyProposal: async (
        proposal: { memory?: { id: MemoryId }; memoryId?: MemoryId },
        _generation: MemoryGenerationId,
        write?: DecisionLedgerWrite,
      ) => {
        proposals.push(proposal as Record<string, unknown>);
        if (write) ledger.push(write);
        return { id: proposal.memory?.id ?? proposal.memoryId };
      },
    } as never,
    content: { store: async (value) => `content:${value.contentKey}` },
    approvals: {} as never,
    audit: { record: async (record) => void audit.push(record) },
    ledger: { append: async (write: DecisionLedgerWrite) => void ledger.push(write) } as never,
    readSourceText: async () => "好家里只喝明治的牛奶",
    now: () => "2026-11-08T00:00:00.000Z",
    memoryIdFor: (generation, ordinal) => `memory:${generation}:${ordinal}` as MemoryId,
    approvalIdFor: (generation, ordinal) => `approval:${generation}:${ordinal}`,
    onCommitted: async ({ memoryId }) => void committed.push(memoryId),
  });
  const result = await service.processCommittedRun(input);
  return { result, audit, ledger, proposals, committed };
}

describe("[PA-2] low-confidence candidates are kept as tentative memories", () => {
  it("keeps a low-confidence create with a verified quote as tentative and records why", async () => {
    const { result, audit, ledger, proposals } = await capture([candidate({})]);
    expect(result.committedMemoryIds).toEqual([]);
    expect(result.tentativeMemoryIds).toEqual(["memory:generation-1:0"]);
    expect(audit.map(({ outcome }) => outcome)).toEqual(["tentative_kept"]);
    expect(proposals[0]).toMatchObject({
      decision: "create",
      memory: {
        inference: true,
        confidencePermille: 700,
        sourceThreadId: "thread-1",
        attributes: { tentative: true },
      },
      quoteRef: "content:generation-1:0:quote",
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      outcome: "kept",
      reasonCode: "kept_tentative",
      confidencePermille: 700,
      inferred: true,
    });
  });

  it("does not let a tentative memory supersede a formal one or run commit side effects", async () => {
    const { proposals, committed } = await capture([
      candidate({ supersedes: "memory-old" as MemoryId }),
    ]);
    expect(proposals[0]).not.toHaveProperty("supersedes");
    expect(committed).toEqual([]);
  });

  it("REVERSE: still discards low-confidence candidates that are not a verified new fact", async () => {
    const { result, audit, ledger, proposals } = await capture([
      candidate({ quote: "" }),
      candidate({ decision: "update", existingMemoryId: "memory-1" as MemoryId }),
      candidate({ decision: "unchanged", existingMemoryId: "memory-1" as MemoryId }),
      candidate({ kind: "transient" }),
    ]);
    expect(result.tentativeMemoryIds).toEqual([]);
    expect(proposals).toEqual([]);
    expect(audit.map(({ outcome }) => outcome)).toEqual([
      "confidence_below_threshold",
      "confidence_below_threshold",
      "confidence_below_threshold",
      "transient_ignored",
    ]);
    expect(ledger.every(({ outcome }) => outcome === "discarded")).toBe(true);
  });

  it("REVERSE: a confident candidate is still committed as a formal memory", async () => {
    const { result, proposals } = await capture([
      candidate({ confidencePermille: 950, inference: false }),
    ]);
    expect(result.committedMemoryIds).toEqual(["memory:generation-1:0"]);
    expect(result.tentativeMemoryIds).toEqual([]);
    expect((proposals[0] as { memory: object }).memory).not.toHaveProperty("attributes");
  });
});
