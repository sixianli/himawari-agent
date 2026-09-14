import {
  sandboxExecutionPlanSchema,
  sandboxJobIdentitySchema,
  sandboxJobReceiptSchema,
} from "./sandbox-execution-v1.ts";
import {
  sandboxExecutionBrokerCommandSchema,
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanV2Schema,
  sandboxResourceOutputPageSchema,
  validateSandboxExecutionFacts,
} from "./sandbox-execution-v2.ts";
import { sandboxExecutionReservationSchema } from "./sandbox-preparation-v2.ts";
import { resolvedSandboxScopeSchema } from "./sandbox-scope-v1.ts";
import {
  booleanValue,
  ContractValidationError,
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

export const PAYLOAD_BROKER_V1_SCHEMA_VERSION = "payload-broker.v1" as const;

export const PAYLOAD_BROKER_V1_MESSAGE_TYPES = [
  "payload.sandbox.execution",
  "payload.sandbox.execution.result",
  "payload.sandbox.job",
  "payload.sandbox.job.result",
  "payload.handshake",
  "payload.handshake.accepted",
  "payload.input.read",
  "payload.input.read.result",
  "payload.output.write",
  "payload.output.write.accepted",
] as const;

export type PayloadBrokerV1MessageType = (typeof PAYLOAD_BROKER_V1_MESSAGE_TYPES)[number];

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA_TOKEN = "[A-Za-z0-9!#$%&'*+\\-.^_`|~]+";
const CONTENT_TYPE_PATTERN = new RegExp(
  `^${MEDIA_TOKEN}/${MEDIA_TOKEN}(?:;[ \\t]*${MEDIA_TOKEN}=${MEDIA_TOKEN})*$`,
);

function fail(path: string, message: string): never {
  throw new ContractValidationError(path, message);
}

function base64Value(character: string): number {
  const value = BASE64_ALPHABET.indexOf(character);
  return value;
}

function hasCanonicalPaddingBits(encoded: string): boolean {
  if (encoded.length === 0) return true;
  if (encoded.endsWith("==")) {
    const second = base64Value(encoded.at(-3) ?? "");
    return second >= 0 && (second & 0x0f) === 0;
  }
  if (encoded.endsWith("=")) {
    const third = base64Value(encoded.at(-2) ?? "");
    return third >= 0 && (third & 0x03) === 0;
  }
  return true;
}

const payloadBytesSchema: Schema<string> = {
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      !BASE64_PATTERN.test(input) ||
      !hasCanonicalPaddingBits(input)
    ) {
      fail(path, "expected canonical padded base64 bytes");
    }
    return input;
  },
};

const contentTypeSchema: Schema<string> = {
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.length > 256 ||
      [...input].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      ) ||
      !CONTENT_TYPE_PATTERN.test(input)
    ) {
      fail(path, "expected a valid bounded media type");
    }
    return input;
  },
};

function envelope<const TKind extends "request" | "response", const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(PAYLOAD_BROKER_V1_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
  } as const;
}

function requestEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("request", type), idempotencyKey: machineString } as const;
}

export const payloadBrokerHandshakeRequestSchema = object({
  ...requestEnvelope("payload.handshake"),
  payload: object({
    agentServiceInstanceId: machineString,
    agentServiceBootId: machineString,
    workerInstanceId: machineString,
    workerBootId: machineString,
    authorityEpoch: integer(1),
    fencingToken: integer(1),
    requestedAt: timestamp,
  }),
});

export const payloadBrokerHandshakeAcceptedSchema = object({
  ...envelope("response", "payload.handshake.accepted"),
  payload: object({
    agentServiceInstanceId: machineString,
    agentServiceBootId: machineString,
    workerInstanceId: machineString,
    workerBootId: machineString,
    authorityEpoch: integer(1),
    fencingToken: integer(1),
    acceptedAt: timestamp,
  }),
});

const payloadIdentitySchema = {
  handleRef: machineString,
  invocationId: machineString,
  workerInstanceId: machineString,
  workerBootId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
} as const;

const payloadResponseIdentitySchema = {
  ...payloadIdentitySchema,
  agentServiceInstanceId: machineString,
  agentServiceBootId: machineString,
} as const;

export const payloadInputReadRequestSchema = object({
  ...requestEnvelope("payload.input.read"),
  payload: object(payloadIdentitySchema),
});

export const payloadInputReadResultSchema = object({
  ...envelope("response", "payload.input.read.result"),
  payload: object({
    ...payloadResponseIdentitySchema,
    bytesBase64: payloadBytesSchema,
  }),
});

export const payloadOutputWriteRequestSchema = object({
  ...requestEnvelope("payload.output.write"),
  payload: object({
    ...payloadIdentitySchema,
    bytesBase64: payloadBytesSchema,
    contentType: contentTypeSchema,
  }),
});

export const payloadOutputWriteAcceptedSchema = object({
  ...envelope("response", "payload.output.write.accepted"),
  payload: object({
    ...payloadResponseIdentitySchema,
    outputRef: machineString,
    replayed: booleanValue,
  }),
});

