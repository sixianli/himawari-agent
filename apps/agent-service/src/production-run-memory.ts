import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  ApplicationPortError,
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
import type { Mem0ProjectionAdapter } from "@himawari-agent/memory-mem0";

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

/** Keep Mem0's embedding SDK and vector search while governing every physical request. */
export function createProductionRunMemory(options: {
  readonly configuration: ProductConfiguration;
  readonly memory: Pick<DurableMemoryService, "search">;
  readonly projection: Pick<Mem0ProjectionAdapter, "bindEmbeddingBoundary">;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly admission: ModelInvocationAdmissionResolver;
  readonly budget: ModelBudgetPort;
  readonly assertActive: () => Promise<void>;
  readonly now: () => string;
}): Pick<MemoryPort, "search"> & { project: NonNullable<DurableMemoryServiceOptions["project"]> } {
  const scope = new AsyncLocalStorage<MemorySearchRequest>();
  const projectionScope = new AsyncLocalStorage<{
    job: MemoryProjectionJob;
    memory: ProductMemoryRecord;
  }>();
  const descriptor = embeddingAdmissionDescriptor(options.configuration);
  options.projection.bindEmbeddingBoundary(async (request, send) => {
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
          limits: {
            accountCostMicros: options.configuration.budgets.perRunCostMicros,
            globalCostMicros: options.configuration.budgets.globalCostMicros,
            perClassificationCostMicros: options.configuration.budgets.perClassificationCostMicros,
          },
          reservedAt: options.now(),
        });
      let admitted = await reserve();
      // A released reservation proves no physical request started. Reuse the
      // stable next slot after a crash; never step over an uncertain/settled call.
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
          const actualCostMicros = Math.ceil(usage.inputTokens * descriptor.pricing.input);
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
        logicalSlot: "context-memory-search:v1",
        source: "embedding",
        ordinal: 1,
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
      const timeoutMs = Math.max(1, Math.floor(remaining()));
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
      const response = await send({ timeoutMs, signal });
      if (!Number.isSafeInteger(response.usage?.prompt_tokens) || response.usage.prompt_tokens < 0)
        throw new Error("EMBEDDING_USAGE_MISSING");
      if (
        response.data.length !== 1 ||
        response.data[0]?.index !== 0 ||
        response.data[0].embedding.length !== options.configuration.memory.dimensions ||
        !response.data[0].embedding.every(Number.isFinite)
      )
        throw new Error("EMBEDDING_VECTOR_INVALID");
      await permit.settle({
        inputTokens: response.usage.prompt_tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      settled = true;
      await permit.assertActive();
      return response;
    } catch (error) {
      if (started && !settled) await permit.markUnknown("transport_unresolved");
      else if (!started) await permit.releaseReserved();
      throw error;
    }
  }, options.configuration.deadlines.providerRequestMs);
  return {
    project: (job, memory, operation) => projectionScope.run({ job, memory }, operation),
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
        const found = await options.memory.search({
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
        });
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
