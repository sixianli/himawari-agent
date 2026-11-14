import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";

export const MODEL_USAGE_PURPOSES = [
  "chat",
  "thread-title",
  "memory-capture",
  "memory-episode",
  "memory-consolidation",
  "mail-judgment",
  "action-review",
  "review-prereview",
  "rule-review",
  "other",
] as const;

export type ModelUsagePurpose = (typeof MODEL_USAGE_PURPOSES)[number];

export type ModelUsageSource = "model-port" | "agent-stream";

export interface ModelUsageObservation {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly invocationId: string;
  readonly purpose: ModelUsagePurpose;
  readonly source: ModelUsageSource;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReported: boolean;
  readonly occurredAt: string;
}

export interface ModelUsageStorePort {
  record(observation: ModelUsageObservation): Promise<void>;
  isFollowUpTurn?(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly runId: RunId;
  }): Promise<boolean>;
}

export const MINIMUM_CACHEABLE_INPUT_TOKENS = 1024;
export const FOLLOW_UP_CACHE_HIT_FLOOR = 0.5;

export function lowCacheHitRate(observation: ModelUsageObservation): number | null {
  if (
    observation.purpose !== "chat" ||
    !observation.cacheReported ||
    observation.inputTokens < MINIMUM_CACHEABLE_INPUT_TOKENS
  )
    return null;
  const rate = observation.cacheReadTokens / observation.inputTokens;
  return rate < FOLLOW_UP_CACHE_HIT_FLOOR ? rate : null;
}

export function modelUsagePurpose(value: string): ModelUsagePurpose {
  if (value.startsWith("memory-episode")) return "memory-episode";
  return (MODEL_USAGE_PURPOSES as readonly string[]).includes(value)
    ? (value as ModelUsagePurpose)
    : "other";
}
