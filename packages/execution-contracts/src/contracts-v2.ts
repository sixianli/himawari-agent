import {
  ContractValidationError,
  type InferSchema,
  type Schema,
  array,
  booleanValue,
  enumeration,
  integer,
  literal,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "./validation.js";

export const EXECUTION_V2_SCHEMA_VERSION = "execution.v2" as const;
export const EXECUTION_V2_MESSAGE_TYPES = [
  "worker.handshake",
  "worker.handshake.accepted",
  "worker.readiness.query",
  "worker.readiness.snapshot",
  "work.delegate",
  "work.delegate.accepted",
  "work.execute",
  "work.cancel",
  "work.events.replay",
  "work.reconcile",
  "work.progress",
  "work.result",
  "work.cancelled",
  "work.reconciled",
] as const;

export type ExecutionV2MessageType = (typeof EXECUTION_V2_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(["public", "private", "sensitive", "restricted"]);
const riskSchema = enumeration(["low", "medium", "high", "critical"]);
const scopeSchema = object({
  deploymentId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
  ownerId: nullable(machineString),
  agentId: nullable(machineString),
  runId: nullable(machineString),
  workerRunId: nullable(machineString),
});

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(EXECUTION_V2_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
    dataClassification: classificationSchema,
    risk: riskSchema,
    authorizationRef: nullable(machineString),
    scope: scopeSchema,
  } as const;
}

function requestEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("request", type), idempotencyKey: machineString } as const;
}

export const workerHandshakeRequestSchema = object({
  ...requestEnvelope("worker.handshake"),
  payload: object({
    agentServiceInstanceId: machineString,
    bootTokenRef: machineString,
    supportedSchemaVersions: array(machineString),
    requestedAt: timestamp,
  }),
});

export const workerHandshakeAcceptedSchema = object({
  ...envelope("response", "worker.handshake.accepted"),
  payload: object({
    workerInstanceId: machineString,
    workerBootId: machineString,
    selectedSchemaVersion: literal(EXECUTION_V2_SCHEMA_VERSION),
    ready: booleanValue,
    acceptedAt: timestamp,
  }),
});

export const workerReadinessQuerySchema = object({
  ...requestEnvelope("worker.readiness.query"),
  payload: object({ requestedAt: timestamp }),
});

export const workerReadinessSnapshotSchema = object({
  ...envelope("response", "worker.readiness.snapshot"),
  payload: object({
    workerInstanceId: machineString,
    live: booleanValue,
    ready: booleanValue,
    supportedSchemaVersions: array(machineString),
    reasonCodes: array(machineString),
    observedAt: timestamp,
  }),
});

const secretReferenceSchema = object({
  secretRef: machineString,
  secretVersion: machineString,
  purpose: machineString,
});

const delegatedCapabilityHandleSchema = object({
  handleVersion: literal("capability-handle.v2"),
  ref: machineString,
  revision: integer(1),
  authorityFence: integer(1),
  ownerId: machineString,
  agentId: machineString,
  runId: machineString,
  capabilityRef: machineString,
  capabilityVersion: machineString,
  authorizationType: enumeration(["policy", "grant"]),
  authorizationRef: machineString,
  operations: array(machineString),
  inputRefs: array(machineString),
  delegatedContextRefs: array(machineString),
  secretRefs: array(secretReferenceSchema),
  maxDataClassification: classificationSchema,
  issuedAt: timestamp,
  expiresAt: timestamp,
  revokedAt: nullable(timestamp),
  operation: machineString,
  maxUses: integer(1),
  uses: integer(0),
  maxTotalCostMicros: integer(0),
  spentCostMicros: integer(0),
  idempotencyKeys: array(machineString),
  workerEndedAt: nullable(timestamp),
});

export const delegateWorkRequestSchema = object({
  ...requestEnvelope("work.delegate"),
  payload: object({
    handle: delegatedCapabilityHandleSchema,
    requestedAt: timestamp,
  }),
});

