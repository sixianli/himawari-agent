import {
  type AutomaticActionReviewPort,
  AutomaticActionReviewService,
  type AutomaticReviewRequest,
  type AutomaticReviewStorePort,
  type ClockPort,
  type GovernedActionIntent,
  type IdGeneratorPort,
  ModelActionReviewer,
  type ModelDescriptor,
  type ModelPort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductConfiguration,
  type RunExecutionLeaseClaim,
  type SecretPort,
} from "@himawari-agent/application";
import { ProtectedPiModelPayloadBoundary } from "@himawari-agent/runtime-pi";

import { configuredReviewDisclosureIdentity } from "./production-model-disclosure.js";

/**
 * Compose automatic review from explicit configuration only. Absent
 * `runPolicy.automaticReview` returns undefined, so production keeps the
 * original human/deny path and never discloses input or spends budget.
 *
 * Reused Pi/product capabilities: the product `ModelPort` and
 * `TrustedModelProviderAdapter` (durable admission, budget, provider routing),
 * `ProtectedPiModelPayloadBoundary` (protected input/output payloads), and the
 * existing durable review store plus Approval/Grant boundary. Himawari adds only
 * the review identity, the host-owned disclosure decision and the binding of an
 * untrusted response to the exact frozen request.
 */
export interface ProductionAutomaticReviewOptions {
  readonly configuration: ProductConfiguration;
  /** The same product model boundary the Run uses; no second provider protocol. */
  readonly model: ModelPort;
  readonly descriptors: readonly ModelDescriptor[];
  readonly handles: SecretPort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly store: AutomaticReviewStorePort;
  readonly executionLease: (
    runId: GovernedActionIntent["runId"],
  ) => Promise<RunExecutionLeaseClaim>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

export function createProductionAutomaticReview(
  options: ProductionAutomaticReviewOptions,
): AutomaticActionReviewPort | undefined {
  const review = options.configuration.runPolicy?.automaticReview;
  if (!review) return undefined;
  const { ownerId, agentId } = options.configuration;
  const descriptor = options.descriptors.find(({ ref }) => ref === review.modelRef);
  const configured = options.configuration.modelDescriptors.find(
    ({ ref }) => ref === review.modelRef,
  );
  if (!descriptor || !configured || configured.role === "embedding")
    throw new Error("AUTOMATIC_REVIEW_MODEL_NOT_CONFIGURED");
  const boundary = new ProtectedPiModelPayloadBoundary({
    ownerId,
    agentId,
    payloads: options.payloads,
    protector: options.protector,
    ids: options.ids,
    clock: options.clock,
  });
  const disclosureRef = configuredReviewDisclosureIdentity(configured, review.configurationVersion);
  // Only the host's frozen summary reaches the reviewer: identity, versions,
  // operation, target kinds and the request digest. No file contents, local
  // paths, credentials or conversation text are disclosed.
  const prepareInput = async (
    intent: GovernedActionIntent,
    envelope: Omit<AutomaticReviewRequest, "inputRef">,
  ): Promise<string> =>
    boundary.writeText({
      invocationId: envelope.reviewId,
      sequence: 0,
      dataClassification: "private",
      content: JSON.stringify({
        ...envelope,
        schemaVersion: "automatic-review-input.v1",
        action: {
          capabilityRef: intent.capabilityRef,
          capabilityVersion: intent.capabilityVersion,
          operation: intent.operation,
          actionKind: intent.actionKind,
          sideEffect: intent.sideEffect,
          finalRisk: intent.finalRisk,
          dataClassification: intent.dataClassification,
          targetKinds: [...new Set(intent.targets.map(({ type }) => type))].sort(),
          deterministicFacts: intent.deterministicFacts.map(({ code }) => code).sort(),
        },
      }),
      occurredAt: options.clock.now(),
    });
  const reviewer = new ModelActionReviewer({
    model: options.model,
    descriptor,
    configurationVersion: review.configurationVersion,
    maxOutputBytes: review.maxOutputBytes,
    clock: options.clock,
    authorize: async (request) => {
      // Host-owned disclosure decision: the reviewer only speaks for the configured
      // model, and only about a request it already accepted.
      if (
        request.modelRef !== review.modelRef ||
        request.configurationVersion !== review.configurationVersion
      )
        throw new Error("AUTOMATIC_REVIEW_MODEL_CONFIGURATION_INVALID");
      if (!descriptor.allowedDataClassifications.includes("private"))
        throw new Error("AUTOMATIC_REVIEW_DISCLOSURE_DENIED");
      const requirement = descriptor.secretRequirement;
      if (!requirement)
        return {
          dataClassification: "private" as const,
          allowedDisclosureRef: disclosureRef,
          secretHandleRefs: [],
        };
      const handle = await options.handles.issueHandle({
        ownerId,
        agentId,
        runId: request.runId,
        secretRef: requirement.secretRef,
        secretVersion: requirement.secretVersion,
        purpose: requirement.purpose,
        scopeRef: request.reviewId,
        expiresAt: request.deadlineAt,
      });
      return {
        dataClassification: "private" as const,
        allowedDisclosureRef: disclosureRef,
        secretHandleRefs: [handle.ref],
      };
    },
    readOutput: (payloadRef) => boundary.readText(payloadRef),
  });
  return new AutomaticActionReviewService({
    maximumWaitMs: review.maximumWaitMs,
    configurationVersion: review.configurationVersion,
    modelRef: review.modelRef,
    delegationKey: review.delegationKey,
    // A calibrated approval below this boundary becomes human confirmation. The
    // documented default is 0.8 when the configuration omits it.
    confidenceThreshold: review.confidenceThreshold ?? 0.8,
    store: options.store,
    reviewer,
    clock: options.clock,
    ids: options.ids,
    executionLease: options.executionLease,
    prepareInput,
    // The saved output is the decision plus, for an alternative, the untrusted
    // suggestion text. It stays protected and never becomes authority.
    saveOutput: (request, decision) =>
      boundary.writeText({
        invocationId: request.reviewId,
        sequence: 0,
        dataClassification: "private",
        content: JSON.stringify(decision),
        occurredAt: options.clock.now(),
      }),
  });
}