const sandboxJobRequestShape = object({
  ...requestEnvelope("payload.sandbox.job"),
  payload: object({
    ...payloadIdentitySchema,
    identity: sandboxJobIdentitySchema,
    observation: nullable(sandboxJobReceiptSchema),
    resolveScope: booleanValue,
  }),
});
export type PayloadBrokerSandboxJobRequest = InferSchema<typeof sandboxJobRequestShape>;
export const payloadSandboxJobRequestSchema: Schema<PayloadBrokerSandboxJobRequest> = {
  parse(value, path = "$") {
    const result = sandboxJobRequestShape.parse(value, path);
    const { payload } = result;
    if (
      (payload.resolveScope && payload.observation !== null) ||
      payload.invocationId !== payload.identity.invocationId ||
      (payload.observation &&
        JSON.stringify(payload.observation.identity) !== JSON.stringify(payload.identity))
    )
      throw new ContractValidationError(path, "sandbox job identity mismatch");
    return result;
  },
};
const sandboxJobResultShape = object({
  ...envelope("response", "payload.sandbox.job.result"),
  payload: object({
    ...payloadResponseIdentitySchema,
    record: object({ plan: sandboxExecutionPlanSchema, observation: sandboxJobReceiptSchema }),
    applied: booleanValue,
    resolvedScope: nullable(resolvedSandboxScopeSchema),
  }),
});
export type PayloadBrokerSandboxJobResult = InferSchema<typeof sandboxJobResultShape>;
export const payloadSandboxJobResultSchema: Schema<PayloadBrokerSandboxJobResult> = {
  parse(value, path = "$") {
    const result = sandboxJobResultShape.parse(value, path);
    const { payload } = result;
    if (
      (payload.resolvedScope !== null &&
        (payload.resolvedScope.scope.handleRef !== payload.record.plan.handleRef ||
          payload.resolvedScope.scope.toolCallId !== payload.record.plan.identity.toolCallId ||
          payload.resolvedScope.scope.inputRef !== payload.record.plan.inputRef ||
          payload.resolvedScope.scope.ownerId !== payload.record.plan.identity.ownerId ||
          payload.resolvedScope.scope.agentId !== payload.record.plan.identity.agentId ||
          payload.resolvedScope.scope.runId !== payload.record.plan.identity.runId ||
          payload.resolvedScope.scope.hostId !== payload.record.plan.identity.hostId)) ||
      payload.record.plan.identity.invocationId !== payload.invocationId ||
      payload.record.plan.handleRef !== payload.handleRef ||
      JSON.stringify(payload.record.plan.identity) !==
        JSON.stringify(payload.record.observation.identity)
    )
      throw new ContractValidationError(path, "sandbox result identity mismatch");
    return result;
  },
};

const sandboxExecutionRequestShape = object({
  ...requestEnvelope("payload.sandbox.execution"),
  payload: object({
    ...payloadIdentitySchema,
    identity: sandboxJobIdentitySchema,
    command: sandboxExecutionBrokerCommandSchema,
  }),
});
export type PayloadBrokerSandboxExecutionRequest = InferSchema<typeof sandboxExecutionRequestShape>;
export const payloadSandboxExecutionRequestSchema: Schema<PayloadBrokerSandboxExecutionRequest> = {
  parse(value, path = "$") {
    const result = sandboxExecutionRequestShape.parse(value, path);
    const { identity, command } = result.payload;
    if (
      identity.invocationId !== result.payload.invocationId ||
      (command.kind === "bind" &&
        JSON.stringify(command.facts.environment.creator) !== JSON.stringify(identity)) ||
      ((command.kind === "append" || command.kind === "operation") &&
        command.facts.result &&
        JSON.stringify(command.facts.result.identity) !== JSON.stringify(identity))
    )
      throw new ContractValidationError(path, "sandbox execution identity mismatch");
    return result;
  },
};
const boundExecutionWireShape = object({
  phase: literal("bound"),
  plan: sandboxExecutionPlanV2Schema,
  facts: sandboxExecutionFactsSchema,
  startedAt: nullable(timestamp),
  operationRevision: integer(0),
});
const reservedExecutionWireShape = object({
  phase: literal("reserved"),
  plan: sandboxExecutionPlanV2Schema,
  reservation: sandboxExecutionReservationSchema,
  startedAt: literal(null),
  operationRevision: integer(0, 0),
});
const executionWireRecord: Schema<
  InferSchema<typeof boundExecutionWireShape> | InferSchema<typeof reservedExecutionWireShape>
