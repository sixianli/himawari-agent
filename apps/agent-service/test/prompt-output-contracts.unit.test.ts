import type { ProactiveSourceItem } from "@himawari-agent/application";
import * as application from "@himawari-agent/application";
import type { PromptEntry } from "@himawari-agent/prompt-catalog";
import * as catalog from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import * as capture from "../src/production-memory-capture.js";
import * as classification from "../src/production-memory-classification.js";
import * as review from "../src/production-memory-conversation-review.js";

const message = "我下周三要去大阪出差，记得提醒我前一天订酒店。";
const memory = {
  kind: "commitment",
  decision: "create",
  text: "主人下周三去大阪出差，前一天要订酒店",
  classification: "private",
  confidence: 950,
  category: "plan",
  importance: 600,
  entities: ["大阪"],
  quote: "我下周三要去大阪出差",
};

const captured = (output: string) =>
  capture.parseMemoryCandidates({
    output,
    sourceRef: "payload-source",
    sourceClassification: "private",
    existingIds: new Set(),
    ownerMessage: message,
  });

const mail: ProactiveSourceItem = {
  source: "gmail",
  messageId: "mail-a",
  threadId: "thread-a",
  from: "東京ガス",
  fromAddress: "info@example.com",
  subject: "11 月のご請求",
  snippet: "お支払い期限は 11 月 20 日です。",
  link: "https://mail.example.com/a",
  receivedAt: "2026-11-04T00:10:00.000Z",
  categories: [],
  sentByOwner: false,
  body: "お支払い期限は 11 月 20 日です。",
  bodyTruncated: false,
  bodyUnavailable: false,
  attachments: [],
};

const isEntry = (value: unknown): value is PromptEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  Array.isArray((value as { segments?: unknown }).segments);

const PARSERS: Readonly<Record<string, unknown>> = {
  parseMemoryCandidates: capture.parseMemoryCandidates,
  parseSupportVerdict: capture.parseSupportVerdict,
  parseMemoryClassifications: classification.parseMemoryClassifications,
  parseConversationReview: review.parseConversationReview,
  parseImportDuplicateAnswers: application.parseImportDuplicateAnswers,
  parseJudgements: application.parseJudgements,
  parseMailReferences: application.parseMailReferences,
  parseAutomaticReviewDecision: application.parseAutomaticReviewDecision,
  parseGeneratedQuestion: application.parseGeneratedQuestion,
  parseJudgeVerdict: application.parseJudgeVerdict,
  parseLeakVerdict: application.parseLeakVerdict,
  parsePrereview: application.parsePrereview,
  parseHomeUrgency: application.parseHomeUrgency,
  parseRuleReviewAnswer: application.parseRuleReviewAnswer,
};

const NOT_COVERED = new Set(["memory.consolidation", "memory.consolidation.format"]);

