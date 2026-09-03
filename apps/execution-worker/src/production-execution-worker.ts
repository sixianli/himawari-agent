import type {
  ExecutionTransportPort,
  ExecutionWorkerEvent,
  ExecutionWorkerService,
  CapabilityExecutionHandle,
} from "@himawari-agent/application";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_V2_SCHEMA_VERSION,
  type DelegatedCapabilityHandleV2,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
  type ResourceCeiling,
} from "@himawari-agent/execution-contracts";

export const PRODUCTION_WORKER_ERROR_CODES = Object.freeze({
  ADAPTER_NOT_REGISTERED: "WORKER_ADAPTER_NOT_REGISTERED",
  BOOT_TOKEN_REJECTED: "WORKER_BOOT_TOKEN_REJECTED",
  DUPLICATE_CONFLICT: "WORKER_DUPLICATE_CONFLICT",
  HANDSHAKE_REQUIRED: "WORKER_HANDSHAKE_REQUIRED",
  NOT_READY: "WORKER_NOT_READY",
  RESOURCE_CEILING_EXCEEDED: "WORKER_RESOURCE_CEILING_EXCEEDED",
  SCHEMA_UNSUPPORTED: "WORKER_SCHEMA_UNSUPPORTED",
  STALE_FENCE: "WORKER_STALE_FENCE",
  DELEGATION_INVALID: "WORKER_DELEGATION_INVALID",
  DELEGATION_REQUIRED: "WORKER_DELEGATION_REQUIRED",
  DEADLINE_EXPIRED: "WORKER_DEADLINE_EXPIRED",
  SUBTASK_NOT_ACTIVE: "WORKER_SUBTASK_NOT_ACTIVE",
} as const);

type ProductionWorkerErrorCode =
  (typeof PRODUCTION_WORKER_ERROR_CODES)[keyof typeof PRODUCTION_WORKER_ERROR_CODES];

export class ProductionExecutionWorkerError extends Error {
  readonly code: ProductionWorkerErrorCode;

  constructor(code: ProductionWorkerErrorCode) {
    super(code);
    this.name = "ProductionExecutionWorkerError";
    this.code = code;
  }
}

export interface RegisteredWorkerAdapter {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly operations: readonly string[];
}

export interface ProductionExecutionWorkerOptions {
  readonly service: ExecutionWorkerService;
  readonly workerInstanceId: string;
  readonly workerBootId: string;
  readonly bootTokenRef: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly maximumResourceCeiling: ResourceCeiling;
  readonly adapters: readonly RegisteredWorkerAdapter[];
  readonly hostOperations?: RegisteredHostOperationAdapter;
  readonly subtasks?: RegisteredWorkerSubtaskAdapter;
  readonly delegations?: {
    accept(handle: DelegatedCapabilityHandleV2): unknown;
    getExecutionHandle(handleRef: string): Promise<CapabilityExecutionHandle | undefined>;
    clear(): void;
  };
  readonly now: () => string;
  readonly nextId: (scope: string) => string;
}

type HandshakeRequest = Extract<ExecutionV2Request, { type: "worker.handshake" }>;
type ReadinessRequest = Extract<ExecutionV2Request, { type: "worker.readiness.query" }>;
type DelegateRequest = Extract<ExecutionV2Request, { type: "work.delegate" }>;
type ExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;
type CancelRequest = Extract<ExecutionV2Request, { type: "work.cancel" }>;
type ReconcileRequest = Extract<ExecutionV2Request, { type: "work.reconcile" }>;
type HostOperationRequest = Extract<ExecutionV2Request, { type: "host.operation.execute" }>;
type WorkerSubtaskRequest = Extract<ExecutionV2Request, { type: "worker.subtask.execute" }>;

export interface RegisteredHostOperationAdapter {
  readonly operations: readonly HostOperationRequest["payload"]["operation"][];
  execute(request: HostOperationRequest): Promise<{
    readonly outcome: "succeeded" | "failed" | "result_unknown";
    readonly outputRef: string | null;
    readonly errorCode: string | null;
    readonly fileObservationRefs: readonly string[];
    readonly networkObservationRefs: readonly string[];
  }>;
}

