import { createHash } from "node:crypto";
import {
  type CapabilityInvocationAuthority,
  projectSandboxExecution,
  type SandboxExecutionJournalPort,
  type SandboxExecutionPreparationPort,
  type SandboxExecutionProjectionContext,
  type SandboxExecutionRecord,
  type SandboxExecutionVerification,
} from "@himawari-agent/application";

export interface SandboxToolCompletion {
  readonly outcome: "succeeded" | "failed";
  readonly outputRef: string | null;
  readonly errorCode: string | null;
  readonly externalActionId: null;
}
export interface SandboxToolDelivery {
  /** Recheck the original Handle, Run, authority, Grant and model disclosure. */
  assertDisclosure(): Promise<void>;
  /** A protected receipt for this handoff, separate from the returned tool result. */
  saveReceipt(value: SandboxToolCompletion): Promise<void>;
}

/** Worker completion is a notification. Only the Agent's existing verified
 * projection and durable continuation intents can hand a foreground result to Pi.
 */
export function createProductionSandboxToolResult(options: {
  preparations: Pick<SandboxExecutionPreparationPort, "readAdmissionByInvocation">;
  journal: SandboxExecutionJournalPort;
  verifyFresh(record: SandboxExecutionRecord): Promise<SandboxExecutionVerification>;
  authority(): CapabilityInvocationAuthority;
  now(): string;
}) {
  return async (
    input: { runId: string; invocationId: string },
    delivery: SandboxToolDelivery,
  ): Promise<SandboxToolCompletion | null | undefined> => {
    const admission = await options.preparations.readAdmissionByInvocation(input);
    if (!admission) return null;
    if (admission.phase !== "bound") return undefined;
    let record = admission.record;
    const { plan } = record;
    if (plan.mode !== "foreground") return null;
    if (plan.identity.runId !== input.runId || plan.identity.invocationId !== input.invocationId)
      throw new Error("SANDBOX_TOOL_RESULT_BINDING_CHANGED");
    const result = record.facts.result;
    if (!result || result.kind === "unknown" || result.kind === "started") return undefined;
    await delivery.assertDisclosure();
    const verification = await options.verifyFresh(record);
    const context: SandboxExecutionProjectionContext = {
      now: options.now(),
      environment: record.facts.environment,
      operationContract: plan.operationContract,
      verification,
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
    const intentId = `sandbox-tool-result:${createHash("sha256").update(plan.semanticFingerprint).digest("hex")}`;
    const intent = () => ({
      identity: plan.identity,
      intentId,
      kind: "tool_result" as const,
      expectedSequence: record.facts.resource.sequence,
      authority: options.authority(),
      now: options.now(),
      context,
    });
    await options.journal.prepareIntent(intent());
    await delivery.assertDisclosure();
    if (!(await options.journal.dispatchIntent(intent())).applied) return undefined;
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
              outputRef: null,
              errorCode: result.kind === "error" ? result.reasonCode : "SANDBOX_COMMAND_FAILED",
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
