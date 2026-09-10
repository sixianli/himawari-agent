import {
  type SandboxExecutionPlan,
  type SandboxExecutionPlanCandidate,
  sandboxExecutionPlanCandidateSchema,
  sandboxExecutionPlanSchema,
  sandboxJobIdentitySchema,
} from "./sandbox-execution-v1.ts";
import {
  array,
  booleanValue,
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

export const SANDBOX_EXECUTION_V2_SCHEMA_VERSION = "sandbox-execution.v2" as const;
const version = literal(SANDBOX_EXECUTION_V2_SCHEMA_VERSION);
const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "expected a SHA-256 hex digest");
    return value;
  },
};
function fail(message: string): never {
  throw new ContractValidationError("$", message);
}
/** Strict discriminated parsing; never try a weaker branch after a branch fails. */
function variant<const T extends Readonly<Record<string, Schema<unknown>>>>(
  key: string,
  branches: T,
): Schema<InferSchema<T[keyof T]>> {
  return {
    parse(value, path = "$") {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new ContractValidationError(path, "expected a discriminated object");
      const tag = (value as Record<string, unknown>)[key];
      if (typeof tag !== "string" || !Object.hasOwn(branches, tag))
        throw new ContractValidationError(`${path}.${key}`, "unknown branch");
      const branch = branches[tag];
      if (!branch) throw new ContractValidationError(path, "missing branch schema");
      return branch.parse(value, path) as InferSchema<T[keyof T]>;
    },
  };
}
export const sandboxPayloadReferenceSchema = object({
  ref: machineString,
  digest,
  byteLength: integer(0),
});
const evidence = object({ ref: machineString, digest });
const contractIdentity = { ref: machineString, version: machineString };
/** Trusted catalog descriptors, not model-selectable assertions about effects. */
export const sandboxOperationContractSchema = variant("kind", {
  fixed_read: object({ ...contractIdentity, kind: literal("fixed_read") }),
  command: object({ ...contractIdentity, kind: literal("command") }),
  verified_effect: object({
    ...contractIdentity,
    kind: literal("verified_effect"),
    verifierRef: machineString,
    verifierVersion: machineString,
    targetRef: machineString,
  }),
  task_start: object({ ...contractIdentity, kind: literal("task_start") }),
  service_start: object({
    ...contractIdentity,
    kind: literal("service_start"),
    readinessProbeRef: machineString,
  }),
});
export type SandboxOperationContract = InferSchema<typeof sandboxOperationContractSchema>;
const additions = object({
  mode: enumeration(["foreground", "background", "service"]),
  operationContract: sandboxOperationContractSchema,
  backendRef: machineString,
  environmentId: machineString,
});
type Additions = InferSchema<typeof additions>;
export type SandboxExecutionPlanV2 = Omit<SandboxExecutionPlan, "schemaVersion"> &
  Additions & {
    readonly schemaVersion: typeof SANDBOX_EXECUTION_V2_SCHEMA_VERSION;
  };
export type SandboxExecutionPlanCandidateV2 = Omit<SandboxExecutionPlanCandidate, "schemaVersion"> &
  Additions & {
    readonly schemaVersion: typeof SANDBOX_EXECUTION_V2_SCHEMA_VERSION;
  };
