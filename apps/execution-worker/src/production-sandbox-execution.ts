import { createHash } from "node:crypto";
import type {
  SandboxExecutionPlan,
  SandboxExecutionPort,
  SandboxJobIdentity,
  SandboxJobReceipt,
} from "@himawari-agent/application";
import {
  type ExecutionV2Request,
  executionV2MessageSchema,
  sandboxExecutionPlanSchema,
  sandboxJobIdentitySchema,
  sandboxJobReceiptSchema,
} from "@himawari-agent/execution-contracts";

type Execute = Extract<ExecutionV2Request, { type: "work.execute" }>;
type Control = Extract<ExecutionV2Request, { type: "work.cancel" | "work.reconcile" }>;
export interface BoundSandboxExecution {
  readonly plan: SandboxExecutionPlan;
  readonly lifecycle: SandboxExecutionPort & {
    wait(identity: SandboxJobIdentity): Promise<SandboxJobReceipt>;
  };
}
export interface SandboxWorkerResult {
  readonly outcome: "succeeded" | "failed" | "result_unknown";
  readonly outputRef: string | null;
  readonly errorCode: string | null;
  readonly externalActionId: string | null;
}
export function sandboxExternalActionId(identity: SandboxJobIdentity): string {
  return `sandbox-job:${createHash("sha256")
    .update(JSON.stringify(sandboxJobIdentitySchema.parse(identity)))
    .digest("hex")}`;
}
interface Entry {
  readonly request: Execute;
  cancelled: boolean;
  binding?: BoundSandboxExecution;
  completion?: Promise<SandboxWorkerResult>;
}

/** Routes an authenticated execution request through the existing durable lifecycle.
 * bind must resolve the frozen plan through the broker and provide scope/qualification
 * verification. This adapter never grants authority or launches a process itself. */
export class ProductionSandboxExecution {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly options: {
    readonly bind: (request: Execute) => Promise<BoundSandboxExecution>;
    readonly now: () => string;
  };
  constructor(options: {
    readonly bind: (request: Execute) => Promise<BoundSandboxExecution>;
    readonly now: () => string;
  }) {
    this.options = options;
  }

  handles(requestId: string): boolean {
    return this.entries.has(requestId);
  }
  private unknown(identity: SandboxJobIdentity): SandboxWorkerResult {
    return {
      outcome: "result_unknown",
      outputRef: null,
      errorCode: null,
      externalActionId: sandboxExternalActionId(identity),
    };
  }
  private result(value: SandboxJobReceipt): SandboxWorkerResult {
    const receipt = sandboxJobReceiptSchema.parse(value);
    if (receipt.state === "completed")
      return {
        outcome: "succeeded",
        outputRef: receipt.outputRef,
        errorCode: null,
        externalActionId: null,
      };
    if (receipt.state === "failed")
      return {
        outcome: "failed",
        outputRef: null,
        errorCode: receipt.reasonCode ?? "SANDBOX_EXECUTION_FAILED",
        externalActionId: null,
      };
    return this.unknown(receipt.identity);
  }
  execute(value: Execute): Promise<SandboxWorkerResult> {
    const request = executionV2MessageSchema.parse(value);
    if (request.type !== "work.execute" || !request.payload.sandboxJob)
      throw new Error("SANDBOX_JOB_REQUIRED");
    if (this.closed) throw new Error("SANDBOX_WORKER_STOPPED");
    const previous = this.entries.get(request.messageId);
    if (previous) {
      if (
        executionV2MessageSchema.serialize(previous.request) !==
        executionV2MessageSchema.serialize(request)
      )
        throw new Error("SANDBOX_REQUEST_CHANGED");
      if (!previous.completion) throw new Error("SANDBOX_EXECUTION_REENTRANT");
      return previous.completion;
    }
    const entry: Entry = { request, cancelled: false };
    this.entries.set(request.messageId, entry);
    entry.completion = this.run(entry);
    return entry.completion;
  }
  private async run(entry: Entry): Promise<SandboxWorkerResult> {
    const request = entry.request;
    const identity = request.payload.sandboxJob;
    if (!identity) throw new Error("SANDBOX_JOB_REQUIRED");
    try {
      const resolved = await this.options.bind(request);
      const plan = sandboxExecutionPlanSchema.parse(resolved.plan);
      if (
        JSON.stringify(plan.identity) !== JSON.stringify(identity) ||
        plan.handleRef !== request.payload.capabilityHandleRef ||
        plan.inputRef !== request.payload.inputRef ||
        plan.capabilityRef !== request.payload.capabilityId ||
        plan.capabilityVersion !== request.payload.capabilityVersion ||
        plan.operation !== request.payload.operation ||
        (request.authorizationRef !== null && plan.authorizationRef !== request.authorizationRef) ||
        plan.executionLease.deploymentId !== request.scope.deploymentId ||
        plan.executionLease.authorityEpoch !== request.scope.authorityEpoch ||
        plan.executionLease.fencingToken !== request.scope.fencingToken ||
        plan.effectiveDeadlineAt > request.payload.deadlineAt ||
        Object.entries(plan.resourceCeiling).some(
          ([key, value]) =>
            value > request.payload.resourceCeiling[key as keyof typeof plan.resourceCeiling],
        )
      )
        throw new Error("SANDBOX_EXECUTION_BINDING_CHANGED");
      entry.binding = { plan, lifecycle: resolved.lifecycle };
      const lifecycle = resolved.lifecycle;
      if (entry.cancelled || this.closed || this.options.now() >= plan.effectiveDeadlineAt) {
        await lifecycle.cancel(
          identity,
          entry.cancelled || this.closed ? "owner_cancelled" : "deadline_exceeded",
        );
      } else {
        const prepared = await lifecycle.prepare(plan);
        if (entry.cancelled || this.closed) await lifecycle.cancel(identity, "owner_cancelled");
        else if (prepared.state === "prepared") await lifecycle.start(identity);
        else await lifecycle.reconcile(identity);
      }
      return this.result(await lifecycle.wait(identity));
    } catch {
      // A failed start RPC can have committed. Never report a known failure or retry it.
      return this.unknown(identity);
    }
  }
  private entry(request: Control): Entry {
    const entry = this.entries.get(request.payload.targetRequestId);
    if (
      !entry ||
      [
        "deploymentId",
        "authorityEpoch",
        "fencingToken",
        "ownerId",
        "agentId",
        "runId",
        "workerRunId",
      ].some(
        (key) =>
          entry.request.scope[key as keyof typeof request.scope] !==
          request.scope[key as keyof typeof request.scope],
      )
    )
      throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
    return entry;
  }
  async cancel(request: Extract<Control, { type: "work.cancel" }>): Promise<void> {
    const entry = this.entry(request);
    entry.cancelled = true;
    if (entry.binding)
      await entry.binding.lifecycle.cancel(entry.binding.plan.identity, "owner_cancelled");
  }
  async reconcile(
    request: Extract<Control, { type: "work.reconcile" }>,
  ): Promise<SandboxWorkerResult> {
    const entry = this.entry(request);
    const identity = entry.request.payload.sandboxJob;
    if (!identity) throw new Error("SANDBOX_JOB_REQUIRED");
    if (request.payload.externalActionId !== sandboxExternalActionId(identity))
      throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
    if (!entry.binding) return this.unknown(identity);
    return this.result(await entry.binding.lifecycle.reconcile(identity));
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        entry.cancelled = true;
        if (entry.binding)
          await entry.binding.lifecycle.cancel(entry.binding.plan.identity, "owner_cancelled");
        await entry.completion;
      }),
    );
  }
}
