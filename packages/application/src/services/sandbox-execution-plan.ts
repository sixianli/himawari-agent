import {
  type SandboxExecutionPlan,
  type SandboxExecutionPlanCandidate,
  sandboxExecutionPlanCandidateSchema,
  sandboxExecutionPlanSchema,
} from "@himawari-agent/execution-contracts";
import type { GovernedCapabilityExecutionHandle } from "../ports/capabilities.js";
import type {
  ConsumeCapabilityInvocationInput,
  FrozenCapabilityInvocationReceipt,
} from "../ports/capability-invocations.js";
import type { RuntimeRequest, RuntimeToolInvocation } from "../ports/intelligence.js";

/** Pure projection of existing authority, not an authorization decision.
 * Worker must resolve the protected input/scope and revalidate live authority.
 * Invocation/Handle consumption and approval storage keep their existing owners.
 */
interface ProjectionInput {
  readonly request: Pick<
    RuntimeRequest,
    | "ownerId"
    | "agentId"
    | "runId"
    | "threadId"
    | "modelRef"
    | "executionLease"
    | "executionDeadlineAt"
  >;
  readonly invocation: RuntimeToolInvocation;
  readonly receipt: Pick<
    FrozenCapabilityInvocationReceipt,
    | "receiptRef"
    | "invocationId"
    | "idempotencyKey"
    | "ownerId"
    | "agentId"
    | "runId"
    | "inputRef"
    | "handleRef"
    | "operation"
    | "capabilityRef"
    | "capabilityVersion"
    | "authorizationRef"
    | "authority"
    | "deadlineAt"
    | "effectiveExpiresAt"
    | "resourceCeiling"
  >;
  readonly jobId: string;
  readonly attemptId: string;
  readonly hostId: string;
  readonly binding: SandboxExecutionPlan["binding"];
  readonly now: string;
  /** Trusted SHA-256 implementation, same canonical key as ProductionRuntimeTools. */
  readonly digest: (canonicalValue: string) => string;
}

function project(input: ProjectionInput): SandboxExecutionPlanCandidate {
  const { request, invocation, receipt } = input;
  const context = invocation.context;
  const lease = request.executionLease;
  const { inputRef } = invocation.arguments;
  const invocationKey = `runtime-tool:${input.digest(JSON.stringify([invocation.runId, invocation.toolCallId]))}`;
  if (
    receipt.invocationId !== invocationKey ||
    receipt.idempotencyKey !== invocationKey ||
    inputRef !== receipt.inputRef
  )
    throw new Error("SANDBOX_EXECUTION_INVOCATION_MISMATCH");
  if (
    !context ||
    !request.executionDeadlineAt ||
    request.ownerId !== receipt.ownerId ||
    request.agentId !== receipt.agentId ||
    request.runId !== receipt.runId ||
    invocation.runId !== request.runId ||
    context.threadId !== request.threadId ||
    context.modelRef !== request.modelRef ||
    invocation.capabilityRef !== receipt.capabilityRef ||
    (invocation.capabilityHandleRef !== null &&
      invocation.capabilityHandleRef !== receipt.handleRef) ||
    invocation.executionDeadlineAt !== request.executionDeadlineAt
  )
    throw new Error("SANDBOX_EXECUTION_SCOPE_MISMATCH");
  for (const key of Object.keys(lease) as (keyof typeof lease)[])
    if (context.executionLease[key] !== lease[key])
      throw new Error("SANDBOX_EXECUTION_LEASE_MISMATCH");
  if (
    lease.deploymentId !== receipt.authority.product.deploymentId ||
    lease.authorityEpoch !== receipt.authority.product.authorityEpoch ||
    lease.fencingToken !== receipt.authority.product.fencingToken ||
    lease.authorityLeaseId !== receipt.authority.lease.leaseId ||
    lease.authorityFencingToken !== receipt.authority.lease.fencingToken
  )
    throw new Error("SANDBOX_EXECUTION_AUTHORITY_MISMATCH");
  const now = Date.parse(input.now);
  const deadline = Math.min(
    Date.parse(request.executionDeadlineAt),
    Date.parse(receipt.deadlineAt),
    Date.parse(receipt.effectiveExpiresAt),
  );
  if (!Number.isFinite(now) || !Number.isFinite(deadline) || now >= deadline)
    throw new Error("SANDBOX_EXECUTION_EXPIRED");
  return sandboxExecutionPlanCandidateSchema.parse({
    schemaVersion: "sandbox-execution.v1",
    identity: {
      jobId: input.jobId,
      attemptId: input.attemptId,
      invocationId: receipt.invocationId,
      receiptRef: receipt.receiptRef,
      hostId: input.hostId,
      ownerId: request.ownerId,
      agentId: request.agentId,
      threadId: request.threadId,
      runId: request.runId,
      toolCallId: invocation.toolCallId,
    },
    handleRef: receipt.handleRef,
    inputRef: receipt.inputRef,
    operation: receipt.operation,
    capabilityRef: receipt.capabilityRef,
    capabilityVersion: receipt.capabilityVersion,
    authorizationRef: receipt.authorizationRef,
    modelRef: request.modelRef,
    executionLease: lease,
    requestedAt: input.now,
    originalDeadlineAt: request.executionDeadlineAt,
    effectiveDeadlineAt: new Date(deadline).toISOString(),
    resourceCeiling: {
      ...receipt.resourceCeiling,
      maxWallTimeMs: Math.min(receipt.resourceCeiling.maxWallTimeMs, deadline - now),
    },
    binding: input.binding,
  });
}

