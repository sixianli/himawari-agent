import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceHit, fullContextMessages, memoryAnswerMessages } from "./answer.ts";
import {
  armMetrics,
  locomoSamples,
  longMemEvalSamples,
  parseJudgeVerdict,
  parseLocomoDate,
  parseLongMemEvalDate,
  stratifiedLongMemEval,
} from "./datasets.ts";
import { BudgetReachedError, ChatClient, DEEPSEEK_V4_1_FLASH_PRICES } from "./model.ts";
import { finishedSamples, readEarlierRound } from "./resume.ts";

const locomo = [
  {
    sample_id: "conv-1",
    conversation: {
      speaker_a: "Caroline",
      speaker_b: "Melanie",
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_1: [
        { speaker: "Caroline", dia_id: "D1:1", text: "I went to a support group yesterday." },
        { speaker: "Melanie", dia_id: "D1:2", text: "That sounds great!", blip_caption: "a cake" },
      ],
      session_2_date_time: "10:00 am on 20 May, 2023",
      session_2: [{ speaker: "Melanie", dia_id: "D2:1", text: "I painted a sunrise." }],
    },
    qa: [
      {
        question: "When did Caroline go to the support group?",
        answer: "7 May 2023",
        evidence: ["D1:1"],
        category: 2,
      },
      { question: "What did Melanie paint?", answer: "a sunrise", evidence: ["D2:1"], category: 4 },
      { question: "Adversarial", adversarial_answer: "x", evidence: ["D1:2"], category: 5 },
    ],
  },
];

function lme(id: string, type: string) {
  return {
    question_id: id,
    question_type: type,
    question: "What did I buy?",
    answer: "a bike",
    question_date: "2023/06/01 (Thu) 10:00",
    haystack_dates: ["2023/05/30 (Tue) 23:40", "2023/05/01 (Mon) 08:00"],
    haystack_session_ids: ["late", "early"],
    haystack_sessions: [
      [
        { role: "user" as const, content: "I bought a bike." },
        { role: "assistant" as const, content: "Nice." },
      ],
      [{ role: "user" as const, content: "Hello." }],
    ],
    answer_session_ids: ["late"],
  };
}

