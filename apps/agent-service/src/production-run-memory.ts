import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  CONTEXT_MEMORY_QUOTA_EXCEEDED,
  CONTEXT_MEMORY_UNAVAILABLE,
  type DurableMemoryService,
  type DurableMemoryServiceOptions,
  type MemoryPort,
  type MemoryProjectionJob,
  type MemorySearchRequest,
  type ModelBudgetPort,
  type ModelInvocationAdmissionDescriptor,
  type ModelInvocationAdmissionResolver,
  type ModelInvocationPermit,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import {
  type EmbeddingBoundary,
  type EmbeddingRequest,
  gatewayEmbeddingUsage,
} from "@himawari-agent/memory-engine";

const FIRST_EMBEDDING_ATTEMPT_MS = 3_000;
const EMBEDDING_ATTEMPT_TIMED_OUT = "EMBEDDING_ATTEMPT_TIMED_OUT";

export function embeddingAdmissionDescriptor(
  configuration: ProductConfiguration,
): ModelInvocationAdmissionDescriptor {
  const model = configuration.modelDescriptors.find(({ role }) => role === "embedding");
  if (!model) throw new Error("EMBEDDING_DESCRIPTOR_MISSING");
  const secret = configuration.secretReferences.find(({ ref }) => ref === model.secretRef);
  return {
    ref: model.ref,
    provider: model.provider,
    model: model.model,
    version: model.version,
    routingClass: "primary",
    priority: 1,
    disclosure: model.disclosure,
    capabilities: model.capabilities,
    allowedDataClassifications: model.allowedDataClassifications,
    secretRequirement: secret
      ? { secretRef: secret.ref, secretVersion: secret.version, purpose: secret.purpose }
      : null,
    pricing: model.cost,
    estimatedCostMicros: Math.ceil(16384 * model.cost.input),
  };
}

export interface RunEmbeddingContext {
  readonly ownerId: MemorySearchRequest["ownerId"];
  readonly agentId: MemorySearchRequest["agentId"];
  readonly runId: NonNullable<MemorySearchRequest["runId"]>;
  readonly executionLease: NonNullable<MemorySearchRequest["executionLease"]>;
  readonly deadlineAt: string;
  readonly dataClassification: NonNullable<MemorySearchRequest["dataClassification"]>;
  readonly signal?: AbortSignal;
  readonly slot: string;
}

