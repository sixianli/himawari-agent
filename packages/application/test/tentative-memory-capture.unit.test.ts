import {
  MEMORY_AUTO_COMMIT_GATE,
  MEMORY_TENTATIVE_CONFIRM_GATE,
  THRESHOLD_CATEGORIES,
  THRESHOLD_GATES,
} from "@himawari-agent/calibration";
import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import type {
  ExtractedMemoryCandidate,
  MemoryExtractionAuditRecord,
} from "../src/ports/automatic-memory.js";
import type { DecisionLedgerWrite } from "../src/ports/decision-ledger.js";
import { DEFAULT_MEMORY_ATTRIBUTES, MEMORY_CATEGORIES } from "../src/ports/memory-projection.js";
import {
  AutomaticMemoryService,
  type CaptureGates,
  type CommittedRunMemoryInput,
  DEFAULT_CAPTURE_GATES,
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

async function capture(
  candidates: readonly ExtractedMemoryCandidate[],
  { gates }: { readonly gates?: CaptureGates } = {},
) {
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
    approvals: { create: async (request: unknown) => request } as never,
    audit: { record: async (record) => void audit.push(record) },
    ledger: { append: async (write: DecisionLedgerWrite) => void ledger.push(write) } as never,
    readSourceText: async () => "好家里只喝明治的牛奶",
    ...(gates ? { gates } : {}),
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

  it("REVERSE: a low-confidence candidate with a reminder or people is discarded, not half-kept", async () => {
    const { result, audit, proposals } = await capture([
      candidate({
        reminder: { dueAt: "2026-11-09T00:00:00.000Z" } as never,
      }),
      candidate({ people: [{ name: "小葵", aliases: [] }] as never }),
      candidate({ personLinks: [{ from: "主人", to: "小葵", relation: "女儿" }] as never }),
    ]);
    expect(result.tentativeMemoryIds).toEqual([]);
    expect(proposals).toEqual([]);
    expect(audit.map(({ outcome }) => outcome)).toEqual([
      "confidence_below_threshold",
      "confidence_below_threshold",
      "confidence_below_threshold",
    ]);
  });

  it("REVERSE: a low-confidence restricted candidate is still excluded, not kept as tentative", async () => {
    const { result, audit, proposals } = await capture([
      candidate({ dataClassification: "restricted" }),
    ]);
    expect(result.tentativeMemoryIds).toEqual([]);
    expect(proposals).toEqual([]);
    expect(audit.map(({ outcome }) => outcome)).toEqual(["restricted_excluded"]);
  });

  it("[ADR-0286] a low-confidence sensitive candidate is kept as tentative like any other, without an approval request", async () => {
    const { result, audit } = await capture([candidate({ dataClassification: "sensitive" })]);
    expect(result.approvalRequestIds).toEqual([]);
    expect(result.tentativeMemoryIds).toEqual(["memory:generation-1:0"]);
    expect(audit.map(({ outcome }) => outcome)).not.toContain("approval_requested");
  });

  it("REVERSE: a confident candidate is still committed as a formal memory", async () => {
    const { result, proposals } = await capture([
      candidate({ confidencePermille: 950, inference: false }),
    ]);
    expect(result.committedMemoryIds).toEqual(["memory:generation-1:0"]);
    expect(result.tentativeMemoryIds).toEqual([]);
    expect((proposals[0] as { memory: object }).memory).not.toHaveProperty("attributes");
  });

  it("[P4-4] auto-commits exactly from the registered threshold", async () => {
    const at = MEMORY_AUTO_COMMIT_GATE.defaultThreshold;
    const below = await capture([candidate({ confidencePermille: at - 1 })]);
    expect(below.result.committedMemoryIds).toEqual([]);
    expect(below.result.tentativeMemoryIds).toEqual(["memory:generation-1:0"]);
    const onLine = await capture([candidate({ confidencePermille: at })]);
    expect(onLine.result.committedMemoryIds).toEqual(["memory:generation-1:0"]);
    expect(onLine.result.tentativeMemoryIds).toEqual([]);
  });
});

