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
  type ProductConfiguration,
  type RunPayloadArtifactPort,
  type RuntimeRequest,
  type RuntimeToolDescriptor,
  type RuntimeToolExecutionResult,
  type RuntimeToolInvocation,
  type RuntimeToolPort,
  type RuntimeToolSettledResult,
  type SandboxExecutionPreparationPort,
  type WorkerDelegationAdmissionServiceOptions,
  WorkerDelegationService,
} from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionAdmissionPeerBinding,
  type ExecutionV2Event,
  type ExecutionV2Request,
  executionV2MessageSchema,
  piFileRecoveryOperationKey,
} from "@himawari-agent/execution-contracts";
import {
  executeProductionCodingRequest,
  fileVersionConflictResult,
} from "./production-coding-workflow.js";
import type { ProductionExecutionAdmissionParentBinding } from "./production-execution-admission-handler.js";
import {
  type CodingBinding,
  type FileReadExecutionContext,
  type ProductionFileReadServices,
  ProductionFileReadWorkflow,
} from "./production-file-read-workflow.js";
import {
  MANAGED_TASK_ACTIONS,
  managedTaskDescriptors,
  type ProductionManagedTasks,
} from "./production-managed-tasks.js";
import {
  SANDBOX_TOOL_RESULT_LOST,
  SANDBOX_TOOL_RESULT_LOST_MESSAGE,
} from "./production-sandbox-lost-result-recovery.js";
import {
  RECOVERY_SETTLE_WAIT_MS,
  SANDBOX_TOOL_DEADLINE_EXCEEDED,
  SANDBOX_TOOL_DEADLINE_EXCEEDED_MESSAGE,
  SANDBOX_HOST_COMPLETION_CONTRADICTED,
  SANDBOX_HOST_COMPLETION_CONTRADICTED_MESSAGE,
  type SandboxToolCompletion,
  type SandboxToolDelivery,
} from "./production-sandbox-tool-result.js";
import { ProductionWorkerForwardTransport } from "./production-worker-forward-transport.js";
import type { ProductionWorkerParentBindingRegistryWriter } from "./production-worker-parent-binding-registry.js";

type ExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;
type WorkerToolCompletion = Pick<
  Extract<ExecutionV2Event, { type: "work.result" }>["payload"],
  "outcome" | "outputRef" | "errorCode" | "externalActionId"
