import type {
  AutomaticActionReviewerPort,
  AutomaticReviewRequest,
} from "../ports/automatic-action-review.js";
import type { ModelDescriptor, ModelInvocationRequest, ModelPort } from "../ports/intelligence.js";
import type { ClockPort } from "../ports/system.js";

type ReviewModelAuthority = Pick<
  ModelInvocationRequest,
  "dataClassification" | "allowedDisclosureRef" | "secretHandleRefs"
>;
export interface ModelActionReviewerDependencies {
  /** Production supplies TrustedModelProviderAdapter, retaining durable admission and budget. */
  readonly model: ModelPort;
  readonly descriptor: ModelDescriptor;
  readonly configurationVersion: string;
  /** Host validates approved disclosure and issues scoped secret handles. No model output is input here. */
  readonly authorize: (
    request: AutomaticReviewRequest,
    descriptor: ModelDescriptor,
    signal: AbortSignal,
  ) => Promise<ReviewModelAuthority>;
  readonly readOutput: (payloadRef: string) => Promise<string>;
  readonly clock: ClockPort;
  readonly maxOutputBytes?: number;
}

/** A tool-free, single-model adapter over the existing product model boundary.
 * It never chooses a fallback, creates a Grant, or starts an executable tool. */
export class ModelActionReviewer implements AutomaticActionReviewerPort {
  private readonly dependencies: ModelActionReviewerDependencies;
  private readonly descriptor: ModelDescriptor;
  private readonly maximumBytes: number;
  constructor(dependencies: ModelActionReviewerDependencies) {
    this.dependencies = dependencies;
    this.descriptor = structuredClone(dependencies.descriptor);
    this.maximumBytes = dependencies.maxOutputBytes ?? 32_768;
    if (
      !Number.isSafeInteger(this.maximumBytes) ||
      this.maximumBytes < 1 ||
      this.maximumBytes > 1_048_576
    )
      throw new Error("AUTOMATIC_REVIEW_MODEL_CONFIGURATION_INVALID");
  }
  async review(request: AutomaticReviewRequest, signal: AbortSignal): Promise<unknown> {
    request = Object.freeze({ ...request });
    const d = this.dependencies;
    signal.throwIfAborted();
    const remaining = Date.parse(request.deadlineAt) - Date.parse(d.clock.now());
    if (
      request.modelRef !== this.descriptor.ref ||
      request.configurationVersion !== d.configurationVersion ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > 300_000
    )
      throw new Error("AUTOMATIC_REVIEW_MODEL_CONFIGURATION_INVALID");
    const timeout = new AbortController();
    const cancellation = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), remaining);
    const assertCurrent = () => {
      cancellation.throwIfAborted();
      if (d.clock.now() >= request.deadlineAt) throw new Error("AUTOMATIC_REVIEW_EXPIRED");
    };
    try {
      const available = (await d.model.listAvailable()).find(({ ref }) => ref === request.modelRef);
      assertCurrent();
      if (!available || JSON.stringify(available) !== JSON.stringify(this.descriptor))
        throw new Error("AUTOMATIC_REVIEW_MODEL_CHANGED");
      const authority = await d.authorize(request, structuredClone(this.descriptor), cancellation);
      assertCurrent();
      if (
        !authority.allowedDisclosureRef ||
        !this.descriptor.allowedDataClassifications.includes(authority.dataClassification)
      )
        throw new Error("AUTOMATIC_REVIEW_DISCLOSURE_DENIED");
      const invocation: ModelInvocationRequest = {
        invocationId: request.reviewId,
        runId: request.runId,
        modelRef: request.modelRef,
        inputRef: request.inputRef,
        dataClassification: authority.dataClassification,
        allowedDisclosureRef: authority.allowedDisclosureRef,
        secretHandleRefs: [...authority.secretHandleRefs],
        correlationId: request.reviewId,
        signal: cancellation,
      };
      let text = "",
        bytes = 0,
        sequence = 0,
        completed = false;
      const seen = new Map<number, string>();
      for await (const event of d.model.invoke(invocation)) {
        assertCurrent();
        if (event.invocationId !== request.reviewId)
          throw new Error("AUTOMATIC_REVIEW_MODEL_IDENTITY_INVALID");
        if (event.type === "model.failed") throw new Error("AUTOMATIC_REVIEW_MODEL_FAILED");
        if (event.type === "model.output") {
          const previous = seen.get(event.sequence);
          if (previous) {
            if (previous !== event.payloadRef)
              throw new Error("AUTOMATIC_REVIEW_MODEL_OUTPUT_CHANGED");
            continue;
          }
          if (event.sequence !== sequence + 1 || sequence >= 256)
            throw new Error("AUTOMATIC_REVIEW_MODEL_OUTPUT_INVALID");
          const part = await d.readOutput(event.payloadRef);
          assertCurrent();
          bytes += new TextEncoder().encode(part).byteLength;
          if (bytes > this.maximumBytes) throw new Error("AUTOMATIC_REVIEW_MODEL_OUTPUT_LIMIT");
          sequence = event.sequence;
          seen.set(sequence, event.payloadRef);
          text += part;
        } else if (event.type === "model.completed") {
          completed = true;
          break;
        }
      }
      assertCurrent();
      if (!completed) throw new Error("AUTOMATIC_REVIEW_MODEL_INCOMPLETE");
      // Structural binding is checked by AutomaticActionReviewService before any durable decision.
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      timeout.abort();
    }
  }
}
