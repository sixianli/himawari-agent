import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import type { ModelInvocationEvent, ModelInvocationRequest } from "../src/ports/intelligence.js";
import type { ProductMemoryRecord } from "../src/ports/memory-projection.js";
import type { RuleReviewCandidate, RuleReviewStorePort } from "../src/ports/rule-review.js";
import type { ProactiveModelInvoker } from "../src/services/proactive-mail-check-service.js";
import { RuleReviewService, ruleReviewPrompt } from "../src/services/rule-review-service.js";

const NOW = "2026-11-11T10:00:00.000Z";
const SCOPE = { ownerId: "owner-1" as OwnerId, agentId: "agent-1" as AgentId };
const BOSS = {
  type: "mail_must_notify",
  summary: "老板的邮件一律提醒",
  params: { senderAddresses: ["boss@a.com"] },
};
const CANDIDATE: RuleReviewCandidate = {
  ruleId: "owner:boss",
  revision: 2,
  status: "needs_review",
  parameters: BOSS,
  sourceMemoryId: "memory:rule:boss",
  reviewAttempts: 0,
};

function memory(overrides: Partial<ProductMemoryRecord> = {}): ProductMemoryRecord {
  return {
    id: "memory:rule:boss" as MemoryId,
    ...SCOPE,
    revision: 4,
    status: "active",
    contentRef: "payload:boss" as ProductMemoryRecord["contentRef"],
    dataClassification: "private",
    sourceThreadId: null,
    sourceRefs: [],
    inference: false,
    confidencePermille: 1000,
    policyVersion: "owner-rule:v1",
    providerRecordId: null,
    lastUsedAt: null,
    updatedAt: NOW,
    attributes: {
      category: "rule",
      supersededBy: null,
    } as ProductMemoryRecord["attributes"],
    ...overrides,
  } as ProductMemoryRecord;
}

type Reply = string | { failed: string } | "disclosure-denied";

function harness(
  reply: Reply,
  source: ProductMemoryRecord | null = memory(),
  readMemoryText: () => Promise<string> = async () =>
    "以后 boss@b.com 的邮件必须提醒我\n老板的邮件一律提醒",
) {
  const resolved: unknown[] = [];
  const failures: unknown[] = [];
  const prompts: string[] = [];
  let calls = 0;
  const store: RuleReviewStorePort = {
    listDue: async () => [CANDIDATE],
    resolve: async (input) => {
      resolved.push(input);
      return true;
    },
    recordFailure: async (input) => {
      failures.push(input);
      return true;
    },
  };
  const model: ProactiveModelInvoker = {
    modelRef: "deepseek-flash",
    model: {
      listAvailable: async () => [],
      async *invoke(request: ModelInvocationRequest): AsyncIterable<ModelInvocationEvent> {
        calls += 1;
        if (typeof reply === "object") {
          yield {
            type: "model.failed",
            invocationId: request.invocationId,
            errorCode: reply.failed,
            retryable: true,
            latencyMs: 1,
            occurredAt: NOW,
          };
          return;
        }
        yield {
          type: "model.output",
          invocationId: request.invocationId,
          sequence: 0,
          payloadRef: "out-1" as never,
          occurredAt: NOW,
        };
        yield {
          type: "model.completed",
          invocationId: request.invocationId,
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
          latencyMs: 1,
          occurredAt: NOW,
        };
      },
    },
    async prepare({ prompt }) {
      if (reply === "disclosure-denied") throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
      prompts.push(prompt);
      return {
        runId: "run-1" as never,
        inputRef: "in-1",
        allowedDisclosureRef: "in-1",
        secretHandleRefs: [],
        release: async () => undefined,
      };
    },
    readOutput: async () => (typeof reply === "string" ? reply : ""),
    release: async () => undefined,
  };
  const service = new RuleReviewService({
    scope: SCOPE,
    clock: { now: () => NOW },
    store,
    memories: { read: async () => source ?? undefined },
    readMemoryText,
    model,
    nextInvocationId: () => "rule-review-1",
  });
  return { service, resolved, failures, prompts, calls: () => calls };
}

