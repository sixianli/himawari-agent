import { createAgentId, createMemoryId, createOwnerId } from "@himawari-agent/domain";
import {
  REAL_EVAL_ANSWER,
  REAL_EVAL_JUDGE,
  REAL_EVAL_LEAK_JUDGE,
  REAL_EVAL_QUESTION,
} from "@himawari-agent/prompt-catalog";
import type { CalibrationDecisionRow } from "@himawari-agent/calibration";
import { describe, expect, it } from "vitest";
import type { ProductMemoryRecord } from "../src/ports/memory-projection.js";
import type {
  RealEvalQuestionRecord,
  RealEvalRunRecord,
  RealEvalStorePort,
} from "../src/ports/real-eval.js";
import {
  type RealEvalModel,
  RealMemoryEvalService,
} from "../src/services/real-memory-eval-service.js";

const OWNER = createOwnerId("owner");
const AGENT = createAgentId("agent");
const START = Date.parse("2026-11-11T00:00:00.000Z");

const memory = (
  id: string,
  overrides: Partial<ProductMemoryRecord> = {},
  tentative = false,
): ProductMemoryRecord => ({
  id: createMemoryId(id),
  ownerId: OWNER,
  agentId: AGENT,
  revision: 1,
  status: "active",
  contentRef: `memory-content:${id}`,
  dataClassification: "private",
  sourceThreadId: null,
  sourceRefs: [],
  inference: false,
  confidencePermille: 900,
  policyVersion: "v1",
  providerRecordId: null,
  lastUsedAt: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  attributes: {
    category: "preference",
    importancePermille: 600,
    entities: [],
    validFrom: null,
    validTo: null,
    supersededBy: null,
    evidenceVerified: true,
    tentative,
  },
  ...overrides,
});

const SOURCES: Record<string, { text: string; quote: string; question: unknown }> = {
  coffee: {
    text: "主人早上只喝燕麦拿铁，不加糖",
    quote: "我早上只喝燕麦拿铁，不加糖",
    question: {
      question: "我早上习惯喝什么？",
      kind: "preference",
      abstainQuestion: "我妹妹早上喝什么？",
    },
  },
  flight: {
    text: "主人十二月三日飞往大阪出差",
    quote: "十二月三日我要飞大阪出差",
    question: {
      question: "我下个月去哪儿出差？",
      kind: "fact",
      abstainQuestion: "我同事下个月去哪儿出差？",
    },
  },
  pending: {
    text: "主人可能想换工作",
    quote: "最近有点想换工作",
    question: { question: "我最近在想什么？", kind: "fact", abstainQuestion: null },
  },
  shy: {
    text: "主人不喜欢香菜",
    quote: "我不吃香菜",
    question: { question: null, kind: null, abstainQuestion: null },
  },
  leaky: {
    text: "主人的猫叫小橘子豆豆",
    quote: "我家猫叫小橘子豆豆",
    question: { question: "我家猫叫小橘子豆豆吗？", kind: "fact", abstainQuestion: null },
  },
};

class MemoryStore implements RealEvalStorePort {
  readonly questions: RealEvalQuestionRecord[] = [];
  readonly runs: RealEvalRunRecord[] = [];
  async listQuestions() {
    return [...this.questions];
  }
  async addQuestion(input: Parameters<RealEvalStorePort["addQuestion"]>[0]) {
    if (
      this.questions.some(
        (row) =>
          row.memoryId === input.question.memoryId &&
          row.memoryRevision === input.question.memoryRevision &&
          row.kind === input.question.kind,
      )
    )
      return false;
    this.questions.push({ ...input.question, retiredAt: null, retiredReason: null });
    return true;
  }
  async retireQuestion(input: Parameters<RealEvalStorePort["retireQuestion"]>[0]) {
    const index = this.questions.findIndex((row) => row.id === input.id);
    const row = this.questions[index];
    if (row && row.retiredAt === null)
      this.questions[index] = { ...row, retiredAt: input.at, retiredReason: input.reason };
  }
  async recordRun(input: Parameters<RealEvalStorePort["recordRun"]>[0]) {
    this.runs.push(input.run);
  }
  async listRuns(input: Parameters<RealEvalStorePort["listRuns"]>[0]) {
    return this.runs.toReversed().slice(0, input.limit);
  }
}