export const delegateWorkAcceptedSchema = object({
  ...envelope("response", "work.delegate.accepted"),
  payload: object({
    handleRef: machineString,
    workerBootId: machineString,
    acceptedAt: timestamp,
  }),
});

const resourceCeilingSchema = object({
  maxWallTimeMs: integer(1),
  maxCpuTimeMs: integer(1),
  maxMemoryBytes: integer(1),
  maxOutputBytes: integer(1),
  maxProgressEvents: integer(1),
});

const executePayloadSchema = object({
  capabilityId: machineString,
  capabilityVersion: machineString,
  operation: machineString,
  inputRef: machineString,
  capabilityHandleRef: machineString,
  delegatedContextRefs: array(machineString),
  secretRefs: array(secretReferenceSchema),
  resourceCeiling: resourceCeilingSchema,
  requestedAt: timestamp,
  deadlineAt: timestamp,
});

export const executeWorkV2RequestSchema = object({
  ...requestEnvelope("work.execute"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = executePayloadSchema.parse(input, path);
      if (payload.deadlineAt <= payload.requestedAt) {
        throw new ContractValidationError(`${path}.deadlineAt`, "must be later than requestedAt");
      }
      return payload;
    },
  },
});

export const cancelWorkV2RequestSchema = object({
  ...requestEnvelope("work.cancel"),
  payload: object({
    targetRequestId: machineString,
    reasonCode: machineString,
    requestedAt: timestamp,
  }),
});

export const replayWorkEventsRequestSchema = object({
  ...requestEnvelope("work.events.replay"),
  payload: object({
    afterCursor: nullable(machineString),
    limit: integer(1, 1000),
    requestedAt: timestamp,
  }),
});

export const reconcileWorkV2RequestSchema = object({
  ...requestEnvelope("work.reconcile"),
  payload: object({
    targetRequestId: machineString,
    externalActionId: machineString,
    resultLookupRef: machineString,
    requestedAt: timestamp,
  }),
});

const eventCursor = {
  cursor: machineString,
  sequence: integer(1),
} as const;

export const workProgressV2EventSchema = object({
  ...envelope("event", "work.progress"),
  payload: object({
    requestId: machineString,
    ...eventCursor,
    occurredAt: timestamp,
    stage: machineString,
    progressPermille: integer(0, 1000),
    payloadRef: nullable(machineString),
  }),
});

const workResultPayloadSchema = object({
  requestId: machineString,
  ...eventCursor,
  completedAt: timestamp,
  outcome: enumeration(["succeeded", "failed", "result_unknown"]),
  outputRef: nullable(machineString),
  errorCode: nullable(machineString),
  externalActionId: nullable(machineString),
});

export const workResultV2EventSchema = object({
  ...envelope("event", "work.result"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = workResultPayloadSchema.parse(input, path);
      const valid =
        (payload.outcome === "succeeded" &&
          payload.outputRef !== null &&
          payload.errorCode === null &&
          payload.externalActionId === null) ||
        (payload.outcome === "failed" &&
          payload.outputRef === null &&
          payload.errorCode !== null &&
          payload.externalActionId === null) ||
        (payload.outcome === "result_unknown" &&
          payload.outputRef === null &&
          payload.errorCode === null &&
          payload.externalActionId !== null);
      if (!valid) {
        throw new ContractValidationError(
          path,
          "result references do not match the declared outcome",
        );
      }
      return payload;
    },
  },
});

export const workCancelledV2EventSchema = object({
  ...envelope("event", "work.cancelled"),
  payload: object({
    requestId: machineString,
    ...eventCursor,
    cancelledAt: timestamp,
    reasonCode: machineString,
  }),
});

const reconciledPayloadSchema = object({
  requestId: machineString,
  externalActionId: machineString,
  ...eventCursor,
  reconciledAt: timestamp,
  outcome: enumeration(["confirmed_succeeded", "confirmed_failed", "still_unknown"]),
  resultRef: nullable(machineString),
  errorCode: nullable(machineString),
});

