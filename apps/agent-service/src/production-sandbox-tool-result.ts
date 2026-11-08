import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CapabilityInvocationAuthority,
  type CapabilityResourceCeiling,
  projectSandboxExecution,
  RECOVERY_SETTLE_WAIT_MS,
  type SandboxExecutionJournalPort,
  type SandboxExecutionPreparationPort,
  type SandboxExecutionProjectionContext,
  type SandboxExecutionRecord,
  type SandboxExecutionVerification,
} from "@himawari-agent/application";
import { isSandboxReservationNeverStarted } from "@himawari-agent/application/sandbox-execution-projection";
import type {
  SandboxEffectObservation,
  SandboxOperationContract,
  SandboxOperationResult,
} from "@himawari-agent/execution-contracts";
import {
  FILE_WRITE_NOT_STARTED,
  isSandboxCeilingExceededReason,
  isSandboxOutputLimitReason,
  isSandboxToolResultLost,
  SANDBOX_CPU_TIME_LIMIT,
  SANDBOX_HOST_COMPLETION_CONTRADICTED,
  SANDBOX_MEMORY_LIMIT,
  SANDBOX_RESOURCE_LIMIT,
  SANDBOX_TOOL_DEADLINE_EXCEEDED,
  SANDBOX_TOOL_NOT_STARTED,
  SRT_BACKEND_REF,
} from "@himawari-agent/execution-contracts";
import { stageTiming } from "./production-stage-timing.js";

export const SANDBOX_HOST_COMPLETION_CONTRADICTED_MESSAGE =
  "执行宿主报告的退出结果前后不一致，本次结果按失败处理，没有重新执行。工具可能已经运行，是否重做请先确认。";

export interface SandboxToolCompletion {
  readonly outcome: "succeeded" | "failed";
  readonly outputRef: string | null;
  readonly errorCode: string | null;
  readonly externalActionId: null;
  readonly processExitCode?: number;
  readonly resourceCeiling?: CapabilityResourceCeiling;
}
export interface SandboxToolDelivery {
  readonly resultRecovery?: {
    readonly executionLease: SandboxExecutionRecord["plan"]["executionLease"];
    readonly deadlineAt: string;
  };
  assertDisclosure(): Promise<void>;
  saveReceipt(value: SandboxToolCompletion): Promise<void>;
}

export function sandboxCommandEffectReason(input: {
  readonly operationKind: SandboxOperationContract["kind"];
  readonly result: SandboxOperationResult | null;
  readonly effectKind: SandboxEffectObservation["kind"];
}): "SANDBOX_COMMAND_EFFECT_UNVERIFIED" | null {
  const result = input.result;
  const nonzeroCommandExit =
    input.operationKind === "command" &&
    input.effectKind === "not_asserted" &&
    (result?.kind === "error"
      ? result.termination.type === "exit" && result.termination.exitCode !== 0
      : result?.kind === "result" &&
        result.completion.type === "exit" &&
        result.completion.exitCode !== 0);
  return nonzeroCommandExit ? "SANDBOX_COMMAND_EFFECT_UNVERIFIED" : null;
}

function commandProcessExitCode(result: SandboxOperationResult): number | undefined {
  const ending =
    result.kind === "result"
      ? result.completion
      : result.kind === "error"
        ? result.termination
        : undefined;
  return ending?.type === "exit" ? ending.exitCode : undefined;
}

export function failedCommandModelContent(
  text: string,
  expected: { readonly operation: string; readonly processExitCode: number },
): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const fields = envelope as Record<string, unknown>;
  const commandExitCode = fields["commandExitCode"];
  const envelopeExitCode =
    commandExitCode === null
      ? 1
      : typeof commandExitCode === "number" &&
          Number.isInteger(commandExitCode) &&
          commandExitCode >= 1 &&
          commandExitCode <= 255
        ? commandExitCode
        : undefined;
  if (
    "effectNotice" in fields ||
    fields["schemaVersion"] !== "pi-result.v1" ||
    fields["tool"] !== expected.operation ||
    fields["isError"] !== true ||
    envelopeExitCode !== expected.processExitCode
  )
    return null;
  const status =
    commandExitCode === null ? "命令没有正常结束" : `命令以退出码 ${envelopeExitCode} 结束`;
  return JSON.stringify({
    effectNotice: `命令执行失败：${status}。Himawari 没有核验这条命令是否改动了工作区；如果它会写入文件，继续前先检查目标文件。`,
    ...fields,
  });
}

