import type { BenchmarkQuestion, BenchmarkSample } from "./datasets.ts";
import type { ChatMessage, ChatRequest, ChatResult, ChatTool } from "./model.ts";
import type { ConversationToolOutcome, RelatedMemory } from "./store.ts";

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

const CONVERSATION_SEARCH_GUIDANCE =
  " You can also search and open the original earlier conversations, including what you said, with the conversation_search and conversation_open tools. When the answer depends on details from earlier conversations (dates, numbers, exact words, what you recommended), search the original conversations before answering instead of guessing from a one-line memory.";

export const MAXIMUM_TOOL_ROUNDS = 6;

export interface ToolAnswer {
  readonly text: string;
  readonly promptTokens: number;
  readonly ms: number;
  readonly toolCalls: number;
  readonly sessionIds: readonly string[];
}

export async function answerWithConversationTools(input: {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ChatTool[];
  readonly chat: (request: Pick<ChatRequest, "messages" | "tools">) => Promise<ChatResult>;
  readonly runTool: (
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ) => Promise<ConversationToolOutcome>;
}): Promise<ToolAnswer> {
  const [system, ...rest] = input.messages;
  const messages: ChatMessage[] = [
    ...(system && system.role === "system"
      ? [{ role: "system" as const, content: `${system.content}${CONVERSATION_SEARCH_GUIDANCE}` }]
      : []),
    ...(system && system.role !== "system" ? [system] : []),
    ...rest,
  ];
  const sessionIds = new Set<string>();
  let promptTokens = 0;
  let ms = 0;
  let toolCalls = 0;
  for (let round = 0; ; round += 1) {
    const last = round >= MAXIMUM_TOOL_ROUNDS;
    const result = await input.chat({ messages, ...(last ? {} : { tools: input.tools }) });
    promptTokens += result.promptTokens;
    ms += result.ms;
    if (last || result.toolCalls.length === 0)
      return { text: result.text, promptTokens, ms, toolCalls, sessionIds: [...sessionIds] };
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      toolCalls += 1;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
      const outcome = await input.runTool(call.function.name, args, call.id);
      for (const id of outcome.sessionIds) sessionIds.add(id);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(outcome.output),
      });
    }
  }
}
