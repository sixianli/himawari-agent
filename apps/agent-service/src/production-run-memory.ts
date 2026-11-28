import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type DataClassification,
  type DurableMemoryService,
  type DurableMemoryServiceOptions,
  isModelVisible,
  type MemoryPort,
  type MemoryProjectionJob,
  type MemorySearchRequest,
  type ModelBudgetPort,
  type ModelInvocationAdmissionDescriptor,
  type ModelInvocationAdmissionResolver,
  type ModelInvocationPermit,
  memoryDatesOf,
  modelVisibleClassifications,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import {
  type EmbeddingBoundary,
  type EmbeddingRequest,
  embeddingUsageFor,
} from "@himawari-agent/memory-engine";
import { isExternalContentSourceRef } from "./context-external-content.js";

const FIRST_EMBEDDING_ATTEMPT_MS = 3_000;
const EMBEDDING_ATTEMPT_TIMED_OUT = "EMBEDDING_ATTEMPT_TIMED_OUT";
const EMBEDDING_INPUT_LIMIT = 16384;

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
    secretRequirement: secret
      ? { secretRef: secret.ref, secretVersion: secret.version, purpose: secret.purpose }
      : null,
    pricing: model.cost,
    estimatedCostMicros: Math.ceil(EMBEDDING_INPUT_LIMIT * model.cost.input),
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
  readonly skipWhenSlow?: boolean;
}

export interface MailEmbeddingContext {
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
  readonly dataClassification?: DataClassification;
  costMicros: number;
}

export interface MaintenanceEmbeddingContext {
  readonly deadlineAt: string;
  readonly dataClassification: NonNullable<MemorySearchRequest["dataClassification"]>;
}

