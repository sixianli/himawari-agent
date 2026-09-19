import {
  projectSandboxExecution,
  type CapabilityInvocationAuthority,
  type SandboxExecutionJournalPort,
  type SandboxExecutionProjectionContext,
  type SandboxExecutionRecord,
  type SandboxExecutionVerification,
} from "@himawari-agent/application";
import {
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  PI_WRITE_VERIFIER,
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";

/** Recover facts only after authenticated release. No launch, business mutation,
 * grant issuance or disclosure port is available to this service. */
export function createProductionSandboxFileRecovery(options: {
  readonly journal: Pick<SandboxExecutionJournalPort, "recordOperation">;
  readonly verifyFresh: (record: SandboxExecutionRecord) => Promise<SandboxExecutionVerification>;
  readonly recoverOutput: (
    record: SandboxExecutionRecord,
  ) => Promise<{ ref: string; digest: string; byteLength: number } | undefined>;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly now: () => string;
}) {
  return async (record: SandboxExecutionRecord): Promise<SandboxExecutionRecord> => {
    const { plan } = record;
    if (
      !record.releaseReceipt ||
      record.workspaceBlocked ||
      record.facts.resource.supervision !== "released"
    )
      return record;
    const contract = plan.operationContract;
    if (
      plan.mode !== "foreground" ||
      contract.ref !== PI_FIXED_FILE_CONTRACT.ref ||
      ![PI_FIXED_FILE_CONTRACT.version, PI_PREPARED_FILE_CONTRACT.version].some(
        (version) => version === contract.version,
      ) ||
      contract.kind !== "verified_effect" ||
      contract.verifierRef !== PI_WRITE_VERIFIER.ref ||
      contract.verifierVersion !== PI_WRITE_VERIFIER.version ||
      contract.targetRef !== PI_WRITE_VERIFIER.targetRef ||
      !["write", "edit"].includes(plan.operation) ||
      (record.facts.result && record.facts.result.kind !== "unknown")
    )
      return record;
    const context = (
      verification: SandboxExecutionVerification,
    ): SandboxExecutionProjectionContext => ({
      now: options.now(),
      environment: record.facts.environment,
      operationContract: contract,
      verification,
      releaseReceipt: record.releaseReceipt ?? null,
      currentResourceSequence: verification.resourceSequence,
      runState: "terminated",
      currentAuthority: false,
      currentFence: false,
      userDisclosureAllowed: false,
      modelDisclosureAllowed: false,
      conflictingWorkspaceRisk: record.workspaceBlocked ?? true,
      pendingApprovalOrReconciliation: false,
      resultAlreadyDelivered: false,
    });
    const resource = await options.verifyFresh(record);
    if (
      !projectSandboxExecution(plan, resource.facts, context(resource)).resourceObligationReleased
    )
      return record;
    if (resource.resourceSequence !== record.facts.resource.sequence)
      throw new Error("SANDBOX_RECOVERY_RESOURCE_CHANGED");
    const output = await options.recoverOutput(record);
    if (!output) return record;
    const now = options.now();
    const facts = sandboxExecutionFactsSchema.parse({
      ...record.facts,
      effect: {
        kind: "verified",
        verifierRef: contract.verifierRef,
        verifierVersion: contract.verifierVersion,
        targetRef: contract.targetRef,
        evidence: { ref: output.ref, digest: output.digest },
        occurredAt: now,
      },
      result: {
        schemaVersion: "sandbox-execution.v2",
        identity: plan.identity,
        environmentId: plan.environmentId,
        policyDigest: record.facts.environment.policyDigest,
        contract: { ref: contract.ref, version: contract.version },
        occurredAt: now,
        kind: "result",
        output,
        completion: { type: "value" },
      },
    });
    const verification = await options.verifyFresh({ ...record, facts });
    return (
      await options.journal.recordOperation({
        identity: plan.identity,
        expectedSequence: record.facts.resource.sequence,
        expectedOperationRevision: record.operationRevision,
        facts,
        authority: options.authority(),
        now: options.now(),
        context: context(verification),
      })
    ).record;
  };
}
