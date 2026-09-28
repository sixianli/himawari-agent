import { createHash } from "node:crypto";
import type {
  ClockPort,
  IdGeneratorPort,
  PayloadProtectorPort,
  RunReconciliationCandidate,
} from "@himawari-agent/application";
import { canonicalAuthorizationSnapshot } from "@himawari-agent/application/action-intent-snapshot";
import { createApplicationServiceIdentityFactory } from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";

export function createProductionRunExpiry(options: {
  repository: SqliteProductStateRepository;
  protector: PayloadProtectorPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  scope: Parameters<SqliteProductStateRepository["runReconciliation"]>;
  executionLeaseDurationMs: number;
}) {
  const [ownerId, agentId, authority] = options.scope;
  const identities = createApplicationServiceIdentityFactory();
  const artifacts = options.repository.runPayloadArtifactPort(ownerId, agentId, {
    product: authority,
    lease: options.scope[3],
  });
  const payloads = options.repository.payloadStore(ownerId, agentId);
  const checkpoints = options.repository.runCheckpointStore(ownerId, agentId, authority);
  const recovery = options.repository.runReconciliation(...options.scope);
  return async (candidate: RunReconciliationCandidate): Promise<boolean> => {
    if (candidate.ownerId !== ownerId || candidate.agentId !== agentId)
      throw new Error("RUN_EXPIRY_SCOPE_CHANGED");
    const saved = await checkpoints.read(candidate.runId);
    if (
      saved?.checkpoint.phase !== "reconciling_external_result" ||
      saved.checkpoint.terminalStatus !== null ||
      saved.checkpoint.output !== null
    )
      return false;
    const artifact = await artifacts.lookup({
      runId: candidate.runId,
      purpose: "context",
      operationKey: "run-execution-input:v1",
    });
    if (!artifact) throw new Error("RUN_EXPIRY_INPUT_UNAVAILABLE");
    const payload = await payloads.get(artifact.payloadRef);
    if (
      !payload ||
      payload.contentType !== "application/json" ||
      payload.contentDigest !== artifact.contentDigest
    )
      throw new Error("RUN_EXPIRY_INPUT_CHANGED");
    const bytes = await options.protector.unprotect({ ownerId, agentId, payload });
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== artifact.contentDigest)
      throw new Error("RUN_EXPIRY_INPUT_CHANGED");
    const frozen = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    const source = await options.repository
      .runExecutionSource(ownerId, agentId)
      .read(candidate.runId);
    if (
      !source ||
      frozen?.version !== "run-execution-input.v2" ||
      canonicalAuthorizationSnapshot(frozen.source) !== canonicalAuthorizationSnapshot(source) ||
      typeof frozen.deadlineAt !== "string" ||
      !Number.isFinite(Date.parse(frozen.deadlineAt)) ||
      typeof frozen.startedAt !== "string" ||
      !Number.isFinite(Date.parse(frozen.startedAt)) ||
      Date.parse(frozen.deadlineAt) <= Date.parse(frozen.startedAt) ||
      Date.parse(frozen.deadlineAt) - Date.parse(frozen.startedAt) > 86_400_000
    )
      throw new Error("RUN_EXPIRY_INPUT_INVALID");
    const at = options.clock.now();
    if (at < frozen.deadlineAt) return false;
    const result = await recovery.settleExpired({
      runId: candidate.runId,
      expectedRunRevision: candidate.runRevision,
      expectedCheckpointRevision: saved.revision,
      expectedLeaseRevision: candidate.leaseRevision,
      executionLeaseId: identities.createExecutionLeaseId({
        instanceId: options.ids.next("run-expiry-lease"),
        runId: candidate.runId,
        expectedLeaseRevision: candidate.leaseRevision + 1,
      }),
      frozenInputRef: artifact.payloadRef,
      frozenInputDigest: artifact.contentDigest,
      originalDeadlineAt: frozen.deadlineAt,
      at,
      leaseExpiresAt: new Date(Date.parse(at) + options.executionLeaseDurationMs).toISOString(),
    });
    return result.settled;
  };
}
