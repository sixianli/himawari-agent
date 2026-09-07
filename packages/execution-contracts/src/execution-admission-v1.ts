import { type ExecutionV2Request, executionV2MessageSchema } from "./contracts-v2.ts";
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
  parseJson,
  type Schema,
  timestamp,
} from "./validation.ts";

export const EXECUTION_ADMISSION_V1_SCHEMA_VERSION = "execution-admission.v1" as const;

export const EXECUTION_ADMISSION_V1_MESSAGE_TYPES = [
  "admission.handshake",
  "admission.handshake.accepted",
  "admission.work.execute",
  "admission.work.execute.accepted",
] as const;

export type ExecutionAdmissionV1MessageType = (typeof EXECUTION_ADMISSION_V1_MESSAGE_TYPES)[number];

const peerBindingSchema = object({
  agentServiceInstanceId: machineString,
  agentServiceBootId: machineString,
  workerInstanceId: machineString,
  workerBootId: machineString,
  deploymentId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
});

const receiptIdentitySchema = object({
  receiptRef: machineString,
  handleRef: machineString,
  invocationId: machineString,
  idempotencyKey: machineString,
  ownerId: machineString,
  agentId: machineString,
  runId: machineString,
  workerRunId: machineString,
});

export type ExecutionAdmissionPeerBinding = InferSchema<typeof peerBindingSchema>;
export type ExecutionAdmissionReceiptIdentity = InferSchema<typeof receiptIdentitySchema>;

type ExecuteWorkRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;

const executeWorkRequestSchema: Schema<ExecuteWorkRequest> = {
  parse(input, path = "$") {
    const parsed = executionV2MessageSchema.parse(input);
    if (parsed.kind !== "request" || parsed.type !== "work.execute") {
      throw new ContractValidationError(path, "expected an execution.v2 work.execute request");
    }
    if (parsed.causationId === null) {
      throw new ContractValidationError(
        `${path}.causationId`,
        "admission requires a causation parent message",
      );
    }
    return parsed;
  },
};

const delegateWorkRequestSchema: Schema<Extract<ExecutionV2Request, { type: "work.delegate" }>> = {
  parse(input, path = "$") {
    const parsed = executionV2MessageSchema.parse(input);
    if (parsed.kind !== "request" || parsed.type !== "work.delegate") {
      throw new ContractValidationError(path, "expected an execution.v2 work.delegate request");
    }
    return parsed;
  },
};

const projectionSchema = object({
  delegate: delegateWorkRequestSchema,
  execute: executeWorkRequestSchema,
});

export type ExecutionAdmissionProjection = InferSchema<typeof projectionSchema>;

const requestEnvelope = {
  schemaVersion: literal(EXECUTION_ADMISSION_V1_SCHEMA_VERSION),
  kind: literal("request"),
  messageId: machineString,
  correlationId: machineString,
  causationId: nullable(machineString),
  idempotencyKey: machineString,
} as const;

const responseEnvelope = {
  schemaVersion: literal(EXECUTION_ADMISSION_V1_SCHEMA_VERSION),
  kind: literal("response"),
  messageId: machineString,
  correlationId: machineString,
  causationId: machineString,
} as const;

export const executionAdmissionHandshakeRequestSchema = object({
  ...requestEnvelope,
  type: literal("admission.handshake"),
  payload: object({
    peer: peerBindingSchema,
    requestedAt: timestamp,
  }),
});

export const executionAdmissionHandshakeAcceptedSchema = object({
  ...responseEnvelope,
  type: literal("admission.handshake.accepted"),
  payload: object({
    peer: peerBindingSchema,
    ready: booleanValue,
    acceptedAt: timestamp,
  }),
});

export const executionAdmissionWorkExecuteRequestSchema = object({
  ...requestEnvelope,
  type: literal("admission.work.execute"),
  payload: object({
    peer: peerBindingSchema,
    execute: executeWorkRequestSchema,
  }),
});

const admissionDispositionSchema = enumeration(["consumed", "replayed", "unknown"]);

export type ExecutionAdmissionAcceptedPayload =
  | {
      readonly requestMessageId: string;
      readonly peer: ExecutionAdmissionPeerBinding;
      readonly receipt: ExecutionAdmissionReceiptIdentity;
      readonly disposition: "consumed";
      readonly projection: ExecutionAdmissionProjection;
      readonly reasonCode: null;
    }
  | {
      readonly requestMessageId: string;
      readonly peer: ExecutionAdmissionPeerBinding;
      readonly receipt: ExecutionAdmissionReceiptIdentity;
      readonly disposition: "replayed";
      readonly projection: null;
      readonly reasonCode: null;
    }
  | {
      readonly requestMessageId: string;
      readonly peer: ExecutionAdmissionPeerBinding;
      readonly receipt: ExecutionAdmissionReceiptIdentity;
      readonly disposition: "unknown";
      readonly projection: null;
      readonly reasonCode: string;
    };

