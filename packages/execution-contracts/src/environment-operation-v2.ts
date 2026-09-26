import {
  executionBackendCapabilitiesSchema,
  executionEnvelopeSchema,
  executionEnvironmentIdentitySchema,
  executionEnvironmentLocatorSchema,
  executionEnvironmentStopProofSchema,
} from "./execution-environment-v1.ts";
import {
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

export const ENVIRONMENT_OPERATIONS = [
  "capabilities",
  "create",
  "inspect",
  "stop",
  "verifyStopped",
  "destroy",
] as const;
export type EnvironmentOperation = (typeof ENVIRONMENT_OPERATIONS)[number];

const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "expected a SHA-256 hex digest");
    return value;
  },
};
const accepted: Schema<true> = {
  parse(value, path = "$") {
    if (value !== true) throw new ContractValidationError(path, "expected true");
    return true;
  },
};
const bounds = { requestedAt: timestamp, deadlineAt: timestamp } as const;
const target = {
  identity: executionEnvironmentIdentitySchema,
  createIntentId: machineString,
  locator: nullable(executionEnvironmentLocatorSchema),
} as const;
const stopTarget = { ...target, stopIntentId: machineString, stopFence: integer(1) } as const;

const requestBranches = {
  capabilities: object({ operation: literal("capabilities"), ...bounds }),
  create: object({
    operation: literal("create"),
    identity: executionEnvironmentIdentitySchema,
    createIntentId: machineString,
    envelope: executionEnvelopeSchema,
    policyDigest: digest,
    imageDigest: digest,
    runnerDigest: digest,
    environmentDeadlineAt: timestamp,
    ...bounds,
  }),
  inspect: object({ operation: literal("inspect"), ...target, ...bounds }),
  stop: object({ operation: literal("stop"), ...stopTarget, ...bounds }),
  verifyStopped: object({ operation: literal("verifyStopped"), ...stopTarget, ...bounds }),
  destroy: object({ operation: literal("destroy"), ...target, ...bounds }),
} as const;

const resultSchemas = {
  capabilities: executionBackendCapabilitiesSchema,
  create: executionEnvironmentLocatorSchema,
  inspect: object({
    state: enumeration(["running", "stopped", "not_found", "unknown"]),
    locator: nullable(executionEnvironmentLocatorSchema),
    observedAt: timestamp,
  }),
  stop: object({ accepted }),
  verifyStopped: executionEnvironmentStopProofSchema,
  destroy: object({ destroyed: booleanValue }),
} as const satisfies Record<EnvironmentOperation, Schema<unknown>>;

export type EnvironmentOperationRequestPayload = InferSchema<
  (typeof requestBranches)[keyof typeof requestBranches]
>;
export type EnvironmentOperationResults = {
  readonly [TOperation in EnvironmentOperation]: InferSchema<(typeof resultSchemas)[TOperation]>;
};

function operationOf(value: unknown, path: string): EnvironmentOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError(path, "expected an object");
  return enumeration(ENVIRONMENT_OPERATIONS).parse(
    (value as Record<string, unknown>)["operation"],
    `${path}.operation`,
  );
}

export const environmentOperationRequestPayloadSchema: Schema<EnvironmentOperationRequestPayload> =
  {
    parse(value, path = "$") {
      const payload = requestBranches[operationOf(value, path)].parse(
        value,
        path,
      ) as EnvironmentOperationRequestPayload;
      if (payload.deadlineAt <= payload.requestedAt)
        throw new ContractValidationError(`${path}.deadlineAt`, "must be later than requestedAt");
      return payload;
    },
  };

const resultPayload = object({
  requestId: machineString,
  operation: enumeration(ENVIRONMENT_OPERATIONS),
  cursor: machineString,
  sequence: integer(1),
  outcome: enumeration(["succeeded", "failed", "result_unknown"]),
  result: { parse: (value: unknown) => value },
  errorCode: nullable(machineString),
  completedAt: timestamp,
});
export type EnvironmentOperationResultPayload = InferSchema<typeof resultPayload>;

export const environmentOperationResultPayloadSchema: Schema<EnvironmentOperationResultPayload> = {
  parse(value, path = "$") {
    const payload = resultPayload.parse(value, path);
    if (payload.outcome === "succeeded") {
      if (payload.result === null || payload.errorCode !== null)
        throw new ContractValidationError(path, "a success carries a result and no error code");
      return Object.freeze({
        ...payload,
        result: resultSchemas[payload.operation].parse(payload.result, `${path}.result`),
      });
    }
    if (payload.result !== null || (payload.outcome === "failed") !== (payload.errorCode !== null))
      throw new ContractValidationError(
        path,
        "a failure carries only an error code and an unknown result carries neither",
      );
    return payload;
  },
};

export function environmentOperationScopeMatches(
  scope: {
    readonly ownerId: string | null;
    readonly agentId: string | null;
    readonly runId: string | null;
  },
  payload: EnvironmentOperationRequestPayload,
): boolean {
  return (
    !("identity" in payload) ||
    (payload.identity.ownerId === scope.ownerId &&
      payload.identity.agentId === scope.agentId &&
      payload.identity.runId === scope.runId)
  );
}
