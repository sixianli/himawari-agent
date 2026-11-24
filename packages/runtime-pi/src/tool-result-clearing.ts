import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  renderPrompt,
  TOOL_RESULT_CLEARED_PLACEHOLDER,
  TOOL_RESULT_RECALL_NOT_FOUND,
} from "@himawari-agent/prompt-catalog";
import { namesRememberedValue } from "@himawari-agent/sensitive-capture";
import { approximateTokens } from "./compaction-prefix.js";

export const TOOL_RESULT_RECALL_TOOL_NAME = "tool_result_recall";

export interface ToolResultClearingSettings {
  readonly triggerTokens: number;
  readonly keepToolUses: number;
  readonly clearAtLeastTokens: number;
  readonly keepToolNames: ReadonlySet<string>;
}

export const DEFAULT_KEEP_TOOL_USES = 3;
export const DEFAULT_CLEAR_AT_LEAST_TOKENS = 5_000;
const IMAGE_TOKENS = 1_600;

type ClearableMessage = { readonly role: string; readonly timestamp?: unknown };

function isToolResult(message: ClearableMessage): message is ToolResultMessage {
  return (
    message.role === "toolResult" &&
    typeof (message as Partial<ToolResultMessage>).toolCallId === "string" &&
    typeof (message as Partial<ToolResultMessage>).toolName === "string" &&
    Array.isArray((message as Partial<ToolResultMessage>).content)
  );
}

function usageTokens(message: ClearableMessage): number | undefined {
  if (message.role !== "assistant") return undefined;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return undefined;
  const total = ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => {
    const value = usage[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? sum + value
      : sum;
  }, 0);
  return total > 0 ? total : undefined;
}

function timestampOf(message: ClearableMessage): number | undefined {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
}

function blockTokens(block: unknown): number {
  if (typeof block !== "object" || block === null) return approximateTokens(String(block));
  const { type, text } = block as { readonly type?: unknown; readonly text?: unknown };
  if (type === "image") return IMAGE_TOKENS;
  return approximateTokens(typeof text === "string" ? text : (JSON.stringify(block) ?? ""));
}

export function contentTokens(content: readonly (TextContent | ImageContent)[]): number {
  return content.reduce((total, block) => total + blockTokens(block), 0);
}

function namesMaskedSecret(message: ToolResultMessage): boolean {
  return message.content.some((block) => {
    const text = (block as { readonly text?: unknown } | null)?.text;
    return typeof text === "string" && namesRememberedValue(text);
  });
}

function messageTokens(message: ClearableMessage): number {
  if (isToolResult(message)) return contentTokens(message.content);
  return approximateTokens(JSON.stringify(message) ?? "");
}

export function clearedToolResultIds(
  messages: readonly ClearableMessage[],
  settings: ToolResultClearingSettings,
): ReadonlySet<string> {
  const cleared = new Set<string>();
  const seen: {
    readonly id: string;
    readonly name: string;
    readonly tokens: number;
    readonly message: ToolResultMessage;
    namesSecret?: boolean;
  }[] = [];
  let measured: number | undefined;
  let sinceMeasured = 0;
  let compactedAt: number | undefined;
  const evaluate = () => {
    if (measured === undefined || measured + sinceMeasured <= settings.triggerTokens) return;
    const older = seen.slice(0, Math.max(0, seen.length - settings.keepToolUses));
    const candidates = older.filter((result) => {
      if (cleared.has(result.id) || settings.keepToolNames.has(result.name)) return false;
      result.namesSecret ??= namesMaskedSecret(result.message);
      return !result.namesSecret;
    });
    const tokens = candidates.reduce((total, result) => total + result.tokens, 0);
    if (candidates.length === 0 || tokens < settings.clearAtLeastTokens) return;
    for (const result of candidates) cleared.add(result.id);
  };
  for (const message of messages) {
    if (message.role === "assistant") evaluate();
    if (message.role === "compactionSummary") {
      compactedAt = timestampOf(message) ?? compactedAt;
      measured = undefined;
      sinceMeasured = 0;
      continue;
    }
    const usage = usageTokens(message);
    const stamp = timestampOf(message);
    const fresh = compactedAt === undefined || (stamp !== undefined && stamp > compactedAt);
    if (usage !== undefined && fresh) {
      measured = usage;
      sinceMeasured = 0;
      continue;
    }
    const tokens = messageTokens(message);
    sinceMeasured += tokens;
    if (isToolResult(message))
      seen.push({ id: message.toolCallId, name: message.toolName, tokens, message });
  }
  evaluate();
  return cleared;
}

export function clearedToolResultPlaceholder(message: ToolResultMessage): ToolResultMessage {
  return {
    ...message,
    content: [
      {
        type: "text",
        text: renderPrompt(TOOL_RESULT_CLEARED_PLACEHOLDER, {
          toolName: message.toolName,
          toolCallId: message.toolCallId,
        }),
      },
    ],
  };
}

export function applyToolResultClearing<T extends ClearableMessage>(
  messages: readonly T[],
  cleared: ReadonlySet<string>,
): T[] | undefined {
  if (cleared.size === 0) return undefined;
  let changed = false;
  const result = messages.map((message) => {
    if (!isToolResult(message) || !cleared.has(message.toolCallId)) return message;
    changed = true;
    return clearedToolResultPlaceholder(message) as unknown as T;
  });
  return changed ? result : undefined;
}

export function clearToolResults<T extends ClearableMessage>(
  messages: readonly T[],
  settings: ToolResultClearingSettings,
): T[] | undefined {
  return applyToolResultClearing(messages, clearedToolResultIds(messages, settings));
}

export function recallToolResult(
  messages: readonly ClearableMessage[],
  toolCallId: unknown,
): { readonly content: (TextContent | ImageContent)[]; readonly found: boolean } {
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  const found =
    id.length === 0
      ? undefined
      : messages.find(
          (message): message is ToolResultMessage =>
            isToolResult(message) && message.toolCallId === id,
        );
  if (found && !(found.toolName === TOOL_RESULT_RECALL_TOOL_NAME && found.isError))
    return { content: structuredClone(found.content), found: true };
  return {
    content: [
      { type: "text", text: renderPrompt(TOOL_RESULT_RECALL_NOT_FOUND, { toolCallId: id }) },
    ],
    found: false,
  };
}
