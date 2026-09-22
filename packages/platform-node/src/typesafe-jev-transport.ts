import { setTimeout as wait } from "node:timers/promises";
import {
  type AutomaticReviewDecision,
  assertMachineSecretFree,
  type ClockPort,
  type DataClassification,
  type ModelDescriptor,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type PayloadRef,
  parseAutomaticReviewDecision,
} from "@himawari-agent/application";

import type { SecretMaterialSource, TrustedModelTransport } from "./trusted-model-provider.js";

/** Protected payload access shared by every model transport; never reads local files. */
export interface JevModelPayloadBoundary {
  readText(payloadRef: string): Promise<string>;
  writeText(input: {
    readonly invocationId: string;
    readonly sequence: number;
    readonly dataClassification: DataClassification;
    readonly content: string;
    readonly occurredAt: string;
  }): Promise<string>;
}

export interface TypeSafeJevTransportOptions {
  readonly secrets: SecretMaterialSource;
  readonly payloads: JevModelPayloadBoundary;
  readonly clock: ClockPort;
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to the documented decision endpoint. */
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly maximumAttempts?: number;
}

/** The host's frozen review summary, mirrored from the protected input payload. */
interface ReviewInputEnvelope {
  readonly reviewId?: unknown;
  readonly dataClassification?: unknown;
  readonly action?: {
    readonly capabilityRef?: unknown;
    readonly operation?: unknown;
    readonly actionKind?: unknown;
    readonly finalRisk?: unknown;
    readonly sideEffect?: unknown;
    readonly targetKinds?: unknown;
  };
}

interface JevAnswerValue {
  readonly value: string;
  readonly confidence: number;
}