/** Project a consumed receipt when one already exists; this never consumes it. */
export function createSandboxExecutionPlan(
  input: Omit<ProjectionInput, "receipt"> & {
    readonly receipt: FrozenCapabilityInvocationReceipt;
  },
): SandboxExecutionPlan {
  return sandboxExecutionPlanSchema.parse({
    ...project(input),
    semanticFingerprint: input.receipt.semanticFingerprint,
  });
}

/** Prepare before atomic journal admission. The existing SQLite transaction
 * supplies the fingerprint and rechecks Handle/Grant/Run authority; no synthetic
 * consumed receipt or second permission consumption is created here. */
export function createSandboxExecutionPlanCandidate(
  input: Omit<ProjectionInput, "receipt"> & {
    readonly admission: ConsumeCapabilityInvocationInput;
    readonly handle: GovernedCapabilityExecutionHandle;
  },
): SandboxExecutionPlanCandidate {
  const { admission, handle } = input;
  if (
    handle.ref !== admission.handleRef ||
    handle.ownerId !== admission.requestScope.ownerId ||
    handle.agentId !== admission.requestScope.agentId ||
    handle.runId !== admission.requestScope.runId ||
    handle.capabilityRef !== admission.capabilityRef ||
    handle.capabilityVersion !== admission.capabilityVersion ||
    handle.operation !== admission.operation ||
    !handle.operations.includes(admission.operation) ||
    !handle.inputRefs.includes(admission.inputRef) ||
    handle.revokedAt !== null ||
    handle.workerEndedAt !== null ||
    handle.authorityFence !== admission.authority.product.fencingToken ||
    (admission.authorizationRef !== null &&
      admission.authorizationRef !== handle.authorizationRef) ||
    admission.requestScope.deploymentId !== admission.authority.product.deploymentId ||
    admission.requestScope.authorityEpoch !== admission.authority.product.authorityEpoch ||
    admission.requestScope.fencingToken !== admission.authority.product.fencingToken ||
    !Number.isFinite(Date.parse(handle.issuedAt)) ||
    Date.parse(handle.issuedAt) > Date.parse(input.now) ||
    Date.parse(admission.requestedAt) > Date.parse(input.now)
  )
    throw new Error("SANDBOX_EXECUTION_HANDLE_MISMATCH");
  return project({
    ...input,
    receipt: {
      receiptRef: admission.receiptRef,
      invocationId: admission.invocationId,
      idempotencyKey: admission.idempotencyKey,
      ownerId: handle.ownerId,
      agentId: handle.agentId,
      runId: handle.runId,
      inputRef: admission.inputRef,
      handleRef: handle.ref,
      operation: admission.operation,
      capabilityRef: handle.capabilityRef,
      capabilityVersion: handle.capabilityVersion,
      authorizationRef: handle.authorizationRef,
      authority: admission.authority,
      deadlineAt: admission.deadlineAt,
      effectiveExpiresAt: handle.expiresAt,
      resourceCeiling: admission.resourceCeiling,
    },
  });
}
