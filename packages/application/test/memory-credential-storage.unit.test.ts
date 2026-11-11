import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import type {
  ExtractedMemoryCandidate,
  MemoryExtractionAuditRecord,
} from "../src/ports/automatic-memory.js";
import {
  AutomaticMemoryService,
  type CommittedRunMemoryInput,
} from "../src/services/automatic-memory-service.js";

const candidate = (text: string, quote?: string): ExtractedMemoryCandidate => ({
  kind: "durable_fact",
  decision: "create",
  existingMemoryId: null,
  text,
  dataClassification: "private",
  confidencePermille: 950,
  inference: false,
  sourceRefs: ["payload-source"],
  ...(quote ? { quote } : {}),
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

async function process(
  candidates: readonly ExtractedMemoryCandidate[],
  sourceText = "主人说了一些话。",
) {
  const audit: MemoryExtractionAuditRecord[] = [];
  const stored: string[] = [];
  const service = new AutomaticMemoryService({
    extraction: { extract: async () => candidates },
    product: {
      applyProposal: async (proposal: { memory?: { id: MemoryId }; memoryId?: MemoryId }) => ({
        id: proposal.memory?.id ?? proposal.memoryId,
      }),
    } as never,
    content: {
      store: async (value: { contentKey: string; text: string }) => {
        stored.push(value.text);
        return `content:${value.contentKey}`;
      },
    },
    approvals: {} as never,
    audit: { record: async (record) => void audit.push(record) },
    readSourceText: async () => sourceText,
    now: () => "2026-11-05T00:00:00.000Z",
    memoryIdFor: (generation, ordinal) => `memory:${generation}:${ordinal}` as MemoryId,
    approvalIdFor: (generation, ordinal) => `approval:${generation}:${ordinal}`,
  });
  const result = await service.processCommittedRun(input);
  return { result, audit, stored };
}

const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");

describe("[mask-not-block] credentials in a candidate are stored as written", () => {
  it("stores a candidate whose text or quote holds a password, a code or a key", async () => {
    const { result, stored } = await process([
      candidate("主人家的 Wi-Fi 密码是 abc12345"),
      candidate("主人换了新的 Wi-Fi 密码", "家里 Wi-Fi 密码是 abc12345"),
      candidate(`主人的接口密钥是 ${FAKE_KEY}`),
      candidate("主人最喜欢的颜色是蓝色"),
    ]);
    expect(result.status).toBe("completed");
    expect(result.excludedCandidateOrdinals).toEqual([]);
    expect(result.committedMemoryIds).toHaveLength(4);
    expect(stored).toContain("主人家的 Wi-Fi 密码是 abc12345");
    expect(stored).toContain(`主人的接口密钥是 ${FAKE_KEY}`);
  });

  it("reads a source that holds a machine secret instead of skipping the run", async () => {
    const { result } = await process([candidate("主人最喜欢的颜色是蓝色")], `token: ${FAKE_KEY}`);
    expect(result.status).toBe("completed");
    expect(result.committedMemoryIds).toHaveLength(1);
  });

  it("REVERSE: still drops a candidate the model classified as restricted", async () => {
    const restricted: ExtractedMemoryCandidate = {
      ...candidate("主人的护照号是 E12345678"),
      dataClassification: "restricted",
    };
    const { result, stored } = await process([restricted]);
    expect(result.excludedCandidateOrdinals).toEqual([0]);
    expect(stored).toEqual([]);
  });
});
