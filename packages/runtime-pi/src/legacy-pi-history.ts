import type { RuntimeHistoryState } from "@himawari-agent/application/runtime-port";
import { nativeHistoryMessages } from "./pi-native-history.js";

export interface LegacyPiRunHistory {
  readonly runId: RuntimeHistoryState["coveredRunIds"][number];
  readonly status: "completed" | "failed" | "cancelled";
  /** Caller must verify Owner/Agent/Thread, causal order, artifact digest and decryption. */
  readonly finalizedMessages: readonly unknown[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One-time qualification of verified legacy observations; never used for normal Run replay. */
export function qualifyLegacyPiHistory(runs: readonly LegacyPiRunHistory[]): RuntimeHistoryState & {
  readonly duplicateMessages: number;
  readonly repairedUsageTotals: number;
  readonly incompleteCancelledRuns: readonly string[];
} {
  const messages: unknown[] = [],
    coveredRunIds: RuntimeHistoryState["coveredRunIds"][number][] = [];
  const incompleteCancelledRuns: string[] = [];
  let duplicateMessages = 0,
    repairedUsageTotals = 0;
  for (const run of runs) {
    if (coveredRunIds.includes(run.runId)) throw new Error("LEGACY_HISTORY_DUPLICATE_RUN");
    const seen = new Set<string>(),
      pending = new Map<string, string>(),
      called = new Set<string>();
    let endedAssistant = false,
      userCount = 0,
      timestamp = 0;
    for (const source of run.finalizedMessages) {
      const identity = JSON.stringify(source);
      if (seen.has(identity)) {
        duplicateMessages++;
        continue;
      }
      seen.add(identity);
      const message: unknown = structuredClone(source);
      if (
        !record(message) ||
        !["user", "assistant", "toolResult"].includes(String(message["role"]))
      )
        throw new Error("LEGACY_HISTORY_MESSAGE_INVALID");
      const usage = message["usage"];
      // Pi 0.84.2 OpenAI-completions defines this total as the sum of these four fields.
      // Legacy observer redaction matched "totalTokens" even though it was not a secret.
      if (
        message["role"] === "assistant" &&
        message["api"] === "openai-completions" &&
        record(usage) &&
        usage["totalTokens"] === "[REDACTED]" &&
        ["input", "output", "cacheRead", "cacheWrite"].every(
          (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0,
        )
      ) {
        usage["totalTokens"] = ["input", "output", "cacheRead", "cacheWrite"].reduce(
          (sum, key) => sum + (usage[key] as number),
          0,
        );
        repairedUsageTotals++;
      }
      if (
        JSON.stringify(message).includes("[REDACTED") ||
        JSON.stringify(message).includes("RUNTIME_TOOL_SUSPENDED")
      )
        throw new Error("LEGACY_HISTORY_CONTENT_UNAVAILABLE");
      const native = nativeHistoryMessages([message])[0];
      if (!native || !["user", "assistant", "toolResult"].includes(native.role))
        throw new Error("LEGACY_HISTORY_MESSAGE_INVALID");
      timestamp = Math.max(timestamp, native.timestamp);
      if (native.role === "user") {
        if (++userCount !== 1 || seen.size !== 1)
          throw new Error("LEGACY_HISTORY_USER_BOUNDARY_INVALID");
      } else if (userCount !== 1) throw new Error("LEGACY_HISTORY_USER_MISSING");
      if (native.role === "assistant") {
        if (pending.size) throw new Error("LEGACY_HISTORY_TOOL_RESULT_MISSING");
        endedAssistant = true;
        for (const block of native.content)
          if (block.type === "toolCall") {
            if (called.has(block.id)) throw new Error("LEGACY_HISTORY_DUPLICATE_CALL");
            called.add(block.id);
            pending.set(block.id, block.name);
          }
      } else if (native.role === "toolResult") {
        if (pending.get(native.toolCallId) !== native.toolName)
          throw new Error("LEGACY_HISTORY_ORPHAN_RESULT");
        pending.delete(native.toolCallId);
      }
      messages.push(message);
    }
    if (userCount !== 1 || pending.size) throw new Error("LEGACY_HISTORY_INCOMPLETE");
    if (!endedAssistant && run.status !== "cancelled") throw new Error("LEGACY_HISTORY_INCOMPLETE");
    if (run.status === "cancelled") {
      if (!endedAssistant) incompleteCancelledRuns.push(run.runId);
      messages.push({
        role: "custom",
        customType: "himawari.turn_aborted",
        display: false,
        timestamp,
        content:
          "<turn_aborted>The user interrupted this turn. The legacy record may omit partial output. Recorded tool results remain authoritative; cancellation does not undo side effects. Handle the new request and resume earlier work only when requested.</turn_aborted>",
      });
    }
    coveredRunIds.push(run.runId);
  }
  return {
    messages,
    coveredRunIds,
    duplicateMessages,
    repairedUsageTotals,
    incompleteCancelledRuns,
  };
}
