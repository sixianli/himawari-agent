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

export const EXECUTION_ENVIRONMENT_V1 = "execution-environment.v1" as const;
export const EXECUTION_BACKEND_PROTOCOL_V1 = "execution-backend.v1" as const;
export const EXECUTION_ENVELOPE_V1 = "execution-envelope.v1" as const;

export const TASK_ENVIRONMENT_GUARANTEES = [
  "immutable-environment-identity.v1",
  "whole-environment-stop.v1",
  "no-automatic-restart.v1",
  "protected-init-wall-clock-deadline.v1",
  "enforced-resource-limits.v1",
  "task-egress-policy.v1",
] as const;
export const STOP_PROOF_COVERAGE = [
  "environment_terminated",
  "no_restart",
  "execute_closed",
  "egress_closed",
  "credentials_revoked",
] as const;

const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "expected a SHA-256 hex digest");
    return value;
  },
};
function unique<T>(schema: Schema<readonly T[]>, key: (value: T) => string): Schema<readonly T[]> {
  return {
    parse(value, path = "$") {
      const parsed = schema.parse(value, path);
      if (new Set(parsed.map(key)).size !== parsed.length)
        throw new ContractValidationError(path, "expected unique entries");
      return parsed;
    },
  };
}
function nonEmpty<T>(schema: Schema<readonly T[]>): Schema<readonly T[]> {
  return {
    parse(value, path = "$") {
      const parsed = schema.parse(value, path);
      if (parsed.length === 0) throw new ContractValidationError(path, "expected entries");
      return parsed;
    },
  };
}
const networkTarget: Schema<string> = {
  parse(value, path = "$") {
    if (
      typeof value !== "string" ||
      value.length > 260 ||
      !/^(?=.{1,253}:)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:(?:[1-9][0-9]{0,4})$/.test(
        value,
      ) ||
      Number(value.slice(value.lastIndexOf(":") + 1)) > 65535
    )
      throw new ContractValidationError(path, "expected an exact lowercase hostname:port");
    return value;
  },
};

export const executionEnvironmentIdentitySchema = object({
  schemaVersion: literal(EXECUTION_ENVIRONMENT_V1),
  ownerId: machineString,
  agentId: machineString,
  runId: machineString,
  hostId: machineString,
  executionJobId: machineString,
  environmentId: machineString,
  environmentGeneration: integer(1),
  role: enumeration(["primary", "network_helper"]),
});
export type ExecutionEnvironmentIdentity = InferSchema<typeof executionEnvironmentIdentitySchema>;

export const executionCapabilitySourceSchema = object({
  authorizationRef: machineString,
  decidedBy: enumeration(["user", "automatic_review"]),
  delegationListRef: nullable(machineString),
  expiresAt: timestamp,
});
export type ExecutionCapabilitySource = InferSchema<typeof executionCapabilitySourceSchema>;

const directoryCapability = object({
  hostId: machineString,
  grantRef: machineString,
  canonicalRootId: machineString,
  access: enumeration(["read", "write"]),
  source: executionCapabilitySourceSchema,
});
const networkCapability = object({
  target: networkTarget,
  source: executionCapabilitySourceSchema,
});
export const executionEnvelopeSchema = object({
  schemaVersion: literal(EXECUTION_ENVELOPE_V1),
  directories: unique(
    array(directoryCapability),
    (item) => `${item.hostId}\n${item.canonicalRootId}`,
  ),
  network: unique(array(networkCapability), (item) => item.target),
  resources: object({
    cpuMillicores: integer(1),
    memoryBytes: integer(1),
    maxProcesses: integer(1),
    privateStorageBytes: integer(1),
  }),
});
export type ExecutionEnvelope = InferSchema<typeof executionEnvelopeSchema>;

export const EXECUTION_DELEGATION_LIST_V1 = "execution-delegation-list.v1" as const;
const delegatedNetwork = object({ kind: literal("network"), target: networkTarget });
const delegatedDirectoryRead = object({
  kind: literal("directory_read"),
  hostId: machineString,
  canonicalRootId: machineString,
});
export type ExecutionDelegationItem =
  | InferSchema<typeof delegatedNetwork>
  | InferSchema<typeof delegatedDirectoryRead>;
const delegationItem: Schema<ExecutionDelegationItem> = {
  parse(value, path = "$") {
    const kind =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)["kind"]
        : undefined;
    if (kind === "network") return delegatedNetwork.parse(value, path);
    if (kind === "directory_read") return delegatedDirectoryRead.parse(value, path);
    throw new ContractValidationError(
      `${path}.kind`,
      "only exact network targets and directory reads can be delegated",
    );
  },
};
export const executionDelegationListSchema = object({
  schemaVersion: literal(EXECUTION_DELEGATION_LIST_V1),
  ref: machineString,
  revision: integer(1),
  items: unique(array(delegationItem), (item) =>
    item.kind === "network"
      ? `network\n${item.target}`
      : `read\n${item.hostId}\n${item.canonicalRootId}`,
  ),
});
export type ExecutionDelegationList = InferSchema<typeof executionDelegationListSchema>;

export const executionBackendCapabilitiesSchema = object({
  protocolVersion: literal(EXECUTION_BACKEND_PROTOCOL_V1),
  backendRef: machineString,
  runtimeInstanceId: machineString,
  guarantees: unique(array(enumeration(TASK_ENVIRONMENT_GUARANTEES)), (item) => item),
  checkedAt: timestamp,
});
export type ExecutionBackendCapabilities = InferSchema<typeof executionBackendCapabilitiesSchema>;

export const executionEnvironmentLocatorSchema = object({
  backendRef: machineString,
  runtimeInstanceId: machineString,
  runtimeEnvironmentId: machineString,
  createIntentId: machineString,
  effectivePolicyDigest: digest,
});
export type ExecutionEnvironmentLocator = InferSchema<typeof executionEnvironmentLocatorSchema>;

const evidence = nonEmpty(array(object({ ref: machineString, digest })));
const proofFields = {
  identity: executionEnvironmentIdentitySchema,
  createIntentId: machineString,
  stopIntentId: machineString,
  stopFence: integer(1),
  verifierRef: machineString,
  checkedAt: timestamp,
  validUntil: timestamp,
  evidence,
};
const verifiedStopped = object({
  basis: literal("verified_stopped"),
  ...proofFields,
  locator: executionEnvironmentLocatorSchema,
  coverage: unique(array(enumeration(STOP_PROOF_COVERAGE)), (item) => item),
});
const neverCreated = object({ basis: literal("never_created"), ...proofFields });
export type ExecutionEnvironmentStopProof =
  | InferSchema<typeof verifiedStopped>
  | InferSchema<typeof neverCreated>;
export const executionEnvironmentStopProofSchema: Schema<ExecutionEnvironmentStopProof> = {
  parse(value, path = "$") {
    const basis =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)["basis"]
        : undefined;
    const proof =
      basis === "verified_stopped"
        ? verifiedStopped.parse(value, path)
        : basis === "never_created"
          ? neverCreated.parse(value, path)
          : (() => {
              throw new ContractValidationError(`${path}.basis`, "unknown branch");
            })();
    if (proof.basis === "verified_stopped" && proof.coverage.length !== STOP_PROOF_COVERAGE.length)
      throw new ContractValidationError(`${path}.coverage`, "expected complete stop coverage");
    if (Date.parse(proof.validUntil) <= Date.parse(proof.checkedAt))
      throw new ContractValidationError(`${path}.validUntil`, "expected a later validity bound");
    return proof;
  },
};
