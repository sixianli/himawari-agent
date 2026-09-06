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
  WorkerDelegationService,
} from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionAdmissionPeerBinding,
  type ExecutionV2Event,
  type ExecutionV2Request,
} from "@himawari-agent/execution-contracts";
import type { ProductionExecutionAdmissionParentBinding } from "./production-execution-admission-handler.js";
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

export interface ProductionRuntimeToolsOptions {
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

/** Tools select only previously authorized input references; they cannot expand a Handle. */
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
    this.#delegation = new WorkerDelegationService({
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
    const descriptors: RuntimeToolDescriptor[] = [];
    for (const ref of refs) {
      const handle = await this.#handle(runId, ref);
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
    this.#exposed.set(runId, new Set(refs));
    return descriptors;
  }

  async preflight(invocation: RuntimeToolInvocation) {
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

  execute(invocation: RuntimeToolInvocation): Promise<RuntimeToolExecutionResult> {
    const key = digest([invocation.runId, invocation.toolCallId]);
    const fingerprint = digest(invocation);
    const active = this.#inFlight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint)
        return Promise.reject(
          new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Tool call identity changed"),
        );
      return active.result;
    }
    const result = this.#execute(invocation, key, fingerprint);
    this.#inFlight.set(key, { fingerprint, result });
    void result.finally(() => this.#inFlight.delete(key)).catch(() => undefined);
    return result;
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

  async #validate(invocation: RuntimeToolInvocation) {
    await this.#options.assertRunActive(invocation.runId);
    if (!this.#exposed.get(invocation.runId)?.has(invocation.capabilityHandleRef)) reject();
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
  ): Promise<RuntimeToolExecutionResult> {
    const handle = await this.#validate(invocation);
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
        await this.#assertDisclosure(invocation, key);
        const observed = await this.#options.results.lookupOutput({
          handleRef: handle.ref,
          invocationId: `runtime-tool:${key}`,
          authority: this.#options.authority(),
          now: this.#options.clock.now(),
        });
        if (!observed || observed.payloadRef !== replay.resultRef) reject();
      }
      await this.#validate(invocation);
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
    if (committed.replayed) return this.#execute(invocation, key, fingerprint);
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
      await beforeDeadline(this.#delegation.dispatch(request), monotonicDeadline);
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
            await this.#validate(invocation);
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
              await this.#assertDisclosure(invocation, key);
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
            await this.#validate(invocation);
            await this.#writeJson(invocation, `runtime-tool-result:${key}`, outcome);
            await this.#assertDisclosure(invocation, key);
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

  async #assertDisclosure(invocation: RuntimeToolInvocation, key: string): Promise<void> {
    await this.#validate(invocation);
    // Output observation intentionally permits historical lookup. Disclosure additionally
    // requires the live receipt path, including grant revocation and Run authority checks.
    const receipt = await this.#options.invocations.read({
      handleRef: invocation.capabilityHandleRef,
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