function parsePlan<T extends SandboxExecutionPlan | SandboxExecutionPlanCandidate>(
  schema: Schema<T>,
  value: unknown,
  path: string,
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected a plan");
  const { schemaVersion, mode, operationContract, backendRef, environmentId, ...admission } =
    value as Record<string, unknown>;
  version.parse(schemaVersion, `${path}.schemaVersion`);
  const extra = additions.parse({ mode, operationContract, backendRef, environmentId }, path);
  const kind = extra.operationContract.kind;
  if (
    (kind === "task_start") !== (mode === "background") ||
    (kind === "service_start" && mode !== "service")
  )
    fail("operation contract does not support execution mode");
  // Reuse the exact v1 admission validation; no default fingerprint or implicit v1 upgrade.
  const base = schema.parse({ ...admission, schemaVersion: "sandbox-execution.v1" }, path);
  return Object.freeze({ ...base, ...extra, schemaVersion: SANDBOX_EXECUTION_V2_SCHEMA_VERSION });
}
export const sandboxExecutionPlanV2Schema: Schema<SandboxExecutionPlanV2> = {
  parse(value, path = "$") {
    return parsePlan(sandboxExecutionPlanSchema, value, path);
  },
};
export const sandboxExecutionPlanCandidateV2Schema: Schema<SandboxExecutionPlanCandidateV2> = {
  parse(value, path = "$") {
    return parsePlan(sandboxExecutionPlanCandidateSchema, value, path);
  },
};
/** Version dispatch preserves old records and never supplies v2 supervision defaults. */
export const versionedSandboxExecutionPlanSchema = variant("schemaVersion", {
  "sandbox-execution.v1": sandboxExecutionPlanSchema,
  "sandbox-execution.v2": sandboxExecutionPlanV2Schema,
});
const supervisor = object({
  supervisorId: machineString,
  bootId: machineString,
  epoch: integer(1),
});
const environmentFields = {
  schemaVersion: version,
  environmentId: machineString,
  resourceRef: nullable(machineString),
  creator: sandboxJobIdentitySchema,
  mode: enumeration(["foreground", "background", "service"]),
  backendRef: machineString,
  authorizationRef: machineString,
  scopeDigest: digest,
  policyDigest: digest,
  deadlineAt: timestamp,
  supervisor,
  workspaceConflictRefs: array(machineString),
};
export const sandboxEnvironmentSchema = variant("kind", {
  local: object({
    ...environmentFields,
    kind: literal("local"),
    privateDirectoryRef: machineString,
    privateDirectoryOwnerRef: machineString,
  }),
  remote: object({ ...environmentFields, kind: literal("remote"), connectionRef: machineString }),
});
export type SandboxEnvironment = InferSchema<typeof sandboxEnvironmentSchema>;
const handleFields = {
  ref: machineString,
  environmentId: machineString,
  creator: sandboxJobIdentitySchema,
  backendRef: machineString,
  authorizationRef: machineString,
  scopeDigest: digest,
  deadlineAt: timestamp,
};
export const sandboxResourceHandleSchema = variant("kind", {
  task: object({
    ...handleFields,
    kind: literal("task"),
    state: enumeration(["starting", "running", "exited", "unknown"]),
  }),
  service: object({
    ...handleFields,
    kind: literal("service"),
    readiness: enumeration(["starting", "ready", "unavailable"]),
  }),
});
export type SandboxResourceHandle = InferSchema<typeof sandboxResourceHandleSchema>;
const resultFields = {
  schemaVersion: version,
  identity: sandboxJobIdentitySchema,
  environmentId: machineString,
  policyDigest: digest,
  contract: object(contractIdentity),
  occurredAt: timestamp,
};
const successValue = object({ type: literal("value") });
const commandExit = object({ type: literal("exit"), exitCode: integer(0, 255) });
export const sandboxOperationResultSchema = variant("kind", {
  result: object({
    ...resultFields,
    kind: literal("result"),
    output: sandboxPayloadReferenceSchema,
    completion: variant("type", { value: successValue, exit: commandExit }),
  }),
  started: object({
    ...resultFields,
    kind: literal("started"),
    output: sandboxPayloadReferenceSchema,
    handle: sandboxResourceHandleSchema,
    readinessEvidence: nullable(evidence),
  }),
  error: object({
    ...resultFields,
    kind: literal("error"),
    output: sandboxPayloadReferenceSchema,
    reasonCode: machineString,
    termination: variant("type", {
      failure: object({ type: literal("failure") }),
      exit: commandExit,
      interrupted: object({ type: literal("interrupted"), signal: nullable(machineString) }),
    }),
  }),
  unknown: object({ ...resultFields, kind: literal("unknown"), reasonCode: machineString }),
});
export type SandboxOperationResult = InferSchema<typeof sandboxOperationResultSchema>;
export const sandboxEffectObservationSchema = variant("kind", {
  not_applicable: object({ kind: literal("not_applicable") }),
  not_asserted: object({ kind: literal("not_asserted") }),
  verified: object({
    kind: literal("verified"),
    verifierRef: machineString,
    verifierVersion: machineString,
    targetRef: machineString,
    evidence,
    occurredAt: timestamp,
  }),
  unknown: object({ kind: literal("unknown"), reasonCode: machineString }),
});
export type SandboxEffectObservation = InferSchema<typeof sandboxEffectObservationSchema>;
const resourceFields = {
  schemaVersion: version,
  environmentId: machineString,
  creator: sandboxJobIdentitySchema,
  policyDigest: digest,
  scopeDigest: digest,
  sequence: integer(1),
  occurredAt: timestamp,
  supervisor,
  resourceRef: nullable(machineString),
  status: variant("kind", {
    foreground: object({ kind: literal("foreground") }),
    task: object({
      kind: literal("task"),
      state: enumeration(["starting", "running", "exited", "unknown"]),
    }),
    service: object({
      kind: literal("service"),
      readiness: enumeration(["starting", "ready", "unavailable"]),
    }),
  }),
  metrics: nullable(
    object({ samples: integer(0), cpuTimeMs: integer(0), peakMemoryBytes: integer(0) }),
  ),
};
const supervisionEvidence = object({
  ref: machineString,
  digest,
  qualificationRef: machineString,
  profileRef: machineString,
  validUntil: timestamp,
  subject: variant("kind", {
    local_process: object({ kind: literal("local_process"), processIdentityRef: machineString }),
    remote_connection: object({ kind: literal("remote_connection"), connectionRef: machineString }),
  }),
});
export const sandboxResourceObservationSchema = variant("supervision", {
  initializing: object({
    ...resourceFields,
    supervision: literal("initializing"),
    cleanup: literal("pending"),
  }),
  controlled: object({
    ...resourceFields,
    supervision: literal("controlled"),
    cleanup: literal("pending"),
    evidence: supervisionEvidence,
  }),
  stopping: object({
    ...resourceFields,
    supervision: literal("stopping"),
    cleanup: literal("pending"),
    reasonCode: machineString,
  }),
  lost: object({
    ...resourceFields,
    supervision: literal("lost"),
    cleanup: literal("unknown"),
    reasonCode: machineString,
  }),
  reconciling: object({
    ...resourceFields,
    supervision: literal("reconciling"),
    cleanup: enumeration(["pending", "unknown"]),
    reasonCode: machineString,
  }),
  released: object({
    ...resourceFields,
    supervision: literal("released"),
    cleanup: literal("confirmed"),
    evidence: supervisionEvidence,
  }),
});
export type SandboxResourceObservation = InferSchema<typeof sandboxResourceObservationSchema>;
export const sandboxExecutionFactsSchema = object({
  schemaVersion: version,
  environment: sandboxEnvironmentSchema,
  result: nullable(sandboxOperationResultSchema),
  effect: sandboxEffectObservationSchema,
  resource: sandboxResourceObservationSchema,
});
export type SandboxExecutionFacts = InferSchema<typeof sandboxExecutionFactsSchema>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const transitions: Record<
  SandboxResourceObservation["supervision"],
  readonly SandboxResourceObservation["supervision"][]