interface JevResponseBody {
  readonly model?: unknown;
  readonly version?: unknown;
  readonly answers?: unknown;
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
/**
 * The decision endpoint has no output tokens; pricing is per input token only.
 * This bound keeps a conservative reservation while the real prompt is a few
 * hundred tokens of frozen summary.
 */
const ESTIMATED_INPUT_TOKENS = 2_048;
/** Reason codes the host asked for; anything else is malformed model output. */
const DECISION_REASON_CODES = new Set([
  "WITHIN_DELEGATION",
  "OUTSIDE_DELEGATION",
  "HIGH_RISK",
  "INSUFFICIENT_CONTEXT",
  "POLICY_UNCERTAIN",
]);

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function validConfidence(value: JevAnswerValue): boolean {
  return Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A typed answer may be a bare choice or carry a calibrated confidence. */
function answerValue(value: unknown): JevAnswerValue | undefined {
  if (typeof value === "string") return { value, confidence: 1 };
  if (!isRecord(value)) return undefined;
  const choice = value["value"];
  if (typeof choice !== "string") return undefined;
  const confidence = value["confidence"];
  if (confidence === undefined) return { value: choice, confidence: 1 };
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return undefined;
  return { value: choice, confidence };
}

export class TypeSafeJevTransport implements TrustedModelTransport {
  private readonly options: TypeSafeJevTransportOptions;

  constructor(options: TypeSafeJevTransportOptions) {
    this.options = options;
  }

  /** Reserved budget for a decision call: input tokens only, output is free. */
  static estimatedAdmissionCost(descriptor: Pick<ModelDescriptor, "cost">): {
    readonly pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
    readonly estimatedCostMicros: number;
  } {
    const estimatedCostMicros = Math.ceil(ESTIMATED_INPUT_TOKENS * descriptor.cost.input);
    if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0)
      throw new TypeError("TYPESAFE_MODEL_ADMISSION_ESTIMATE_UNSAFE");
    return Object.freeze({
      pricing: Object.freeze({ ...descriptor.cost }),
      estimatedCostMicros,
    });
  }

  async *invoke(input: {
    readonly descriptor: ModelDescriptor;
    readonly request: ModelInvocationRequest;
    readonly secretValues: readonly string[];
  }): AsyncIterable<ModelInvocationEvent> {
    const { descriptor, request } = input;
    const startedAt = Date.now();
    const occurredAt = this.options.clock.now();
    request.signal?.throwIfAborted();
    const prepared = await this.#prepare(descriptor, request, input.secretValues, occurredAt);
    if ("failed" in prepared) {
      yield prepared.failed;
      return;
    }
    const { body, envelope, apiKey } = prepared;
    const attempts = boundedInteger(this.options.maximumAttempts, DEFAULT_MAXIMUM_ATTEMPTS, 1, 4);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const parsed = await this.#call(descriptor, request, body, apiKey);
        const decision = this.#validateDecision(envelope, this.#synthesize(envelope, parsed));
        const outputRef = await this.options.payloads.writeText({
          invocationId: request.invocationId,
          sequence: 1,
          dataClassification: request.dataClassification,
          content: JSON.stringify(decision),
          occurredAt: this.options.clock.now(),
        });
        yield {
          type: "model.output",
          invocationId: request.invocationId,
          sequence: 1,
          payloadRef: outputRef as PayloadRef,
          occurredAt: this.options.clock.now(),
        };
        yield {
          type: "model.completed",
          invocationId: request.invocationId,
          inputTokens: boundedInteger(
            parsed.usage?.input_tokens,
            this.#estimatedTokens(body),
            1,
            1_000_000,
          ),
          // The decision endpoint never bills or returns output tokens.
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: 0,
          latencyMs: Math.max(0, Date.now() - startedAt),
          occurredAt: this.options.clock.now(),
        };
        return;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof JevTransportFailure && error.retryable;
        if (!retryable || attempt === attempts || request.signal?.aborted) break;
        await wait(Math.min(250 * attempt, 1_000), undefined, { ref: false });
      }
    }
    yield {
      type: "model.failed",
      invocationId: request.invocationId,
      errorCode:
        lastError instanceof JevTransportFailure ? lastError.errorCode : "TYPESAFE_REQUEST_FAILED",
      retryable: lastError instanceof JevTransportFailure ? lastError.retryable : false,
      latencyMs: Math.max(0, Date.now() - startedAt),
      occurredAt,
    };
  }

  /**
   * Assemble the frozen state and the host-owned typed questions. A failure here
   * is reported as a failed invocation, so the host never has to translate a
   * thrown transport error into a different outcome.
   */
  async #prepare(
    descriptor: ModelDescriptor,
    request: ModelInvocationRequest,
    secretValues: readonly string[],
    occurredAt: string,
  ): Promise<
    | { readonly body: string; readonly envelope: ReviewInputEnvelope; readonly apiKey: string }
    | { readonly failed: ModelInvocationEvent }
  > {
    try {
      const state = await this.options.payloads.readText(request.inputRef);
      const envelope = this.#parseEnvelope(state);
      const body = JSON.stringify({
        state: envelope,
        model: descriptor.model,
        questions: {
          within_delegated_scope: {
            type: "choice",
            instructions:
              "Is this action covered by the Owner's delegation for exactly this frozen request? " +
              "Answer outside when the scope, recipient, budget or target is unclear.",
            criteria: {
              within: "The action is one the Owner already delegated for this exact request.",
              outside:
                "The action is not covered by the delegation, or the summary is insufficient.",
            },
          },
          decision: {
            type: "choice",
            instructions:
              "Should the host approve this exact request, deny it, or leave it for the human Owner?",
            criteria: {
              approve: "Safe to execute as frozen, with no widened scope.",
              deny: "Must not execute.",
              human: "Cannot be decided from the summary alone.",
            },
          },
          reason_code: {
            type: "choice",
            instructions: "Pick the single best reason for the decision.",
            criteria: {
              WITHIN_DELEGATION: "Delegated and safe to approve.",
              OUTSIDE_DELEGATION: "Not covered by the delegation.",
              HIGH_RISK: "Effect or risk is too high for automatic approval.",
              INSUFFICIENT_CONTEXT: "The frozen summary is not enough to decide.",
              POLICY_UNCERTAIN: "Policy or delegation state is ambiguous.",
            },
          },
        },
      });
      assertMachineSecretFree(body);
      return { body, envelope, apiKey: this.#apiKey(secretValues) };
    } catch (error) {
      return {
        failed: {
          type: "model.failed",
          invocationId: request.invocationId,
          errorCode:
            error instanceof JevTransportFailure
              ? error.errorCode
              : "TYPESAFE_REVIEW_INPUT_UNAVAILABLE",
          retryable: false,
          latencyMs: 0,
          occurredAt,
        },
      };
    }
  }

  #parseEnvelope(state: string): ReviewInputEnvelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(state);
    } catch {
      throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_INVALID", false);
    }
    if (!isRecord(parsed)) throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_INVALID", false);
    return parsed;
  }

  #apiKey(secretValues: readonly string[]): string {
    const key = secretValues.find((value) => value.length > 0);
    if (key === undefined) throw new JevTransportFailure("TYPESAFE_CREDENTIAL_UNAVAILABLE", false);
    return key;
  }

  #estimatedTokens(body: string): number {
    // Conservative character-based estimate; TypeSafe reports real usage when present.
    return Math.max(1, Math.ceil(Buffer.byteLength(body, "utf8") / 4));
  }

  async #call(
    descriptor: ModelDescriptor,
    request: ModelInvocationRequest,
    body: string,
    apiKey: string,
  ): Promise<JevResponseBody> {
    const base = (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeout = new AbortController();
    const signals = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    const timer = setTimeout(
      () => timeout.abort(),
      boundedInteger(this.options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000),
    );
    let response: Response;
    try {
      const fetchImpl = this.options.fetch ?? globalThis.fetch;
      response = await fetchImpl(`${base}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: signals,
      });
    } catch (error) {
      // Cancellation is never retried; a transport error is retryable within the bound.
      const cancelled = request.signal?.aborted === true;
      throw new JevTransportFailure(
        cancelled ? "TYPESAFE_REQUEST_CANCELLED" : "TYPESAFE_TRANSPORT_UNAVAILABLE",
        !cancelled,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Diagnostics stay in the transport; never surface provider text or credentials.
      const retryable = response.status === 429 || response.status >= 500;
      throw new JevTransportFailure(`TYPESAFE_HTTP_${response.status}`, retryable);
    }
    const text = await response.text();
    assertMachineSecretFree(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JevTransportFailure("TYPESAFE_RESPONSE_INVALID", false);
    }
    if (!isRecord(parsed)) throw new JevTransportFailure("TYPESAFE_RESPONSE_INVALID", false);
    if (parsed["model"] !== undefined && parsed["model"] !== descriptor.model) {
      throw new JevTransportFailure("TYPESAFE_MODEL_IDENTITY_INVALID", false);
    }
    return parsed as JevResponseBody;
  }

  /**
   * Turn the decision model's typed answers into the review contract. The host
   * builds the decision deterministically; the model supplies choices and its
   * calibrated confidence, which the review service gates before any approval.
   */
  #synthesize(envelope: ReviewInputEnvelope, response: JevResponseBody): Record<string, unknown> {
    const answersValue = response["answers"];
    if (!isRecord(answersValue)) throw new JevTransportFailure("TYPESAFE_RESPONSE_INVALID", false);
    const scope = answerValue(answersValue["within_delegated_scope"]);
    const decision = answerValue(answersValue["decision"]);
    const reason = answerValue(answersValue["reason_code"]);
    // Every reported answer must be well formed, including its confidence: a
    // malformed calibrated value is not something the host may interpret.
    if (
      !scope ||
      !decision ||
      !reason ||
      !validConfidence(scope) ||
      !validConfidence(decision) ||
      !validConfidence(reason)
    )
      throw new JevTransportFailure("TYPESAFE_ANSWER_INVALID", false);
    // The answer vocabulary is host-owned. An answer outside it is malformed
    // output, not something the host silently reinterprets.
    if (decision.value !== "approve" && decision.value !== "deny" && decision.value !== "human")
      throw new JevTransportFailure("TYPESAFE_ANSWER_INVALID", false);
    if (!DECISION_REASON_CODES.has(reason.value))
      throw new JevTransportFailure("TYPESAFE_ANSWER_INVALID", false);
    const reviewId = envelope.reviewId;
    const dataClassification = envelope.dataClassification;
    if (typeof reviewId !== "string" || typeof dataClassification !== "string")
      throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_INVALID", false);
    // An unclear scope is never an approval: it goes to the human Owner.
    const outside = scope.value !== "within";
    const outcome = outside ? "human" : decision.value;
    return {
      schemaVersion: "automatic-review.v1",
      reviewId,
      reasonCode: outside ? "OUTSIDE_DELEGATION" : reason.value,
      // Only an approval carries the gate-relevant confidence.
      ...(outcome === "approve" ? { confidence: decision.confidence } : {}),
      decision: outcome,
    };
  }

  /**
   * The reviewer port returns unbounded data, but the durable decision has to be
   * the validated shape. The host therefore re-binds its own answer to the
   * envelope the coordinator froze and passes it through the same contract the
   * contract expects, so a provider cannot smuggle an extra field or a foreign
   * request identity into a committed decision.
   */
  #validateDecision(
    envelope: ReviewInputEnvelope,
    decision: Record<string, unknown>,
  ): AutomaticReviewDecision {
    // Re-bind the host's own answer to the frozen request identity and run it
    // through the shared decision contract, so a provider cannot smuggle an
    // extra field or a foreign request identity into a committed decision. Only
    // the binding fields and the answer belong in the validated object.
    return parseAutomaticReviewDecision(
      {
        schemaVersion: "automatic-review.v1",
        reviewId: String(envelope.reviewId ?? ""),
        intentFingerprint: String(envelope.intentFingerprint ?? ""),
        policyVersion: String(envelope.policyVersion ?? ""),
        configurationVersion: String(envelope.configurationVersion ?? ""),
        modelRef: String(envelope.modelRef ?? ""),
        deadlineAt: String(envelope.deadlineAt ?? ""),
        approvalExpiresAt: String(envelope.approvalExpiresAt ?? ""),
        inputRef: "",
        runId: envelope.runId as never,
      },
      {
        ...decision,
        schemaVersion: "automatic-review.v1",
        reviewId: String(envelope.reviewId ?? ""),
        intentFingerprint: String(envelope.intentFingerprint ?? ""),
        policyVersion: String(envelope.policyVersion ?? ""),
        configurationVersion: String(envelope.configurationVersion ?? ""),
        modelRef: String(envelope.modelRef ?? ""),
      },
    );
  }
}

/** Transport-local failure; its message never carries provider text or secrets. */
class JevTransportFailure extends Error {
  readonly errorCode: string;
  readonly retryable: boolean;
  constructor(errorCode: string, retryable: boolean, cause?: unknown) {
    super(errorCode, cause === undefined ? undefined : { cause });
    this.name = "JevTransportFailure";
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

export { JevTransportFailure };