export const workReconciledV2EventSchema = object({
  ...envelope("event", "work.reconciled"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = reconciledPayloadSchema.parse(input, path);
      const valid =
        (payload.outcome === "confirmed_succeeded" &&
          payload.resultRef !== null &&
          payload.errorCode === null) ||
        (payload.outcome === "confirmed_failed" &&
          payload.resultRef === null &&
          payload.errorCode !== null) ||
        (payload.outcome === "still_unknown" &&
          payload.resultRef === null &&
          payload.errorCode === null);
      if (!valid) {
        throw new ContractValidationError(
          path,
          "reconciliation references do not match the declared outcome",
        );
      }
      return payload;
    },
  },
});

const schemasByType = {
  "worker.handshake": workerHandshakeRequestSchema,
  "worker.handshake.accepted": workerHandshakeAcceptedSchema,
  "worker.readiness.query": workerReadinessQuerySchema,
  "worker.readiness.snapshot": workerReadinessSnapshotSchema,
  "work.delegate": delegateWorkRequestSchema,
  "work.delegate.accepted": delegateWorkAcceptedSchema,
  "work.execute": executeWorkV2RequestSchema,
  "work.cancel": cancelWorkV2RequestSchema,
  "work.events.replay": replayWorkEventsRequestSchema,
  "work.reconcile": reconcileWorkV2RequestSchema,
  "work.progress": workProgressV2EventSchema,
  "work.result": workResultV2EventSchema,
  "work.cancelled": workCancelledV2EventSchema,
  "work.reconciled": workReconciledV2EventSchema,
} as const satisfies Record<ExecutionV2MessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;

export type SecretReferenceV2 = InferSchema<typeof secretReferenceSchema>;
export type DelegatedCapabilityHandleV2 = InferSchema<typeof delegatedCapabilityHandleSchema>;
export type ResourceCeiling = InferSchema<typeof resourceCeilingSchema>;
export type ExecutionV2Message = InferSchema<SchemaByType[keyof SchemaByType]>;
export type ExecutionV2Request = Extract<ExecutionV2Message, { kind: "request" }>;
export type ExecutionV2Response = Extract<ExecutionV2Message, { kind: "response" }>;
export type ExecutionV2Event = Extract<ExecutionV2Message, { kind: "event" }>;

function readType(input: unknown): ExecutionV2MessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected an Execution v2 message object");
  }
  return enumeration(EXECUTION_V2_MESSAGE_TYPES).parse(
    (input as { readonly type?: unknown }).type,
    "$.type",
  );
}

function parseExecutionV2Message(input: unknown): ExecutionV2Message {
  const parsed = schemasByType[readType(input)].parse(input, "$") as ExecutionV2Message;
  if (
    parsed.kind === "request" &&
    (parsed.risk === "high" || parsed.risk === "critical") &&
    parsed.authorizationRef === null
  ) {
    throw new ContractValidationError(
      "$.authorizationRef",
      "high and critical risk requests require an authorization reference",
    );
  }
  if (parsed.type.startsWith("work.") && parsed.type !== "work.events.replay") {
    const { ownerId, agentId, runId, workerRunId } = parsed.scope;
    if ([ownerId, agentId, runId, workerRunId].some((value) => value === null)) {
      throw new ContractValidationError(
        "$.scope",
        "work messages require owner, agent, Run and Worker Run scope",
      );
    }
  }
  return parsed;
}

export const executionV2MessageSchema = Object.freeze({
  schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
  parse(input: unknown): ExecutionV2Message {
    return parseExecutionV2Message(input);
  },
  parseJson(json: string): ExecutionV2Message {
    return parseJson({ parse: parseExecutionV2Message }, json);
  },
  serialize(message: ExecutionV2Message): string {
    return JSON.stringify(parseExecutionV2Message(message));
  },
});