describe("[PROMPT-CONTRACT] background prompts and the parsers that read their answers", () => {
  it("names a real parser for every catalog prompt that asks for a structured answer, or lists it as not covered", () => {
    const structured = (Object.values(catalog) as unknown[])
      .filter(isEntry)
      .filter((entry) => entry.output === "json" || entry.output === "structured-choice");
    const problems = structured.flatMap((entry) => {
      if (NOT_COVERED.has(entry.id))
        return entry.parser === undefined ? [] : [`LISTED_BUT_HAS_PARSER ${entry.id}`];
      if (entry.parser === undefined) return [`NO_PARSER ${entry.id}`];
      return typeof PARSERS[entry.parser] === "function"
        ? []
        : [`UNKNOWN_PARSER ${entry.id} ${entry.parser}`];
    });
    expect(problems).toEqual([]);
    expect(
      structured
        .filter((entry) => !NOT_COVERED.has(entry.id))
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "eval.real-memory.judge",
        "eval.real-memory.leak-judge",
        "eval.real-memory.question",
        "home.urgency",
        "mail.judgment",
        "mail.reference-extraction",
        "memory.capture",
        "memory.classification",
        "memory.confirmation-judge",
        "memory.conversation-review",
        "memory.import-duplicate-question",
        "review.prereview",
        "review.typesafe-questions",
        "rule.review",
      ].sort(),
    );
  });

  it("memory capture: accepts the JSON the prompt asks for, also inside a Markdown fence", () => {
    expect(captured(JSON.stringify({ memories: [memory] })).candidates).toHaveLength(1);
    expect(
      captured(`\`\`\`json\n${JSON.stringify({ memories: [memory] })}\n\`\`\``).candidates,
    ).toHaveLength(1);
    expect(captured(JSON.stringify({ memories: [] })).returnedNone).toBe(true);
  });

  it("memory capture: rejects a renamed top-level key, a missing field and plain text", () => {
    expect(() => captured(JSON.stringify({ items: [memory] }))).toThrow(
      "MEMORY_CAPTURE_RESPONSE_INVALID",
    );
    const { text: _text, ...withoutText } = memory;
    const missing = captured(JSON.stringify({ memories: [withoutText] }));
    expect(missing.candidates).toHaveLength(0);
    expect(missing.invalidCandidates).toBe(1);
    expect(() => captured("好的，我记下了。")).toThrow("MEMORY_CAPTURE_RESPONSE_INVALID");
  });

  it("memory classification: accepts the items JSON the prompt asks for and rejects anything else", () => {
    const example = JSON.stringify({
      items: [{ id: "0", category: "preference", classification: "private", topic: null }],
    });
    expect(classification.parseMemoryClassifications(example, ["0"]).get("0")).toEqual({
      category: "preference",
      classification: "private",
      topic: null,
      failed: false,
    });
    expect(
      classification.parseMemoryClassifications(`\`\`\`json\n${example}\n\`\`\``, ["0"]).size,
    ).toBe(1);
    expect(() => classification.parseMemoryClassifications("好的", ["0"])).toThrow(
      "MEMORY_CLASSIFICATION_RESPONSE_INVALID",
    );
    expect(
      classification.parseMemoryClassifications(
        JSON.stringify({ items: [{ id: "0", category: "preference", classification: "secret" }] }),
        ["0"],
      ).size,
    ).toBe(0);
  });

  it("mail judgment: accepts the items JSON the prompt asks for", () => {
    const parsed = application.parseJudgements(
      JSON.stringify({ items: [{ id: "mail-a", result: "ignore", confidence: "sure" }] }),
      [mail],
    );
    expect(parsed?.get("mail-a")?.result).toBe("ignore");
  });

  it("[P4-5] real eval question: accepts the JSON the prompt asks for, also inside a Markdown fence", () => {
    const sources = { memory: "主人住在大阪市北区。", quote: "我家在大阪北区" };
    const answer = JSON.stringify({
      question: "我现在住在哪个城市？",
      kind: "fact",
      abstainQuestion: "我妹妹住在哪个城市？",
    });
    expect(application.parseGeneratedQuestion(answer, sources)).toMatchObject({ kind: "fact" });
    expect(
      application.parseGeneratedQuestion(`\`\`\`json\n${answer}\n\`\`\``, sources),
    ).toMatchObject({
      kind: "fact",
    });
    expect(
      application.parseGeneratedQuestion(
        JSON.stringify({ question: null, kind: null, abstainQuestion: null }),
        sources,
      ),
    ).toEqual({ rejected: "declined" });
  });

  it("[P4-5] real eval question and judge: reject a renamed key and plain text", () => {
    const sources = { memory: "主人住在大阪市北区。", quote: "我家在大阪北区" };
    expect(
      application.parseGeneratedQuestion(JSON.stringify({ q: "我住哪？", kind: "fact" }), sources),
    ).toEqual({ rejected: "question_invalid" });
    expect(application.parseGeneratedQuestion("我住哪？", sources)).toEqual({
      rejected: "response_invalid",
    });
    expect(application.parseJudgeVerdict(JSON.stringify({ verdict: "correct" }))).toBe("correct");
    expect(application.parseJudgeVerdict(JSON.stringify({ result: "correct" }))).toBeNull();
    expect(application.parseJudgeVerdict("答对了")).toBeNull();
  });

  it("home urgency: accepts the items JSON the prompt asks for, and rejects a renamed key and plain text", () => {
    expect(
      application
        .parseHomeUrgency(
          JSON.stringify({
            items: [{ n: 1, score: 640, sentence: "给田中发确认邮件", affirm: "发出去" }],
          }),
          1,
        )
        .get(1),
    ).toEqual({ score: 640, sentence: "给田中发确认邮件", affirm: "发出去" });
    expect(
      application.parseHomeUrgency(JSON.stringify({ scores: [{ n: 1, score: 640 }] }), 1).size,
    ).toBe(0);
    expect(application.parseHomeUrgency("第一件最要紧。", 1).size).toBe(0);
  });

  it("mail judgment: rejects a renamed top-level key and plain text", () => {
    expect(
      application.parseJudgements(
        JSON.stringify({ mails: [{ id: "mail-a", result: "ignore", confidence: "sure" }] }),
        [mail],
      ),
    ).toBeUndefined();
    expect(application.parseJudgements("全部忽略。", [mail])).toBeUndefined();
  });
});
