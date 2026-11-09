import type { AgentId, OwnerId, RunId, ThreadId } from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";
import type { RuntimeRequest } from "./intelligence.js";
import type { PayloadRecord } from "./observability.js";

export const THREAD_PROMPT_BUNDLE_ORIGINS = [
  "new_thread",
  "rollout",
  "tool_set_changed",
  "tool_missing",
  "tool_schema_changed",
  "model_changed",
  "thinking_level_changed",
  "answer_locale_changed",
  "classification_lower",
  "rebuild_requested",
] as const;

export type ThreadPromptBundleOrigin = (typeof THREAD_PROMPT_BUNDLE_ORIGINS)[number];

export interface ThreadPromptBundleIdentity {
  readonly toolNames: readonly string[];
  readonly modelRef: string;
  readonly thinkingLevel: string;
  readonly answerLocale: string | null;
  readonly redactionRuleset?: number;
}

export interface ThreadPromptBundleScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
}

export interface ThreadPromptBundleRecord extends ThreadPromptBundleScope {
  readonly generation: number;
  readonly origin: ThreadPromptBundleOrigin;
  readonly identity: ThreadPromptBundleIdentity;
  readonly systemPromptRef: PayloadRef;
  readonly toolsRef: PayloadRef;
  readonly systemPromptSha256: string;
  readonly toolsSha256: string;
  readonly dataClassification: DataClassification;
  readonly createdByRunId: RunId;
  readonly createdAt: string;
  readonly supersededAt: string | null;
  readonly rebuildReason: string | null;
  readonly rebuildOperator: string | null;
}

export interface ThreadPromptBundleCreateInput extends ThreadPromptBundleScope {
  readonly expectedLatestGeneration: number | null;
  readonly origin: ThreadPromptBundleOrigin;
  readonly identity: ThreadPromptBundleIdentity;
  readonly systemPrompt: PayloadRecord;
  readonly tools: PayloadRecord;
  readonly systemPromptSha256: string;
  readonly toolsSha256: string;
  readonly dataClassification: DataClassification;
  readonly runId: RunId;
  readonly now: string;
}

export interface ThreadPromptBundleCreateResult {
  readonly created: boolean;
  readonly record: ThreadPromptBundleRecord;
}

export interface ThreadPromptBundleRebuildInput extends ThreadPromptBundleScope {
  readonly reason: string;
  readonly operator: string;
  readonly now: string;
}

export interface ThreadPromptBundleStorePort {
  latest(scope: ThreadPromptBundleScope): Promise<ThreadPromptBundleRecord | undefined>;
  get(
    input: ThreadPromptBundleScope & { readonly generation: number },
  ): Promise<ThreadPromptBundleRecord | undefined>;
  create(input: ThreadPromptBundleCreateInput): Promise<ThreadPromptBundleCreateResult>;
  requestRebuild(input: ThreadPromptBundleRebuildInput): Promise<ThreadPromptBundleRecord>;
}

export interface RuntimePromptBundleCandidate {
  readonly systemPrompt: string;
  readonly tools: string;
}

export interface RuntimePromptBundle extends RuntimePromptBundleCandidate {
  readonly generation: number;
  readonly redactionRuleset?: number;
}

export interface RuntimePromptBundleResolveInput {
  readonly request: RuntimeRequest;
  readonly identity: ThreadPromptBundleIdentity;
  readonly candidate: RuntimePromptBundleCandidate;
  readonly hasHistory: boolean;
}

export interface RuntimePromptBundlePort {
  resolve(input: RuntimePromptBundleResolveInput): Promise<RuntimePromptBundle | undefined>;
}
