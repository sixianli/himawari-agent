import {
  array,
  ContractValidationError,
  enumeration,
  type InferSchema,
  integer,
  literal,
  machineString,
  nullable,
  object,
  type Schema,
  timestamp,
} from "./validation.ts";

/** Product job contract; deliberately contains no SRT SDK types or raw credentials. */
export const SANDBOX_EXECUTION_SCHEMA_VERSION = "sandbox-execution.v1" as const;

const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "expected a SHA-256 hex digest");
    return value;
  },
};

export const sandboxJobIdentitySchema = object({
  jobId: machineString,
  attemptId: machineString,
  invocationId: machineString,
  receiptRef: machineString,
  hostId: machineString,
  ownerId: machineString,
  agentId: machineString,
  threadId: nullable(machineString),
  runId: machineString,
  toolCallId: machineString,
});

const planFields = {
  schemaVersion: literal(SANDBOX_EXECUTION_SCHEMA_VERSION),
  identity: sandboxJobIdentitySchema,
  handleRef: machineString,
  inputRef: machineString,
  operation: machineString,
  capabilityRef: machineString,
  capabilityVersion: machineString,
  semanticFingerprint: {
    parse(value: unknown, path = "$"): string {
      if (typeof value !== "string" || !value.startsWith("sha256:"))
        throw new ContractValidationError(
          path,
          "expected a prefixed SHA-256 invocation fingerprint",
        );
      digest.parse(value.slice(7), path);
      return value;
    },
  },
  authorizationRef: machineString,
  modelRef: machineString,
  executionLease: object({
    executionLeaseId: machineString,
    expectedLeaseRevision: integer(1),
    authorityLeaseId: machineString,
    authorityFencingToken: integer(1),
    deploymentId: machineString,
    authorityEpoch: integer(1),
    fencingToken: integer(1),
    consumerId: machineString,
  }),
  requestedAt: timestamp,
  originalDeadlineAt: timestamp,
  effectiveDeadlineAt: timestamp,
  resourceCeiling: object({
    maxWallTimeMs: integer(1),
    maxCpuTimeMs: integer(1),
    maxMemoryBytes: integer(1),
    maxOutputBytes: integer(1),
    maxProgressEvents: integer(1),
  }),
  // An opaque, authorized product scope. The Worker resolves and compiles it;
  // model arguments never supply a platform policy or claim qualification.
  binding: object({
    scopeRef: machineString,
    scopeDigest: digest,
    profileRef: machineString,
    runtimeDigest: digest,
    runnerDigest: digest,
    qualificationRef: machineString,
    requiredGuarantees: array(machineString),
  }),
};
const planShape = object(planFields);
const { semanticFingerprint: _fingerprintSchema, ...candidateFields } = planFields;
const candidateShape = object(candidateFields);

export type SandboxExecutionPlanCandidate = InferSchema<typeof candidateShape>;
export type SandboxExecutionPlan = InferSchema<typeof planShape>;
export type SandboxJobIdentity = InferSchema<typeof sandboxJobIdentitySchema>;

function validatePlanWindow<T extends SandboxExecutionPlanCandidate>(plan: T, path: string): T {
  if (
    Date.parse(plan.requestedAt) >= Date.parse(plan.effectiveDeadlineAt) ||
    Date.parse(plan.effectiveDeadlineAt) > Date.parse(plan.originalDeadlineAt)
  )
    throw new ContractValidationError(path, "invalid execution deadline window");
  if (new Set(plan.binding.requiredGuarantees).size !== plan.binding.requiredGuarantees.length)
    throw new ContractValidationError(path, "duplicate required guarantee");
  if (plan.binding.requiredGuarantees.length === 0)
    throw new ContractValidationError(path, "at least one required guarantee is necessary");
  return plan;
}
export const sandboxExecutionPlanSchema: Schema<SandboxExecutionPlan> = {
  parse(value, path = "$") {
    return validatePlanWindow(planShape.parse(value, path), path);
  },
};
export const sandboxExecutionPlanCandidateSchema: Schema<SandboxExecutionPlanCandidate> = {
  parse(value, path = "$") {
    return validatePlanWindow(candidateShape.parse(value, path), path);
  },
};

