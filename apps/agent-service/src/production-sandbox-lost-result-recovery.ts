import type {
  CapabilityInvocationAuthority,
  SandboxExecutionJournalPort,
  SandboxExecutionProjectionContext,
  SandboxExecutionRecord,
  SandboxExecutionVerification,
} from "@himawari-agent/application";
import {
  isSandboxExecutionFenceSuperseded,
  SANDBOX_TOOL_RESULT_LOST,
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";

export { SANDBOX_TOOL_RESULT_LOST };

export const SANDBOX_TOOL_RESULT_LOST_MESSAGE =
  "工具已运行并结束，但输出和退出结果在服务重启时丢失；没有重新执行。它可能已经产生了效果，是否重做请先确认。";

export function createProductionSandboxLostResultRecovery(options: {
  journal: Pick<SandboxExecutionJournalPort, "read" | "recordOperation">;
  authority(): CapabilityInvocationAuthority;
  now(): string;
  verifyExited(record: SandboxExecutionRecord): Promise<boolean>;
  saveOutput(
    record: SandboxExecutionRecord,
  ): Promise<{ ref: string; digest: string; byteLength: number }>;
  verifyFresh(record: SandboxExecutionRecord): Promise<SandboxExecutionVerification>;
}) {
  return async (input: SandboxExecutionRecord): Promise<SandboxExecutionRecord> => {
    const record = await options.journal.read(input.plan.identity);
    if (!record || record.plan.semanticFingerprint !== input.plan.semanticFingerprint)
      throw new Error("SANDBOX_TOOL_RESULT_BINDING_CHANGED");
    const { plan, facts } = record;
    if (
      plan.mode !== "foreground" ||
      plan.backendRef !== "srt" ||
      !record.releaseReceipt ||
      record.workspaceBlocked ||
      facts.resource.supervision !== "released" ||
      (facts.result && facts.result.kind !== "unknown") ||
      !isSandboxExecutionFenceSuperseded(plan, options.authority().product) ||
      options.now() >= plan.originalDeadlineAt ||
      !(await options.verifyExited(record))
    )
      return record;
    const output = await options.saveOutput(record);
    const next = sandboxExecutionFactsSchema.parse({
      ...facts,
      result: {
        schemaVersion: "sandbox-execution.v2",
        identity: plan.identity,
        environmentId: plan.environmentId,
        policyDigest: facts.environment.policyDigest,
        contract: { ref: plan.operationContract.ref, version: plan.operationContract.version },
        occurredAt: options.now(),
        kind: "error",
        reasonCode: SANDBOX_TOOL_RESULT_LOST,
        termination: { type: "failure" },
        output,
      },
    });
    const verification = await options.verifyFresh({ ...record, facts: next });
    const context: SandboxExecutionProjectionContext = {
      now: options.now(),
      environment: facts.environment,
      operationContract: plan.operationContract,
      verification,
      releaseReceipt: record.releaseReceipt,
      currentResourceSequence: facts.resource.sequence,
      runState: "terminated",
      currentAuthority: false,
      currentFence: false,
      userDisclosureAllowed: false,
      modelDisclosureAllowed: false,
      conflictingWorkspaceRisk: record.workspaceBlocked ?? true,
      pendingApprovalOrReconciliation: false,
      resultAlreadyDelivered: false,
    };
    try {
      return (
        await options.journal.recordOperation({
          identity: plan.identity,
          expectedSequence: facts.resource.sequence,
          expectedOperationRevision: record.operationRevision,
          facts: next,
          authority: options.authority(),
          now: options.now(),
          context,
        })
      ).record;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "PORT_CONFLICT")
        throw error;
      const latest = await options.journal.read(plan.identity);
      if (!latest || latest.plan.semanticFingerprint !== plan.semanticFingerprint) throw error;
      return latest;
    }
  };
}