> = {
  initializing: ["initializing", "controlled", "stopping", "lost", "reconciling"],
  controlled: ["controlled", "stopping", "lost", "reconciling"],
  stopping: ["stopping", "lost", "reconciling", "released"],
  lost: ["lost", "reconciling"],
  reconciling: ["reconciling", "lost", "released"],
  // A fresh verification may renew the proof of the same terminal resource.
  // It cannot revive the environment or replace its process/status facts.
  released: ["released"],
};
/** Checks binding/semantics only. Evidence authenticity must be resolved by trusted host ports. */
export function validateSandboxExecutionFacts(
  rawPlan: SandboxExecutionPlanV2,
  raw: unknown,
  binding: {
    readonly environment: SandboxEnvironment;
    readonly operationContract: SandboxOperationContract;
  },
  previous?: SandboxExecutionFacts,
): SandboxExecutionFacts {
  const plan = sandboxExecutionPlanV2Schema.parse(rawPlan);
  const facts = sandboxExecutionFactsSchema.parse(raw);
  const env = facts.environment;
  if (
    !same(
      plan.operationContract,
      sandboxOperationContractSchema.parse(binding.operationContract),
    ) ||
    !same(env, sandboxEnvironmentSchema.parse(binding.environment))
  )
    fail("frozen binding substituted");
  if (
    env.environmentId !== plan.environmentId ||
    env.backendRef !== plan.backendRef ||
    env.mode !== plan.mode ||
    env.scopeDigest !== plan.binding.scopeDigest ||
    env.authorizationRef !== plan.authorizationRef ||
    env.creator.runId !== plan.identity.runId ||
    env.creator.ownerId !== plan.identity.ownerId ||
    env.creator.agentId !== plan.identity.agentId ||
    env.creator.hostId !== plan.identity.hostId ||
    env.creator.threadId !== plan.identity.threadId ||
    Date.parse(plan.effectiveDeadlineAt) > Date.parse(env.deadlineAt)
  )
    fail("environment scope mismatch");
  const sharedRequest = plan.mode === "service" && plan.operationContract.kind !== "service_start";
  if (
    !sharedRequest &&
    (!same(env.creator, plan.identity) || env.deadlineAt !== plan.effectiveDeadlineAt)
  )
    fail("creator invocation or deadline mismatch");
  const obs = facts.resource;
  if (
    obs.environmentId !== env.environmentId ||
    obs.resourceRef !== env.resourceRef ||
    !same(obs.creator, env.creator) ||
    obs.policyDigest !== env.policyDigest ||
    obs.scopeDigest !== env.scopeDigest ||
    !same(obs.supervisor, env.supervisor)
  )
    fail("resource binding mismatch");
  if (
    (env.mode === "foreground") !== (obs.resourceRef === null) ||
    obs.status.kind !==
      ({ foreground: "foreground", background: "task", service: "service" } as const)[env.mode]
  )
    fail("resource mode mismatch");
  if (Date.parse(obs.occurredAt) < Date.parse(plan.requestedAt) && !sharedRequest)
    fail("observation predates request");
  if (
    obs.supervision === "released" &&
    ((obs.status.kind === "task" && obs.status.state !== "exited") ||
      (obs.status.kind === "service" && obs.status.readiness !== "unavailable"))
  )
    fail("released resource must be stopped");
  if (obs.supervision === "controlled" || obs.supervision === "released") {
    const subject = obs.evidence.subject;
    if (
      env.kind === "local"
        ? subject.kind !== "local_process"
        : subject.kind !== "remote_connection" || subject.connectionRef !== env.connectionRef
    )
      fail("supervision subject mismatch");
    if (
      obs.evidence.profileRef !== plan.binding.profileRef ||
      obs.evidence.qualificationRef !== plan.binding.qualificationRef ||
      Date.parse(obs.evidence.validUntil) <= Date.parse(obs.occurredAt)
    )
      fail("invalid supervision evidence window or qualification");
  }
  if (previous) {
    const prior = sandboxExecutionFactsSchema.parse(previous);
    if (
      !same(prior.environment, env) ||
      obs.sequence !== prior.resource.sequence + 1 ||
      Date.parse(obs.occurredAt) < Date.parse(prior.resource.occurredAt) ||
      !transitions[prior.resource.supervision].includes(obs.supervision) ||
      prior.resource.resourceRef !== obs.resourceRef
    )
      fail("invalid resource observation transition");
    if (
      prior.resource.supervision === "released" &&
      obs.supervision === "released" &&
      (!same(prior.resource.status, obs.status) ||
        !same(prior.resource.metrics, obs.metrics) ||
        !same(prior.resource.evidence.subject, obs.evidence.subject))
    )
      fail("released resource facts are immutable");
    if (
      prior.result !== null &&
      prior.result.kind !== "unknown" &&
      !same(prior.result, facts.result)
    )
      fail("operation result is immutable");
  }
  if (
    previous?.effect.kind === "verified" &&
    !same(sandboxEffectObservationSchema.parse(previous.effect), facts.effect)
  )
    fail("verified effects are immutable");
  const result = facts.result;
  const contract = plan.operationContract;
  if (result) {
    if (
      !same(result.identity, plan.identity) ||
      result.environmentId !== env.environmentId ||
      result.policyDigest !== env.policyDigest ||
      result.contract.ref !== contract.ref ||
      result.contract.version !== contract.version ||
      Date.parse(result.occurredAt) < Date.parse(plan.requestedAt)
    )
      fail("result invocation or policy mismatch");
    if (result.kind === "started") {
      const h = result.handle;
      if (
        !same(h.creator, env.creator) ||
        h.environmentId !== env.environmentId ||
        h.backendRef !== env.backendRef ||
        h.authorizationRef !== env.authorizationRef ||
        h.scopeDigest !== env.scopeDigest ||
        h.deadlineAt !== env.deadlineAt ||
        h.ref !== obs.resourceRef
      )
        fail("resource handle binding mismatch");
      if (contract.kind === "task_start") {
        if (h.kind !== "task" || h.state !== "running" || result.readinessEvidence !== null)
          fail("invalid task start result");
      } else if (contract.kind === "service_start") {
        if (h.kind !== "service" || h.readiness !== "ready" || result.readinessEvidence === null)
          fail("service start requires readiness evidence");
      } else fail("ordinary operation cannot return a resource handle");
    } else if (
      result.kind === "error" &&
      result.termination.type === "exit" &&
      contract.kind !== "command"
    ) {
      fail("exit branch requires command contract");
    } else if (result.kind === "result") {
      if (contract.kind === "task_start" || contract.kind === "service_start")
        fail("resource start cannot report operation completion");
      if ((contract.kind === "command") !== (result.completion.type === "exit"))
        fail("completion branch does not match operation contract");
    }
  }
  const effect = facts.effect;
  if (effect.kind === "not_applicable" && contract.kind !== "fixed_read")
    fail("only fixed reads have no asserted user effects");
  if (effect.kind === "not_asserted") {
    const normalExit =
      (result?.kind === "result" && result.completion.type === "exit") ||
      (result?.kind === "error" && result.termination.type === "exit");
    const registered =
      result?.kind === "started" &&
      (contract.kind === "task_start" || contract.kind === "service_start");
    if (!(contract.kind === "command" && normalExit) && !registered)
      fail("missing normal result cannot weaken effects");
  }
  if (effect.kind === "verified") {
    if (
      contract.kind !== "verified_effect" ||
      effect.verifierRef !== contract.verifierRef ||
      effect.verifierVersion !== contract.verifierVersion ||
      effect.targetRef !== contract.targetRef ||
      !result ||
      Date.parse(effect.occurredAt) < Date.parse(plan.requestedAt)
    )
      fail("effect verifier or target mismatch");
  }
  return facts;
}

