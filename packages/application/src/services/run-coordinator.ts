import type {
  AgentId,
  IdempotencyKey,
  OwnerId,
  RunExecutionLeaseId,
  RunId,
  RunStatus,
} from "@himawari-agent/domain";
import type {
  AgentRuntimePort,
  AuthorityFence,
  PayloadRef,
  RunCheckpoint,
  RunCheckpointStore,
  RunExecutionLeaseClaim,
  RunLifecyclePort,
  RuntimeEvent,
  RuntimeRequest,
  StoredRun,
  StoredRunCheckpoint,
  TraceEventId,
  WorkerRunEvent,
  WorkerRunPort,
  WorkerRunRequest,
} from "../ports/index.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/index.js";
import type { ContextFormationPort, ContextFormationRequest } from "./context-formation-service.js";
import type { SessionTraceRecorder } from "./session-trace-recorder.js";

export interface RunTransitionCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly commandFingerprint: string;
  readonly payloadRef: PayloadRef;
}

export interface RunCoordinatorCommands {
  readonly buildingContext: RunTransitionCommand;
  readonly running: RunTransitionCommand;
  readonly reconcilingExternalResult: RunTransitionCommand;
  readonly completed: RunTransitionCommand;
  readonly failed: RunTransitionCommand;
  readonly cancelled: RunTransitionCommand;
}

export interface WorkerDelegation {
  readonly request: WorkerRunRequest;
  readonly parentTraceEventId?: TraceEventId;
}

export interface ExecuteCoordinatedRunInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly authority: AuthorityFence;
  /** Execution claim supplied by the canonical dispatch pump. */
  readonly executionLease?: RunExecutionLeaseClaim;
  readonly context: ContextFormationRequest;
  readonly runtime: Omit<RuntimeRequest, "contextEnvelopeRef" | "workerResultRefs">;
  readonly workers: readonly WorkerDelegation[];
  readonly delegableCapabilityHandleRefs: readonly string[];
  readonly delegableContextRefs: readonly PayloadRef[];
  readonly commands: RunCoordinatorCommands;
}

export interface CoordinatedRunResult {
  readonly run: StoredRun;
  readonly checkpoint: RunCheckpoint;
  readonly workerResultRefs: readonly PayloadRef[];
  readonly resumed: boolean;
}

export interface CancelCoordinatedRunInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly authority: AuthorityFence;
  readonly command: RunTransitionCommand;
  readonly reasonCode: string;
}

export interface InterruptCoordinatedRunInput {
  readonly runId: RunId;
  readonly executionLeaseId: RunExecutionLeaseId;
  readonly reasonCode: string;
}

export interface ExecutionInterruptionFailure {
  readonly target: "runtime" | "worker";
  readonly workerRunId?: string;
  readonly error: unknown;
}

export interface ExecutionInterruptionResult {
  readonly runId: RunId;
  readonly executionLeaseId: RunExecutionLeaseId;
  readonly reasonCode: string;
  readonly runtimeCancellationAttempted: boolean;
  readonly workerRunIds: readonly string[];
  readonly failures: readonly ExecutionInterruptionFailure[];
}

export class RunExecutionInterruptedError extends Error {
  readonly runId: RunId;
  readonly executionLeaseId: RunExecutionLeaseId;
  readonly reasonCode: string;

  constructor(input: InterruptCoordinatedRunInput) {
    super(`Execution attempt for Run ${input.runId} was interrupted: ${input.reasonCode}`);
    this.name = "RunExecutionInterruptedError";
    this.runId = input.runId;
    this.executionLeaseId = input.executionLeaseId;
    this.reasonCode = input.reasonCode;
  }
}

export interface RunCoordinatorDependencies {
  readonly runs: RunLifecyclePort;
  readonly checkpoints: RunCheckpointStore;
  readonly context: ContextFormationPort;
  readonly runtime: AgentRuntimePort;
  readonly workers: WorkerRunPort;
  readonly trace: SessionTraceRecorder;
}

