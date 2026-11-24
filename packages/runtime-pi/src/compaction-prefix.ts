import { isDeepStrictEqual } from "node:util";
import type { Context, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildSessionProjection, convertToLlm } from "@earendil-works/pi-coding-agent";
import { COMPACTION_SUMMARY_INSTRUCTION } from "@himawari-agent/prompt-catalog";
import {
  applyToolResultClearing,
  clearedToolResultIds,
  type ToolResultClearingSettings,
} from "./tool-result-clearing.js";

export function compactionPrefixMessages(
  event: {
    readonly reason: "manual" | "threshold" | "overflow";
    readonly preparation: { readonly isSplitTurn: boolean; readonly firstKeptEntryId: string };
    readonly branchEntries: Parameters<typeof buildSessionProjection>[0];
  },
  clearing?: ToolResultClearingSettings,
): Message[] | undefined {
  if (event.reason !== "manual" && event.reason !== "threshold") return undefined;
  if (event.preparation.isSplitTurn) return undefined;
  const { entries } = buildSessionProjection(event.branchEntries);
  const cut = entries.findIndex(
    (entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId,
  );
  if (cut <= 0) return undefined;
  const all = entries.flatMap((entry) => entry.messages);
  const prefix = entries.slice(0, cut).flatMap((entry) => entry.messages);
  const lastAssistant = all.findLastIndex((message) => message.role === "assistant");
  const cleared = clearing
    ? clearedToolResultIds(all.slice(0, Math.max(0, lastAssistant)), clearing)
    : new Set<string>();
  const messages = convertToLlm(applyToolResultClearing(prefix, cleared) ?? prefix).filter(
    (message) => message.role !== "system",
  );
  return messages.length > 0 ? messages : undefined;
}

const COMPACTION_REQUEST_ROOM_TOKENS = 4096;

export function approximateTokens(text: string): number {
  let ascii = 0;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) < 128) ascii++;
  return Math.ceil(ascii / 3 + (text.length - ascii) / 1.2);
}

export function sharedSummaryOptions(
  options: SimpleStreamOptions | undefined,
  lastOptions: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
  const { cacheRetention: _cache, sessionId: _session, ...rest } = options ?? {};
  return {
    ...rest,
    ...(lastOptions?.cacheRetention === undefined
      ? {}
      : { cacheRetention: lastOptions.cacheRetention }),
    ...(lastOptions?.sessionId === undefined ? {} : { sessionId: lastOptions.sessionId }),
  };
}

export function sharedSummaryContext(
  lastRequest: Context | undefined,
  prefix: Message[] | undefined,
  contextWindow: number,
  maxTokens: number,
): Context | undefined {
  if (!lastRequest || !prefix) return undefined;
  const history = lastRequest.messages.slice(0, prefix.length);
  if (history.length !== prefix.length || !isDeepStrictEqual(history, prefix)) {
    return undefined;
  }
  const estimated =
    approximateTokens(lastRequest.systemPrompt ?? "") +
    approximateTokens(JSON.stringify(lastRequest.tools ?? [])) +
    approximateTokens(COMPACTION_SUMMARY_INSTRUCTION.text) +
    history.reduce((total, message) => total + approximateTokens(JSON.stringify(message)), 0);
  if (estimated + COMPACTION_REQUEST_ROOM_TOKENS + maxTokens > contextWindow) return undefined;
  return {
    ...lastRequest,
    messages: [
      ...history,
      {
        role: "user",
        content: COMPACTION_SUMMARY_INSTRUCTION.text,
        timestamp: history.at(-1)?.timestamp ?? 0,
      },
    ],
  };
}

export const COMPACTION_TRIGGER_CAP_TOKENS = 150_000;
const PI_DEFAULT_RESERVE_TOKENS = 16_384;
const CLEARING_TO_COMPACTION_RATIO = 2 / 3;

export function compactionTriggerTokens(contextWindow: number): number | undefined {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= PI_DEFAULT_RESERVE_TOKENS)
    return undefined;
  return Math.min(COMPACTION_TRIGGER_CAP_TOKENS, contextWindow - PI_DEFAULT_RESERVE_TOKENS);
}

export function toolResultClearingTriggerTokens(contextWindow: number): number | undefined {
  const compaction = compactionTriggerTokens(contextWindow);
  return compaction === undefined
    ? undefined
    : Math.floor(compaction * CLEARING_TO_COMPACTION_RATIO);
}

export function compactionModelOverrides(model: {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}): Record<string, { reserveTokens: number }> {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return {};
  if (model.contextWindow - PI_DEFAULT_RESERVE_TOKENS <= COMPACTION_TRIGGER_CAP_TOKENS) return {};
  return {
    [`${model.provider}/${model.id}`]: {
      reserveTokens: model.contextWindow - COMPACTION_TRIGGER_CAP_TOKENS,
    },
  };
}