describe("[P4-1] RuleReviewService", () => {
  it("suspends the rule and suggests the new sender when the owner changed the sentence", async () => {
    const run = harness(
      JSON.stringify({
        standing: true,
        type: "mail_must_notify",
        summary: "老板新邮箱的邮件一律提醒",
        params: { senderAddresses: ["boss@b.com"] },
      }),
    );
    expect(await run.service.run()).toEqual([{ ruleId: "owner:boss", outcome: "suspended" }]);
    expect(run.resolved).toEqual([
      expect.objectContaining({
        ruleId: "owner:boss",
        expectedRevision: 2,
        sourceRevision: 4,
        resolution: {
          outcome: "suspended",
          reason: "parameters_changed",
          suggestion: expect.objectContaining({
            params: expect.objectContaining({ senderAddresses: ["boss@b.com"] }),
          }),
        },
      }),
    ]);
  });

  it("clears the rule when the meaning did not change", async () => {
    const run = harness(
      JSON.stringify({
        standing: true,
        type: "mail_must_notify",
        summary: "x",
        params: BOSS.params,
      }),
    );
    expect(await run.service.run()).toEqual([{ ruleId: "owner:boss", outcome: "cleared" }]);
    expect(run.resolved).toEqual([expect.objectContaining({ resolution: { outcome: "cleared" } })]);
  });

  it("suspends a rule the owner no longer wants", async () => {
    const run = harness('{"standing": false}');
    await run.service.run();
    expect(run.resolved).toEqual([
      expect.objectContaining({
        resolution: { outcome: "suspended", reason: "no_longer_standing", suggestion: null },
      }),
    ]);
  });

  it("suspends without asking the model when the source memory is gone or no longer a rule", async () => {
    for (const source of [
      null,
      memory({ status: "trashed" }),
      memory({ attributes: { category: "preference" } } as Partial<ProductMemoryRecord>),
    ]) {
      const run = harness("{}", source);
      expect(await run.service.run()).toEqual([{ ruleId: "owner:boss", outcome: "suspended" }]);
      expect(run.calls()).toBe(0);
      expect(run.resolved).toEqual([
        expect.objectContaining({
          resolution: { outcome: "suspended", reason: "source_removed", suggestion: null },
        }),
      ]);
    }
  });

  it("keeps the rule as it is when the model fails, answers nonsense or may not see the memory", async () => {
    for (const [reply, reason] of [
      [{ failed: "HTTP_503" }, "model_failed"],
      ["不是 JSON", "answer_invalid"],
      ['{"standing": true, "type": "mail_must_notify", "params": {}}', "answer_invalid"],
      ["disclosure-denied", "content_blocked"],
    ] as const) {
      const run = harness(reply);
      expect(await run.service.run()).toEqual([{ ruleId: "owner:boss", outcome: reason }]);
      expect(run.resolved).toEqual([]);
      expect(run.failures).toEqual([
        expect.objectContaining({ reason, retryAfter: "2026-11-11T11:00:00.000Z" }),
      ]);
    }
  });

  it("keeps the rule as it is and counts a failed attempt when the source memory's text cannot be read", async () => {
    const run = harness("{}", memory(), async () => {
      throw new Error("RULE_REVIEW_MEMORY_UNREADABLE");
    });
    expect(await run.service.run()).toEqual([
      { ruleId: "owner:boss", outcome: "source_unreadable" },
    ]);
    expect(run.calls()).toBe(0);
    expect(run.resolved).toEqual([]);
    expect(run.failures).toEqual([
      expect.objectContaining({
        reason: "source_unreadable",
        retryAfter: "2026-11-11T11:00:00.000Z",
      }),
    ]);
  });

  it("puts the fixed instructions first and the changing data last, byte for byte the same each time", () => {
    const first = ruleReviewPrompt("以后 boss@b.com 的邮件必须提醒我", BOSS);
    const again = ruleReviewPrompt("以后 boss@b.com 的邮件必须提醒我", {
      ...BOSS,
      params: { senderAddresses: ["BOSS@A.COM", "boss@a.com"] },
    });
    expect(again).toBe(first);
    const lines = first.split("\n");
    expect(JSON.parse(lines.at(-1) ?? "")).toEqual({
      memory: "以后 boss@b.com 的邮件必须提醒我",
      currentRule: { type: "mail_must_notify", params: expect.anything() },
    });
    expect(first.startsWith("主人以前用一句话立过")).toBe(true);
  });
});
