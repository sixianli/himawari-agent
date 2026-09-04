import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

/** The two product paths that can cause a physical Pi provider stream. */
export type ModelInvocationSource = "model-port" | "agent-stream";

/**
 * Execution identity captured by Core when it creates an admission gate.
 *
 * The lease claim is intentionally carried by the gate rather than reconstructed
 * from RuntimeRequest.budget or an invocation request. The gate implementation
 * must re-check this identity and cancellation at each lifecycle transition.
 */
export interface ModelInvocationExecutionContext {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly executionLease: RunExecutionLeaseClaim;
}

export interface ModelInvocationAdmissionInput {
  readonly modelRef: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly dataClassification: DataClassification;
  /** Stable caller identity; never derive this from prompt text. */
  readonly operationKey: string;
  readonly source: ModelInvocationSource;
  /** 1-based ordinal for physical streams within the source execution. */
  readonly ordinal: number;
  readonly estimatedCostMicros: number;
  /** Frozen descriptor pricing, expressed in USD per million tokens. */
  readonly pricing: ModelInvocationPricing;
}

export interface ModelInvocationPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ModelInvocationUsage {
  /** Total provider prompt tokens, including cacheReadTokens/cacheWriteTokens. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ModelInvocationPermit {
  /** Re-check authority, active lease and cancellation before secret access. */
  assertActive(): Promise<void>;
  /** Mark the allocation started immediately before entering the Pi stream. */
  markStarted(): Promise<void>;
  /** Settle from verified usage and the frozen descriptor price captured at begin. */
  settle(usage: ModelInvocationUsage): Promise<void>;
  /** Preserve uncertainty when a started stream has no trusted terminal usage. */
  markUnknown(
    reasonCode: "provider_unresolved" | "transport_unresolved" | "cancel_unresolved",
  ): Promise<void>;
}

/**
 * A gate is created by the execution owner from a typed lease claim. Its
 * context is immutable so a caller cannot select a different Run after reserve.
 */
export interface ModelInvocationAdmissionPort {
  readonly context: ModelInvocationExecutionContext;
  begin(input: ModelInvocationAdmissionInput): Promise<ModelInvocationPermit>;
}

export type ModelInvocationAdmissionResolver = (scope: {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
}) => ModelInvocationAdmissionPort | undefined | Promise<ModelInvocationAdmissionPort | undefined>;