export function createProductionRunMemory(options: {
  readonly configuration: ProductConfiguration;
  readonly memory: Pick<DurableMemoryService, "search">;
  readonly projection: {
    bindEmbeddingBoundary(boundary: EmbeddingBoundary, timeoutMs: number): void;
  };
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly admission: ModelInvocationAdmissionResolver;
  readonly budget: ModelBudgetPort;
  readonly assertActive: () => Promise<void>;
  readonly now: () => string;
  readonly diagnostic?: (event: Readonly<Record<string, string>>) => void;
}): Pick<MemoryPort, "search"> & {
  project: NonNullable<DurableMemoryServiceOptions["project"]>;
  embedWithin: <T>(context: RunEmbeddingContext, operation: () => Promise<T>) => Promise<T>;
} {
  const scope = new AsyncLocalStorage<MemorySearchRequest & { readonly embeddingSlot?: string }>();
  const providerFailedSearches = new WeakMap<
    MemorySearchRequest,
    typeof CONTEXT_MEMORY_UNAVAILABLE | typeof CONTEXT_MEMORY_QUOTA_EXCEEDED
  >();
  const projectionScope = new AsyncLocalStorage<{
    job: MemoryProjectionJob;
    memory: ProductMemoryRecord;
  }>();
  const descriptor = embeddingAdmissionDescriptor(options.configuration);
  const embedOnce = async (
    request: EmbeddingRequest,
    send: Parameters<EmbeddingBoundary>[1],
    ordinal: number,
    attemptMs?: number,
  ) => {
    const context = scope.getStore();
    const projection = projectionScope.getStore();
    context?.signal?.throwIfAborted();
    const deadline = context?.deadlineAt ?? projection?.job.claimExpiresAt;
    if (!deadline || !Number.isFinite(Date.parse(deadline)))
      throw new Error("EMBEDDING_DEADLINE_REQUIRED");
    const remaining = () =>
      Math.min(
        options.configuration.deadlines.providerRequestMs,
        Date.parse(deadline) - Date.parse(options.now()),
      );
    if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
    const classification = context?.dataClassification ?? projection?.memory.dataClassification;
    if (!classification || (!projection && (!context?.runId || !context.executionLease)))
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "EMBEDDING_EXECUTION_CONTEXT_REQUIRED",
      );
    if (
      !descriptor.allowedDataClassifications.includes(classification) ||
      request.model !== descriptor.model ||
      typeof request.input !== "string" ||
      Buffer.byteLength(request.input, "utf8") > 16384 ||
      request.dimensions !== options.configuration.memory.dimensions
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "EMBEDDING_REQUEST_OUTSIDE_POLICY",
      );
    let permit: ModelInvocationPermit;
    if (projection) {
      await options.assertActive();
      const parent = {
        kind: "memory-projection" as const,
        jobId: projection.job.id,
        claimedBy: projection.job.claimedBy ?? "",
        attemptCount: projection.job.attemptCount,
      };
      const baseOperationKey = `embedding:v1:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
      let identity = { parent, operationKey: baseOperationKey };
      const reserve = () =>
        options.budget.reserve({
          ...identity,
          modelRef: descriptor.ref,
          dataClassification: classification,
          estimatedCostMicros: descriptor.estimatedCostMicros,
          reservedAt: options.now(),
        });
      let admitted = await reserve();
      for (
        let sequence = 2;
        admitted.allocation.status === "released" && sequence <= 32;
        sequence++
      ) {
        identity = { parent, operationKey: `${baseOperationKey}:attempt:${sequence}` };
        admitted = await reserve();
      }
      if (admitted.allocation.status !== "reserved")
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "EMBEDDING_RESULT_REQUIRES_RECONCILIATION",
        );
      permit = {
        assertActive: options.assertActive,
        markStarted: async () => {
          await options.budget.markStarted({ ...identity, startedAt: options.now() });
        },
        releaseReserved: async () => {
          await options.budget.releaseReserved({ ...identity, releasedAt: options.now() });
        },
        settle: async (usage) => {
          const actualCostMicros = usage.reportedCostMicros;
          if (
            typeof actualCostMicros !== "number" ||
            !Number.isSafeInteger(actualCostMicros) ||
            actualCostMicros < 0
          )
            throw new Error("EMBEDDING_GATEWAY_COST_MISSING");
          await options.budget.settle({ ...identity, actualCostMicros, settledAt: options.now() });
        },
        markUnknown: async (reasonCode) => {
          await options.budget.markUnknown({ ...identity, reasonCode, observedAt: options.now() });
        },
      };
    } else {
      if (!context?.runId) throw new Error("EMBEDDING_RUN_REQUIRED");
      const gate = await options.admission({ ...context, runId: context.runId });
      if (!gate)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "EMBEDDING_ADMISSION_REQUIRED",
        );
      const admitted = await gate.begin({
        modelRef: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        modelVersion: descriptor.version,
        dataClassification: classification,
        logicalSlot: context.embeddingSlot ?? "context-memory-search:v1",
        source: "embedding",
        ordinal,
        estimatedCostMicros: descriptor.estimatedCostMicros,
        pricing: descriptor.pricing,
      });
      if (admitted.disposition !== "fresh")
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "EMBEDDING_RESULT_REQUIRES_RECONCILIATION",
        );
      permit = admitted.permit;
    }
    let started = false;
    let settled = false;
    try {
      await permit.assertActive();
      context?.signal?.throwIfAborted();
      if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
      await permit.markStarted();
      started = true;
      const timeoutMs = Math.max(
        1,
        Math.floor(Math.min(remaining(), attemptMs ?? Number.POSITIVE_INFINITY)),
      );
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
      let response: Awaited<ReturnType<typeof send>>;
      let usage: ReturnType<typeof gatewayEmbeddingUsage>;
      try {
        response = await send({ timeoutMs, signal });
        signal.throwIfAborted();
        if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
        usage = gatewayEmbeddingUsage(
          response,
          descriptor.model,
          options.configuration.memory.dimensions,
        );
      } catch (error) {
        if (attemptMs !== undefined && timeout.aborted && !context?.signal?.aborted)
          throw new Error(EMBEDDING_ATTEMPT_TIMED_OUT);
        if (context && !context.signal?.aborted)
          providerFailedSearches.set(context, embeddingFailureCode(error));
        options.diagnostic?.(embeddingFailureDiagnostic(error));
        throw error;
      }
      await permit.assertActive();
      signal.throwIfAborted();
      if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
      await permit.settle(usage);
      settled = true;
      await permit.assertActive();
      return response;
    } catch (error) {
      if (started && !settled) await permit.markUnknown("transport_unresolved");
      else if (!started) await permit.releaseReserved();
      throw error;
    }
  };
  options.projection.bindEmbeddingBoundary(async (request, send) => {
    if (projectionScope.getStore() || !scope.getStore()?.runId) return embedOnce(request, send, 1);
    try {
      return await embedOnce(request, send, 1, FIRST_EMBEDDING_ATTEMPT_MS);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== EMBEDDING_ATTEMPT_TIMED_OUT) throw error;
      options.diagnostic?.({
        component: "agent-service",
        event: "memory.embedding_retried",
        afterMs: String(FIRST_EMBEDDING_ATTEMPT_MS),
      });
      return embedOnce(request, send, 2);
    }
  }, options.configuration.deadlines.providerRequestMs);
  return {
    project: (job, memory, operation) => projectionScope.run({ job, memory }, operation),
    embedWithin: (context, operation) =>
      scope.run(
        {
          ownerId: context.ownerId,
          agentId: context.agentId,
          runId: context.runId,
          executionLease: context.executionLease,
          deadlineAt: context.deadlineAt,
          dataClassification: context.dataClassification,
          ...(context.signal ? { signal: context.signal } : {}),
          queryRef: "",
          queryTerms: [],
          limit: 0,
          embeddingSlot: context.slot,
        },
        operation,
      ),
    search: async (request) => {
      if (
        request.ownerId !== options.configuration.ownerId ||
        request.agentId !== options.configuration.agentId
      )
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "MEMORY_SCOPE_MISMATCH");
      const payload = await options.payloads.get(request.queryRef);
      if (!payload || payload.dataClassification !== request.dataClassification)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "MEMORY_QUERY_CLASSIFICATION_MISMATCH",
        );
      return scope.run(request, async () => {
        const found = await options.memory
          .search({
            ownerId: request.ownerId,
            agentId: request.agentId,
            queryRef: request.queryRef,
            policy: {
              limit: request.limit,
              allowedClassifications: (
                ["public", "private", "sensitive", "restricted"] as const
              ).filter(
                (_classification, index, all) =>
                  index <= all.indexOf(request.dataClassification ?? "public"),
              ),
            },
          })
          .catch((error: unknown) => {
            const failure = providerFailedSearches.get(request);
            if (!failure) throw error;
            throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, failure);
          });
        const failure = providerFailedSearches.get(request);
        if (failure) throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, failure);
        return found.map(({ memory, score }) => ({
          id: memory.id,
          ownerId: memory.ownerId,
          agentId: memory.agentId,
          contentRef: memory.contentRef,
          sourceRef: memory.sourceRefs[0] ?? memory.id,
          searchTerms: [],
          dataClassification: memory.dataClassification,
          updatedAt: memory.updatedAt,
          score,
        }));
      });
    },
  };
}

function embeddingFailureCode(error: unknown) {
  return error instanceof ApplicationPortError &&
    (error.details["status"] === "402" ||
      error.details["gatewayErrorType"] === "quota_for_entity_exceeded")
    ? CONTEXT_MEMORY_QUOTA_EXCEEDED
    : CONTEXT_MEMORY_UNAVAILABLE;
}

function embeddingFailureDiagnostic(error: unknown): Readonly<Record<string, string>> {
  return {
    component: "agent-service",
    event: "memory.embedding_failed",
    failure: embeddingFailureCode(error),
    error: error instanceof Error ? error.message : "EMBEDDING_FAILED",
    ...(error instanceof ApplicationPortError ? error.details : {}),
  };
}
