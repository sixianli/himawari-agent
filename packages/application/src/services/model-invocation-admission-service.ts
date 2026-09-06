import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  type ClockPort,
  type DataClassification,
  type ModelBudgetLimits,
  type ModelDescriptor,
  type ModelInvocationAdmissionInput,
  type ModelInvocationAdmissionPort,
  type ModelInvocationAdmissionResult,
  type ModelInvocationExecutionContext,
  type ModelInvocationIdentity,
  type ModelInvocationIdentityPort,
  type ModelInvocationPermit,
  type ModelInvocationPricing,
  type ModelInvocationSource,
  type ModelInvocationUsage,
  PORT_ERROR_CODES,
  type RunDispatchPort,
  type RunExecutionLease,
  type RunExecutionLeaseClaim,
} from "../ports/index.js";

const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
const SOURCES = ["model-port", "agent-stream", "embedding"] as const;
const ROUTING_CLASSES = ["primary", "specialist", "local", "fallback"] as const;
const DISCLOSURES = ["local_only", "trusted_remote", "external_remote"] as const;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface ModelInvocationAdmissionDescriptor extends ModelDescriptor {
  readonly pricing: ModelInvocationPricing;
  readonly estimatedCostMicros: number;
}

export interface ModelInvocationAdmissionServiceDependencies {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly executionLease: RunExecutionLeaseClaim;
  readonly dispatch: RunDispatchPort;
  readonly invocations: ModelInvocationIdentityPort;
  readonly clock: ClockPort;
  readonly limits: ModelBudgetLimits;
  readonly registry: readonly ModelInvocationAdmissionDescriptor[];
}

interface BoundDescriptor {
  readonly descriptor: ModelDescriptor;
  readonly pricing: ModelInvocationPricing;
  readonly estimatedCostMicros: number;
}

function invalid(
  message: string,
  details: Readonly<Record<string, string>> = {},
): ApplicationPortError {
  return new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, message, details);
}

function notAuthoritative(
  message: string,
  details: Readonly<Record<string, string>> = {},
): ApplicationPortError {
  return new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, message, details);
}