describe("memory benchmark datasets", () => {
  it("reads the two benchmarks' date formats as UTC", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseLocomoDate("12:05 am on 1 January, 2024")).toBe("2024-01-01T00:05:00.000Z");
    expect(parseLongMemEvalDate("2023/05/30 (Tue) 23:40")).toBe("2023-05-30T23:40:00.000Z");
    expect(() => parseLocomoDate("yesterday")).toThrow("BENCH_LOCOMO_DATE_INVALID");
  });

  it("splits a LoCoMo conversation into one store per speaker and drops adversarial questions", () => {
    const [sample] = locomoSamples(locomo as never);
    expect(sample?.stores.map(({ id }) => id)).toEqual(["conv-1:Caroline", "conv-1:Melanie"]);
    expect(
      sample?.stores[0]?.turns.map(({ speaker, text, sessionId }) => [speaker, text, sessionId]),
    ).toEqual([
      ["owner", "I went to a support group yesterday.", "D1"],
      ["other", "Melanie: That sounds great! [Sharing image that shows: a cake]", "D1"],
      ["other", "Melanie: I painted a sunrise.", "D2"],
    ]);
    expect(sample?.stores[1]?.turns[1]?.speaker).toBe("owner");
    expect(sample?.stores[0]?.turns[1]?.at).toBe("2023-05-08T13:56:30.000Z");
    expect(
      sample?.questions.map(({ category, evidenceSessionIds, askedAt }) => [
        category,
        evidenceSessionIds,
        askedAt,
      ]),
    ).toEqual([
      ["temporal", ["D1"], "2023-05-20T10:00:00.000Z"],
      ["single-hop", ["D2"], "2023-05-20T10:00:00.000Z"],
    ]);
  });

  it("orders LongMemEval sessions by date and marks abstention questions", () => {
    const [sample] = longMemEvalSamples([lme("q1_abs", "temporal-reasoning")]);
    expect(sample?.stores[0]?.turns.map(({ speaker, sessionId }) => [speaker, sessionId])).toEqual([
      ["owner", "early"],
      ["owner", "late"],
      ["other", "late"],
    ]);
    expect(sample?.transcript.indexOf("Session early")).toBeLessThan(
      sample?.transcript.indexOf("Session late") ?? 0,
    );
    expect(sample?.questions[0]).toMatchObject({ abstention: true, evidenceSessionIds: ["late"] });
  });

  it("samples LongMemEval evenly within each question type", () => {
    const raw = [
      ...Array.from({ length: 6 }, (_, index) => lme(`a${index}`, "multi-session")),
      lme("b0", "knowledge-update"),
    ];
    expect(stratifiedLongMemEval(raw, 3).map(({ question_id }) => question_id)).toEqual([
      "b0",
      "a0",
      "a2",
      "a4",
    ]);
  });

  it("reads judge verdicts in both benchmarks' formats and refuses unclear ones", () => {
    expect(parseJudgeVerdict("locomo", '{"reasoning":"same date","label":"CORRECT"}')).toBe(true);
    expect(parseJudgeVerdict("locomo", "WRONG")).toBe(false);
    expect(parseJudgeVerdict("locomo", "CORRECT or WRONG")).toBeNull();
    expect(parseJudgeVerdict("longmemeval", "Yes.")).toBe(true);
    expect(parseJudgeVerdict("longmemeval", "no")).toBe(false);
    expect(parseJudgeVerdict("longmemeval", "maybe")).toBeNull();
  });

  it("puts the fixed memory list before the per-question memories and the question last", () => {
    const [sample] = locomoSamples(locomo as never);
    if (!sample) throw new Error("missing sample");
    const question = sample.questions[0];
    if (!question) throw new Error("missing question");
    const [, user] = memoryAnswerMessages(sample, question, [
      { ownerName: "Caroline", profile: "- support group", related: [] },
      {
        ownerName: "Melanie",
        profile: "- paints",
        related: [
          {
            id: "m",
            text: "painted a sunrise",
            recordedAt: "2023-05-20T10:00:00.000Z",
            sessionIds: ["D2"],
          },
        ],
      },
    ]);
    const content = user?.content ?? "";
    expect(content.indexOf("- paints")).toBeLessThan(content.indexOf("found for this question"));
    expect(content).toContain("- [2023-05-20] painted a sunrise");
    expect(content.endsWith(`Question: ${question.question}`)).toBe(true);
    expect(fullContextMessages(sample, question)[1]?.content.endsWith(question.question)).toBe(
      true,
    );
    expect(evidenceHit(question, ["D2"])).toBe(false);
    expect(evidenceHit(question, ["D1"])).toBe(true);
  });

  it("scores accuracy only over judged answers, per category", () => {
    const outcome = (category: string, correct: boolean | null) => ({
      sampleId: "s",
      questionId: "q",
      category,
      arm: "memory" as const,
      correct,
      response: "",
      contextTokens: 100,
      answerMs: 10,
      evidenceRecalled: correct,
      evidenceStored: true,
    });
    const metrics = armMetrics([outcome("a", true), outcome("a", false), outcome("b", null)]);
    expect(metrics).toMatchObject({
      questions: 3,
      judged: 2,
      accuracy: 0.5,
      evidenceRecall: 0.5,
      evidenceStored: 1,
      byCategory: { a: { questions: 2, accuracy: 0.5 }, b: { questions: 1, accuracy: null } },
    });
  });
});