interface Harness {
  readonly store: MemoryStore;
  readonly prompts: string[];
  readonly recalls: string[];
  readonly recallClassifications: string[];
  readonly payloads: Map<string, string>;
  readonly discarded: string[];
  memories: ProductMemoryRecord[];
  service: RealMemoryEvalService;
}

function harness(options: {
  readonly memories: ProductMemoryRecord[];
  readonly answer?: (question: string) => string;
  readonly judge?: string;
  readonly leak?: (question: string) => string;
  readonly decisions?: readonly CalibrationDecisionRow[];
  readonly estimateMicros?: number;
  readonly answerCostMicros?: number;
  readonly addQuestion?: "duplicate" | "throw";
  readonly discardFails?: boolean;
  readonly recallEstimateMicros?: number;
  readonly failAnswer?: boolean;
  readonly questionOutput?: string;
  readonly unreadable?: string | readonly string[];
  readonly questionUnreadable?: boolean;
}): Harness {
  const store = new MemoryStore();
  if (options.addQuestion === "duplicate") store.addQuestion = async () => false;
  if (options.addQuestion === "throw")
    store.addQuestion = async () => {
      throw new Error("SQLITE_BUSY");
    };
  const prompts: string[] = [];
  const recalls: string[] = [];
  const recallClassifications: string[] = [];
  const discarded: string[] = [];
  const payloads = new Map<string, string>();
  let stored = 0;
  let tick = 0;
  let id = 0;
  const sourceOf = (record: ProductMemoryRecord) => SOURCES[String(record.id)];
  const model: RealEvalModel = {
    modelRef: "eval-model",
    estimateMicros: () => options.estimateMicros ?? 100,
    async generate({ prompt }) {
      prompts.push(prompt);
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<
        string,
        unknown
      >;
      if (prompt.startsWith(REAL_EVAL_QUESTION.text)) {
        const source = Object.values(SOURCES).find(({ quote }) => quote === data["quote"]);
        return {
          output: options.questionOutput ?? JSON.stringify(source?.question),
          costMicros: 100,
        };
      }
      if (prompt.startsWith(REAL_EVAL_ANSWER.text)) {
        const question = String(data["question"]);
        if (options.failAnswer) throw new Error("RATE_LIMITED");
        return {
          output: options.answer ? options.answer(question) : defaultAnswer(question),
          costMicros: options.answerCostMicros ?? 100,
        };
      }
      if (prompt.startsWith(REAL_EVAL_LEAK_JUDGE.text)) {
        const verdict = options.leak ? options.leak(String(data["question"])) : '{"leaks":false}';
        if (verdict === "throw") throw new Error("RATE_LIMITED");
        return { output: verdict, costMicros: 0 };
      }
      if (prompt.startsWith(REAL_EVAL_JUDGE.text))
        return { output: options.judge ?? '{"verdict":"correct"}', costMicros: 50 };
      throw new Error("UNEXPECTED_PROMPT");
    },
  };
  const state: Harness = {
    store,
    prompts,
    recalls,
    recallClassifications,
    payloads,
    discarded,
    memories: options.memories,
    service: undefined as unknown as RealMemoryEvalService,
  };
  state.service = new RealMemoryEvalService({
    scope: { ownerId: OWNER, agentId: AGENT },
    store,
    model,
    now: () => new Date(START + tick++ * 1000).toISOString(),
    newId: () => `id-${++id}`,
    promptSha256: "a".repeat(64),
    maxSelectedMemories: 2,
    recallEstimateMicros: options.recallEstimateMicros ?? 0,
    listMemories: async () => state.memories,
    readMemoryText: async (record) => {
      if ([options.unreadable ?? []].flat().includes(record.id)) throw new Error("DECRYPT_FAILED");
      return sourceOf(record)?.text;
    },
    readQuote: async (record) => sourceOf(record)?.quote,
    storeQuestion: async ({ text }) => {
      const ref = `question:${stored++}`;
      payloads.set(ref, text);
      return ref;
    },
    readQuestion: async (ref) => {
      if (options.questionUnreadable) throw new Error("DECRYPT_FAILED");
      return payloads.get(ref);
    },
    discardQuestion: async (ref) => {
      if (options.discardFails) throw new Error("SQLITE_BUSY");
      discarded.push(ref);
      payloads.delete(ref);
    },
    recall: async (question, dataClassification) => {
      recalls.push(question);
      recallClassifications.push(dataClassification);
      const hit = Object.entries(SOURCES).find(
        ([, source]) => (source.question as { question: unknown }).question === question,
      );
      return {
        memories: hit
          ? [
              { id: "noise", text: "主人住在东京", dataClassification: "private" as const },
              { id: hit[0], text: hit[1].text, dataClassification: "private" as const },
            ]
          : [],
        costMicros: 10,
      };
    },
    profile: async () => ({ memoryIds: [], texts: [], dataClassification: "public" as const }),
    ...(options.decisions ? { decisions: async () => options.decisions ?? [] } : {}),
  });
  return state;
}

