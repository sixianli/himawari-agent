import type { MemoryId } from "@himawari-agent/domain";
import {
  RULE_REVIEW,
  RULE_REVIEW_INSTRUCTIONS_HEADER,
  TOOL_RULE_SET,
} from "@himawari-agent/prompt-catalog";
import type { ClockPort } from "../ports/system.js";
import type { ModelInvocationRequest } from "../ports/intelligence.js";
import type { ProductMemoryRecord, ProductMemoryStatePort } from "../ports/memory-projection.js";
import type { OwnerRuleScope } from "../ports/owner-rules.js";
import {
  RULE_REVIEW_BATCH,
  RULE_REVIEW_RETRY_MS,
  type RuleReviewCandidate,
  type RuleReviewFailureReason,
  type RuleReviewResolution,
  type RuleReviewStorePort,
} from "../ports/rule-review.js";
import { judgeRuleReview, parseRuleReviewAnswer } from "../rules/rule-review.js";
import { parseOwnerRuleParameters, RuleTypeError } from "../rules/rule-types.js";
import type { ProactiveModelInvoker } from "./proactive-mail-check-service.js";

const MAX_OUTPUT_BYTES = 65_536;
const REQUEST_DEADLINE_MS = 60_000;

export type RuleReviewOutcome = "cleared" | "suspended" | RuleReviewFailureReason | "stale";

export interface RuleReviewReport {
  readonly ruleId: string;
  readonly outcome: RuleReviewOutcome;
}

export interface RuleReviewServiceOptions {
  readonly scope: OwnerRuleScope;
  readonly clock: ClockPort;
  readonly store: RuleReviewStorePort;
  readonly memories: Pick<ProductMemoryStatePort, "read">;
  readMemoryText(memory: ProductMemoryRecord): Promise<string>;
  readonly model: ProactiveModelInvoker;
  nextInvocationId(): string;
}

function usableSource(memory: ProductMemoryRecord | undefined): boolean {
  return (
    memory !== undefined &&
    memory.status === "active" &&
    memory.attributes?.category === "rule" &&
    !memory.attributes.supersededBy
  );
}

export function ruleReviewPrompt(memoryText: string, current: unknown): string {
  const parsed = parseOwnerRuleParameters(current);
  return [
    RULE_REVIEW.text,
    RULE_REVIEW_INSTRUCTIONS_HEADER.text,
    TOOL_RULE_SET.text,
    JSON.stringify({
      memory: memoryText,
      currentRule: { type: parsed.type, params: parsed.params },
    }),
  ].join("\n");
}

export class RuleReviewService {
  readonly #options: RuleReviewServiceOptions;
  #running: Promise<readonly RuleReviewReport[]> | undefined;

  constructor(options: RuleReviewServiceOptions) {
    this.#options = options;
  }

