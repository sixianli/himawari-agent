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
import { credentialFindings } from "@himawari-agent/sensitive-capture";

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

async function process(candidates: readonly ExtractedMemoryCandidate[]) {
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
    readSourceText: async () => "主人说了一些话。",
    now: () => "2026-11-05T00:00:00.000Z",
    memoryIdFor: (generation, ordinal) => `memory:${generation}:${ordinal}` as MemoryId,
    approvalIdFor: (generation, ordinal) => `approval:${generation}:${ordinal}`,
  });
  const result = await service.processCommittedRun(input);
  return { result, audit, stored };
}

describe("[W-07b] passwords, verification codes and keys never become memories", () => {
  it("finds credentials with the outbound redaction detectors, including masked placeholders", () => {
    expect(credentialFindings("主人家的 Wi-Fi 密码是 abc12345")).toEqual([
      { kind: "password", count: 1 },
    ]);
    expect(credentialFindings("主人的验证码是 482910")).toEqual([
      { kind: "verification-code", count: 1 },
    ]);
    expect(credentialFindings("主人家的 Wi-Fi 密码是 [密码#abcdefgh]")).toEqual([
      { kind: "password", count: 1 },
    ]);
    expect(credentialFindings("登录用 [验证码#qwertyui]，接口用 [密钥]")).toEqual([
      { kind: "machine-secret", count: 1 },
      { kind: "verification-code", count: 1 },
    ]);
  });

  it("REVERSE: ordinary facts, card numbers and ID numbers are not credentials", () => {
    expect(credentialFindings("主人最喜欢的颜色是蓝色")).toEqual([]);
    expect(credentialFindings("主人想换一个更好记的密码")).toEqual([]);
    expect(credentialFindings("主人的银行卡号是 4111 1111 1111 1111")).toEqual([]);
    expect(credentialFindings("主人的卡是 [银行卡 尾号1111#abcdefgh]")).toEqual([]);
  });

  it("drops a candidate whose text or quote holds a credential before anything is stored", async () => {
    const { result, audit, stored } = await process([
      candidate("主人家的 Wi-Fi 密码是 [密码#abcdefgh]"),
      candidate("主人换了新的 Wi-Fi 密码", "家里 Wi-Fi 密码是 abc12345"),
      candidate("主人最喜欢的颜色是蓝色"),
    ]);
    expect(result.excludedCandidateOrdinals).toEqual([0, 1]);
    expect(
      audit
        .filter(({ outcome }) => outcome === "candidate_secret_excluded")
        .map(({ candidateOrdinal, secretFindings }) => [candidateOrdinal, secretFindings]),
    ).toEqual([
      [0, [{ ruleId: "password", count: 1 }]],
      [1, [{ ruleId: "password", count: 1 }]],
    ]);
    expect(stored.join("\n")).not.toContain("密码");
    expect(stored).toContain("主人最喜欢的颜色是蓝色");
  });
});
