import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";

export const MODEL_USAGE_PURPOSES = [
  "chat",
  "thread-title",
  "memory-capture",
  "memory-episode",
  "memory-consolidation",
  "mail-judgment",
  "action-review",
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
}

export function modelUsagePurpose(value: string): ModelUsagePurpose {
  if (value.startsWith("memory-episode")) return "memory-episode";
  return (MODEL_USAGE_PURPOSES as readonly string[]).includes(value)
    ? (value as ModelUsagePurpose)
    : "other";
}