export interface RegisteredWorkerSubtaskAdapter {
  readonly allowedModelRefs: readonly string[];
  readonly maximumCostMicros: number;
  readonly maximumDurationMs: number;
  execute(
    request: WorkerSubtaskRequest,
    context: WorkerSubtaskExecutionContext,
  ): Promise<{
    readonly workerResultRef: string;
    readonly actualModelRef: string;
    readonly actualCostMicros: number;
    readonly durationMs: number;
  }>;
}

export interface WorkerSubtaskExecutionContext {
  readonly signal: AbortSignal;
  executeCapability(input: {
    readonly invocationId: string;
    readonly capabilityId: string;
    readonly capabilityVersion: string;
    readonly operation: string;
    readonly inputRef: string;
    readonly capabilityHandleRef: string;
    readonly delegatedContextRefs: readonly string[];
  }): AsyncIterable<ExecutionWorkerEvent>;
}

function withinCeiling(requested: ResourceCeiling, maximum: ResourceCeiling): boolean {
  return (
    requested.maxWallTimeMs <= maximum.maxWallTimeMs &&
    requested.maxCpuTimeMs <= maximum.maxCpuTimeMs &&
    requested.maxMemoryBytes <= maximum.maxMemoryBytes &&
    requested.maxOutputBytes <= maximum.maxOutputBytes &&
    requested.maxProgressEvents <= maximum.maxProgressEvents
  );
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(error.code)
  ) {
    return error.code;
  }
  return "WORKER_EXECUTION_FAILED";
}

export class ProductionExecutionWorker implements ExecutionTransportPort {
  private readonly options: ProductionExecutionWorkerOptions;
  private readonly eventsByCursor: ExecutionV2Event[] = [];
  private readonly requestFingerprints = new Map<string, string>();
  private readonly idempotencyFingerprints = new Map<string, string>();
  private readonly active = new Set<Promise<void>>();
  private readonly sequenceByRequest = new Map<string, number>();
  private handshakeAgentInstanceId: string | null = null;
  private ready = true;
  private cursorSequence = 0;
  private readonly activeSubtasks = new Map<
    string,
    { readonly request: WorkerSubtaskRequest; readonly controller: AbortController }
  >();

