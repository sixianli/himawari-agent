import { createHash } from "node:crypto";
import type {
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  RuntimeToolExecutionResult,
  SandboxExecutionRecord,
  SandboxResourceOutputPage,
} from "@himawari-agent/application";

export const MANAGED_TASK_ACTIONS = ["status", "output", "cancel"] as const;
export type ManagedTaskAction = (typeof MANAGED_TASK_ACTIONS)[number];
export interface ProductionManagedTasks {
  execute(invocation: RuntimeToolInvocation): Promise<RuntimeToolExecutionResult>;
}
export function managedTaskDescriptors(): RuntimeToolDescriptor[] {
  return MANAGED_TASK_ACTIONS.map((action) => ({
    capabilityRef: `execution.task.${action}`,
    capabilityHandleRef: null,
    name: `execution_task_${action}`,
    description:
      action === "status"
        ? "查询本 Run 创建任务的实际状态、观察时间和过期标记。"
        : action === "output"
          ? "分页读取本 Run 任务已保存的输出；不会启动或重启任务。"
          : "停止本 Run 创建的原任务，返回实际停止或待核查状态。",
    parameters: {
      type: "object",
      properties: {
        resourceRef: { type: "string" },
        ...(action === "output"
          ? {
              cursor: { type: ["string", "null"] },
              limit: { type: "integer", minimum: 1, maximum: 32768 },
            }
          : {}),
      },
      required: ["resourceRef"],
      additionalProperties: false,
    },
  }));
}
/** Management never consumes an execution Grant or constructs a launch request.
 * The original resource and current caller must both pass the product authority reader. */
export function createProductionManagedTasks(options: {
  resolve(invocation: RuntimeToolInvocation, resourceRef: string): Promise<SandboxExecutionRecord>;
  observe(record: SandboxExecutionRecord, stop: boolean): Promise<SandboxExecutionRecord>;
  output(
    record: SandboxExecutionRecord,
    cursor: string | null,
    limit: number,
  ): Promise<SandboxResourceOutputPage>;
  readOutput(
    invocation: RuntimeToolInvocation,
    record: SandboxExecutionRecord,
    ref: string,
  ): Promise<string>;
  load(invocation: RuntimeToolInvocation, key: string): Promise<unknown>;
  save(
    invocation: RuntimeToolInvocation,
    key: string,
    value: unknown,
  ): Promise<{ ref: string; value: unknown }>;
  termination(record: SandboxExecutionRecord): Promise<unknown>;
  now(): string;
}): ProductionManagedTasks {
  return {
    async execute(invocation) {
      const action = invocation.capabilityRef.replace("execution.task.", "") as ManagedTaskAction;
      const args = invocation.arguments;
      if (
        !MANAGED_TASK_ACTIONS.includes(action) ||
        typeof args["resourceRef"] !== "string" ||
        Object.keys(args).some(
          (name) =>
            !["resourceRef", ...(action === "output" ? ["cursor", "limit"] : [])].includes(name),
        )
      )
        throw new Error("MANAGED_TASK_INPUT_INVALID");
      const resourceRef = args["resourceRef"];
      const cursor = args["cursor"] ?? null;
      const limit = args["limit"] ?? 8192;
      if (
        (cursor !== null && typeof cursor !== "string") ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 32768
      )
        throw new Error("MANAGED_TASK_INPUT_INVALID");
      const key = `managed-task:${createHash("sha256")
        .update(JSON.stringify([invocation.runId, invocation.toolCallId]))
        .digest("hex")}`;
      let record = await options.resolve(invocation, resourceRef);
      const intent = await options.save(invocation, `${key}:intent`, invocation);
      if (JSON.stringify(intent.value) !== JSON.stringify(invocation))
        throw new Error("MANAGED_TASK_REPLAY_CHANGED");
      const previous = await options.load(invocation, `${key}:result`);
      if (previous !== undefined) return previous as RuntimeToolExecutionResult;
      let value: unknown;
      if (action === "output") {
        const page = await options.output(record, cursor, limit);
        const text = await options.readOutput(invocation, record, page.output.ref);
        let readable: string | null = null;
        try {
          const decoded = new TextDecoder("utf8", { fatal: true }).decode(
            Buffer.from(text, "base64"),
          );
          if (
            !Array.from(decoded).some(
              (character) =>
                character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)),
            ) &&
            Buffer.byteLength(JSON.stringify(decoded)) <= 16384
          )
            readable = decoded;
        } catch {
          /* Binary or a code point split at the page boundary stays lossless base64. */
        }
        value = { ...page, encoding: "base64", bytesBase64: text, text: readable };
      } else {
        record = await options.observe(record, action === "cancel");
        const resource = record.facts.resource;
        value = {
          resourceRef,
          status: resource.status,
          supervision: resource.supervision,
          cleanup: resource.cleanup,
          observedAt: resource.occurredAt,
          termination: await options.termination(record),
          stale:
            resource.supervision === "released"
              ? false
              : resource.supervision !== "controlled" ||
                options.now() >= resource.evidence.validUntil,
          deadlineAt: record.plan.effectiveDeadlineAt,
        };
      }
      await options.resolve(invocation, resourceRef);
      const saved = await options.save(invocation, `${key}:output`, value);
      const result: RuntimeToolExecutionResult = {
        outcome: "succeeded",
        resultRef: saved.ref,
        errorCode: null,
        externalActionId: null,
        modelContent: JSON.stringify(saved.value),
      };
      return (await options.save(invocation, `${key}:result`, result))
        .value as RuntimeToolExecutionResult;
    },
  };
}