  run(): Promise<readonly RuleReviewReport[]> {
    if (!this.#running)
      this.#running = this.#runOnce().finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #runOnce(): Promise<readonly RuleReviewReport[]> {
    const due = await this.#options.store.listDue({
      ...this.#options.scope,
      now: this.#options.clock.now(),
      limit: RULE_REVIEW_BATCH,
    });
    const reports: RuleReviewReport[] = [];
    for (const candidate of due)
      reports.push(
        Object.freeze({ ruleId: candidate.ruleId, outcome: await this.#review(candidate) }),
      );
    return Object.freeze(reports);
  }

  async #review(candidate: RuleReviewCandidate): Promise<RuleReviewOutcome> {
    const memory = await this.#options.memories.read(candidate.sourceMemoryId as MemoryId);
    if (!memory || !usableSource(memory))
      return this.#resolve(candidate, memory?.revision ?? null, {
        outcome: "suspended",
        reason: "source_removed",
        suggestion: null,
      });
    let text: string;
    try {
      text = await this.#options.readMemoryText(memory);
    } catch {
      return this.#fail(candidate, "source_unreadable");
    }
    let prompt: string;
    try {
      prompt = ruleReviewPrompt(text, candidate.parameters);
    } catch (error) {
      if (error instanceof RuleTypeError) return this.#fail(candidate, "answer_invalid");
      throw error;
    }
    let output: string;
    try {
      output = await this.#invoke(prompt, memory);
    } catch (error) {
      return this.#fail(
        candidate,
        error instanceof Error && error.message.endsWith("_DISCLOSURE_DENIED")
          ? "content_blocked"
          : "model_failed",
      );
    }
    let answer: unknown;
    try {
      answer = parseRuleReviewAnswer(output);
    } catch {
      return this.#fail(candidate, "answer_invalid");
    }
    const verdict = judgeRuleReview(candidate.parameters, answer);
    switch (verdict.kind) {
      case "same":
        return this.#resolve(candidate, memory.revision, { outcome: "cleared" });
      case "changed":
        return this.#resolve(candidate, memory.revision, {
          outcome: "suspended",
          reason: "parameters_changed",
          suggestion: verdict.suggestion,
        });
      case "not_standing":
        return this.#resolve(candidate, memory.revision, {
          outcome: "suspended",
          reason: "no_longer_standing",
          suggestion: null,
        });
      case "invalid":
        return this.#fail(candidate, "answer_invalid");
    }
  }

  async #invoke(prompt: string, memory: ProductMemoryRecord): Promise<string> {
    const { model, clock } = this.#options;
    const invocationId = this.#options.nextInvocationId();
    const deadlineAt = new Date(Date.parse(clock.now()) + REQUEST_DEADLINE_MS).toISOString();
    const authority = await model.prepare({
      invocationId,
      prompt,
      deadlineAt,
      dataClassification: memory.dataClassification,
    });
    const outputs: string[] = [authority.inputRef];
    let output = "";
    try {
      const request: ModelInvocationRequest = {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        invocationId,
        runId: authority.runId,
        modelRef: model.modelRef,
        inputRef: authority.inputRef,
        dataClassification: memory.dataClassification,
        allowedDisclosureRef: authority.allowedDisclosureRef,
        secretHandleRefs: [...authority.secretHandleRefs],
        correlationId: invocationId as ModelInvocationRequest["correlationId"],
      };
      for await (const event of model.model.invoke(request)) {
        if (event.invocationId !== invocationId) continue;
        if (event.type === "model.failed") throw new Error(`RULE_REVIEW_${event.errorCode}`);
        if (event.type === "model.output") {
          outputs.push(event.payloadRef);
          output += await model.readOutput(event.payloadRef);
          if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES)
            throw new Error("RULE_REVIEW_OUTPUT_TOO_LARGE");
        }
        if (event.type === "model.completed") return output;
      }
      throw new Error("RULE_REVIEW_INCOMPLETE");
    } finally {
      await authority.release();
      await model.release(outputs);
    }
  }

  async #resolve(
    candidate: RuleReviewCandidate,
    sourceRevision: number | null,
    resolution: RuleReviewResolution,
  ): Promise<RuleReviewOutcome> {
    const applied = await this.#options.store.resolve({
      ...this.#options.scope,
      ruleId: candidate.ruleId,
      expectedRevision: candidate.revision,
      sourceMemoryId: candidate.sourceMemoryId,
      sourceRevision,
      resolution,
      now: this.#options.clock.now(),
    });
    return applied ? resolution.outcome : "stale";
  }

  async #fail(
    candidate: RuleReviewCandidate,
    reason: RuleReviewFailureReason,
  ): Promise<RuleReviewOutcome> {
    const now = this.#options.clock.now();
    const applied = await this.#options.store.recordFailure({
      ...this.#options.scope,
      ruleId: candidate.ruleId,
      expectedRevision: candidate.revision,
      reason,
      retryAfter: new Date(Date.parse(now) + RULE_REVIEW_RETRY_MS).toISOString(),
      now,
    });
    return applied ? reason : "stale";
  }
}