describe("benchmark model client", () => {
  const ok = (text: string) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: text } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      }),
      { status: 200 },
    );
  const request = {
    purpose: "capture",
    session: "s",
    messages: [{ role: "user" as const, content: "hi" }],
    maxTokens: 10,
  };

  it("waits out a rate limit instead of failing the call, and prices cached tokens apart", async () => {
    const replies = [new Response("{}", { status: 429 }), ok("done")];
    const client = new ChatClient({
      baseUrl: "http://model.invalid",
      model: "m",
      prices: DEEPSEEK_V4_1_FLASH_PRICES,
      capUsd: 1,
      concurrency: 2,
      rateLimitPauseMs: 1,
      fetch: async () => replies.shift() ?? new Response("{}", { status: 500 }),
    });
    expect((await client.chat(request)).text).toBe("done");
    expect(client.usage.get("capture")).toMatchObject({ calls: 1, failures: 0, rateLimited: 1 });
    expect(client.spentUsd).toBeCloseTo(600 * 0.15e-6 + 400 * 0.003e-6 + 10 * 0.6e-6, 12);
  });

  it("gives up on a rate limit that does not clear, and stops before the budget is passed", async () => {
    const limited = new ChatClient({
      baseUrl: "http://model.invalid",
      model: "m",
      prices: DEEPSEEK_V4_1_FLASH_PRICES,
      capUsd: 1,
      concurrency: 1,
      rateLimitPauseMs: 1,
      rateLimitGiveUpMs: 20,
      fetch: async () => new Response("{}", { status: 429 }),
    });
    await expect(limited.chat(request)).rejects.toThrow("BENCH_MODEL_429");
    const broke = new ChatClient({
      baseUrl: "http://model.invalid",
      model: "m",
      prices: DEEPSEEK_V4_1_FLASH_PRICES,
      capUsd: 0.0000001,
      concurrency: 1,
      fetch: async () => ok("x"),
    });
    await broke.chat(request);
    await expect(broke.chat(request)).rejects.toBeInstanceOf(BudgetReachedError);
  });
});

describe("resuming an interrupted round", () => {
  it("keeps only samples whose stores and every question in every arm were recorded, and carries the earlier spend", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "himawari-bench-resume-"));
    const [sample] = locomoSamples(locomo);
    if (!sample) throw new Error("sample");
    const other = {
      ...sample,
      id: "conv-2",
      stores: sample.stores.map((store) => ({ ...store, id: `${store.id}-2` })),
    };
    const outcome = (sampleId: string, questionId: string, arm: string) =>
      JSON.stringify({
        sampleId,
        questionId,
        arm,
        category: "1",
        correct: true,
        response: "",
        contextTokens: 1,
        answerMs: 1,
        evidenceRecalled: null,
        evidenceStored: null,
      });
    const lines = sample.questions.flatMap((question) => [
      outcome(sample.id, question.id, "memory"),
      outcome(sample.id, question.id, "full-context"),
    ]);
    lines.push(outcome(other.id, sample.questions[0]?.id ?? "", "memory"));
    await writeFile(path.join(output, "outcomes.jsonl"), `${lines.join("\n")}\n`);
    await writeFile(
      path.join(output, "stores.jsonl"),
      `${[...sample.stores, ...other.stores].map(({ id }) => JSON.stringify({ id, benchmark: "locomo" })).join("\n")}\n`,
    );
    await writeFile(path.join(output, "progress.json"), JSON.stringify({ spentUsd: 1.25 }));
    const earlier = await readEarlierRound(output);
    expect(earlier.spentUsd).toBe(1.25);
    expect([
      ...finishedSamples([sample, other], earlier, () => ["memory", "full-context"]),
    ]).toEqual([sample.id]);
    expect([...finishedSamples([sample, other], earlier, () => ["memory"])]).toEqual([sample.id]);
  });

  it("REVERSE: a fresh output directory resumes nothing and has spent nothing", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "himawari-bench-resume-"));
    const earlier = await readEarlierRound(output);
    expect(earlier).toEqual({ spentUsd: 0, outcomes: [], stores: [] });
    expect(finishedSamples(locomoSamples(locomo), earlier, () => ["memory"]).size).toBe(0);
  });

  it("REVERSE: a sample missing one store is not resumed even when its answers were recorded", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "himawari-bench-resume-"));
    const [sample] = locomoSamples(locomo);
    if (!sample) throw new Error("sample");
    await writeFile(
      path.join(output, "outcomes.jsonl"),
      sample.questions
        .map((question) =>
          JSON.stringify({ sampleId: sample.id, questionId: question.id, arm: "memory" }),
        )
        .join("\n"),
    );
    await writeFile(
      path.join(output, "stores.jsonl"),
      JSON.stringify({ id: sample.stores[0]?.id }),
    );
    expect(finishedSamples([sample], await readEarlierRound(output), () => ["memory"]).size).toBe(
      0,
    );
  });
});
