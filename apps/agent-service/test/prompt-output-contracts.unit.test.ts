import type { ProactiveSourceItem } from "@himawari-agent/application";
import * as application from "@himawari-agent/application";
import type { PromptEntry } from "@himawari-agent/prompt-catalog";
import * as catalog from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import * as capture from "../src/production-memory-capture.js";

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
  parseJudgements: application.parseJudgements,
  parseAutomaticReviewDecision: application.parseAutomaticReviewDecision,
  parsePrereview: application.parsePrereview,
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
      ["mail.judgment", "memory.capture", "review.prereview", "review.typesafe-questions"].sort(),
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

  it("mail judgment: accepts the items JSON the prompt asks for", () => {
    const parsed = application.parseJudgements(
      JSON.stringify({ items: [{ id: "mail-a", result: "ignore", confidence: "sure" }] }),
      [mail],
    );
    expect(parsed?.get("mail-a")?.result).toBe("ignore");
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