>;
// Reuse the existing event polling cadence while an individual event read is pending.
const EVENT_POLL_MS = 50;
// Same bounded cleanup wait as RunCoordinator; expiry never cancels the duty to stop.
const AUTHORITY_STOP_WAIT_MS = 30_000;
const RANK = ["public", "private", "sensitive", "restricted"] as const;
const unknownResult = (): RuntimeToolSettledResult => ({
  dispatchState: "possibly_sent",
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
function executionIdentity(
  invocation: RuntimeToolInvocation,
  originalAuthority?: { deploymentId: string; authorityEpoch: number; fencingToken: number },
) {
  if (!invocation.context) return invocation;
  const { executionLease, continuationRef: _continuation, ...context } = invocation.context;
  return {
    ...invocation,
    context: {
      ...context,
      authority: {
        deploymentId: originalAuthority?.deploymentId ?? executionLease.deploymentId,
        authorityEpoch: originalAuthority?.authorityEpoch ?? executionLease.authorityEpoch,
        fencingToken: originalAuthority?.fencingToken ?? executionLease.fencingToken,
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
async function nextWithAuthority<T>(
  next: Promise<T>,
  deadline: number,
  assertCurrent: () => Promise<void>,
): Promise<T> {
  const pending = next.then(
    (value) => ({ kind: "event" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  while (true) {
    await beforeDeadline(assertCurrent(), deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await beforeDeadline(
        Promise.race([
          pending,
          new Promise<{ kind: "check" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "check" }), EVENT_POLL_MS);
          }),
        ]),
        deadline,
      );
      if (result.kind === "error") throw result.error;
      if (result.kind === "event") {
        await beforeDeadline(assertCurrent(), deadline);
        return result.value;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function reject(): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.HANDLE_REVOKED, "Runtime tool is not authorized");
}

function preDispatchFailure(error: unknown): { reasonCode: string; modelContent: string } {
  if (error instanceof ApplicationPortError) {
    switch (error.code) {
      case PORT_ERROR_CODES.CONFLICT:
        return {
          reasonCode: "WORKER_ADMISSION_CONFLICT",
          modelContent: "操作尚未派发：资源或请求状态发生冲突。",
        };
      case PORT_ERROR_CODES.HANDLE_REVOKED:
        return {
          reasonCode: "WORKER_AUTHORIZATION_DENIED",
          modelContent: "操作尚未派发：执行权限已失效或不再允许本次操作。",
        };
      case PORT_ERROR_CODES.NOT_AUTHORITATIVE:
        return {
          reasonCode: "WORKER_AUTHORITY_UNAVAILABLE",
          modelContent: "操作尚未派发：当前执行权不可用。",
        };
      case PORT_ERROR_CODES.NOT_FOUND:
        return {
          reasonCode: "WORKER_ADMISSION_RESOURCE_MISSING",
          modelContent: "操作尚未派发：执行所需资源已不存在。",
        };
      case PORT_ERROR_CODES.DUPLICATE:
        return {
          reasonCode: "WORKER_ADMISSION_ALREADY_RECORDED",
          modelContent: "操作尚未派发：该请求已被记录，请先检查原请求状态。",
        };
      case PORT_ERROR_CODES.INVALID_OPERATION:
      case PORT_ERROR_CODES.OPERATION_NOT_INSTALLED:
        return {
          reasonCode: "WORKER_OPERATION_UNAVAILABLE",
          modelContent: "操作尚未派发：当前执行方式不可用。",
        };
      case PORT_ERROR_CODES.PROVIDER_FAILURE:
      case PORT_ERROR_CODES.INJECTED_FAILURE:
        return {
          reasonCode: "WORKER_ADMISSION_UNAVAILABLE",
          modelContent: "操作尚未派发：执行准入服务暂不可用。",
        };
    }
  }

  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "WORKER_DEADLINE_EXCEEDED":
      return {
        reasonCode: code,
        modelContent: "操作未派发：执行期限已到。请重新检查当前期限后再决定是否发起新请求。",
      };
    case "WORKER_RESOURCE_CEILING_CHANGED":
      return {
        reasonCode: code,
        modelContent: "操作未派发：允许的资源上限已变化，请重新检查授权和资源上限。",
      };
    case "SANDBOX_PREPARATION_AUTHORITY_CHANGED":
    case "SANDBOX_CHILD_SCOPE_EXCEEDED":
      return {
        reasonCode: "WORKER_AUTHORITY_UNAVAILABLE",
        modelContent: "操作尚未派发：当前执行权或授权范围已变化。",
      };
    case "SANDBOX_DIRECTORY_GRANT_UNAVAILABLE":
      return {
        reasonCode: "WORKER_AUTHORIZATION_DENIED",
        modelContent: "操作尚未派发：目录授权已失效或不可用。",
      };
    case "SANDBOX_STRICT_MODE_UNAVAILABLE":
      return {
        reasonCode: code,
        modelContent:
          "操作未执行：当前是严格模式，所有工具都必须在容器里运行，这个工具还不能在容器里运行，所以在严格模式下不可用。不要改用其他方式执行同样的操作，请告诉用户这个限制。",
      };
    case "SANDBOX_DIRECTORY_MOVE_TARGET_CHANGED":
      return {
        reasonCode: "DIRECTORY_TARGET_CHANGED",
        modelContent: "目录位置或目标已变化，本次操作未执行。请重新读取目录位置后提出新请求。",
      };
    default:
      return {
        reasonCode: "WORKER_NOT_DISPATCHED",
        modelContent: "操作尚未派发，未开始执行。",
      };
  }
}

type SandboxAdmission = NonNullable<WorkerDelegationAdmissionServiceOptions["sandbox"]>;
export type ProductionRuntimeSandbox = Omit<SandboxAdmission, "prepare"> & {
  readonly preparations?: SandboxAdmission["preparations"] &
    Partial<Pick<SandboxExecutionPreparationPort, "readAdmissionByInvocation">>;
  readonly prepare: (
    admission: ConsumeCapabilityInvocationInput,
    invocation: RuntimeToolInvocation,
    parentCall?: RuntimeToolInvocation,
    signal?: AbortSignal,
  ) => ReturnType<SandboxAdmission["prepare"]>;
};

export interface ProductionRuntimeToolsOptions {
  readonly completeSandboxToolResult?: (
    input: { runId: string; invocationId: string },
    delivery: SandboxToolDelivery,
  ) => Promise<SandboxToolCompletion | null | undefined>;

  readonly coding?: NonNullable<ProductConfiguration["runPolicy"]>["coding"];
  readonly publicSearch?: NonNullable<ProductConfiguration["runPolicy"]>["publicSearch"];
  readonly fileReadEnabled?: boolean;
  readonly sandbox?: ProductionRuntimeSandbox;
  readonly managedTasks?: ProductionManagedTasks;
  readonly taskHandle?: (handle: GovernedCapabilityExecutionHandle) => Promise<boolean>;
  readonly fileRead?: ProductionFileReadServices;
  readonly ownerId: RuntimeRequest["ownerId"];
  readonly agentId: RuntimeRequest["agentId"];
  readonly capabilities: Pick<CapabilityRegistryStorePort, "get"> &
    Pick<CapabilityExecutionHandleStorePort, "getExecutionHandle"> &
    Partial<Pick<CapabilityExecutionHandleStorePort, "revokeExecutionHandle">>;
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
  readonly maximumResourceCeiling?: (
    capabilityRef: string,
    capabilityVersion: string,
  ) => Promise<CapabilityResourceCeiling | undefined>;
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
    const descriptors: RuntimeToolDescriptor[] =
      this.#options.fileReadEnabled === false
        ? []
        : [
            {
              definition: "builtin-read",
              name: "read",
              capabilityRef: "host.file.read",
              capabilityHandleRef: null,
            },
          ];
    const coding = this.#options.coding;
    if (coding) {
      if (
        coding.enabledTools.includes("read") &&
        descriptors[0]?.capabilityRef === "host.file.read"
      )
        descriptors.splice(0, 1);
      for (const name of coding.enabledTools)
        descriptors.push(
          name === "save_copy"
            ? {
                name,
                capabilityRef: `${coding.capabilityRef}.${name}`,
                capabilityHandleRef: null,
                description:
                  "保存 Owner 已准备的单个副本改动。需要准备结果中的 operationId 和 canonicalHash；逐文件执行，冲突时保留副本。",
                parameters: {
                  type: "object",
                  properties: { operationId: { type: "string" }, expectedHash: { type: "string" } },
                  required: ["operationId", "expectedHash"],
                  additionalProperties: false,
                },
              }
            : name === "move_directory"
              ? {
                  name,
                  capabilityRef: `${coding.capabilityRef}.${name}`,
                  capabilityHandleRef: null,
                  description:
                    "在已授权目录内移动或重命名一个目录；目标必须不存在。等待相关文件操作后执行，不支持跨文件系统移动。",
                  parameters: {
                    type: "object",
                    properties: { path: { type: "string" }, destination: { type: "string" } },
                    required: ["path", "destination"],
                    additionalProperties: false,
                  },
                }
              : {
                  definition: "builtin-coding",
                  name,
                  capabilityRef: `${coding.capabilityRef}.${name}`,
                  capabilityHandleRef: null,
                },
        );
    }
    if (this.#options.publicSearch)
      descriptors.push({
        name: "web_search",
        capabilityRef: `${this.#options.publicSearch.capabilityRef}.web_search`,
        capabilityHandleRef: null,
        description:
          "搜索公开互联网的最新资料。查询经用户确认后发送给 Exa；返回来源网址、摘录和查询时间，不能将摘录当作已打开的完整网页。不要把文件正文或凭据放入查询。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 4096 },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      });
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
  #codingTool(call: RuntimeToolInvocation) {
    if (
      this.#options.publicSearch &&
      call.capabilityRef === `${this.#options.publicSearch.capabilityRef}.web_search`
    )
      return "web_search" as const;
    const coding = this.#options.coding;
    return coding?.enabledTools.find(
      (tool) => call.capabilityRef === `${coding.capabilityRef}.${tool}`,
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
        this.#exposed.has(invocation.runId) &&
        ((invocation.capabilityRef === "host.file.read" &&
          this.#options.fileReadEnabled !== false) ||
          this.#codingTool(invocation) !== undefined);
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

  async recoverResult(
    invocation: RuntimeToolInvocation,
    recovery: NonNullable<RuntimeRequest["knownToolResult"]>,
  ): Promise<RuntimeToolSettledResult> {
    const recoveryLease = invocation.context?.executionLease;
    const recoveryDeadline = invocation.executionDeadlineAt;
    if (
      !recoveryLease ||
      !recoveryDeadline ||
      !Number.isFinite(Date.parse(recoveryDeadline)) ||
      this.#options.clock.now() >= recoveryDeadline
    )
      reject();
    if (
      !invocation.context ||
      invocation.toolCallId !== recovery.toolCallId ||
      invocation.capabilityRef !== recovery.capabilityRef ||
      invocation.context.continuationRef !== recovery.continuationRef ||
      !recovery.invocationId.startsWith("runtime-tool:") ||
      !this.#options.completeSandboxToolResult
    )
      reject();
    const artifact = await this.#options.artifacts.lookup({
      runId: invocation.runId,
      purpose: "trace",
      operationKey: `runtime-tool-intent:${recovery.invocationId.slice("runtime-tool:".length)}`,
    });
    if (!artifact) reject();
    const saved = (await this.#readJson(artifact.payloadRef)) as {
      fingerprint?: string;
      request?: unknown;
      recovery?: { version?: string; continuationRef?: string; toolCallId?: string };
    };
    const original = executionV2MessageSchema.parse(saved.request);
    if (
      original.kind !== "request" ||
      original.type !== "work.execute" ||
      original.messageId !== recovery.invocationId ||
      original.scope.runId !== invocation.runId ||
      original.scope.ownerId !== this.#options.ownerId ||
      original.scope.agentId !== this.#options.agentId ||
      saved.recovery?.version !== "tool-batch-recovery.v1" ||
      saved.recovery.continuationRef !== recovery.continuationRef ||
      saved.recovery.toolCallId !== invocation.toolCallId
    )
      reject();
    const receive = async (child: RuntimeToolInvocation): Promise<RuntimeToolSettledResult> => {
      const key = digest([child.runId, child.toolCallId]);
      if (
        `runtime-tool:${key}` !== recovery.invocationId ||
        saved.fingerprint !== digest(executionIdentity(child, original.scope)) ||
        original.payload.capabilityHandleRef !== child.capabilityHandleRef ||
        original.payload.capabilityId !== child.capabilityRef ||
        original.payload.inputRef !== child.arguments["inputRef"]
      )
        reject();
      const admission = await this.#options.sandbox?.preparations?.readAdmissionByInvocation?.({
        runId: child.runId,
        invocationId: recovery.invocationId,
      });
      if (!admission) reject();
      const plan = admission.phase === "bound" ? admission.record.plan : admission.plan;
      if (plan.identity.jobId !== recovery.jobId) reject();
      const assertDisclosure = async () => {
        await this.#options.assertRunActive(child.runId);
        if (
          !child.context ||
          !child.executionDeadlineAt ||
          !Number.isFinite(Date.parse(child.executionDeadlineAt)) ||
          this.#options.clock.now() >= child.executionDeadlineAt ||
          plan.handleRef !== child.capabilityHandleRef ||
          plan.inputRef !== child.arguments["inputRef"]
        )
          reject();
      };
      await assertDisclosure();
      const completion = await this.#options.completeSandboxToolResult?.(
        { runId: child.runId, invocationId: recovery.invocationId },
        {
          assertDisclosure,
          resultRecovery: {
            executionLease: recoveryLease,
            deadlineAt: recoveryDeadline,
          },
          saveReceipt: async (value) => {
            await this.#saveRecoveryJson(child, `runtime-sandbox-delivery:${key}`, value);
          },
        },
      );
      if (!completion) reject();
      const outcome = await this.#completionOutcome(
        child,
        key,
        plan.handleRef,
        completion,
        plan.resourceCeiling.maxOutputBytes,
        true,
        {
          assertDisclosure,
          readOutput: async (ref) => {
            await assertDisclosure();
            const result = admission.phase === "bound" ? admission.record.facts.result : null;
            if (
              !result ||
              (result.kind !== "result" && result.kind !== "error") ||
              result.output.ref !== ref
            )
              reject();
            const payload = await this.#options.payloads.get(ref);
            if (
              !payload ||
              RANK.indexOf(payload.dataClassification) > RANK.indexOf(child.dataClassification)
            )
              reject();
            const bytes = await this.#options.protector.unprotect({
              ownerId: this.#options.ownerId,
              agentId: this.#options.agentId,
              payload,
            });
            if (
              bytes.byteLength !== result.output.byteLength ||
              bytes.byteLength > plan.resourceCeiling.maxOutputBytes ||
              createHash("sha256").update(bytes).digest("hex") !== result.output.digest
            )
              reject();
            await assertDisclosure();
            return { ref, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
          },
        },
      );
      await this.#saveRecoveryJson(child, `runtime-tool-recovered-result:${key}`, outcome);
      return outcome;
    };
    if (invocation.capabilityHandleRef !== null) {
      if (!this.#exposed.get(invocation.runId)?.has(invocation.capabilityHandleRef)) reject();
      return receive(invocation);
    }
    const services = this.#options.fileRead;
    if (!services || !this.#exposed.has(invocation.runId)) reject();
    const key = digest([invocation.runId, invocation.toolCallId]);
    const ctx = this.#workflowContext(invocation, key);
    const recovering: FileReadExecutionContext = {
      ...ctx,
      canResumeAuthority: async (previous) =>
        digest(previous) ===
        digest({
          deploymentId: original.scope.deploymentId,
          authorityEpoch: original.scope.authorityEpoch,
          fencingToken: original.scope.fencingToken,
        }),
      save: async (suffix) => {
        const previous = await this.#options.artifacts.lookup({
          runId: invocation.runId,
          purpose: "trace",
          operationKey: `runtime-file-read:${key}:${suffix}`,
        });
        if (!previous) reject();
        return { ref: previous.payloadRef, value: await this.#readJson(previous.payloadRef) };
      },
      phase: async (handle, phase, inputRef) =>
        receive({
          ...invocation,
          toolCallId: `file-phase:${digest([key, phase])}`,
          capabilityRef: handle.capabilityRef,
          capabilityHandleRef: handle.ref,
          arguments: { inputRef },
        }),
    };
    const readOnlyServices = {
      ...services,
      issue: async (): Promise<never> => {
        throw new Error("RESULT_RECOVERY_CANNOT_ISSUE_HANDLE");
      },
    };
    const coding = this.#codingTool(invocation);
    const result = coding
      ? await executeProductionCodingRequest(invocation, coding, readOnlyServices, recovering)
      : await new ProductionFileReadWorkflow(readOnlyServices).execute(invocation, recovering);
    if (result.outcome === "awaiting_approval" || result.dispatchState === "not_sent") reject();
    return result;
  }

  async #saveRecoveryJson(invocation: RuntimeToolInvocation, operationKey: string, value: unknown) {
    const existing = await this.#options.artifacts.lookup({
      runId: invocation.runId,
      purpose: "trace",
      operationKey,
    });
    if (existing) {
      if (digest(await this.#readJson(existing.payloadRef)) !== digest(value))
        throw new Error("RUNTIME_KNOWN_RESULT_RECEIPT_CHANGED");
      return;
    }
    await this.#writeJson(invocation, operationKey, value);
  }

  async execute(
    value: RuntimeToolInvocation,
    options: Parameters<RuntimeToolPort["execute"]>[1] = {},
  ): Promise<RuntimeToolExecutionResult> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const invocation = await this.#taskStart(value);
    signal?.throwIfAborted();
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
    return this.#executeCanonical(invocation, signal);
  }
  #executeCanonical(
    invocation: RuntimeToolInvocation,
    signal?: AbortSignal,
  ): Promise<RuntimeToolExecutionResult> {
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
        ? this.#executeRequest(invocation, key, signal)
        : this.#execute(invocation, key, fingerprint, false, undefined, signal);
    this.#inFlight.set(key, { fingerprint: attemptFingerprint, result });
    void result.finally(() => this.#inFlight.delete(key)).catch(() => undefined);
    return result;
  }

  async #executeRequest(invocation: RuntimeToolInvocation, key: string, signal?: AbortSignal) {
    if (!this.#exposed.has(invocation.runId) || !this.#options.fileRead) reject();
    const coding = this.#codingTool(invocation);
    if (coding)
      return executeProductionCodingRequest(
        invocation,
        coding,
        this.#options.fileRead,
        this.#workflowContext(invocation, key, signal),
      );
    return new ProductionFileReadWorkflow(this.#options.fileRead).execute(
      invocation,
      this.#workflowContext(invocation, key, signal),
    );
  }

  #workflowContext(
    invocation: RuntimeToolInvocation,
    key: string,
    signal?: AbortSignal,
  ): FileReadExecutionContext {
    if (!this.#exposed.has(invocation.runId) || !this.#options.fileRead) reject();
    const operationKey = (suffix: string) => `runtime-file-read:${key}:${suffix}`;
    return {
      ...(signal ? { signal } : {}),
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      now: () => this.#options.clock.now(),
      authorityFence: () => this.#options.authority().product.fencingToken,
      canResumeAuthority: async (previous) => {
        const codingTool = this.#codingTool(invocation);
        const phases = codingTool ? [codingTool] : ["inspect", "read"];
        for (const phase of phases) {
          const childId = `file-phase:${digest([key, phase])}`;
          const queued = await this.#options.sandbox?.preparations?.readQueuedByInvocation?.({
            runId: invocation.runId,
            invocationId: `runtime-tool:${digest([invocation.runId, childId])}`,
          });
          if (
            queued?.status === "queued" &&
            queued.bindingRevision > 0 &&
            queued.recovery?.toolCallId === invocation.toolCallId &&
            digest(queued.recovery.authority) === digest(previous) &&
            digest(queued.invocation.authority) === digest(this.#options.authority()) &&
            digest(queued.plan.executionLease) === digest(invocation.context?.executionLease)
          )
            return true;
        }
        return false;
      },
      restoreInspection: async (previous) => {
        const read = async (operationKey: string) => {
          const artifact = await this.#options.artifacts.lookup({
            runId: invocation.runId,
            purpose: "trace",
            operationKey,
          });
          return artifact ? this.#readJson(artifact.payloadRef) : undefined;
        };
        const saved = (await read(operationKey("inspect:handle"))) as
          | { handle: GovernedCapabilityExecutionHandle; inputRef: string }
          | undefined;
        if (!saved) return undefined;
        const child = {
          ...invocation,
          toolCallId: `file-phase:${digest([key, "inspect"])}`,
          capabilityHandleRef: saved.handle.ref,
          capabilityRef: saved.handle.capabilityRef,
          arguments: { inputRef: saved.inputRef },
        };
        const childKey = digest([child.runId, child.toolCallId]);
        const intent = (await read(`runtime-tool-intent:${childKey}`)) as
          | { fingerprint?: string }
          | undefined;
        if (intent?.fingerprint !== digest(executionIdentity(child, previous))) return undefined;
        const result = ((await read(`runtime-tool-recovered-result:${childKey}`)) ??
          (await read(`runtime-tool-result:${childKey}`))) as
          | RuntimeToolExecutionResult
          | undefined;
        return result?.outcome === "succeeded" ? result : undefined;
      },
      workerInstanceId: () => this.#options.peer().workerInstanceId,
      assertActive: async () => {
        signal?.throwIfAborted();
        await this.#options.assertRunActive(invocation.runId);
        signal?.throwIfAborted();
      },
      load: async (suffix) => {
        const record = await this.#options.artifacts.lookup({
          runId: invocation.runId,
          purpose: "trace",
          operationKey: operationKey(suffix),
        });
        return record ? this.#readJson(record.payloadRef) : undefined;
      },
      save: async (suffix, value) => {
        // A resumed request reuses the original frozen record. Recommitting
        // a new timestamp or lease under its operation key is a durable conflict.
        // The workflow compares the returned identity before granting any effect.
        const existing = await this.#options.artifacts.lookup({
          runId: invocation.runId,
          purpose: "trace",
          operationKey: operationKey(suffix),
        });
        if (existing)
          return { ref: existing.payloadRef, value: await this.#readJson(existing.payloadRef) };
        const saved = await this.#writeJson(invocation, operationKey(suffix), value);
        return { ref: saved.ref, value: await this.#readJson(saved.ref) };
      },
      fileConflict: async (toolCallId) => {
        if (!toolCallId) return undefined;
        const previousKey = digest([invocation.runId, toolCallId]);
        const read = async (operationKey: string) => {
          const record = await this.#options.artifacts.lookup({
            runId: invocation.runId,
            purpose: "trace",
            operationKey,
          });
          return record ? this.#readJson(record.payloadRef) : undefined;
        };
        const context = (await read(`runtime-file-read:${previousKey}:context`)) as
          | {
              call?: RuntimeToolInvocation;
              binding?: CodingBinding;
              tool?: string;
            }
          | undefined;
        if (
          !context?.call ||
          !context.binding ||
          !context.tool ||
          context.call.runId !== invocation.runId ||
          context.call.toolCallId !== toolCallId ||
          !["write", "edit"].includes(context.tool) ||
          context.call.capabilityHandleRef !== null ||
          context.call.capabilityRef !== `${context.binding.capabilityRef}.${context.tool}`
        )
          return undefined;
        const childKey = digest([
          invocation.runId,
          `file-phase:${digest([previousKey, context.tool])}`,
        ]);
        const result = (await read(`runtime-tool-result:${childKey}`)) as
          | Partial<RuntimeToolSettledResult>
          | undefined;
        const diagnostic = (await read(`runtime-tool-diagnostic:${childKey}`)) as
          | { stage?: string; reasonCode?: string }
          | undefined;
        // A tool's claimed error or a Worker failure alone is insufficient: require
        // the host's persisted non-dispatch fact, so unknown effects never get retried.
        if (
          result?.outcome !== "failed" ||
          result.errorCode !== "FILE_VERSION_CONFLICT" ||
          !["not_dispatched", "verified_no_file_effect"].includes(diagnostic?.stage ?? "") ||
          diagnostic?.reasonCode !== "FILE_VERSION_CONFLICT"
        )
          return undefined;
        const lineage = (await read(`runtime-file-read:${previousKey}:conflict-lineage`)) as
          | { depth?: number }
          | undefined;
        if (context.call.fileConflictOf !== undefined && lineage?.depth === undefined)
          return undefined;
        return {
          call: context.call,
          binding: context.binding,
          depth: lineage?.depth ?? 0,
          dispatchState: diagnostic.stage === "verified_no_file_effect" ? "accepted" : "not_sent",
        };
      },
      phase: async (handle, phase, inputRef) => {
        signal?.throwIfAborted();
        const live = await this.#handle(invocation.runId, handle.ref);
        signal?.throwIfAborted();
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
          signal,
        );
      },
    };
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
    signal?: AbortSignal,
  ): Promise<RuntimeToolExecutionResult> {
    const handle = await this.#validate(invocation, internal);
    const maximum = await this.#options.maximumResourceCeiling?.(
      handle.capabilityRef,
      handle.capabilityVersion,
    );
    const configured = this.#options.ceiling;
    const ceiling = maximum
      ? {
          maxWallTimeMs: Math.min(configured.maxWallTimeMs, maximum.maxWallTimeMs),
          maxCpuTimeMs: Math.min(configured.maxCpuTimeMs, maximum.maxCpuTimeMs),
          maxMemoryBytes: Math.min(configured.maxMemoryBytes, maximum.maxMemoryBytes),
          maxOutputBytes: Math.min(configured.maxOutputBytes, maximum.maxOutputBytes),
          maxProgressEvents: Math.min(configured.maxProgressEvents, maximum.maxProgressEvents),
        }
      : configured;
    const intentKey = {
      runId: invocation.runId,
      purpose: "trace" as const,
      operationKey: `runtime-tool-intent:${key}`,
    };
    const existing = await this.#options.artifacts.lookup(intentKey);
    if (existing) {
      const intent = (await this.#readJson(existing.payloadRef)) as {
        fingerprint?: string;
        request?: unknown;
      };
      const result = await this.#options.artifacts.lookup({
        ...intentKey,
        operationKey: `runtime-tool-result:${key}`,
      });
      const recovered = await this.#options.artifacts.lookup({
        ...intentKey,
        operationKey: `runtime-tool-recovered-result:${key}`,
      });
      const storedResult = recovered ?? result;
      const queued = await this.#options.sandbox?.preparations?.readQueuedByInvocation?.({
        runId: invocation.runId,
        invocationId: `runtime-tool:${key}`,
      });
      if (intent.fingerprint !== fingerprint) {
        const original =
          queued && queued.bindingRevision > 0
            ? executionV2MessageSchema.parse(intent.request)
            : undefined;
        if (
          !original ||
          original.kind !== "request" ||
          original.type !== "work.execute" ||
          original.messageId !== `runtime-tool:${key}` ||
          original.payload.capabilityHandleRef !== handle.ref ||
          digest(queued?.invocation.authority) !== digest(this.#options.authority()) ||
          digest(queued?.plan.executionLease) !== digest(invocation.context?.executionLease) ||
          intent.fingerprint !== digest(executionIdentity(invocation, original.scope))
        )
          throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Tool call identity changed");
      }
      if (!storedResult) {
        if (queued?.status === "queued") {
          const original = executionV2MessageSchema.parse(intent.request);
          if (
            original.kind !== "request" ||
            original.type !== "work.execute" ||
            original.messageId !== `runtime-tool:${key}` ||
            original.payload.capabilityHandleRef !== handle.ref ||
            digest(queued.invocation.authority) !== digest(this.#options.authority()) ||
            digest(queued.plan.executionLease) !== digest(invocation.context?.executionLease) ||
            Object.entries(ceiling).some(
              ([name, limit]) =>
                original.payload.resourceCeiling[name as keyof CapabilityResourceCeiling] > limit,
            )
          )
            throw new ApplicationPortError(
              PORT_ERROR_CODES.NOT_AUTHORITATIVE,
              "Queued execution requires current authority",
            );
          if (intent.fingerprint !== digest(executionIdentity(invocation, original.scope)))
            throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Tool call identity changed");
          const reboundRequest = executionV2MessageSchema.parse({
            ...original,
            scope: { ...original.scope, ...queued.invocation.authority.product },
          }) as ExecuteRequest;
          // Only the durable queue permits re-entry. reserve still atomically
          // compares its snapshot and commits at most one invocation receipt.
          return this.#dispatch(
            invocation,
            key,
            handle,
            reboundRequest,
            ceiling,
            internal,
            parentCall,
            signal,
          );
        }
      }
      let replay = storedResult
        ? ((await this.#readJson(storedResult.payloadRef)) as RuntimeToolExecutionResult)
        : unknownResult();
      if (
        (!storedResult || replay.outcome === "result_unknown") &&
        this.#options.completeSandboxToolResult
      ) {
        const completion = await this.#options.completeSandboxToolResult(
          { runId: invocation.runId, invocationId: `runtime-tool:${key}` },
          {
            assertDisclosure: () => this.#assertDisclosure(invocation, key, internal),
            saveReceipt: async (value) => {
              await this.#writeJson(invocation, `runtime-sandbox-delivery:${key}`, value);
            },
          },
        );
        if (completion) {
          replay = await this.#completionOutcome(
            invocation,
            key,
            handle.ref,
            completion,
            ceiling.maxOutputBytes,
            internal,
          );
          await this.#validate(invocation, internal);
          await this.#writeJson(invocation, `runtime-tool-recovered-result:${key}`, replay);
        }
      }
      if (replay.outcome === "succeeded") {
        await this.#assertDisclosure(invocation, key, internal);
        if (!replay.resultRef) reject();
        await this.#assertOutputObserved(invocation, key, handle.ref, replay.resultRef);
      }
      await this.#validate(invocation, internal);
      return replay;
    }
    const now = this.#options.clock.now();
    const deadlineAt = new Date(
      Math.min(
        Date.parse(handle.expiresAt),
        Date.parse(now) + ceiling.maxWallTimeMs,
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
        resourceCeiling: ceiling,
        requestedAt: now,
        deadlineAt,
      },
    };
    const recoveryCall = parentCall ?? invocation;
    const continuationRef = recoveryCall.context?.continuationRef;
    const committed = await this.#writeJson(invocation, intentKey.operationKey, {
      fingerprint,
      request,
      ...(continuationRef
        ? {
            recovery: {
              version: "tool-batch-recovery.v1",
              continuationRef,
              toolCallId: recoveryCall.toolCallId,
            },
          }
        : {}),
    });
    // A concurrent writer won the durable operation key. Never forward a second request.
    if (committed.replayed)
      return this.#execute(invocation, key, fingerprint, internal, parentCall, signal);
    return this.#dispatch(invocation, key, handle, request, ceiling, internal, parentCall, signal);
  }

  async #dispatch(
    invocation: RuntimeToolInvocation,
    key: string,
    handle: GovernedCapabilityExecutionHandle,
    request: ExecuteRequest,
    ceiling: CapabilityResourceCeiling,
    internal: boolean,
    parentCall?: RuntimeToolInvocation,
    signal?: AbortSignal,
  ): Promise<RuntimeToolExecutionResult> {
    const deadlineAt = request.payload.deadlineAt;
    if (
      request.scope.ownerId !== this.#options.ownerId ||
      request.scope.agentId !== this.#options.agentId ||
      request.scope.runId !== invocation.runId ||
      !request.scope.workerRunId ||
      Date.parse(deadlineAt) <= Date.parse(this.#options.clock.now())
    )
      reject();
    const scope = {
      ...request.scope,
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      runId: invocation.runId,
      workerRunId: request.scope.workerRunId,
    };
    const authority = this.#options.authority();
    const monotonicDeadline =
      performance.now() +
      Math.max(0, Date.parse(deadlineAt) - Date.parse(this.#options.clock.now()));
    const resultRecovery =
      this.#options.sandbox?.preparations?.readAdmissionByInvocation &&
      invocation.context?.executionLease &&
      invocation.executionDeadlineAt &&
      this.#options.completeSandboxToolResult
        ? {
            executionLease: invocation.context.executionLease,
            deadlineAt: invocation.executionDeadlineAt,
          }
        : undefined;
    const replyDeadlineAt = resultRecovery
      ? Math.min(
          Date.parse(deadlineAt) + RECOVERY_SETTLE_WAIT_MS,
          Date.parse(resultRecovery.deadlineAt),
        )
      : Date.parse(deadlineAt);
    const replyMonotonicDeadline =
      performance.now() + Math.max(0, replyDeadlineAt - Date.parse(this.#options.clock.now()));
    const assertResultCurrent = async () => {
      signal?.throwIfAborted();
      if (!resultRecovery || Date.parse(this.#options.clock.now()) < Date.parse(deadlineAt))
        return this.#assertDisclosure(invocation, key, internal);
      await this.#options.assertRunActive(invocation.runId);
      if (
        Date.parse(this.#options.clock.now()) >= replyDeadlineAt ||
        digest(this.#options.authority()) !== digest(authority)
      )
        reject();
    };
    this.#parents.set(request.messageId, {
      parentMessageId: request.messageId,
      parentCorrelationId: request.correlationId,
      bindingRevision: 1,
      bindingDigest: digest(request),
      scope,
      authority: this.#options.peer(),
      dataClassification: invocation.dataClassification,
      resourceCeiling: ceiling,
      deadlineAt,
      capabilityHandleRefs: [handle.ref],
      delegatedContextRefs: [...handle.delegatedContextRefs],
    });
    let outcome = unknownResult();
    let possiblySent = false;
    let forwardingClosed = false;
    let authorityWithdrawn = false;
    const assertCurrent = async () => {
      try {
        signal?.throwIfAborted();
        await assertResultCurrent();
      } catch (error) {
        authorityWithdrawn = true;
        throw error;
      }
    };
    try {
      await this.#options.assertRunActive(invocation.runId);
      const sandbox = this.#options.sandbox;
      let dispatchPlan: Parameters<SandboxAdmission["scopes"]["read"]>[0] | undefined;
      const delegation = sandbox
        ? this.#createDelegation({
            ...sandbox,
            prepare: async (admission) => {
              const prepared = await sandbox.prepare(admission, invocation, parentCall, signal);
              dispatchPlan = prepared.plan;
              return prepared;
            },
          })
        : this.#delegation;
      await beforeDeadline(
        delegation.dispatch(request, async () => {
          // Worker Handle delivery can await I/O. Revalidate the original target
          // and live Grant after that wait; approval and receipt remain historical.
          if (sandbox && dispatchPlan) await sandbox.scopes.read(dispatchPlan, request.causationId);
          const maximum = await this.#options.maximumResourceCeiling?.(
            handle.capabilityRef,
            handle.capabilityVersion,
          );
          if (
            maximum &&
            Object.entries(maximum).some(
              ([name, limit]) =>
                request.payload.resourceCeiling[name as keyof CapabilityResourceCeiling] > limit,
            )
          )
            throw new Error("WORKER_RESOURCE_CEILING_CHANGED");
          await this.#assertDisclosure(invocation, key, internal);
          signal?.throwIfAborted();
          if (forwardingClosed || performance.now() >= monotonicDeadline)
            throw new Error("WORKER_DEADLINE_EXCEEDED");
          possiblySent = true;
        }),
        monotonicDeadline,
      );
      // A replayed admission may belong to a concurrent dispatcher. A missing
      // result is then unknown, even though this instance sent no executable message.
      possiblySent = true;
      let cursor: string | null = null;
      let workerStartedAt: string | undefined;
      while (
        performance.now() < replyMonotonicDeadline &&
        Date.parse(this.#options.clock.now()) < replyDeadlineAt
      ) {
        await this.#options.assertRunActive(invocation.runId);
        const iterator: AsyncIterator<ExecutionV2Event> = this.#options.transport
          .events(cursor)
          [Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await nextWithAuthority(
              iterator.next(),
              replyMonotonicDeadline,
              assertCurrent,
            );
            if (next.done) break;
            const event = next.value;
            cursor = event.payload.cursor;
            if (
              event.type === "work.progress" &&
              event.payload.stage === "worker.execution.started" &&
              event.payload.requestId === request.messageId &&
              event.causationId === request.messageId &&
              event.correlationId === request.correlationId &&
              digest(event.scope) === digest(scope)
            ) {
              workerStartedAt ??= event.payload.occurredAt;
              continue;
            }
            if (
              (event.type !== "work.result" && event.type !== "work.cancelled") ||
              event.payload.requestId !== request.messageId ||
              event.causationId !== request.messageId ||
              event.correlationId !== request.correlationId ||
              digest(event.scope) !== digest(scope)
            )
              continue;
            await assertResultCurrent();
            let completion: WorkerToolCompletion | undefined =
              event.type === "work.result" ? event.payload : undefined;
            if (this.#options.completeSandboxToolResult) {
              const verified = await nextWithAuthority(
                this.#options.completeSandboxToolResult(
                  { runId: invocation.runId, invocationId: request.messageId },
                  {
                    ...(resultRecovery ? { resultRecovery } : {}),
                    assertDisclosure: assertResultCurrent,
                    saveReceipt: async (value) => {
                      await assertResultCurrent();
                      await this.#writeJson(invocation, `runtime-sandbox-delivery:${key}`, value);
                    },
                  },
                ),
                replyMonotonicDeadline,
                assertCurrent,
              );
              if (verified !== null)
                completion = verified ?? {
                  outcome: "result_unknown",
                  outputRef: null,
                  errorCode: null,
                  externalActionId:
                    event.type === "work.result" ? event.payload.externalActionId : null,
                };
            }
            if (event.type === "work.cancelled")
              await this.#writeJson(invocation, `runtime-tool-diagnostic:${key}`, {
                stage: "accepted",
                reasonCode: "WORKER_CANCELLATION_OBSERVED",
                operationId: key,
                invocationId: request.messageId,
                runId: invocation.runId,
                authorityEpoch: authority.product.authorityEpoch,
                occurredAt: this.#options.clock.now(),
                cancellationReason: event.payload.reasonCode,
              });
            if (event.type === "work.cancelled" && !completion) {
              outcome = {
                ...unknownResult(),
                dispatchState: "accepted",
              };
            } else {
              outcome = await this.#completionOutcome(
                invocation,
                key,
                handle.ref,
                completion,
                ceiling.maxOutputBytes,
                internal,
                resultRecovery
                  ? {
                      assertDisclosure: assertResultCurrent,
                      readOutput: (ref) =>
                        this.#readSandboxOutput(
                          invocation,
                          request.messageId,
                          ref,
                          ceiling.maxOutputBytes,
                          assertResultCurrent,
                        ),
                    }
                  : undefined,
              );
            }
            const workerEndedAt = event.type === "work.result" ? event.payload.completedAt : null;
            if (
              workerStartedAt &&
              workerEndedAt &&
              outcome.outcome !== "result_unknown" &&
              Date.parse(workerEndedAt) >= Date.parse(workerStartedAt)
            )
              outcome = {
                ...outcome,
                executionTiming: { startedAt: workerStartedAt, endedAt: workerEndedAt },
              };
            await assertResultCurrent();
            await this.#writeJson(invocation, `runtime-tool-result:${key}`, outcome);
            await assertResultCurrent();
            return outcome;
          }
        } finally {
          // A hung iterator must not extend the tool deadline; its transport owns cancellation.
          void iterator.return?.().catch(() => undefined);
        }
        await beforeDeadline(
          new Promise<void>((resolve) => setTimeout(resolve, EVENT_POLL_MS)),
          replyMonotonicDeadline,
        );
      }
    } catch (error) {
      forwardingClosed = true;
      const fileConflict =
        error instanceof Error &&
        error.message === "SANDBOX_FILE_VERSION_CHANGED" &&
        ["write", "edit"].includes(handle.operation);
      const classification = preDispatchFailure(error);
      const reasonCode = possiblySent
        ? "WORKER_RESULT_RECONCILIATION_REQUIRED"
        : fileConflict
          ? "FILE_VERSION_CONFLICT"
          : classification.reasonCode;
      outcome = possiblySent
        ? unknownResult()
        : fileConflict
          ? fileVersionConflictResult()
          : {
              dispatchState: "not_sent",
              outcome: "failed",
              resultRef: null,
              errorCode: reasonCode,
              externalActionId: null,
              modelContent: classification.modelContent,
            };
      let stopRequest: "not_requested" | "requested" | "unconfirmed" = "not_requested";
      let stopRequestError: string | null = null;
      if (possiblySent && authorityWithdrawn) {
        // A cancel acknowledgement is not effect or resource-release evidence.
        try {
          await beforeDeadline(
            this.#options.transport.request({
              ...request,
              type: "work.cancel",
              messageId: `runtime-tool-stop:${key}`,
              causationId: request.messageId,
              idempotencyKey: `runtime-tool-stop:${key}`,
              payload: {
                targetRequestId: request.messageId,
                reasonCode: "AUTHORITY_WITHDRAWN",
                requestedAt: this.#options.clock.now(),
              },
            }),
            performance.now() + AUTHORITY_STOP_WAIT_MS,
          );
          stopRequest = "requested";
        } catch (stopError) {
          stopRequest = "unconfirmed";
          stopRequestError =
            stopError instanceof Error ? stopError.message.slice(0, 2048) : "unknown";
        }
      }
      if (possiblySent && authorityWithdrawn)
        outcome = {
          ...unknownResult(),
          errorCode: "WORKER_AUTHORITY_WITHDRAWN",
          modelContent:
            stopRequest === "requested"
              ? "执行许可已失效，已请求停止；已产生的效果仍需核验。"
              : "执行许可已失效，停止尚未确认；不能重新执行该操作。",
        };
      let authorityWithdrawalError: string | null = null;
      if (!possiblySent && this.#options.capabilities.revokeExecutionHandle) {
        try {
          await this.#options.capabilities.revokeExecutionHandle(
            handle.ref,
            this.#options.clock.now(),
          );
        } catch (withdrawalError) {
          authorityWithdrawalError =
            withdrawalError instanceof Error ? withdrawalError.message.slice(0, 2048) : "unknown";
        }
      }
      await this.#writeJson(invocation, `runtime-tool-diagnostic:${key}`, {
        authorityWithdrawalError,
        authorityWithdrawn,
        stopRequest,
        stopRequestError,
        stage: possiblySent ? "possibly_sent" : "not_dispatched",
        reasonCode,
        operationId: key,
        invocationId: request.messageId,
        runId: invocation.runId,
        authorityEpoch: authority.product.authorityEpoch,
        occurredAt: this.#options.clock.now(),
        error:
          error instanceof Error
            ? { name: error.name, message: error.message.slice(0, 8192) }
            : { name: "UnknownError" },
      });
      // Never resend an executable message merely because its result is unknown.
    } finally {
      forwardingClosed = true;
    }
    await this.#options.assertRunActive(invocation.runId);
    await this.#writeJson(invocation, `runtime-tool-result:${key}`, outcome);
    return outcome;
  }

  async #completionOutcome(
    invocation: RuntimeToolInvocation,
    key: string,
    handleRef: string,
    completion: WorkerToolCompletion | undefined,
    maxOutputBytes: number,
    internal: boolean,
    recovered?: {
      assertDisclosure(): Promise<void>;
      readOutput(ref: string): Promise<{ ref: string; text: string }>;
    },
  ): Promise<RuntimeToolSettledResult> {
    if (
      completion?.outcome === "failed" &&
      completion.errorCode === "FILE_VERSION_CONFLICT" &&
      completion.outputRef
    ) {
      const delivered = await this.#options.artifacts.lookup({
        runId: invocation.runId,
        purpose: "trace",
        operationKey: `runtime-sandbox-delivery:${key}`,
      });
      const receipt = delivered
        ? ((await this.#readJson(delivered.payloadRef)) as Partial<SandboxToolCompletion>)
        : undefined;
      if (
        receipt?.outcome === "failed" &&
        receipt.errorCode === "FILE_VERSION_CONFLICT" &&
        receipt.outputRef === completion.outputRef
      ) {
        await (recovered?.assertDisclosure() ?? this.#assertDisclosure(invocation, key, internal));
        await this.#saveRecoveryJson(invocation, `runtime-tool-diagnostic:${key}`, {
          stage: "verified_no_file_effect",
          reasonCode: "FILE_VERSION_CONFLICT",
          invocationId: `runtime-tool:${key}`,
          outputRef: completion.outputRef,
        });
        return {
          ...fileVersionConflictResult(),
          dispatchState: "accepted",
          resultRef: completion.outputRef,
          modelContent:
            "目标文件已变化。Worker 已结束发布检查，并核验本次未发布；候选已保留。请读取最新内容后，用新工具调用重新生成；新内容仍须经过原权限检查。",
        };
      }
      return unknownResult();
    }
    if (completion?.outcome === "succeeded") {
      if (!completion.outputRef) throw new Error("WORKER_OUTPUT_MISSING");
      const output = recovered
        ? await recovered.readOutput(completion.outputRef)
        : await this.#observedOutput(
            invocation,
            key,
            handleRef,
            completion.outputRef,
            maxOutputBytes,
            internal,
          );
      return {
        dispatchState: "accepted",
        outcome: "succeeded",
        resultRef: output.ref,
        errorCode: null,
        externalActionId: null,
        modelContent: output.text,
      };
    } else if (!completion || completion.outcome === "result_unknown") {
      return {
        ...unknownResult(),
        dispatchState: "accepted",
        errorCode: completion?.errorCode ?? "WORKER_RESULT_RECONCILIATION_REQUIRED",
        externalActionId: completion?.externalActionId ?? null,
      };
    } else {
      const commandEffectUnverified = completion.errorCode === "SANDBOX_COMMAND_EFFECT_UNVERIFIED";
      if (completion.outputRef && !commandEffectUnverified) {
        const output = recovered
          ? await recovered.readOutput(completion.outputRef)
          : await this.#observedOutput(
              invocation,
              key,
              handleRef,
              completion.outputRef,
              maxOutputBytes,
              internal,
            );
        return {
          dispatchState: "accepted",
          outcome: completion.outcome,
          resultRef: output.ref,
          errorCode: completion.errorCode,
          externalActionId: completion.externalActionId,
          modelContent: output.text,
        };
      }
      return {
        dispatchState: "accepted",
        outcome: completion.outcome,
        resultRef: null,
        errorCode: completion.errorCode,
        externalActionId: completion.externalActionId,
        modelContent:
          completion.errorCode === SANDBOX_TOOL_RESULT_LOST
            ? `${SANDBOX_TOOL_RESULT_LOST}：${SANDBOX_TOOL_RESULT_LOST_MESSAGE}`
            : completion.errorCode === SANDBOX_TOOL_DEADLINE_EXCEEDED
              ? `${SANDBOX_TOOL_DEADLINE_EXCEEDED}：${SANDBOX_TOOL_DEADLINE_EXCEEDED_MESSAGE}`
              : completion.errorCode === SANDBOX_HOST_COMPLETION_CONTRADICTED
                ? `${SANDBOX_HOST_COMPLETION_CONTRADICTED}：${SANDBOX_HOST_COMPLETION_CONTRADICTED_MESSAGE}`
                : completion.errorCode === "SANDBOX_TOOL_NOT_STARTED"
                  ? "工具未启动：准备阶段失败，已确认清理完成。"
                  : commandEffectUnverified
                    ? "命令执行失败，但这不代表工作区没有变化；命令可能已修改工作区文件，具体效果尚未核验。请先检查工作区再决定下一步。"
                    : "操作未确认成功。",
      };
    }
  }

  async #readSandboxOutput(
    invocation: RuntimeToolInvocation,
    invocationId: string,
    ref: string,
    maxOutputBytes: number,
    assertCurrent: () => Promise<void>,
  ): Promise<{ ref: string; text: string }> {
    await assertCurrent();
    const admission = await this.#options.sandbox?.preparations?.readAdmissionByInvocation?.({
      runId: invocation.runId,
      invocationId,
    });
    const result = admission?.phase === "bound" ? admission.record.facts.result : null;
    if (
      !result ||
      (result.kind !== "result" && result.kind !== "error") ||
      result.output.ref !== ref
    )
      reject();
    const payload = await this.#options.payloads.get(ref);
    if (
      !payload ||
      RANK.indexOf(payload.dataClassification) > RANK.indexOf(invocation.dataClassification)
    )
      reject();
    const bytes = await this.#options.protector.unprotect({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      payload,
    });
    if (
      bytes.byteLength > maxOutputBytes ||
      bytes.byteLength !== result.output.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== result.output.digest
    )
      reject();
    await assertCurrent();
    return { ref, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }

  async #observedOutput(
    invocation: RuntimeToolInvocation,
    key: string,
    handleRef: string,
    outputRef: string,
    maxOutputBytes: number,
    internal: boolean,
  ): Promise<{ readonly ref: string; readonly text: string }> {
    await this.#assertDisclosure(invocation, key, internal);
    await this.#assertOutputObserved(invocation, key, handleRef, outputRef);
    const payload = await this.#options.payloads.get(outputRef);
    if (
      !payload ||
      RANK.indexOf(payload.dataClassification) > RANK.indexOf(invocation.dataClassification)
    )
      reject();
    const bytes = await this.#options.protector.unprotect({
      ownerId: this.#options.ownerId,
      agentId: this.#options.agentId,
      payload,
    });
    if (bytes.byteLength > maxOutputBytes) throw new Error("WORKER_OUTPUT_LIMIT_EXCEEDED");
    return { ref: payload.ref, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }

  async #assertOutputObserved(
    invocation: RuntimeToolInvocation,
    key: string,
    handleRef: string,
    outputRef: string,
  ): Promise<void> {
    const observed = await this.#options.results.lookupOutput({
      handleRef,
      invocationId: `runtime-tool:${key}`,
      authority: this.#options.authority(),
      now: this.#options.clock.now(),
    });
    if (observed?.payloadRef === outputRef) return;
    // A recovery artifact alone is insufficient. Only the sandbox completion
    // path can save the protected handoff receipt after fresh effect verification.
    const recovered = await this.#options.artifacts.lookup({
      runId: invocation.runId,
      purpose: "trace",
      operationKey: piFileRecoveryOperationKey(`runtime-tool:${key}`),
    });
    const delivered = await this.#options.artifacts.lookup({
      runId: invocation.runId,
      purpose: "trace",
      operationKey: `runtime-sandbox-delivery:${key}`,
    });
    if (recovered?.payloadRef === outputRef && delivered) {
      const receipt = (await this.#readJson(
        delivered.payloadRef,
      )) as Partial<SandboxToolCompletion>;
      if (receipt.outcome === "succeeded" && receipt.outputRef === outputRef) return;
    }
    throw new Error("WORKER_OUTPUT_OBSERVATION_MISSING");
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