> = {
  parse(value, path = "$") {
    if (
      value !== null &&
      typeof value === "object" &&
      "phase" in value &&
      value.phase === "reserved"
    )
      return reservedExecutionWireShape.parse(value, path);
    return boundExecutionWireShape.parse(value, path);
  },
};
const sandboxExecutionResultShape = object({
  ...envelope("response", "payload.sandbox.execution.result"),
  payload: object({
    ...payloadResponseIdentitySchema,
    record: executionWireRecord,
    applied: booleanValue,
    resolvedScope: nullable(resolvedSandboxScopeSchema),
    output: nullable(sandboxResourceOutputPageSchema),
  }),
});
export type PayloadBrokerSandboxExecutionResult = InferSchema<typeof sandboxExecutionResultShape>;
export const payloadSandboxExecutionResultSchema: Schema<PayloadBrokerSandboxExecutionResult> = {
  parse(value, path = "$") {
    const result = sandboxExecutionResultShape.parse(value, path);
    const { record, resolvedScope, output } = result.payload;
    if (record.phase === "bound")
      validateSandboxExecutionFacts(record.plan, record.facts, {
        environment: record.facts.environment,
        operationContract: record.plan.operationContract,
      });
    else if (
      JSON.stringify(record.reservation.identity) !== JSON.stringify(record.plan.identity) ||
      record.reservation.environmentId !== record.plan.environmentId ||
      record.reservation.mode !== record.plan.mode ||
      output !== null ||
      result.payload.applied
    )
      throw new ContractValidationError(path, "invalid unbound reservation");
    if (
      record.plan.identity.invocationId !== result.payload.invocationId ||
      record.plan.handleRef !== result.payload.handleRef ||
      (output &&
        (record.phase !== "bound" || output.resourceRef !== record.facts.environment.resourceRef))
    )
      throw new ContractValidationError(path, "sandbox execution result mismatch");
    if (
      resolvedScope &&
      (resolvedScope.scope.runId !== record.plan.identity.runId ||
        resolvedScope.scope.hostId !== record.plan.identity.hostId ||
        resolvedScope.scope.inputRef !== record.plan.inputRef ||
        resolvedScope.scope.handleRef !== record.plan.handleRef ||
        resolvedScope.scope.toolCallId !== record.plan.identity.toolCallId ||
        resolvedScope.scope.ownerId !== record.plan.identity.ownerId ||
        resolvedScope.scope.agentId !== record.plan.identity.agentId)
    )
      throw new ContractValidationError(path, "sandbox execution scope mismatch");
    return result;
  },
};

export type PayloadBrokerHandshakeRequest = InferSchema<typeof payloadBrokerHandshakeRequestSchema>;
export type PayloadBrokerHandshakeAccepted = InferSchema<
  typeof payloadBrokerHandshakeAcceptedSchema
>;
export type PayloadBrokerInputReadRequest = InferSchema<typeof payloadInputReadRequestSchema>;
export type PayloadBrokerInputReadResult = InferSchema<typeof payloadInputReadResultSchema>;
export type PayloadBrokerOutputWriteRequest = InferSchema<typeof payloadOutputWriteRequestSchema>;
export type PayloadBrokerOutputWriteAccepted = InferSchema<typeof payloadOutputWriteAcceptedSchema>;

export type PayloadBrokerRequest =
  | PayloadBrokerSandboxExecutionRequest
  | PayloadBrokerSandboxJobRequest
  | PayloadBrokerHandshakeRequest
  | PayloadBrokerInputReadRequest
  | PayloadBrokerOutputWriteRequest;

export type PayloadBrokerResponse =
  | PayloadBrokerSandboxExecutionResult
  | PayloadBrokerSandboxJobResult
  | PayloadBrokerHandshakeAccepted
  | PayloadBrokerInputReadResult
  | PayloadBrokerOutputWriteAccepted;

export type PayloadBrokerMessage = PayloadBrokerRequest | PayloadBrokerResponse;

function isRecord(input: unknown): input is Record<string, unknown> & { readonly type?: unknown } {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function parsePayloadBrokerMessage(input: unknown): PayloadBrokerMessage {
  if (!isRecord(input) || typeof input.type !== "string") {
    throw new ContractValidationError("$", "expected a payload broker message");
  }
  switch (input.type) {
    case "payload.sandbox.execution":
      return payloadSandboxExecutionRequestSchema.parse(input);
    case "payload.sandbox.execution.result":
      return payloadSandboxExecutionResultSchema.parse(input);
    case "payload.sandbox.job":
      return payloadSandboxJobRequestSchema.parse(input);
    case "payload.sandbox.job.result":
      return payloadSandboxJobResultSchema.parse(input);
    case "payload.handshake":
      return payloadBrokerHandshakeRequestSchema.parse(input);
    case "payload.handshake.accepted":
      return payloadBrokerHandshakeAcceptedSchema.parse(input);
    case "payload.input.read":
      return payloadInputReadRequestSchema.parse(input);
    case "payload.input.read.result":
      return payloadInputReadResultSchema.parse(input);
    case "payload.output.write":
      return payloadOutputWriteRequestSchema.parse(input);
    case "payload.output.write.accepted":
      return payloadOutputWriteAcceptedSchema.parse(input);
    default:
      throw new ContractValidationError("$.type", "unsupported payload broker message type");
  }
}

export const payloadBrokerV1MessageSchema = Object.freeze({
  schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
  parse(input: unknown): PayloadBrokerMessage {
    return parsePayloadBrokerMessage(input);
  },
  parseJson(json: string): PayloadBrokerMessage {
    return parseJson({ parse: parsePayloadBrokerMessage }, json);
  },
  serialize(message: PayloadBrokerMessage): string {
    return JSON.stringify(parsePayloadBrokerMessage(message));
  },
});
