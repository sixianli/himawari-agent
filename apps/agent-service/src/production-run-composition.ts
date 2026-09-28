import {
  type ClockPort,
  ContextFormationService,
  ContextProjectionService,
  type IdGeneratorPort,
  type MemoryPort,
  type ModelInvocationAdmissionDescriptor,
  type ModelInvocationAdmissionPort,
  type ModelInvocationAdmissionResolver,
  ModelInvocationAdmissionService,
  type PayloadProtectorPort,
  type ProductConfiguration,
  RunCoordinator,
  RunExecutionInputService,
  type RunExecutionPolicy,
  type RunExecutionSource,
  RuntimeContinuationService,
  type RuntimeRequest,
  type RuntimeToolPort,
  SessionTraceRecorder,
  type WorkerRunPort,
} from "@himawari-agent/application";
import { canonicalAuthorizationSnapshot } from "@himawari-agent/application/action-intent-snapshot";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PiAgentRuntimeAdapter, type PiModelBindingPort } from "@himawari-agent/runtime-pi";
import type { ProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import {
  ProductionRunDispatchLoop,
  type ProductionRunDispatchLoopFailure,
} from "./production-run-dispatch-loop.js";
import { ProductionRunDispatcher } from "./production-run-dispatcher.js";
import { createProductionRunReconciler } from "./production-run-reconciler.js";
import { createProductionToolResultRecovery } from "./production-tool-result-recovery.js";
import { ProductionThreadTitles } from "./production-thread-titles.js";

export interface ProductionRunCompositionOptions {
  readonly generateTitle?: (
    request: RuntimeRequest,
    prompt: string,
    admission: ModelInvocationAdmissionPort,
  ) => Promise<string>;
  readonly onTitleFailure?: (error: unknown) => void;
  readonly resources?: {
    recoverPending?(signal: AbortSignal, maximum: number): Promise<void>;
    stopRun(
      runId: Parameters<RunCoordinator["cancel"]>[0]["runId"],
      reason: "run_finished" | "run_cancelled",
    ): Promise<{ released: boolean }>;
  };
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "budgets" | "concurrency" | "deadlines"
  >;
  readonly repository: SqliteProductStateRepository;
  readonly authority: Pick<
    ProductionAuthorityLifecycle,
    "authorityFence" | "authorityLease" | "assertActive" | "isAccepting"
  >;
  readonly models: PiModelBindingPort;
  readonly modelRegistry: readonly ModelInvocationAdmissionDescriptor[];
  readonly protector: PayloadProtectorPort;
  readonly memory: Pick<MemoryPort, "search">;
  readonly tools: RuntimeToolPort;
  readonly prepareQueuedSandboxExecutions?: (request: RuntimeRequest) => Promise<void>;
  readonly workers?: WorkerRunPort;
  readonly policy: (source: RunExecutionSource) => Promise<RunExecutionPolicy>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly instanceId: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly onFailure: (failure: ProductionRunDispatchLoopFailure) => void;
}

/** One scoped composition owns dispatch, product context, Pi and durable completion. */
export function createProductionRunComposition(options: ProductionRunCompositionOptions) {
  const { configuration, repository, authority, clock, ids, protector } = options;
  const { ownerId, agentId } = configuration;
  const fence = authority.authorityFence();
  const lease = authority.authorityLease();
  const payloads = repository.payloadStore(ownerId, agentId);
  const artifacts = repository.runPayloadArtifactPort(ownerId, agentId, { product: fence, lease });
  const dispatch = repository.runDispatch(ownerId, agentId, fence, lease, options.instanceId);
  const checkpoints = repository.runCheckpointStore(ownerId, agentId, fence);
  const admission: ModelInvocationAdmissionResolver = async (scope) => {
    if (scope.ownerId !== ownerId || scope.agentId !== agentId || !scope.executionLease)
      return undefined;
    await authority.assertActive();
    return new ModelInvocationAdmissionService({
      ownerId,
      agentId,
      runId: scope.runId,
      executionLease: scope.executionLease,
      dispatch,
      invocations: repository.modelInvocationIdentityPort(ownerId, agentId, fence, lease),
      clock,
      registry: options.modelRegistry,
      limits: {
        accountCostMicros: configuration.budgets.perRunCostMicros,
        globalCostMicros: configuration.budgets.globalCostMicros,
        perClassificationCostMicros: configuration.budgets.perClassificationCostMicros,
      },
    });
  };
  const trace = new SessionTraceRecorder({
    trace: repository.traceStore(),
    artifacts,
    protector,
    audit: repository.auditLedger(),
    clock,
    ids,
  });
  const context = new ContextFormationService({
    memory: options.memory,
    trace,
    artifacts,
    payloads,
    protector,
    clock,
    ids,
    threads: repository.threadRepository(),
    threadSummaries: repository.threadDistillationState(),
  });
  const projection = new ContextProjectionService({
    ownerId,
    agentId,
    threads: repository.threadRepository(),
    checkpoints,
    payloads,
    artifacts,
    protector,
    clock,
    ids,
  });
  const prepareToolResultRecovery = createProductionToolResultRecovery({
    ownerId,
    agentId,
    repository,
    artifacts,
    checkpoints,
    protector,
    clock,
  });
  const continuations = new RuntimeContinuationService({
    artifacts,
    payloads,
    protector,
    clock,
    ids,
    authorizeAuthorityChange: async (request, ref, previousAuthority) => {
      if (request.knownToolResult) {
        const prepared = await prepareToolResultRecovery(request);
        return (
          prepared !== undefined &&
          prepared.binding.continuationRef === ref &&
          canonicalAuthorizationSnapshot(prepared.binding) ===
            canonicalAuthorizationSnapshot(request.knownToolResult) &&
          canonicalAuthorizationSnapshot(prepared.previousAuthority) ===
            canonicalAuthorizationSnapshot(previousAuthority)
        );
      }
      const saved = await checkpoints.read(request.runId);
      const recovery = saved?.queuedToolBatch;
      if (
        !recovery ||
        recovery.continuationRef !== ref ||
        canonicalAuthorizationSnapshot(previousAuthority) !==
          canonicalAuthorizationSnapshot(recovery.authority)
      )
        return false;
      const inventory = await repository
        .sandboxExecutionPreparations(ownerId, agentId)
        .readRunInventory({ runId: request.runId });
      const pending = inventory.queue.filter((item) => item.status === "queued");
      return (
        pending.length === 1 &&
        pending[0]?.recovery?.continuationRef === ref &&
        pending[0].bindingRevision > 0 &&
        canonicalAuthorizationSnapshot(pending[0].plan.executionLease) ===
          canonicalAuthorizationSnapshot(request.executionLease)
      );
    },
    assertActive: async (request) => {
      if (request.ownerId !== ownerId || request.agentId !== agentId)
        throw new Error("RUNTIME_SCOPE_INVALID");
      await authority.assertActive();
      await dispatch.assertHeld({
        runId: request.runId,
        executionLeaseId: request.executionLease.executionLeaseId,
        expectedLeaseRevision: request.executionLease.expectedLeaseRevision,
        at: clock.now(),
      });
      const current = await repository.runLifecycle(ownerId, agentId, fence).readRun(request.runId);
      if (!current || current.run.status !== "running") throw new Error("RUNTIME_RUN_NOT_ACTIVE");
    },
  });
  const runtime = new PiAgentRuntimeAdapter({
    continuations,
    projection,
    tools: options.tools,
    models: options.models,
    cwd: options.cwd,
    agentDir: options.agentDir,
    admission,
    now: () => clock.now(),
    // Each slot is scoped to a durable Run. The identity ledger prevents replay
    // of settled or uncertain physical streams after process restart.
    logicalSlot: (_request, ordinal) => `agent-stream:${ordinal}`,
  });
  const titles = options.generateTitle
    ? new ProductionThreadTitles({
        threads: repository.threadRepository(),
        payloads,
        protector,
        clock,
        authority: () => authority.authorityFence(),
        assertActive: () => authority.assertActive(),
        generate: async (request, prompt, onAdmitted) => {
          const gate = await admission(request);
          if (!gate || !options.generateTitle)
            throw new Error("THREAD_TITLE_ADMISSION_UNAVAILABLE");
          return options.generateTitle(request, prompt, {
            context: gate.context,
            begin: async (input) => {
              const result = await gate.begin({ ...input, budgetAccount: "thread-title" });
              if (result.disposition !== "fresh") return result;
              const { permit } = result;
              return {
                ...result,
                permit: {
                  assertActive: () => permit.assertActive(),
                  releaseReserved: () => permit.releaseReserved(),
                  settle: (usage) => permit.settle(usage),
                  markUnknown: (reason) => permit.markUnknown(reason),
                  markStarted: async () => {
                    await permit.markStarted();
                    onAdmitted();
                  },
                },
              };
            },
          });
        },
        onFailure: (error) => options.onTitleFailure?.(error),
      })
    : undefined;
  const titledRuntime = {
    cancel: (runId: Parameters<typeof runtime.cancel>[0]) => runtime.cancel(runId),
    async *run(request: RuntimeRequest) {
      await options.prepareQueuedSandboxExecutions?.(request);
      let requested = false;
      let titleAdmission: Promise<void> | undefined;
      for await (const event of runtime.run(request)) {
        if (!requested && event.type === "runtime.message" && event.role === "assistant") {
          requested = true;
          titleAdmission = titles?.start(request);
        }
        // The coordinator stops consuming at these events and then releases the Run lease.
        if (
          ["runtime.completed", "runtime.suspended", "runtime.result_unknown"].includes(event.type)
        )
          await titleAdmission;
        yield event;
      }
    },
  };
  const coordinator = new RunCoordinator({
    ...(options.resources ? { resources: options.resources } : {}),
    clock,
    runs: repository.runLifecycle(ownerId, agentId, fence),
    checkpoints,
    context,
    runtime: titledRuntime,
    ...(options.workers ? { workers: options.workers } : {}),
    trace,
  });
  const input = new RunExecutionInputService({
    maximumRunDurationMs: configuration.deadlines.runMs,
    source: repository.runExecutionSource(ownerId, agentId),
    artifacts,
    payloads,
    protector,
    clock,
    ids,
    dispatch,
    policy: options.policy,
  });
  const dispatcher = new ProductionRunDispatcher({
    authority,
    dispatch,
    coordinator,
    input: (candidate) => input.create(candidate),
    prepareToolResultRecovery,
    reconcile: createProductionRunReconciler({
      ownerId,
      agentId,
      runs: repository.runLifecycle(ownerId, agentId, fence),
      recovery: repository.runReconciliation(ownerId, agentId, fence, lease, options.instanceId),
      clock,
    }),
    clock,
    executionLeaseDurationMs: 30_000,
    maximumRunsPerPump: configuration.concurrency.totalRuns,
    instanceId: options.instanceId,
  });
  const loop = new ProductionRunDispatchLoop({
    dispatcher,
    fallbackScanIntervalMs: 1000,
    onFailure: options.onFailure,
    ...(options.resources?.recoverPending
      ? {
          recoverResources: async (signal: AbortSignal) => {
            await authority.assertActive();
            await options.resources?.recoverPending?.(signal, configuration.concurrency.totalRuns);
          },
        }
      : {}),
  });
  return Object.freeze({
    input,
    admission,
    projection,
    runtime,
    coordinator,
    dispatcher,
    loop,
    titles,
  });
}