function nonEmptyText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw invalid(`${field} must be a nonempty bounded string`, { field });
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative safe integer`, { field, value: String(value) });
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  const result = safeNonNegativeInteger(value, field);
  if (result === 0) throw invalid(`${field} must be a positive safe integer`, { field });
  return result;
}

function nonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid(`${field} must be a non-negative finite number`, { field, value: String(value) });
  }
  return value;
}

function isClassification(value: unknown): value is DataClassification {
  return typeof value === "string" && CLASSIFICATIONS.some((candidate) => candidate === value);
}

function classification(value: unknown, field: string): DataClassification {
  if (!isClassification(value))
    throw invalid(`${field} is not a supported data classification`, { field });
  return value;
}

function isSource(value: unknown): value is ModelInvocationSource {
  return typeof value === "string" && SOURCES.some((candidate) => candidate === value);
}

function source(value: unknown): ModelInvocationSource {
  if (!isSource(value)) throw invalid("source is not a supported model invocation source");
  return value;
}

function isRoutingClass(value: unknown): value is ModelDescriptor["routingClass"] {
  return typeof value === "string" && ROUTING_CLASSES.some((candidate) => candidate === value);
}

function routingClass(value: unknown, field: string): ModelDescriptor["routingClass"] {
  if (!isRoutingClass(value)) {
    throw invalid(`${field} is not a supported model routing class`, { field });
  }
  return value;
}

function isDisclosure(value: unknown): value is ModelDescriptor["disclosure"] {
  return typeof value === "string" && DISCLOSURES.some((candidate) => candidate === value);
}

function disclosure(value: unknown, field: string): ModelDescriptor["disclosure"] {
  if (!isDisclosure(value)) {
    throw invalid(`${field} is not a supported model disclosure`, { field });
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const result = nonEmptyText(value, field, 64);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) {
    throw invalid(`${field} must be a canonical ISO timestamp`, { field });
  }
  return result;
}

function freezePricing(input: ModelInvocationPricing, field: string): ModelInvocationPricing {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid(`${field} must be an object`, { field });
  }
  const pricing = {
    input: nonNegativeFinite(input.input, `${field}.input`),
    output: nonNegativeFinite(input.output, `${field}.output`),
    cacheRead: nonNegativeFinite(input.cacheRead, `${field}.cacheRead`),
    cacheWrite: nonNegativeFinite(input.cacheWrite, `${field}.cacheWrite`),
  };
  return Object.freeze(pricing);
}

function samePricing(left: ModelInvocationPricing, right: ModelInvocationPricing): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  );
}

function freezeDescriptor(
  input: ModelInvocationAdmissionDescriptor,
  index: number,
): BoundDescriptor {
  const field = `registry[${index}]`;
  if (!Array.isArray(input.capabilities)) {
    throw invalid(`${field}.capabilities must be an array`, { field });
  }
  if (!Array.isArray(input.allowedDataClassifications)) {
    throw invalid(`${field}.allowedDataClassifications must be an array`, { field });
  }
  if (
    input.secretRequirement !== null &&
    (typeof input.secretRequirement !== "object" || Array.isArray(input.secretRequirement))
  ) {
    throw invalid(`${field}.secretRequirement must be null or an object`, { field });
  }
  const capabilities = Object.freeze(
    input.capabilities.map((value, capabilityIndex) =>
      nonEmptyText(value, `${field}.capabilities[${capabilityIndex}]`),
    ),
  );
  const allowedDataClassifications = Object.freeze(
    input.allowedDataClassifications.map((value, classificationIndex) =>
      classification(value, `${field}.allowedDataClassifications[${classificationIndex}]`),
    ),
  );
  const secretRequirement =
    input.secretRequirement === null
      ? null
      : Object.freeze({
          secretRef: nonEmptyText(
            input.secretRequirement.secretRef,
            `${field}.secretRequirement.secretRef`,
          ),
          secretVersion: nonEmptyText(
            input.secretRequirement.secretVersion,
            `${field}.secretRequirement.secretVersion`,
          ),
          purpose: nonEmptyText(
            input.secretRequirement.purpose,
            `${field}.secretRequirement.purpose`,
          ),
        });
  const descriptor = Object.freeze({
    ref: nonEmptyText(input.ref, `${field}.ref`),
    provider: nonEmptyText(input.provider, `${field}.provider`),
    model: nonEmptyText(input.model, `${field}.model`),
    version: nonEmptyText(input.version, `${field}.version`),
    routingClass: routingClass(input.routingClass, `${field}.routingClass`),
    priority: positiveSafeInteger(input.priority, `${field}.priority`),
    disclosure: disclosure(input.disclosure, `${field}.disclosure`),
    capabilities,
    allowedDataClassifications,
    secretRequirement,
    ...(input.providerRouting === undefined
      ? {}
      : {
          providerRouting: Object.freeze({
            ...input.providerRouting,
            ...(input.providerRouting.order === undefined
              ? {}
              : { order: Object.freeze([...input.providerRouting.order]) }),
          }),
        }),
  });
  if (descriptor.allowedDataClassifications.length === 0) {
    throw invalid(`${field}.allowedDataClassifications must not be empty`, { field });
  }
  if (
    new Set(descriptor.allowedDataClassifications).size !==
    descriptor.allowedDataClassifications.length
  ) {
    throw invalid(`${field}.allowedDataClassifications must not contain duplicates`, { field });
  }
  const pricing = freezePricing(input.pricing, `${field}.pricing`);
  const estimatedCostMicros = safeNonNegativeInteger(
    input.estimatedCostMicros,
    `${field}.estimatedCostMicros`,
  );
  return Object.freeze({ descriptor, pricing, estimatedCostMicros });
}

function freezeLimits(input: ModelBudgetLimits): ModelBudgetLimits {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("limits must be an object", { field: "limits" });
  }
  if (
    input.perClassificationCostMicros === null ||
    typeof input.perClassificationCostMicros !== "object" ||
    Array.isArray(input.perClassificationCostMicros)
  ) {
    throw invalid("limits.perClassificationCostMicros must be an object", {
      field: "limits.perClassificationCostMicros",
    });
  }
  const perClassificationCostMicros: Record<DataClassification, number> = {
    public: safeNonNegativeInteger(
      input.perClassificationCostMicros.public,
      "limits.perClassificationCostMicros.public",
    ),
    private: safeNonNegativeInteger(
      input.perClassificationCostMicros.private,
      "limits.perClassificationCostMicros.private",
    ),
    sensitive: safeNonNegativeInteger(
      input.perClassificationCostMicros.sensitive,
      "limits.perClassificationCostMicros.sensitive",
    ),
    restricted: safeNonNegativeInteger(
      input.perClassificationCostMicros.restricted,
      "limits.perClassificationCostMicros.restricted",
    ),
  };
  return Object.freeze({
    accountCostMicros: safeNonNegativeInteger(input.accountCostMicros, "limits.accountCostMicros"),
    globalCostMicros: safeNonNegativeInteger(input.globalCostMicros, "limits.globalCostMicros"),
    perClassificationCostMicros: Object.freeze(perClassificationCostMicros),
  });
}

function freezeClaim(input: RunExecutionLeaseClaim): RunExecutionLeaseClaim {
  nonEmptyText(input.executionLeaseId, "executionLease.executionLeaseId", 128);
  safeNonNegativeInteger(input.expectedLeaseRevision, "executionLease.expectedLeaseRevision");
  nonEmptyText(input.authorityLeaseId, "executionLease.authorityLeaseId", 128);
  positiveSafeInteger(input.authorityFencingToken, "executionLease.authorityFencingToken");
  nonEmptyText(input.deploymentId, "executionLease.deploymentId", 128);
  positiveSafeInteger(input.authorityEpoch, "executionLease.authorityEpoch");
  positiveSafeInteger(input.fencingToken, "executionLease.fencingToken");
  nonEmptyText(input.consumerId, "executionLease.consumerId", 128);
  if (input.authorityFencingToken !== input.fencingToken) {
    throw notAuthoritative("Execution lease authority fencing token is inconsistent");
  }
  return Object.freeze({ ...input });
}

function assertUsage(usage: ModelInvocationUsage): void {
  const inputTokens = safeNonNegativeInteger(usage.inputTokens, "usage.inputTokens");
  const outputTokens = safeNonNegativeInteger(usage.outputTokens, "usage.outputTokens");
  const cacheReadTokens = safeNonNegativeInteger(usage.cacheReadTokens, "usage.cacheReadTokens");
  const cacheWriteTokens = safeNonNegativeInteger(usage.cacheWriteTokens, "usage.cacheWriteTokens");
  if (cacheReadTokens > inputTokens || cacheWriteTokens > inputTokens - cacheReadTokens) {
    throw invalid("Cached token counts exceed total input tokens");
  }
  if (outputTokens > MAX_SAFE_INTEGER) {
    throw invalid("usage.outputTokens exceeds the safe integer limit");
  }
}

function multiplyCost(tokens: number, price: number, field: string): number {
  const result = tokens * price;
  if (!Number.isFinite(result) || result < 0 || result > MAX_SAFE_INTEGER) {
    throw invalid(`${field} multiplication exceeds the safe numeric range`, { field });
  }
  return result;
}

function addCost(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isFinite(result) || result < 0 || result > MAX_SAFE_INTEGER) {
    throw invalid(`${field} addition exceeds the safe numeric range`, { field });
  }
  return result;
}

function actualCost(usage: ModelInvocationUsage, pricing: ModelInvocationPricing): number {
  assertUsage(usage);
  const regularInputTokens = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  let total = multiplyCost(regularInputTokens, pricing.input, "input cost");
  total = addCost(
    total,
    multiplyCost(usage.outputTokens, pricing.output, "output cost"),
    "total cost",
  );
  total = addCost(
    total,
    multiplyCost(usage.cacheReadTokens, pricing.cacheRead, "cache read cost"),
    "total cost",
  );
  total = addCost(
    total,
    multiplyCost(usage.cacheWriteTokens, pricing.cacheWrite, "cache write cost"),
    "total cost",
  );
  const rounded = Math.ceil(total);
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw invalid("Calculated model invocation cost exceeds the safe integer limit");
  }
  return rounded;
}

function sameLease(
  lease: RunExecutionLease,
  context: ModelInvocationExecutionContext,
  at: string,
): boolean {
  const now = Date.parse(at);
  const expires = Date.parse(lease.expiresAt);
  return (
    lease.ownerId === context.ownerId &&
    lease.agentId === context.agentId &&
    lease.runId === context.runId &&
    lease.authorityLeaseId === context.executionLease.authorityLeaseId &&
    lease.deploymentId === context.executionLease.deploymentId &&
    lease.authorityEpoch === context.executionLease.authorityEpoch &&
    lease.fencingToken === context.executionLease.fencingToken &&
    lease.consumerId === context.executionLease.consumerId &&
    lease.executionLeaseId === context.executionLease.executionLeaseId &&
    lease.revision === context.executionLease.expectedLeaseRevision &&
    lease.releasedAt === null &&
    Number.isFinite(expires) &&
    expires > now
  );
}

function sameExecutionLeaseClaim(
  left: RunExecutionLeaseClaim,
  right: RunExecutionLeaseClaim,
): boolean {
  return (
    left.executionLeaseId === right.executionLeaseId &&
    left.expectedLeaseRevision === right.expectedLeaseRevision &&
    left.authorityLeaseId === right.authorityLeaseId &&
    left.authorityFencingToken === right.authorityFencingToken &&
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken &&
    left.consumerId === right.consumerId
  );
}

export class ModelInvocationAdmissionService implements ModelInvocationAdmissionPort {
  readonly #context: ModelInvocationExecutionContext;
  readonly #dispatch: RunDispatchPort;
  readonly #invocations: ModelInvocationIdentityPort;
  readonly #clock: ClockPort;
  readonly #limits: ModelBudgetLimits;
  readonly #registry: readonly BoundDescriptor[];

  constructor(dependencies: ModelInvocationAdmissionServiceDependencies) {
    const executionLease = freezeClaim(dependencies.executionLease);
    this.#context = Object.freeze({
      ownerId: dependencies.ownerId,
      agentId: dependencies.agentId,
      runId: dependencies.runId,
      executionLease,
    });
    this.#dispatch = dependencies.dispatch;
    this.#invocations = dependencies.invocations;
    this.#clock = dependencies.clock;
    this.#limits = freezeLimits(dependencies.limits);
    const registry = dependencies.registry.map(freezeDescriptor);
    if (new Set(registry.map(({ descriptor }) => descriptor.ref)).size !== registry.length) {
      throw invalid("Model invocation registry contains duplicate model refs");
    }
    this.#registry = Object.freeze(registry);
  }

  get context(): ModelInvocationExecutionContext {
    return this.#context;
  }

  async begin(input: ModelInvocationAdmissionInput): Promise<ModelInvocationAdmissionResult> {
    const descriptor = this.#descriptor(input.modelRef);
    this.#validateInput(input, descriptor);
    await this.#assertActive();
    const reservedAt = canonicalTimestamp(this.#clock.now(), "reservedAt");
    const result = await this.#invocations.begin({
      runId: this.#context.runId,
      modelRef: descriptor.descriptor.ref,
      provider: descriptor.descriptor.provider,
      model: descriptor.descriptor.model,
      modelVersion: descriptor.descriptor.version,
      dataClassification: input.dataClassification,
      logicalSlot: nonEmptyText(input.logicalSlot, "logicalSlot"),
      source: input.source,
      ordinal: input.ordinal,
      estimatedCostMicros: descriptor.estimatedCostMicros,
      limits: this.#limits,
      pricing: descriptor.pricing,
      reservedAt,
      executionLease: this.#context.executionLease,
      authority: {
        deploymentId: this.#context.executionLease.deploymentId,
        authorityEpoch: this.#context.executionLease.authorityEpoch,
        fencingToken: this.#context.executionLease.fencingToken,
      },
      authorityLease: {
        leaseId: this.#context.executionLease.authorityLeaseId,
        fencingToken: this.#context.executionLease.authorityFencingToken,
      },
    });
    if (result.disposition !== "fresh") return result;
    const identity = result.identity;
    if (
      identity.ownerId !== this.#context.ownerId ||
      identity.agentId !== this.#context.agentId ||
      identity.runId !== this.#context.runId ||
      !sameExecutionLeaseClaim(identity.executionLease, this.#context.executionLease) ||
      identity.modelRef !== descriptor.descriptor.ref ||
      identity.provider !== descriptor.descriptor.provider ||
      identity.model !== descriptor.descriptor.model ||
      identity.modelVersion !== descriptor.descriptor.version ||
      identity.dataClassification !== input.dataClassification ||
      identity.logicalSlot !== input.logicalSlot ||
      identity.source !== input.source ||
      identity.ordinal !== input.ordinal ||
      identity.estimatedCostMicros !== descriptor.estimatedCostMicros ||
      !samePricing(identity.pricing, descriptor.pricing) ||
      identity.status !== "reserved"
    ) {
      throw notAuthoritative("Model invocation identity escaped its bound execution scope", {
        runId: String(this.#context.runId),
        modelRef: descriptor.descriptor.ref,
      });
    }
    return Object.freeze({
      disposition: "fresh" as const,
      identity,
      permit: this.#permit(identity),
    });
  }

  #descriptor(modelRef: string): BoundDescriptor {
    const descriptor = this.#registry.find(
      ({ descriptor: candidate }) => candidate.ref === modelRef,
    );
    if (descriptor === undefined) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        "Model descriptor is not registered",
        {
          modelRef,
        },
      );
    }
    return descriptor;
  }

  #validateInput(input: ModelInvocationAdmissionInput, bound: BoundDescriptor): void {
    if (
      input.modelRef !== bound.descriptor.ref ||
      input.provider !== bound.descriptor.provider ||
      input.model !== bound.descriptor.model ||
      input.modelVersion !== bound.descriptor.version
    ) {
      throw invalid("Model invocation identity does not match the registered descriptor", {
        modelRef: bound.descriptor.ref,
      });
    }
    const dataClassification = classification(input.dataClassification, "dataClassification");
    if (!bound.descriptor.allowedDataClassifications.includes(dataClassification)) {
      throw invalid("Model descriptor does not allow the requested data classification", {
        modelRef: bound.descriptor.ref,
        dataClassification,
      });
    }
    nonEmptyText(input.logicalSlot, "logicalSlot");
    source(input.source);
    positiveSafeInteger(input.ordinal, "ordinal");
    const estimatedCostMicros = safeNonNegativeInteger(
      input.estimatedCostMicros,
      "estimatedCostMicros",
    );
    if (estimatedCostMicros !== bound.estimatedCostMicros) {
      throw invalid("Model invocation estimate does not match the registered descriptor", {
        modelRef: bound.descriptor.ref,
      });
    }
    const pricing = freezePricing(input.pricing, "pricing");
    if (!samePricing(pricing, bound.pricing)) {
      throw invalid("Model invocation pricing does not match the registered descriptor", {
        modelRef: bound.descriptor.ref,
      });
    }
  }

  async #assertActive(): Promise<void> {
    const at = canonicalTimestamp(this.#clock.now(), "at");
    const lease = await this.#dispatch.assertHeld({
      runId: this.#context.runId,
      expectedLeaseRevision: this.#context.executionLease.expectedLeaseRevision,
      executionLeaseId: this.#context.executionLease.executionLeaseId,
      at,
    });
    if (!sameLease(lease, this.#context, at)) {
      throw notAuthoritative("Run execution lease is no longer active", {
        runId: String(this.#context.runId),
        executionLeaseId: String(this.#context.executionLease.executionLeaseId),
      });
    }
  }

  #permit(identity: ModelInvocationIdentity): ModelInvocationPermit {
    const frozenPricing = identity.pricing;
    return Object.freeze({
      assertActive: async () => this.#assertActive(),
      markStarted: async () => {
        await this.#assertActive();
        await this.#invocations.markStarted({
          runId: identity.runId,
          invocationId: identity.invocationId,
          budgetOperationKey: identity.budgetOperationKey,
          executionLease: identity.executionLease,
          at: canonicalTimestamp(this.#clock.now(), "startedAt"),
        });
      },
      releaseReserved: async () => {
        await this.#invocations.releaseReserved({
          runId: identity.runId,
          invocationId: identity.invocationId,
          budgetOperationKey: identity.budgetOperationKey,
          executionLease: identity.executionLease,
          at: canonicalTimestamp(this.#clock.now(), "releasedAt"),
        });
      },
      settle: async (usage: ModelInvocationUsage) => {
        const actualCostMicros = actualCost(usage, frozenPricing);
        await this.#invocations.settle({
          runId: identity.runId,
          invocationId: identity.invocationId,
          budgetOperationKey: identity.budgetOperationKey,
          executionLease: identity.executionLease,
          actualCostMicros,
          at: canonicalTimestamp(this.#clock.now(), "settledAt"),
        });
      },
      markUnknown: async (reasonCode: Parameters<ModelInvocationPermit["markUnknown"]>[0]) => {
        if (
          reasonCode !== "provider_unresolved" &&
          reasonCode !== "transport_unresolved" &&
          reasonCode !== "cancel_unresolved"
        ) {
          throw invalid("Model invocation unknown reason is invalid");
        }
        await this.#invocations.markUnknown({
          runId: identity.runId,
          invocationId: identity.invocationId,
          budgetOperationKey: identity.budgetOperationKey,
          executionLease: identity.executionLease,
          at: canonicalTimestamp(this.#clock.now(), "observedAt"),
          reasonCode,
        });
      },
    });
  }
}

export function createModelInvocationAdmissionService(
  dependencies: ModelInvocationAdmissionServiceDependencies,
): ModelInvocationAdmissionService {
  return new ModelInvocationAdmissionService(dependencies);
}