const sandboxTaskTerminationSchema = object({
  exitCode: nullable(integer(0, 255)),
  reasonCode: machineString,
  taskProcessExited: booleanValue,
});
export type SandboxTaskTermination = InferSchema<typeof sandboxTaskTerminationSchema>;
function withTaskTermination<T extends { end: boolean }>(
  base: Schema<T>,
): Schema<T & { readonly termination?: SandboxTaskTermination }> {
  return {
    parse(value, path = "$") {
      if (!value || typeof value !== "object" || Array.isArray(value) || !("termination" in value))
        return base.parse(value, path);
      const { termination, ...rest } = value;
      const parsed = base.parse(rest, path);
      const terminal = sandboxTaskTerminationSchema.parse(termination, path);
      if (!parsed.end || (!terminal.taskProcessExited && terminal.exitCode !== null))
        throw new ContractValidationError(path, "termination requires a final output chunk");
      return { ...parsed, termination: terminal };
    },
  };
}

/** Protected, bounded output pages; cursor is a locator, never execution authority. */
export const sandboxResourceOutputQuerySchema = object({
  resourceRef: machineString,
  cursor: nullable(machineString),
  limit: integer(1, 1_048_576),
});
export const sandboxResourceOutputPageSchema = withTaskTermination(
  object({
    resourceRef: machineString,
    cursor: nullable(machineString),
    nextCursor: nullable(machineString),
    output: sandboxPayloadReferenceSchema,
    truncated: booleanValue,
    end: booleanValue,
  }),
);

