import { createHash } from "node:crypto";
import {
  type ClockPort,
  type ContextConversationRecallPort,
  ContextFormationService,
  ContextProjectionService,
  type ExecutionLiveFeed,
  type IdGeneratorPort,
  INBOX_LOOP_DEFAULTS,
  type MemoryPort,
  type ModelEgress,
  type ModelInvocationAdmissionDescriptor,
  type ModelInvocationAdmissionPort,
  type ModelInvocationAdmissionResolver,
  ModelInvocationAdmissionService,
  OwnerProfileService,
  type PayloadProtectorPort,
  type ProductConfiguration,
  RunCoordinator,
  RunExecutionInputService,
  type RunExecutionPolicy,
  type RunExecutionSource,
  RuntimeContinuationService,
  type RuntimeProjectionRequest,
  type RuntimeRequest,
  type RuntimeToolPort,
  type SandboxExecutionRecord,
  SessionTraceRecorder,
  ThreadPromptBundleService,
  type ToolRefusalConfiguration,
  type TraceStorePort,
  type WorkerRunPort,
} from "@himawari-agent/application";
import { canonicalAuthorizationSnapshot } from "@himawari-agent/application/action-intent-snapshot";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { PiAgentRuntimeAdapter, type PiModelBindingPort } from "@himawari-agent/runtime-pi";
import {
  type ContextExternalContent,
  markRecalledExternalRecords,
  runExternalOrigins,
  threadExternalOrigins,
} from "./context-external-content.js";
import type { ProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import type { ProductionBackgroundCommands } from "./production-background-commands.js";
import { ProductionBackgroundRuns } from "./production-background-runs.js";
import {
  type MemoryCaptureCall,
  ProductionMemoryCapture,
  type ProductionMemoryCaptureOptions,
} from "./production-memory-capture.js";
import {
  ProductionRunDispatchLoop,
  type ProductionRunDispatchLoopFailure,
} from "./production-run-dispatch-loop.js";
import { ProductionRunDispatcher } from "./production-run-dispatcher.js";
import { createProductionRunExpiry } from "./production-run-expiry.js";
import { createProductionRunReconciler } from "./production-run-reconciler.js";

type ProductionMemoryCaptureRecall = NonNullable<
  ReturnType<NonNullable<ProductionMemoryCaptureOptions["relevantMemoryIds"]>>
>[number];

import {
  ProductionMemoryConsolidation,
  type ProductionMemoryConsolidationOptions,
} from "./production-memory-consolidation.js";
import {
  ProductionMemoryConversationReview,
  type ProductionMemoryConversationReviewOptions,
} from "./production-memory-conversation-review.js";
import {
  ProductionMemoryEpisodes,
  type ProductionMemoryEpisodesOptions,
} from "./production-memory-episodes.js";
import type { ModelUsageRecording } from "./production-model-composition.js";
import {
  currentRunId,
  ProductionRunTimings,
  type RunTimingDiagnostic,
} from "./production-run-timing.js";
import { ProductionThreadTitles } from "./production-thread-titles.js";
import { createProductionTitledRuntime } from "./production-titled-runtime.js";
import { createProductionToolResultRecovery } from "./production-tool-result-recovery.js";
import { ProductionUploadedFiles } from "./production-uploaded-files.js";

export interface ProductionRunCompositionOptions {
  readonly egress: ModelEgress;
  readonly externalContent?: Pick<
    ContextExternalContent,
    "mark" | "markRunSource" | "read" | "readThread"
  >;
  readonly toolRefusalLimits?: ToolRefusalConfiguration;
  readonly generateTitle?: (
    request: RuntimeRequest,
    prompt: string,
    admission: ModelInvocationAdmissionPort,
  ) => Promise<string>;
  readonly onTitleFailure?: (error: unknown) => void;
  readonly memoryCapture?: Pick<
    ProductionMemoryCaptureOptions,
    "product" | "approvals" | "onAudit" | "onFailure" | "timeZone"
  > & {
    readonly generate: (
      request: RuntimeRequest,
      prompt: string,
      admission: ModelInvocationAdmissionPort,
      purpose?: string,
      call?: MemoryCaptureCall,
    ) => Promise<string>;
    readonly episodes?: Pick<
      ProductionMemoryEpisodesOptions,
      "service" | "turns" | "embedWithin" | "onFailure"
    >;
    readonly consolidation?: Pick<
      ProductionMemoryConsolidationOptions,
      "service" | "search" | "embedWithin" | "onResult" | "onFailure"
    >;
    readonly conversationReview?: Pick<
      ProductionMemoryConversationReviewOptions,
      "settings" | "search" | "onResult" | "onFailure"
    >;
  };
  readonly recoverMissingToolResult?: (
    record: SandboxExecutionRecord,
  ) => Promise<SandboxExecutionRecord>;
  readonly sandboxResultUnrecoverable?: (record: SandboxExecutionRecord) => Promise<boolean>;
  readonly resources?: {
    recoverPending?(signal: AbortSignal, maximum: number): Promise<void>;
    stopRun(
      runId: Parameters<RunCoordinator["cancel"]>[0]["runId"],
      reason: "run_finished" | "run_cancelled",
    ): Promise<{ released: boolean }>;
  };
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "concurrency" | "deadlines"
  > & {
    readonly runPolicy?: Pick<
      NonNullable<ProductConfiguration["runPolicy"]>,
      "freezeThreadPrompts" | "userComputers"
    >;
  };
  readonly onHandleTools?: (
    request: RuntimeRequest,
    observation: { readonly generation: number | null; readonly handleTools: number },
  ) => void;
  readonly repository: SqliteProductStateRepository;
  readonly authority: Pick<
    ProductionAuthorityLifecycle,
    "authorityFence" | "authorityLease" | "assertActive" | "isAccepting"
  >;
  readonly models: PiModelBindingPort;
  readonly modelRegistry: readonly ModelInvocationAdmissionDescriptor[];
  readonly protector: PayloadProtectorPort;
  readonly memory: Pick<MemoryPort, "search">;
  readonly conversationRecall?: ContextConversationRecallPort;
  readonly tools: RuntimeToolPort;
  readonly backgroundCommands?: ProductionBackgroundCommands;
  readonly prepareQueuedSandboxExecutions?: (request: RuntimeRequest) => Promise<void>;
  readonly onToolCallStarted?: (request: RuntimeRequest, toolName: string) => void;
  readonly live?: Pick<ExecutionLiveFeed, "assistantText" | "changed">;
  readonly modelUsage?: ModelUsageRecording;
  readonly onModelAdmissionFailed?: (
    request: RuntimeRequest,
    failure: { readonly code: string; readonly reason: string | null },
  ) => void;
  readonly onModelRequestRejected?: (
    request: RuntimeRequest,
    rejection: {
      readonly status: number;
      readonly retryAfter: string | null;
      readonly shouldRetry: string | null;
      readonly host: string | null;
    },
  ) => void;
  readonly onCompactionSummaryRequest?: (
    request: RuntimeRequest,
    summary: { readonly sharedHead: boolean },
  ) => void;
  readonly onModelStreamFailed?: (
    request: RuntimeRequest,
    failure: { readonly code: string; readonly message: string },
  ) => void;
  readonly workers?: WorkerRunPort;
  readonly policy: (source: RunExecutionSource) => Promise<RunExecutionPolicy>;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly instanceId: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly timeZone?: string;
  readonly memorySnapshotCharacters?: number;
  readonly onFailure: (failure: ProductionRunDispatchLoopFailure) => void;
  readonly onRunTiming?: (diagnostic: RunTimingDiagnostic) => void;
  readonly onBackgroundFailure?: (runId: string, error: unknown) => void;
}

function liveTrace(
  trace: TraceStorePort,
  live: Pick<ExecutionLiveFeed, "changed"> | undefined,
): TraceStorePort {
  if (!live) return trace;
  return {
    appendNext: async (event) => {
      const appended = await trace.appendNext(event);
      live.changed(appended.runId);
      return appended;
    },
    append: (event) => trace.append(event),
    readRun: (runId, afterSequence, limit) => trace.readRun(runId, afterSequence, limit),
    readSession: (sessionId, afterRecordedAt, limit) =>
      trace.readSession(sessionId, afterRecordedAt, limit),
    readRecentByType: (input) => trace.readRecentByType(input),
  };
}

export function createProductionRunComposition(options: ProductionRunCompositionOptions) {
  const { configuration, repository, authority, clock, ids, protector } = options;
  const { ownerId, agentId } = configuration;
  const fence = authority.authorityFence();
  const lease = authority.authorityLease();
  const timings = new ProductionRunTimings();
  const payloads = repository.payloadStore(ownerId, agentId);
  const artifacts = timings.methods(
    repository.runPayloadArtifactPort(ownerId, agentId, { product: fence, lease }),
    { commit: "payload.commit" },
  );
  const dispatch = repository.runDispatch(ownerId, agentId, fence, lease, options.instanceId);
  const checkpoints = timings.methods(repository.runCheckpointStore(ownerId, agentId, fence), {
    read: "checkpoint.read",
    compareAndSet: "checkpoint.write",
  });
  const admission: ModelInvocationAdmissionResolver = async (scope) => {
    if (scope.ownerId !== ownerId || scope.agentId !== agentId || !scope.executionLease)
      return undefined;
    await authority.assertActive();
    return timings.methods(
      new ModelInvocationAdmissionService({
        ownerId,
        agentId,
        runId: scope.runId,
        executionLease: scope.executionLease,
        dispatch,
        invocations: repository.modelInvocationIdentityPort(ownerId, agentId, fence, lease),
        clock,
        registry: options.modelRegistry,
      }),
      { begin: "model.admission" },
      () => scope.runId,
    );
  };
  const trace = timings.methods(
    new SessionTraceRecorder({
      trace: timings.methods(liveTrace(repository.traceStore(), options.live), {
        appendNext: "trace.append",
      }),
      artifacts,
      protector: timings.methods(protector, { protect: "trace.protect" }, currentRunId),
      audit: timings.methods(repository.auditLedger(), { append: "trace.audit" }, currentRunId),
      clock,
      ids,
    }),
    { record: "trace.record" },
  );
  const recalled = new Map<string, readonly ProductionMemoryCaptureRecall[]>();
  const memory: Pick<MemoryPort, "search"> = {
    search: async (request) => {
      const found = await timings.measure(request.runId, "memory.search", () =>
        options.memory.search(request),
      );
      if (options.externalContent && request.runId)
        await markRecalledExternalRecords({
          marker: options.externalContent,
          state: repository.productMemoryState(),
          runId: request.runId,
          ownerId: request.ownerId,
          agentId: request.agentId,
          memoryIds: found.map(({ id }) => id),
        });
      if (options.memoryCapture && request.runId) {
        recalled.delete(request.runId);
        recalled.set(
          request.runId,
          found.map(({ id }) => id as ProductionMemoryCaptureRecall),
        );
        if (recalled.size > 200) {
          const oldest = recalled.keys().next().value;
          if (oldest !== undefined) recalled.delete(oldest);
        }
      }
      return found;
    },
  };
  const profileText = new Map<string, string>();
  const preferences = repository.ownerPreferences();
  const profile = new OwnerProfileService({
    state: repository.productMemoryState(),
    pins: repository.memoryBook(),
    ownerName: async (scope) => (await preferences.read(scope)).name,
    readText: async (record) => {
      const cached = profileText.get(record.contentRef);
      if (cached !== undefined) return cached;
      const payload = await payloads.get(record.contentRef);
      if (!payload || payload.contentType !== "text/plain") return undefined;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await protector.unprotect({ ownerId, agentId, payload }),
      );
      if (profileText.size >= 2000) profileText.clear();
      profileText.set(record.contentRef, text);
      return text;
    },
    storeText: async (input) => {
      if (await payloads.get(input.ref)) return;
      await payloads.put(
        await protector.protect({
          ownerId: input.ownerId,
          agentId: input.agentId,
          ref: input.ref,
          contentType: "text/plain",
          dataClassification: input.dataClassification,
          plaintext: new TextEncoder().encode(input.text),
          createdAt: clock.now(),
        }),
      );
    },
    digest: (text) => createHash("sha256").update(text).digest("hex"),
    reminders: repository.memoryReminders(),
    conversations: repository.conversationTurns(),
    ...(options.memorySnapshotCharacters
      ? { snapshotCharacterBudget: options.memorySnapshotCharacters }
      : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const context = timings.methods(
    new ContextFormationService({
      profile,
      memory,
      ...(options.conversationRecall ? { conversations: options.conversationRecall } : {}),
      trace,
      artifacts,
      payloads,
      protector,
      clock,
      ids,
      threads: repository.threadRepository(),
      threadSummaries: repository.threadDistillationState(),
      ledger: repository.decisionLedger(),
    }),
    { form: "context.form" },
  );
  const resolvedProjection = timings.methods(
    new ContextProjectionService({
      ownerId,
      agentId,
      threads: repository.threadRepository(),
      checkpoints,
      payloads,
      artifacts,
      protector,
      clock,
      ids,
    }),
    {
      resolveProjection: "pi.resolve_projection",
      capture: "pi.capture",
      captureHistory: "pi.history_write",
      captureFinalAnswer: "pi.final_answer",
    },
  );
  const externalContent = options.externalContent;
  const projection: typeof resolvedProjection = externalContent
    ? Object.assign(Object.create(resolvedProjection) as typeof resolvedProjection, {
        resolveProjection: async (request: RuntimeProjectionRequest) => {
          await externalContent.markRunSource(request.runId);
          const resolved = await resolvedProjection.resolveProjection(request);
          if (resolved.ownerAttachments)
            await externalContent.mark(request.runId, "owner_attachment");
          return resolved;
        },
      })
    : resolvedProjection;
  const toolResultRecoveryParts = {
    ...(options.recoverMissingToolResult
      ? { recoverMissingResult: options.recoverMissingToolResult }
      : {}),
    ownerId,
    agentId,
    repository,
    artifacts,
    checkpoints,
    protector,
    clock,
    ids,
  };
  const prepareToolResultRecovery = createProductionToolResultRecovery({
    ...toolResultRecoveryParts,
    ...(options.sandboxResultUnrecoverable
      ? { resultUnrecoverable: options.sandboxResultUnrecoverable }
      : {}),
  });
  const inspectToolResultRecovery = createProductionToolResultRecovery(toolResultRecoveryParts);
  const continuations = new RuntimeContinuationService({
    artifacts,
    payloads,
    protector,
    clock,
    ids,
    authorizeAuthorityChange: async (request, ref, previousAuthority) => {
      if (request.knownToolResult) {
        const prepared = await inspectToolResultRecovery(request);
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
  const promptBundles =
    configuration.runPolicy?.freezeThreadPrompts === false
      ? undefined
      : timings.methods(
          new ThreadPromptBundleService({
            store: repository.threadPromptBundles(),
            payloads,
            artifacts,
            protector,
            clock,
            ids,
            trace: (input) => trace.record(input),
          }),
          { resolve: "pi.prompt_bundle" },
        );
  const runtime = new PiAgentRuntimeAdapter({
    egress: options.egress,
    ...(options.toolRefusalLimits ? { toolRefusalLimits: options.toolRefusalLimits } : {}),
    continuations,
    projection,
    ...(promptBundles ? { promptBundles } : {}),
    ...(options.onHandleTools ? { onHandleTools: options.onHandleTools } : {}),
    tools: timings.methods(
      options.tools,
      {
        listAuthorized: "tool.list",
        preflight: "tool.preflight",
        execute: "tool.execute",
      },
      (args) => {
        const first = args[0];
        if (typeof first === "string") return first;
        const runId = (first as { readonly runId?: unknown } | undefined)?.runId;
        return typeof runId === "string" ? runId : undefined;
      },
    ),
    models: options.models,
    cwd: options.cwd,
    ...(configuration.runPolicy?.userComputers ? { toolsRunInComputer: true } : {}),
    agentDir: options.agentDir,
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    admission,
    measure: (runId, name, work) => timings.measure(runId, name, work),
    now: () => clock.now(),
    logicalSlot: (_request, ordinal) => `agent-stream:${ordinal}`,
    ...(options.onToolCallStarted ? { onToolCallStarted: options.onToolCallStarted } : {}),
    ...(options.live
      ? {
          onAssistantText: (
            request: RuntimeRequest,
            message: { readonly timestamp: unknown; readonly text: string },
          ) =>
            options.live?.assistantText({
              threadId: request.threadId,
              runId: request.runId,
              ...message,
            }),
        }
      : {}),
    ...(options.onModelStreamFailed ? { onModelStreamFailed: options.onModelStreamFailed } : {}),
    ...(options.onCompactionSummaryRequest
      ? { onCompactionSummaryRequest: options.onCompactionSummaryRequest }
      : {}),
    ...(options.onModelAdmissionFailed
      ? { onModelAdmissionFailed: options.onModelAdmissionFailed }
      : {}),
    ...(options.onModelRequestRejected
      ? { onModelRequestRejected: options.onModelRequestRejected }
      : {}),
    ...(options.modelUsage ? { usage: options.modelUsage } : {}),
  });
  const titles = options.generateTitle
    ? new ProductionThreadTitles({
        threads: repository.threadRepository(),
        payloads,
        protector,
        clock,
        authority: () => authority.authorityFence(),
        assertActive: () => authority.assertActive(),
        externalTag: () => options.egress.externalTag(),
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
  const memoryCaptureOptions = options.memoryCapture;
  const memoryCapture = memoryCaptureOptions
    ? new ProductionMemoryCapture({
        sources: repository.runExecutionSource(ownerId, agentId),
        threads: repository.threadRepository(),
        generations: repository.threadDistillationState(),
        state: repository.productMemoryState(),
        relevantMemoryIds: (runId) => recalled.get(runId) ?? [],
        ...(options.externalContent
          ? {
              externalOrigins: runExternalOrigins(externalContent),
            }
          : {}),
        product: memoryCaptureOptions.product,
        approvals: memoryCaptureOptions.approvals,
        reminders: repository.memoryReminders(),
        book: repository.memoryBook(),
        ledger: repository.decisionLedger(),
        ...(memoryCaptureOptions.timeZone ? { timeZone: memoryCaptureOptions.timeZone } : {}),
        payloads,
        protector,
        clock,
        assertActive: () => authority.assertActive(),
        externalTag: () => options.egress.externalTag(),
        backlog: repository.memoryCaptureBacklog(),
        unitOfWork: repository.unitOfWork(),
        generate: (request, prompt, onAdmitted, call) =>
          auxiliaryMemoryGeneration(request, prompt, onAdmitted, "memory-capture", call),
        onAudit: memoryCaptureOptions.onAudit,
        onFailure: memoryCaptureOptions.onFailure,
      })
    : undefined;
  const memoryEpisodeOptions = memoryCaptureOptions?.episodes;
  const memoryEpisodes = memoryEpisodeOptions
    ? new ProductionMemoryEpisodes({
        service: memoryEpisodeOptions.service,
        ...(memoryEpisodeOptions.turns ? { turns: memoryEpisodeOptions.turns } : {}),
        threads: repository.threadRepository(),
        payloads,
        protector,
        assertActive: () => authority.assertActive(),
        generate: (request, prompt, onAdmitted, purpose) =>
          auxiliaryMemoryGeneration(request, prompt, onAdmitted, purpose),
        ...(memoryEpisodeOptions.embedWithin
          ? { embedWithin: memoryEpisodeOptions.embedWithin }
          : {}),
        onFailure: memoryEpisodeOptions.onFailure,
      })
    : undefined;
  const memoryConsolidationOptions = memoryCaptureOptions?.consolidation;
  const memoryConsolidation = memoryConsolidationOptions
    ? new ProductionMemoryConsolidation({
        ...memoryConsolidationOptions,
        assertActive: () => authority.assertActive(),
        generate: (request, prompt, onAdmitted, purpose) =>
          auxiliaryMemoryGeneration(request, prompt, onAdmitted, purpose),
        now: () => options.clock.now(),
      })
    : undefined;
  const conversationReviewOptions = memoryCaptureOptions?.conversationReview;
  const memoryConversationReview =
    memoryCaptureOptions && conversationReviewOptions
      ? new ProductionMemoryConversationReview({
          ...conversationReviewOptions,
          episodes: repository.memoryEpisodes(),
          store: repository.memoryConversationReviews(),
          threads: repository.threadRepository(),
          state: repository.productMemoryState(),
          generations: repository.threadDistillationState(),
          product: memoryCaptureOptions.product,
          approvals: memoryCaptureOptions.approvals,
          reminders: repository.memoryReminders(),
          book: repository.memoryBook(),
          ledger: repository.decisionLedger(),
          ...(options.externalContent
            ? {
                externalOrigins: threadExternalOrigins(externalContent),
              }
            : {}),
          ...(memoryCaptureOptions.timeZone ? { timeZone: memoryCaptureOptions.timeZone } : {}),
          payloads,
          protector,
          clock,
          assertActive: () => authority.assertActive(),
          externalTag: () => options.egress.externalTag(),
          generate: (request, prompt, onAdmitted, call) =>
            auxiliaryMemoryGeneration(request, prompt, onAdmitted, "memory-consolidation", call),
        })
      : undefined;
  const memoryPaused = () =>
    repository
      .memoryBook()
      .readSettings({ ownerId, agentId })
      .then(({ capturePaused }) => capturePaused);
  async function auxiliaryMemoryGeneration(
    request: RuntimeRequest,
    prompt: string,
    onAdmitted: () => void,
    purpose: string,
    call?: MemoryCaptureCall,
  ): Promise<string> {
    if (!memoryCaptureOptions) throw new Error("MEMORY_CAPTURE_MODEL_UNAVAILABLE");
    const gate = await admission(request);
    if (!gate) throw new Error("MEMORY_CAPTURE_ADMISSION_UNAVAILABLE");
    return memoryCaptureOptions.generate(
      request,
      prompt,
      {
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
      },
      purpose,
      call,
    );
  }
  const titledRuntime = createProductionTitledRuntime({
    runtime: timings.runtime(runtime, "pi"),
    ...(options.prepareQueuedSandboxExecutions
      ? {
          prepareQueuedSandboxExecutions: (request: RuntimeRequest) =>
            timings.measure(
              request.runId,
              "sandbox.rebind_queued",
              () => options.prepareQueuedSandboxExecutions?.(request) ?? Promise.resolve(),
            ),
        }
      : {}),
    ...(titles ? { titles } : {}),
    uploads: new ProductionUploadedFiles({
      threads: repository.threadRepository(),
      payloads,
      protector,
      store: repository.threadArtifacts(),
      ids,
      now: () => clock.now(),
    }),
    ...(memoryCapture ? { memoryCapture } : {}),
    ...(memoryEpisodes ? { memoryEpisodes } : {}),
    ...(memoryConsolidation ? { memoryConsolidation } : {}),
    ...(memoryConversationReview ? { memoryConversationReview } : {}),
    memoryPaused,
  });
  const runLifecycle = repository.runLifecycle(ownerId, agentId, fence);
  const background = options.backgroundCommands
    ? new ProductionBackgroundRuns({
        ownerId,
        agentId,
        commands: options.backgroundCommands,
        dispatch,
        runs: runLifecycle,
        ...(options.resources ? { resources: options.resources } : {}),
        storeNotice: async (input) => {
          if (await payloads.get(input.ref)) return;
          await payloads.put(
            await protector.protect({
              ownerId,
              agentId,
              ref: input.ref,
              contentType: "text/plain",
              dataClassification: input.dataClassification,
              plaintext: new TextEncoder().encode(input.text),
              createdAt: clock.now(),
            }),
          );
        },
        authority: () => authority.authorityLease(),
        assertActive: () => authority.assertActive(),
        clock,
        ...(options.onBackgroundFailure ? { onFailure: options.onBackgroundFailure } : {}),
      })
    : undefined;
  const coordinator = new RunCoordinator({
    ...(options.resources
      ? { resources: timings.methods(options.resources, { stopRun: "resources.stop" }) }
      : {}),
    clock,
    runs: timings.methods(runLifecycle, {
      readRun: "run.read",
      transitionRun: "run.transition",
      completeRun: "run.complete",
    }),
    checkpoints,
    context,
    runtime: timings.runtime(titledRuntime, "runtime"),
    ...(options.workers ? { workers: options.workers } : {}),
    trace,
    ...(background ? { background } : {}),
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
    folds: repository.threadRepository(),
    foldLimit: async () => {
      const settings = await repository
        .inbox()
        .readSettings({ ownerId, agentId })
        .catch(() => undefined);
      const perRun = settings?.overrides["eventsPerRun"] ?? INBOX_LOOP_DEFAULTS.eventsPerRun;
      return Math.max(0, perRun - 1);
    },
  });
  const describeSettledRun = (result: {
    readonly checkpoint: {
      readonly terminalStatus: string | null;
      readonly diagnosticCode: string | null;
    };
  }): RunTimingDiagnostic => ({
    ...(result.checkpoint.terminalStatus
      ? { terminalStatus: result.checkpoint.terminalStatus }
      : {}),
    ...(result.checkpoint.diagnosticCode
      ? { diagnosticCode: result.checkpoint.diagnosticCode }
      : {}),
  });
  const reportTiming = (diagnostic: RunTimingDiagnostic) => options.onRunTiming?.(diagnostic);
  let loopRef: ProductionRunDispatchLoop | undefined;
  const dispatcher = new ProductionRunDispatcher({
    authority,
    dispatch,
    coordinator: {
      execute: (input) =>
        timings.attempt(
          input.runId,
          "execute",
          () => coordinator.execute(input),
          reportTiming,
          describeSettledRun,
        ),
      resumeToolResult: (input) =>
        timings.attempt(
          input.runId,
          "resume_tool_result",
          () => coordinator.resumeToolResult(input),
          reportTiming,
        ),
      recoverCompleted: (input) =>
        timings.attempt(
          input.runId,
          "recover_completed",
          () => coordinator.recoverCompleted(input),
          reportTiming,
        ),
      interruptExecution: (input) => coordinator.interruptExecution(input),
    },
    input: (candidate) => input.create(candidate),
    prepareToolResultRecovery,
    reconcile: createProductionRunReconciler({
      ownerId,
      agentId,
      runs: repository.runLifecycle(ownerId, agentId, fence),
      recovery: repository.runReconciliation(ownerId, agentId, fence, lease, options.instanceId),
      settleExpired: createProductionRunExpiry({
        repository,
        protector,
        clock,
        ids,
        scope: [ownerId, agentId, fence, lease, options.instanceId],
        executionLeaseDurationMs: 30_000,
      }),
      clock,
    }),
    clock,
    executionLeaseDurationMs: 30_000,
    maximumRunsPerPump: configuration.concurrency.totalRuns,
    onCapacityFreed: () => {
      loopRef?.wakeup();
    },
    instanceId: options.instanceId,
    ...(background ? { background } : {}),
  });
  const loop = new ProductionRunDispatchLoop({
    dispatcher: {
      pump: () => dispatcher.fill(),
      drain: (timeoutMs) => dispatcher.drain(timeoutMs),
      recover: (limit) => dispatcher.recover(limit),
    },
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
  loopRef = loop;
  return Object.freeze({
    input,
    admission,
    projection,
    runtime,
    coordinator,
    dispatcher,
    loop,
    titles,
    memoryCapture,
    memoryEpisodes,
    memoryConsolidation,
    background,
    inspectToolResultRecovery,
  });
}
