import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationReceiptPort,
  CapabilityInvocationResultPort,
  CapabilityResourceCeiling,
  FrozenCapabilityInvocationReceipt,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadRecord,
  PayloadStorePort,
  RunPayloadArtifactCommitResult,
} from "@himawari-agent/application";
import { createApplicationServiceIdentityFactory } from "@himawari-agent/application";
import {
  type PayloadBrokerInputReadRequest,
  type PayloadBrokerOutputWriteRequest,
  payloadBrokerV1MessageSchema,
} from "@himawari-agent/execution-contracts";
import { createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES,
  ProductionPayloadBrokerHandler,
} from "../src/production-payload-broker-handler.js";

type OwnerId = PayloadProtectionRequest["ownerId"];
type AgentId = PayloadProtectionRequest["agentId"];

const V02_FIXTURE = createV02Fixture();
const IDENTITY_FACTORY = createApplicationServiceIdentityFactory();
const OWNER_ID = V02_FIXTURE.scope.ownerId;
const AGENT_ID = V02_FIXTURE.scope.agentId;
const RUN_ID = V02_FIXTURE.scope.runId;
const HANDLE_REF = "handle:payload-handler";
const INVOCATION_ID = "invocation:payload-handler";
const INPUT_REF = "payload:input:payload-handler";
const REQUESTED_AT = "2026-09-04T00:00:00.000Z";
const DEADLINE_AT = "2026-09-04T00:00:05.000Z";
const AUTHORITY_EPOCH = 7;
const FENCING_TOKEN = 13;
const AGENT_SERVICE_INSTANCE_ID = "agent-service:payload-handler";
const AGENT_SERVICE_BOOT_ID = "agent-boot:payload-handler";
const WORKER_INSTANCE_ID = "worker:payload-handler";
const WORKER_BOOT_ID = "worker-boot:payload-handler";
const AUTHORITY_LEASE = IDENTITY_FACTORY.createAuthorityLease({
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  leaseId: "lease:payload-handler",
  holderId: "holder:payload-handler",
});

const ceiling: CapabilityResourceCeiling = Object.freeze({
  maxWallTimeMs: 10_000,
  maxCpuTimeMs: 5_000,
  maxMemoryBytes: 16_777_216,
  maxOutputBytes: 4,
  maxProgressEvents: 8,
});

const authority: CapabilityInvocationAuthority = Object.freeze({
  product: {
    deploymentId: V02_FIXTURE.scope.authority.deploymentId,
    authorityEpoch: AUTHORITY_EPOCH,
    fencingToken: FENCING_TOKEN,
  },
  lease: {
    leaseId: AUTHORITY_LEASE.id,
    fencingToken: FENCING_TOKEN,
  },
  agentServiceInstanceId: AGENT_SERVICE_INSTANCE_ID,
  agentServiceBootId: AGENT_SERVICE_BOOT_ID,
  workerInstanceId: WORKER_INSTANCE_ID,
  workerBootId: WORKER_BOOT_ID,
});

const receipt: FrozenCapabilityInvocationReceipt = {
  receiptVersion: "capability-invocation.v1",
  receiptRef: "receipt:payload-handler",
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  handleRef: HANDLE_REF,
  handleRevision: 3,
  invocationId: INVOCATION_ID,
  workerRunId: "worker-run:payload-handler",
  idempotencyKey: "idempotency:payload-handler",
  capabilityRef: "capability:payload-handler",
  capabilityVersion: "1.0.0",
  authorization: { type: "policy", ref: "policy:payload-handler" },
  authorizationRef: "policy:payload-handler",
  operation: "execute",
  inputRef: INPUT_REF,
  delegatedContextRefs: [],
  secretRefs: [],
  dataClassification: "private",
  resourceCeiling: ceiling,
  requestedAt: REQUESTED_AT,
  deadlineAt: DEADLINE_AT,
  effectiveExpiresAt: DEADLINE_AT,
  authority,
  semanticFingerprint: "fingerprint:payload-handler",
  consumedAt: REQUESTED_AT,
};

const inputPayload: PayloadRecord = Object.freeze({
  ref: INPUT_REF,
  dataClassification: "private",
  contentType: "application/octet-stream",
  ciphertext: new Uint8Array([0x01, 0x02]),
  encryption: { algorithm: "fixture", keyRef: "fixture:key" },
  contentDigest: "digest:input",
  createdAt: REQUESTED_AT,
});