const withCategory = (
  category: string | null,
  overrides: Partial<ExtractedMemoryCandidate>,
): ExtractedMemoryCandidate =>
  candidate({
    ...(category === null
      ? {}
      : { attributes: { ...DEFAULT_MEMORY_ATTRIBUTES, category: category as never } }),
    ...overrides,
  });

const reaffirm = (
  category: string | null,
  confidencePermille: number,
  confirmsTentativeCategory?: string,
  decision: ExtractedMemoryCandidate["decision"] = "unchanged",
) =>
  withCategory(category, {
    decision,
    existingMemoryId: "memory-tentative" as MemoryId,
    confidencePermille,
    ...(confirmsTentativeCategory === undefined
      ? {}
      : { confirmsTentativeCategory: confirmsTentativeCategory as never }),
  });

describe("[P4-7] capture thresholds are configured per category", () => {
  it("registers the tentative-confirm gate next to the auto-commit gate with today's values", () => {
    expect(THRESHOLD_GATES).toContain(MEMORY_AUTO_COMMIT_GATE);
    expect(THRESHOLD_GATES).toContain(MEMORY_TENTATIVE_CONFIRM_GATE);
    expect(DEFAULT_CAPTURE_GATES).toEqual({
      autoCommit: MEMORY_AUTO_COMMIT_GATE,
      confirmTentative: MEMORY_TENTATIVE_CONFIRM_GATE,
    });
    for (const gate of [MEMORY_AUTO_COMMIT_GATE, MEMORY_TENTATIVE_CONFIRM_GATE]) {
      expect(gate.defaultThreshold).toBe(850);
      expect(gate.byCategory).toEqual({});
    }
  });

  it("every registered override is an integer score for a known memory category", () => {
    expect([...THRESHOLD_CATEGORIES].sort()).toEqual([...MEMORY_CATEGORIES].sort());
    const keys = new Set<string>();
    for (const gate of THRESHOLD_GATES) {
      expect(keys.has(gate.key)).toBe(false);
      keys.add(gate.key);
      for (const [category, value] of Object.entries(gate.byCategory)) {
        expect(THRESHOLD_CATEGORIES).toContain(category);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(gate.scoreMax + 1);
      }
    }
  });

  it("a per-category auto-commit override takes effect only for that category", async () => {
    const gates: CaptureGates = {
      ...DEFAULT_CAPTURE_GATES,
      autoCommit: { ...MEMORY_AUTO_COMMIT_GATE, byCategory: { health: 950, preference: 600 } },
    };
    const { result, ledger } = await capture(
      [
        withCategory("health", { confidencePermille: 900 }),
        withCategory("preference", { confidencePermille: 700 }),
        withCategory("goal", { confidencePermille: 849 }),
        withCategory("goal", { confidencePermille: 850 }),
      ],
      { gates },
    );
    expect(result.tentativeMemoryIds).toEqual(["memory:generation-1:0", "memory:generation-1:2"]);
    expect(result.committedMemoryIds).toEqual(["memory:generation-1:1", "memory:generation-1:3"]);
    expect(ledger.map(({ reasonCode }) => reasonCode)).toEqual([
      "kept_tentative",
      "auto_committed",
      "kept_tentative",
      "auto_committed",
    ]);
  });

  it("the confirm gate decides every confirmation of a tentative memory, not the auto-commit gate", async () => {
    const gates: CaptureGates = {
      autoCommit: { ...MEMORY_AUTO_COMMIT_GATE, defaultThreshold: 950 },
      confirmTentative: {
        ...MEMORY_TENTATIVE_CONFIRM_GATE,
        defaultThreshold: 750,
        byCategory: { health: 900 },
      },
    };
    const { result, ledger } = await capture(
      [
        reaffirm("goal", 800, "goal"),
        reaffirm("health", 800, "health"),
        reaffirm("goal", 800, "goal", "update"),
        reaffirm("goal", 800, "goal", "merge"),
      ],
      { gates },
    );
    expect(result.committedMemoryIds).toEqual([
      "memory-tentative",
      "memory-tentative",
      "memory-tentative",
    ]);
    expect(ledger.map(({ outcome, reasonCode }) => [outcome, reasonCode])).toEqual([
      ["kept", "tentative_confirmed"],
      ["discarded", "confirm_below_threshold"],
      ["kept", "tentative_confirmed"],
      ["kept", "tentative_confirmed"],
    ]);
  });

  it("REVERSE: the confirmed memory's own category picks the threshold, not the category the model claims", async () => {
    const gates: CaptureGates = {
      ...DEFAULT_CAPTURE_GATES,
      confirmTentative: {
        ...MEMORY_TENTATIVE_CONFIRM_GATE,
        byCategory: { health: 950, preference: 600 },
      },
    };
    const { result, ledger } = await capture([reaffirm("preference", 800, "health")], { gates });
    expect(result.committedMemoryIds).toEqual([]);
    expect(ledger.map(({ reasonCode, category }) => [reasonCode, category])).toEqual([
      ["confirm_below_threshold", "health"],
    ]);
  });

  it("REVERSE: a new memory carrying a confirmation mark still goes through the auto-commit gate", async () => {
    const gates: CaptureGates = {
      ...DEFAULT_CAPTURE_GATES,
      confirmTentative: { ...MEMORY_TENTATIVE_CONFIRM_GATE, defaultThreshold: 0 },
    };
    const { result, ledger } = await capture(
      [withCategory("goal", { confidencePermille: 800, confirmsTentativeCategory: "goal" })],
      { gates },
    );
    expect(result.committedMemoryIds).toEqual([]);
    expect(result.tentativeMemoryIds).toEqual(["memory:generation-1:0"]);
    expect(ledger.map(({ reasonCode }) => reasonCode)).toEqual(["kept_tentative"]);
  });

  it("REVERSE: reaffirming a formal memory still uses the auto-commit gate", async () => {
    const gates: CaptureGates = {
      ...DEFAULT_CAPTURE_GATES,
      confirmTentative: { ...MEMORY_TENTATIVE_CONFIRM_GATE, defaultThreshold: 0 },
    };
    const { result, ledger } = await capture([reaffirm("goal", 800)], { gates });
    expect(result.committedMemoryIds).toEqual([]);
    expect(ledger.map(({ reasonCode }) => reasonCode)).toEqual(["confidence_below_threshold"]);
  });

  it("replaying the same confirmation writes the same decision record", async () => {
    const first = await capture([reaffirm("goal", 900, "goal")]);
    const second = await capture([reaffirm("goal", 900, "goal")]);
    expect(second.ledger).toEqual(first.ledger);
    expect(first.ledger.map(({ reasonCode }) => reasonCode)).toEqual(["tentative_confirmed"]);
  });

  it("with the default configuration every category behaves exactly as the single 850 threshold did", async () => {
    for (const category of [...THRESHOLD_CATEGORIES, null]) {
      const below = await capture([withCategory(category, { confidencePermille: 849 })]);
      expect(below.result.tentativeMemoryIds).toEqual(["memory:generation-1:0"]);
      expect(below.result.committedMemoryIds).toEqual([]);
      const onLine = await capture([withCategory(category, { confidencePermille: 850 })]);
      expect(onLine.result.committedMemoryIds).toEqual(["memory:generation-1:0"]);
      expect(onLine.result.tentativeMemoryIds).toEqual([]);
      for (const confirms of [undefined, category ?? "other"]) {
        const weak = await capture([reaffirm(category, 849, confirms)]);
        expect(weak.result.committedMemoryIds).toEqual([]);
        expect(weak.proposals).toEqual([]);
        expect(weak.audit.map(({ outcome }) => outcome)).toEqual(["confidence_below_threshold"]);
        expect(weak.ledger.map(({ reasonCode }) => reasonCode)).toEqual([
          confirms === undefined ? "confidence_below_threshold" : "confirm_below_threshold",
        ]);
        const strong = await capture([reaffirm(category, 850, confirms)]);
        expect(strong.result.committedMemoryIds).toEqual(["memory-tentative"]);
        expect(strong.audit.map(({ outcome }) => outcome)).toEqual(["auto_committed"]);
        expect(strong.ledger.map(({ reasonCode }) => reasonCode)).toEqual([
          confirms === undefined ? "auto_committed" : "tentative_confirmed",
        ]);
      }
    }
  });
});
