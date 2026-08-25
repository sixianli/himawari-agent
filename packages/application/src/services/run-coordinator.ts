import type { AgentId, IdempotencyKey, OwnerId, RunId, RunStatus } from "@himawari-agent/domain";
import type {
  AgentRuntimePort,
  AuthorityFence,
  JsonObject,
  PayloadRef,
  RuntimeEvent,
  RuntimeRequest,
  StateStorePort,
  TraceEventId,
  WorkerRunEvent,
  WorkerRunPort,
  WorkerRunRequest,
} from "../ports/index.js";
import { PORT_ERROR_CODES, ApplicationPortError } from "../ports/index.js";
import type { ContextFormationPort, ContextFormationRequest } from "./context-formation-service.js";
import type { RunStateCommitCoordinator, StoredRun } from "./run-state-commit-coordinator.js";
import type { SessionTraceRecorder } from "./session-trace-recorder.js";

type CheckpointPhase =
  | "accepted"
  | "context_formed"
  | "workers_running"
  | "runtime_running"
  | "runtime_settled"
  | "reconciling_external_result"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunCheckpoint {
  readonly phase: CheckpointPhase;
  readonly contextRef: PayloadRef | null;
  readonly workerResults: Readonly<Record<string, PayloadRef>>;
  readonly runtimeEventCount: number;
  readonly lastTraceEventId: TraceEventId | null;
  readonly terminalStatus: "completed" | "failed" | "cancelled" | null;
}

interface StoredCheckpoint {
  readonly revision: number;
  readonly checkpoint: RunCheckpoint;
}

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
  readonly context: ContextFormationRequest;
  readonly runtime: Omit<RuntimeRequest, "messageRefs">;
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

export interface RunCoordinatorDependencies {
  readonly runs: RunStateCommitCoordinator;
  readonly checkpoints: StateStorePort;
  readonly context: ContextFormationPort;
  readonly runtime: AgentRuntimePort;
  readonly workers: WorkerRunPort;
  readonly trace: SessionTraceRecorder;
}

function checkpointKey(runId: RunId): string {
  return `run-checkpoint:${runId}`;
}

function defaultCheckpoint(): RunCheckpoint {
  return Object.freeze({
    phase: "accepted",
    contextRef: null,
    workerResults: Object.freeze({}),
    runtimeEventCount: 0,
    lastTraceEventId: null,
    terminalStatus: null,
  });
}

function checkpointValue(checkpoint: RunCheckpoint): JsonObject {
  return {
    phase: checkpoint.phase,
    contextRef: checkpoint.contextRef,
    workerResults: checkpoint.workerResults,
    runtimeEventCount: checkpoint.runtimeEventCount,
    lastTraceEventId: checkpoint.lastTraceEventId,
    terminalStatus: checkpoint.terminalStatus,
  };
}

function checkpointField(value: JsonObject, field: string): unknown {
  return value[field];
}