function defaultCheckpoint(): RunCheckpoint {
  return Object.freeze({
    phase: "accepted",
    contextRef: null,
    workerResults: Object.freeze({}),
    runtimeEventCount: 0,
    lastTraceEventId: null,
    terminalStatus: null,
    output: null,
    diagnosticCode: null,
  });
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

interface ExecutionAttempt {
  readonly runId: RunId;
  readonly executionLeaseId: RunExecutionLeaseId;
  readonly activeWorkerRunIds: Set<string>;
  interrupted?: InterruptCoordinatedRunInput;
  interruption?: Promise<void>;
  interruptionResult?: ExecutionInterruptionResult;
  runtimeActive: boolean;
  runtimeCancellationIssued: boolean;
  readonly cancelledWorkerRunIds: Set<string>;
}

export class RunCoordinator {
  private readonly dependencies: RunCoordinatorDependencies;
  private readonly activeWorkers = new Map<RunId, Set<string>>();
  private readonly cancelledRuns = new Set<RunId>();
  private readonly executionAttempts = new Map<RunId, ExecutionAttempt>();

  constructor(dependencies: RunCoordinatorDependencies) {
    this.dependencies = dependencies;
  }

  async execute(input: ExecuteCoordinatedRunInput): Promise<CoordinatedRunResult> {
    this.assertScope(input);
    const attempt = this.beginExecutionAttempt(input);
    try {
      return await this.executeAttempt(input, attempt);
    } finally {
      if (attempt?.interruption) await attempt.interruption;
      this.endExecutionAttempt(attempt);
    }
  }

  async interruptExecution(
    input: InterruptCoordinatedRunInput,
  ): Promise<ExecutionInterruptionResult | undefined> {
    const attempt = this.executionAttempts.get(input.runId);
    if (!attempt || attempt.executionLeaseId !== input.executionLeaseId) return undefined;
    if (attempt.interruption) {
      await attempt.interruption;
      return attempt.interruptionResult;
    }
    attempt.interrupted = Object.freeze({ ...input });
    const cancellations: Promise<void>[] = [];
    const failures: ExecutionInterruptionFailure[] = [];
    const workerRunIds = [...attempt.activeWorkerRunIds];
    if (attempt.runtimeActive && !attempt.runtimeCancellationIssued) {
      attempt.runtimeCancellationIssued = true;
      cancellations.push(
        Promise.resolve()
          .then(() => this.dependencies.runtime.cancel(input.runId))
          .catch((error: unknown) => {
            failures.push({ target: "runtime", error });
          }),
      );
    }
    for (const workerRunId of workerRunIds) {
      if (attempt.cancelledWorkerRunIds.has(workerRunId)) continue;
      attempt.cancelledWorkerRunIds.add(workerRunId);
      cancellations.push(
        Promise.resolve()
          .then(() => this.dependencies.workers.cancel(workerRunId, input.reasonCode))
          .catch((error: unknown) => {
            failures.push({ target: "worker", workerRunId, error });
          }),
      );
    }
    attempt.interruption = Promise.all(cancellations).then(() => {
      attempt.interruptionResult = Object.freeze({
        runId: input.runId,
        executionLeaseId: input.executionLeaseId,
        reasonCode: input.reasonCode,
        runtimeCancellationAttempted: attempt.runtimeCancellationIssued,
        workerRunIds: Object.freeze(workerRunIds),
        failures: Object.freeze([...failures]),
      });
      return undefined;
    });
    await attempt.interruption;
    return attempt.interruptionResult;
  }

  private beginExecutionAttempt(input: ExecuteCoordinatedRunInput): ExecutionAttempt | undefined {
    const executionLease = input.executionLease;
    if (!executionLease) return undefined;
    if (this.executionAttempts.has(input.runId)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "An execution attempt is already active for this execution lease",
        { runId: input.runId, executionLeaseId: executionLease.executionLeaseId },
      );
    }
    const attempt: ExecutionAttempt = {
      runId: input.runId,
      executionLeaseId: executionLease.executionLeaseId,
      activeWorkerRunIds: new Set(),
      runtimeActive: false,
      runtimeCancellationIssued: false,
      cancelledWorkerRunIds: new Set(),
    };
    this.executionAttempts.set(input.runId, attempt);
    return attempt;
  }

  private endExecutionAttempt(attempt: ExecutionAttempt | undefined): void {
    if (!attempt) return;
    if (this.executionAttempts.get(attempt.runId) === attempt)
      this.executionAttempts.delete(attempt.runId);
  }

  private assertExecutionActive(attempt: ExecutionAttempt | undefined): void {
    if (attempt?.interrupted) throw new RunExecutionInterruptedError(attempt.interrupted);
  }

  private async executeAttempt(
    input: ExecuteCoordinatedRunInput,
    attempt: ExecutionAttempt | undefined,
  ): Promise<CoordinatedRunResult> {
    const initialCheckpoint = await this.readCheckpoint(input.runId);
    this.assertExecutionActive(attempt);
    const resumed = initialCheckpoint !== undefined;
    let storedCheckpoint = initialCheckpoint ?? {
      runId: input.runId,
      revision: 0,
      checkpoint: defaultCheckpoint(),
    };
    let storedRun = await this.requireRun(input.runId);
    this.assertExecutionActive(attempt);
    if (
      storedRun.run.ownerId !== input.ownerId ||
      storedRun.run.agentId !== input.agentId ||
      storedRun.run.sessionId !== input.runtime.sessionId ||
      (storedRun.run.threadId ?? null) !== input.runtime.threadId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Runtime scope does not match the canonical Run",
      );

    if (isTerminalStatus(storedRun.run.status)) {
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }
    const interrupted =
      storedCheckpoint.checkpoint.phase === "runtime_running" &&
      storedCheckpoint.checkpoint.terminalStatus === null;
    const missingOutput =
      storedCheckpoint.checkpoint.terminalStatus === "completed" &&
      storedCheckpoint.checkpoint.output === null;
    if (
      interrupted ||
      missingOutput ||
      storedCheckpoint.checkpoint.phase === "reconciling_external_result"
    ) {
      this.assertExecutionActive(attempt);
      storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "reconciling_external_result",
        diagnosticCode: interrupted
          ? "RUNTIME_ATTEMPT_INTERRUPTED"
          : missingOutput
            ? "RUNTIME_COMPLETION_OUTPUT_MISSING"
            : storedCheckpoint.checkpoint.diagnosticCode,
      });
      this.assertExecutionActive(attempt);
      storedRun = await this.transition(input, storedRun, "reconciling_external_result");
      this.assertExecutionActive(attempt);
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }
    if (storedRun.run.status === "accepted") {
      this.assertExecutionActive(attempt);
      storedRun = await this.transition(input, storedRun, "building_context");
      this.assertExecutionActive(attempt);
    }

    if (storedCheckpoint.checkpoint.contextRef === null) {
      const formed = await this.dependencies.context.form(input.context);
      this.assertExecutionActive(attempt);
      storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "context_formed",
        contextRef: formed.contextEnvelopeRef,
        lastTraceEventId: formed.traceEventIds.at(-1) ?? null,
      });
      this.assertExecutionActive(attempt);
    }

    if (storedRun.run.status === "building_context") {
      this.assertExecutionActive(attempt);
      storedRun = await this.transition(input, storedRun, "running");
      this.assertExecutionActive(attempt);
    }

    if (this.cancelledRuns.has(input.runId)) {
      this.assertExecutionActive(attempt);
      storedRun = await this.transition(input, storedRun, "cancelled");
      this.assertExecutionActive(attempt);
      storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "cancelled",
        terminalStatus: "cancelled",
      });
      this.assertExecutionActive(attempt);
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }

    this.assertExecutionActive(attempt);
    const workerOutcome =
      storedCheckpoint.checkpoint.terminalStatus === null
        ? await this.runWorkers(input, storedRun, storedCheckpoint, attempt)
        : { run: storedRun, checkpoint: storedCheckpoint };
    this.assertExecutionActive(attempt);
    storedRun = workerOutcome.run;
    storedCheckpoint = workerOutcome.checkpoint;
    if (
      isTerminalStatus(storedRun.run.status) ||
      storedRun.run.status === "reconciling_external_result"
    ) {
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }

    if (storedCheckpoint.checkpoint.terminalStatus === null) {
      this.assertExecutionActive(attempt);
      storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "runtime_running",
      });
      this.assertExecutionActive(attempt);
      const terminal = await this.runRuntime(input, storedCheckpoint, attempt);
      this.assertExecutionActive(attempt);
      storedCheckpoint = terminal.checkpoint;
    }

    const terminalStatus = storedCheckpoint.checkpoint.terminalStatus;
    if (!terminalStatus) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Runtime for Run ${input.runId} ended without a terminal event`,
        { runId: input.runId },
      );
    }
    if (terminalStatus === "completed") {
      const output = storedCheckpoint.checkpoint.output;
      if (!output)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Runtime completion output is missing",
        );
      const latest = await this.requireRun(input.runId);
      this.assertExecutionActive(attempt);
      if (!isTerminalStatus(latest.run.status)) {
        const classifications = ["public", "private", "sensitive", "restricted"] as const;
        const dataClassification =
          classifications[
            Math.max(
              classifications.indexOf(input.runtime.dataClassification),
              classifications.indexOf(input.context.dataClassification),
            )
          ];
        if (!dataClassification)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "Invalid completion classification",
          );
        await this.dependencies.runs.completeRun({
          ...input.commands.completed,
          ownerId: input.ownerId,
          agentId: input.agentId,
          runId: input.runId,
          authority: input.authority,
          expectedRevision: latest.revision,
          output,
          dataClassification,
          ...(input.executionLease ? { executionLease: input.executionLease } : {}),
        });
      }
      this.assertExecutionActive(attempt);
      storedRun = await this.requireRun(input.runId);
    } else {
      this.assertExecutionActive(attempt);
      storedRun = await this.transition(input, storedRun, terminalStatus);
      this.assertExecutionActive(attempt);
    }
    this.assertExecutionActive(attempt);
    storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
      ...storedCheckpoint.checkpoint,
      phase:
        storedRun.run.status === "cancelled"
          ? "cancelled"
          : storedRun.run.status === "failed"
            ? "failed"
            : terminalStatus,
      terminalStatus:
        storedRun.run.status === "cancelled"
          ? "cancelled"
          : storedRun.run.status === "failed"
            ? "failed"
            : terminalStatus,
    });
    this.assertExecutionActive(attempt);
    return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
  }

  async cancel(input: CancelCoordinatedRunInput): Promise<StoredRun> {
    const existing = await this.requireRun(input.runId);
    if (existing.run.ownerId !== input.ownerId || existing.run.agentId !== input.agentId)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Cancellation scope does not match the canonical Run",
      );
    if (isTerminalStatus(existing.run.status)) return existing;
    await this.dependencies.runs.cancelRun({
      ownerId: input.ownerId,
      agentId: input.agentId,
      runId: input.runId,
      authority: input.authority,
      expectedRevision: existing.revision,
      idempotencyKey: input.command.idempotencyKey,
      commandFingerprint: input.command.commandFingerprint,
      payloadRef: input.command.payloadRef,
    });
    const storedRun = await this.requireRun(input.runId);
    if (storedRun.run.status !== "cancelled") return storedRun;
    this.cancelledRuns.add(input.runId);
    await this.dependencies.runtime.cancel(input.runId);
    for (const workerRunId of this.activeWorkers.get(input.runId) ?? []) {
      await this.dependencies.workers.cancel(workerRunId, input.reasonCode);
    }
    return storedRun;
  }

  private async runWorkers(
    input: ExecuteCoordinatedRunInput,
    initialRun: StoredRun,
    initialCheckpoint: StoredRunCheckpoint,
    attempt: ExecutionAttempt | undefined,
  ): Promise<{ readonly run: StoredRun; readonly checkpoint: StoredRunCheckpoint }> {
    let storedRun = initialRun;
    let storedCheckpoint = initialCheckpoint;
    const active = this.activeWorkers.get(input.runId) ?? new Set<string>();
    this.activeWorkers.set(input.runId, active);

    for (const delegation of input.workers) {
      this.assertExecutionActive(attempt);
      const request = delegation.request;
      if (storedCheckpoint.checkpoint.workerResults[request.workerRunId]) continue;
      this.assertWorkerDelegation(input, request);
      active.add(request.workerRunId);
      const delegated = await this.dependencies.trace.record({
        ...this.traceScope(input),
        parentEventId:
          delegation.parentTraceEventId ?? storedCheckpoint.checkpoint.lastTraceEventId,
        causationId: storedCheckpoint.checkpoint.lastTraceEventId,
        eventType: "worker.delegated",
        payload: request,
      });
      this.assertExecutionActive(attempt);
      storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "workers_running",
        lastTraceEventId: delegated.event.id,
      });
      this.assertExecutionActive(attempt);
      let progressCount = 0;
      let terminal: WorkerRunEvent | undefined;
      try {
        this.assertExecutionActive(attempt);
        attempt?.activeWorkerRunIds.add(request.workerRunId);
        this.assertExecutionActive(attempt);
        for await (const event of this.dependencies.workers.run(request)) {
          this.assertExecutionActive(attempt);
          if (event.workerRunId !== request.workerRunId) {
            throw new ApplicationPortError(
              PORT_ERROR_CODES.INVALID_OPERATION,
              `Worker event scope does not match ${request.workerRunId}`,
              { eventWorkerRunId: event.workerRunId, workerRunId: request.workerRunId },
            );
          }
          if (event.type === "worker.progress") {
            progressCount += 1;
            if (progressCount > request.budget.maxProgressEvents) {
              await this.dependencies.workers.cancel(request.workerRunId, "WORKER_PROGRESS_BUDGET");
              terminal = {
                type: "worker.failed",
                workerRunId: request.workerRunId,
                errorCode: "WORKER_PROGRESS_BUDGET_EXCEEDED",
                occurredAt: event.occurredAt,
              };
              break;
            }
          } else {
            terminal = event;
          }
          const recorded = await this.dependencies.trace.record({
            ...this.traceScope(input),
            parentEventId: storedCheckpoint.checkpoint.lastTraceEventId,
            causationId: delegated.event.id,
            eventType: event.type,
            occurredAt: event.occurredAt,
            payload: event,
          });
          this.assertExecutionActive(attempt);
          storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
            ...storedCheckpoint.checkpoint,
            lastTraceEventId: recorded.event.id,
          });
          this.assertExecutionActive(attempt);
          if (terminal) break;
        }
      } finally {
        attempt?.activeWorkerRunIds.delete(request.workerRunId);
        active.delete(request.workerRunId);
      }

      this.assertExecutionActive(attempt);
      if (!terminal) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `Worker ${request.workerRunId} ended without a terminal event`,
        );
      }
      if (
        terminal.type === "worker.completed" &&
        (terminal.costMicros > request.budget.maxCostMicros ||
          terminal.durationMs > request.budget.maxDurationMs)
      ) {
        terminal = {
          type: "worker.failed",
          workerRunId: request.workerRunId,
          errorCode: "WORKER_BUDGET_EXCEEDED",
          occurredAt: terminal.occurredAt,
        };
      }
      if (
        terminal.type === "worker.failed" &&
        (terminal.errorCode === "WORKER_PROGRESS_BUDGET_EXCEEDED" ||
          terminal.errorCode === "WORKER_BUDGET_EXCEEDED")
      ) {
        this.assertExecutionActive(attempt);
        const recorded = await this.dependencies.trace.record({
          ...this.traceScope(input),
          parentEventId: storedCheckpoint.checkpoint.lastTraceEventId,
          causationId: delegated.event.id,
          eventType: terminal.type,
          occurredAt: terminal.occurredAt,
          payload: terminal,
        });
        this.assertExecutionActive(attempt);
        storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          lastTraceEventId: recorded.event.id,
        });
        this.assertExecutionActive(attempt);
      }
      if (terminal.type === "worker.completed") {
        this.assertExecutionActive(attempt);
        storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          workerResults: Object.freeze({
            ...storedCheckpoint.checkpoint.workerResults,
            [request.workerRunId]: terminal.resultRef,
          }),
        });
        this.assertExecutionActive(attempt);
      } else if (terminal.type === "worker.result_unknown") {
        this.assertExecutionActive(attempt);
        storedRun = await this.transition(input, storedRun, "reconciling_external_result");
        this.assertExecutionActive(attempt);
        storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          phase: "reconciling_external_result",
        });
        this.assertExecutionActive(attempt);
        return { run: storedRun, checkpoint: storedCheckpoint };
      } else {
        const nextStatus = terminal.type === "worker.cancelled" ? "cancelled" : "failed";
        this.assertExecutionActive(attempt);
        storedRun = await this.transition(input, storedRun, nextStatus);
        this.assertExecutionActive(attempt);
        storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          phase: nextStatus,
          terminalStatus: nextStatus,
        });
        this.assertExecutionActive(attempt);
        return { run: storedRun, checkpoint: storedCheckpoint };
      }
    }
    return { run: storedRun, checkpoint: storedCheckpoint };
  }

  private async runRuntime(
    input: ExecuteCoordinatedRunInput,
    initialCheckpoint: StoredRunCheckpoint,
    attempt: ExecutionAttempt | undefined,
  ): Promise<{ readonly checkpoint: StoredRunCheckpoint }> {
    let storedCheckpoint = initialCheckpoint;
    let observed = 0;
    const runtimeRequest: RuntimeRequest = {
      ...input.runtime,
      contextEnvelopeRef: storedCheckpoint.checkpoint.contextRef as PayloadRef,
      workerResultRefs: Object.entries(storedCheckpoint.checkpoint.workerResults).map(
        ([workerRunId, resultRef]) => ({ workerRunId, resultRef }),
      ),
    };
    this.assertExecutionActive(attempt);
    if (attempt) attempt.runtimeActive = true;
    try {
      this.assertExecutionActive(attempt);
      for await (const event of this.dependencies.runtime.run(runtimeRequest)) {
        this.assertExecutionActive(attempt);
        if (event.runId !== input.runId) {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            `Runtime event scope does not match Run ${input.runId}`,
            { eventRunId: event.runId, runId: input.runId },
          );
        }
        observed += 1;
        const recorded = await this.dependencies.trace.record({
          ...this.traceScope(input),
          parentEventId: storedCheckpoint.checkpoint.lastTraceEventId,
          causationId: storedCheckpoint.checkpoint.lastTraceEventId,
          eventType: event.type,
          occurredAt: event.occurredAt,
          payload: event,
        });
        this.assertExecutionActive(attempt);
        const invalidOutput =
          event.type === "runtime.completed" &&
          (event.output.kind === "no-answer"
            ? input.runtime.threadId !== null
            : event.output.contentRef.trim().length === 0);
        const terminalStatus = invalidOutput ? "failed" : this.runtimeTerminalStatus(event);
        storedCheckpoint = await this.saveCheckpoint(input, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          phase: terminalStatus ? "runtime_settled" : "runtime_running",
          runtimeEventCount: observed,
          lastTraceEventId: recorded.event.id,
          terminalStatus,
          output: event.type === "runtime.completed" && !invalidOutput ? event.output : null,
          diagnosticCode: invalidOutput
            ? "RUNTIME_FINAL_ANSWER_INVALID"
            : event.type === "runtime.failed"
              ? event.errorCode
              : null,
        });
        this.assertExecutionActive(attempt);
        if (terminalStatus) break;
      }
    } finally {
      if (attempt) attempt.runtimeActive = false;
    }
    return { checkpoint: storedCheckpoint };
  }

  private runtimeTerminalStatus(event: RuntimeEvent): RunCheckpoint["terminalStatus"] {
    if (event.type === "runtime.completed") return "completed";
    if (event.type === "runtime.cancelled") return "cancelled";
    if (event.type === "runtime.failed") return "failed";
    return null;
  }

  private assertScope(input: ExecuteCoordinatedRunInput): void {
    const matches =
      input.context.ownerId === input.ownerId &&
      input.context.agentId === input.agentId &&
      input.context.runId === input.runId &&
      input.runtime.ownerId === input.ownerId &&
      input.runtime.agentId === input.agentId &&
      input.runtime.runId === input.runId &&
      input.runtime.sessionId === input.context.sessionId &&
      input.runtime.threadId === input.context.threadId;
    if (!matches) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Run Coordinator input scopes do not match",
        { runId: input.runId },
      );
    }
  }

  private assertWorkerDelegation(
    input: ExecuteCoordinatedRunInput,
    worker: WorkerRunRequest,
  ): void {
    const budgetValues = [
      worker.budget.maxDurationMs,
      worker.budget.maxCostMicros,
      worker.budget.maxProgressEvents,
    ];
    const validBudget = budgetValues.every((value) => Number.isSafeInteger(value) && value >= 0);
    const allowedHandles = new Set(input.delegableCapabilityHandleRefs);
    const allowedContext = new Set([
      ...input.delegableContextRefs,
      ...input.context.threadMessages.map(({ payloadRef }) => payloadRef),
      input.context.trigger.payloadRef,
    ]);
    const valid =
      worker.ownerId === input.ownerId &&
      worker.agentId === input.agentId &&
      worker.parentRunId === input.runId &&
      worker.capabilityHandleRefs.every((ref) => allowedHandles.has(ref)) &&
      worker.delegatedContextRefs.every((ref) => allowedContext.has(ref)) &&
      worker.secretRefs.length === 0 &&
      worker.allowedModelRefs.includes(worker.selectedModelRef) &&
      validBudget &&
      !Number.isNaN(Date.parse(worker.deadlineAt));
    if (!valid) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Worker ${worker.workerRunId} exceeds its explicit delegation`,
        { workerRunId: worker.workerRunId, runId: input.runId },
      );
    }
  }

  private async transition(
    input: ExecuteCoordinatedRunInput,
    stored: StoredRun,
    nextStatus: Exclude<RunStatus, "accepted">,
  ): Promise<StoredRun> {
    if (stored.run.status === nextStatus) return stored;
    let command: RunTransitionCommand;
    switch (nextStatus) {
      case "building_context":
        command = input.commands.buildingContext;
        break;
      case "running":
        command = input.commands.running;
        break;
      case "reconciling_external_result":
        command = input.commands.reconcilingExternalResult;
        break;
      case "completed":
        command = input.commands.completed;
        break;
      case "failed":
        command = input.commands.failed;
        break;
      case "cancelled":
        command = input.commands.cancelled;
        break;
      case "awaiting_approval":
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Run Coordinator does not enter awaiting_approval without an approval service",
        );
    }
    return this.transitionWithCommand(
      input.ownerId,
      input.agentId,
      input.authority,
      stored,
      nextStatus,
      command,
      input.executionLease,
    );
  }

  private async transitionWithCommand(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: AuthorityFence,
    stored: StoredRun,
    nextStatus: Exclude<RunStatus, "accepted">,
    command: RunTransitionCommand,
    executionLease?: RunExecutionLeaseClaim,
  ): Promise<StoredRun> {
    const latest = await this.requireRun(stored.run.id);
    if (latest.run.status === nextStatus) return latest;
    if (isTerminalStatus(latest.run.status)) return latest;
    await this.dependencies.runs.transitionRun({
      runId: latest.run.id,
      ownerId,
      agentId,
      expectedRevision: latest.revision,
      nextStatus,
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: command.commandFingerprint,
      authority,
      payloadRef: command.payloadRef,
      ...(executionLease ? { executionLease } : {}),
    });
    return this.requireRun(latest.run.id);
  }

  private async requireRun(runId: RunId): Promise<StoredRun> {
    const stored = await this.dependencies.runs.readRun(runId);
    if (!stored) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Run ${runId} not found`, {
        runId,
      });
    }
    return stored;
  }

  private async readCheckpoint(runId: RunId): Promise<StoredRunCheckpoint | undefined> {
    return this.dependencies.checkpoints.read(runId);
  }

  private async saveCheckpoint(
    input: ExecuteCoordinatedRunInput,
    current: StoredRunCheckpoint,
    checkpoint: RunCheckpoint,
  ): Promise<StoredRunCheckpoint> {
    try {
      const record = await this.dependencies.checkpoints.compareAndSet({
        runId: input.runId,
        expectedRevision: current.revision === 0 ? null : current.revision,
        checkpoint,
        ...(input.executionLease ? { executionLease: input.executionLease } : {}),
      });
      return record;
    } catch (error) {
      if (error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT) {
        const latest = await this.readCheckpoint(input.runId);
        if (latest && latest.checkpoint.terminalStatus !== null) return latest;
      }
      throw error;
    }
  }

  private traceScope(input: ExecuteCoordinatedRunInput) {
    return {
      ownerId: input.ownerId,
      agentId: input.agentId,
      sessionId: input.context.sessionId,
      threadId: input.context.threadId,
      runId: input.runId,
      turnId: null,
      correlationId: input.context.correlationId,
      actorId: input.context.actorId,
      dataClassification: input.context.dataClassification,
    };
  }

  private result(
    run: StoredRun,
    checkpoint: RunCheckpoint,
    resumed: boolean,
  ): CoordinatedRunResult {
    return Object.freeze({
      run,
      checkpoint,
      workerResultRefs: Object.freeze(Object.values(checkpoint.workerResults)),
      resumed,
    });
  }
}
