import {
  ContextFormationService,
  ContextProjectionService,
  ModelInvocationAdmissionService,
  RunCoordinator,
  RunExecutionInputService,
  SessionTraceRecorder,
  type ClockPort,
  type IdGeneratorPort,
  type MemoryPort,
  type ModelInvocationAdmissionResolver,
  type ModelInvocationAdmissionDescriptor,
  type PayloadProtectorPort,
  type ProductConfiguration,
  type RunExecutionPolicy,
  type RunExecutionSource,
  type RuntimeToolPort,
  type WorkerRunPort,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PiAgentRuntimeAdapter, type PiModelBindingPort } from "@himawari-agent/runtime-pi";
import type { ProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import {
  ProductionRunDispatcher,
  type ProductionRunReconciler,
} from "./production-run-dispatcher.js";
import {
  ProductionRunDispatchLoop,
  type ProductionRunDispatchLoopFailure,
} from "./production-run-dispatch-loop.js";

export interface ProductionRunCompositionOptions {
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "budgets" | "concurrency"
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
  readonly workers: WorkerRunPort;
  readonly policy: (source: RunExecutionSource) => Promise<RunExecutionPolicy>;
  readonly reconcile: ProductionRunReconciler;
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
  const runtime = new PiAgentRuntimeAdapter({
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
  const coordinator = new RunCoordinator({
    runs: repository.runLifecycle(ownerId, agentId, fence),
    checkpoints,
    context,
    runtime,
    workers: options.workers,
    trace,
  });
  const input = new RunExecutionInputService({
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
    reconcile: options.reconcile,
    clock,
    executionLeaseDurationMs: 30_000,
    maximumRunsPerPump: configuration.concurrency.totalRuns,
    instanceId: options.instanceId,
  });
  const loop = new ProductionRunDispatchLoop({
    dispatcher,
    fallbackScanIntervalMs: 1000,
    onFailure: options.onFailure,
  });
  return Object.freeze({ input, admission, projection, runtime, coordinator, dispatcher, loop });
}