export type SandboxResourceOutputQuery = InferSchema<typeof sandboxResourceOutputQuerySchema>;
export type SandboxResourceOutputPage = InferSchema<typeof sandboxResourceOutputPageSchema>;

/** Append-only output captured by the original Worker; no host paths or executable input. */
const outputBytes: Schema<string> = {
  parse(value, path = "$") {
    if (
      typeof value !== "string" ||
      value.length > 43_692 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
      throw new ContractValidationError(path, "expected bounded base64 output");
    return value;
  },
};
export const sandboxOutputChunkSchema = withTaskTermination(
  object({
    index: integer(0),
    offset: integer(0),
    bytesBase64: outputBytes,
    end: booleanValue,
  }),
);
export type SandboxOutputChunk = InferSchema<typeof sandboxOutputChunkSchema>;

/** Resource-specific infrastructure credential, carried only by authenticated
 * private Payload IPC and stored as a restricted Run artifact. Never a tool argument. */
const controlDirectory: Schema<string> = {
  parse(value, path = "$") {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value.length > 4096 ||
      value.endsWith("/") ||
      value.includes("//") ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value.split("/").some((part) => part === "." || part === "..")
    )
      throw new ContractValidationError(path, "expected a normalized absolute control directory");
    return value;
  },
};
export const sandboxJobControlBindingSchema = object({
  directory: controlDirectory,
  token: digest,
  sessionId: machineString,
  jobId: machineString,
  attemptId: machineString,
});
export type SandboxJobControlBinding = InferSchema<typeof sandboxJobControlBindingSchema>;

