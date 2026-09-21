import {
  type CapabilityInvocationAuthority,
  projectSandboxExecution,
  type SandboxExecutionJournalPort,
  type SandboxExecutionProjectionContext,
  type SandboxExecutionRecord,
  type SandboxExecutionVerification,
} from "@himawari-agent/application";
import {
  DIRECTORY_MOVE_VERIFIER,
  PI_DIRECTORY_MOVE_CONTRACT,
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
  ) => Promise<
    | { ref: string; digest: string; byteLength: number; outcome?: "published" | "conflict" }
    | undefined
  >;
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
    const moving =
      contract.version === PI_DIRECTORY_MOVE_CONTRACT.version &&
      plan.operation === "move_directory";
    const verifier = moving ? DIRECTORY_MOVE_VERIFIER : PI_WRITE_VERIFIER;
    if (
      plan.mode !== "foreground" ||
      contract.ref !== PI_FIXED_FILE_CONTRACT.ref ||
      ![
        PI_FIXED_FILE_CONTRACT.version,
        PI_PREPARED_FILE_CONTRACT.version,
        PI_DIRECTORY_MOVE_CONTRACT.version,
      ].some((version) => version === contract.version) ||
      contract.kind !== "verified_effect" ||
      contract.verifierRef !== verifier.ref ||
      contract.verifierVersion !== verifier.version ||
      contract.targetRef !== verifier.targetRef ||
      !(moving || ["write", "edit"].includes(plan.operation)) ||
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
        ...(output.outcome === "conflict"
          ? { kind: "error", reasonCode: "FILE_VERSION_CONFLICT", termination: { type: "failure" } }
          : { kind: "result", completion: { type: "value" } }),
        output: { ref: output.ref, digest: output.digest, byteLength: output.byteLength },
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
