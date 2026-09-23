// biome-ignore-all lint/complexity/useLiteralKeys: provider JSON is untrusted until parsed
import { setTimeout as wait } from "node:timers/promises";
import {
  type AutomaticReviewDecision,
  assertMachineSecretFree,
  type ClockPort,
  type DataClassification,
  type ModelDescriptor,
  type ModelCostDescriptor,
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
  /** The same frozen pricing supplied to the invocation admission gate. */
  readonly pricingFor: (descriptor: ModelDescriptor) => ModelCostDescriptor;
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to the documented decision endpoint. */
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly maximumAttempts?: number;
}

/** The host's frozen review summary, mirrored from the protected input payload. */
interface ReviewInputEnvelope {
  readonly reviewId?: unknown;
  readonly runId?: unknown;
  readonly intentFingerprint?: unknown;
  readonly policyVersion?: unknown;
  readonly configurationVersion?: unknown;
  readonly modelRef?: unknown;
  readonly deadlineAt?: unknown;
  readonly approvalExpiresAt?: unknown;
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
  readonly model: string;
  readonly answers?: unknown;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
/** Bound the disclosed request independently of the provider's token count. */
const MAX_REQUEST_BYTES = 8_192;
/** The documented Jev 1.13 context limit; reserve the full bound before a call. */
const MAX_ADMISSION_INPUT_TOKENS = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
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

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the documented Choice answer; confidence is never synthesized. */
function answerValue(value: unknown): JevAnswerValue | undefined {
  if (!isRecord(value)) return undefined;
  if (value["type"] !== "choice") return undefined;
  const choice = value["choice"];
  if (typeof choice !== "string") return undefined;
  const confidence = value["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return undefined;
  const probabilities = value["probabilities"];
  if (!isRecord(probabilities) || !Object.hasOwn(probabilities, choice)) return undefined;
  const values = Object.values(probabilities);
  if (
    values.length === 0 ||
    values.some(
      (probability) =>
        typeof probability !== "number" ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1,
    )
  )
    return undefined;
  const total = (values as number[]).reduce((sum, probability) => sum + probability, 0);
  if (
    Math.abs(total - 1) > 0.001 ||
    (probabilities[choice] as number) < Math.max(...(values as number[]))
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
  static estimatedAdmissionCost(descriptor: { readonly cost: ModelCostDescriptor }): {
    readonly pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
    readonly estimatedCostMicros: number;
  } {
    const estimatedCostMicros = Math.ceil(MAX_ADMISSION_INPUT_TOKENS * descriptor.cost.input);
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
    const deadline =
      Date.now() +
      boundedInteger(this.options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const parsed = await this.#call(descriptor, request, body, apiKey, deadline);
        const decision = this.#validateDecision(envelope, this.#synthesize(envelope, parsed));
        const pricing = this.options.pricingFor(descriptor);
        if (
          [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite].some(
            (price) => !Number.isFinite(price) || price < 0,
          )
        )
          throw new JevTransportFailure("TYPESAFE_MODEL_PRICING_INVALID", false);
        const cost =
          parsed.usage.input_tokens * pricing.input + parsed.usage.output_tokens * pricing.output;
        if (!Number.isSafeInteger(Math.ceil(cost)) || cost < 0)
          throw new JevTransportFailure("TYPESAFE_MODEL_PRICING_INVALID", false);
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
          inputTokens: parsed.usage.input_tokens,
          // Output tokens are reported even when the output price is zero.
          outputTokens: parsed.usage.output_tokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: Math.ceil(cost),
          latencyMs: Math.max(0, Date.now() - startedAt),
          occurredAt: this.options.clock.now(),
        };
        return;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof JevTransportFailure && error.retryable;
        if (!retryable || attempt === attempts || request.signal?.aborted) break;
        const delay = Math.max(
          Math.min(250 * 2 ** (attempt - 1), 1_000),
          error instanceof JevTransportFailure ? (error.retryAfterMs ?? 0) : 0,
        );
        if (Date.now() + delay >= deadline) {
          lastError = new JevTransportFailure("TYPESAFE_REQUEST_TIMEOUT", false);
          break;
        }
        try {
          await wait(delay, undefined, { ref: false, signal: request.signal });
        } catch {
          lastError = new JevTransportFailure("TYPESAFE_REQUEST_CANCELLED", false);
          break;
        }
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
      const envelope = this.#parseEnvelope(state, request);
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
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
        throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_TOO_LARGE", false);
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

  #parseEnvelope(state: string, request: ModelInvocationRequest): ReviewInputEnvelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(state);
    } catch {
      throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_INVALID", false);
    }
    if (!isRecord(parsed)) throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_INVALID", false);
    if (
      parsed["schemaVersion"] !== "automatic-review-input.v1" ||
      parsed["reviewId"] !== request.invocationId ||
      parsed["runId"] !== request.runId ||
      parsed["modelRef"] !== request.modelRef ||
      parsed["dataClassification"] !== request.dataClassification ||
      [
        "intentFingerprint",
        "policyVersion",
        "configurationVersion",
        "deadlineAt",
        "approvalExpiresAt",
      ].some((key) => typeof parsed[key] !== "string" || (parsed[key] as string).length === 0) ||
      !isRecord(parsed["action"])
    )
      throw new JevTransportFailure("TYPESAFE_REVIEW_INPUT_INVALID", false);
    return parsed;
  }

  #apiKey(secretValues: readonly string[]): string {
    const key = secretValues.find((value) => value.length > 0);
    if (key === undefined) throw new JevTransportFailure("TYPESAFE_CREDENTIAL_UNAVAILABLE", false);
    return key;
  }

  async #call(
    descriptor: ModelDescriptor,
    request: ModelInvocationRequest,
    body: string,
    apiKey: string,
    deadline: number,
  ): Promise<JevResponseBody> {
    if (Date.now() >= deadline) throw new JevTransportFailure("TYPESAFE_REQUEST_TIMEOUT", false);
    const base = (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeout = new AbortController();
    const signals = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), Math.max(1, deadline - Date.now()));
    try {
      const fetchImpl = this.options.fetch ?? globalThis.fetch;
      const response = await this.#withAbort(
        fetchImpl(`${base}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
          signal: signals,
        }),
        signals,
      );
      if (!response.ok) {
        // A definite rate/overload rejection has not accepted a decision request.
        const retryable = response.status === 429 || response.status === 529;
        throw new JevTransportFailure(
          `TYPESAFE_HTTP_${response.status}`,
          retryable,
          undefined,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      const text = await this.#readResponse(response, signals);
      assertMachineSecretFree(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new JevTransportFailure("TYPESAFE_RESPONSE_INVALID", false);
      }
      if (!isRecord(parsed)) throw new JevTransportFailure("TYPESAFE_RESPONSE_INVALID", false);
      const reportedModel = parsed["model"];
      const configuredVersion = descriptor.version;
      const alias = descriptor.model === "jev-latest";
      if (
        typeof reportedModel !== "string" ||
        (alias
          ? !/^jev-\d+\.\d+\.\d+$/.test(reportedModel) ||
            (/^jev-\d+\.\d+\.\d+$/.test(configuredVersion) && reportedModel !== configuredVersion)
          : reportedModel !== descriptor.model)
      )
        throw new JevTransportFailure("TYPESAFE_MODEL_IDENTITY_INVALID", false);
      const usage = parsed["usage"];
      if (
        !isRecord(usage) ||
        !Number.isSafeInteger(usage["input_tokens"]) ||
        (usage["input_tokens"] as number) < 1 ||
        (usage["input_tokens"] as number) > MAX_ADMISSION_INPUT_TOKENS ||
        !Number.isSafeInteger(usage["output_tokens"]) ||
        (usage["output_tokens"] as number) < 0
      )
        throw new JevTransportFailure("TYPESAFE_USAGE_INVALID", false);
      return {
        model: reportedModel,
        answers: parsed["answers"],
        usage: {
          input_tokens: usage["input_tokens"] as number,
          output_tokens: usage["output_tokens"] as number,
        },
      };
    } catch (error) {
      if (error instanceof JevTransportFailure) throw error;
      const cancelled = request.signal?.aborted === true;
      throw new JevTransportFailure(
        cancelled
          ? "TYPESAFE_REQUEST_CANCELLED"
          : timeout.signal.aborted
            ? "TYPESAFE_REQUEST_TIMEOUT"
            : "TYPESAFE_TRANSPORT_UNAVAILABLE",
        false,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #readResponse(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) throw new JevTransportFailure("TYPESAFE_RESPONSE_INVALID", false);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await this.#withAbort(reader.read(), signal);
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_RESPONSE_BYTES)
          throw new JevTransportFailure("TYPESAFE_RESPONSE_TOO_LARGE", false);
        chunks.push(result.value);
      }
      return Buffer.concat(chunks, total).toString("utf8");
    } finally {
      void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* A cancelled read may still be pending. */
      }
    }
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
    if (!scope || !decision || !reason || !["within", "outside"].includes(scope.value))
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
      confidence: Math.min(scope.confidence, decision.confidence, reason.confidence),
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
  readonly retryAfterMs?: number;
  constructor(errorCode: string, retryable: boolean, cause?: unknown, retryAfterMs?: number) {
    super(errorCode, cause === undefined ? undefined : { cause });
    this.name = "JevTransportFailure";
    this.errorCode = errorCode;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export { JevTransportFailure };