  constructor(options: ProductionExecutionWorkerOptions) {
    this.options = options;
  }

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    const parsed = executionV2MessageSchema.parse(message);
    if (parsed.kind !== "request") {
      throw new TypeError("Execution Worker accepts request messages only");
    }
    if (parsed.type === "worker.handshake") return this.handshake(parsed);
    if (parsed.type === "worker.readiness.query") return this.readiness(parsed);
    this.assertReadyAndAuthoritative(parsed);
    if (parsed.type === "work.events.replay") return null;
    if (parsed.type === "work.execute") {
      await this.assertExecutable(parsed);
      if (this.isReplay(parsed)) return null;
      this.track(this.execute(parsed));
      return null;
    }
    if (parsed.type === "host.operation.execute") {
      if (this.isReplay(parsed, false)) return null;
      this.assertDeadline(parsed.payload.deadlineAt);
      if (
        !this.options.hostOperations ||
        !this.options.hostOperations.operations.includes(parsed.payload.operation)
      ) {
        throw new ProductionExecutionWorkerError(
          PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED,
        );
      }
      if (this.isReplay(parsed)) return null;
      this.track(this.executeHostOperation(parsed));
      return null;
    }
    if (parsed.type === "worker.subtask.execute") {
      if (this.isReplay(parsed, false)) return null;
      try {
        await this.assertSubtaskExecutable(parsed);
      } catch (error) {
        this.assertReadyAndAuthoritative(parsed);
        if (this.isReplay(parsed, false)) return null;
        throw error;
      }
      this.assertReadyAndAuthoritative(parsed);
      if (this.isReplay(parsed, false)) return null;
      if (this.activeSubtasks.has(parsed.scope.workerRunId as string))
        throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DUPLICATE_CONFLICT);
      if (this.isReplay(parsed)) return null;
      this.track(this.executeSubtask(parsed));
      return null;
    }
    if (this.isReplay(parsed)) return null;
    if (parsed.type === "work.delegate") return this.delegate(parsed);
    if (parsed.type === "work.cancel") {
      this.track(this.cancel(parsed));
      return null;
    }
    if (parsed.type !== "work.reconcile") {
      throw new ProductionExecutionWorkerError(
        PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED,
      );
    }
    this.track(this.reconcile(parsed));
    return null;
  }

  async *events(afterCursor: string | null): AsyncIterable<ExecutionV2Event> {
    let start = 0;
    if (afterCursor !== null) {
      const index = this.eventsByCursor.findIndex(
        (event) => "cursor" in event.payload && event.payload.cursor === afterCursor,
      );
      if (index < 0) throw new Error("WORKER_CURSOR_NOT_FOUND");
      start = index + 1;
    }
    for (const event of this.eventsByCursor.slice(start)) yield event;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  async shutdown(): Promise<void> {
    this.ready = false;
    for (const { controller } of this.activeSubtasks.values()) controller.abort();
    await this.waitForIdle();
    this.options.delegations?.clear();
    this.handshakeAgentInstanceId = null;
  }

  private handshake(
    request: HandshakeRequest,
  ): Extract<ExecutionV2Response, { type: "worker.handshake.accepted" }> {
    this.assertAuthority(request);
    if (request.payload.bootTokenRef !== this.options.bootTokenRef) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.BOOT_TOKEN_REJECTED);
    }
    if (!request.payload.supportedSchemaVersions.includes(EXECUTION_V2_SCHEMA_VERSION)) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.SCHEMA_UNSUPPORTED);
    }
    this.handshakeAgentInstanceId = request.payload.agentServiceInstanceId;
    return executionV2MessageSchema.parse({
      ...this.responseEnvelope(request, "worker.handshake.accepted"),
      payload: {
        workerInstanceId: this.options.workerInstanceId,
        workerBootId: this.options.workerBootId,
        selectedSchemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        ready: this.ready,
        acceptedAt: this.options.now(),
      },
    }) as Extract<ExecutionV2Response, { type: "worker.handshake.accepted" }>;
  }

  private readiness(
    request: ReadinessRequest,
  ): Extract<ExecutionV2Response, { type: "worker.readiness.snapshot" }> {
    this.assertAuthority(request);
    return executionV2MessageSchema.parse({
      ...this.responseEnvelope(request, "worker.readiness.snapshot"),
      payload: {
        workerInstanceId: this.options.workerInstanceId,
        live: true,
        ready: this.ready && this.handshakeAgentInstanceId !== null,
        supportedSchemaVersions: [EXECUTION_V2_SCHEMA_VERSION],
        reasonCodes:
          this.ready && this.handshakeAgentInstanceId !== null ? [] : ["WORKER_HANDSHAKE_REQUIRED"],
        observedAt: this.options.now(),
      },
    }) as Extract<ExecutionV2Response, { type: "worker.readiness.snapshot" }>;
  }

  private assertReadyAndAuthoritative(request: ExecutionV2Request): void {
    if (!this.ready) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.NOT_READY);
    }
    if (this.handshakeAgentInstanceId === null) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.HANDSHAKE_REQUIRED);
    }
    this.assertAuthority(request);
  }

  private assertAuthority(request: ExecutionV2Request): void {
    if (
      request.scope.deploymentId !== this.options.deploymentId ||
      request.scope.authorityEpoch !== this.options.authorityEpoch ||
      request.scope.fencingToken !== this.options.fencingToken
    ) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.STALE_FENCE);
    }
  }

  private delegate(
    request: DelegateRequest,
  ): Extract<ExecutionV2Response, { type: "work.delegate.accepted" }> {
    const handle = request.payload.handle;
    if (
      handle.authorityFence !== request.scope.fencingToken ||
      handle.ownerId !== request.scope.ownerId ||
      handle.agentId !== request.scope.agentId ||
      handle.runId !== request.scope.runId ||
      handle.authorizationRef !== request.authorizationRef ||
      handle.maxDataClassification !== request.dataClassification
    ) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DELEGATION_INVALID);
    }
    if (!this.options.delegations) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DELEGATION_REQUIRED);
    }
    this.options.delegations.accept(handle);
    return executionV2MessageSchema.parse({
      ...this.responseEnvelope(request, "work.delegate.accepted"),
      payload: {
        handleRef: handle.ref,
        workerBootId: this.options.workerBootId,
        acceptedAt: this.options.now(),
      },
    }) as Extract<ExecutionV2Response, { type: "work.delegate.accepted" }>;
  }

  private async assertExecutable(request: ExecuteRequest): Promise<void> {
    if (!withinCeiling(request.payload.resourceCeiling, this.options.maximumResourceCeiling)) {
      throw new ProductionExecutionWorkerError(
        PRODUCTION_WORKER_ERROR_CODES.RESOURCE_CEILING_EXCEEDED,
      );
    }
    const registered = this.options.adapters.some(
      (adapter) =>
        adapter.capabilityId === request.payload.capabilityId &&
        adapter.capabilityVersion === request.payload.capabilityVersion &&
        adapter.operations.includes(request.payload.operation),
    );
    if (!registered) {
      throw new ProductionExecutionWorkerError(
        PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED,
      );
    }
    if (
      this.options.delegations &&
      !(await this.options.delegations.getExecutionHandle(request.payload.capabilityHandleRef))
    ) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DELEGATION_REQUIRED);
    }
  }

  private async assertSubtaskExecutable(request: WorkerSubtaskRequest): Promise<void> {
    this.assertDeadline(request.payload.deadlineAt);
    const adapter = this.options.subtasks;
    if (
      !adapter ||
      !adapter.allowedModelRefs.includes(request.payload.selectedModelRef) ||
      !request.payload.allowedModelRefs.every((model) =>
        adapter.allowedModelRefs.includes(model),
      ) ||
      request.payload.maximumCostMicros > adapter.maximumCostMicros ||
      request.payload.maximumDurationMs > adapter.maximumDurationMs ||
      request.payload.maximumDurationMs > this.options.maximumResourceCeiling.maxWallTimeMs ||
      request.payload.maximumProgressEvents > this.options.maximumResourceCeiling.maxProgressEvents
    )
      throw new ProductionExecutionWorkerError(
        PRODUCTION_WORKER_ERROR_CODES.RESOURCE_CEILING_EXCEEDED,
      );
    if (!this.options.delegations)
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DELEGATION_REQUIRED);
    await this.options.service.assertSubtaskDelegation({
      scope: {
        ownerId: request.scope.ownerId as string,
        agentId: request.scope.agentId as string,
        runId: request.scope.runId as string,
        workerRunId: request.scope.workerRunId as string,
      },
      dataClassification: request.dataClassification,
      capabilityHandleRefs: request.payload.capabilityHandleRefs,
      deadlineAt: request.payload.deadlineAt,
      authorityFence: request.scope.fencingToken,
    });
  }

  private assertDeadline(deadlineAt: string): void {
    if (this.options.now() >= deadlineAt)
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DEADLINE_EXPIRED);
  }

  private isReplay(
    request: Exclude<
      ExecutionV2Request,
      | HandshakeRequest
      | ReadinessRequest
      | Extract<ExecutionV2Request, { type: "work.events.replay" }>
    >,
    record = true,
  ): boolean {
    const fingerprint = executionV2MessageSchema.serialize(request);
    const byMessage = this.requestFingerprints.get(request.messageId);
    const byIdempotency = this.idempotencyFingerprints.get(request.idempotencyKey);
    if (
      (byMessage !== undefined && byMessage !== fingerprint) ||
      (byIdempotency !== undefined && byIdempotency !== fingerprint)
    ) {
      throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DUPLICATE_CONFLICT);
    }
    if (byMessage !== undefined || byIdempotency !== undefined) return true;
    if (record) {
      this.requestFingerprints.set(request.messageId, fingerprint);
      this.idempotencyFingerprints.set(request.idempotencyKey, fingerprint);
    }
    return false;
  }

  private track(operation: Promise<void>): void {
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation));
  }

  private async execute(request: ExecuteRequest): Promise<void> {
    const v1Request = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      kind: "request" as const,
      type: "work.execute" as const,
      messageId: request.messageId,
      correlationId: request.correlationId,
      causationId: request.causationId ?? request.messageId,
      dataClassification: request.dataClassification,
      scope: {
        ownerId: request.scope.ownerId as string,
        agentId: request.scope.agentId as string,
        runId: request.scope.runId as string,
        workerRunId: request.scope.workerRunId as string,
      },
      idempotencyKey: request.idempotencyKey,
      payload: {
        capabilityId: request.payload.capabilityId,
        capabilityVersion: request.payload.capabilityVersion,
        operation: request.payload.operation,
        inputRef: request.payload.inputRef,
        capabilityHandleRef: request.payload.capabilityHandleRef,
        delegatedContextRefs: request.payload.delegatedContextRefs,
        secretRefs: request.payload.secretRefs,
        requestedAt: request.payload.requestedAt,
        deadlineAt: request.payload.deadlineAt,
      },
    };
    let progressEvents = 0;
    const iterator = this.options.service
      .execute(v1Request, request.payload.resourceCeiling)
      [Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), request.payload.resourceCeiling.maxWallTimeMs);
      timer.unref();
    });
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next === "timeout") {
          await this.options.service.cancel({
            ...v1Request,
            type: "work.cancel",
            messageId: this.options.nextId("worker-timeout-cancel"),
            idempotencyKey: `${request.idempotencyKey}:timeout`,
            payload: {
              targetRequestId: request.messageId,
              reasonCode: "WORKER_WALL_TIME_EXCEEDED",
              requestedAt: this.options.now(),
            },
          });
          this.appendFailure(request, "WORKER_WALL_TIME_EXCEEDED");
          return;
        }
        if (next.done) return;
        if (next.value.type === "work.progress") {
          progressEvents += 1;
          if (progressEvents > request.payload.resourceCeiling.maxProgressEvents) {
            await this.options.service.cancel({
              ...v1Request,
              type: "work.cancel",
              messageId: this.options.nextId("worker-progress-cancel"),
              idempotencyKey: `${request.idempotencyKey}:progress-limit`,
              payload: {
                targetRequestId: request.messageId,
                reasonCode: "WORKER_PROGRESS_LIMIT_EXCEEDED",
                requestedAt: this.options.now(),
              },
            });
            this.appendFailure(request, "WORKER_PROGRESS_LIMIT_EXCEEDED");
            return;
          }
        }
        this.appendMappedEvent(request, next.value);
      }
    } catch (error) {
      this.appendFailure(request, errorCode(error));
    } finally {
      if (timer) clearTimeout(timer);
      await iterator.return?.();
    }
  }

  private async cancel(request: CancelRequest): Promise<void> {
    try {
      const active = this.activeSubtasks.get(request.scope.workerRunId as string);
      if (active && active.request.messageId === request.payload.targetRequestId) {
        if (
          active.request.scope.ownerId !== request.scope.ownerId ||
          active.request.scope.agentId !== request.scope.agentId ||
          active.request.scope.runId !== request.scope.runId
        )
          throw new ProductionExecutionWorkerError(
            PRODUCTION_WORKER_ERROR_CODES.DELEGATION_INVALID,
          );
        active.controller.abort("WORKER_SUBTASK_CANCELLED");
      }
      const event = await this.options.service.cancel({
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        kind: "request",
        type: "work.cancel",
        messageId: request.messageId,
        correlationId: request.correlationId,
        causationId: request.causationId ?? request.messageId,
        dataClassification: request.dataClassification,
        scope: {
          ownerId: request.scope.ownerId as string,
          agentId: request.scope.agentId as string,
          runId: request.scope.runId as string,
          workerRunId: request.scope.workerRunId as string,
        },
        idempotencyKey: request.idempotencyKey,
        payload: request.payload,
      });
      this.appendMappedEvent(request, event);
    } catch (error) {
      this.appendFailure(request, errorCode(error));
    }
  }

  private async executeHostOperation(request: HostOperationRequest): Promise<void> {
    try {
      this.assertDeadline(request.payload.deadlineAt);
      const adapter = this.options.hostOperations;
      if (!adapter) throw new Error(PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED);
      const result = await adapter.execute(request);
      const event = executionV2MessageSchema.parse({
        schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        kind: "event",
        type: "host.operation.result",
        messageId: this.options.nextId("host-operation-result"),
        correlationId: request.correlationId,
        causationId: request.messageId,
        dataClassification: request.dataClassification,
        risk: request.risk,
        authorizationRef: request.authorizationRef,
        scope: request.scope,
        payload: {
          requestId: request.messageId,
          operation: request.payload.operation,
          cursor: this.nextCursor(),
          sequence: this.nextSequence(request.messageId),
          ...result,
          completedAt: this.options.now(),
        },
      });
      if (event.kind !== "event") throw new TypeError("Worker produced a non-event message");
      this.eventsByCursor.push(event);
    } catch (error) {
      const event = executionV2MessageSchema.parse({
        schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        kind: "event",
        type: "host.operation.result",
        messageId: this.options.nextId("host-operation-result"),
        correlationId: request.correlationId,
        causationId: request.messageId,
        dataClassification: request.dataClassification,
        risk: request.risk,
        authorizationRef: request.authorizationRef,
        scope: request.scope,
        payload: {
          requestId: request.messageId,
          operation: request.payload.operation,
          cursor: this.nextCursor(),
          sequence: this.nextSequence(request.messageId),
          outcome: "failed",
          outputRef: null,
          errorCode: errorCode(error),
          fileObservationRefs: [],
          networkObservationRefs: [],
          completedAt: this.options.now(),
        },
      });
      if (event.kind !== "event") throw new TypeError("Worker produced a non-event message");
      this.eventsByCursor.push(event);
    }
  }

  private async executeSubtask(request: WorkerSubtaskRequest): Promise<void> {
    const controller = new AbortController();
    const workerRunId = request.scope.workerRunId as string;
    this.activeSubtasks.set(workerRunId, { request, controller });
    const remainingMs = Math.min(
      request.payload.maximumDurationMs,
      Date.parse(request.payload.deadlineAt) - Date.parse(this.options.now()),
    );
    const timer = setTimeout(() => controller.abort(), Math.max(0, remainingMs));
    timer.unref();
    try {
      const adapter = this.options.subtasks;
      if (!adapter) throw new Error(PRODUCTION_WORKER_ERROR_CODES.ADAPTER_NOT_REGISTERED);
      this.assertReadyAndAuthoritative(request);
      this.assertDeadline(request.payload.deadlineAt);
      const cancelled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DEADLINE_EXPIRED),
            ),
          { once: true },
        );
      });
      const result = await Promise.race([
        adapter.execute(request, this.subtaskContext(request, controller)),
        cancelled,
      ]);
      if (controller.signal.aborted)
        throw new ProductionExecutionWorkerError(PRODUCTION_WORKER_ERROR_CODES.DEADLINE_EXPIRED);
      this.assertDeadline(request.payload.deadlineAt);
      if (
        result.actualModelRef !== request.payload.selectedModelRef ||
        result.actualCostMicros > request.payload.maximumCostMicros ||
        result.durationMs > request.payload.maximumDurationMs
      )
        throw new Error(PRODUCTION_WORKER_ERROR_CODES.RESOURCE_CEILING_EXCEEDED);
      this.appendSubtaskResult(request, {
        outcome: "succeeded",
        workerResultRef: result.workerResultRef,
        errorCode: null,
        actualModelRef: result.actualModelRef,
        actualCostMicros: result.actualCostMicros,
        durationMs: result.durationMs,
      });
    } catch (error) {
      this.appendSubtaskResult(request, {
        outcome: controller.signal.reason === "WORKER_SUBTASK_CANCELLED" ? "cancelled" : "failed",
        workerResultRef: null,
        errorCode:
          controller.signal.reason === "WORKER_SUBTASK_CANCELLED"
            ? "WORKER_SUBTASK_CANCELLED"
            : errorCode(error),
        actualModelRef: null,
        actualCostMicros: 0,
        durationMs: 0,
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (this.activeSubtasks.get(workerRunId)?.controller === controller)
        this.activeSubtasks.delete(workerRunId);
    }
  }

  private subtaskContext(
    request: WorkerSubtaskRequest,
    controller: AbortController,
  ): WorkerSubtaskExecutionContext {
    const worker = this;
    let progressEvents = 0;
    const invocations = new Set<string>();
    return Object.freeze({
      signal: controller.signal,
      async *executeCapability(
        input: Parameters<WorkerSubtaskExecutionContext["executeCapability"]>[0],
      ) {
        const assertActive = () => {
          worker.assertReadyAndAuthoritative(request);
          worker.assertDeadline(request.payload.deadlineAt);
          if (
            controller.signal.aborted ||
            worker.activeSubtasks.get(request.scope.workerRunId as string)?.controller !==
              controller
          )
            throw new ProductionExecutionWorkerError(
              PRODUCTION_WORKER_ERROR_CODES.SUBTASK_NOT_ACTIVE,
            );
          if (
            !request.payload.capabilityHandleRefs.includes(input.capabilityHandleRef) ||
            !input.delegatedContextRefs.every((ref) =>
              request.payload.delegatedContextRefs.includes(ref),
            )
          )
            throw new ProductionExecutionWorkerError(
              PRODUCTION_WORKER_ERROR_CODES.DELEGATION_INVALID,
            );
        };
        assertActive();
        if (invocations.has(input.invocationId))
          throw new ProductionExecutionWorkerError(
            PRODUCTION_WORKER_ERROR_CODES.DUPLICATE_CONFLICT,
          );
        invocations.add(input.invocationId);
        const invocationId = `${request.messageId}:tool:${input.invocationId}`;
        const cancel = () => {
          void worker.options.service
            .cancel({
              schemaVersion: EXECUTION_SCHEMA_VERSION,
              kind: "request",
              type: "work.cancel",
              messageId: `${invocationId}:cancel`,
              correlationId: request.correlationId,
              causationId: request.messageId,
              dataClassification: request.dataClassification,
              scope: {
                ownerId: request.scope.ownerId as string,
                agentId: request.scope.agentId as string,
                runId: request.scope.runId as string,
                workerRunId: request.scope.workerRunId as string,
              },
              idempotencyKey: `${request.idempotencyKey}:tool:${input.invocationId}:cancel`,
              payload: {
                targetRequestId: invocationId,
                reasonCode: "SUBTASK_ENDED",
                requestedAt: worker.options.now(),
              },
            })
            .catch(() => undefined);
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          for await (const event of worker.options.service.execute(
            {
              schemaVersion: EXECUTION_SCHEMA_VERSION,
              kind: "request",
              type: "work.execute",
              messageId: invocationId,
              correlationId: request.correlationId,
              causationId: request.messageId,
              dataClassification: request.dataClassification,
              scope: {
                ownerId: request.scope.ownerId as string,
                agentId: request.scope.agentId as string,
                runId: request.scope.runId as string,
                workerRunId: request.scope.workerRunId as string,
              },
              idempotencyKey: `${request.idempotencyKey}:tool:${input.invocationId}`,
              payload: {
                capabilityId: input.capabilityId,
                capabilityVersion: input.capabilityVersion,
                operation: input.operation,
                inputRef: input.inputRef,
                capabilityHandleRef: input.capabilityHandleRef,
                delegatedContextRefs: input.delegatedContextRefs,
                secretRefs: [],
                requestedAt: worker.options.now(),
                deadlineAt: request.payload.deadlineAt,
              },
            },
            {
              ...worker.options.maximumResourceCeiling,
              maxWallTimeMs: request.payload.maximumDurationMs,
              maxProgressEvents: request.payload.maximumProgressEvents,
            },
            assertActive,
          )) {
            assertActive();
            if (
              event.type === "work.progress" &&
              ++progressEvents > request.payload.maximumProgressEvents
            ) {
              controller.abort();
              throw new ProductionExecutionWorkerError(
                PRODUCTION_WORKER_ERROR_CODES.RESOURCE_CEILING_EXCEEDED,
              );
            }
            yield event;
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
        }
      },
    });
  }

  private appendSubtaskResult(
    request: WorkerSubtaskRequest,
    result: {
      readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly workerResultRef: string | null;
      readonly errorCode: string | null;
      readonly actualModelRef: string | null;
      readonly actualCostMicros: number;
      readonly durationMs: number;
    },
  ): void {
    const event = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "event",
      type: "worker.subtask.result",
      messageId: this.options.nextId("worker-subtask-result"),
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
      payload: {
        requestId: request.messageId,
        delegationId: request.payload.delegationId,
        cursor: this.nextCursor(),
        sequence: this.nextSequence(request.messageId),
        ...result,
        completedAt: this.options.now(),
      },
    });
    if (event.kind !== "event") throw new TypeError("Worker produced a non-event message");
    this.eventsByCursor.push(event);
  }

  private async reconcile(request: ReconcileRequest): Promise<void> {
    try {
      const event = await this.options.service.reconcile({
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        kind: "request",
        type: "work.reconcile",
        messageId: request.messageId,
        correlationId: request.correlationId,
        causationId: request.causationId ?? request.messageId,
        dataClassification: request.dataClassification,
        scope: {
          ownerId: request.scope.ownerId as string,
          agentId: request.scope.agentId as string,
          runId: request.scope.runId as string,
          workerRunId: request.scope.workerRunId as string,
        },
        idempotencyKey: request.idempotencyKey,
        payload: {
          externalActionId: request.payload.externalActionId,
          resultLookupRef: request.payload.resultLookupRef,
          requestedAt: request.payload.requestedAt,
        },
      });
      this.appendMappedEvent(request, event, request.payload.targetRequestId);
    } catch (error) {
      this.appendFailure(request, errorCode(error));
    }
  }

  private appendMappedEvent(
    request: ExecuteRequest | CancelRequest | ReconcileRequest,
    event: ExecutionWorkerEvent,
    requestIdOverride?: string,
  ): void {
    const sequence = this.nextSequence(requestIdOverride ?? event.payload.requestId);
    const cursor = this.nextCursor();
    const envelope = {
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "event" as const,
      type: event.type,
      messageId: event.messageId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      dataClassification: event.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
    };
    let mapped: unknown;
    if (event.type === "work.progress") {
      mapped = {
        ...envelope,
        payload: { ...event.payload, cursor, sequence },
      };
    } else if (event.type === "work.result") {
      mapped = {
        ...envelope,
        payload: {
          ...event.payload,
          requestId: requestIdOverride ?? event.payload.requestId,
          cursor,
          sequence,
        },
      };
    } else if (event.type === "work.cancelled") {
      mapped = {
        ...envelope,
        payload: {
          ...event.payload,
          requestId: requestIdOverride ?? event.payload.requestId,
          cursor,
          sequence,
        },
      };
    } else {
      mapped = {
        ...envelope,
        payload: {
          ...event.payload,
          requestId: requestIdOverride ?? event.payload.requestId,
          cursor,
          sequence,
        },
      };
    }
    const parsed = executionV2MessageSchema.parse(mapped);
    if (parsed.kind !== "event") throw new TypeError("Worker produced a non-event message");
    this.eventsByCursor.push(parsed);
  }

  private appendFailure(
    request: ExecuteRequest | CancelRequest | ReconcileRequest,
    code: string,
  ): void {
    const requestId =
      request.type === "work.cancel"
        ? request.payload.targetRequestId
        : request.type === "work.reconcile"
          ? request.payload.targetRequestId
          : request.messageId;
    const event = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "event",
      type: "work.result",
      messageId: this.options.nextId("worker-result"),
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
      payload: {
        requestId,
        cursor: this.nextCursor(),
        sequence: this.nextSequence(requestId),
        completedAt: this.options.now(),
        outcome: "failed",
        outputRef: null,
        errorCode: code,
        externalActionId: null,
      },
    });
    if (event.kind !== "event") throw new TypeError("Worker produced a non-event message");
    this.eventsByCursor.push(event);
  }

  private responseEnvelope(
    request: HandshakeRequest | ReadinessRequest | DelegateRequest,
    type: "worker.handshake.accepted" | "worker.readiness.snapshot" | "work.delegate.accepted",
  ) {
    return {
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "response" as const,
      type,
      messageId: this.options.nextId("worker-response"),
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      risk: request.risk,
      authorizationRef: request.authorizationRef,
      scope: request.scope,
    };
  }

  private nextCursor(): string {
    this.cursorSequence += 1;
    return `worker-cursor-${this.cursorSequence}`;
  }

  private nextSequence(requestId: string): number {
    const sequence = (this.sequenceByRequest.get(requestId) ?? 0) + 1;
    this.sequenceByRequest.set(requestId, sequence);
    return sequence;
  }
}