function defaultAnswer(question: string): string {
  if (question.includes("妹妹") || question.includes("同事")) return "我没有这条记忆。";
  if (question.includes("喝")) return "你说过：我早上只喝燕麦拿铁，不加糖。";
  return "你十二月三日去大阪出差。";
}

const LIMITS = { capMicros: 500_000, newMemoriesPerRun: 10 };

describe("[P4-5] real memory eval run", () => {
  it("banks questions only from confirmed memories, answers, judges and records one run", async () => {
    const test = harness({
      memories: [memory("coffee"), memory("flight"), memory("pending", {}, true)],
    });
    const report = await test.service.run("manual", LIMITS);

    expect(report.outcome).toBe("completed");
    expect(test.store.questions.map(({ memoryId, kind }) => `${memoryId}:${kind}`)).toEqual([
      "coffee:preference",
      "coffee:abstain",
      "flight:fact",
      "flight:abstain",
    ]);
    expect(test.store.questions.every(({ questionModel }) => questionModel === "eval-model")).toBe(
      true,
    );
    expect(test.prompts.some((prompt) => prompt.includes("最近有点想换工作"))).toBe(false);
    const summary = report.summary as {
      scores: Record<string, { successes: number; samples: number }>;
      added: number;
      fastPath: number;
      judged: number;
    };
    expect(summary.added).toBe(4);
    expect(summary.scores["fresh"]).toMatchObject({ successes: 2, samples: 2 });
    expect(summary.scores["fixed"]).toMatchObject({ samples: 0 });
    expect(summary.scores["abstain"]).toMatchObject({ successes: 2, samples: 2 });
    expect(summary.fastPath).toBe(1);
    expect(summary.judged).toBe(3);
    expect(test.store.runs).toHaveLength(1);
    expect(test.store.runs[0]).toMatchObject({
      outcome: "completed",
      trigger: "manual",
      model: "eval-model",
      costMicros: report.costMicros,
    });
    expect(report.costMicros).toBe(2 * 100 + 4 * 100 + 3 * 50 + 4 * 10);
    const retrieval = (report.summary as { scores: Record<string, unknown> }).scores["retrieval"];
    expect(retrieval).toMatchObject({ successes: 2, samples: 2 });
    expect(JSON.stringify(test.store.runs[0]?.summary)).not.toMatch(/燕麦|大阪/u);
  });

  it("counts a concrete answer to an abstain question as wrong", async () => {
    const test = harness({
      memories: [memory("coffee")],
      answer: () => "你早上喝美式。",
      judge: '{"verdict":"wrong"}',
    });
    const report = await test.service.run("manual", LIMITS);
    const scores = (report.summary as { scores: Record<string, { successes: number }> }).scores;
    expect(scores["abstain"]).toMatchObject({ successes: 0, samples: 1 });
    expect(scores["fresh"]).toMatchObject({ successes: 0, samples: 1 });
  });

  it("keeps earlier questions as the fixed panel and retires those whose memory changed", async () => {
    const test = harness({ memories: [memory("coffee"), memory("flight")] });
    await test.service.run("weekly", LIMITS);
    test.memories = [memory("coffee"), memory("flight", { revision: 2 })];
    const report = await test.service.run("weekly", LIMITS);

    const retired = test.store.questions.filter(({ retiredAt }) => retiredAt !== null);
    expect(retired.map(({ memoryId, retiredReason }) => `${memoryId}:${retiredReason}`)).toEqual([
      "flight:memory_revised",
      "flight:memory_revised",
    ]);
    const live = test.store.questions.filter(({ retiredAt }) => retiredAt === null);
    expect(live.map(({ memoryId, memoryRevision }) => `${memoryId}@${memoryRevision}`)).toEqual([
      "coffee@1",
      "coffee@1",
      "flight@2",
      "flight@2",
    ]);
    const summary = report.summary as {
      scores: Record<string, { samples: number }>;
      retired: number;
    };
    expect(summary.retired).toBe(2);
    expect(summary.scores["fixed"]).toMatchObject({ samples: 1 });
    expect(summary.scores["fresh"]).toMatchObject({ samples: 1 });
  });

  it("drops leaking questions and does not ask again about a rejected memory version", async () => {
    const test = harness({ memories: [memory("leaky"), memory("shy")] });
    const first = await test.service.run("weekly", LIMITS);
    expect(test.store.questions).toHaveLength(0);
    expect((first.summary as { rejected: Record<string, number> }).rejected).toEqual({
      leak: 1,
      declined: 1,
    });

    const asked = test.prompts.length;
    await test.service.run("weekly", LIMITS);
    expect(test.prompts.slice(asked)).toEqual([]);

    test.memories = [memory("leaky", { revision: 2 }), memory("shy")];
    await test.service.run("weekly", LIMITS);
    const third = test.prompts.slice(asked);
    expect(third.some((prompt) => prompt.includes("小橘子豆豆"))).toBe(true);
    expect(third.some((prompt) => prompt.includes("我不吃香菜"))).toBe(false);
  });

  it("asks the leak judge about every question before it enters the bank, and keeps one it clears", async () => {
    const test = harness({ memories: [memory("flight")] });
    const report = await test.service.run("manual", LIMITS);
    expect((report.summary as { rejected: Record<string, number> }).rejected).toEqual({});
    expect(test.store.questions.map(({ kind }) => kind).sort()).toEqual(["abstain", "fact"]);
    expect(
      test.prompts.filter((prompt) => prompt.startsWith(REAL_EVAL_LEAK_JUDGE.text)),
    ).toHaveLength(2);
  });

  it("REVERSE: a time written in words the n-gram check cannot see is rejected when the leak judge says it leaks", async () => {
    const test = harness({
      memories: [memory("flight")],
      questionOutput:
        '{"question":"我腊月初三要飞去哪里出差？","kind":"fact","abstainQuestion":"我同事下个月去哪儿出差？"}',
      leak: (question) => (question.includes("腊月初三") ? '{"leaks":true}' : '{"leaks":false}'),
    });
    const report = await test.service.run("manual", LIMITS);
    expect((report.summary as { rejected: Record<string, number> }).rejected).toEqual({
      leak: 1,
    });
    expect(test.store.questions).toEqual([]);
  });

  it.each([
    ["answers something other than a verdict", "不知道"],
    ["fails", "throw"],
  ])("REVERSE: rejects the question when the leak judge %s", async (_name, answer) => {
    const test = harness({ memories: [memory("flight")], leak: () => answer });
    const report = await test.service.run("manual", LIMITS);
    expect((report.summary as { rejected: Record<string, number> }).rejected).toMatchObject({
      leak: 1,
    });
    expect(test.store.questions).toEqual([]);
  });

  it("drops only the abstain question when the leak judge flags it", async () => {
    const test = harness({
      memories: [memory("flight")],
      leak: (question) => (question.includes("同事") ? '{"leaks":true}' : '{"leaks":false}'),
    });
    await test.service.run("manual", LIMITS);
    expect(test.store.questions.map(({ kind }) => kind)).toEqual(["fact"]);
  });

  it("deletes the stored question text when the bank does not keep the question", async () => {
    const duplicate = harness({ memories: [memory("coffee")], addQuestion: "duplicate" });
    const kept = await duplicate.service.run("manual", LIMITS);
    expect(kept.outcome).toBe("completed");
    expect(duplicate.discarded).toEqual(["question:0", "question:1"]);
    expect(duplicate.payloads.size).toBe(0);

    const failing = harness({ memories: [memory("coffee")], addQuestion: "throw" });
    const failed = await failing.service.run("manual", LIMITS);
    expect(failed.outcome).toBe("failed");
    expect(failing.discarded).toEqual(["question:0"]);
    expect(failing.payloads.size).toBe(0);
  });

  it("keeps going and still skips the version when the unkept question text cannot be deleted", async () => {
    const options = {
      memories: [memory("coffee")],
      addQuestion: "duplicate" as const,
      discardFails: true,
    };
    const test = harness(options);
    const report = await test.service.run("weekly", LIMITS);
    expect(report.outcome).toBe("completed");
    expect(report.summary).toMatchObject({
      rejected: { already_banked: 2, discard_failed: 2 },
      declined: ["coffee@1"],
      undiscarded: ["question:0", "question:1"],
    });
    expect(test.payloads.size).toBe(2);

    const stillFailing = await test.service.run("weekly", LIMITS);
    expect(stillFailing.summary).toMatchObject({ undiscarded: ["question:0", "question:1"] });

    const latest = test.store.runs.at(-1);
    if (latest) test.store.runs.push({ ...latest, id: "run-lost", summary: { undiscarded: [] } });
    options.discardFails = false;
    const retried = await test.service.run("weekly", { ...LIMITS, runId: "run-given" });
    expect(retried.runId).toBe("run-given");
    expect(test.discarded).toEqual(["question:0", "question:1"]);
    expect(test.payloads.size).toBe(0);
    expect(retried.summary).toMatchObject({ undiscarded: [] });
  });

  it("skips a memory whose text cannot be read without using its slot and asks again later", async () => {
    const options: { memories: ProductMemoryRecord[]; unreadable?: string } = {
      memories: [memory("aaa-missing"), memory("coffee"), memory("flight")],
      unreadable: "coffee",
    };
    const test = harness(options);
    const first = await test.service.run("weekly", { ...LIMITS, newMemoriesPerRun: 2 });
    expect(first.outcome).toBe("completed");
    expect(first.summary).toMatchObject({
      rejected: { source_missing: 1, source_unreadable: 1 },
      declined: ["aaa-missing@1"],
    });
    expect(test.store.questions.map(({ memoryId }) => memoryId)).toContain("flight");
    expect(test.store.questions.map(({ memoryId }) => memoryId)).not.toContain("coffee");

    delete options.unreadable;
    await test.service.run("weekly", { ...LIMITS, newMemoriesPerRun: 2 });
    expect(test.store.questions.map(({ memoryId }) => memoryId)).toContain("coffee");
  });

  it("stops reading after four unreadable memories per question slot", async () => {
    const broken = ["a1", "a2", "a3", "a4", "a5"];
    const test = harness({
      memories: [...broken.map((id) => memory(id)), memory("coffee")],
      unreadable: broken,
    });
    const report = await test.service.run("weekly", { ...LIMITS, newMemoriesPerRun: 1 });
    expect(report.summary).toMatchObject({
      rejected: { source_unreadable: 4 },
      unreadable: ["a1@1", "a2@1", "a3@1", "a4@1"],
    });
    expect(test.store.questions).toEqual([]);
  });

  it("reads memories that could not be read last time after the others", async () => {
    const broken = ["a1", "a2", "a3", "a4"];
    const test = harness({
      memories: [...broken.map((id) => memory(id)), memory("coffee")],
      unreadable: broken,
    });
    await test.service.run("weekly", { ...LIMITS, newMemoriesPerRun: 1 });
    expect(test.store.questions).toEqual([]);
    const second = await test.service.run("weekly", { ...LIMITS, newMemoriesPerRun: 1 });
    expect(test.store.questions.map(({ memoryId }) => memoryId)).toContain("coffee");
    expect(second.summary).toMatchObject({ unreadable: ["a1@1", "a2@1", "a3@1", "a4@1"] });
  });

  it("counts a question as unanswerable when its text or source cannot be read while answering", async () => {
    const options: {
      memories: ProductMemoryRecord[];
      unreadable?: string;
      questionUnreadable?: boolean;
    } = { memories: [memory("coffee"), memory("flight")] };
    const test = harness(options);
    await test.service.run("weekly", LIMITS);
    const banked = test.store.questions.length;

    options.unreadable = "coffee";
    const sourceFails = await test.service.run("weekly", LIMITS);
    expect(sourceFails.outcome).toBe("completed");
    const coffee = test.store.questions.filter(({ memoryId }) => memoryId === "coffee").length;
    expect(sourceFails.summary).toMatchObject({ unanswerable: coffee, items: banked - coffee });

    delete options.unreadable;
    options.questionUnreadable = true;
    const questionFails = await test.service.run("weekly", LIMITS);
    expect(questionFails.outcome).toBe("completed");
    expect(questionFails.summary).toMatchObject({ unanswerable: banked, items: 0 });
  });

  it("does not ask again about a memory version the bank already holds", async () => {
    const test = harness({ memories: [memory("coffee")], addQuestion: "duplicate" });
    await test.service.run("weekly", LIMITS);
    const asked = test.prompts.length;
    const second = await test.service.run("weekly", LIMITS);
    expect(test.prompts.slice(asked)).toEqual([]);
    expect((second.summary as { rejected: Record<string, number> }).rejected).toEqual({});
  });

  it("asks again after a reply that was not valid output", async () => {
    const test = harness({ memories: [memory("coffee")], questionOutput: "not json" });
    await test.service.run("weekly", LIMITS);
    const second = await test.service.run("weekly", LIMITS);
    expect((second.summary as { rejected: Record<string, number> }).rejected).toEqual({
      response_invalid: 1,
    });
  });

  it("charges the estimate of a call that failed", async () => {
    const test = harness({ memories: [memory("coffee")], failAnswer: true });
    const report = await test.service.run("weekly", LIMITS);
    expect(report.outcome).toBe("failed");
    expect(report.costMicros).toBe(100 + 10 + 100);
  });

  it("does not search when the remaining budget cannot cover the search estimate", async () => {
    const test = harness({
      memories: [memory("coffee")],
      recallEstimateMicros: 60,
      estimateMicros: 10,
    });
    const report = await test.service.run("weekly", { capMicros: 150, newMemoriesPerRun: 10 });
    expect(report.outcome).toBe("budget_exceeded");
    expect(test.recalls).toEqual([]);
  });

  it("records the run as failed when the owner's sample cannot be written", async () => {
    const test = harness({ memories: [memory("coffee")] });
    const report = await test.service.run("manual", {
      ...LIMITS,
      sampleSize: 30,
      writeSample: async () => {
        throw new Error("ENOSPC 燕麦");
      },
    });
    expect(report.outcome).toBe("failed");
    expect(test.store.runs[0]).toMatchObject({ outcome: "failed", summary: { failure: "Error" } });
    expect(JSON.stringify(test.store.runs[0])).not.toContain("燕麦");
  });

  it("searches with the classification of the memory behind the question", async () => {
    const test = harness({ memories: [memory("coffee", { dataClassification: "sensitive" })] });
    await test.service.run("manual", LIMITS);
    expect(test.recallClassifications).toEqual(["sensitive", "sensitive"]);
  });

  it("answers this week's new questions before the fixed panel", async () => {
    const test = harness({ memories: [memory("coffee")] });
    await test.service.run("weekly", LIMITS);
    test.memories = [memory("coffee"), memory("flight")];
    test.recalls.length = 0;
    await test.service.run("weekly", LIMITS);
    expect(test.recalls).toEqual([
      "我下个月去哪儿出差？",
      "我同事下个月去哪儿出差？",
      "我早上习惯喝什么？",
      "我妹妹早上喝什么？",
    ]);
  });

  it("stops at the spending cap and still records the run", async () => {
    const test = harness({ memories: [memory("coffee"), memory("flight")] });
    const report = await test.service.run("weekly", { capMicros: 450, newMemoriesPerRun: 10 });

    expect(report.outcome).toBe("budget_exceeded");
    expect(report.costMicros).toBeLessThanOrEqual(450);
    expect(test.store.runs).toHaveLength(1);
    expect(test.store.runs[0]?.outcome).toBe("budget_exceeded");
    const summary = report.summary as { items: number; unanswered: number };
    expect(summary.items + summary.unanswered).toBe(4);
    expect(summary.unanswered).toBeGreaterThan(0);
  });

  it("stops at once when a call costs more than its estimate", async () => {
    const test = harness({
      memories: [memory("coffee"), memory("flight")],
      estimateMicros: 1,
      answerCostMicros: 1_000,
    });
    const report = await test.service.run("weekly", { capMicros: 500, newMemoriesPerRun: 10 });
    expect(report.outcome).toBe("budget_exceeded");
    const answers = test.prompts.filter((prompt) => prompt.startsWith(REAL_EVAL_ANSWER.text));
    expect(answers).toHaveLength(1);
    expect(report.costMicros).toBe(2 * 100 + 10 + 1_000);
  });

  it("counts retrieval cost and does not search once the cap is used up", async () => {
    const test = harness({ memories: [memory("coffee")], estimateMicros: 0 });
    const report = await test.service.run("weekly", { capMicros: 100, newMemoriesPerRun: 10 });
    expect(report.outcome).toBe("budget_exceeded");
    expect(test.recalls).toEqual([]);
    expect(report.costMicros).toBe(100);
  });

  it("records a failed run without the error text", async () => {
    const test = harness({ memories: [memory("coffee")] });
    test.memories = [memory("coffee")];
    const failing = new RealMemoryEvalService({
      scope: { ownerId: OWNER, agentId: AGENT },
      store: test.store,
      model: {
        modelRef: "eval-model",
        estimateMicros: () => 1,
        generate: async () => {
          throw new Error("secret 燕麦拿铁 leaked");
        },
      },
      now: () => "2026-11-11T00:00:00.000Z",
      newId: () => "fixed-id",
      promptSha256: "a".repeat(64),
      maxSelectedMemories: 2,
      recallEstimateMicros: 0,
      listMemories: async () => test.memories,
      readMemoryText: async () => "主人早上只喝燕麦拿铁，不加糖",
      readQuote: async () => "我早上只喝燕麦拿铁，不加糖",
      storeQuestion: async () => "ref",
      readQuestion: async () => undefined,
      discardQuestion: async () => undefined,
      recall: async () => ({ memories: [], costMicros: 0 }),
      profile: async () => ({ memoryIds: [], texts: [], dataClassification: "public" as const }),
    });
    const report = await failing.run("manual", LIMITS);
    expect(report.outcome).toBe("failed");
    expect(JSON.stringify(test.store.runs[0])).not.toContain("燕麦");
  });

  it("adds the rated decision groups to the run without any model call", async () => {
    const test = harness({
      memories: [],
      decisions: [
        { kind: "proactive", outcome: "pushed", ownerRating: "useful", delivered: true },
        { kind: "consolidation", outcome: "merged", ownerRating: "unneeded", delivered: false },
      ],
    });
    const report = await test.service.run("weekly", LIMITS);
    expect(test.prompts).toHaveLength(0);
    expect((report.summary as { decisions: unknown }).decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "proactive_pushed", rated: 1, correct: 1 }),
        expect.objectContaining({ group: "consolidation", rated: 1, correct: 0 }),
      ]),
    );
  });
});
