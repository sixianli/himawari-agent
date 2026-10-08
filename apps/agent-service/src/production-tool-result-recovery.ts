import type {
  AgentId,
  ClockPort,
  OwnerId,
  PayloadProtectorPort,
  RunCheckpointStore,
  RunDispatchCandidate,
  RunPayloadArtifactPort,
  RunToolResultRecoveryClaim,
  RuntimeRequest,
  SandboxExecutionRecord,
} from "@himawari-agent/application";
import { canonicalAuthorizationSnapshot } from "@himawari-agent/application/action-intent-snapshot";
import { isSandboxReservationNeverStarted } from "@himawari-agent/application/sandbox-execution-projection";
import { executionV2MessageSchema } from "@himawari-agent/execution-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { inspectPiToolBatch } from "@himawari-agent/runtime-pi";

export interface PreparedToolResultRecovery {
  readonly claim: RunToolResultRecoveryClaim;
  readonly binding: NonNullable<RuntimeRequest["knownToolResult"]>;
  readonly previousAuthority: unknown;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("TOOL_RESULT_RECOVERY_RECORD_INVALID");
  return value as Record<string, unknown>;
}

export function createProductionToolResultRecovery(options: {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly repository: SqliteProductStateRepository;
  readonly artifacts: RunPayloadArtifactPort;
  readonly checkpoints: RunCheckpointStore;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly recoverMissingResult?: (
    record: SandboxExecutionRecord,
  ) => Promise<SandboxExecutionRecord>;
}) {
  const { ownerId, agentId, repository, artifacts, checkpoints, protector, clock } = options;
  const payloads = repository.payloadStore(ownerId, agentId);
  const read = async (ref: string) => {
    const payload = await payloads.get(ref);
    if (!payload || payload.contentType !== "application/json")
      throw new Error("TOOL_RESULT_RECOVERY_PAYLOAD_MISSING");
    return object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await protector.unprotect({ ownerId, agentId, payload }),
        ),
      ),
    );
  };
  return async (
    candidate: Pick<RunDispatchCandidate, "runId" | "ownerId" | "agentId">,
  ): Promise<PreparedToolResultRecovery | undefined> => {
    if (candidate.ownerId !== ownerId || candidate.agentId !== agentId) return undefined;
    const saved = await checkpoints.read(candidate.runId);
    if (
      !saved ||
      ![
        "RUNTIME_TOOL_RESULT_UNKNOWN",
        "RUNTIME_ATTEMPT_INTERRUPTED",
        "PERSISTED_EXECUTION_RECONCILIATION_REQUIRED",
        "SERVICE_STOPPING",
      ].includes(saved.checkpoint.diagnosticCode ?? "") ||
      saved.checkpoint.output !== null ||
      saved.checkpoint.terminalStatus !== null ||
      !saved.checkpoint.contextRef
    )
      return undefined;
    const inputArtifact = await artifacts.lookup({
      runId: candidate.runId,
      purpose: "context",
      operationKey: "run-execution-input:v1",
    });
    if (!inputArtifact) return undefined;
    const frozen = await read(inputArtifact.payloadRef);
    if (
      frozen["version"] !== "run-execution-input.v2" ||
      typeof frozen["deadlineAt"] !== "string" ||
      !Number.isFinite(Date.parse(frozen["deadlineAt"])) ||
      frozen["deadlineAt"] <= clock.now()
    )
      return undefined;
    const trace = [];
    let after = 0;
    for (;;) {
      const page = await repository.traceStore().readRun(candidate.runId, after, 1000);
      trace.push(...page);
      if (trace.length > 10000) throw new Error("TOOL_RESULT_RECOVERY_TRACE_LIMIT");
      if (page.length < 1000) break;
      const last = page.at(-1);
      if (!last || last.sequence <= after) throw new Error("TOOL_RESULT_RECOVERY_TRACE_ORDER");
      after = last.sequence;
    }
    const lastTool = trace.findLast(
      (event) =>
        event.eventType === "runtime.result_unknown" || event.eventType === "runtime.tool_intent",
    );
    if (!lastTool?.payloadRef || lastTool.ownerId !== ownerId || lastTool.agentId !== agentId)
      return undefined;
    const event = await read(lastTool.payloadRef);
    const waiting =
      event["type"] === "runtime.tool_intent" && typeof event["payloadRef"] === "string"
        ? { ...(await read(event["payloadRef"])), capabilityRef: event["capabilityRef"] }
        : event;
    if (
      event["runId"] !== candidate.runId ||
      typeof waiting["toolCallId"] !== "string" ||
      typeof waiting["capabilityRef"] !== "string"
    )
      return undefined;
    const inventory = await repository
      .sandboxExecutionPreparations(ownerId, agentId)
      .readRunInventory({ runId: candidate.runId });
    const matches: PreparedToolResultRecovery[] = [];
    for (let admission of inventory.admissions) {
      if (
        admission.phase === "reserved" &&
        admission.releaseReceipt?.verification.schemaVersion ===
          "sandbox-admin-reservation-release.v1"
      )
        continue;
      if (
        admission.phase === "bound" &&
        options.recoverMissingResult &&
        (!admission.record.facts.result || admission.record.facts.result.kind === "unknown")
      ) {
        admission = { ...admission, record: await options.recoverMissingResult(admission.record) };
      }
      const plan = admission.phase === "bound" ? admission.record.plan : admission.plan;
      const known =
        admission.phase === "bound"
          ? admission.record.releaseReceipt &&
            admission.record.facts.resource.supervision === "released" &&
            ["result", "error"].includes(admission.record.facts.result?.kind ?? "")
          : isSandboxReservationNeverStarted(
              admission.plan,
              admission.releaseReceipt?.verification,
            ) && !admission.workspaceBlocked;
      if (
        !known ||
        plan.mode !== "foreground" ||
        !plan.identity.invocationId.startsWith("runtime-tool:")
      )
        continue;
      const intentArtifact = await artifacts.lookup({
        runId: candidate.runId,
        purpose: "trace",
        operationKey: `runtime-tool-intent:${plan.identity.invocationId.slice("runtime-tool:".length)}`,
      });
      if (!intentArtifact) continue;
      const intent = await read(intentArtifact.payloadRef);
      if (!intent["recovery"] || typeof intent["recovery"] !== "object") continue;
      const recovery = object(intent["recovery"]);
      if (
        recovery["version"] !== "tool-batch-recovery.v1" ||
        recovery["toolCallId"] !== waiting["toolCallId"] ||
        typeof recovery["continuationRef"] !== "string"
      )
        continue;
      const original = executionV2MessageSchema.parse(intent["request"]);
      if (
        original.kind !== "request" ||
        original.type !== "work.execute" ||
        original.messageId !== plan.identity.invocationId ||
        original.scope.runId !== candidate.runId ||
        original.scope.ownerId !== ownerId ||
        original.scope.agentId !== agentId ||
        original.payload.capabilityHandleRef !== plan.handleRef ||
        original.payload.inputRef !== plan.inputRef ||
        original.payload.capabilityId !== plan.capabilityRef ||
        original.payload.capabilityVersion !== plan.capabilityVersion ||
        original.payload.operation !== plan.operation ||
        typeof intent["fingerprint"] !== "string"
      )
        continue;
      const continuationRef = recovery["continuationRef"];
      const continuationArtifact = await artifacts.lookup({
        runId: candidate.runId,
        purpose: "trace",
        operationKey: `runtime-continuation:${continuationRef}`,
      });
      if (continuationArtifact?.payloadRef !== continuationRef) continue;
      const continuation = await read(continuationRef);
      const scope = object(continuation["scope"]);
      const value = object(continuation["value"]);
      const batch = inspectPiToolBatch(value["batch"]);
      const previousAuthority = {
        deploymentId: original.scope.deploymentId,
        authorityEpoch: original.scope.authorityEpoch,
        fencingToken: original.scope.fencingToken,
      };
      if (
        batch.waitingToolCallId !== waiting["toolCallId"] ||
        scope["ownerId"] !== ownerId ||
        scope["agentId"] !== agentId ||
        scope["runId"] !== candidate.runId ||
        scope["contextEnvelopeRef"] !== saved.checkpoint.contextRef ||
        scope["executionDeadlineAt"] !== frozen["deadlineAt"] ||
        canonicalAuthorizationSnapshot(scope["authority"]) !==
          canonicalAuthorizationSnapshot(previousAuthority)
      )
        continue;
      let newerTool = false;
      for (const event of trace.filter(
        (event) => event.sequence > lastTool.sequence && event.eventType === "runtime.tool_intent",
      )) {
        if (!event.payloadRef) {
          newerTool = true;
          break;
        }
        const detail = await read(event.payloadRef);
        if (typeof detail["payloadRef"] !== "string") {
          newerTool = true;
          break;
        }
        const tool = await read(detail["payloadRef"]);
        if (
          tool["toolCallId"] !== batch.waitingToolCallId &&
          !batch.completedToolCallIds.includes(String(tool["toolCallId"]))
        ) {
          newerTool = true;
          break;
        }
      }
      if (newerTool) continue;
      matches.push({
        claim: {
          jobId: plan.identity.jobId,
          invocationId: plan.identity.invocationId,
          semanticFingerprint: plan.semanticFingerprint,
          checkpointRevision: saved.revision,
          ...(admission.phase === "reserved" &&
          admission.releaseReceipt?.verification.schemaVersion === "sandbox-reservation-release.v1"
            ? { reservationReleaseDigest: admission.releaseReceipt.verification.evidence.digest }
            : {}),
          operationRevision: admission.phase === "bound" ? admission.record.operationRevision : 0,
          resourceSequence:
            admission.phase === "bound"
              ? admission.record.facts.resource.sequence
              : admission.reservation.sequence,
          completedStreamOrdinal: batch.completedStreamOrdinal,
          deadlineAt: frozen["deadlineAt"],
        },
        binding: {
          capabilityRef: waiting["capabilityRef"],
          jobId: plan.identity.jobId,
          invocationId: plan.identity.invocationId,
          continuationRef,
          toolCallId: batch.waitingToolCallId,
        },
        previousAuthority,
      });
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
}