export const SANDBOX_JOB_STATES = [
  "prepared",
  "starting",
  "running",
  "stopping",
  "reconciling",
  "completed",
  "failed",
  "quarantined",
] as const;
export type SandboxJobState = (typeof SANDBOX_JOB_STATES)[number];
const receiptShape = object({
  schemaVersion: literal(SANDBOX_EXECUTION_SCHEMA_VERSION),
  identity: sandboxJobIdentitySchema,
  sequence: integer(1),
  state: enumeration(SANDBOX_JOB_STATES),
  policyDigest: digest,
  occurredAt: timestamp,
  outcome: enumeration(["pending", "succeeded", "failed", "cancelled", "timed_out", "unknown"]),
  cleanup: enumeration(["pending", "confirmed", "unknown"]),
  effect: enumeration(["not_started", "confirmed", "unknown"]),
  outputRef: nullable(machineString),
  outputDigest: nullable(digest),
  reasonCode: nullable(machineString),
});
export type SandboxJobReceipt = InferSchema<typeof receiptShape>;
export const sandboxJobReceiptSchema: Schema<SandboxJobReceipt> = {
  parse(value, path = "$") {
    const receipt = receiptShape.parse(value, path);
    if ((receipt.outputRef === null) !== (receipt.outputDigest === null))
      throw new ContractValidationError(path, "output reference and digest must be paired");
    if (
      (receipt.state === "completed" || receipt.state === "failed") &&
      (receipt.cleanup !== "confirmed" || receipt.effect === "unknown")
    )
      throw new ContractValidationError(
        path,
        "terminal result requires confirmed cleanup and effect",
      );
    if (
      receipt.state === "completed" &&
      (receipt.outcome !== "succeeded" ||
        receipt.effect !== "confirmed" ||
        receipt.outputRef === null ||
        receipt.reasonCode !== null)
    )
      throw new ContractValidationError(path, "completed requires confirmed success");
    if (
      receipt.state === "failed" &&
      (!["failed", "cancelled", "timed_out"].includes(receipt.outcome) ||
        receipt.reasonCode === null)
    )
      throw new ContractValidationError(path, "failed requires a settled failure reason");
    if (
      (receipt.state === "reconciling" || receipt.state === "quarantined") &&
      receipt.reasonCode === null
    )
      throw new ContractValidationError(path, "unresolved jobs require a reason");
    if (
      receipt.state === "prepared" &&
      (receipt.effect !== "not_started" || receipt.outcome !== "pending")
    )
      throw new ContractValidationError(path, "prepared cannot claim execution");
    return receipt;
  },
};

const transitions: Readonly<Record<SandboxJobState, readonly SandboxJobState[]>> = {
  prepared: ["starting", "stopping", "reconciling"],
  starting: ["starting", "running", "stopping", "reconciling"],
  running: ["running", "stopping", "reconciling"],
  stopping: ["stopping", "completed", "failed", "reconciling", "quarantined"],
  reconciling: ["completed", "failed", "quarantined"],
  quarantined: ["reconciling"],
  completed: [],
  failed: [],
};

/** Validation only, not a second durable ledger. Caller persists with the existing CAS/fence. */
export function validateSandboxJobObservation(
  plan: SandboxExecutionPlan,
  value: unknown,
  previous?: SandboxJobReceipt,
): SandboxJobReceipt {
  const expected = sandboxExecutionPlanSchema.parse(plan);
  const next = sandboxJobReceiptSchema.parse(value);
  if (Date.parse(next.occurredAt) < Date.parse(expected.requestedAt))
    throw new ContractValidationError("$.occurredAt", "observation predates the plan");
  for (const key of Object.keys(expected.identity) as (keyof SandboxJobIdentity)[]) {
    if (next.identity[key] !== expected.identity[key])
      throw new ContractValidationError("$.identity", "job identity mismatch");
  }
  if (previous) {
    const prior = sandboxJobReceiptSchema.parse(previous);
    for (const key of Object.keys(expected.identity) as (keyof SandboxJobIdentity)[])
      if (prior.identity[key] !== expected.identity[key])
        throw new ContractValidationError("$.identity", "previous job identity mismatch");
    if (
      next.sequence !== prior.sequence + 1 ||
      next.policyDigest !== prior.policyDigest ||
      Date.parse(next.occurredAt) < Date.parse(prior.occurredAt) ||
      !transitions[prior.state].includes(next.state)
    )
      throw new ContractValidationError("$", "invalid job observation transition");
  } else if (next.state !== "prepared" || next.sequence !== 1) {
    throw new ContractValidationError("$", "first observation must be prepared");
  }
  return next;
}