/** Authenticated Worker requests carry facts and locators, never database authority. */
export const sandboxExecutionBrokerCommandSchema = variant("kind", {
  register_control: object({
    kind: literal("register_control"),
    expectedSequence: integer(1, 1),
    control: sandboxJobControlBindingSchema,
  }),
  observe_control: object({ kind: literal("observe_control"), expectedSequence: integer(1) }),
  bind: object({
    kind: literal("bind"),
    expectedSequence: integer(1, 1),
    facts: sandboxExecutionFactsSchema,
  }),
  read: object({ kind: literal("read") }),
  resolve: object({ kind: literal("resolve") }),
  start: object({ kind: literal("start"), expectedSequence: integer(1), policyDigest: digest }),
  append: object({
    kind: literal("append"),
    expectedSequence: integer(1),
    expectedOperationRevision: integer(0),
    facts: sandboxExecutionFactsSchema,
  }),
  operation: object({
    kind: literal("operation"),
    expectedSequence: integer(1),
    expectedOperationRevision: integer(0),
    facts: sandboxExecutionFactsSchema,
  }),
  inspect: object({
    kind: literal("inspect"),
    resourceRef: machineString,
    expectedSequence: integer(1),
  }),
  append_output: object({
    kind: literal("append_output"),
    resourceRef: machineString,
    expectedSequence: integer(1),
    chunk: sandboxOutputChunkSchema,
  }),
  output: object({
    kind: literal("output"),
    resourceRef: machineString,
    cursor: nullable(machineString),
    limit: integer(1, 1_048_576),
    expectedSequence: integer(1),
  }),
  stop: object({
    kind: literal("stop"),
    resourceRef: nullable(machineString),
    expectedSequence: integer(1),
    reason: enumeration(["owner_cancelled", "deadline_exceeded", "supervision_lost"]),
  }),
  reconcile: object({ kind: literal("reconcile"), expectedSequence: integer(1) }),
});
export type SandboxExecutionBrokerCommand = InferSchema<typeof sandboxExecutionBrokerCommandSchema>;