export function createProductionRunMemory(options: {
  readonly configuration: ProductConfiguration;
  readonly memory: Pick<DurableMemoryService, "search">;
  readonly projection: {
    bindEmbeddingBoundary(
      boundary: EmbeddingBoundary,
      timeoutMs: number,
      searchCancelled?: (error: unknown) => boolean,
    ): void;
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
  embedForMailCheck: <T>(context: MailEmbeddingContext, operation: () => Promise<T>) => Promise<T>;
  embedForMaintenance: <T>(
    context: MaintenanceEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
  embedForExternalRead: <T>(
    context: MailEmbeddingContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
} {
  const scope = new AsyncLocalStorage<
    MemorySearchRequest & { readonly embeddingSlot?: string; readonly skipWhenSlow?: boolean }
  >();
  const mailScope = new AsyncLocalStorage<MailEmbeddingContext>();
  const maintenanceScope = new AsyncLocalStorage<MaintenanceEmbeddingContext>();
  const projectionScope = new AsyncLocalStorage<{
    job: MemoryProjectionJob;
    memory: ProductMemoryRecord;
  }>();
  const descriptor = embeddingAdmissionDescriptor(options.configuration);
  const diagnose = (event: Readonly<Record<string, string>>) => {
    try {
      options.diagnostic?.(event);
    } catch {
      return;
    }
  };
  const leaseLost = new WeakSet<object>();
  const skippedSearches = new WeakSet<object>();
  const whileHeld = async <T>(step: Promise<T>): Promise<T> => {
    try {
      return await step;
    } catch (error) {
      if (
        error instanceof ApplicationPortError &&
        error.code === PORT_ERROR_CODES.NOT_AUTHORITATIVE
      )
        leaseLost.add(error);
      throw error;
    }
  };
  const embedOnce = async (
    request: EmbeddingRequest,
    send: Parameters<EmbeddingBoundary>[1],
    ordinal: number,
    attemptMs?: number,
  ) => {
    const context = scope.getStore();
    const projection = projectionScope.getStore();
    const mail = mailScope.getStore();
    const maintenance = maintenanceScope.getStore();
    context?.signal?.throwIfAborted();
    mail?.signal.throwIfAborted();
    const deadline =
      context?.deadlineAt ??
      projection?.job.claimExpiresAt ??
      mail?.deadlineAt ??
      maintenance?.deadlineAt;
    if (!deadline || !Number.isFinite(Date.parse(deadline)))
      throw new Error("EMBEDDING_DEADLINE_REQUIRED");
    const remaining = () =>
      Math.min(
        options.configuration.deadlines.providerRequestMs,
        Date.parse(deadline) - Date.parse(options.now()),
      );
    if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
    const classification =
      context?.dataClassification ??
      projection?.memory.dataClassification ??
      (mail ? (mail.dataClassification ?? "private") : undefined) ??
      maintenance?.dataClassification;
    if (
      !classification ||
      (!projection && !mail && !maintenance && (!context?.runId || !context.executionLease))
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "EMBEDDING_EXECUTION_CONTEXT_REQUIRED",
      );
    if (
      !isModelVisible(classification) ||
      request.model !== descriptor.model ||
      typeof request.input !== "string" ||
      Buffer.byteLength(request.input, "utf8") > EMBEDDING_INPUT_LIMIT ||
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
    } else if (mail) {
      permit = {
        assertActive: options.assertActive,
        markStarted: async () => {},
        releaseReserved: async () => {},
        settle: async (usage) => {
          const actualCostMicros = usage.reportedCostMicros;
          if (
            typeof actualCostMicros !== "number" ||
            !Number.isSafeInteger(actualCostMicros) ||
            actualCostMicros < 0
          )
            throw new Error("EMBEDDING_GATEWAY_COST_MISSING");
          mail.costMicros += actualCostMicros;
        },
        markUnknown: async () => {
          mail.costMicros += descriptor.estimatedCostMicros;
        },
      };
    } else if (maintenance && !context) {
      if (descriptor.estimatedCostMicros !== 0)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "EMBEDDING_MAINTENANCE_REQUIRES_FREE_MODEL",
        );
      permit = {
        assertActive: options.assertActive,
        markStarted: async () => {},
        releaseReserved: async () => {},
        settle: async (usage) => {
          if (usage.reportedCostMicros !== 0) throw new Error("EMBEDDING_MAINTENANCE_COST_NONZERO");
        },
        markUnknown: async () => {},
      };
    } else {
      if (!context?.runId) throw new Error("EMBEDDING_RUN_REQUIRED");
      const gate = await options.admission({ ...context, runId: context.runId });
      if (!gate)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "EMBEDDING_ADMISSION_REQUIRED",
        );
      const admitted = await whileHeld(
        gate.begin({
          modelRef: descriptor.ref,
          provider: descriptor.provider,
          model: descriptor.model,
          modelVersion: descriptor.version,
          dataClassification: classification,
          logicalSlot:
            ordinal === 1
              ? (context.embeddingSlot ?? "context-memory-search:v1")
              : `${context.embeddingSlot ?? "context-memory-search:v1"}:attempt:${ordinal}`,
          source: "embedding",
          ordinal,
          estimatedCostMicros: descriptor.estimatedCostMicros,
          pricing: descriptor.pricing,
        }),
      );
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
      await whileHeld(permit.assertActive());
      context?.signal?.throwIfAborted();
      if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
      await whileHeld(permit.markStarted());
      started = true;
      const timeoutMs = Math.max(
        1,
        Math.floor(Math.min(remaining(), attemptMs ?? Number.POSITIVE_INFINITY)),
      );
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
      let response: Awaited<ReturnType<typeof send>>;
      let usage: ReturnType<ReturnType<typeof embeddingUsageFor>>;
      try {
        response = await send({ timeoutMs, signal });
        signal.throwIfAborted();
        if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
        usage = embeddingUsageFor(descriptor.provider)(
          response,
          descriptor.model,
          options.configuration.memory.dimensions,
        );
      } catch (error) {
        if (attemptMs !== undefined && timeout.aborted && !context?.signal?.aborted)
          throw new Error(EMBEDDING_ATTEMPT_TIMED_OUT);
        diagnose(embeddingFailureDiagnostic(error));
        throw error;
      }
      await whileHeld(permit.assertActive());
      signal.throwIfAborted();
      if (remaining() <= 0) throw new Error("EMBEDDING_DEADLINE_EXCEEDED");
      await permit.settle(usage);
      settled = true;
      await whileHeld(permit.assertActive());
      return response;
    } catch (error) {
      const markUnknownKeepingError = async () => {
        try {
          await permit.markUnknown("transport_unresolved");
        } catch (unknown) {
          diagnose({
            component: "agent-service",
            event: "memory.embedding_unknown_failed",
            error: unknown instanceof Error ? unknown.message : "EMBEDDING_UNKNOWN_FAILED",
          });
        }
      };
      const runEmbedding = !projection && !mail;
      if (
        started &&
        !settled &&
        ((error instanceof Error && error.message === EMBEDDING_ATTEMPT_TIMED_OUT) ||
          (runEmbedding && !context?.signal?.aborted))
      ) {
        try {
          await permit.settle({
            inputTokens: EMBEDDING_INPUT_LIMIT,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reportedCostMicros: descriptor.estimatedCostMicros,
          });
        } catch (accounting) {
          diagnose({
            component: "agent-service",
            event: "memory.embedding_settle_failed",
            error: accounting instanceof Error ? accounting.message : "EMBEDDING_SETTLE_FAILED",
          });
          await markUnknownKeepingError();
        }
      } else if (started && !settled) await markUnknownKeepingError();
      else if (!started)
        try {
          await permit.releaseReserved();
        } catch (release) {
          diagnose({
            component: "agent-service",
            event: "memory.embedding_release_failed",
            error: release instanceof Error ? release.message : "EMBEDDING_RELEASE_FAILED",
          });
        }
      throw error;
    }
  };
  options.projection.bindEmbeddingBoundary(
    async (request, send) => {
      if (projectionScope.getStore() || !scope.getStore()?.runId)
        return embedOnce(request, send, 1);
      try {
        return await embedOnce(request, send, 1, FIRST_EMBEDDING_ATTEMPT_MS);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== EMBEDDING_ATTEMPT_TIMED_OUT) throw error;
        const search = scope.getStore();
        if (search && (search.embeddingSlot === undefined || search.skipWhenSlow === true)) {
          skippedSearches.add(search);
          diagnose({
            component: "agent-service",
            event: "memory.embedding_skipped",
            afterMs: String(FIRST_EMBEDDING_ATTEMPT_MS),
          });
          throw error;
        }
        diagnose({
          component: "agent-service",
          event: "memory.embedding_retried",
          afterMs: String(FIRST_EMBEDDING_ATTEMPT_MS),
        });
        return embedOnce(request, send, 2);
      }
    },
    options.configuration.deadlines.providerRequestMs,
    (error) =>
      scope.getStore()?.signal?.aborted === true ||
      mailScope.getStore()?.signal.aborted === true ||
      (typeof error === "object" && error !== null && leaseLost.has(error)),
  );
  return {
    project: (job, memory, operation) => projectionScope.run({ job, memory }, operation),
    embedForMailCheck: (context, operation) => mailScope.run(context, operation),
    embedForMaintenance: (context, operation) => maintenanceScope.run(context, operation),
    embedForExternalRead: (context, operation) => mailScope.run(context, operation),
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
          ...(context.skipWhenSlow === true ? { skipWhenSlow: true } : {}),
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
        const found = await options.memory.search({
          ownerId: request.ownerId,
          agentId: request.agentId,
          queryRef: request.queryRef,
          policy: {
            limit: request.limit,
            allowedClassifications: modelVisibleClassifications(),
          },
        });
        if (skippedSearches.has(request)) return [];
        return found.map(({ memory, score }) => ({
          id: memory.id,
          ownerId: memory.ownerId,
          agentId: memory.agentId,
          contentRef: memory.contentRef,
          sourceRef: memory.sourceRefs.find((ref) => !isExternalContentSourceRef(ref)) ?? memory.id,
          searchTerms: [],
          dataClassification: memory.dataClassification,
          updatedAt: memory.updatedAt,
          dates: memoryDatesOf(memory),
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
    ? "quota_exceeded"
    : "unavailable";
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
