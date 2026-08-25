import {
  ContractValidationError,
  type InferSchema,
  type Schema,
  array,
  enumeration,
  integer,
  literal,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "./validation.js";

export const EXECUTION_SCHEMA_VERSION = "execution.v1" as const;
export const DATA_CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
export const EXECUTION_MESSAGE_TYPES = [
  "work.execute",
  "work.cancel",
  "work.reconcile",
  "work.progress",
  "work.result",
  "work.cancelled",
  "work.reconciled",
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];
export type ExecutionMessageType = (typeof EXECUTION_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(DATA_CLASSIFICATIONS);
const scopeSchema = object({
  ownerId: machineString,
  agentId: machineString,
  runId: machineString,
  workerRunId: machineString,
});

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(EXECUTION_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: machineString,
    dataClassification: classificationSchema,
    scope: scopeSchema,
  } as const;
}

function requestEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("request", type), idempotencyKey: machineString } as const;
}

const secretReferenceSchema = object({
  secretRef: machineString,
  secretVersion: machineString,
  purpose: machineString,
});

const executeWorkPayloadSchema = object({
  capabilityId: machineString,
  capabilityVersion: machineString,
  operation: machineString,
  inputRef: machineString,
  capabilityHandleRef: machineString,
  delegatedContextRefs: array(machineString),
  secretRefs: array(secretReferenceSchema),
  requestedAt: timestamp,
  deadlineAt: timestamp,
});

export const executeWorkRequestSchema = object({
  ...requestEnvelope("work.execute"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = executeWorkPayloadSchema.parse(input, path);
      if (payload.deadlineAt <= payload.requestedAt) {
        throw new ContractValidationError(`${path}.deadlineAt`, "must be later than requestedAt");
      }
      return payload;
    },
  },
});

export const cancelWorkRequestSchema = object({
  ...requestEnvelope("work.cancel"),
  payload: object({
    targetRequestId: machineString,
    reasonCode: machineString,
    requestedAt: timestamp,
  }),
});

export const reconcileWorkRequestSchema = object({
  ...requestEnvelope("work.reconcile"),
  payload: object({
    externalActionId: machineString,
    resultLookupRef: machineString,
    requestedAt: timestamp,
  }),
});

export const workProgressEventSchema = object({
  ...envelope("event", "work.progress"),
  payload: object({
    requestId: machineString,
    sequence: integer(1),
    occurredAt: timestamp,
    stage: machineString,
    progressPermille: integer(0, 1000),
    payloadRef: nullable(machineString),
  }),
});

const workResultPayloadSchema = object({
  requestId: machineString,
  completedAt: timestamp,
  outcome: enumeration(["succeeded", "failed", "result_unknown"]),
  outputRef: nullable(machineString),
  errorCode: nullable(machineString),
  externalActionId: nullable(machineString),
});

export const workResultEventSchema = object({
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

export const workCancelledEventSchema = object({
  ...envelope("event", "work.cancelled"),
  payload: object({
    requestId: machineString,
    cancelledAt: timestamp,
    reasonCode: machineString,
  }),
});

const workReconciledPayloadSchema = object({
  requestId: machineString,
  externalActionId: machineString,
  reconciledAt: timestamp,
  outcome: enumeration(["confirmed_succeeded", "confirmed_failed", "still_unknown"]),
  resultRef: nullable(machineString),
  errorCode: nullable(machineString),
});

export const workReconciledEventSchema = object({
  ...envelope("event", "work.reconciled"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = workReconciledPayloadSchema.parse(input, path);
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
  "work.execute": executeWorkRequestSchema,
  "work.cancel": cancelWorkRequestSchema,
  "work.reconcile": reconcileWorkRequestSchema,
  "work.progress": workProgressEventSchema,
  "work.result": workResultEventSchema,
  "work.cancelled": workCancelledEventSchema,
  "work.reconciled": workReconciledEventSchema,
} as const satisfies Record<ExecutionMessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;

export type SecretReference = InferSchema<typeof secretReferenceSchema>;
export type ExecuteWorkRequest = InferSchema<typeof executeWorkRequestSchema>;
export type CancelWorkRequest = InferSchema<typeof cancelWorkRequestSchema>;
export type ReconcileWorkRequest = InferSchema<typeof reconcileWorkRequestSchema>;
export type WorkProgressEvent = InferSchema<typeof workProgressEventSchema>;
export type WorkResultEvent = InferSchema<typeof workResultEventSchema>;
export type WorkCancelledEvent = InferSchema<typeof workCancelledEventSchema>;
export type WorkReconciledEvent = InferSchema<typeof workReconciledEventSchema>;
export type ExecutionMessage = InferSchema<SchemaByType[keyof SchemaByType]>;
export type ExecutionRequest = Extract<ExecutionMessage, { kind: "request" }>;
export type ExecutionEvent = Extract<ExecutionMessage, { kind: "event" }>;

function readType(input: unknown): ExecutionMessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected an Execution message object");
  }
  const type = (input as { readonly type?: unknown }).type;
  return enumeration(EXECUTION_MESSAGE_TYPES).parse(type, "$.type");
}

export const executionMessageSchema = Object.freeze({
  schemaVersion: EXECUTION_SCHEMA_VERSION,
  parse(input: unknown): ExecutionMessage {
    return parseExecutionMessage(input);
  },
  parseJson(json: string): ExecutionMessage {
    return parseJson({ parse: parseExecutionMessage }, json);
  },
  serialize(message: ExecutionMessage): string {
    return JSON.stringify(parseExecutionMessage(message));
  },
});

function parseExecutionMessage(input: unknown): ExecutionMessage {
  const type = readType(input);
  return schemasByType[type].parse(input, "$") as ExecutionMessage;
}