function parseCheckpoint(value: JsonObject): RunCheckpoint {
  const phase = checkpointField(value, "phase");
  const contextRef = checkpointField(value, "contextRef");
  const workerResults = checkpointField(value, "workerResults");
  const runtimeEventCount = checkpointField(value, "runtimeEventCount");
  const lastTraceEventId = checkpointField(value, "lastTraceEventId");
  const terminalStatus = checkpointField(value, "terminalStatus");
  if (
    typeof phase !== "string" ||
    (contextRef !== null && typeof contextRef !== "string") ||
    workerResults === null ||
    typeof workerResults !== "object" ||
    Array.isArray(workerResults) ||
    typeof runtimeEventCount !== "number" ||
    !Number.isSafeInteger(runtimeEventCount) ||
    runtimeEventCount < 0 ||
    (lastTraceEventId !== null && typeof lastTraceEventId !== "string") ||
    (terminalStatus !== null && typeof terminalStatus !== "string")
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Stored Run checkpoint is invalid",
    );
  }
  const validPhases: readonly CheckpointPhase[] = [
    "accepted",
    "context_formed",
    "workers_running",
    "runtime_running",
    "runtime_settled",
    "reconciling_external_result",
    "completed",
    "failed",
    "cancelled",
  ];
  if (!validPhases.includes(phase as CheckpointPhase)) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Stored Run checkpoint phase ${phase} is invalid`,
    );
  }
  const validTerminalStatuses = ["completed", "failed", "cancelled"] as const;
  if (
    terminalStatus !== null &&
    !validTerminalStatuses.includes(terminalStatus as (typeof validTerminalStatuses)[number])
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Stored Run checkpoint terminal status ${terminalStatus} is invalid`,
    );
  }
  const parsedWorkerResults: Record<string, string> = {};
  for (const [workerRunId, resultRef] of Object.entries(workerResults)) {
    if (typeof resultRef !== "string") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Stored worker result reference is invalid",
        { workerRunId },
      );
    }
    parsedWorkerResults[workerRunId] = resultRef;
  }
  return Object.freeze({
    phase: phase as CheckpointPhase,
    contextRef,
    workerResults: Object.freeze(parsedWorkerResults),
    runtimeEventCount,
    lastTraceEventId,
    terminalStatus: terminalStatus as RunCheckpoint["terminalStatus"],
  });
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class RunCoordinator {
  private readonly dependencies: RunCoordinatorDependencies;
  private readonly activeWorkers = new Map<RunId, Set<string>>();
  private readonly cancelledRuns = new Set<RunId>();

  constructor(dependencies: RunCoordinatorDependencies) {
    this.dependencies = dependencies;
  }

  async execute(input: ExecuteCoordinatedRunInput): Promise<CoordinatedRunResult> {
    this.assertScope(input);
    const initialCheckpoint = await this.readCheckpoint(input.runId);
    const resumed = initialCheckpoint !== undefined;
    let storedCheckpoint = initialCheckpoint ?? { revision: 0, checkpoint: defaultCheckpoint() };
    let storedRun = await this.requireRun(input.runId);

    if (isTerminalStatus(storedRun.run.status)) {
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }
    if (storedRun.run.status === "accepted") {
      storedRun = await this.transition(input, storedRun, "building_context");
    }

    if (storedCheckpoint.checkpoint.contextRef === null) {
      const formed = await this.dependencies.context.form(input.context);
      storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "context_formed",
        contextRef: formed.finalContextRef,
        lastTraceEventId: formed.traceEventIds.at(-1) ?? null,
      });
    }

    if (storedRun.run.status === "building_context") {
      storedRun = await this.transition(input, storedRun, "running");
    }

    if (this.cancelledRuns.has(input.runId)) {
      storedRun = await this.transition(input, storedRun, "cancelled");
      storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "cancelled",
        terminalStatus: "cancelled",
      });
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }

    const workerOutcome = await this.runWorkers(input, storedRun, storedCheckpoint);
    storedRun = workerOutcome.run;
    storedCheckpoint = workerOutcome.checkpoint;
    if (
      isTerminalStatus(storedRun.run.status) ||
      storedRun.run.status === "reconciling_external_result"
    ) {
      return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
    }

    if (storedCheckpoint.checkpoint.terminalStatus === null) {
      storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "runtime_running",
      });
      const terminal = await this.runRuntime(input, storedCheckpoint);
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
    storedRun = await this.transition(input, storedRun, terminalStatus);
    storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
      ...storedCheckpoint.checkpoint,
      phase: terminalStatus,
    });
    return this.result(storedRun, storedCheckpoint.checkpoint, resumed);
  }

  async cancel(input: CancelCoordinatedRunInput): Promise<StoredRun> {
    this.cancelledRuns.add(input.runId);
    await this.dependencies.runtime.cancel(input.runId);
    for (const workerRunId of this.activeWorkers.get(input.runId) ?? []) {
      await this.dependencies.workers.cancel(workerRunId, input.reasonCode);
    }
    let storedRun = await this.requireRun(input.runId);
    if (!isTerminalStatus(storedRun.run.status)) {
      storedRun = await this.transitionWithCommand(
        input.ownerId,
        input.agentId,
        input.authority,
        storedRun,
        "cancelled",
        input.command,
      );
    }
    const current = (await this.readCheckpoint(input.runId)) ?? {
      revision: 0,
      checkpoint: defaultCheckpoint(),
    };
    await this.saveCheckpoint(input.runId, current, {
      ...current.checkpoint,
      phase: "cancelled",
      terminalStatus: "cancelled",
    });
    return storedRun;
  }

  private async runWorkers(
    input: ExecuteCoordinatedRunInput,
    initialRun: StoredRun,
    initialCheckpoint: StoredCheckpoint,
  ): Promise<{ readonly run: StoredRun; readonly checkpoint: StoredCheckpoint }> {
    let storedRun = initialRun;
    let storedCheckpoint = initialCheckpoint;
    const active = this.activeWorkers.get(input.runId) ?? new Set<string>();
    this.activeWorkers.set(input.runId, active);

    for (const delegation of input.workers) {
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
      storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: "workers_running",
        lastTraceEventId: delegated.event.id,
      });
      let progressCount = 0;
      let terminal: WorkerRunEvent | undefined;
      try {
        for await (const event of this.dependencies.workers.run(request)) {
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
          storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
            ...storedCheckpoint.checkpoint,
            lastTraceEventId: recorded.event.id,
          });
          if (terminal) break;
        }
      } finally {
        active.delete(request.workerRunId);
      }

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
        const recorded = await this.dependencies.trace.record({
          ...this.traceScope(input),
          parentEventId: storedCheckpoint.checkpoint.lastTraceEventId,
          causationId: delegated.event.id,
          eventType: terminal.type,
          occurredAt: terminal.occurredAt,
          payload: terminal,
        });
        storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          lastTraceEventId: recorded.event.id,
        });
      }
      if (terminal.type === "worker.completed") {
        storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          workerResults: Object.freeze({
            ...storedCheckpoint.checkpoint.workerResults,
            [request.workerRunId]: terminal.resultRef,
          }),
        });
      } else if (terminal.type === "worker.result_unknown") {
        storedRun = await this.transition(input, storedRun, "reconciling_external_result");
        storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          phase: "reconciling_external_result",
        });
        return { run: storedRun, checkpoint: storedCheckpoint };
      } else {
        const nextStatus = terminal.type === "worker.cancelled" ? "cancelled" : "failed";
        storedRun = await this.transition(input, storedRun, nextStatus);
        storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
          ...storedCheckpoint.checkpoint,
          phase: nextStatus,
          terminalStatus: nextStatus,
        });
        return { run: storedRun, checkpoint: storedCheckpoint };
      }
    }
    return { run: storedRun, checkpoint: storedCheckpoint };
  }

  private async runRuntime(
    input: ExecuteCoordinatedRunInput,
    initialCheckpoint: StoredCheckpoint,
  ): Promise<{ readonly checkpoint: StoredCheckpoint }> {
    let storedCheckpoint = initialCheckpoint;
    let observed = 0;
    const runtimeRequest: RuntimeRequest = {
      ...input.runtime,
      messageRefs: [
        storedCheckpoint.checkpoint.contextRef as PayloadRef,
        ...Object.values(storedCheckpoint.checkpoint.workerResults),
      ],
    };
    for await (const event of this.dependencies.runtime.run(runtimeRequest)) {
      if (event.runId !== input.runId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `Runtime event scope does not match Run ${input.runId}`,
          { eventRunId: event.runId, runId: input.runId },
        );
      }
      observed += 1;
      if (observed <= storedCheckpoint.checkpoint.runtimeEventCount) continue;
      const recorded = await this.dependencies.trace.record({
        ...this.traceScope(input),
        parentEventId: storedCheckpoint.checkpoint.lastTraceEventId,
        causationId: storedCheckpoint.checkpoint.lastTraceEventId,
        eventType: event.type,
        occurredAt: event.occurredAt,
        payload: event,
      });
      const terminalStatus = this.runtimeTerminalStatus(event);
      storedCheckpoint = await this.saveCheckpoint(input.runId, storedCheckpoint, {
        ...storedCheckpoint.checkpoint,
        phase: terminalStatus ? "runtime_settled" : "runtime_running",
        runtimeEventCount: observed,
        lastTraceEventId: recorded.event.id,
        terminalStatus,
      });
      if (terminalStatus) break;
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
    );
  }

  private async transitionWithCommand(
    ownerId: OwnerId,
    agentId: AgentId,
    authority: AuthorityFence,
    stored: StoredRun,
    nextStatus: Exclude<RunStatus, "accepted">,
    command: RunTransitionCommand,
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

  private async readCheckpoint(runId: RunId): Promise<StoredCheckpoint | undefined> {
    const record = await this.dependencies.checkpoints.read(checkpointKey(runId));
    if (!record) return undefined;
    return Object.freeze({ revision: record.revision, checkpoint: parseCheckpoint(record.value) });
  }

  private async saveCheckpoint(
    runId: RunId,
    current: StoredCheckpoint,
    checkpoint: RunCheckpoint,
  ): Promise<StoredCheckpoint> {
    try {
      const record = await this.dependencies.checkpoints.compareAndSet({
        key: checkpointKey(runId),
        expectedRevision: current.revision === 0 ? null : current.revision,
        value: checkpointValue(checkpoint),
      });
      return Object.freeze({ revision: record.revision, checkpoint });
    } catch (error) {
      if (error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT) {
        const latest = await this.readCheckpoint(runId);
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
