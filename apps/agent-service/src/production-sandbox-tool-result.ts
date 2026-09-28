import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CapabilityInvocationAuthority,
  projectSandboxExecution,
  type SandboxExecutionJournalPort,
  type SandboxExecutionPreparationPort,
  type SandboxExecutionProjectionContext,
  type SandboxExecutionRecord,
  type SandboxExecutionVerification,
} from "@himawari-agent/application";
import type {
  SandboxEffectObservation,
  SandboxOperationContract,
  SandboxOperationResult,
} from "@himawari-agent/execution-contracts";

export interface SandboxToolCompletion {
  readonly outcome: "succeeded" | "failed";
  readonly outputRef: string | null;
  readonly errorCode: string | null;
  readonly externalActionId: null;
}
export interface SandboxToolDelivery {
  readonly resultRecovery?: {
    readonly executionLease: SandboxExecutionRecord["plan"]["executionLease"];
    readonly deadlineAt: string;
  };
  /** Recheck the original Handle, Run, authority, Grant and model disclosure. */
  assertDisclosure(): Promise<void>;
  /** A protected receipt for this handoff, separate from the returned tool result. */
  saveReceipt(value: SandboxToolCompletion): Promise<void>;
}

/** A nonzero shell exit is a known command failure, but it does not prove that
 * the command left the workspace unchanged. Preserve that distinction for Pi
 * and the durable execution projection. */
export function sandboxCommandEffectReason(input: {
  readonly operationKind: SandboxOperationContract["kind"];
  readonly result: SandboxOperationResult | null;
  readonly effectKind: SandboxEffectObservation["kind"];
}): "SANDBOX_COMMAND_EFFECT_UNVERIFIED" | null {
  const result = input.result;
  return input.operationKind === "command" &&
    result?.kind === "error" &&
    result.termination.type === "exit" &&
    result.termination.exitCode !== 0 &&
    input.effectKind === "not_asserted"
    ? "SANDBOX_COMMAND_EFFECT_UNVERIFIED"
    : null;
}

const RECOVERY_SETTLE_WAIT_MS = 35000;
const RECOVERY_POLL_MS = 250;

function awaitingRecovery(record: SandboxExecutionRecord) {
  const { supervision } = record.facts.resource;
  return supervision === "lost" || supervision === "reconciling";
}

/** Worker completion is a notification. Only the Agent's existing verified
 * projection and durable continuation intents can hand a foreground result to Pi.
 */
export function createProductionSandboxToolResult(options: {
  preparations: Pick<SandboxExecutionPreparationPort, "readAdmissionByInvocation"> &
    Partial<Pick<SandboxExecutionPreparationPort, "authorizeReservationResult">>;
  journal: SandboxExecutionJournalPort;
  verifyFresh(record: SandboxExecutionRecord): Promise<SandboxExecutionVerification>;
  recoverResult?(record: SandboxExecutionRecord): Promise<SandboxExecutionRecord>;
  authority(): CapabilityInvocationAuthority;
  now(): string;
}) {
  return async (
    input: { runId: string; invocationId: string },
    delivery: SandboxToolDelivery,
  ): Promise<SandboxToolCompletion | null | undefined> => {
    const admission = await options.preparations.readAdmissionByInvocation(input);
    if (!admission) return null;
    if (admission.phase === "reserved") {
      if (
        admission.plan.mode !== "foreground" ||
        admission.releaseReceipt?.verification.basis !== "host_never_started" ||
        admission.workspaceBlocked
      )
        return undefined;
      if (!options.preparations.authorizeReservationResult)
        throw new Error("SANDBOX_RESULT_AUTHORITY_UNAVAILABLE");
      await delivery.assertDisclosure();
      await options.preparations.authorizeReservationResult({
        identity: admission.plan.identity,
        authority: options.authority(),
        now: options.now(),
        executionLease: delivery.resultRecovery?.executionLease ?? admission.plan.executionLease,
        deadlineAt: delivery.resultRecovery?.deadlineAt ?? admission.plan.effectiveDeadlineAt,
      });
      const result: SandboxToolCompletion = {
        outcome: "failed",
        outputRef: null,
        errorCode: "SANDBOX_TOOL_NOT_STARTED",
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
          const verification = await options.verifyFresh(record);
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
          await options.journal.prepareIntent(intent());
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
    // A repeated handoff retries only the immutable receipt, never executable work.
    await options.journal.dispatchIntent(intent());
    try {
      await delivery.assertDisclosure();
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
                result.kind === "error" &&
                (result.reasonCode === "FILE_VERSION_CONFLICT" ||
                  plan.operationContract.kind === "fixed_read")
                  ? result.output.ref
                  : null,
              errorCode:
                sandboxCommandEffectReason({
                  operationKind: record.plan.operationContract.kind,
                  result: record.facts.result,
                  effectKind: record.facts.effect.kind,
                }) ?? (result.kind === "error" ? result.reasonCode : "SANDBOX_COMMAND_FAILED"),
              externalActionId: null,
            };
      await delivery.saveReceipt(completion);
      await options.journal.acknowledgeIntent({
        identity: plan.identity,
        intentId,
        authority: options.authority(),
        now: options.now(),
        context,
      });
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
