import { createHash } from "node:crypto";
import type {
  CapabilityInvocationAuthority,
  PayloadProtectorPort,
  PayloadRecord,
  PayloadStorePort,
  SandboxExecutionJournalPort,
  SandboxExecutionProjectionContext,
  SandboxExecutionRecord,
} from "@himawari-agent/application";
import type {
  SandboxExecutionFacts,
  SandboxTaskTermination,
} from "@himawari-agent/execution-contracts";
import type { createProductionSandboxStream } from "./production-sandbox-stream.js";

export function createProductionSandboxStreamResultRecovery(options: {
  journal: Pick<SandboxExecutionJournalPort, "read" | "readResultRecovery" | "importResult">;
  authority(): CapabilityInvocationAuthority;
  now(): string;
  stream: ReturnType<typeof createProductionSandboxStream>;
  payloads: Pick<PayloadStorePort, "get">;
  protector: PayloadProtectorPort;
  nextRef(): string;
  facts(
    record: SandboxExecutionRecord,
    bytes: Uint8Array,
    termination: SandboxTaskTermination,
    output: { ref: string; digest: string; byteLength: number },
  ): Promise<SandboxExecutionFacts>;
}) {
  return async (input: SandboxExecutionRecord): Promise<SandboxExecutionRecord> => {
    const record = await options.journal.read(input.plan.identity);
    if (!record || record.plan.semanticFingerprint !== input.plan.semanticFingerprint)
      throw new Error("SANDBOX_TOOL_RESULT_BINDING_CHANGED");
    const { plan, facts: current } = record;
    if (
      plan.mode !== "foreground" ||
      plan.backendRef !== "srt" ||
      !record.releaseReceipt ||
      record.workspaceBlocked ||
      current.resource.supervision !== "released" ||
      (current.result && current.result.kind !== "unknown") ||
      options.now() >= plan.originalDeadlineAt
    )
      return record;
    const recovered = await options.stream.recover(record);
    if (!recovered) return record;
    const original = await options.journal.readResultRecovery({
      identity: plan.identity,
      authority: options.authority(),
      now: options.now(),
    });
    let payload: PayloadRecord;
    if (original.output) {
      const saved = await options.payloads.get(original.output.payloadRef);
      if (
        !saved ||
        saved.dataClassification !== original.receipt.dataClassification ||
        saved.contentType !== "application/octet-stream" ||
        saved.contentDigest !== `sha256:${recovered.source.digest}` ||
        saved.ciphertext.byteLength > plan.resourceCeiling.maxOutputBytes + 131072
      )
        throw new Error("SANDBOX_RECOVERY_OUTPUT_CHANGED");
      const bytes = await options.protector.unprotect({
        ownerId: original.receipt.ownerId,
        agentId: original.receipt.agentId,
        payload: saved,
      });
      if (
        bytes.byteLength !== recovered.bytes.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== recovered.source.digest
      )
        throw new Error("SANDBOX_RECOVERY_OUTPUT_CHANGED");
      payload = saved;
    } else {
      payload = await options.protector.protect({
        ownerId: original.receipt.ownerId,
        agentId: original.receipt.agentId,
        ref: options.nextRef(),
        dataClassification: original.receipt.dataClassification,
        contentType: "application/octet-stream",
        plaintext: recovered.bytes,
        createdAt: options.now(),
      });
    }
    const facts = await options.facts(record, recovered.bytes, recovered.termination, {
      ref: payload.ref,
      digest: recovered.source.digest,
      byteLength: recovered.source.byteLength,
    });
    const now = options.now();
    const context: SandboxExecutionProjectionContext = {
      now,
      environment: current.environment,
      operationContract: plan.operationContract,
      verification: {
        facts,
        identity: plan.identity,
        environmentId: plan.environmentId,
        policyDigest: facts.environment.policyDigest,
        resourceSequence: facts.resource.sequence,
        checkedAt: now,
        validUntil: new Date(Date.parse(now) + 1000).toISOString(),
        outputs: facts.result && facts.result.kind !== "unknown" ? [facts.result.output] : [],
        evidence: facts.effect.kind === "verified" ? [facts.effect.evidence] : [],
      },
      releaseReceipt: record.releaseReceipt,
      currentResourceSequence: current.resource.sequence,
      runState: "terminated",
      currentAuthority: false,
      currentFence: false,
      userDisclosureAllowed: false,
      modelDisclosureAllowed: false,
      conflictingWorkspaceRisk: false,
      pendingApprovalOrReconciliation: false,
      resultAlreadyDelivered: false,
    };
    try {
      return (
        await options.journal.importResult({
          identity: plan.identity,
          expectedSequence: current.resource.sequence,
          expectedOperationRevision: record.operationRevision,
          facts,
          authority: options.authority(),
          now,
          context,
          payload,
          source: recovered.source,
        })
      ).record;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "PORT_CONFLICT")
        throw error;
      const latest = await options.journal.read(plan.identity);
      if (
        !latest ||
        latest.plan.semanticFingerprint !== plan.semanticFingerprint ||
        !latest.facts.result ||
        latest.facts.result.kind === "unknown"
      )
        throw error;
      return latest;
    }
  };
}