export {
  SANDBOX_CPU_TIME_LIMIT,
  SANDBOX_HOST_COMPLETION_CONTRADICTED,
  SANDBOX_MEMORY_LIMIT,
  SANDBOX_OUTPUT_LIMIT,
  SANDBOX_RESOURCE_LIMIT,
  SANDBOX_TOOL_DEADLINE_EXCEEDED,
  SANDBOX_WRITE_EFFECT_UNVERIFIED,
} from "@himawari-agent/execution-contracts";

const limitAmount = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

export function sandboxFailureKeepsOutput(input: {
  readonly operationKind: SandboxOperationContract["kind"];
  readonly reasonCode: string;
  readonly hostResultRejected: boolean;
}) {
  return (
    !input.hostResultRejected &&
    input.reasonCode !== SANDBOX_TOOL_DEADLINE_EXCEEDED &&
    input.reasonCode !== SANDBOX_TOOL_NOT_STARTED &&
    !isSandboxCeilingExceededReason(input.reasonCode) &&
    (input.reasonCode === "FILE_VERSION_CONFLICT" ||
      input.reasonCode === FILE_WRITE_NOT_STARTED ||
      input.operationKind === "fixed_read")
  );
}
const limitBytes = (value: number) =>
  value >= 1_000_000
    ? `${limitAmount(value / 1_000_000)} MB`
    : value >= 1_000
      ? `${limitAmount(value / 1_000)} KB`
      : `${value} 字节`;
export function sandboxCeilingExceededMessage(
  reasonCode: string,
  ceiling: {
    readonly maxCpuTimeMs: number;
    readonly maxMemoryBytes: number;
    readonly maxOutputBytes: number;
  },
): string | null {
  if (isSandboxOutputLimitReason(reasonCode))
    return `${reasonCode}：命令输出的内容超过上限，已被终止并完成清理，没有重新执行。本次允许的上限是输出 ${limitBytes(ceiling.maxOutputBytes)}。它在终止前可能已经修改了工作区，输出已被截断、拿不到完整内容；请改成只输出需要的部分（例如加筛选条件、只取开头几行、或把结果写进文件再分段读）后重试，或者说明这件事做不到。`;
  const limits = `本次允许的上限是 CPU 时间 ${limitAmount(ceiling.maxCpuTimeMs / 1000)} 秒、内存 ${limitAmount(ceiling.maxMemoryBytes / 1_000_000)} MB`;
  const crossed =
    reasonCode === SANDBOX_CPU_TIME_LIMIT
      ? "命令使用的 CPU 时间超过上限"
      : reasonCode === SANDBOX_MEMORY_LIMIT
        ? "命令使用的内存超过上限"
        : reasonCode === SANDBOX_RESOURCE_LIMIT
          ? "命令超过资源上限"
          : null;
  if (crossed === null) return null;
  return `${reasonCode}：${crossed}，已被终止并完成清理，没有重新执行。${limits}。它在终止前可能已经修改了工作区，部分输出不可用；请先检查当前状态，再用更省资源的做法重试，或者说明这件事做不到。`;
}
export const SANDBOX_TOOL_DEADLINE_EXCEEDED_MESSAGE =
  "工具运行超过期限，已被终止并完成清理，没有重新执行。它在终止前可能已经修改了工作区，部分输出不可用；请先检查当前状态再决定下一步。";
export const SANDBOX_WRITE_EFFECT_UNVERIFIED_MESSAGE =
  "文件操作失败，但没能核实文件有没有被改：文件可能已被修改，也可能没有。请先读取目标文件确认当前内容，再决定下一步。";
const RECOVERY_POLL_MS = 250;

function awaitingRecovery(record: SandboxExecutionRecord) {
  const { supervision } = record.facts.resource;
  return supervision === "lost" || supervision === "reconciling";
}

