import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type CapabilityExecutionHandleStorePort,
  type CapabilityInvocationAuthority,
  type CapabilityInvocationReceiptPort,
  type CapabilityInvocationResultPort,
  type CapabilityRegistryStorePort,
  type CapabilityResourceCeiling,
  type ClockPort,
  type ConsumeCapabilityInvocationInput,
  capabilityLifecycleHasActiveAuthority,
  type ExecutionTransportPort,
  type GovernedCapabilityExecutionHandle,
  type IdGeneratorPort,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type RunPayloadArtifactPort,
  type RuntimeRequest,
  type RuntimeToolDescriptor,
  type RuntimeToolExecutionResult,
  type RuntimeToolInvocation,
  type RuntimeToolPort,
  type WorkerDelegationAdmissionServiceOptions,
  WorkerDelegationService,
} from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionAdmissionPeerBinding,
  type ExecutionV2Event,
  type ExecutionV2Request,
} from "@himawari-agent/execution-contracts";
import {
  managedTaskDescriptors,
  MANAGED_TASK_ACTIONS,
  type ProductionManagedTasks,
} from "./production-managed-tasks.js";
import type { ProductionExecutionAdmissionParentBinding } from "./production-execution-admission-handler.js";
import {
  type ProductionFileReadServices,
  ProductionFileReadWorkflow,
} from "./production-file-read-workflow.js";
import { ProductionWorkerForwardTransport } from "./production-worker-forward-transport.js";
import type { ProductionWorkerParentBindingRegistryWriter } from "./production-worker-parent-binding-registry.js";

type ExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;
const RANK = ["public", "private", "sensitive", "restricted"] as const;
const unknownResult = (): RuntimeToolExecutionResult => ({
  outcome: "result_unknown",
  resultRef: null,
  errorCode: "WORKER_RESULT_RECONCILIATION_REQUIRED",
  externalActionId: null,
  modelContent: "执行结果尚未确认，不能重新执行该操作。",
});
function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}
function executionIdentity(invocation: RuntimeToolInvocation) {
  if (!invocation.context) return invocation;
  const { executionLease, continuationRef: _continuation, ...context } = invocation.context;
  return {
    ...invocation,
    context: {
      ...context,
      authority: {
        deploymentId: executionLease.deploymentId,
        authorityEpoch: executionLease.authorityEpoch,
        fencingToken: executionLease.fencingToken,
      },
    },
  };
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  if (performance.now() >= deadline) throw new Error("WORKER_DEADLINE_EXCEEDED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("WORKER_DEADLINE_EXCEEDED")),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function reject(): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.HANDLE_REVOKED, "Runtime tool is not authorized");
}

type SandboxAdmission = NonNullable<WorkerDelegationAdmissionServiceOptions["sandbox"]>;
export type ProductionRuntimeSandbox = Omit<SandboxAdmission, "prepare"> & {
  readonly prepare: (
    admission: ConsumeCapabilityInvocationInput,
    invocation: RuntimeToolInvocation,
    parentCall?: RuntimeToolInvocation,
  ) => ReturnType<SandboxAdmission["prepare"]>;
};

export interface ProductionRuntimeToolsOptions {
  readonly sandbox?: ProductionRuntimeSandbox;
  readonly managedTasks?: ProductionManagedTasks;
  readonly taskHandle?: (handle: GovernedCapabilityExecutionHandle) => Promise<boolean>;
  readonly fileRead?: ProductionFileReadServices;
  readonly ownerId: RuntimeRequest["ownerId"];
  readonly agentId: RuntimeRequest["agentId"];
  readonly capabilities: Pick<CapabilityRegistryStorePort, "get"> &
    Pick<CapabilityExecutionHandleStorePort, "getExecutionHandle">;
  readonly invocations: CapabilityInvocationReceiptPort;
  readonly transport: ExecutionTransportPort;
  readonly parents: ProductionWorkerParentBindingRegistryWriter;
  readonly peer: () => ExecutionAdmissionPeerBinding;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly assertRunActive: (runId: RuntimeRequest["runId"]) => Promise<void>;
  readonly results: Pick<CapabilityInvocationResultPort, "lookupOutput">;
  readonly artifacts: RunPayloadArtifactPort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: Pick<PayloadProtectorPort, "protect" | "unprotect">;
  readonly ceiling: CapabilityResourceCeiling;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

/** Path requests carry no authority; executable tools select only authorized inputs. */
export class ProductionRuntimeTools implements RuntimeToolPort {
  readonly #options: ProductionRuntimeToolsOptions;
  readonly #delegation: WorkerDelegationService;
  readonly #parents = new Map<string, ProductionExecutionAdmissionParentBinding>();
  readonly #exposed = new Map<string, ReadonlySet<string>>();
  readonly #inFlight = new Map<
    string,
    { fingerprint: string; result: Promise<RuntimeToolExecutionResult> }
  >();
  constructor(options: ProductionRuntimeToolsOptions) {
    this.#options = options;
    this.#delegation = this.#createDelegation();
  }

  #createDelegation(sandbox?: SandboxAdmission) {
    const options = this.#options;
    return new WorkerDelegationService({
      ...(sandbox ? { sandbox } : {}),
      invocations: options.invocations,
      invocationAuthority: options.authority,
      now: () => options.clock.now(),
      nextId: (scope) => options.ids.next(scope),
      transport: new ProductionWorkerForwardTransport({
        transport: options.transport,
        parentBindingWriter: options.parents,
        parentBindingFor: (message) => {
          const parentId =
            message.type === "work.execute" ? message.messageId : message.causationId;
          const binding = parentId === null ? undefined : this.#parents.get(parentId);
          if (!binding) throw new Error("RUNTIME_TOOL_PARENT_MISSING");
          return binding;
        },
      }),
    });
  }

  async listAuthorized(
    runId: RuntimeRequest["runId"],
    refs: readonly string[],
  ): Promise<readonly RuntimeToolDescriptor[]> {
    await this.#options.assertRunActive(runId);
    if (new Set(refs).size !== refs.length) reject();
    const descriptors: RuntimeToolDescriptor[] = [
      {
        definition: "builtin-read",
        name: "read",
        capabilityRef: "host.file.read",
        capabilityHandleRef: null,
      },
    ];
    const tasks: string[] = [];
    for (const ref of refs) {
      const handle = await this.#handle(runId, ref);
      if (this.#options.taskHandle && (await this.#options.taskHandle(handle))) tasks.push(ref);
      descriptors.push({
        capabilityRef: handle.capabilityRef,
        capabilityHandleRef: ref,
        name: `authorized_${digest(ref).slice(0, 24)}`,
        description: `执行已授权操作 ${handle.capabilityRef}/${handle.operation}，只能选择列出的输入。`,
        parameters: {
          type: "object",
          properties: { inputRef: { type: "string", enum: [...handle.inputRefs] } },
          required: ["inputRef"],
          additionalProperties: false,
        },
      });
    }
    if (this.#options.managedTasks) {
      descriptors.push(...managedTaskDescriptors());
      if (tasks.length)
        descriptors.push({
          capabilityRef: "execution.task.start",
          capabilityHandleRef: null,
          name: "execution_task_start",
          description:
            "启动已授权的后台命令，选择既有 Handle 与冻结输入；返回 started 不表示命令已完成。",
          parameters: {
            type: "object",
            properties: {
              capabilityHandleRef: { type: "string", enum: tasks },
              inputRef: { type: "string" },
            },
            required: ["capabilityHandleRef", "inputRef"],
            additionalProperties: false,
          },
        });
    }
    this.#exposed.set(runId, new Set(refs));
    return descriptors;
  }

  async #taskStart(invocation: RuntimeToolInvocation): Promise<RuntimeToolInvocation> {
    if (
      invocation.capabilityHandleRef !== null ||
      invocation.capabilityRef !== "execution.task.start"
    )
      return invocation;
    const args = invocation.arguments;
    if (
      typeof args["capabilityHandleRef"] !== "string" ||
      typeof args["inputRef"] !== "string" ||
      Object.keys(args).length !== 2 ||
      !this.#exposed.get(invocation.runId)?.has(args["capabilityHandleRef"])
    )
      reject();
    const handle = await this.#handle(invocation.runId, args["capabilityHandleRef"]);
    if (!this.#options.taskHandle || !(await this.#options.taskHandle(handle))) reject();
    return {
      ...invocation,
      capabilityRef: handle.capabilityRef,
      capabilityHandleRef: handle.ref,
      arguments: { inputRef: args["inputRef"] },
    };
  }
  #isTaskManagement(invocation: RuntimeToolInvocation) {
    return (
      invocation.capabilityHandleRef === null &&
      MANAGED_TASK_ACTIONS.some((action) => invocation.capabilityRef === `execution.task.${action}`)
    );
  }
  async preflight(value: RuntimeToolInvocation) {
    const invocation = await this.#taskStart(value);
    if (this.#isTaskManagement(invocation)) {
      await this.#options.assertRunActive(invocation.runId);
      return {
        allowed: this.#exposed.has(invocation.runId) && this.#options.managedTasks !== undefined,
        permissionDecisionRef: `task-management:${digest([invocation.runId, invocation.toolCallId])}`,
        reasonCode: "TASK_RESOURCE_AUTHORITY_REQUIRED",
      };
    }
    if (invocation.capabilityHandleRef === null) {
      await this.#options.assertRunActive(invocation.runId);
      const valid =
        this.#exposed.has(invocation.runId) && invocation.capabilityRef === "host.file.read";
      return {
        allowed: valid && this.#options.fileRead !== undefined,
        permissionDecisionRef: `tool-workflow:${digest([invocation.runId, invocation.toolCallId])}`,
        reasonCode: !valid
          ? "FILE_READ_REQUEST_INVALID"
          : this.#options.fileRead
            ? "FILE_READ_WORKFLOW_REQUIRED"
            : "FILE_READ_AUTHORIZATION_UNAVAILABLE",
      };
    }
    try {
      const handle = await this.#validate(invocation);
      return {
        allowed: true,
        permissionDecisionRef: handle.authorizationRef,
        reasonCode: "GOVERNED_HANDLE_VALID",
      };
    } catch (error) {
      if (
        !(error instanceof ApplicationPortError) ||
        error.code !== PORT_ERROR_CODES.HANDLE_REVOKED
      )
        throw error;
      return {
        allowed: false,
        permissionDecisionRef: `tool-denied:${digest([invocation.runId, invocation.toolCallId])}`,
        reasonCode: "GOVERNED_HANDLE_INVALID",
      };
    }
  }

  async execute(value: RuntimeToolInvocation): Promise<RuntimeToolExecutionResult> {
    const invocation = await this.#taskStart(value);
    if (this.#isTaskManagement(invocation)) {
      await this.#options.assertRunActive(invocation.runId);
      if (!this.#exposed.has(invocation.runId) || !this.#options.managedTasks) reject();
      const key = digest([invocation.runId, invocation.toolCallId]);
      const fingerprint = digest(executionIdentity(invocation));
      const claimed = await this.#writeJson(invocation, `runtime-tool-intent:${key}`, {
        fingerprint,
        management: true,
      });
      const intent = (await this.#readJson(claimed.ref)) as {
        fingerprint?: string;
        management?: boolean;
      };
      if (intent.fingerprint !== fingerprint || intent.management !== true)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Tool call identity changed");
      return this.#options.managedTasks.execute(invocation);
    }
    return this.#executeCanonical(invocation);
  }
  #executeCanonical(invocation: RuntimeToolInvocation): Promise<RuntimeToolExecutionResult> {
    const key = digest([invocation.runId, invocation.toolCallId]);
    const fingerprint = digest(executionIdentity(invocation));
    const attemptFingerprint = digest(invocation);
    const active = this.#inFlight.get(key);
    if (active) {
      if (active.fingerprint !== attemptFingerprint)
        return Promise.reject(
          new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Tool call identity changed"),
        );
      return active.result;
    }
    const result =
      invocation.capabilityHandleRef === null && this.#options.fileRead
        ? this.#executeFileRead(invocation, key)
        : this.#execute(invocation, key, fingerprint);
    this.#inFlight.set(key, { fingerprint: attemptFingerprint, result });
    void result.finally(() => this.#inFlight.delete(key)).catch(() => undefined);
    return result;
  }

  async #executeFileRead(invocation: RuntimeToolInvocation, key: string) {
    if (!this.#exposed.has(invocation.runId) || !this.#options.fileRead) reject();
    const workflow = new ProductionFileReadWorkflow(this.#options.fileRead);
    const operationKey = (suffix: string) => `runtime-file-read:${key}:${suffix}`;
    return workflow.execute(invocation, {
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      now: () => this.#options.clock.now(),
      authorityFence: () => this.#options.authority().product.fencingToken,
      workerInstanceId: () => this.#options.peer().workerInstanceId,
      assertActive: () => this.#options.assertRunActive(invocation.runId),
      load: async (suffix) => {
        const record = await this.#options.artifacts.lookup({
          runId: invocation.runId,
          purpose: "trace",
          operationKey: operationKey(suffix),
        });
        return record ? this.#readJson(record.payloadRef) : undefined;
      },
      save: async (suffix, value) => {
        const saved = await this.#writeJson(invocation, operationKey(suffix), value);
        return { ref: saved.ref, value: await this.#readJson(saved.ref) };
      },
      phase: async (handle, phase, inputRef) => {
        const live = await this.#handle(invocation.runId, handle.ref);
        if (
          live.operation !== phase ||
          live.capabilityVersion !== handle.capabilityVersion ||
          live.maxUses !== 1 ||
          live.inputRefs.length !== 1 ||
          live.inputRefs[0] !== inputRef
        )
          reject();
        if (
          handle.operation !== phase ||
          handle.inputRefs.length !== 1 ||
          handle.inputRefs[0] !== inputRef ||
          handle.maxUses !== 1 ||
          handle.runId !== invocation.runId
        )
          reject();
        const child: RuntimeToolInvocation = {
          ...invocation,
          toolCallId: `file-phase:${digest([key, phase])}`,
          capabilityHandleRef: handle.ref,
          capabilityRef: handle.capabilityRef,
          arguments: { inputRef },
        };
        // Issued phase handles stay private to this workflow, never in model-visible tools.
        return this.#execute(
          child,
          digest([child.runId, child.toolCallId]),
          digest(executionIdentity(child)),
          true,
          invocation,
        );
      },
    });
  }

  async #handle(
    runId: RuntimeRequest["runId"],
    ref: string,
  ): Promise<GovernedCapabilityExecutionHandle> {
    const handle = await this.#options.capabilities.getExecutionHandle(ref);
    if (!handle || !("handleVersion" in handle) || handle.handleVersion !== "capability-handle.v2")
      reject();
    const governed = handle as GovernedCapabilityExecutionHandle;
    const record = await this.#options.capabilities.get(handle.capabilityRef);
    if (
      handle.ownerId !== this.#options.ownerId ||
      handle.agentId !== this.#options.agentId ||
      handle.runId !== runId ||
      handle.revokedAt !== null ||
      governed.workerEndedAt !== null ||
      !Number.isFinite(Date.parse(handle.expiresAt)) ||
      !Number.isFinite(Date.parse(handle.issuedAt)) ||
      Date.parse(handle.issuedAt) > Date.parse(this.#options.clock.now()) ||
      Date.parse(handle.expiresAt) <= Date.parse(this.#options.clock.now()) ||
      governed.authorityFence !== this.#options.authority().product.fencingToken ||
      !record ||
      !capabilityLifecycleHasActiveAuthority(record.lifecycle) ||
      record.declaration.version !== handle.capabilityVersion
    )
      reject();
    return governed;
  }

  async #validate(invocation: RuntimeToolInvocation, internal = false) {
    await this.#options.assertRunActive(invocation.runId);
    if (invocation.capabilityHandleRef === null) reject();
    if (!internal && !this.#exposed.get(invocation.runId)?.has(invocation.capabilityHandleRef))
      reject();
    const handle = await this.#handle(invocation.runId, invocation.capabilityHandleRef);
    if (
      invocation.executionDeadlineAt !== undefined &&
      (!Number.isFinite(Date.parse(invocation.executionDeadlineAt)) ||
        Date.parse(invocation.executionDeadlineAt) <= Date.parse(this.#options.clock.now()))
    )
      reject();
    const keys = Object.keys(invocation.arguments);
    if (
      handle.capabilityRef !== invocation.capabilityRef ||
      keys.length !== 1 ||
      keys[0] !== "inputRef" ||
      typeof invocation.arguments["inputRef"] !== "string" ||
      !handle.inputRefs.includes(invocation.arguments["inputRef"]) ||
      RANK.indexOf(invocation.dataClassification) > RANK.indexOf(handle.maxDataClassification)
    )
      reject();
    return handle;
  }

  async #execute(
    invocation: RuntimeToolInvocation,
    key: string,
    fingerprint: string,
    internal = false,
    parentCall?: RuntimeToolInvocation,
  ): Promise<RuntimeToolExecutionResult> {
    const handle = await this.#validate(invocation, internal);
    const intentKey = {
      runId: invocation.runId,
      purpose: "trace" as const,
      operationKey: `runtime-tool-intent:${key}`,
    };
    const existing = await this.#options.artifacts.lookup(intentKey);
    if (existing) {
      const intent = (await this.#readJson(existing.payloadRef)) as { fingerprint?: string };
      if (intent.fingerprint !== fingerprint)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Tool call identity changed");
      const result = await this.#options.artifacts.lookup({
        ...intentKey,
        operationKey: `runtime-tool-result:${key}`,
      });
      const replay = result
        ? ((await this.#readJson(result.payloadRef)) as RuntimeToolExecutionResult)
        : unknownResult();
      if (replay.outcome === "succeeded") {
        await this.#assertDisclosure(invocation, key, internal);
        const observed = await this.#options.results.lookupOutput({
          handleRef: handle.ref,
          invocationId: `runtime-tool:${key}`,
          authority: this.#options.authority(),
          now: this.#options.clock.now(),
        });
        if (!observed || observed.payloadRef !== replay.resultRef) reject();
      }
      await this.#validate(invocation, internal);
      return replay;
    }
    const now = this.#options.clock.now();
    const deadlineAt = new Date(
      Math.min(
        Date.parse(handle.expiresAt),
        Date.parse(now) + this.#options.ceiling.maxWallTimeMs,
        invocation.executionDeadlineAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(invocation.executionDeadlineAt),
      ),
    ).toISOString();
    const authority = this.#options.authority();
    const scope = {
      ...authority.product,
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      runId: invocation.runId,
      workerRunId: `runtime-worker:${key}`,
    };
    const request: ExecuteRequest = {
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.execute",
      messageId: `runtime-tool:${key}`,
      correlationId: `run:${invocation.runId}`,
      causationId: invocation.runId,
      dataClassification: invocation.dataClassification,
      risk: "high",
      authorizationRef: handle.authorizationRef,
      scope,
      idempotencyKey: `runtime-tool:${key}`,
      payload: {
        capabilityId: handle.capabilityRef,
        capabilityVersion: handle.capabilityVersion,
        operation: handle.operation,
        inputRef: invocation.arguments["inputRef"] as string,
        capabilityHandleRef: handle.ref,
        delegatedContextRefs: [...handle.delegatedContextRefs],
        secretRefs: [...handle.secretRefs],
        resourceCeiling: this.#options.ceiling,
        requestedAt: now,
        deadlineAt,
      },
    };
    const committed = await this.#writeJson(invocation, intentKey.operationKey, {
      fingerprint,
      request,
    });
    // A concurrent writer won the durable operation key. Never forward a second request.
    if (committed.replayed)
      return this.#execute(invocation, key, fingerprint, internal, parentCall);
    const monotonicDeadline =
      performance.now() +
      Math.max(0, Date.parse(deadlineAt) - Date.parse(this.#options.clock.now()));
    this.#parents.set(request.messageId, {
      parentMessageId: request.messageId,
      parentCorrelationId: request.correlationId,
      bindingRevision: 1,
      bindingDigest: digest(request),
      scope,
      authority: this.#options.peer(),
      dataClassification: invocation.dataClassification,
      resourceCeiling: this.#options.ceiling,
      deadlineAt,
      capabilityHandleRefs: [handle.ref],
      delegatedContextRefs: [...handle.delegatedContextRefs],
    });
    let outcome = unknownResult();
    try {
      await this.#options.assertRunActive(invocation.runId);
      const sandbox = this.#options.sandbox;
      const delegation = sandbox
        ? this.#createDelegation({
            ...sandbox,
            prepare: (admission) => sandbox.prepare(admission, invocation, parentCall),
          })
        : this.#delegation;
      await beforeDeadline(delegation.dispatch(request), monotonicDeadline);
      let cursor: string | null = null;
      while (
        performance.now() < monotonicDeadline &&
        Date.parse(this.#options.clock.now()) < Date.parse(deadlineAt)
      ) {
        await this.#options.assertRunActive(invocation.runId);
        const iterator: AsyncIterator<ExecutionV2Event> = this.#options.transport
          .events(cursor)
          [Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await beforeDeadline(iterator.next(), monotonicDeadline);
            if (next.done) break;
            const event = next.value;
            cursor = event.payload.cursor;
            if (
              (event.type !== "work.result" && event.type !== "work.cancelled") ||
              event.payload.requestId !== request.messageId ||
              event.causationId !== request.messageId ||
              event.correlationId !== request.correlationId ||
              digest(event.scope) !== digest(scope)
            )
              continue;
            await this.#validate(invocation, internal);
            if (event.type === "work.cancelled") {
              outcome = {
                outcome: "failed",
                resultRef: null,
                errorCode: event.payload.reasonCode,
                externalActionId: null,
                modelContent: "操作已取消。",
              };
            } else if (event.payload.outcome === "succeeded") {
              if (!event.payload.outputRef) throw new Error("WORKER_OUTPUT_MISSING");
              await this.#assertDisclosure(invocation, key, internal);
              const observed = await this.#options.results.lookupOutput({
                handleRef: handle.ref,
                invocationId: request.messageId,
                authority: this.#options.authority(),
                now: this.#options.clock.now(),
              });
              if (!observed || observed.payloadRef !== event.payload.outputRef)
                throw new Error("WORKER_OUTPUT_OBSERVATION_MISSING");
              const payload = await this.#options.payloads.get(observed.payloadRef);
              if (
                !payload ||
                RANK.indexOf(payload.dataClassification) >
                  RANK.indexOf(invocation.dataClassification)
              )
                reject();
              const bytes = await this.#options.protector.unprotect({
                ownerId: this.#options.ownerId,
                agentId: this.#options.agentId,
                payload,
              });
              if (bytes.byteLength > this.#options.ceiling.maxOutputBytes)
                throw new Error("WORKER_OUTPUT_LIMIT_EXCEEDED");
              outcome = {
                outcome: "succeeded",
                resultRef: payload.ref,
                errorCode: null,
                externalActionId: null,
                modelContent: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              };
            } else {
              outcome = {
                outcome: event.payload.outcome,
                resultRef: null,
                errorCode: event.payload.errorCode,
                externalActionId: event.payload.externalActionId,
                modelContent: "操作未确认成功。",
              };
            }
            await this.#validate(invocation, internal);
            await this.#writeJson(invocation, `runtime-tool-result:${key}`, outcome);
            await this.#assertDisclosure(invocation, key, internal);
            return outcome;
          }
        } finally {
          // A hung iterator must not extend the tool deadline; its transport owns cancellation.
          void iterator.return?.().catch(() => undefined);
        }
        await beforeDeadline(
          new Promise<void>((resolve) => setTimeout(resolve, 50)),
          monotonicDeadline,
        );
      }
    } catch {
      outcome = unknownResult();
      // A sent request can have an external effect even when transport or authority fails.
      // Keep its intent durable and never automatically submit it again.
    }
    await this.#options.assertRunActive(invocation.runId);
    await this.#writeJson(invocation, `runtime-tool-result:${key}`, outcome);
    return outcome;
  }

  async #assertDisclosure(
    invocation: RuntimeToolInvocation,
    key: string,
    internal = false,
  ): Promise<void> {
    const handle = await this.#validate(invocation, internal);
    // Output observation intentionally permits historical lookup. Disclosure additionally
    // requires the live receipt path, including grant revocation and Run authority checks.
    const receipt = await this.#options.invocations.read({
      handleRef: handle.ref,
      invocationId: `runtime-tool:${key}`,
      authority: this.#options.authority(),
      now: this.#options.clock.now(),
    });
    if (!receipt) reject();
  }

  async #readJson(ref: string): Promise<unknown> {
    const payload = await this.#options.payloads.get(ref);
    if (!payload || payload.contentType !== "application/json")
      throw new Error("RUNTIME_TOOL_RECORD_MISSING");
    const bytes = await this.#options.protector.unprotect({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      payload,
    });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async #writeJson(invocation: RuntimeToolInvocation, operationKey: string, value: unknown) {
    const payload = await this.#options.protector.protect({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      ref: this.#options.ids.next("runtime-tool-record"),
      dataClassification: invocation.dataClassification,
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify(value)),
      createdAt: this.#options.clock.now(),
    });
    return this.#options.artifacts.commit({
      runId: invocation.runId,
      purpose: "trace",
      operationKey,
      payload,
    });
  }
}