const acceptedPayloadSchema: Schema<ExecutionAdmissionAcceptedPayload> = {
  parse(input, path = "$") {
    const parsed = object({
      requestMessageId: machineString,
      peer: peerBindingSchema,
      receipt: receiptIdentitySchema,
      disposition: admissionDispositionSchema,
      projection: nullable(projectionSchema),
      reasonCode: nullable(machineString),
    }).parse(input, path);
    switch (parsed.disposition) {
      case "consumed":
        if (parsed.projection === null || parsed.reasonCode !== null) {
          throw new ContractValidationError(
            path,
            "consumed admission must include a projection and no reasonCode",
          );
        }
        return {
          ...parsed,
          disposition: "consumed",
          projection: projectionSchema.parse(parsed.projection, `${path}.projection`),
          reasonCode: null,
        };
      case "replayed":
        if (parsed.projection !== null || parsed.reasonCode !== null) {
          throw new ContractValidationError(
            path,
            "replayed admission must not include a projection or reasonCode",
          );
        }
        return {
          ...parsed,
          disposition: "replayed",
          projection: null,
          reasonCode: null,
        };
      case "unknown":
        if (parsed.projection !== null || parsed.reasonCode === null) {
          throw new ContractValidationError(
            path,
            "unknown admission must include a reasonCode and no projection",
          );
        }
        return {
          ...parsed,
          disposition: "unknown",
          projection: null,
          reasonCode: parsed.reasonCode,
        };
      default: {
        const exhaustive: never = parsed.disposition;
        throw new ContractValidationError(path, `unsupported admission disposition ${exhaustive}`);
      }
    }
  },
};

export const executionAdmissionWorkExecuteAcceptedSchema = object({
  ...responseEnvelope,
  type: literal("admission.work.execute.accepted"),
  payload: acceptedPayloadSchema,
});

export type ExecutionAdmissionHandshakeRequest = InferSchema<
  typeof executionAdmissionHandshakeRequestSchema
>;
export type ExecutionAdmissionHandshakeAccepted = InferSchema<
  typeof executionAdmissionHandshakeAcceptedSchema
>;
export type ExecutionAdmissionWorkExecuteRequest = InferSchema<
  typeof executionAdmissionWorkExecuteRequestSchema
>;
export type ExecutionAdmissionWorkExecuteAccepted = InferSchema<
  typeof executionAdmissionWorkExecuteAcceptedSchema
>;
export type ExecutionAdmissionV1Request =
  | ExecutionAdmissionHandshakeRequest
  | ExecutionAdmissionWorkExecuteRequest;
export type ExecutionAdmissionV1Response =
  | ExecutionAdmissionHandshakeAccepted
  | ExecutionAdmissionWorkExecuteAccepted;
export type ExecutionAdmissionV1Message =
  | ExecutionAdmissionV1Request
  | ExecutionAdmissionV1Response;

function parseExecutionAdmissionMessage(input: unknown): ExecutionAdmissionV1Message {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected an execution admission message");
  }
  const type = (input as { readonly type?: unknown }).type;
  switch (type) {
    case "admission.handshake":
      return executionAdmissionHandshakeRequestSchema.parse(input);
    case "admission.handshake.accepted":
      return executionAdmissionHandshakeAcceptedSchema.parse(input);
    case "admission.work.execute":
      return executionAdmissionWorkExecuteRequestSchema.parse(input);
    case "admission.work.execute.accepted":
      return executionAdmissionWorkExecuteAcceptedSchema.parse(input);
    default:
      throw new ContractValidationError("$.type", "unsupported execution admission message type");
  }
}

export const executionAdmissionV1MessageSchema = Object.freeze({
  schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
  parse(input: unknown): ExecutionAdmissionV1Message {
    return parseExecutionAdmissionMessage(input);
  },
  parseJson(json: string): ExecutionAdmissionV1Message {
    return parseJson({ parse: parseExecutionAdmissionMessage }, json);
  },
  serialize(message: ExecutionAdmissionV1Message): string {
    return JSON.stringify(parseExecutionAdmissionMessage(message));
  },
});
