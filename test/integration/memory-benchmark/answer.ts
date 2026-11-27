import type { BenchmarkQuestion, BenchmarkSample } from "./datasets.ts";
import type { ChatMessage } from "./model.ts";
import type { RelatedMemory } from "./store.ts";

export interface StoreContext {
  readonly ownerName: string | null;
  readonly profile: string;
  readonly related: readonly RelatedMemory[];
}

function day(at: string): string {
  return at.slice(0, 10);
}

function askedOn(question: BenchmarkQuestion): string {
  return `${question.askedAt.slice(0, 16).replace("T", " ")} UTC`;
}

const LOCOMO_SYSTEM =
  "You are a personal assistant. Each person in the conversation below has their own Himawari assistant, and you can read what each assistant remembers about its owner. Answer the question using only these memories. Give a short, direct answer. When the memories do not contain the answer, say that you do not know.";

const LONGMEMEVAL_SYSTEM =
  "You are Himawari, the user's personal assistant. Below is what you remember about the user from earlier conversations. Answer the user's question using these memories. Give a short, direct answer. When the memories do not contain the answer, say that you do not know.";

function owner(context: StoreContext): string {
  return context.ownerName ? `${context.ownerName}'s assistant` : "you";
}

function profileSection(context: StoreContext): string {
  const title = context.ownerName
    ? `## Memory list kept by ${owner(context)} about ${context.ownerName}`
    : "## Your memory list about the user";
  return `${title}\n${context.profile.length > 0 ? context.profile : "(empty)"}`;
}

function relatedSection(context: StoreContext): string {
  const title = context.ownerName
    ? `## Memories ${owner(context)} found for this question`
    : "## Memories you found for this question";
  const lines =
    context.related.length === 0
      ? "(none)"
      : context.related.map(({ text, recordedAt }) => `- [${day(recordedAt)}] ${text}`).join("\n");
  return `${title}\n${lines}`;
}

export function memoryAnswerMessages(
  sample: BenchmarkSample,
  question: BenchmarkQuestion,
  contexts: readonly StoreContext[],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: sample.benchmark === "locomo" ? LOCOMO_SYSTEM : LONGMEMEVAL_SYSTEM,
    },
    {
      role: "user",
      content: `${[...contexts.map(profileSection), ...contexts.map(relatedSection)].join("\n\n")}\n\nCurrent time: ${askedOn(question)}\nQuestion: ${question.question}`,
    },
  ];
}

const FULL_CONTEXT_SYSTEM =
  "You are a personal assistant. Below is the full history of earlier conversations. Answer the question using this history. Give a short, direct answer. When the history does not contain the answer, say that you do not know.";

export function fullContextMessages(
  sample: BenchmarkSample,
  question: BenchmarkQuestion,
): ChatMessage[] {
  return [
    { role: "system", content: FULL_CONTEXT_SYSTEM },
    {
      role: "user",
      content: `# Conversation history\n\n${sample.transcript}\n\nCurrent time: ${askedOn(question)}\nQuestion: ${question.question}`,
    },
  ];
}

export function evidenceHit(
  question: BenchmarkQuestion,
  sessionIds: Iterable<string>,
): boolean | null {
  if (question.abstention || question.evidenceSessionIds.length === 0) return null;
  const found = new Set(sessionIds);
  return question.evidenceSessionIds.some((id) => found.has(id));
}