const outputPayload: PayloadRecord = Object.freeze({
  ref: "payload:output:payload-handler",
  dataClassification: "private",
  contentType: "application/json",
  ciphertext: new Uint8Array([0x03, 0x04]),
  encryption: { algorithm: "fixture", keyRef: "fixture:key" },
  contentDigest: "digest:output",
  createdAt: REQUESTED_AT,
});

const outputArtifact: RunPayloadArtifactCommitResult = {
  ref: outputPayload.ref,
  replayed: false,
  artifact: {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    purpose: "worker_result",
    operationKey: `capability-output:${INVOCATION_ID}`,
    payloadRef: outputPayload.ref,
    contentDigest: outputPayload.contentDigest,
    contentType: outputPayload.contentType,
    dataClassification: outputPayload.dataClassification,
    createdAt: outputPayload.createdAt,
  },
};

const identity = {
  handleRef: HANDLE_REF,
  invocationId: INVOCATION_ID,
  workerInstanceId: WORKER_INSTANCE_ID,
  workerBootId: WORKER_BOOT_ID,
  authorityEpoch: AUTHORITY_EPOCH,
  fencingToken: FENCING_TOKEN,
} as const;

function inputRequest(): PayloadBrokerInputReadRequest {
  const parsed = payloadBrokerV1MessageSchema.parse({
    schemaVersion: "payload-broker.v1",
    kind: "request",
    type: "payload.input.read",
    messageId: "message:payload-input-read",
    correlationId: "message:payload-input-read",
    causationId: null,
    idempotencyKey: "idempotency:payload-input-read",
    payload: identity,
  });
  if (parsed.kind !== "request" || parsed.type !== "payload.input.read") {
    throw new TypeError("payload input request fixture is invalid");
  }
  return parsed;
}

