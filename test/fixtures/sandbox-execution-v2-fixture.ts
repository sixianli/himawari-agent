import type { SandboxExecutionJournalPort } from "@himawari-agent/application";
import {
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanCandidateV2Schema,
} from "@himawari-agent/execution-contracts";
import {
  AGENT_ID,
  invocation,
  OWNER_ID,
  type openSandboxJournal,
  operationsForDatabase,
  T1,
} from "./sqlite-capability-invocation-fixture.ts";

type Fixture = Awaited<ReturnType<typeof openSandboxJournal>>;
type Admission = Parameters<SandboxExecutionJournalPort["admit"]>[0];
export function sandboxV2Admission(
  f: Fixture,
  suffix = "",
  lineage = [
    { device: "1", inode: "1" },
    { device: "1", inode: "10" },
  ],
  access: "read" | "write" = "write",
): Admission {
  const { semanticFingerprint: _fingerprint, ...v1 } = f.plan;
  const identity = {
    ...v1.identity,
    jobId: `job${suffix}`,
    attemptId: `attempt${suffix}`,
    receiptRef: suffix ? `receipt${suffix}` : v1.identity.receiptRef,
    invocationId: suffix ? `invocation${suffix}` : v1.identity.invocationId,
  };
  const plan = sandboxExecutionPlanCandidateV2Schema.parse({
    ...v1,
    identity,
    schemaVersion: "sandbox-execution.v2",
    mode: "foreground",
    environmentId: `environment${suffix}`,
    backendRef: "srt",
    operationContract: { ref: "fixed-read", version: "1", kind: "fixed_read" },
  });
  const environment = {
    schemaVersion: "sandbox-execution.v2",
    kind: "local",
    environmentId: plan.environmentId,
    resourceRef: null,
    creator: identity,
    mode: plan.mode,
    backendRef: plan.backendRef,
    authorizationRef: plan.authorizationRef,
    scopeDigest: plan.binding.scopeDigest,
    policyDigest: "d".repeat(64),
    deadlineAt: plan.effectiveDeadlineAt,
    supervisor: { supervisorId: "supervisor", bootId: "boot", epoch: 1 },
    workspaceConflictRefs: ["workspace"],
    privateDirectoryRef: "private-dir",
    privateDirectoryOwnerRef: "host",
  };
  const facts = sandboxExecutionFactsSchema.parse({
    schemaVersion: "sandbox-execution.v2",
    environment,
    result: null,
    effect: { kind: "unknown", reasonCode: "pending" },
    resource: {
      schemaVersion: "sandbox-execution.v2",
      environmentId: plan.environmentId,
      creator: identity,
      policyDigest: environment.policyDigest,
      scopeDigest: environment.scopeDigest,
      sequence: 1,
      occurredAt: T1,
      supervisor: environment.supervisor,
      resourceRef: null,
      status: { kind: "foreground" },
      metrics: null,
      supervision: "initializing",
      cleanup: "pending",
    },
  });
  return {
    invocation: invocation(
      suffix
        ? {
            receiptRef: identity.receiptRef,
            invocationId: identity.invocationId,
            idempotencyKey: `idempotency${suffix}`,
            authorizationRef: plan.authorizationRef,
          }
        : { authorizationRef: plan.authorizationRef },
    ) as unknown as Admission["invocation"],
    plan,
    facts,
    workspaces: [
      {
        ref: "workspace",
        hostId: identity.hostId,
        canonicalRootId: "root-fixture",
        access,
        lineage,
      },
    ],
  };
}
export function sandboxV2Call<K extends keyof SandboxExecutionJournalPort>(
  f: Fixture,
  name: K,
  input: Parameters<SandboxExecutionJournalPort[K]>[0],
): Awaited<ReturnType<SandboxExecutionJournalPort[K]>> {
  return operationsForDatabase(f.database).execute(`capabilityInvocation.sandboxV2.${name}`, {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input,
  }) as Awaited<ReturnType<SandboxExecutionJournalPort[K]>>;
}