export function createProductionSandboxToolResult(options: {
  preparations: Pick<SandboxExecutionPreparationPort, "readAdmissionByInvocation"> &
    Partial<Pick<SandboxExecutionPreparationPort, "authorizeReservationResult">>;
  journal: SandboxExecutionJournalPort;
  verifyFresh(record: SandboxExecutionRecord): Promise<SandboxExecutionVerification>;
  recoverResult?(record: SandboxExecutionRecord): Promise<SandboxExecutionRecord>;
  releaseUnbound?(input: { runId: string; invocationId: string }): Promise<boolean>;
  authority(): CapabilityInvocationAuthority;
  now(): string;
}) {
  return async (
    input: { runId: string; invocationId: string },
    delivery: SandboxToolDelivery,
  ): Promise<SandboxToolCompletion | null | undefined> => {
    const timing = stageTiming("sandbox.tool_result.timing", { ...input });
    const admission = await options.preparations.readAdmissionByInvocation(input);
    timing.mark("admission_read");
    if (!admission) return null;
    if (admission.phase === "reserved") {
      let reserved = admission;
      if (
        reserved.plan.mode === "foreground" &&
        reserved.plan.backendRef !== SRT_BACKEND_REF &&
        !isSandboxReservationNeverStarted(reserved.plan, reserved.releaseReceipt?.verification) &&
        options.releaseUnbound &&
        (await options.releaseUnbound(input))
      ) {
        const settled = await options.preparations.readAdmissionByInvocation(input);
        if (settled?.phase === "reserved") reserved = settled;
      }
      if (
        reserved.plan.mode !== "foreground" ||
        !isSandboxReservationNeverStarted(reserved.plan, reserved.releaseReceipt?.verification) ||
        reserved.workspaceBlocked
      )
        return undefined;
      if (!options.preparations.authorizeReservationResult)
        throw new Error("SANDBOX_RESULT_AUTHORITY_UNAVAILABLE");
      await delivery.assertDisclosure();
      await options.preparations.authorizeReservationResult({
        identity: reserved.plan.identity,
        authority: options.authority(),
        now: options.now(),
        executionLease: delivery.resultRecovery?.executionLease ?? reserved.plan.executionLease,
        deadlineAt: delivery.resultRecovery?.deadlineAt ?? reserved.plan.effectiveDeadlineAt,
      });
      const result: SandboxToolCompletion = {
        outcome: "failed",
        outputRef: null,
        errorCode: SANDBOX_TOOL_NOT_STARTED,
        externalActionId: null,
      };
      await delivery.saveReceipt(result);
      await delivery.assertDisclosure();
      return result;
    }
    let record = admission.record;
    const { plan } = record;
    if (plan.mode !== "foreground") return null;
    if (plan.identity.runId !== input.runId || plan.identity.invocationId !== input.invocationId)
      throw new Error("SANDBOX_TOOL_RESULT_BINDING_CHANGED");
    const waitUntil = performance.now() + RECOVERY_SETTLE_WAIT_MS;
    const intentId = `sandbox-tool-result:${createHash("sha256").update(plan.semanticFingerprint).digest("hex")}`;
    const readCurrent = async () => {
      const latest = await options.preparations.readAdmissionByInvocation(input);
      if (
        latest?.phase !== "bound" ||
        latest.record.plan.semanticFingerprint !== plan.semanticFingerprint
      )
        throw new Error("SANDBOX_TOOL_RESULT_BINDING_CHANGED");
      return latest.record;
    };
    const prepare = async () => {
      for (;;) {
        if (performance.now() >= waitUntil) throw new Error("SANDBOX_RECOVERY_UNSETTLED");
        const observed = record;
        try {
          while (awaitingRecovery(record)) {
            if (record.recovery?.status === "unresolved") return undefined;
            if (performance.now() >= waitUntil) throw new Error("SANDBOX_RECOVERY_UNSETTLED");
            await delay(RECOVERY_POLL_MS);
            record = await readCurrent();
          }
          if (
            (!record.facts.result || record.facts.result.kind === "unknown") &&
            options.recoverResult
          )
            record = await options.recoverResult(record);
          const result = record.facts.result;
          if (!result || result.kind === "unknown" || result.kind === "started") return undefined;
          await delivery.assertDisclosure();
          timing.mark("disclosure");
          const verification = await options.verifyFresh(record);
          timing.mark("verify_fresh");
          const context: SandboxExecutionProjectionContext = {
            ...(delivery.resultRecovery
              ? { resultDeliveryDeadlineAt: delivery.resultRecovery.deadlineAt }
              : {}),
            now: options.now(),
            environment: record.facts.environment,
            operationContract: plan.operationContract,
            verification,
            releaseReceipt: record.releaseReceipt ?? null,
            currentResourceSequence: verification.facts.resource.sequence,
            runState: "active",
            currentAuthority: true,
            currentFence: true,
            userDisclosureAllowed: false,
            modelDisclosureAllowed: true,
            conflictingWorkspaceRisk: false,
            pendingApprovalOrReconciliation: false,
            resultAlreadyDelivered: false,
          };
          const projection = projectSandboxExecution(plan, verification.facts, context);
          if (!projection.deliverToolResult) return undefined;
          await delivery.assertDisclosure();
          if (verification.facts.resource.sequence !== record.facts.resource.sequence)
            record = (
              await options.journal.append({
                identity: plan.identity,
                expectedSequence: record.facts.resource.sequence,
                expectedOperationRevision: record.operationRevision,
                facts: verification.facts,
                authority: options.authority(),
                now: options.now(),
                context,
              })
            ).record;
          const intent = () => ({
            ...(delivery.resultRecovery
              ? { resultRecoveryLease: delivery.resultRecovery.executionLease }
              : {}),
            identity: plan.identity,
            intentId,
            kind: "tool_result" as const,
            expectedSequence: record.facts.resource.sequence,
            authority: options.authority(),
            now: options.now(),
            context,
          });
          timing.mark("journal_append");
          await options.journal.prepareIntent(intent());
          timing.mark("prepare_intent");
          return { result, projection, context, intent };
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "PORT_CONFLICT")
            throw error;
          const latest = await readCurrent();
          if (
            latest.operationRevision === observed.operationRevision &&
            latest.facts.resource.sequence === observed.facts.resource.sequence
          )
            throw error;
          await delivery.assertDisclosure();
          record = latest;
        }
      }
    };
    const prepared = await prepare();
    if (!prepared) return undefined;
    const { result, projection, context, intent } = prepared;
    await delivery.assertDisclosure();
    await options.journal.dispatchIntent(intent());
    timing.mark("dispatch_intent");
    try {
      await delivery.assertDisclosure();
      const hostResultRejected =
        result.kind === "error" &&
        (isSandboxToolResultLost(result) ||
          result.reasonCode === SANDBOX_HOST_COMPLETION_CONTRADICTED);
      const commandEffectReason = hostResultRejected
        ? null
        : sandboxCommandEffectReason({
            operationKind: record.plan.operationContract.kind,
            result: record.facts.result,
            effectKind: record.facts.effect.kind,
          });
      const processExitCode = commandEffectReason ? commandProcessExitCode(result) : undefined;
      const failureReason =
        (hostResultRejected ? result.reasonCode : commandEffectReason) ??
        (result.kind === "error" ? result.reasonCode : "SANDBOX_COMMAND_FAILED");
      const completion: SandboxToolCompletion =
        projection.conclusion === "succeeded"
          ? {
              outcome: "succeeded",
              outputRef: result.output.ref,
              errorCode: null,
              externalActionId: null,
            }
          : {
              outcome: "failed",
              outputRef:
                processExitCode !== undefined ||
                (result.kind === "error" &&
                  sandboxFailureKeepsOutput({
                    operationKind: plan.operationContract.kind,
                    reasonCode: result.reasonCode,
                    hostResultRejected,
                  }))
                  ? result.output.ref
                  : null,
              errorCode: failureReason,
              externalActionId: null,
              ...(isSandboxCeilingExceededReason(failureReason)
                ? { resourceCeiling: plan.resourceCeiling }
                : {}),
              ...(processExitCode === undefined ? {} : { processExitCode }),
            };
      await delivery.saveReceipt(completion);
      timing.mark("receipt");
      await options.journal.acknowledgeIntent({
        identity: plan.identity,
        intentId,
        authority: options.authority(),
        now: options.now(),
        context,
      });
      timing.finish("acknowledge");
      return completion;
    } catch (error) {
      await options.journal.observeIntent({
        identity: plan.identity,
        intentId,
        authority: options.authority(),
        now: options.now(),
        reasonCode: "SANDBOX_TOOL_HANDOFF_UNCONFIRMED",
      });
      throw error;
    }
  };
}