function outputRequest(contentType = "application/json"): PayloadBrokerOutputWriteRequest {
  const parsed = payloadBrokerV1MessageSchema.parse({
    schemaVersion: "payload-broker.v1",
    kind: "request",
    type: "payload.output.write",
    messageId: "message:payload-output-write",
    correlationId: "message:payload-output-write",
    causationId: null,
    idempotencyKey: "idempotency:payload-output-write",
    payload: {
      ...identity,
      bytesBase64: "AQID",
      contentType,
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "payload.output.write") {
    throw new TypeError("payload output request fixture is invalid");
  }
  return parsed;
}

function handlerFixture(
  options: {
    readonly receipt?: FrozenCapabilityInvocationReceipt | undefined;
    readonly outputResult?: RunPayloadArtifactCommitResult;
    readonly inputPayload?: PayloadRecord;
  } = {},
) {
  const frozenReceipt = "receipt" in options ? options.receipt : receipt;
  const observed: Array<{
    readonly payload: PayloadRecord;
    readonly plaintextByteLength: number;
  }> = [];
  const protectedRequests: PayloadProtectionRequest[] = [];
  let readCalls = 0;
  let unprotectCalls = 0;
  let lookupFrozenCalls = 0;
  let payloadScope: { readonly ownerId: OwnerId; readonly agentId: AgentId } | undefined;

  const receipts: CapabilityInvocationReceiptPort = {
    consume: async () => {
      throw new Error("consume is not part of the trusted handler boundary");
    },
    read: async () => {
      readCalls += 1;
      return frozenReceipt;
    },
  };
  const results: CapabilityInvocationResultPort = {
    lookupFrozen: async () => {
      lookupFrozenCalls += 1;
      return frozenReceipt;
    },
    observeOutput: async (input) => {
      observed.push({
        payload: input.payload,
        plaintextByteLength: input.plaintextByteLength,
      });
      return options.outputResult ?? outputArtifact;
    },
    lookupOutput: async () => undefined,
  };
  const payloads: Pick<PayloadStorePort, "get"> = {
    get: async (ref) => (ref === INPUT_REF ? (options.inputPayload ?? inputPayload) : undefined),
  };
  const protector: PayloadProtectorPort = {
    protect: async (input) => {
      protectedRequests.push(input);
      return outputPayload;
    },
    unprotect: async () => {
      unprotectCalls += 1;
      return new Uint8Array([0x10, 0x11, 0x12]);
    },
    rewrap: async ({ payload }) => payload,
  };
  const handler = new ProductionPayloadBrokerHandler({
    receipts,
    results,
    payloadsFor: (ownerId, agentId) => {
      payloadScope = { ownerId, agentId };
      return payloads;
    },
    protector,
    currentAuthority: () => ({ product: authority.product, lease: authority.lease }),
    clock: { now: () => REQUESTED_AT },
    ids: { next: () => "payload:generated-output" },
    agentServiceInstanceId: AGENT_SERVICE_INSTANCE_ID,
    agentServiceBootId: AGENT_SERVICE_BOOT_ID,
    maximumPayloadBytes: 32,
    allowedContentTypes: ["application/json", "text/plain"],
  });
  return {
    handler,
    observed,
    protectedRequests,
    get readCalls() {
      return readCalls;
    },
    get unprotectCalls() {
      return unprotectCalls;
    },
    get lookupFrozenCalls() {
      return lookupFrozenCalls;
    },
    get payloadScope() {
      return payloadScope;
    },
  };
}

describe("production Payload broker trusted handler", () => {
  it("reads input only through a live receipt and scoped protected Payload", async () => {
    const fixture = handlerFixture();

    await expect(fixture.handler.readInput(inputRequest())).resolves.toEqual(
      new Uint8Array([0x10, 0x11, 0x12]),
    );
    expect(fixture.readCalls).toBe(1);
    expect(fixture.unprotectCalls).toBe(1);
    expect(fixture.payloadScope).toEqual({ ownerId: OWNER_ID, agentId: AGENT_ID });
  });

  it("allows a lower-classification input under a private invocation ceiling", async () => {
    const fixture = handlerFixture({
      inputPayload: { ...inputPayload, dataClassification: "public" },
    });

    await expect(fixture.handler.readInput(inputRequest())).resolves.toEqual(
      new Uint8Array([0x10, 0x11, 0x12]),
    );
    expect(fixture.unprotectCalls).toBe(1);
  });

  it("rejects an input above the frozen invocation classification", async () => {
    const fixture = handlerFixture({
      inputPayload: { ...inputPayload, dataClassification: "sensitive" },
    });

    await expect(fixture.handler.readInput(inputRequest())).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.PAYLOAD_CLASSIFICATION_MISMATCH,
    });
    expect(fixture.unprotectCalls).toBe(0);
  });

  it("protects output with frozen metadata and submits one observation", async () => {
    const fixture = handlerFixture();

    await expect(
      fixture.handler.writeOutput(
        outputRequest(),
        new Uint8Array([0x20, 0x21, 0x22]),
        "application/json",
      ),
    ).resolves.toEqual({ outputRef: outputPayload.ref, replayed: false });
    expect(fixture.lookupFrozenCalls).toBe(1);
    expect(fixture.protectedRequests).toMatchObject([
      {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        dataClassification: "private",
        contentType: "application/json",
        plaintext: new Uint8Array([0x20, 0x21, 0x22]),
      },
    ]);
    expect(fixture.observed).toMatchObject([
      {
        payload: { ref: outputPayload.ref, dataClassification: "private" },
        plaintextByteLength: 3,
      },
    ]);
    expect(fixture.readCalls).toBe(0);
  });

  it("rejects a content type that disagrees with the output request", async () => {
    const fixture = handlerFixture();

    await expect(
      fixture.handler.writeOutput(
        outputRequest("application/json"),
        new Uint8Array([0x20]),
        "text/plain",
      ),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.CONTENT_TYPE_MISMATCH,
    });
    expect(fixture.protectedRequests).toHaveLength(0);
    expect(fixture.observed).toHaveLength(0);
  });

  it("rejects output before protection when media type or frozen byte ceiling is invalid", async () => {
    const fixture = handlerFixture();

    await expect(
      fixture.handler.writeOutput(outputRequest("text/html"), new Uint8Array([0x20]), "text/html"),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED,
    });
    await expect(
      fixture.handler.writeOutput(
        outputRequest(),
        new Uint8Array([0x20, 0x21, 0x22, 0x23, 0x24]),
        "application/json",
      ),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.OUTPUT_TOO_LARGE,
    });
    expect(fixture.protectedRequests).toHaveLength(0);
    expect(fixture.observed).toHaveLength(0);
  });

  it("fails closed when the consumed invocation is unavailable", async () => {
    const fixture = handlerFixture({ receipt: undefined });

    await expect(fixture.handler.readInput(inputRequest())).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_NOT_FOUND,
    });
    await expect(
      fixture.handler.writeOutput(outputRequest(), new Uint8Array([0x20]), "application/json"),
    ).rejects.toMatchObject({
      code: PRODUCTION_PAYLOAD_HANDLER_ERROR_CODES.INVOCATION_NOT_FOUND,
    });
    expect(fixture.unprotectCalls).toBe(0);
    expect(fixture.protectedRequests).toHaveLength(0);
  });
});
